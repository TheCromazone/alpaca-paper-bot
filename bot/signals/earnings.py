"""Earnings calendar + last-4-quarter EPS-surprise history.

Sources (no API key required):
- NASDAQ public earnings calendar JSON: api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD
- Yahoo Finance EPS history via yfinance (``Ticker.get_earnings_history()``).
  The raw quoteSummary endpoint now demands a crumb + cookie and returns
  nothing to plain requests; yfinance negotiates both.

Both sources rate-limit aggressively. We:
1. Pull the next 14 days of NASDAQ calendar entries (universe-filtered).
2. For each ticker on the upcoming list, refresh that ticker's last-4-quarter
   surprise history (if our cached value is older than 7 days).

Best-effort. Anything that fails logs a warning and moves on.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Iterable

import requests
from loguru import logger
from sqlalchemy import delete, desc, select

from bot.config import FULL_UNIVERSE, settings
from bot.db import EarningsCalendar, EarningsHistory, JobRun, SessionLocal


_NASDAQ_URL = "https://api.nasdaq.com/api/calendar/earnings?date={date}"
_YF_GAP_S = 0.3   # pause between yfinance history pulls
# Quarter labels written before the yfinance switch were the fiscal period-end
# date ("2025-09-30"); they'd duplicate the canonical "2025-Q3" rows.
_LEGACY_QUARTER_LIKE = "____-__-__"


def _ua_headers() -> dict:
    """NASDAQ refuses anonymous Python user agents."""
    return {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        ),
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.nasdaq.com/market-activity/earnings",
    }


def _nasdaq_calendar_for(day: datetime) -> list[dict]:
    url = _NASDAQ_URL.format(date=day.strftime("%Y-%m-%d"))
    try:
        r = requests.get(url, headers=_ua_headers(), timeout=20)
        if r.status_code != 200:
            return []
        body = r.json()
    except (requests.RequestException, ValueError) as exc:
        logger.warning("nasdaq calendar {} fetch failed: {}", day.date(), exc)
        return []
    rows = (body.get("data") or {}).get("rows") or []
    out = []
    for row in rows:
        ticker = (row.get("symbol") or "").upper().strip()
        if not ticker or ticker not in FULL_UNIVERSE:
            continue
        eps_est_raw = (row.get("epsForecast") or "").replace("$", "").strip()
        try:
            eps_est = float(eps_est_raw) if eps_est_raw else None
        except ValueError:
            eps_est = None
        out.append({
            "ticker": ticker,
            "report_date": day,
            "time_of_day": (row.get("time") or "").lower()[:8] or None,
            "eps_estimate": eps_est,
        })
    return out


def refresh_calendar(days_ahead: int = 14) -> int:
    """Pull and persist next N days of upcoming earnings for universe tickers.
    Idempotent — uses (ticker, report_date) unique constraint.
    """
    # Midnight UTC, not "now": report_date used to carry the job's run time
    # (~22:00:00.123456), so the (ticker, report_date) unique key never
    # matched and every daily run re-inserted each upcoming report — up to
    # 14 duplicate rows per event in get_upcoming_earnings.
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    # Fetch everything before opening the write transaction: holding the
    # SQLite write lock across 14 NASDAQ round-trips could outlast the busy
    # timeout of the account sync / manual-trade writers.
    entries = [e for d in range(days_ahead) for e in _nasdaq_calendar_for(today + timedelta(days=d))]
    window_end = today + timedelta(days=days_ahead)
    new_dates: dict[str, set] = {}
    for e in entries:
        new_dates.setdefault(e["ticker"], set()).add(e["report_date"].replace(tzinfo=None))
    upserts = 0
    with SessionLocal.begin() as s:
        # A rescheduled report: NASDAQ lists the ticker on a new date inside
        # this window, so its old future-dated row is stale (upcoming() and
        # the earnings blackout would otherwise still see the old date).
        if new_dates:
            for row in s.scalars(
                select(EarningsCalendar)
                .where(EarningsCalendar.ticker.in_(new_dates))
                .where(EarningsCalendar.report_date >= today)
                .where(EarningsCalendar.report_date < window_end)
            ).all():
                if row.report_date.replace(tzinfo=None) not in new_dates[row.ticker]:
                    s.delete(row)
        for entry in entries:
            # Manual upsert: SQLite doesn't have ON CONFLICT here without
            # the dialect import; just check + update.
            existing = s.scalars(
                select(EarningsCalendar).where(
                    EarningsCalendar.ticker == entry["ticker"],
                    EarningsCalendar.report_date == entry["report_date"],
                )
            ).first()
            if existing:
                existing.time_of_day = entry["time_of_day"]
                existing.eps_estimate = entry["eps_estimate"]
                existing.fetched_at = datetime.now(timezone.utc)
            else:
                s.add(EarningsCalendar(**entry))
                upserts += 1
    return upserts


def _yf_symbol(ticker: str) -> str:
    return ticker.replace(".", "-")   # BRK.B -> BRK-B on Yahoo


def _quarter_label(period_end: datetime) -> str:
    """Fiscal period end → "YYYY-Qn" of the calendar quarter holding the
    period's midpoint, so off-calendar fiscal years label sensibly and
    uniquely (WMT's quarter ending Jan 31 → previous year's Q4)."""
    mid = period_end - timedelta(days=45)
    return f"{mid.year}-Q{(mid.month - 1) // 3 + 1}"


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f   # NaN → None


def _yahoo_surprise_history(ticker: str) -> list[dict]:
    """Last reported quarters' EPS surprise via yfinance, oldest first.

    ``surprise_pct`` is a fraction (0.0452 = beat by 4.52%), the same unit
    Yahoo's ``surprisePercent`` always had and the dashboard renders (×100).
    """
    try:
        import yfinance as yf

        df = yf.Ticker(_yf_symbol(ticker)).get_earnings_history()
    except Exception as exc:   # yfinance raises a zoo of HTTP/parse errors
        logger.warning("yfinance earnings history {} failed: {}", ticker, exc)
        return []
    if df is None or getattr(df, "empty", True):
        return []
    by_quarter: dict[str, dict] = {}
    for idx, row in df.iterrows():
        try:
            period_end = idx.to_pydatetime() if hasattr(idx, "to_pydatetime") else datetime.fromisoformat(str(idx))
        except (TypeError, ValueError):
            continue
        est, act = _num(row.get("epsEstimate")), _num(row.get("epsActual"))
        surprise = _num(row.get("surprisePercent"))
        if surprise is None and est not in (None, 0) and act is not None:
            surprise = (act - est) / abs(est)
        quarter = _quarter_label(period_end)
        by_quarter[quarter] = {
            "quarter": quarter,
            "eps_estimate": est,
            "eps_actual": act,
            "surprise_pct": surprise,
        }
    return [by_quarter[q] for q in sorted(by_quarter)][-8:]


def refresh_history_for(tickers: Iterable[str], stale_days: int = 7) -> int:
    """Refresh EPS surprise history for tickers whose newest cached row is
    older than `stale_days`. Returns number of rows written/updated."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=stale_days)
    stale: list[str] = []
    with SessionLocal() as s:   # read only; released before any network call
        for t in dict.fromkeys(tickers):
            newest = s.scalars(
                select(EarningsHistory)
                .where(EarningsHistory.ticker == t)
                # Legacy date-labelled rows don't count as fresh: the ticker
                # gets re-fetched and those rows replaced below.
                .where(EarningsHistory.quarter.not_like(_LEGACY_QUARTER_LIKE))
                .order_by(desc(EarningsHistory.fetched_at))
                .limit(1)
            ).first()
            # SQLite hands back naive datetimes; comparing one with the aware
            # cutoff raised TypeError, aborting the whole history refresh
            # (and failing the job) as soon as any ticker had cached history.
            fetched = newest.fetched_at if newest else None
            if fetched is not None and fetched.tzinfo is None:
                fetched = fetched.replace(tzinfo=timezone.utc)
            if fetched is None or fetched < cutoff:
                stale.append(t)

    # All yfinance calls happen outside any transaction (see refresh_calendar).
    histories: dict[str, list[dict]] = {}
    for i, t in enumerate(stale):
        if i and _YF_GAP_S:
            time.sleep(_YF_GAP_S)
        histories[t] = _yahoo_surprise_history(t)

    written = 0
    with SessionLocal.begin() as s:
        for t, history in histories.items():
            if history:
                s.execute(delete(EarningsHistory)
                          .where(EarningsHistory.ticker == t)
                          .where(EarningsHistory.quarter.like(_LEGACY_QUARTER_LIKE)))
            for h in history:
                existing = s.scalars(
                    select(EarningsHistory).where(
                        EarningsHistory.ticker == t,
                        EarningsHistory.quarter == h["quarter"],
                    )
                ).first()
                if existing:
                    existing.eps_estimate = h["eps_estimate"]
                    existing.eps_actual = h["eps_actual"]
                    existing.surprise_pct = h["surprise_pct"]
                    existing.fetched_at = datetime.now(timezone.utc)
                else:
                    s.add(EarningsHistory(
                        ticker=t, quarter=h["quarter"],
                        eps_estimate=h["eps_estimate"],
                        eps_actual=h["eps_actual"],
                        surprise_pct=h["surprise_pct"],
                    ))
                    written += 1
    return written


def upcoming(days: int = 14) -> list[dict]:
    """Read upcoming earnings (used by API + LLM tool)."""
    # From today's midnight so today's reporters (stored at 00:00 UTC) stay
    # visible all day.
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff = today + timedelta(days=days + 1)
    with SessionLocal() as s:
        rows = s.scalars(
            select(EarningsCalendar)
            .where(EarningsCalendar.report_date >= today)
            .where(EarningsCalendar.report_date < cutoff)
            .order_by(EarningsCalendar.report_date.asc())
        ).all()
        out = []
        seen: set[tuple] = set()
        for r in rows:
            # Collapse legacy duplicates (rows stamped with a time-of-day by
            # pre-fix refreshes) to one event per ticker per date.
            key = (r.ticker, r.report_date.date() if r.report_date else None)
            if key in seen:
                continue
            seen.add(key)
            history = s.scalars(
                select(EarningsHistory)
                .where(EarningsHistory.ticker == r.ticker)
                .order_by(desc(EarningsHistory.quarter))
                .limit(4)
            ).all()
            out.append({
                "ticker": r.ticker,
                "report_date": r.report_date.isoformat() if r.report_date else None,
                "time_of_day": r.time_of_day,
                "eps_estimate": r.eps_estimate,
                "last_4_surprise_pcts": [h.surprise_pct for h in history],
            })
    return out


def run() -> dict:
    started = datetime.now(timezone.utc)
    with SessionLocal.begin() as s:
        jr = JobRun(job_name="earnings_refresh", started_at=started, status="running")
        s.add(jr)
        s.flush()
        jr_id = jr.id
    out = {"calendar_added": 0, "history_added": 0, "error": None}
    try:
        out["calendar_added"] = refresh_calendar()
        # Only refresh history for tickers with upcoming earnings — saves yfinance calls.
        with SessionLocal() as s:
            upcoming_tickers = [
                r[0] for r in s.execute(
                    select(EarningsCalendar.ticker)
                    .where(EarningsCalendar.report_date >= datetime.now(timezone.utc))
                    .where(EarningsCalendar.report_date <= datetime.now(timezone.utc) + timedelta(days=21))
                ).all()
            ]
        out["history_added"] = refresh_history_for(set(upcoming_tickers))
    except Exception as exc:
        out["error"] = str(exc)
        logger.exception("earnings_refresh failed")
    with SessionLocal.begin() as s:
        jr = s.get(JobRun, jr_id)
        jr.finished_at = datetime.now(timezone.utc)
        jr.status = "ok" if out["error"] is None else "failed"
        jr.message = str(out)
    return out
