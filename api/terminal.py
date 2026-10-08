"""Terminal endpoints — the data-dense read models behind the dashboard's
Bloomberg-style launchpad.

Everything here is read-only and served from local tables (``price_history``,
``portfolio_snapshots``, ``positions``, ``trades``, ``decisions``, ``news_items``,
``signals``, ``earnings_*``, ``llm_runs``, ``market_regime``). No Alpaca calls,
no orders, no network on the hot path — the bot's scheduled jobs keep these
tables fresh (sync_account every 5 min, prices daily, news every 15 min), so
the terminal is as live as the bot itself and never blocks on a broker blip.

All datetimes go out through ``_iso`` (explicit UTC) — same contract as
``api.main._iso_utc``: SQLite strips tz info on read and the browser would
otherwise parse naive strings as local time.
"""
from __future__ import annotations

import math
import re
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from statistics import mean, pstdev
from typing import Any, Iterable
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import String, asc, cast, desc, select
from sqlalchemy.orm import Session

from bot.config import (
    EQUITY_UNIVERSE,
    FIXED_INCOME_UNIVERSE,
    FULL_UNIVERSE,
    LLM_MAX_POSITIONS,
    LLM_MIDDAY_STOP_LOSS_PCT,
    LLM_TRAILING_STOP_PCT,
    MAX_SECTOR_PCT,
    MONITOR_EXTRA,
    SECTOR_MAP,
    TICKER_NAMES,
    settings,
)
from bot.db import (
    CompanyProfile,
    Decision,
    EarningsCalendar,
    EarningsHistory,
    JobRun,
    LLMRun,
    MacroSeries,
    MarketRegime,
    NewsItem,
    PortfolioSnapshot,
    Position,
    PriceHistory,
    SessionLocal,
    Signal,
    Trade,
)

router = APIRouter(prefix="/terminal", tags=["terminal"])

ET = ZoneInfo("America/New_York")
TRADING_DAYS = 252

# Default cross-asset monitor (the launchpad's "WEI" panel): broad equity,
# rates/credit, plus VIX when the regime job has stored it.
DEFAULT_MONITOR = [
    "SPY", "QQQ", "DIA", "IWM", "VTI",
    "TLT", "IEF", "SHY", "AGG", "LQD", "HYG", "TIP",
]
_CORE_GROUPS = {
    **{t: "Equity" for t in ("SPY", "QQQ", "DIA", "IWM", "VTI")},
    **{t: "Rates" for t in ("TLT", "IEF", "SHY")},
    **{t: "Credit" for t in ("AGG", "LQD", "HYG", "TIP")},
}
_MONITOR_ORDER = ["Equity", "Sectors", "Global", "Rates", "Credit", "FX", "Commodities", "Crypto"]

# Mirrors api.main._ROUTINE_SCHEDULE (ET wall-clock) — duplicated as plain
# data so this module never imports api.main (which includes this router).
_ROUTINES = [
    ("premarket", "mon-fri", 7, 0, "Research only: web search, news/signals, write the day's thesis list"),
    ("execute", "mon-fri", 9, 30, "The only buy window: up to 2 fresh names, 5% cap, auto 10% trailing stop"),
    ("midday", "mon-fri", 13, 0, "The only sell window: cut anything ≥7% under cost, tighten stops on winners"),
    ("close", "mon-fri", 16, 0, "Log day P/L and the watch-list for tomorrow"),
    ("weekly_review", "fri", 17, 0, "Post-mortem: grade the week, propose rulebook edits"),
]

_TICKER_RX = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")

# Same rule as the dashboard's BOT_STALE_MS: no LLM routine for ~3.5 days
# (a weekend + holiday) means the bot isn't running its routines.
BOT_STALE = timedelta(hours=84)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    dt = _aware(dt)
    return dt.isoformat() if dt else None


def _d(dt: datetime) -> date:
    """Trading date of a price_history row (stored as midnight UTC)."""
    return _aware(dt).date()


def _r(x: float | None, n: int = 4) -> float | None:
    if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))):
        return None
    return round(x, n)


def _pct(x: float, digits: int = 2) -> str:
    """Signed percent with a true minus sign (U+2212): 0.0123 → "+1.23%"."""
    sign = "+" if x > 0 else ("−" if x < 0 else "")
    return f"{sign}{abs(x) * 100:.{digits}f}%"


def _usd(x: float) -> str:
    sign = "+" if x > 0 else ("−" if x < 0 else "")
    return f"{sign}${abs(x):,.0f}"


def _name(ticker: str, profiles: dict[str, CompanyProfile] | None = None) -> str:
    if profiles and ticker in profiles and profiles[ticker].name:
        return profiles[ticker].name
    if ticker in MONITOR_EXTRA:
        return MONITOR_EXTRA[ticker][1]
    names = TICKER_NAMES.get(ticker)
    return names[0] if names else ticker


def _closes(
    s: Session, tickers: Iterable[str], since: datetime | None = None
) -> dict[str, list[tuple[date, float]]]:
    """{ticker: [(date, close), ...]} ascending by date."""
    tickers = list(dict.fromkeys(tickers))
    if not tickers:
        return {}
    q = (
        select(PriceHistory.ticker, PriceHistory.trade_date, PriceHistory.close)
        .where(PriceHistory.ticker.in_(tickers))
        .order_by(asc(PriceHistory.trade_date))
    )
    if since is not None:
        q = q.where(PriceHistory.trade_date >= since.replace(tzinfo=None))
    out: dict[str, list[tuple[date, float]]] = defaultdict(list)
    for t, td, c in s.execute(q).all():
        if c is not None:
            out[t].append((_d(td), float(c)))
    return out


def _volumes(
    s: Session, tickers: Iterable[str], since: datetime | None = None
) -> dict[str, list[tuple[date, float]]]:
    """{ticker: [(date, volume), ...]} ascending; rows without volume skipped."""
    tickers = list(dict.fromkeys(tickers))
    if not tickers:
        return {}
    q = (
        select(PriceHistory.ticker, PriceHistory.trade_date, PriceHistory.volume)
        .where(PriceHistory.ticker.in_(tickers))
        .where(PriceHistory.volume.is_not(None))
        .order_by(asc(PriceHistory.trade_date))
    )
    if since is not None:
        q = q.where(PriceHistory.trade_date >= since.replace(tzinfo=None))
    out: dict[str, list[tuple[date, float]]] = defaultdict(list)
    for t, td, v in s.execute(q).all():
        out[t].append((_d(td), float(v)))
    return out


def _rel_vol(vols: list[tuple[date, float]] | None) -> tuple[float | None, float | None, float | None]:
    """(last volume, 20-day average before it, last / average)."""
    if not vols or len(vols) < 6:
        return None, None, None
    last = vols[-1][1]
    prior = [v for _, v in vols[-21:-1] if v]
    avg = mean(prior) if prior else None
    return last, avg, (last / avg if avg else None)


def _chg(series: list[tuple[date, float]], back: int) -> float | None:
    """Fractional change over the last ``back`` observations."""
    if len(series) <= back:
        return None
    base = series[-1 - back][1]
    return (series[-1][1] / base - 1.0) if base else None


def _chg_since(series: list[tuple[date, float]], start: date) -> float | None:
    base = next((c for d, c in reversed(series) if d < start), None)
    if base is None and series and series[0][0] >= start:
        base = series[0][1]
    if not base or not series:
        return None
    return series[-1][1] / base - 1.0


def _months_back(d: date, months: int) -> date:
    y, m = divmod(d.month - 1 - months, 12)
    y, m = d.year + y, m + 1
    for day in (d.day, 30, 29, 28):
        try:
            return date(y, m, day)
        except ValueError:
            continue
    return date(y, m, 28)


def _chg_back(series: list[tuple[date, float]], *, months: int) -> float | None:
    """Change from the last close on/before the same calendar date `months`
    ago to the latest close. None when history doesn't reach back that far."""
    if not series:
        return None
    target = _months_back(series[-1][0], months)
    if series[0][0] > target:
        return None
    base = next((c for d, c in reversed(series) if d <= target), None)
    return (series[-1][1] / base - 1.0) if base else None


def _returns(vals: list[float]) -> list[float]:
    return [vals[i] / vals[i - 1] - 1.0 for i in range(1, len(vals)) if vals[i - 1]]


def _ann_vol(rets: list[float]) -> float | None:
    if len(rets) < 5:
        return None
    return pstdev(rets) * math.sqrt(TRADING_DAYS)


def _beta_corr(a: list[float], b: list[float]) -> tuple[float | None, float | None]:
    n = min(len(a), len(b))
    if n < 10:
        return None, None
    a, b = a[-n:], b[-n:]
    ma, mb = mean(a), mean(b)
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b)) / n
    va = sum((x - ma) ** 2 for x in a) / n
    vb = sum((y - mb) ** 2 for y in b) / n
    beta = cov / vb if vb else None
    corr = cov / math.sqrt(va * vb) if va and vb else None
    return beta, corr


def _aligned_returns(
    x: list[tuple[date, float]], y: list[tuple[date, float]]
) -> tuple[list[float], list[float]]:
    ym = dict(y)
    common = [(d, c, ym[d]) for d, c in x if d in ym]
    xs = [c for _, c, _ in common]
    ys = [v for _, _, v in common]
    return _returns(xs), _returns(ys)


def _max_drawdown(vals: list[float]) -> tuple[float | None, float | None]:
    """(max drawdown, current drawdown) as negative fractions."""
    if len(vals) < 2:
        return None, None
    peak, mdd = vals[0], 0.0
    for v in vals:
        peak = max(peak, v)
        if peak:
            mdd = min(mdd, v / peak - 1.0)
    cur = vals[-1] / max(vals) - 1.0 if max(vals) else None
    return mdd, cur


def _rsi(vals: list[float], n: int = 14) -> float | None:
    if len(vals) <= n:
        return None
    gains, losses = 0.0, 0.0
    for i in range(len(vals) - n, len(vals)):
        ch = vals[i] - vals[i - 1]
        gains += max(ch, 0.0)
        losses += max(-ch, 0.0)
    if losses == 0:
        return 100.0
    rs = (gains / n) / (losses / n)
    return 100.0 - 100.0 / (1.0 + rs)


def _sma(vals: list[float], n: int) -> float | None:
    return mean(vals[-n:]) if len(vals) >= n else None


def _quote_row(
    ticker: str,
    series: list[tuple[date, float]],
    *,
    held: set[str],
    profiles: dict[str, CompanyProfile] | None = None,
    spark_n: int = 30,
    vols: list[tuple[date, float]] | None = None,
) -> dict[str, Any] | None:
    if not series:
        return None
    v_last, v_avg, v_rel = _rel_vol(vols)
    last_d, last = series[-1]
    year = [c for d, c in series if d >= last_d - timedelta(days=365)]
    hi, lo = (max(year), min(year)) if year else (None, None)
    closes = [c for _, c in series]
    return {
        "ticker": ticker,
        "name": _name(ticker, profiles),
        "sector": SECTOR_MAP.get(ticker, "Other"),
        "held": ticker in held,
        "as_of": last_d.isoformat(),
        "last": _r(last, 4),
        "prev": _r(series[-2][1], 4) if len(series) > 1 else None,
        "chg_1d": _r(_chg(series, 1), 5),
        "chg_5d": _r(_chg(series, 5), 5),
        # Calendar windows (close on/before the same date 1M/3M/1Y ago) — the
        # same definition the charts use for their range buttons, so a "1Y"
        # figure reads the same on every panel.
        "chg_1m": _r(_chg_back(series, months=1), 5),
        "chg_3m": _r(_chg_back(series, months=3), 5),
        "chg_ytd": _r(_chg_since(series, date(last_d.year, 1, 1)), 5),
        "chg_1y": _r(_chg_back(series, months=12), 5),
        "hi_52w": _r(hi, 4),
        "lo_52w": _r(lo, 4),
        "pos_52w": _r((last - lo) / (hi - lo), 4) if hi and lo and hi > lo else None,
        "vol_20d": _r(_ann_vol(_returns(closes[-21:])), 4),
        "volume": _r(v_last, 0),
        "avg_volume_20d": _r(v_avg, 0),
        "rel_volume": _r(v_rel, 3),
        "spark": [_r(c, 4) for c in closes[-spark_n:]],
    }


def _profiles(s: Session, tickers: Iterable[str]) -> dict[str, CompanyProfile]:
    tickers = list(tickers)
    if not tickers:
        return {}
    return {
        p.ticker: p
        for p in s.scalars(select(CompanyProfile).where(CompanyProfile.ticker.in_(tickers))).all()
    }


def _daily_snapshots(s: Session, since: datetime | None = None) -> list[tuple[date, float, float | None, float]]:
    """Last PortfolioSnapshot per ET calendar day → [(day, equity, spy, cash)].

    sync_account writes a snapshot every 5 minutes, so production holds tens
    of thousands of rows: select bare columns (no ORM objects) and keep only
    the last one per day.
    """
    q = select(PortfolioSnapshot.at, PortfolioSnapshot.equity, PortfolioSnapshot.spy_close, PortfolioSnapshot.cash).order_by(
        asc(PortfolioSnapshot.at)
    )
    if since is not None:
        q = q.where(PortfolioSnapshot.at >= since.replace(tzinfo=None))
    by_day: dict[date, tuple[float, float | None, float]] = {}
    for at, equity, spy, cash in s.execute(q).all():
        by_day[_aware(at).astimezone(ET).date()] = (equity, spy, cash)
    return [(d, e, sp, c) for d, (e, sp, c) in sorted(by_day.items())]


def _trading_days_only(s: Session, days: list[tuple[date, float, float | None, float]]) -> list[tuple[date, float, float | None, float]]:
    """Keep only sessions the market was open. sync_account snapshots every
    5 minutes all week, so weekends/holidays would otherwise add zero-return
    days that deflate annualized vol and the up-day ratio. SPY's daily bars
    define the calendar; days after the newest bar (today, before the price
    refresh) count if they are weekdays."""
    if not days:
        return days
    spy_days = {
        _d(td)
        for (td,) in s.execute(
            select(PriceHistory.trade_date)
            .where(PriceHistory.ticker == "SPY")
            .where(PriceHistory.trade_date >= datetime.combine(days[0][0] - timedelta(days=3), time()))
        ).all()
    }
    if not spy_days:
        return [x for x in days if x[0].weekday() < 5]
    first, last = min(spy_days), max(spy_days)
    # price_history keeps ~260 bars, so older snapshots fall back to the
    # weekday rule instead of silently shrinking the window to one year.
    return [
        x for x in days
        if x[0] in spy_days or ((x[0] > last or x[0] < first) and x[0].weekday() < 5)
    ]


def _report_day(rd: datetime) -> date:
    """Earnings rows are stamped at 00:00 UTC of the report date — read the
    date as stored. Converting to ET would show 20:00 the evening before."""
    return _aware(rd).date()


def _next_routine(now: datetime) -> dict[str, Any] | None:
    best: tuple[datetime, tuple] | None = None
    local = now.astimezone(ET)
    for entry in _ROUTINES:
        name, dow, hh, mm, _ = entry
        for add in range(0, 8):
            day = (local + timedelta(days=add)).date()
            wd = day.weekday()
            if dow == "fri" and wd != 4:
                continue
            if dow == "mon-fri" and wd > 4:
                continue
            fire = datetime.combine(day, time(hh, mm), tzinfo=ET)
            if fire > local:
                if best is None or fire < best[0]:
                    best = (fire, entry)
                break
    if not best:
        return None
    fire, (name, _, _, _, what) = best
    return {
        "name": name,
        "fire_at": _iso(fire.astimezone(timezone.utc)),
        "seconds_until": int((fire - local).total_seconds()),
        "what": what,
    }


def _held_positions(s: Session) -> list[Position]:
    return [p for p in s.scalars(select(Position)).all() if (p.qty or 0) > 0]


def _equity_now(s: Session, positions: list[Position]) -> tuple[float | None, float | None]:
    snap = s.scalars(select(PortfolioSnapshot).order_by(desc(PortfolioSnapshot.at)).limit(1)).first()
    if snap:
        return snap.equity, snap.cash
    mv = sum(p.market_value or 0 for p in positions)
    return (mv or None), None


# ---------------------------------------------------------------------------
# endpoints
# ---------------------------------------------------------------------------


@router.get("/universe")
def universe() -> list[dict]:
    """Every tradable symbol with a display name, sector and held flag —
    feeds the command line's autocomplete."""
    with SessionLocal() as s:
        held = {p.ticker for p in _held_positions(s)}
        profiles = _profiles(s, FULL_UNIVERSE)
    return [
        {
            "ticker": t,
            "name": _name(t, profiles),
            "sector": SECTOR_MAP.get(t, "Other"),
            "held": t in held,
            "kind": "bond_etf" if t in FIXED_INCOME_UNIVERSE else ("etf" if SECTOR_MAP.get(t) == "BroadETF" else "equity"),
        }
        for t in FULL_UNIVERSE
    ]


@router.get("/monitor")
def monitor(tickers: str | None = Query(None, description="comma-separated; default = full cross-asset monitor")) -> dict:
    """Cross-asset security monitor: equity indices, sector SPDRs, global
    equity, Treasuries, credit, FX, commodities and crypto — each row with
    last, 1D/5D/1M/3M/YTD/1Y change, 52-week range position, 20-day realized
    vol, relative volume and a 30-close sparkline — plus VIX and the FRED
    rates block (yield curve, curve and credit spreads, dollar, oil)."""
    if tickers:
        wanted = [t.strip().upper() for t in tickers.split(",")]
    else:
        wanted = list(DEFAULT_MONITOR) + list(MONITOR_EXTRA)
    wanted = [t for t in wanted if _TICKER_RX.match(t)][:80]
    since = datetime.now(timezone.utc) - timedelta(days=400)
    with SessionLocal() as s:
        series = _closes(s, wanted, since)
        vols = _volumes(s, wanted, since - timedelta(days=0))
        held = {p.ticker for p in _held_positions(s)}
        profiles = _profiles(s, wanted)
        regime = s.scalars(select(MarketRegime).order_by(desc(MarketRegime.as_of)).limit(1)).first()
        regimes = s.scalars(
            select(MarketRegime).order_by(desc(MarketRegime.as_of)).limit(30)
        ).all()
        macro = _macro_block(s)
    rows = []
    for t in wanted:
        r = _quote_row(t, series.get(t, []), held=held, profiles=profiles, vols=vols.get(t))
        if r:
            r["group"] = _CORE_GROUPS.get(t) or (MONITOR_EXTRA[t][0] if t in MONITOR_EXTRA else "Other")
            rows.append(r)
    if not tickers:
        rows.sort(key=lambda r: _MONITOR_ORDER.index(r["group"]) if r["group"] in _MONITOR_ORDER else 99)
    vix = None
    if regime and regime.vix is not None:
        hist = [x.vix for x in reversed(regimes) if x.vix is not None]
        vix = {
            "ticker": "VIX",
            "name": "CBOE Volatility Index",
            "last": _r(regime.vix, 2),
            "chg_5d_abs": _r(regime.vix_5d_change, 2),
            "spark": [_r(v, 2) for v in hist],
            "as_of": _iso(regime.as_of),
        }
    return {"rows": rows, "vix": vix, "macro": macro, "groups": _MONITOR_ORDER}


_SPREAD_LEGS = {"T10Y2Y": ("DGS10", "DGS2"), "T10Y3M": ("DGS10", "DGS3MO")}


def _macro_block(s: Session) -> list[dict]:
    """Latest FRED observations with 1D/5D/1M changes (percentage points for
    yields and spreads — the UI shows them as bp) and a 60-observation
    sparkline. Empty until the macro job has run."""
    from bot.signals.macro import SERIES, YF_SERIES

    catalog = {**SERIES, **{f"YF:{k}": v for k, v in YF_SERIES.items()}}

    since = (datetime.now(timezone.utc) - timedelta(days=200)).replace(tzinfo=None)
    rows = s.execute(
        select(MacroSeries.series_id, MacroSeries.obs_date, MacroSeries.value)
        .where(MacroSeries.obs_date >= since)
        .where(MacroSeries.value.is_not(None))
        .order_by(asc(MacroSeries.obs_date))
    ).all()
    by: dict[str, list[tuple[date, float]]] = defaultdict(list)
    for sid, d, v in rows:
        by[sid].append((_d(d), float(v)))
    # Curve spreads are rebuilt from the displayed yield legs on the dates both
    # exist, so 2s10s always equals 10Y − 2Y on screen. FRED publishes T10Y2Y
    # a day ahead of the DGS legs; mixing dates made the rows disagree.
    for sid, (long_leg, short_leg) in _SPREAD_LEGS.items():
        a, b = dict(by.get(long_leg, [])), dict(by.get(short_leg, []))
        derived = [(d, round(a[d] - b[d], 4)) for d in sorted(a.keys() & b.keys())]
        if derived:
            by[sid] = derived
    out = []
    for sid, (group, label, unit) in catalog.items():
        ser = by.get(sid)
        if not ser:
            continue
        last_d, last = ser[-1]

        def delta(back: int) -> float | None:
            if len(ser) <= back:
                return None
            base = ser[-1 - back][1]
            return (last - base) if unit == "pct" else ((last / base - 1.0) if base else None)

        out.append({
            "series_id": sid, "group": group, "label": label, "unit": unit,
            "as_of": last_d.isoformat(), "last": _r(last, 4),
            "chg_1d": _r(delta(1), 5), "chg_5d": _r(delta(5), 5), "chg_1m": _r(delta(21), 5),
            "spark": [_r(v, 4) for _, v in ser[-60:]],
        })
    return out


@router.get("/heatmap")
def heatmap() -> dict:
    """Whole-universe 1D / 5D / 1M change grid, grouped by sector, with the
    book's weight per name so the UI can outline what we own."""
    since = datetime.now(timezone.utc) - timedelta(days=60)
    with SessionLocal() as s:
        series = _closes(s, FULL_UNIVERSE, since)
        positions = _held_positions(s)
        equity, _ = _equity_now(s, positions)
        profiles = _profiles(s, FULL_UNIVERSE)
    weights = {p.ticker: (p.market_value or 0) / equity for p in positions if equity}
    cells = []
    as_of = None
    for t in FULL_UNIVERSE:
        ser = series.get(t)
        if not ser:
            continue
        as_of = max(as_of or ser[-1][0], ser[-1][0])
        cells.append({
            "ticker": t,
            "sector": SECTOR_MAP.get(t, "Other"),
            "last": _r(ser[-1][1], 4),
            "chg_1d": _r(_chg(ser, 1), 5),
            "chg_5d": _r(_chg(ser, 5), 5),
            "chg_1m": _r(_chg(ser, 21), 5),
            "held": t in weights,
            "weight": _r(weights.get(t), 5),
            "name": _name(t, profiles),
            # GICS-style sector from the company profile (Yahoo): splits
            # Communication Services and Consumer Cyclical/Defensive out of the
            # bot's coarse SECTOR_MAP buckets. Null for ETFs / unknown.
            "gics": profiles[t].sector if t in profiles and profiles[t].sector else None,
            # Market cap (ETFs: AUM) for area-weighted tiles; null until the
            # weekly profile job has seen the name.
            "mcap": profiles[t].market_cap if t in profiles and profiles[t].market_cap else None,
        })
    sectors: dict[str, list[float]] = defaultdict(list)
    for c in cells:
        if c["chg_1d"] is not None:
            sectors[c["sector"]].append(c["chg_1d"])
    # One breadth definition for every surface (tape, heatmap header): moves
    # inside ±0.05% count as unchanged.
    band = 0.0005
    adv = sum(1 for c in cells if (c["chg_1d"] or 0) > band)
    dec = sum(1 for c in cells if (c["chg_1d"] or 0) < -band)
    unch = sum(1 for c in cells if c["chg_1d"] is not None and abs(c["chg_1d"]) <= band)
    return {
        "as_of": as_of.isoformat() if as_of else None,
        "cells": cells,
        "sectors": sorted(
            ({"sector": k, "avg_1d": _r(mean(v), 5), "count": len(v)} for k, v in sectors.items()),
            key=lambda x: -(x["avg_1d"] or 0),
        ),
        "advancers": adv,
        "decliners": dec,
        "unchanged": unch,
        "unchanged_band": band,
    }


@router.get("/security/{ticker}")
def security(ticker: str, days: int = Query(730, ge=30, le=1825)) -> dict:
    """Everything the terminal knows about one symbol: price series + stats,
    our position and stop math, the bot's decisions/trades with theses,
    tagged news, politician/13F flow, and earnings history."""
    ticker = ticker.upper().strip()
    if not _TICKER_RX.match(ticker):
        raise HTTPException(400, f"invalid ticker {ticker!r}")
    since = datetime.now(timezone.utc) - timedelta(days=days)
    with SessionLocal() as s:
        series_map = _closes(s, [ticker, "SPY"], since)
        ser = series_map.get(ticker, [])
        bars = {
            _d(td): (o, h, lo, v)
            for td, o, h, lo, v in s.execute(
                select(PriceHistory.trade_date, PriceHistory.open, PriceHistory.high, PriceHistory.low, PriceHistory.volume)
                .where(PriceHistory.ticker == ticker)
                .where(PriceHistory.trade_date >= since.replace(tzinfo=None))
            ).all()
        }
        spy = series_map.get("SPY", [])
        held_rows = _held_positions(s)
        held = {p.ticker for p in held_rows}
        pos = next((p for p in held_rows if p.ticker == ticker), None)
        equity, _ = _equity_now(s, held_rows)
        profile = s.get(CompanyProfile, ticker)
        decisions = s.scalars(
            select(Decision).where(Decision.ticker == ticker).order_by(desc(Decision.at)).limit(40)
        ).all()
        trades = s.scalars(
            select(Trade).where(Trade.ticker == ticker).order_by(desc(Trade.submitted_at)).limit(40)
        ).all()
        news = s.scalars(
            select(NewsItem)
            # Bounded window: the news table grows every 15 min forever, and a
            # JSON LIKE can't use an index.
            .where(NewsItem.published_at >= (datetime.now(timezone.utc) - timedelta(days=60)).replace(tzinfo=None))
            .where(cast(NewsItem.tickers, String).like(f'%"{ticker}"%'))
            .order_by(desc(NewsItem.published_at))
            .limit(30)
        ).all()
        signals = s.scalars(
            select(Signal).where(Signal.ticker == ticker).order_by(desc(Signal.as_of)).limit(30)
        ).all()
        upcoming = s.scalars(
            select(EarningsCalendar)
            .where(EarningsCalendar.ticker == ticker)
            .where(EarningsCalendar.report_date >= (datetime.now(timezone.utc) - timedelta(days=1)).replace(tzinfo=None))
            .order_by(asc(EarningsCalendar.report_date))
            .limit(1)
        ).first()
        history = s.scalars(
            select(EarningsHistory).where(EarningsHistory.ticker == ticker).order_by(desc(EarningsHistory.quarter)).limit(8)
        ).all()

    if not ser and not pos and not decisions and ticker not in FULL_UNIVERSE:
        raise HTTPException(404, f"no data for {ticker}")

    vol_series = [(d, bars[d][3]) for d, _ in ser if d in bars and bars[d][3] is not None]
    quote = (
        _quote_row(ticker, ser, held=held, profiles={ticker: profile} if profile else None, spark_n=60, vols=vol_series)
        if ser else None
    )
    closes = [c for _, c in ser]
    year = [(d, c) for d, c in ser if ser and d >= ser[-1][0] - timedelta(days=365)]
    a, b = _aligned_returns(year, spy)
    beta, corr = _beta_corr(a, b)
    mdd, cur_dd = _max_drawdown([c for _, c in year])
    stats = {
        "vol_20d": _r(_ann_vol(_returns(closes[-21:])), 4),
        "vol_60d": _r(_ann_vol(_returns(closes[-61:])), 4),
        "beta_1y": _r(beta, 3),
        "corr_1y": _r(corr, 3),
        "max_dd_1y": _r(mdd, 4),
        "drawdown": _r(cur_dd, 4),
        "rsi_14": _r(_rsi(closes), 2),
        "sma_20": _r(_sma(closes, 20), 4),
        "sma_50": _r(_sma(closes, 50), 4),
        "sma_200": _r(_sma(closes, 200), 4),
        "rel_spy_3m": _r(
            (_chg_back(ser, months=3) - _chg_back(spy, months=3))
            if _chg_back(ser, months=3) is not None and _chg_back(spy, months=3) is not None else None, 5
        ),
    }

    position = None
    if pos:
        trail = pos.trail_pct or LLM_TRAILING_STOP_PCT
        stop = (pos.peak_price or pos.market_price) * (1 - trail)
        cut = pos.avg_cost * (1 - LLM_MIDDAY_STOP_LOSS_PCT)
        position = {
            "qty": pos.qty,
            "avg_cost": _r(pos.avg_cost, 4),
            "market_price": _r(pos.market_price, 4),
            "market_value": _r(pos.market_value, 2),
            "unrealized_pnl": _r(pos.unrealized_pnl, 2),
            "unrealized_pct": _r(pos.market_price / pos.avg_cost - 1, 5) if pos.avg_cost else None,
            "weight": _r((pos.market_value or 0) / equity, 5) if equity else None,
            "peak_price": _r(pos.peak_price, 4),
            "trail_pct": trail,
            "stop_price": _r(stop, 4),
            "stop_distance": _r(pos.market_price / stop - 1, 5) if stop else None,
            "midday_cut_price": _r(cut, 4),
            "midday_cut_distance": _r(pos.market_price / cut - 1, 5) if cut else None,
            "broker_stop": bool(pos.stop_order_id),
            "opened_at": _iso(pos.opened_at),
            "updated_at": _iso(pos.updated_at),
        }

    return {
        "ticker": ticker,
        "name": _name(ticker, {ticker: profile} if profile else None),
        "sector": SECTOR_MAP.get(ticker, profile.sector if profile else "Other"),
        "in_universe": ticker in FULL_UNIVERSE,
        "quote": quote,
        "series": [
            {
                "d": d.isoformat(), "c": _r(c, 4),
                "o": _r(bars[d][0], 4) if d in bars else None,
                "h": _r(bars[d][1], 4) if d in bars else None,
                "l": _r(bars[d][2], 4) if d in bars else None,
                "v": _r(bars[d][3], 0) if d in bars else None,
            }
            for d, c in ser
        ],
        "spy_series": [{"d": d.isoformat(), "c": _r(c, 4)} for d, c in spy],
        "stats": stats,
        "position": position,
        "profile": (
            {
                "name": profile.name,
                "sector": profile.sector,
                "industry": profile.industry,
                "description": profile.description,
                "website": profile.website,
                "exchange": profile.exchange,
                "country": profile.country,
                "market_cap": profile.market_cap,
                "employees": profile.employees,
            }
            if profile
            else None
        ),
        "decisions": [
            {"id": d.id, "at": _iso(d.at), "action": d.action, "reason": d.reason, "dry_run": d.dry_run, "trade_id": d.trade_id}
            for d in decisions
        ],
        "trades": [
            {
                "id": t.id, "side": t.side, "qty": t.qty, "price": _r(t.price, 4), "notional": _r(t.notional, 2),
                "status": t.status, "dry_run": t.dry_run, "submitted_at": _iso(t.submitted_at), "filled_at": _iso(t.filled_at),
            }
            for t in trades
        ],
        "news": [
            {
                "id": n.id, "title": n.title, "url": n.url, "source": n.source, "published_at": _iso(n.published_at),
                "vader_score": n.vader_score, "tickers": n.tickers or [],
            }
            for n in news
        ],
        "signals": [
            {
                "id": g.id, "kind": g.kind, "source": (g.meta or {}).get("politician") or g.source,
                "direction": g.direction, "amount": g.amount, "as_of": _iso(g.as_of),
                "chamber": (g.meta or {}).get("chamber"),
                # 13F: holdings quarter-end and filing date, so a quarter-old
                # position change never reads as fresh flow; plus the change verb.
                "period": (g.meta or {}).get("period"),
                "filed": (g.meta or {}).get("filed"),
                "change": (g.meta or {}).get("change"),
            }
            for g in signals
        ],
        "earnings": {
            "next": (
                {"report_date": _iso(upcoming.report_date), "time_of_day": upcoming.time_of_day, "eps_estimate": upcoming.eps_estimate}
                if upcoming else None
            ),
            "history": [
                {"quarter": h.quarter, "eps_actual": h.eps_actual, "eps_estimate": h.eps_estimate, "surprise_pct": h.surprise_pct}
                for h in history
            ],
        },
    }


_NEWS_CACHE: dict[str, tuple[float, list[dict]]] = {}
_NEWS_TTL_S = 900


_YAHOO_RSS = "https://feeds.finance.yahoo.com/rss/2.0/headline?s={sym}&region=US&lang=en-US"


def _yf_news(ticker: str) -> list[dict]:
    """Company headlines from Yahoo Finance's per-ticker RSS feed (the same
    feedparser path the bot's news job uses), normalized. Any failure → []
    so the screen falls back to locally-scraped news."""
    try:
        import feedparser
        import requests

        r = requests.get(
            _YAHOO_RSS.format(sym=ticker.replace(".", "-")),
            headers={"User-Agent": "Mozilla/5.0 (compatible; cromaz-terminal)"},
            timeout=8,
        )
        r.raise_for_status()
        feed = feedparser.parse(r.content)
    except Exception as exc:
        from loguru import logger as _logger
        _logger.warning("yahoo rss news failed for {}: {}", ticker, exc)
        return []
    out = []
    for e in feed.entries:
        title = (e.get("title") or "").strip()
        if not title:
            continue
        pub = None
        if e.get("published_parsed"):
            pub = datetime(*e.published_parsed[:6], tzinfo=timezone.utc).isoformat()
        out.append({
            "title": title,
            "url": e.get("link") or "",
            "source": "Yahoo Finance",
            "published_at": pub,
            "summary": re.sub(r"<[^>]+>", "", e.get("summary") or "")[:400],
        })
    out.sort(key=lambda x: x["published_at"] or "", reverse=True)
    return out[:25]


@router.get("/security/{ticker}/news")
def security_news(ticker: str) -> dict:
    """Company-specific headlines for the security screen's CN panel —
    Yahoo's per-ticker feed (cached 15 min), scored with the bot's VADER
    analyzer so tone reads the same as the scraped wire."""
    import time as _time

    ticker = ticker.upper().strip()
    if not _TICKER_RX.match(ticker):
        raise HTTPException(400, f"invalid ticker {ticker!r}")
    hit = _NEWS_CACHE.get(ticker)
    if hit and _time.monotonic() - hit[0] < _NEWS_TTL_S:
        items = hit[1]
    else:
        items = _yf_news(ticker)
        try:
            from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

            sia = SentimentIntensityAnalyzer()
            for it in items:
                it["vader_score"] = round(sia.polarity_scores(it["title"])["compound"], 3)
        except Exception:
            pass
        _NEWS_CACHE[ticker] = (_time.monotonic(), items)
    return {"ticker": ticker, "source": "yahoo", "items": items}


@router.get("/regime/history")
def regime_history(days: int = Query(400, ge=5, le=1500)) -> list[dict]:
    """Daily regime label + inputs, oldest→newest, one row per ET session
    (the latest snapshot that day) — lets charts shade risk_on / neutral /
    risk_off periods behind price and equity."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).replace(tzinfo=None)
    with SessionLocal() as s:
        rows = s.scalars(
            select(MarketRegime).where(MarketRegime.as_of >= since).order_by(asc(MarketRegime.as_of))
        ).all()
    by_day: dict[date, MarketRegime] = {}
    for r in rows:
        by_day[_aware(r.as_of).astimezone(ET).date()] = r
    return [
        {
            "d": d.isoformat(),
            "label": r.regime_label,
            "vix": _r(r.vix, 2),
            "spy_trend": _r(r.spy_trend, 4),
            "breadth_pct": _r(r.breadth_pct, 2),
        }
        for d, r in sorted(by_day.items())
    ]


@router.get("/risk")
def risk() -> dict:
    """Portfolio risk & performance analytics from the equity snapshot series
    and the live position table: realized vol, Sharpe/Sortino, drawdown, beta
    and correlation to SPY, concentration, sector load vs cap, and per-name
    distance to the trailing stop and to the midday 7% cut."""
    with SessionLocal() as s:
        days = _trading_days_only(s, _daily_snapshots(s))
        positions = _held_positions(s)
        equity, cash = _equity_now(s, positions)
        snap_at = s.scalars(select(PortfolioSnapshot.at).order_by(desc(PortfolioSnapshot.at)).limit(1)).first()
        upcoming = s.scalars(
            select(EarningsCalendar)
            .where(EarningsCalendar.ticker.in_([p.ticker for p in positions] or ["~"]))
            .where(EarningsCalendar.report_date >= (datetime.now(timezone.utc) - timedelta(days=1)).replace(tzinfo=None))
            .order_by(asc(EarningsCalendar.report_date))
        ).all()

    eq = [e for _, e, _, _ in days]
    spy_pts = [(d, sp) for d, _, sp, _ in days if sp]
    bot_r = _returns(eq)
    a, b = _aligned_returns([(d, e) for d, e, _, _ in days], spy_pts)
    beta, corr = _beta_corr(a, b)
    vol = _ann_vol(bot_r)
    mu = mean(bot_r) * TRADING_DAYS if len(bot_r) >= 5 else None
    # Sortino's downside deviation: RMS of below-zero returns over ALL days
    # (not the stdev of the negative days alone).
    dvol = (
        math.sqrt(sum(min(r, 0.0) ** 2 for r in bot_r) / len(bot_r)) * math.sqrt(TRADING_DAYS)
        if len(bot_r) >= 5 and any(r < 0 for r in bot_r)
        else None
    )
    mdd, cur_dd = _max_drawdown(eq)

    spy_vals = [sp for _, sp in spy_pts]
    curve = []
    if days:
        e0 = days[0][1]
        s0 = next((sp for _, _, sp, _ in days if sp), None)
        peak = 0.0
        for d, e, sp, _ in days:
            peak = max(peak, e)
            curve.append({
                "d": d.isoformat(),
                "equity": _r(e, 2),
                "bot_pct": _r(e / e0 - 1, 5) if e0 else None,
                "spy_pct": _r(sp / s0 - 1, 5) if sp and s0 else None,
                "dd": _r(e / peak - 1, 5) if peak else None,
            })

    weights = sorted(
        (
            {
                "ticker": p.ticker,
                "sector": SECTOR_MAP.get(p.ticker, "Other"),
                "weight": (p.market_value or 0) / equity if equity else 0.0,
                "market_value": p.market_value or 0.0,
            }
            for p in positions
        ),
        key=lambda x: -x["weight"],
    )
    # Concentration over the *invested* book (weights renormalized to sum to
    # 1) — measured against total equity a 58%-cash book would read as ~55
    # "effective names" when it holds 10.
    invested = sum(w["weight"] for w in weights)
    hhi = sum((w["weight"] / invested) ** 2 for w in weights) if invested else 0.0
    sector_load: dict[str, float] = defaultdict(float)
    for w in weights:
        sector_load[w["sector"]] += w["weight"]

    next_er = {}
    for e in upcoming:
        next_er.setdefault(e.ticker, e)
    now = datetime.now(timezone.utc)
    guards = []
    for p in positions:
        trail = p.trail_pct or LLM_TRAILING_STOP_PCT
        stop = (p.peak_price or p.market_price) * (1 - trail)
        cut = p.avg_cost * (1 - LLM_MIDDAY_STOP_LOSS_PCT)
        er = next_er.get(p.ticker)
        er_days = (_report_day(er.report_date) - now.astimezone(ET).date()).days if er else None
        guards.append({
            "ticker": p.ticker,
            "price": _r(p.market_price, 4),
            "avg_cost": _r(p.avg_cost, 4),
            "pnl_pct": _r(p.market_price / p.avg_cost - 1, 5) if p.avg_cost else None,
            "stop_price": _r(stop, 4),
            "stop_distance": _r(p.market_price / stop - 1, 5) if stop else None,
            "cut_price": _r(cut, 4),
            "cut_distance": _r(p.market_price / cut - 1, 5) if cut else None,
            "trail_pct": trail,
            "broker_stop": bool(p.stop_order_id),
            "earnings_at": _iso(er.report_date) if er else None,
            "earnings_in_days": _r(er_days, 1),
        })
    guards.sort(key=lambda g: min(g["stop_distance"] or 9, g["cut_distance"] or 9))

    return {
        # Freshness of the underlying data (newest equity snapshot), so the
        # UI's live-age dot reflects the bot's sync, not this request.
        "as_of": _iso(snap_at) if snap_at else None,
        "computed_at": _iso(now),
        "equity": _r(equity, 2),
        "cash": _r(cash, 2),
        "cash_pct": _r(cash / equity, 4) if equity and cash is not None else None,
        "observations": len(bot_r),
        "ann_return": _r(mu, 4),
        "ann_vol": _r(vol, 4),
        "sharpe": _r(mu / vol, 2) if mu is not None and vol else None,
        "sortino": _r(mu / dvol, 2) if mu is not None and dvol else None,
        "max_drawdown": _r(mdd, 4),
        "drawdown": _r(cur_dd, 4),
        "beta": _r(beta, 3),
        "corr": _r(corr, 3),
        "spy_ann_vol": _r(_ann_vol(_returns(spy_vals)), 4),
        "best_day": _r(max(bot_r), 5) if bot_r else None,
        "worst_day": _r(min(bot_r), 5) if bot_r else None,
        "up_days_pct": _r(sum(1 for r in bot_r if r > 0) / len(bot_r), 4) if bot_r else None,
        "positions": len(positions),
        "max_positions": LLM_MAX_POSITIONS,
        "top5_weight": _r(sum(w["weight"] for w in weights[:5]), 4),
        "hhi": _r(hhi, 4),
        "effective_n": _r(1 / hhi, 2) if hhi else None,
        "weights": [{**w, "weight": _r(w["weight"], 5), "market_value": _r(w["market_value"], 2)} for w in weights],
        "sector_load": sorted(
            ({"sector": k, "weight": _r(v, 5), "cap": MAX_SECTOR_PCT, "over": v > MAX_SECTOR_PCT} for k, v in sector_load.items()),
            key=lambda x: -(x["weight"] or 0),
        ),
        "guards": guards,
        "curve": curve,
    }


@router.get("/brief")
def brief() -> dict:
    """The terminal's intelligence brief — a deterministic, data-derived read
    of the book right now: today's move vs SPY with contributors, risk flags
    (stops, the midday cut, earnings blackout, sector caps), catalysts, macro
    regime, insider flow on names we own, and what the bot does next."""
    now = datetime.now(timezone.utc)
    with SessionLocal() as s:
        positions = _held_positions(s)
        held = [p.ticker for p in positions]
        equity, cash = _equity_now(s, positions)
        series = _closes(s, held + ["SPY", "QQQ"], now - timedelta(days=20))
        days = _trading_days_only(s, _daily_snapshots(s, now - timedelta(days=14)))
        regime = s.scalars(select(MarketRegime).order_by(desc(MarketRegime.as_of)).limit(1)).first()
        last_run_any = s.scalars(select(LLMRun).order_by(desc(LLMRun.started_at)).limit(1)).first()
        last_run = s.scalars(
            select(LLMRun).where(LLMRun.status == "ok").order_by(desc(LLMRun.started_at)).limit(1)
        ).first()
        failed = s.scalars(
            select(LLMRun).where(LLMRun.status != "ok").where(LLMRun.started_at >= (now - timedelta(days=2)).replace(tzinfo=None))
            .order_by(desc(LLMRun.started_at))
        ).all()
        job_fail = s.scalars(
            select(JobRun).where(JobRun.status == "failed").where(JobRun.started_at >= (now - timedelta(hours=24)).replace(tzinfo=None))
            .order_by(desc(JobRun.started_at)).limit(5)
        ).all()
        er = s.scalars(
            select(EarningsCalendar)
            .where(EarningsCalendar.ticker.in_(held or ["~"]))
            .where(EarningsCalendar.report_date >= (now - timedelta(days=1)).replace(tzinfo=None))
            .where(EarningsCalendar.report_date <= (now + timedelta(days=10)).replace(tzinfo=None))
            .order_by(asc(EarningsCalendar.report_date))
        ).all()
        flow = s.scalars(
            select(Signal)
            .where(Signal.ticker.in_(held or ["~"]))
            .where(Signal.as_of >= (now - timedelta(days=21)).replace(tzinfo=None))
            .order_by(desc(Signal.as_of)).limit(8)
        ).all()

    items: list[dict] = []

    def add(kind: str, tone: str, text: str, ticker: str | None = None, *, severity: int = 0,
            metrics: dict | None = None, at: datetime | date | None = None) -> None:
        """severity: 0 info · 1 watch · 2 act · 3 breach. ``metrics`` carries
        the numbers behind risk items so the UI can render them as a table.
        ``at`` is when the underlying fact was observed (a date for report
        days), so the UI can age each line."""
        at_s = _iso(at) if isinstance(at, datetime) else at.isoformat() if isinstance(at, date) else None
        items.append({"kind": kind, "tone": tone, "text": text, "ticker": ticker,
                      "severity": severity, "metrics": metrics, "at": at_s})

    marks_at = max((_aware(p.updated_at) for p in positions if p.updated_at), default=None)

    # --- the book today -------------------------------------------------
    contrib = []
    for p in positions:
        ser = series.get(p.ticker, [])
        prev = ser[-2][1] if len(ser) >= 2 else None
        # Live mark vs the prior close when the position row is fresher than
        # the last daily bar; otherwise last bar vs the bar before it.
        if ser and _aware(p.updated_at) and _aware(p.updated_at).astimezone(ET).date() > ser[-1][0]:
            prev = ser[-1][1]
        if prev:
            contrib.append((p.ticker, (p.market_price - prev) * p.qty, p.market_price / prev - 1))
    day_pnl = sum(c[1] for c in contrib) if contrib else None
    spy_1d = _chg(series.get("SPY", []), 1)
    if day_pnl is not None and equity:
        book_pct = day_pnl / equity
        rel = f" vs SPY {_pct(spy_1d)}" if spy_1d is not None else ""
        add("perf", "up" if day_pnl >= 0 else "down",
            f"Book {_usd(day_pnl)} ({_pct(book_pct)}){rel}.", at=marks_at)
        contrib.sort(key=lambda c: c[1])
        if contrib:
            best, worst = contrib[-1], contrib[0]
            if best[1] > 0:
                add("perf", "up", f"{best[0]} leads, {_pct(best[2])} ({_usd(best[1])}).", best[0], at=marks_at)
            if worst[1] < 0:
                add("perf", "down", f"{worst[0]} drags, {_pct(worst[2])} ({_usd(worst[1])}).", worst[0], at=marks_at)
    if len(days) >= 2:
        wk = days[-1][1] / days[0][1] - 1 if days[0][1] else None
        if wk is not None:
            add("perf", "up" if wk >= 0 else "down", f"Equity {_pct(wk)} over the last {len(days)} sessions to ${days[-1][1]:,.0f}.", at=days[-1][0])

    # --- is the automation actually running? ----------------------------
    # Statuses like "sell @ midday" or "next premarket in 3h" are promises the
    # bot keeps only while routines are enabled and recently run.
    last_any = last_run_any
    bot_stale = last_any is None or (now - _aware(last_any.started_at)) > BOT_STALE
    routines_on = bool(settings.llm_routines_enabled)
    bot_active = routines_on and not bot_stale
    sell_note = "a sell candidate at the next midday scan" if bot_active else "bot off — manual sell needed"
    stop_note = "the stop should fire" if bot_active else "stop unenforced (bot off) — manual exit needed"

    # --- risk flags ------------------------------------------------------
    for p in positions:
        p_at = _aware(p.updated_at)
        trail = p.trail_pct or LLM_TRAILING_STOP_PCT
        stop = (p.peak_price or p.market_price) * (1 - trail)
        cut = p.avg_cost * (1 - LLM_MIDDAY_STOP_LOSS_PCT)
        d_stop = p.market_price / stop - 1 if stop else None
        d_cut = p.market_price / cut - 1 if cut else None
        m = {
            "last": _r(p.market_price, 4), "cut_price": _r(cut, 4), "cut_distance": _r(d_cut, 5),
            "stop_price": _r(stop, 4), "stop_distance": _r(d_stop, 5), "trail_pct": trail,
            "pnl_pct": _r(p.market_price / p.avg_cost - 1, 5) if p.avg_cost else None,
            "weight": _r((p.market_value or 0) / equity, 5) if equity else None,
            "market_value": _r(p.market_value, 2),
            "pnl_usd": _r(p.unrealized_pnl, 2),
            # Dollars already through the tightest breached guard (value ×
            # depth) — ranks breaches by both size and severity.
            "usd_beyond": _r(
                (p.market_value or 0) * abs(min(v for v in (d_cut, d_stop) if v is not None))
                if any(v is not None and v < 0 for v in (d_cut, d_stop)) else 0.0, 2),
        }
        if d_cut is not None and d_cut < 0:
            add("risk", "down",
                f"{p.ticker} is {abs(d_cut) * 100:.1f}% below the midday −7% cut (${cut:,.2f}) — {sell_note}.",
                p.ticker, severity=3, metrics={**m, "action": "SELL @ midday" if bot_active else "MANUAL SELL · bot off"}, at=p_at)
        elif d_stop is not None and d_stop < 0:
            add("risk", "down", f"{p.ticker} is {abs(d_stop) * 100:.1f}% below its {trail * 100:.0f}% trailing stop (${stop:,.2f}) — {stop_note}.",
                p.ticker, severity=3, metrics={**m, "action": "STOP BREACHED · unfilled"}, at=p_at)
        elif d_cut is not None and d_cut < 0.02:
            add("risk", "warn",
                f"{p.ticker} is {d_cut * 100:.1f}% above the midday −7% cut (${cut:,.2f}) — next midday scan sells it below that.",
                p.ticker, severity=1, metrics={**m, "action": "WATCH cut"}, at=p_at)
        elif d_stop is not None and d_stop < 0.03:
            add("risk", "warn", f"{p.ticker} sits {d_stop * 100:.1f}% above its {trail * 100:.0f}% trailing stop (${stop:,.2f}).",
                p.ticker, severity=1, metrics={**m, "action": "WATCH stop"}, at=p_at)
        if not p.stop_order_id:
            pass  # synthetic stop engine covers it; surfaced per-row in /risk
    sec: dict[str, float] = defaultdict(float)
    for p in positions:
        if equity:
            sec[SECTOR_MAP.get(p.ticker, "Other")] += (p.market_value or 0) / equity
    for k, v in sec.items():
        if v > MAX_SECTOR_PCT:
            add("risk", "warn", f"{k} is {v * 100:.1f}% of equity — above the {MAX_SECTOR_PCT * 100:.0f}% sector guide.", at=marks_at)
    if equity and cash is not None:
        add("risk", "info",
            f"{len(positions)}/{LLM_MAX_POSITIONS} slots used · cash {cash / equity * 100:.1f}% (${cash:,.0f}) available to deploy.", at=marks_at)

    # --- catalysts -------------------------------------------------------
    seen = set()
    for e in er:
        if e.ticker in seen:
            continue
        seen.add(e.ticker)
        rd = _report_day(e.report_date)
        dd = (rd - now.astimezone(ET).date()).days
        if dd < 0:
            continue
        when = rd.strftime("%a %b %d")
        tod = {"bmo": " pre-mkt", "amc": " after close"}.get((e.time_of_day or "").lower(), "")
        tone = "warn" if dd <= 2 else "info"
        add("catalyst", tone,
            f"{e.ticker} reports {when}{tod}" + (f" (est EPS ${e.eps_estimate:.2f})" if e.eps_estimate is not None else "")
            + (" — inside the 2-day blackout, no adds." if dd <= 2 else "."), e.ticker, at=rd)

    # --- macro -----------------------------------------------------------
    if regime:
        bits = [f"Regime {str(regime.regime_label or '?').replace('_', ' ').upper()}"]
        if regime.vix is not None:
            bits.append(f"VIX {regime.vix:.1f}" + (f" ({'+' if regime.vix_5d_change > 0 else '−' if regime.vix_5d_change < 0 else ''}{abs(regime.vix_5d_change):.1f} 5d)" if regime.vix_5d_change is not None else ""))
        if regime.breadth_pct is not None:
            b_ = regime.breadth_pct if regime.breadth_pct > 1 else regime.breadth_pct * 100
            bits.append(f"breadth {b_:.0f}% > 50DMA")
        if regime.t10y2y is not None:
            bits.append(f"2s10s {'+' if regime.t10y2y > 0 else '−' if regime.t10y2y < 0 else ''}{abs(regime.t10y2y):.2f}")
        tone = {"risk_on": "up", "risk_off": "down"}.get(regime.regime_label or "", "info")
        suffix = " — sizes halve and only 1 new name/day." if regime.regime_label == "risk_off" else "."
        add("macro", tone, " · ".join(bits) + suffix, at=regime.as_of)

    # --- flow ------------------------------------------------------------
    # One line per (who, name, side, day): a PTR often lists several lots of
    # the same trade, which read as duplicate rows.
    merged: dict[tuple, list] = {}
    for g in flow:
        who = (g.meta or {}).get("politician") or g.source
        key = (who, g.ticker, g.direction, _aware(g.as_of).date())
        if key in merged:
            merged[key][1] += g.amount or 0
            merged[key][2] += 1
        else:
            merged[key] = [g, g.amount or 0, 1]
    for (who, ticker, direction, day), (g, amount, n) in list(merged.items())[:3]:
        amt = f" (~${amount:,.0f}" + (f", {n} lots" if n > 1 else "") + ")" if amount else ""
        add("flow", "up" if direction == "buy" else "down",
            f"{who} {'bought' if direction == 'buy' else 'sold'} {ticker}{amt}, disclosed {day:%b %d}.", ticker, at=g.as_of)

    # --- the bot ---------------------------------------------------------
    nxt = _next_routine(now)
    if not routines_on:
        add("bot", "down", "Routines are disabled in the bot's config — no scheduled buys, sells or stop tightening.", severity=2, at=now)
    elif bot_stale:
        age = f"{(now - _aware(last_any.started_at)).days}d" if last_any else "never"
        add("bot", "down", f"Bot stale — last routine {age} ago; scheduled actions are not running.", severity=3,
            at=last_any.started_at if last_any else None)
    elif nxt:
        mins = nxt["seconds_until"] // 60
        eta = f"{mins // 60}h {mins % 60:02d}m" if mins >= 60 else f"{mins}m"
        add("bot", "info", f"Next: {nxt['name']} in {eta} — {nxt['what']}.", at=now)
    if last_run and last_run.summary:
        first = re.split(r"(?<=[.!?])\s+", re.sub(r"[#*`>|_-]{2,}|\s+", " ", last_run.summary).strip(), maxsplit=1)[0]
        add("bot", "info", f"Last {last_run.routine} ({_aware(last_run.started_at).astimezone(ET):%a %H:%M} ET): {first[:220]}", at=last_run.started_at)
    for f in failed[:2]:
        add("bot", "down", f"{f.routine} run {f.status} at {_aware(f.started_at).astimezone(ET):%a %H:%M} ET" + (f": {f.error[:120]}" if f.error else "."), at=f.started_at)
    for j in job_fail[:2]:
        add("bot", "warn", f"Job {j.job_name} failed {_aware(j.started_at).astimezone(ET):%H:%M} ET" + (f": {(j.message or '')[:100]}" if j.message else "."), at=j.started_at)

    # Within each kind, most severe first (risk: breaches → near-cut → near-stop,
    # deepest breach first); kinds keep their reading order.
    order = {k: i for i, k in enumerate(["perf", "risk", "catalyst", "macro", "flow", "bot"])}

    def _depth(it: dict) -> float:
        m = it.get("metrics") or {}
        vals = [v for v in (m.get("cut_distance"), m.get("stop_distance")) if v is not None]
        return min(vals) if vals else 0.0

    items.sort(key=lambda it: (order.get(it["kind"], 9), -it["severity"], _depth(it)))
    rel = None
    if day_pnl is not None and equity and spy_1d is not None:
        rel = day_pnl / equity - spy_1d
    headline = items[0]["text"] if items else "No book activity yet."
    return {
        "as_of": _iso(now),
        "headline": headline,
        # Book session return minus SPY's, as a fraction — so "both red but
        # we beat SPY by 2bp" reads as a win, not a loss. One session, not alpha.
        "rel_spy_1d": _r(rel, 6),
        "bot": {
            "routines_enabled": routines_on,
            "stale": bot_stale,
            "active": bot_active,
            "last_run_at": _iso(last_any.started_at) if last_any else None,
        },
        "counts": {
            "breach": sum(1 for i in items if i["severity"] >= 3),
            "act": sum(1 for i in items if i["severity"] == 2),
            "watch": sum(1 for i in items if i["severity"] == 1),
            "info": sum(1 for i in items if i["severity"] == 0),
        },
        "items": items,
    }


@router.get("/wire")
def wire(limit: int = Query(80, ge=10, le=300)) -> list[dict]:
    """One chronological event stream across the whole system — orders,
    decisions, LLM routines, job failures, insider flow and strongly-scored
    headlines — for the terminal's live wire."""
    with SessionLocal() as s:
        trades = s.scalars(select(Trade).order_by(desc(Trade.submitted_at)).limit(limit)).all()
        runs = s.scalars(select(LLMRun).order_by(desc(LLMRun.started_at)).limit(limit // 2)).all()
        jobs = s.scalars(
            select(JobRun).where(JobRun.status.in_(["failed", "skipped"])).order_by(desc(JobRun.started_at)).limit(20)
        ).all()
        sigs = s.scalars(select(Signal).order_by(desc(Signal.as_of)).limit(limit // 2)).all()
        news = s.scalars(select(NewsItem).order_by(desc(NewsItem.published_at)).limit(limit * 2)).all()
        reasons = {
            d.trade_id: d.reason
            for d in s.scalars(select(Decision).where(Decision.trade_id.in_([t.id for t in trades] or [-1]))).all()
        }
    ev: list[dict] = []
    for t in trades:
        ev.append({
            "at": _iso(t.submitted_at), "type": "order", "tone": "up" if t.side == "buy" else "down",
            "ticker": t.ticker,
            "text": f"{t.side.upper()} {t.qty:g} {t.ticker} @ ${t.price:,.2f} (${t.notional:,.0f}) · {t.status}",
            "detail": reasons.get(t.id),
        })
    for r in runs:
        ev.append({
            "at": _iso(r.started_at), "type": "routine", "tone": "info" if r.status == "ok" else "down",
            "ticker": None,
            "text": f"{r.routine} · {r.status} · {r.tool_calls} tools" + (f" · ${r.usd_cost:.2f}" if r.usd_cost else ""),
            "detail": (r.summary or r.error or "")[:600] or None,
        })
    for j in jobs:
        ev.append({
            "at": _iso(j.started_at), "type": "job", "tone": "warn" if j.status == "skipped" else "down",
            "ticker": None, "text": f"{j.job_name} · {j.status}", "detail": j.message or None,
        })
    for g in sigs:
        meta = g.meta or {}
        who = meta.get("politician") or meta.get("investor") or g.source
        # 13F rows carry the position change (new/add/trim/exit) and the
        # quarter-over-quarter value; PTRs carry a disclosed-range midpoint.
        verb = (meta.get("change") or g.direction).upper()
        ev.append({
            "at": _iso(g.as_of), "type": g.kind, "tone": "up" if g.direction == "buy" else "down",
            "ticker": g.ticker,
            "text": f"{who} {verb} {g.ticker}" + (f" ~${g.amount:,.0f}" if g.amount else ""),
            "detail": (f"13F {meta.get('period', '')} vs {meta.get('prior_period', '')}" if g.kind == "investor" else None),
            "change": meta.get("change"),
            "traded_on": meta.get("traded_on"),
        })
    for n in news:
        # Lifestyle/macro features with no ticker carry no tradable signal
        # and VADER misreads them; the wire only shows tagged headlines.
        if n.vader_score is None or abs(n.vader_score) < 0.25 or not (n.tickers or []):
            continue
        ev.append({
            "at": _iso(n.published_at), "type": "news", "tone": "up" if n.vader_score > 0 else "down",
            "ticker": (n.tickers or [None])[0], "text": n.title, "detail": n.source, "url": n.url,
            "vader_score": _r(n.vader_score, 3), "tickers": n.tickers or [],
        })
    ev.sort(key=lambda e: e["at"] or "", reverse=True)
    return ev[:limit]
