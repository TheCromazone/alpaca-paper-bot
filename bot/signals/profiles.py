"""Weekly company-profile refresh (yfinance) for the whole universe.

Fills ``company_profiles`` — name, sector, industry, description, market cap,
employees — which the API otherwise only caches lazily, one ticker at a time,
when someone opens a security screen. The dashboard needs market caps for
every name up front to size the universe heatmap. Read-only reference data;
nothing here feeds an order.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Iterable

from loguru import logger

from bot.config import FULL_UNIVERSE
from bot.db import CompanyProfile, JobRun, SessionLocal

STALE_AFTER = timedelta(days=6)


def _yahoo_symbol(ticker: str) -> str:
    return ticker.replace(".", "-")


def fetch_profile(ticker: str) -> dict | None:
    """yfinance ``info`` → profile fields, or None when Yahoo has nothing."""
    try:
        import yfinance as yf

        info = yf.Ticker(_yahoo_symbol(ticker)).info or {}
    except Exception as exc:
        logger.warning("profile fetch failed for {}: {}", ticker, exc)
        return None
    name = info.get("longName") or info.get("shortName")
    mcap = info.get("marketCap") or info.get("totalAssets")  # ETFs report AUM
    if not name and not mcap:
        return None
    return {
        "name": name,
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        "description": info.get("longBusinessSummary"),
        "website": info.get("website"),
        "exchange": info.get("exchange"),
        "country": info.get("country"),
        "market_cap": float(mcap) if mcap else None,
        "employees": info.get("fullTimeEmployees"),
    }


def refresh(tickers: Iterable[str] = FULL_UNIVERSE, *, pause: float = 0.25) -> int:
    """Refresh profiles older than STALE_AFTER. Returns rows written."""
    now = datetime.now(timezone.utc)
    with SessionLocal() as s:
        fresh = {
            p.ticker
            for p in s.query(CompanyProfile).all()
            if p.fetched_at and (now - (p.fetched_at if p.fetched_at.tzinfo else p.fetched_at.replace(tzinfo=timezone.utc))) < STALE_AFTER
        }
    written = 0
    for t in tickers:
        if t in fresh:
            continue
        data = fetch_profile(t)
        if data:
            with SessionLocal.begin() as s:
                s.merge(CompanyProfile(ticker=t, fetched_at=now, **data))
            written += 1
        time.sleep(pause)
    return written


def run() -> dict:
    """Job entrypoint. Records a JobRun row."""
    started = datetime.now(timezone.utc)
    with SessionLocal.begin() as s:
        jr = JobRun(job_name="profiles_weekly", status="running", started_at=started)
        s.add(jr)
        s.flush()
        jr_id = jr.id
    try:
        n = refresh()
        status, msg = "ok", f"profiles={n}"
    except Exception as exc:
        n, status, msg = 0, "failed", str(exc)
        logger.exception("profile refresh failed")
    with SessionLocal.begin() as s:
        jr = s.get(JobRun, jr_id)
        jr.status, jr.message, jr.finished_at = status, msg, datetime.now(timezone.utc)
    return {"profiles": n, "status": status}
