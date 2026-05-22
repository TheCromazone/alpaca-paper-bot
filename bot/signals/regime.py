"""Daily market-regime snapshot.

Computes (once per day, after price_refresh):
  - VIX spot + 5-day delta
  - SPY 50-day vs 200-day MA (positive = uptrend)
  - 10Y-2Y treasury spread (yield-curve inversion = recession warn)
  - Breadth: % of EQUITY_UNIVERSE tickers above their 50-day MA

VIX + T10Y2Y come from FRED's public CSV endpoint (no API key required for
the graph/fredgraph download URL). SPY + breadth come from the bot's local
PriceHistory table (already kept warm by daily_price_refresh).

The label ("risk_on" / "neutral" / "risk_off") is what the LLM consumes via
get_market_regime() and the system prompt — so it can size down on stress.
"""
from __future__ import annotations

import csv
import io
from datetime import datetime, timezone
from typing import Iterable

import requests
from loguru import logger
from sqlalchemy import desc, select

from bot.config import EQUITY_UNIVERSE, settings
from bot.db import JobRun, MarketRegime, PriceHistory, SessionLocal


_FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"


def _fred_latest(series_id: str, *, lookback_rows: int = 20) -> list[tuple[str, float | None]]:
    """Return the most recent ``lookback_rows`` (date, value) pairs from FRED.

    The CSV has two columns: DATE, <SERIES>. Missing/.. values come back as
    None so callers can pick the most recent non-null.
    """
    url = _FRED_CSV.format(series_id=series_id)
    try:
        r = requests.get(
            url, headers={"User-Agent": settings.sec_user_agent}, timeout=20
        )
        if r.status_code != 200:
            logger.warning("FRED {} {}: fetch failed", series_id, r.status_code)
            return []
        reader = csv.reader(io.StringIO(r.text))
        rows = list(reader)
        if len(rows) <= 1:
            return []
        out: list[tuple[str, float | None]] = []
        for row in rows[-lookback_rows - 1:]:  # +1 for header buffer
            if len(row) < 2 or row[0] in ("DATE", "observation_date"):
                continue
            try:
                v = float(row[1])
            except ValueError:
                v = None
            out.append((row[0], v))
        return out
    except requests.RequestException as exc:
        logger.warning("FRED {} fetch error: {}", series_id, exc)
        return []


def _last_non_null(rows: list[tuple[str, float | None]]) -> float | None:
    for _, v in reversed(rows):
        if v is not None:
            return v
    return None


def _spy_ma_ratio(session) -> float | None:
    """SPY 50d MA / 200d MA - 1.0. >0 = uptrend regime."""
    rows = session.execute(
        select(PriceHistory.close)
        .where(PriceHistory.ticker == "SPY")
        .order_by(desc(PriceHistory.trade_date))
        .limit(200)
    ).all()
    closes = [r[0] for r in rows]
    if len(closes) < 200:
        return None
    ma50 = sum(closes[:50]) / 50
    ma200 = sum(closes[:200]) / 200
    if ma200 <= 0:
        return None
    return ma50 / ma200 - 1.0


def _breadth(session, tickers: Iterable[str]) -> float | None:
    """% of `tickers` whose latest close is above their 50d MA."""
    above = 0
    counted = 0
    for t in tickers:
        rows = session.execute(
            select(PriceHistory.close)
            .where(PriceHistory.ticker == t)
            .order_by(desc(PriceHistory.trade_date))
            .limit(50)
        ).all()
        closes = [r[0] for r in rows]
        if len(closes) < 50:
            continue
        ma50 = sum(closes) / 50
        if closes[0] >= ma50:
            above += 1
        counted += 1
    if not counted:
        return None
    return round(100.0 * above / counted, 1)


def _label(vix: float | None, spy_trend: float | None, t10y2y: float | None,
           breadth_pct: float | None) -> str:
    """Three-bucket label from the snapshot.

    risk_off: stressed market — VIX hot OR breadth thin OR yield curve deeply
              inverted while SPY is in a downtrend.
    risk_on:  calm + broad-based + uptrend.
    neutral:  everything else.
    """
    score = 0
    if vix is not None:
        if vix > 25:    score -= 2
        elif vix > 20:  score -= 1
        elif vix < 15:  score += 1
    if spy_trend is not None:
        if spy_trend > 0.02:   score += 2
        elif spy_trend < -0.02: score -= 2
    if breadth_pct is not None:
        if breadth_pct > 65:   score += 1
        elif breadth_pct < 35: score -= 1
    if t10y2y is not None and t10y2y < -0.5:
        # Deep inversion is a meaningful warn but doesn't single-handedly
        # flip the label — pair it with trend.
        if spy_trend is not None and spy_trend < 0:
            score -= 1
    if score >= 2:
        return "risk_on"
    if score <= -2:
        return "risk_off"
    return "neutral"


def compute_today() -> dict:
    """Compute snapshot + persist. Returns a dict the API can serve."""
    vix_rows = _fred_latest("VIXCLS")
    t10y_rows = _fred_latest("T10Y2Y")
    vix_now = _last_non_null(vix_rows)
    vix_5d = None
    if vix_now is not None and len(vix_rows) >= 6:
        prior = next((v for _, v in reversed(vix_rows[:-5]) if v is not None), None)
        if prior is not None:
            vix_5d = round(vix_now - prior, 2)
    t10y2y = _last_non_null(t10y_rows)

    with SessionLocal.begin() as s:
        spy_trend = _spy_ma_ratio(s)
        breadth_pct = _breadth(s, EQUITY_UNIVERSE)
        label = _label(vix_now, spy_trend, t10y2y, breadth_pct)
        snap = MarketRegime(
            as_of=datetime.now(timezone.utc),
            vix=vix_now,
            vix_5d_change=vix_5d,
            spy_trend=round(spy_trend, 4) if spy_trend is not None else None,
            t10y2y=t10y2y,
            breadth_pct=breadth_pct,
            regime_label=label,
            meta={"sources": {"vix": "FRED VIXCLS", "t10y2y": "FRED T10Y2Y"}},
        )
        s.add(snap)
    logger.info(
        "regime: vix={} dvix5={} spy_trend={} t10y2y={} breadth={}% -> {}",
        vix_now, vix_5d, spy_trend, t10y2y, breadth_pct, label,
    )
    return {
        "vix": vix_now, "vix_5d_change": vix_5d,
        "spy_trend": spy_trend, "t10y2y": t10y2y,
        "breadth_pct": breadth_pct, "regime_label": label,
    }


def latest() -> dict | None:
    """Read most recent snapshot (used by API + LLM tool)."""
    with SessionLocal() as s:
        row = s.scalars(
            select(MarketRegime).order_by(desc(MarketRegime.as_of)).limit(1)
        ).first()
    if not row:
        return None
    return {
        "as_of": row.as_of.isoformat() if row.as_of else None,
        "vix": row.vix,
        "vix_5d_change": row.vix_5d_change,
        "spy_trend": row.spy_trend,
        "t10y2y": row.t10y2y,
        "breadth_pct": row.breadth_pct,
        "regime_label": row.regime_label,
    }


def run() -> dict:
    started = datetime.now(timezone.utc)
    with SessionLocal.begin() as s:
        jr = JobRun(job_name="regime_refresh", started_at=started, status="running")
        s.add(jr)
        s.flush()
        jr_id = jr.id
    out: dict = {"label": None, "error": None}
    try:
        snap = compute_today()
        out["label"] = snap["regime_label"]
    except Exception as exc:
        out["error"] = str(exc)
        logger.exception("regime_refresh failed")
    with SessionLocal.begin() as s:
        jr = s.get(JobRun, jr_id)
        jr.finished_at = datetime.now(timezone.utc)
        jr.status = "ok" if out["error"] is None else "failed"
        jr.message = str(out)
    return out
