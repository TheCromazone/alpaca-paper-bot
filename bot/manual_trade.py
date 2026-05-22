"""Manual buy/sell from the dashboard.

This is the one user-facing escape hatch around the LLM tool layer. The user
is making the call deliberately, so we **don't** enforce the conviction caps
(5%/position, 15-position max, 2-fresh-names/day, wash-trade lookback) — those
are LLM-discipline rules, not user-discipline rules. We *do* still:

  * pre-cancel any opposite-side open orders on the symbol (the fix for last
    week's 44% Alpaca wash-trade rejection rate — same pattern as place_buy).
  * honor ``settings.dry_run`` — no Alpaca submit when paper-mode is forced off.
  * persist a ``Trade`` row plus a ``Decision`` row tagged ``manual_{side}``
    so the dashboard's trade journal renders the row identically to a routine.
  * append a ``MANUAL`` line to ``memory/trade_log.md``.

The API endpoint at ``POST /trade/manual`` is a thin wrapper around
``manual_trade()``. Keeping the logic in this module lets us unit-test it
without spinning up FastAPI.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from loguru import logger

from bot.alpaca_client import AlpacaClient
from bot.config import settings
from bot.db import Decision, SessionLocal, Trade
from bot.llm import memory


class ManualTradeError(ValueError):
    """User-facing rejection — surface the message verbatim to the dashboard."""


def _alpaca() -> AlpacaClient:
    return AlpacaClient()


def _cancel_opposite_open_orders(symbol: str, opposite_side: str) -> int:
    """Cancel all open Alpaca orders on ``symbol`` whose side is
    ``opposite_side``. Returns count cancelled. No-op safety net.
    """
    c = _alpaca()
    n = 0
    for o in c.open_orders():
        if o["symbol"].upper() != symbol.upper():
            continue
        if o["side"].lower() != opposite_side:
            continue
        if c.cancel_order_by_id(o["id"]):
            n += 1
    return n


def manual_trade(
    *,
    symbol: str,
    side: str,
    qty: Optional[float] = None,
    notional_usd: Optional[float] = None,
    note: str = "",
    allow_after_hours: bool = False,
) -> dict:
    """Place a manual market order.

    Provide exactly one of ``qty`` or ``notional_usd``. For sells, set
    ``qty`` equal to the live position size to close the whole thing
    (the dashboard's "Sell all" button does this).

    Returns a dict suitable for direct JSON serialisation back to the UI.

    Raises:
        ManualTradeError: with a user-readable message on any rejection.
    """
    # ---- input validation ----
    symbol = (symbol or "").strip().upper()
    if not symbol or len(symbol) > 16 or not symbol.replace(".", "").isalnum():
        raise ManualTradeError("symbol must be a 1-16 character ticker")
    if side not in ("buy", "sell"):
        raise ManualTradeError("side must be 'buy' or 'sell'")
    if (qty is None) == (notional_usd is None):
        raise ManualTradeError("provide exactly one of qty or notional_usd")
    if qty is not None and qty <= 0:
        raise ManualTradeError("qty must be > 0")
    if notional_usd is not None and notional_usd <= 0:
        raise ManualTradeError("notional_usd must be > 0")
    note = (note or "").strip()[:200]

    c = _alpaca()

    # ---- live Alpaca state in one round trip ----
    market_open = c.market_is_open()
    if not market_open and not allow_after_hours:
        raise ManualTradeError(
            "market is closed; resubmit during regular session, or pass "
            "allow_after_hours=true (paper account will queue the order)"
        )

    acct = c.account()
    positions = c.positions()
    held = {p.symbol: p for p in positions}
    quotes = c.latest_quotes([symbol])
    mid = quotes.get(symbol)
    if (not mid or mid <= 0) and symbol in held:
        # Fallback to last position price if quote feed is empty.
        mid = held[symbol].market_price
    if not mid or mid <= 0:
        raise ManualTradeError(
            f"no live quote available for {symbol}; refusing to size order"
        )

    # ---- compute final qty ----
    if qty is None:
        qty = round(float(notional_usd) / mid, 4)
        if qty <= 0:
            raise ManualTradeError(
                f"computed qty {qty} for ${notional_usd:.2f} at ${mid:.2f} — too small"
            )
    qty = float(qty)

    # ---- side-specific validation ----
    if side == "sell":
        if symbol not in held:
            raise ManualTradeError(
                f"no position in {symbol}; cannot sell what you don't own"
            )
        live_qty = held[symbol].qty
        # 1e-4 slack absorbs float-rounding from the qty=notional/mid path.
        if qty > live_qty + 1e-4:
            raise ManualTradeError(
                f"qty {qty} exceeds live position {live_qty} on {symbol}"
            )
    else:  # buy
        cost_estimate = qty * mid
        # 50¢ slack covers fill drift; Alpaca itself enforces buying power.
        if acct.buying_power < cost_estimate - 0.50:
            raise ManualTradeError(
                f"buying power ${acct.buying_power:.2f} < estimated cost "
                f"${cost_estimate:.2f} for {qty} {symbol} @ ~${mid:.2f}"
            )

    notional = qty * mid

    # ---- pre-cancel opposite-side open orders (wash-trade fix) ----
    opposite = "sell" if side == "buy" else "buy"
    try:
        cancelled = _cancel_opposite_open_orders(symbol, opposite)
    except Exception as exc:
        # Pre-cancel is best-effort — don't block the user-initiated trade
        # on a list-orders hiccup.
        logger.warning("manual {} {}: pre-cancel scan failed: {}", side, symbol, exc)
        cancelled = 0
    if cancelled:
        logger.info(
            "manual {} {}: pre-cancelled {} open {} order(s)",
            side, symbol, cancelled, opposite,
        )

    # ---- submit (or simulate) ----
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if settings.dry_run:
        order_id = f"DRY-MAN-{uuid.uuid4().hex[:8]}"
        status = "dry_run"
    else:
        try:
            order_id = c.submit_market(symbol, qty, side)
        except Exception as exc:
            # Surface Alpaca's rejection text directly — the user wants to
            # know "insufficient buying power" or "asset is not tradable",
            # not a generic 500.
            raise ManualTradeError(f"Alpaca rejected order: {exc}") from exc
        status = "submitted"

    reason = f"manual: {note}" if note else "manual entry from dashboard"

    with SessionLocal.begin() as s:
        trade = Trade(
            ticker=symbol,
            side=side,
            qty=qty,
            price=mid,
            notional=notional,
            status=status,
            alpaca_order_id=order_id,
            dry_run=settings.dry_run,
        )
        s.add(trade)
        s.flush()
        s.add(
            Decision(
                ticker=symbol,
                action=f"manual_{side}",
                composite_score=0.0,
                score_breakdown={"manual": True, "note": note},
                reason=reason,
                dry_run=settings.dry_run,
                trade_id=trade.id,
            )
        )
        trade_id = trade.id

    memory.append(
        "trade_log",
        f"- {now_iso} | MANUAL {side.upper():4s} {symbol:6s} qty={qty:>10.4f} "
        f"@ ~${mid:>8.2f} notional=${notional:>8.2f} note: {note or '(none)'}",
    )
    logger.info(
        "MANUAL {} {} qty={} notional=${:.2f} dry_run={} order={}",
        side, symbol, qty, notional, settings.dry_run, order_id,
    )

    return {
        "trade_id": trade_id,
        "order_id": order_id,
        "symbol": symbol,
        "side": side,
        "qty": round(qty, 4),
        "est_price": round(mid, 4),
        "notional": round(notional, 2),
        "status": status,
        "dry_run": settings.dry_run,
        "cancelled_open_opposite": cancelled,
        "market_was_open": market_open,
        "reason": reason,
    }
