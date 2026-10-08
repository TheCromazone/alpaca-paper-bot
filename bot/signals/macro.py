"""Daily macro series (FRED + Yahoo closes) for the dashboard's market monitor.

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

# Same-day closes for the monitor's underlyings from Yahoo (no key): the real
# index/FX/futures/crypto level behind each ETF row. FRED's spot series lag
# (FX ~T-3) and have no Nasdaq-100, Russell, Nikkei, DAX, Hang Seng or metals
# futures. Stored as "YF:<symbol>"; FRED stays the source for rates/spreads.
YF_SERIES: dict[str, tuple[str, str, str]] = {
    "^GSPC": ("Spot levels", "S&P 500", "idx"),
    "^NDX": ("Spot levels", "Nasdaq-100", "idx"),
    "^DJI": ("Spot levels", "Dow Jones", "idx"),
    "^RUT": ("Spot levels", "Russell 2000", "idx"),
    "^N225": ("Spot levels", "Nikkei 225", "idx"),
    "^GDAXI": ("Spot levels", "DAX", "idx"),
    "^HSI": ("Spot levels", "Hang Seng", "idx"),
    "^STOXX50E": ("Spot levels", "Euro Stoxx 50", "idx"),
    "DX-Y.NYB": ("Spot levels", "DXY", "idx"),
    "EURUSD=X": ("Spot levels", "EURUSD", "idx"),
    "JPY=X": ("Spot levels", "USDJPY", "idx"),
    "GBPUSD=X": ("Spot levels", "GBPUSD", "idx"),
    "GC=F": ("Spot levels", "Gold fut", "idx"),
    "SI=F": ("Spot levels", "Silver fut", "idx"),
    "CL=F": ("Spot levels", "WTI fut", "idx"),
    "NG=F": ("Spot levels", "Nat gas fut", "idx"),
    "HG=F": ("Spot levels", "Copper fut", "idx"),
    "BTC-USD": ("Spot levels", "Bitcoin", "idx"),
    "ETH-USD": ("Spot levels", "Ether", "idx"),
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


def yf_rows(frame, symbol: str) -> list[tuple[datetime, float | None]]:
    """One symbol's daily closes from a ``yf.download(group_by="ticker")``
    frame → [(date at 00:00 UTC, close)], NaN rows dropped."""
    try:
        closes = frame[symbol]["Close"].dropna()
    except (KeyError, TypeError):
        return []
    return [
        (datetime(d.year, d.month, d.day, tzinfo=timezone.utc), round(float(v), 6))
        for d, v in closes.items()
    ]


def fetch_yahoo(days: int = 400) -> dict[str, list[tuple[datetime, float | None]]]:
    """All YF_SERIES in one batched download; {} on any failure."""
    try:
        import yfinance as yf

        frame = yf.download(
            list(YF_SERIES), period=f"{days}d", interval="1d", group_by="ticker",
            auto_adjust=False, progress=False, threads=True,
        )
    except Exception as exc:
        logger.warning("Yahoo spot download failed: {}", exc)
        return {}
    return {sym: yf_rows(frame, sym) for sym in YF_SERIES}


def refresh_all(days: int = 400) -> dict[str, int]:
    out: dict[str, int] = {}
    for sid in SERIES:
        try:
            out[sid] = store(sid, fetch_series(sid, days=days))
        except Exception as exc:  # one bad series never sinks the rest
            logger.warning("macro {} failed: {}", sid, exc)
            out[sid] = -1
    for sym, rows in fetch_yahoo(days).items():
        sid = f"YF:{sym}"
        try:
            out[sid] = store(sid, rows) if rows else -1
        except Exception as exc:
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
