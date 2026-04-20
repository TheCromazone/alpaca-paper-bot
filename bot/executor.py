"""Turns PlannedOrders into Alpaca orders (or logs them in DRY_RUN mode)."""
from __future__ import annotations

import math
from datetime import datetime, timezone

from loguru import logger

from bot.alpaca_client import AlpacaClient
from bot.config import settings
from bot.db import Decision, SessionLocal, Trade
from bot.strategy import PlannedOrder


def _qty_from_dollars(dollars: float, price: float) -> float:
    if price <= 0:
        return 0.0
    qty = dollars / price
    # Alpaca supports fractional shares for most equities; round to 4 decimals.
    return math.floor(qty * 10_000) / 10_000


def execute(orders: list[PlannedOrder], alpaca: AlpacaClient) -> list[Trade]:
    if not orders:
        return []
    symbols = sorted({o.ticker for o in orders})
    prices = alpaca.latest_quotes(symbols)

    trades: list[Trade] = []
    with SessionLocal.begin() as s:
        for o in orders:
            price = prices.get(o.ticker)
            if not price:
                logger.warning("no quote for {} — skipping {}", o.ticker, o.action_label)
                continue
            qty = _qty_from_dollars(o.dollar_size, price)
            if qty <= 0:
                continue
            # Pin limit ±0.25% from midpoint — improves fill without chasing.
            limit = price * (1.0025 if o.side == "buy" else 0.9975)

            if settings.dry_run:
                trade = Trade(
                    ticker=o.ticker, side=o.side, qty=qty, price=price,
                    notional=qty * price, status="dry_run", dry_run=True,
                )
                s.add(trade)
                logger.info("[DRY RUN] {} {} {} @ ~{:.2f} — {}",
                            o.side, qty, o.ticker, price, o.reason)
            else:
                try:
                    order_id = alpaca.submit_limit(o.ticker, qty, o.side, limit)
                    trade = Trade(
                        ticker=o.ticker, side=o.side, qty=qty, price=price,
                        notional=qty * price, status="submitted",
                        alpaca_order_id=order_id, dry_run=False,
                    )
                    s.add(trade)
                except Exception as exc:
                    logger.warning("order failed for {}: {}", o.ticker, exc)
                    trade = Trade(
                        ticker=o.ticker, side=o.side, qty=qty, price=price,
                        notional=qty * price, status="rejected", dry_run=False,
                    )
                    s.add(trade)
            trades.append(trade)

        # Link decisions → trades (best-effort by ticker)
        s.flush()
        tid_by_ticker = {t.ticker: t.id for t in trades}
        cutoff = datetime.now(timezone.utc).replace(microsecond=0)
        recent = s.query(Decision).filter(Decision.trade_id.is_(None)).all()
        for d in recent:
            tid = tid_by_ticker.get(d.ticker)
            if tid and d.action in ("buy", "sell", "add"):
                d.trade_id = tid

    return trades
