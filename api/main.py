"""Read-only JSON API over the trading SQLite DB.

Exposes endpoints the Next.js dashboard consumes. CORS is scoped to localhost
only — this service is not intended for internet exposure.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
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
from bot.manual_trade import ManualTradeError, manual_trade

# Lazy import — `AlpacaClient.__init__` constructs an SDK client on each
# instance so we keep one alive at module scope for the API's live calls.
from bot.alpaca_client import AlpacaClient

_alpaca_singleton: AlpacaClient | None = None


def _alpaca() -> AlpacaClient:
    """One-shot Alpaca client per FastAPI worker. Cheap to construct but
    we still cache it so we don't pay TCP/TLS handshake cost on every
    `/positions` poll (10s cadence)."""
    global _alpaca_singleton
    if _alpaca_singleton is None:
        _alpaca_singleton = AlpacaClient()
    return _alpaca_singleton


_TRADE_LOG_LINE = re.compile(
    # Match BUY or MANUAL BUY lines from memory/trade_log.md and extract
    # the ticker + thesis text. Examples (from real history):
    #   - 2026-04-28T13:30:33 | BUY  RTX    qty=  14.0000 ... thesis: text
    #   - 2026-05-01T22:28:32 | MANUAL BUY  AAPL   qty= ... note: text
    r"^- (?P<ts>\S+)\s+\|\s+(?:MANUAL\s+)?(?P<side>BUY|SELL)\s+(?P<ticker>\S+).*?(?:thesis|reason|note):\s*(?P<reason>.+)$",
    re.MULTILINE,
)


def _trade_log_thesis_index() -> dict[str, dict]:
    """Parse memory/trade_log.md into {ticker → {ts, side, reason}} keyed by
    the most recent BUY for each ticker. Used as a fallback when the local
    Decision table doesn't have a row (positions opened before the
    place_buy handler started writing Decisions). Read on every call —
    the file is small (<64KB cap) and changes infrequently.
    """
    try:
        text = llm_memory.read("trade_log")
    except Exception:
        return {}
    out: dict[str, dict] = {}
    for m in _TRADE_LOG_LINE.finditer(text):
        side = m.group("side")
        if side != "BUY":
            continue
        ticker = m.group("ticker").upper()
        # Latest wins — entries are append-only, last match per ticker is freshest.
        out[ticker] = {
            "ts": m.group("ts"),
            "reason": m.group("reason").strip(),
            "side": side,
        }
    return out

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
    # `POST` is required for the dashboard's manual trade panel
    # (`POST /trade/manual`). Everything else is read-only `GET`.
    allow_methods=["GET", "POST", "OPTIONS"],
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
    """Live portfolio snapshot — calls Alpaca directly so the dashboard
    always shows truth, with the local DB as a fallback if Alpaca is
    unreachable. Pre-Apr-30 this read from ``PortfolioSnapshot``, but the
    quant-tick retirement orphaned the only writer for that table; positions
    drifted 7+ days out of date. Now we hit Alpaca live and only fall back
    to the snapshot if the network call fails.
    """
    from bot.config import SECTOR_MAP

    try:
        acct = _alpaca().account()
        live_positions = _alpaca().positions()
        spy_close: float | None = None
        try:
            spy_close = _alpaca().latest_quotes(["SPY"]).get("SPY")
        except Exception:
            pass

        sectors: dict[str, float] = {}
        for p in live_positions:
            sec = SECTOR_MAP.get(p.symbol, "Other")
            sectors[sec] = sectors.get(sec, 0.0) + p.market_value
        total_unrealized = sum(p.unrealized_pl for p in live_positions)
        return {
            "equity": acct.equity,
            "cash": acct.cash,
            "buying_power": acct.buying_power,
            "invested": acct.equity - acct.cash,
            "unrealized_pnl": total_unrealized,
            "spy_close": spy_close,
            "as_of": _iso_utc(datetime.now(timezone.utc)),
            "source": "alpaca_live",
            "position_count": len(live_positions),
            "sector_breakdown": [
                {
                    "sector": k,
                    "market_value": round(v, 2),
                    "weight": round(v / acct.equity, 4) if acct.equity else 0,
                }
                for k, v in sorted(sectors.items(), key=lambda kv: -kv[1])
            ],
        }
    except Exception as exc:
        # Network blip / Alpaca downtime — fall back to the most recent
        # local snapshot so the dashboard doesn't go blank.
        from loguru import logger as _logger
        _logger.warning("portfolio_summary live-fetch failed, falling back to DB: {}", exc)
        with SessionLocal() as s:
            latest = s.scalars(
                select(PortfolioSnapshot).order_by(desc(PortfolioSnapshot.at)).limit(1)
            ).first()
            if not latest:
                raise HTTPException(503, f"Alpaca unreachable and no snapshot: {exc}")
            positions = s.scalars(select(Position)).all()
            sectors: dict[str, float] = {}
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
                "source": "db_fallback",
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
    """Live Alpaca positions enriched with the bot's reasoning from the
    local Decision table. Each row carries the LATEST buy thesis for that
    ticker so the dashboard can show "why do we own this?" inline.
    Falls back to the local Position table only if Alpaca is unreachable.
    """
    from bot.config import SECTOR_MAP, TRAILING_STOP_PCT

    try:
        live = _alpaca().positions()
        # Pull every Decision for the symbols we hold so we can attach
        # the latest BUY reason. Cheaper than per-symbol queries — one
        # IN-list select.
        held_symbols = [p.symbol for p in live]
        latest_buys: dict[str, Decision] = {}
        latest_trades: dict[str, Trade] = {}
        # Fallback theses parsed from memory/trade_log.md for positions
        # opened before the place_buy handler started writing Decisions.
        log_theses = _trade_log_thesis_index()
        if held_symbols:
            with SessionLocal() as s:
                rows = s.scalars(
                    select(Decision)
                    .where(Decision.ticker.in_(held_symbols))
                    .where(Decision.action.in_(["buy", "manual_buy"]))
                    .order_by(desc(Decision.at))
                ).all()
                for d in rows:
                    if d.ticker not in latest_buys:
                        latest_buys[d.ticker] = d
                trade_rows = s.scalars(
                    select(Trade)
                    .where(Trade.ticker.in_(held_symbols))
                    .where(Trade.side == "buy")
                    .order_by(desc(Trade.submitted_at))
                ).all()
                for t in trade_rows:
                    if t.ticker not in latest_trades:
                        latest_trades[t.ticker] = t
            # Local-DB Position rows for stop info (peak_price, stop_order_id).
            with SessionLocal() as s:
                local_pos = {
                    p.ticker: p
                    for p in s.scalars(select(Position)).all()
                }
        else:
            local_pos = {}

        out = []
        for p in sorted(live, key=lambda x: -x.market_value):
            local = local_pos.get(p.symbol)
            peak = (local.peak_price if local else None) or p.market_price
            stop_price = peak * (1 - TRAILING_STOP_PCT) if peak else 0
            d = latest_buys.get(p.symbol)
            t = latest_trades.get(p.symbol)
            # Resolve thesis: prefer the structured Decision row; fall back
            # to a parsed line from trade_log.md for legacy positions whose
            # buy pre-dates the Decision-writing place_buy.
            thesis: str | None = d.reason if d else None
            decision_action: str | None = d.action if d else None
            decision_at: str | None = _iso_utc(d.at) if d else None
            if thesis is None:
                log_entry = log_theses.get(p.symbol)
                if log_entry:
                    thesis = log_entry["reason"]
                    decision_action = "buy"
                    decision_at = log_entry["ts"]  # ISO string already
            out.append({
                "ticker": p.symbol,
                "sector": SECTOR_MAP.get(p.symbol, "Other"),
                "qty": p.qty,
                "avg_cost": p.avg_entry_price,
                "market_price": p.market_price,
                "market_value": p.market_value,
                "unrealized_pnl": p.unrealized_pl,
                "unrealized_pct": ((p.market_price / p.avg_entry_price) - 1) if p.avg_entry_price else 0,
                "peak_price": peak,
                "stop_price": stop_price,
                "distance_to_stop_pct": ((p.market_price - stop_price) / p.market_price) if p.market_price else 0,
                "opened_at": _iso_utc(t.submitted_at) if t else None,
                "updated_at": _iso_utc(datetime.now(timezone.utc)),
                # Trading rationale + provenance
                "thesis": thesis,
                "decision_at": decision_at,
                "decision_action": decision_action,
                "stop_order_id": local.stop_order_id if local else None,
            })
        return out
    except Exception as exc:
        from loguru import logger as _logger
        _logger.warning("/positions live-fetch failed, falling back to DB: {}", exc)
        # Original DB-only path (keeps the dashboard alive in degraded mode).
        with SessionLocal() as s:
            rows = s.scalars(select(Position).order_by(desc(Position.market_value))).all()
            out = []
            for p in rows:
                stop_price = p.peak_price * (1 - TRAILING_STOP_PCT) if p.peak_price else 0
                d = s.scalars(
                    select(Decision)
                    .where(Decision.ticker == p.ticker)
                    .where(Decision.action.in_(["buy", "manual_buy"]))
                    .order_by(desc(Decision.at))
                    .limit(1)
                ).first()
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
                    "thesis": d.reason if d else None,
                    "decision_at": _iso_utc(d.at) if d else None,
                    "decision_action": d.action if d else None,
                    "stop_order_id": p.stop_order_id,
                })
        return out


@app.get("/trades")
def trades(limit: int = Query(100, ge=1, le=500)) -> list[dict]:
    """Recent trades, merging:
      1. Local ``Trade`` rows (LLM/manual entries — carry thesis + composite).
      2. Alpaca's filled closed orders from the last 30 days that *aren't*
         already in the local table — this is how trailing-stop SELL fills
         and any other auxiliary orders Alpaca executed on our behalf show
         up on the dashboard. They carry no thesis (the LLM didn't place
         them) but they're tagged ``source: "alpaca_fill"`` and a synthetic
         ``reason`` line that explains the order type.
    """
    with SessionLocal() as s:
        rows = s.scalars(
            select(Trade).order_by(desc(Trade.submitted_at)).limit(limit)
        ).all()
        local: list[dict] = []
        local_ids: set[str] = set()
        for t in rows:
            decision = next((d for d in t.decisions), None)
            if t.alpaca_order_id:
                local_ids.add(t.alpaca_order_id)
            local.append({
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
                "source": "local",
            })

    # Merge in Alpaca's recent closed orders (best effort — degrade to local
    # only if Alpaca is unreachable). Negative IDs are synthetic so the React
    # `key` prop stays unique alongside the local rows.
    alpaca_rows: list[dict] = []
    try:
        closed = _alpaca().closed_orders(days=30, limit=200)
    except Exception:
        closed = []
    for i, o in enumerate(closed):
        if o.get("id") and o["id"] in local_ids:
            continue  # already represented as a local Trade row
        otype = (o.get("type") or "").lower()
        side = (o.get("side") or "").lower()
        # Synthesize a human-readable reason so the user knows *why* this
        # order existed. Trailing-stop fills are the main thing the user
        # asked to "be seen" in the dashboard.
        if otype == "trailing_stop":
            reason = "Alpaca trailing-stop fill (10% from peak — auto risk control)"
        elif otype == "stop":
            reason = "Alpaca hard stop fill"
        elif otype == "limit":
            reason = "Alpaca limit fill"
        elif side == "sell":
            reason = "Alpaca SELL (filled outside the LLM bot)"
        else:
            reason = "Alpaca fill (placed outside the LLM bot)"
        alpaca_rows.append({
            "id": -1000 - i,  # synthetic negative id, won't collide
            "ticker": o.get("symbol") or "",
            "side": side or "buy",
            "qty": o.get("qty") or 0,
            "price": o.get("price") or 0,
            "notional": o.get("notional") or 0,
            "status": o.get("status") or "filled",
            "dry_run": False,
            "submitted_at": o.get("submitted_at"),
            "filled_at": o.get("filled_at"),
            "reason": reason,
            "composite_score": None,
            "score_breakdown": None,
            "action": None,
            "source": "alpaca_fill",
            "order_type": otype,
        })

    merged = local + alpaca_rows
    # Sort by submitted_at desc; treat None as far past so nothing crashes.
    merged.sort(
        key=lambda r: r.get("submitted_at") or "",
        reverse=True,
    )
    return merged[:limit]


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
    """Recap for the BotRibbon. Surfaces the latest meaningful bot activity
    so the dashboard's "Running" indicator reflects what the bot is *actually*
    doing today, not the retired quant tick from days ago.

    Priority order for `last_tick_at`:
      1. Most recent successful LLM run (premarket / execute / midday / etc.)
      2. Most recent JobRun of any kind (research_tick, regime, earnings, ...)
      3. Most recent legacy strategy_tick (preserved for back-compat)
    """
    with SessionLocal() as s:
        last_llm = s.scalars(
            select(LLMRun).order_by(desc(LLMRun.started_at)).limit(1)
        ).first()
        last_job = s.scalars(
            select(JobRun).order_by(desc(JobRun.started_at)).limit(1)
        ).first()
        last_decision = s.scalars(
            select(Decision).order_by(desc(Decision.at)).limit(1)
        ).first()

    # Pick the most recent activity across LLM runs and any job_run.
    candidates: list[tuple[datetime, str, str]] = []
    if last_llm and last_llm.started_at:
        candidates.append((
            last_llm.started_at,
            last_llm.status,
            f"llm_{last_llm.routine}",
        ))
    if last_job and last_job.started_at:
        candidates.append((
            last_job.started_at,
            last_job.status,
            last_job.job_name,
        ))
    candidates.sort(key=lambda c: c[0], reverse=True)

    if candidates:
        ts, status, kind = candidates[0]
        last_tick_at = _iso_utc(ts)
        last_tick_status = status
        last_tick_kind = kind
    else:
        last_tick_at = None
        last_tick_status = None
        last_tick_kind = None

    return {
        "last_tick_at": last_tick_at,
        "last_tick_status": last_tick_status,
        "last_tick_kind": last_tick_kind,
        "interval_seconds": 900,  # research_tick cadence; LLM routines anchored to ET clock
        "last_llm_run": (
            {
                "id": last_llm.id,
                "routine": last_llm.routine,
                "started_at": _iso_utc(last_llm.started_at),
                "status": last_llm.status,
                "tool_calls": last_llm.tool_calls,
                "usd_cost": last_llm.usd_cost,
            }
            if last_llm
            else None
        ),
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


# ---------------------------------------------------------------------------
# Manual trade endpoint — the dashboard's user-driven escape hatch.
# ---------------------------------------------------------------------------


class ManualTradeRequest(BaseModel):
    """Body for ``POST /trade/manual``.

    Provide exactly one of ``qty`` or ``notional_usd``. The endpoint computes
    the missing one from a live mid quote.
    """

    symbol: str = Field(..., min_length=1, max_length=16)
    side: str = Field(..., pattern="^(buy|sell)$")
    qty: Optional[float] = Field(None, gt=0)
    notional_usd: Optional[float] = Field(None, gt=0)
    note: str = Field("", max_length=200)
    # Paper Alpaca will queue an order placed after-hours; require an
    # explicit opt-in so a misclick at 2 AM doesn't get filled at the open.
    allow_after_hours: bool = False


@app.post("/trade/manual")
def trade_manual(req: ManualTradeRequest) -> dict:
    """Execute a manual buy or sell from the dashboard.

    Hits Alpaca via :func:`bot.manual_trade.manual_trade`, which:
      * pre-cancels any opposite-side open orders on the symbol,
      * honors ``DRY_RUN`` (returns a ``DRY-MAN-…`` order id, no Alpaca call),
      * persists ``Trade`` + ``Decision`` rows tagged ``manual_{side}``,
      * appends a ``MANUAL`` line to ``memory/trade_log.md``.

    Returns the placed trade so the UI can flash a confirmation immediately
    without waiting for the next ``/trades`` poll.
    """
    try:
        return manual_trade(
            symbol=req.symbol,
            side=req.side,
            qty=req.qty,
            notional_usd=req.notional_usd,
            note=req.note,
            allow_after_hours=req.allow_after_hours,
        )
    except ManualTradeError as exc:
        # 400 — user can fix their input and resubmit.
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # pragma: no cover — surface for the dashboard
        # 500 — log + surface a short message; full traceback goes to api.log.
        from loguru import logger as _logger
        _logger.exception("manual_trade failed: {}", exc)
        raise HTTPException(status_code=500, detail=f"internal error: {exc}")
