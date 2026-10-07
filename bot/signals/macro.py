"""Daily macro series from FRED for the dashboard's rates & macro monitor.

Treasury yields across the curve, curve spreads, credit spreads, the dollar,
oil and VIX — the context a trader reads before any single stock. Pulled
once a day (after the close, alongside the regime job) from FRED's public
CSV endpoint (no API key), stored one row per (series, date) in
``macro_series``. Read-only context: nothing here feeds an order.
"""
from __future__ import annotations

import csv
import io
from datetime import datetime, timedelta, timezone

import requests
from loguru import logger
from sqlalchemy import select

from bot.config import settings
from bot.db import JobRun, MacroSeries, SessionLocal

_FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}&cosd={start}"

# series_id: (group, label, unit). Units: "pct" = percent level (yields,
# spreads), "idx" = index/price level.
SERIES: dict[str, tuple[str, str, str]] = {
    "DGS3MO": ("Treasury curve", "UST 3M", "pct"),
    "DGS2": ("Treasury curve", "UST 2Y", "pct"),
    "DGS5": ("Treasury curve", "UST 5Y", "pct"),
    "DGS10": ("Treasury curve", "UST 10Y", "pct"),
    "DGS30": ("Treasury curve", "UST 30Y", "pct"),
    "T10Y2Y": ("Spreads", "2s10s", "pct"),
    "T10Y3M": ("Spreads", "3m10y", "pct"),
    "BAMLC0A0CM": ("Spreads", "IG OAS", "pct"),
    "BAMLH0A0HYM2": ("Spreads", "HY OAS", "pct"),
    "SOFR": ("Funding", "SOFR", "pct"),
    "DTWEXBGS": ("Dollar & oil", "Broad USD", "idx"),
    "DCOILWTICO": ("Dollar & oil", "WTI spot", "idx"),
    "VIXCLS": ("Volatility", "VIX", "idx"),
    # Real spot levels behind the monitor's ETF proxies (FRED lags: indexes
    # and crypto T-1, FX H.10 rates ~T-3 — the UI shows each row's date).
    "SP500": ("Spot levels", "S&P 500", "idx"),
    "NASDAQCOM": ("Spot levels", "Nasdaq Comp", "idx"),
    "DJIA": ("Spot levels", "Dow Jones", "idx"),
    "DEXUSEU": ("Spot levels", "EURUSD", "idx"),
    "DEXJPUS": ("Spot levels", "USDJPY", "idx"),
    "DEXUSUK": ("Spot levels", "GBPUSD", "idx"),
    "DCOILBRENTEU": ("Spot levels", "Brent", "idx"),
    "DHHNGSP": ("Spot levels", "Henry Hub gas", "idx"),
    "CBBTCUSD": ("Spot levels", "Bitcoin", "idx"),
    "CBETHUSD": ("Spot levels", "Ether", "idx"),
}


def parse_fred_csv(text: str) -> list[tuple[datetime, float | None]]:
    """FRED graph CSV → [(date, value)], '.'/blank → None. Tolerates both
    header spellings (DATE / observation_date)."""
    out: list[tuple[datetime, float | None]] = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 2 or row[0] in ("DATE", "observation_date"):
            continue
        try:
            d = datetime.strptime(row[0], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        try:
            v: float | None = float(row[1])
        except ValueError:
            v = None
        out.append((d, v))
    return out


def fetch_series(series_id: str, *, days: int = 400) -> list[tuple[datetime, float | None]]:
    start = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    url = _FRED_CSV.format(series_id=series_id, start=start)
    try:
        r = requests.get(url, headers={"User-Agent": settings.sec_user_agent}, timeout=20)
    except requests.RequestException as exc:
        logger.warning("FRED {} fetch error: {}", series_id, exc)
        return []
    if r.status_code != 200:
        logger.warning("FRED {} HTTP {}", series_id, r.status_code)
        return []
    return parse_fred_csv(r.text)


def store(series_id: str, rows: list[tuple[datetime, float | None]]) -> int:
    """Upsert observations; returns rows inserted or changed."""
    if not rows:
        return 0
    changed = 0
    with SessionLocal.begin() as s:
        existing = {
            (r.obs_date.replace(tzinfo=timezone.utc) if r.obs_date.tzinfo is None else r.obs_date): r
            for r in s.scalars(select(MacroSeries).where(MacroSeries.series_id == series_id)).all()
        }
        for d, v in rows:
            row = existing.get(d)
            if row is None:
                s.add(MacroSeries(series_id=series_id, obs_date=d, value=v))
                changed += 1
            elif row.value != v:
                row.value = v
                changed += 1
    return changed


def refresh_all(days: int = 400) -> dict[str, int]:
    out: dict[str, int] = {}
    for sid in SERIES:
        try:
            out[sid] = store(sid, fetch_series(sid, days=days))
        except Exception as exc:  # one bad series never sinks the rest
            logger.warning("macro {} failed: {}", sid, exc)
            out[sid] = -1
    return out


def run() -> dict:
    """Job entrypoint. Records a JobRun row."""
    started = datetime.now(timezone.utc)
    with SessionLocal.begin() as s:
        jr = JobRun(job_name="macro_daily", status="running", started_at=started)
        s.add(jr)
        s.flush()
        jr_id = jr.id
    try:
        res = refresh_all()
        failed = [k for k, v in res.items() if v < 0]
        status, msg = ("ok" if not failed else "failed"), f"rows={sum(v for v in res.values() if v > 0)} failed={failed}"
    except Exception as exc:
        res, status, msg = {}, "failed", str(exc)
        logger.exception("macro refresh failed")
    with SessionLocal.begin() as s:
        jr = s.get(JobRun, jr_id)
        jr.status, jr.message, jr.finished_at = status, msg, datetime.now(timezone.utc)
    return {"series": res, "status": status}
