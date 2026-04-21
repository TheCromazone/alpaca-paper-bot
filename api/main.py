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

from bot.db import (
    Decision,
    JobRun,
    NewsItem,
    PortfolioSnapshot,
    Position,
    PriceHistory,
    SessionLocal,
    Signal,
    Trade,
    init_db,
)

app = FastAPI(title="Alpaca Trading Bot API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
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
