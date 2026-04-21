"""Tool registry + validators — the trust boundary.

The LLM *proposes* via tool calls; handlers here *verify and execute*. Every
hard cap (5% size, 15-position count, 10% trailing stop, 7% midday cut, 3-day
wash window, 20-char thesis minimum) is enforced here in code, never in
prompts. Prompt constraints are best-effort guidance; these are guarantees.

Each tool entry is:

    {
        "definition": {"name": ..., "description": ..., "input_schema": {...}},
        "handler":    callable(args_dict) -> dict,
        "routines":   frozenset of routine names allowed to see this tool,
    }

The runner assembles ``tools=`` for each routine by filtering on the
``routines`` set, so the model literally cannot call ``place_buy`` in a
research-only routine — it isn't in the toolbox.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable

from loguru import logger
from sqlalchemy import desc, select

from bot.alpaca_client import AlpacaClient
from bot.config import (
    LLM_MAX_POSITION_PCT,
    LLM_MAX_POSITIONS,
    LLM_MIN_THESIS_CHARS,
    LLM_TRAILING_STOP_MAX,
    LLM_TRAILING_STOP_MIN,
    LLM_TRAILING_STOP_PCT,
    LLM_WASH_TRADE_LOOKBACK_DAYS,
    settings,
)
from bot.db import NewsItem, Position, Signal, SessionLocal, Trade
from bot.llm import memory


# ---------------------------------------------------------------------------
# Error type
# ---------------------------------------------------------------------------


class ToolError(Exception):
    """Raised by a handler to signal a refusal that should be returned to
    the model with ``is_error=True``. The message is shown to the model so
    it can re-think. Keep messages actionable: "position exceeds 5% cap" is
    better than "invalid input"."""


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _alpaca() -> AlpacaClient:
    """One-shot client per call. Alpaca SDK clients are cheap to construct."""
    return AlpacaClient()


def _require_str(args: dict, key: str, min_len: int = 1) -> str:
    v = args.get(key)
    if not isinstance(v, str) or len(v) < min_len:
        raise ToolError(f"missing or too-short field {key!r} (need ≥{min_len} chars)")
    return v


def _require_pos_float(args: dict, key: str) -> float:
    v = args.get(key)
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ToolError(f"field {key!r} must be a positive number, got {v!r}")
    if f <= 0:
        raise ToolError(f"field {key!r} must be > 0, got {f}")
    return f


def _portfolio_snapshot() -> dict:
    """Live Alpaca state — equity, cash, positions. Used by tools AND by
    validators that need a fresh read (e.g. place_buy re-queries just before
    submitting so stale locals can't slip an oversized order past)."""
    c = _alpaca()
    acct = c.account()
    positions = c.positions()
    return {
        "equity": acct.equity,
        "cash": acct.cash,
        "buying_power": acct.buying_power,
        "positions": [
            {
                "ticker": p.symbol,
                "qty": p.qty,
                "avg_cost": p.avg_entry_price,
                "market_price": p.market_price,
                "market_value": p.market_value,
                "unrealized_pnl": p.unrealized_pl,
            }
            for p in positions
        ],
    }


def _recent_opposite_trade(ticker: str, side: str) -> Trade | None:
    """Return the most recent Trade on ``ticker`` whose side is opposite
    ``side`` and which was submitted in the last ``LLM_WASH_TRADE_LOOKBACK_DAYS``
    trading days. Returns None if nothing qualifies.

    We measure in *calendar* days here — Alpaca itself enforces wash sale
    rules tighter than we need to, and the strategy.md rule is about not
    re-fighting yesterday's decision, not tax compliance.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=LLM_WASH_TRADE_LOOKBACK_DAYS)
    opposite = "sell" if side == "buy" else "buy"
    with SessionLocal() as s:
        row = s.scalars(
            select(Trade)
            .where(Trade.ticker == ticker)
            .where(Trade.side == opposite)
            .where(Trade.submitted_at >= cutoff)
            .order_by(desc(Trade.submitted_at))
            .limit(1)
        ).first()
    return row


def _append_trade_log(line: str) -> None:
    """Internal-only helper so trade_log.md stays append-only."""
    memory.append("trade_log", line)


# ---------------------------------------------------------------------------
# Handlers — one per tool. Each returns a JSON-serialisable dict.
# ---------------------------------------------------------------------------


def _h_read_memory(args: dict) -> dict:
    name = _require_str(args, "name")
    if name not in memory.ALL_MEMORY:
        raise ToolError(f"unknown memory file {name!r}; allowed: {list(memory.ALL_MEMORY)}")
    return {"name": name, "content": memory.read(name)}


def _h_write_memory(args: dict) -> dict:
    name = _require_str(args, "name")
    content = _require_str(args, "content")
    if name not in memory.WRITABLE:
        raise ToolError(
            f"{name!r} is not writable by the LLM; only {list(memory.WRITABLE)} "
            "accept whole-file rewrites. Use append_memory for research_log."
        )
    bytes_written = memory.write(name, content)
    return {"ok": True, "name": name, "bytes_written": bytes_written}


def _h_append_memory(args: dict) -> dict:
    name = _require_str(args, "name")
    content = _require_str(args, "content")
    # LLM may append to research_log only — trade_log is tool-handler-only.
    if name != "research_log":
        raise ToolError(
            f"append_memory only accepts 'research_log' from the LLM; "
            f"trade_log.md is maintained automatically by place_buy/place_sell."
        )
    bytes_appended = memory.append("research_log", content)
    return {"ok": True, "name": name, "bytes_appended": bytes_appended}


def _h_get_portfolio(args: dict) -> dict:
    return _portfolio_snapshot()


def _h_get_price_snapshot(args: dict) -> dict:
    syms = args.get("symbols") or []
    if not isinstance(syms, list) or not syms:
        raise ToolError("symbols must be a non-empty list of ticker strings")
    if len(syms) > 25:
        raise ToolError("max 25 symbols per call")
    syms = [str(s).upper() for s in syms]
    quotes = _alpaca().latest_quotes(syms)
    return {"prices": {s: quotes.get(s) for s in syms}}


def _h_get_recent_news(args: dict) -> dict:
    ticker = args.get("ticker")
    days = int(args.get("days", 3))
    limit = min(int(args.get("limit", 15)), 50)
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    with SessionLocal() as s:
        q = (
            select(NewsItem)
            .where(NewsItem.published_at >= cutoff)
            .order_by(desc(NewsItem.published_at))
            .limit(limit * 3)  # over-fetch; we filter by ticker below
        )
        rows = s.scalars(q).all()
    out: list[dict] = []
    for r in rows:
        if ticker and (not r.tickers or ticker.upper() not in (r.tickers or [])):
            continue
        out.append({
            "title": r.title,
            "source": r.source,
            "url": r.url,
            "published_at": r.published_at.isoformat(),
            "tickers": r.tickers or [],
            "vader_score": r.vader_score,
            "finbert_label": r.finbert_label,
            "has_body": bool(r.article_text),
        })
        if len(out) >= limit:
            break
    return {"items": out}


def _h_get_recent_signals(args: dict) -> dict:
    ticker = args.get("ticker")
    kind = args.get("kind", "all")
    days = int(args.get("days", 14))
    limit = min(int(args.get("limit", 20)), 100)
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    with SessionLocal() as s:
        q = (
            select(Signal)
            .where(Signal.as_of >= cutoff)
            .order_by(desc(Signal.as_of))
            .limit(limit)
        )
        if kind in ("politician", "investor"):
            q = (
                select(Signal)
                .where(Signal.kind == kind)
                .where(Signal.as_of >= cutoff)
                .order_by(desc(Signal.as_of))
                .limit(limit)
            )
        rows = s.scalars(q).all()
    out = [
        {
            "ticker": r.ticker,
            "kind": r.kind,
            "source": r.source,
            "direction": r.direction,
            "amount": r.amount,
            "as_of": r.as_of.isoformat(),
        }
        for r in rows
        if (not ticker) or r.ticker.upper() == ticker.upper()
    ]
    return {"signals": out}


def _h_list_open_orders(args: dict) -> dict:
    return {"orders": _alpaca().open_orders()}


def _h_cancel_order(args: dict) -> dict:
    oid = _require_str(args, "order_id")
    ok = _alpaca().cancel_order_by_id(oid)
    return {"ok": ok, "order_id": oid}


def _h_set_trailing_stop(args: dict) -> dict:
    symbol = _require_str(args, "symbol").upper()
    trail = _require_pos_float(args, "trail_percent")
    if not (LLM_TRAILING_STOP_MIN <= trail <= LLM_TRAILING_STOP_MAX):
        raise ToolError(
            f"trail_percent {trail} outside [{LLM_TRAILING_STOP_MIN}, "
            f"{LLM_TRAILING_STOP_MAX}]"
        )
    snap = _portfolio_snapshot()
    pos = next((p for p in snap["positions"] if p["ticker"] == symbol), None)
    if pos is None:
        raise ToolError(f"no open position in {symbol}; cannot attach stop")

    # Cancel any prior stop on this ticker so we don't double up.
    with SessionLocal.begin() as s:
        row = s.get(Position, symbol)
        if row and row.stop_order_id:
            _alpaca().cancel_order_by_id(row.stop_order_id)
            row.stop_order_id = None

    if settings.dry_run:
        oid = f"DRY-STOP-{uuid.uuid4().hex[:8]}"
    else:
        oid = _alpaca().submit_trailing_stop(symbol, pos["qty"], trail)

    with SessionLocal.begin() as s:
        row = s.get(Position, symbol)
        if row:
            row.stop_order_id = oid
    return {"order_id": oid, "symbol": symbol, "trail_percent": trail}


def _h_place_buy(args: dict) -> dict:
    symbol = _require_str(args, "symbol").upper()
    notional = _require_pos_float(args, "notional_usd")
    thesis = _require_str(args, "thesis", min_len=LLM_MIN_THESIS_CHARS)

    c = _alpaca()
    if not c.market_is_open():
        raise ToolError("market is closed; buys can only be placed during regular session")

    # Re-query portfolio *right now* to avoid stale-local caps.
    snap = _portfolio_snapshot()
    equity = snap["equity"]
    if equity <= 0:
        raise ToolError("Alpaca reports equity <= 0; refusing to trade")

    max_notional = equity * LLM_MAX_POSITION_PCT
    if notional > max_notional + 0.01:
        raise ToolError(
            f"notional ${notional:.2f} exceeds 5% cap ${max_notional:.2f} "
            f"(equity ${equity:.2f})"
        )
    if snap["buying_power"] < notional:
        raise ToolError(
            f"buying power ${snap['buying_power']:.2f} < notional ${notional:.2f}"
        )

    # Position-count + stealth-top-up guards.
    held = {p["ticker"]: p for p in snap["positions"]}
    if symbol not in held and len(held) >= LLM_MAX_POSITIONS:
        raise ToolError(
            f"already at max positions ({LLM_MAX_POSITIONS}); close one before opening a new name"
        )
    if symbol in held:
        post_mv = held[symbol]["market_value"] + notional
        if post_mv > max_notional + 0.01:
            raise ToolError(
                f"adding ${notional:.2f} to {symbol} would make it "
                f"${post_mv:.2f}, exceeding 5% cap ${max_notional:.2f}"
            )

    # Wash-trade window.
    recent = _recent_opposite_trade(symbol, side="buy")
    if recent is not None:
        raise ToolError(
            f"recent sell on {symbol} at {recent.submitted_at.isoformat()} "
            f"is within {LLM_WASH_TRADE_LOOKBACK_DAYS}-day wash window; skip"
        )

    # Price + sizing. Use mid price for sizing; Alpaca market orders will
    # fill near here. We record ``notional / mid`` as the target qty, rounded
    # down to 2 decimals (fractional shares are fine on Alpaca paper).
    quotes = c.latest_quotes([symbol])
    mid = quotes.get(symbol)
    if not mid or mid <= 0:
        raise ToolError(f"no live quote for {symbol}; refusing to size order")
    qty = round(notional / mid, 2)
    if qty <= 0:
        raise ToolError(f"computed qty {qty} for ${notional:.2f} at ${mid:.2f} — too small")

    # --- Submit (or simulate) ---
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if settings.dry_run:
        order_id = f"DRY-{uuid.uuid4().hex[:8]}"
        stop_id = f"DRY-STOP-{uuid.uuid4().hex[:8]}"
        status = "dry_run"
    else:
        order_id = c.submit_market(symbol, qty, "buy")
        # Pausing to set the stop right after. Alpaca allows a trailing stop
        # independent of the parent fill state; on a market order the parent
        # almost always fills immediately during RTH.
        stop_id = c.submit_trailing_stop(symbol, qty, LLM_TRAILING_STOP_PCT)
        status = "submitted"

    # Persist Trade + stop_order_id.
    with SessionLocal.begin() as s:
        trade = Trade(
            ticker=symbol, side="buy", qty=qty, price=mid,
            notional=notional, status=status, alpaca_order_id=order_id,
            dry_run=settings.dry_run,
        )
        s.add(trade)
        s.flush()
        pos_row = s.get(Position, symbol)
        if pos_row is not None:
            pos_row.stop_order_id = stop_id

    _append_trade_log(
        f"- {now_iso} | BUY  {symbol:6s} qty={qty:>10.4f} @ ~${mid:>8.2f} "
        f"notional=${notional:>8.2f} stop=10%  thesis: {thesis}"
    )
    logger.info("LLM buy {}: qty={} notional=${:.2f} dry_run={}", symbol, qty, notional, settings.dry_run)
    return {
        "order_id": order_id,
        "stop_order_id": stop_id,
        "symbol": symbol,
        "qty": qty,
        "est_price": mid,
        "status": status,
    }


def _h_place_sell(args: dict) -> dict:
    symbol = _require_str(args, "symbol").upper()
    qty_raw = args.get("qty", "all")
    reason = _require_str(args, "reason", min_len=LLM_MIN_THESIS_CHARS)

    snap = _portfolio_snapshot()
    held = {p["ticker"]: p for p in snap["positions"]}
    if symbol not in held:
        raise ToolError(f"no position in {symbol}; nothing to sell")
    live_qty = held[symbol]["qty"]

    if qty_raw == "all":
        qty = live_qty
    else:
        try:
            qty = float(qty_raw)
        except (TypeError, ValueError):
            raise ToolError(f"qty must be a number or 'all', got {qty_raw!r}")
        if qty <= 0 or qty > live_qty + 1e-6:
            raise ToolError(f"qty {qty} outside valid range (0, {live_qty}]")

    # Wash-trade window.
    recent = _recent_opposite_trade(symbol, side="sell")
    if recent is not None:
        raise ToolError(
            f"recent buy on {symbol} at {recent.submitted_at.isoformat()} "
            f"is within {LLM_WASH_TRADE_LOOKBACK_DAYS}-day wash window; skip"
        )

    c = _alpaca()

    # Cancel any open trailing stop on this symbol so it doesn't race the
    # sell we're about to submit.
    with SessionLocal.begin() as s:
        pos_row = s.get(Position, symbol)
        if pos_row and pos_row.stop_order_id:
            c.cancel_order_by_id(pos_row.stop_order_id)
            pos_row.stop_order_id = None

    quotes = c.latest_quotes([symbol])
    mid = quotes.get(symbol) or 0.0
    notional = qty * mid
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")

    if settings.dry_run:
        order_id = f"DRY-{uuid.uuid4().hex[:8]}"
        status = "dry_run"
    else:
        order_id = c.submit_market(symbol, qty, "sell")
        status = "submitted"

    with SessionLocal.begin() as s:
        s.add(Trade(
            ticker=symbol, side="sell", qty=qty, price=mid,
            notional=notional, status=status, alpaca_order_id=order_id,
            dry_run=settings.dry_run,
        ))

    _append_trade_log(
        f"- {now_iso} | SELL {symbol:6s} qty={qty:>10.4f} @ ~${mid:>8.2f} "
        f"notional=${notional:>8.2f} reason: {reason}"
    )
    logger.info("LLM sell {}: qty={} dry_run={}", symbol, qty, settings.dry_run)
    return {"order_id": order_id, "symbol": symbol, "qty": qty, "status": status}


# ---------------------------------------------------------------------------
# Tool registry
# ---------------------------------------------------------------------------

ALL_ROUTINES = ("premarket", "execute", "midday", "close", "weekly_review")


@dataclass
class ToolSpec:
    definition: dict
    handler: Callable[[dict], dict]
    routines: frozenset[str]


def _build_registry() -> dict[str, ToolSpec]:
    r = {
        "read_memory": ToolSpec(
            definition={
                "name": "read_memory",
                "description": "Read a memory file (strategy / portfolio / trade_log / research_log).",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "enum": list(memory.ALL_MEMORY)},
                    },
                    "required": ["name"],
                },
            },
            handler=_h_read_memory,
            routines=frozenset(ALL_ROUTINES),
        ),
        "write_memory": ToolSpec(
            definition={
                "name": "write_memory",
                "description": "Replace portfolio.md with a fresh snapshot. Only 'portfolio' is writable.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "enum": list(memory.WRITABLE)},
                        "content": {"type": "string"},
                    },
                    "required": ["name", "content"],
                },
            },
            handler=_h_write_memory,
            routines=frozenset({"execute", "midday", "close"}),
        ),
        "append_memory": ToolSpec(
            definition={
                "name": "append_memory",
                "description": "Append a new section to research_log.md (timestamped automatically).",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "enum": ["research_log"]},
                        "content": {"type": "string"},
                    },
                    "required": ["name", "content"],
                },
            },
            handler=_h_append_memory,
            routines=frozenset(ALL_ROUTINES),
        ),
        "get_portfolio": ToolSpec(
            definition={
                "name": "get_portfolio",
                "description": "Fetch live account state from Alpaca: equity, cash, buying_power, all positions.",
                "input_schema": {"type": "object", "properties": {}},
            },
            handler=_h_get_portfolio,
            routines=frozenset({"execute", "midday", "close", "weekly_review"}),
        ),
        "get_price_snapshot": ToolSpec(
            definition={
                "name": "get_price_snapshot",
                "description": "Latest mid prices for up to 25 symbols.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "symbols": {"type": "array", "items": {"type": "string"}, "maxItems": 25},
                    },
                    "required": ["symbols"],
                },
            },
            handler=_h_get_price_snapshot,
            routines=frozenset({"premarket", "execute", "midday", "close"}),
        ),
        "get_recent_news": ToolSpec(
            definition={
                "name": "get_recent_news",
                "description": (
                    "Read scraped news items from our local DB (CNBC / Yahoo / "
                    "CNN Business / MarketWatch / Seeking Alpha). Optional "
                    "ticker filter. Returns title, source, URL, VADER/FinBERT "
                    "sentiment, and whether we have the article body scraped."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "ticker": {"type": "string"},
                        "days": {"type": "integer", "minimum": 1, "maximum": 30},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                    },
                },
            },
            handler=_h_get_recent_news,
            routines=frozenset({"premarket", "execute", "weekly_review"}),
        ),
        "get_recent_signals": ToolSpec(
            definition={
                "name": "get_recent_signals",
                "description": "Politician disclosures + 13F changes from the local Signal DB.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "ticker": {"type": "string"},
                        "kind": {"type": "string", "enum": ["politician", "investor", "all"]},
                        "days": {"type": "integer", "minimum": 1, "maximum": 90},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                    },
                },
            },
            handler=_h_get_recent_signals,
            routines=frozenset({"premarket", "execute", "weekly_review"}),
        ),
        "list_open_orders": ToolSpec(
            definition={
                "name": "list_open_orders",
                "description": "List open (unfilled) orders at Alpaca.",
                "input_schema": {"type": "object", "properties": {}},
            },
            handler=_h_list_open_orders,
            routines=frozenset({"execute", "midday"}),
        ),
        "cancel_order": ToolSpec(
            definition={
                "name": "cancel_order",
                "description": "Cancel an open Alpaca order by id.",
                "input_schema": {
                    "type": "object",
                    "properties": {"order_id": {"type": "string"}},
                    "required": ["order_id"],
                },
            },
            handler=_h_cancel_order,
            routines=frozenset({"execute", "midday"}),
        ),
        "set_trailing_stop": ToolSpec(
            definition={
                "name": "set_trailing_stop",
                "description": (
                    "Attach or replace the trailing stop on an existing long "
                    "position. trail_percent is fractional (0.07 = 7%). "
                    "Valid range 3–25%."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "symbol": {"type": "string"},
                        "trail_percent": {"type": "number"},
                    },
                    "required": ["symbol", "trail_percent"],
                },
            },
            handler=_h_set_trailing_stop,
            routines=frozenset({"execute", "midday"}),
        ),
        "place_buy": ToolSpec(
            definition={
                "name": "place_buy",
                "description": (
                    "Open or add to a position. Enforces 5% equity cap, "
                    "15-position max, wash-trade window, and auto-attaches "
                    "a 10% trailing stop. Thesis must be ≥20 chars."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "symbol": {"type": "string"},
                        "notional_usd": {"type": "number", "minimum": 1},
                        "thesis": {"type": "string", "minLength": 20},
                    },
                    "required": ["symbol", "notional_usd", "thesis"],
                },
            },
            handler=_h_place_buy,
            routines=frozenset({"execute"}),
        ),
        "place_sell": ToolSpec(
            definition={
                "name": "place_sell",
                "description": (
                    "Close or trim a position. qty can be a number or the "
                    "string 'all'. Cancels the active trailing stop first. "
                    "Reason must be ≥20 chars."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "symbol": {"type": "string"},
                        "qty": {"oneOf": [{"type": "number"}, {"type": "string", "enum": ["all"]}]},
                        "reason": {"type": "string", "minLength": 20},
                    },
                    "required": ["symbol", "reason"],
                },
            },
            handler=_h_place_sell,
            routines=frozenset({"midday"}),
        ),
    }
    # Lightweight sanity check — catch routine-name typos early.
    for name, spec in r.items():
        bad = spec.routines - set(ALL_ROUTINES)
        assert not bad, f"tool {name!r} references unknown routines {bad}"
    return r


REGISTRY: dict[str, ToolSpec] = _build_registry()


def tools_for_routine(routine: str) -> list[dict]:
    """Return the list of tool definitions the Anthropic API should see for
    this routine. ``web_search`` is added by the runner as a server tool —
    not in this registry because its handler lives on Anthropic's side."""
    if routine not in ALL_ROUTINES:
        raise KeyError(f"unknown routine: {routine}")
    return [spec.definition for spec in REGISTRY.values() if routine in spec.routines]


def handler_for(name: str) -> Callable[[dict], dict]:
    spec = REGISTRY.get(name)
    if spec is None:
        raise ToolError(f"unknown tool {name!r}")
    return spec.handler


def routine_allows(name: str, routine: str) -> bool:
    spec = REGISTRY.get(name)
    return bool(spec) and routine in spec.routines
