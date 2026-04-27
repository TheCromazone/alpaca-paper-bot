"""Read-only JSON API over the trading SQLite DB.

Exposes endpoints the Next.js dashboard consumes. CORS is scoped to localhost
only — this service is not intended for internet exposure.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import desc, select

from bot.config import settings
from bot.db import (
    Decision,
    EarningsCalendar,
    EarningsHistory,
    JobRun,
    LLMRun,
    MarketRegime,
    NewsItem,
    PortfolioSnapshot,
    Position,
    PriceHistory,
    SessionLocal,
    Signal,
    Trade,
    init_db,
)
from bot.llm import memory as llm_memory

app = FastAPI(title="Alpaca Trading Bot API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
    ],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)

init_db()


def _iso_utc(dt: datetime | None) -> str | None:
    """Serialize a stored datetime as an explicit-UTC ISO string.

    Bot-side writes use ``datetime.now(timezone.utc)``, but SQLite strips the
    tz info on read so datetimes come back naive. If we emit those naive, the
    browser parses them as *local* time, breaking countdowns and "time ago"
    labels. We always tag them as UTC on the way out of the API.
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


@app.get("/health")
def health() -> dict:
    return {"ok": True, "now": _iso_utc(datetime.now(timezone.utc))}


@app.get("/portfolio/summary")
def portfolio_summary() -> dict:
    with SessionLocal() as s:
        latest = s.scalars(
            select(PortfolioSnapshot).order_by(desc(PortfolioSnapshot.at)).limit(1)
        ).first()
        if not latest:
            raise HTTPException(404, "no portfolio snapshots yet")

        positions = s.scalars(select(Position)).all()
        sectors: dict[str, float] = {}
        from bot.config import SECTOR_MAP
        for p in positions:
            sec = SECTOR_MAP.get(p.ticker, "Other")
            sectors[sec] = sectors.get(sec, 0.0) + p.market_value

        total_unrealized = sum(p.unrealized_pnl for p in positions)
        return {
            "equity": latest.equity,
            "cash": latest.cash,
            "buying_power": latest.buying_power,
            "invested": latest.equity - latest.cash,
            "unrealized_pnl": total_unrealized,
            "spy_close": latest.spy_close,
            "as_of": _iso_utc(latest.at),
            "position_count": len(positions),
            "sector_breakdown": [
                {"sector": k, "market_value": round(v, 2),
                 "weight": round(v / latest.equity, 4) if latest.equity else 0}
                for k, v in sorted(sectors.items(), key=lambda kv: -kv[1])
            ],
        }


@app.get("/portfolio/history")
def portfolio_history(days: int = Query(30, ge=1, le=365)) -> list[dict]:
    """Equity history + SPY close for P&L vs SPY."""
    since = datetime.now(timezone.utc) - timedelta(days=days)
    with SessionLocal() as s:
        rows = s.scalars(
            select(PortfolioSnapshot)
            .where(PortfolioSnapshot.at >= since)
            .order_by(PortfolioSnapshot.at)
        ).all()
    return [
        {"at": _iso_utc(r.at), "equity": r.equity, "spy_close": r.spy_close}
        for r in rows
    ]


@app.get("/positions")
def positions() -> list[dict]:
    with SessionLocal() as s:
        rows = s.scalars(select(Position).order_by(desc(Position.market_value))).all()
        from bot.config import SECTOR_MAP, TRAILING_STOP_PCT
        out = []
        for p in rows:
            stop_price = p.peak_price * (1 - TRAILING_STOP_PCT) if p.peak_price else 0
            out.append({
                "ticker": p.ticker,
                "sector": SECTOR_MAP.get(p.ticker, "Other"),
                "qty": p.qty,
                "avg_cost": p.avg_cost,
                "market_price": p.market_price,
                "market_value": p.market_value,
                "unrealized_pnl": p.unrealized_pnl,
                "unrealized_pct": ((p.market_price / p.avg_cost) - 1) if p.avg_cost else 0,
                "peak_price": p.peak_price,
                "stop_price": stop_price,
                "distance_to_stop_pct": ((p.market_price - stop_price) / p.market_price) if p.market_price else 0,
                "opened_at": _iso_utc(p.opened_at),
                "updated_at": _iso_utc(p.updated_at),
            })
    return out


@app.get("/trades")
def trades(limit: int = Query(100, ge=1, le=500)) -> list[dict]:
    with SessionLocal() as s:
        rows = s.scalars(
            select(Trade).order_by(desc(Trade.submitted_at)).limit(limit)
        ).all()
        out = []
        for t in rows:
            decision = next((d for d in t.decisions), None)
            out.append({
                "id": t.id,
                "ticker": t.ticker,
                "side": t.side,
                "qty": t.qty,
                "price": t.price,
                "notional": t.notional,
                "status": t.status,
                "dry_run": t.dry_run,
                "submitted_at": _iso_utc(t.submitted_at),
                "filled_at": _iso_utc(t.filled_at),
                "reason": decision.reason if decision else None,
                "composite_score": decision.composite_score if decision else None,
                "score_breakdown": decision.score_breakdown if decision else None,
                "action": decision.action if decision else None,
            })
    return out


@app.get("/decisions")
def decisions(limit: int = 100, action: Optional[str] = None) -> list[dict]:
    with SessionLocal() as s:
        q = select(Decision).order_by(desc(Decision.at)).limit(limit)
        if action:
            q = select(Decision).where(Decision.action == action).order_by(desc(Decision.at)).limit(limit)
        rows = s.scalars(q).all()
    return [
        {
            "id": d.id,
            "at": _iso_utc(d.at),
            "ticker": d.ticker,
            "action": d.action,
            "composite_score": d.composite_score,
            "score_breakdown": d.score_breakdown,
            "reason": d.reason,
            "dry_run": d.dry_run,
            "trade_id": d.trade_id,
        }
        for d in rows
    ]


@app.get("/news")
def news(limit: int = Query(50, ge=1, le=200), ticker: Optional[str] = None) -> list[dict]:
    with SessionLocal() as s:
        q = select(NewsItem).order_by(desc(NewsItem.published_at)).limit(limit)
        rows = s.scalars(q).all()
        if ticker:
            rows = [r for r in rows if r.tickers and ticker in r.tickers]
    return [
        {
            "id": r.id,
            "title": r.title,
            "url": r.url,
            "summary": r.summary,
            "source": r.source,
            "published_at": _iso_utc(r.published_at),
            "tickers": r.tickers or [],
            "vader_score": r.vader_score,
            "sentiment_label": _label_for(r.vader_score),
            "finbert_label": r.finbert_label,
        }
        for r in rows
    ]


def _label_for(v: Optional[float]) -> str:
    if v is None:
        return "neutral"
    if v >= 0.2:
        return "positive"
    if v <= -0.2:
        return "negative"
    return "neutral"


@app.get("/regime/today")
def regime_today() -> dict:
    """Latest macro snapshot. Returns 404 if the regime job hasn't run yet."""
    with SessionLocal() as s:
        row = s.scalars(
            select(MarketRegime).order_by(desc(MarketRegime.as_of)).limit(1)
        ).first()
    if not row:
        raise HTTPException(404, "no regime snapshot yet")
    return {
        "as_of": _iso_utc(row.as_of),
        "vix": row.vix,
        "vix_5d_change": row.vix_5d_change,
        "spy_trend": row.spy_trend,
        "t10y2y": row.t10y2y,
        "breadth_pct": row.breadth_pct,
        "regime_label": row.regime_label,
    }


@app.get("/earnings/upcoming")
def earnings_upcoming(days: int = Query(14, ge=1, le=60)) -> list[dict]:
    """Next N days of earnings reports for universe tickers, plus the
    last-4-quarter surprise % per ticker."""
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
                "report_date": _iso_utc(r.report_date),
                "time_of_day": r.time_of_day,
                "eps_estimate": r.eps_estimate,
                "last_4_surprise_pcts": [h.surprise_pct for h in history],
            })
    return out


@app.get("/signals/by-politician")
def signals_by_politician(
    name: Optional[str] = None,
    days: int = Query(60, ge=1, le=365),
    limit: int = Query(50, ge=1, le=500),
) -> list[dict]:
    """Politician trades filtered by partial name match (case-insensitive)
    and optional date window. Returns chamber, weight, source URL via meta."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    needle = (name or "").strip().lower()
    with SessionLocal() as s:
        rows = s.scalars(
            select(Signal)
            .where(Signal.kind == "politician")
            .where(Signal.as_of >= cutoff)
            .order_by(desc(Signal.as_of))
            .limit(limit * 5)  # over-fetch so the post-filter still hits limit
        ).all()
    out = []
    for r in rows:
        meta = r.meta or {}
        pol = (meta.get("politician") or r.source or "").strip()
        if needle and needle not in pol.lower():
            continue
        out.append({
            "id": r.id,
            "ticker": r.ticker,
            "politician": pol,
            "chamber": meta.get("chamber"),
            "direction": r.direction,
            "amount": r.amount,
            "as_of": _iso_utc(r.as_of),
            "source_url": meta.get("source_url"),
        })
        if len(out) >= limit:
            break
    return out


@app.get("/signals")
def signals(limit: int = Query(100, ge=1, le=500), kind: Optional[str] = None) -> list[dict]:
    with SessionLocal() as s:
        q = select(Signal).order_by(desc(Signal.as_of)).limit(limit)
        if kind:
            q = select(Signal).where(Signal.kind == kind).order_by(desc(Signal.as_of)).limit(limit)
        rows = s.scalars(q).all()
    return [
        {
            "id": sig.id,
            "ticker": sig.ticker,
            "kind": sig.kind,
            "source": sig.source,
            "direction": sig.direction,
            "amount": sig.amount,
            "as_of": _iso_utc(sig.as_of),
            "meta": sig.meta or {},
        }
        for sig in rows
    ]


@app.get("/tape")
def tape(limit: int = 16) -> list[dict]:
    """Scrolling-ticker feed: top universe names with current mid + 20-day return."""
    from bot.config import FULL_UNIVERSE
    featured = [
        "SPY", "QQQ", "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL",
        "META", "AMD", "JPM", "BAC", "XOM", "UNH", "AGG", "TLT",
    ][:limit]
    out = []
    with SessionLocal() as s:
        for t in featured:
            closes = s.execute(
                select(PriceHistory.close)
                .where(PriceHistory.ticker == t)
                .order_by(desc(PriceHistory.trade_date))
                .limit(21)
            ).all()
            if not closes:
                continue
            last = closes[0][0]
            baseline = closes[-1][0] if len(closes) > 1 else last
            chg = (last / baseline) - 1 if baseline else 0
            out.append({"s": t, "p": last, "c": chg})
    # If no price history yet, return an empty list rather than fabricate data.
    return out


@app.get("/bot/status")
def bot_status() -> dict:
    """Recap for the BotRibbon. Reports last strategy tick + last decision."""
    with SessionLocal() as s:
        last_tick = s.scalars(
            select(JobRun)
            .where(JobRun.job_name == "strategy_tick")
            .order_by(desc(JobRun.started_at))
            .limit(1)
        ).first()
        last_decision = s.scalars(
            select(Decision).order_by(desc(Decision.at)).limit(1)
        ).first()
    return {
        "last_tick_at": _iso_utc(last_tick.started_at) if last_tick else None,
        "last_tick_status": last_tick.status if last_tick else None,
        "interval_seconds": 300,
        "last_decision": (
            {
                "at": _iso_utc(last_decision.at),
                "ticker": last_decision.ticker,
                "action": last_decision.action,
                "composite_score": last_decision.composite_score,
                "reason": last_decision.reason,
            }
            if last_decision
            else None
        ),
    }


@app.get("/jobs")
def jobs(limit: int = 30) -> list[dict]:
    with SessionLocal() as s:
        rows = s.scalars(
            select(JobRun).order_by(desc(JobRun.started_at)).limit(limit)
        ).all()
    return [
        {
            "id": j.id,
            "job_name": j.job_name,
            "started_at": _iso_utc(j.started_at),
            "finished_at": _iso_utc(j.finished_at),
            "status": j.status,
            "message": j.message,
        }
        for j in rows
    ]


# ---------------------------------------------------------------------------
# LLM-era endpoints (Phase 4)
# ---------------------------------------------------------------------------


@app.get("/llm/runs")
def llm_runs(limit: int = Query(20, ge=1, le=200)) -> list[dict]:
    """Recent LLMRun rows for the dashboard's routine-history panel.

    Each row includes token breakdown and tool_trace so the UI can render a
    "what did the model do" bullet list without replaying the conversation.
    """
    with SessionLocal() as s:
        rows = s.scalars(
            select(LLMRun).order_by(desc(LLMRun.started_at)).limit(limit)
        ).all()
    return [
        {
            "id": r.id,
            "routine": r.routine,
            "started_at": _iso_utc(r.started_at),
            "finished_at": _iso_utc(r.finished_at),
            "status": r.status,
            "model": r.model,
            "input_tokens": r.input_tokens,
            "output_tokens": r.output_tokens,
            "cache_read_tokens": r.cache_read_tokens,
            "cache_write_tokens": r.cache_write_tokens,
            "usd_cost": round(r.usd_cost, 4),
            "web_search_calls": r.web_search_calls,
            "tool_calls": r.tool_calls,
            "tool_trace": r.tool_trace or [],
            "summary": r.summary or "",
            "error": r.error,
        }
        for r in rows
    ]


@app.get("/llm/cost")
def llm_cost() -> dict:
    """Today (UTC) + this week spend + budget so the UI can render a bar."""
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    # "week" = rolling 7-day window; simpler than ISO-week math and enough
    # for the dashboard card.
    week_start = today_start - timedelta(days=7)
    with SessionLocal() as s:
        today = s.scalars(
            select(LLMRun.usd_cost).where(LLMRun.started_at >= today_start)
        ).all()
        week = s.scalars(
            select(LLMRun.usd_cost).where(LLMRun.started_at >= week_start)
        ).all()
        cache_read = s.scalars(
            select(LLMRun.cache_read_tokens).where(LLMRun.started_at >= today_start)
        ).all()
        cache_write = s.scalars(
            select(LLMRun.cache_write_tokens).where(LLMRun.started_at >= today_start)
        ).all()
    today_usd = float(sum(today))
    week_usd = float(sum(week))
    budget = settings.llm_daily_usd_budget
    cr_total = int(sum(cache_read))
    cw_total = int(sum(cache_write))
    cache_hit_ratio = (
        cr_total / (cr_total + cw_total) if (cr_total + cw_total) else None
    )
    return {
        "today_usd": round(today_usd, 4),
        "week_usd": round(week_usd, 4),
        "budget_usd": float(budget),
        "remaining_usd": round(max(0.0, budget - today_usd), 4),
        "cache_hit_ratio": (
            round(cache_hit_ratio, 3) if cache_hit_ratio is not None else None
        ),
    }


_MEMORY_NAMES = ("strategy", "portfolio", "trade_log", "research_log")


@app.get("/memory/{name}")
def memory_file(name: str) -> dict:
    """Return a memory file's raw markdown + metadata. Whitelisted names
    only — anything else is a 404."""
    if name not in _MEMORY_NAMES:
        raise HTTPException(404, f"memory file {name!r} not found")
    return {
        "name": name,
        "content": llm_memory.read(name),  # type: ignore[arg-type]
        **llm_memory.stat(name),            # type: ignore[arg-type]
    }


# Canonical routine schedule — mirrors what ``bot/main.py`` will register at
# Phase 5 cutover. Exposed via the API so the dashboard can countdown to the
# next firing without needing to peek at APScheduler internals over RPC.
# Times are in America/New_York; cron-style tuple (day_of_week, hour, minute).
_ROUTINE_SCHEDULE: list[dict] = [
    {"name": "premarket",     "day_of_week": "mon-fri", "hour": 7,  "minute": 0},
    {"name": "execute",       "day_of_week": "mon-fri", "hour": 9,  "minute": 30},
    {"name": "midday",        "day_of_week": "mon-fri", "hour": 13, "minute": 0},
    {"name": "close",         "day_of_week": "mon-fri", "hour": 16, "minute": 0},
    {"name": "weekly_review", "day_of_week": "fri",     "hour": 17, "minute": 0},
]


def _next_firing_utc(entry: dict) -> datetime:
    """Compute the next UTC datetime that matches the given cron tuple.

    Uses APScheduler's ``CronTrigger`` with ``timezone="America/New_York"``
    so DST is automatic; returns the tz-aware UTC equivalent.
    """
    from apscheduler.triggers.cron import CronTrigger
    trig = CronTrigger(
        day_of_week=entry["day_of_week"],
        hour=entry["hour"],
        minute=entry["minute"],
        timezone="America/New_York",
    )
    now = datetime.now(timezone.utc)
    fire = trig.get_next_fire_time(None, now)  # previous_fire_time=None
    return fire.astimezone(timezone.utc)


@app.get("/routines/next")
def routines_next() -> dict:
    """Return the next-firing time for each routine + which one is next up.

    Dashboard renders the next-up countdown prominently and lists the other
    four in a smaller schedule strip.
    """
    now = datetime.now(timezone.utc)
    entries: list[dict] = []
    for entry in _ROUTINE_SCHEDULE:
        fire_utc = _next_firing_utc(entry)
        entries.append({
            "name": entry["name"],
            "day_of_week": entry["day_of_week"],
            "hour": entry["hour"],
            "minute": entry["minute"],
            "next_fire_utc": _iso_utc(fire_utc),
            "seconds_until": max(0, int((fire_utc - now).total_seconds())),
        })
    entries.sort(key=lambda e: e["seconds_until"])
    return {
        "now_utc": _iso_utc(now),
        "routines_enabled": settings.llm_routines_enabled,
        "next": entries[0],
        "all": entries,
    }
