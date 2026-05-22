"""Earnings calendar + last-4-quarter EPS-surprise history.

Sources (no API key required):
- NASDAQ public earnings calendar JSON: api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD
- Yahoo Finance unofficial JSON: query2.finance.yahoo.com/v10/finance/quoteSummary/{ticker}?modules=earningsHistory

Both endpoints rate-limit aggressively. We:
1. Pull the next 14 days of NASDAQ calendar entries (universe-filtered).
2. For each ticker on the upcoming list, refresh that ticker's last-4-quarter
   surprise history (if our cached value is older than 7 days).

Best-effort. Anything that fails logs a warning and moves on.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Iterable

import requests
from loguru import logger
from sqlalchemy import desc, select

from bot.config import FULL_UNIVERSE, settings
from bot.db import EarningsCalendar, EarningsHistory, JobRun, SessionLocal


_NASDAQ_URL = "https://api.nasdaq.com/api/calendar/earnings?date={date}"
_YAHOO_URL = "https://query2.finance.yahoo.com/v10/finance/quoteSummary/{ticker}?modules=earningsHistory"


def _ua_headers() -> dict:
    """Both NASDAQ and Yahoo refuse anonymous Python user agents."""
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
    today = datetime.now(timezone.utc)
    upserts = 0
    with SessionLocal.begin() as s:
        for d in range(days_ahead):
            day = today + timedelta(days=d)
            for entry in _nasdaq_calendar_for(day):
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


def _yahoo_surprise_history(ticker: str) -> list[dict]:
    url = _YAHOO_URL.format(ticker=ticker)
    try:
        r = requests.get(url, headers=_ua_headers(), timeout=15)
        if r.status_code != 200:
            return []
        body = r.json()
    except (requests.RequestException, ValueError):
        return []
    try:
        history = (
            body["quoteSummary"]["result"][0]
            ["earningsHistory"]["history"]
        )
    except (KeyError, IndexError, TypeError):
        return []
    out = []
    for h in history[-8:]:  # most recent 8 quarters
        try:
            quarter = h.get("quarter", {}).get("fmt") or ""
            est = h.get("epsEstimate", {}).get("raw")
            act = h.get("epsActual", {}).get("raw")
            surprise = h.get("surprisePercent", {}).get("raw")
        except AttributeError:
            continue
        if not quarter:
            continue
        out.append({
            "quarter": quarter,
            "eps_estimate": est,
            "eps_actual": act,
            "surprise_pct": surprise,
        })
    return out


def refresh_history_for(tickers: Iterable[str], stale_days: int = 7) -> int:
    """Refresh EPS surprise history for tickers whose newest cached row is
    older than `stale_days`. Returns number of rows written/updated."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=stale_days)
    written = 0
    with SessionLocal.begin() as s:
        for t in tickers:
            newest = s.scalars(
                select(EarningsHistory)
                .where(EarningsHistory.ticker == t)
                .order_by(desc(EarningsHistory.fetched_at))
                .limit(1)
            ).first()
            if newest and newest.fetched_at and newest.fetched_at >= cutoff:
                continue
            history = _yahoo_surprise_history(t)
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
    today = datetime.now(timezone.utc)
    cutoff = today + timedelta(days=days)
    with SessionLocal() as s:
        rows = s.scalars(
            select(EarningsCalendar)
            .where(EarningsCalendar.report_date >= today)
            .where(EarningsCalendar.report_date <= cutoff)
            .order_by(EarningsCalendar.report_date.asc())
        ).all()
        out = []
        for r in rows:
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
        # Only refresh history for tickers with upcoming earnings — saves Yahoo calls.
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
