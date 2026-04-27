"""Thin wrapper around the alpaca-py SDK."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from alpaca.data.enums import DataFeed
from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.requests import StockBarsRequest, StockLatestQuoteRequest
from alpaca.data.timeframe import TimeFrame
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderSide, TimeInForce
from alpaca.trading.requests import (
    GetOrdersRequest,
    LimitOrderRequest,
    MarketOrderRequest,
    TrailingStopOrderRequest,
)
from alpaca.trading.enums import QueryOrderStatus
from loguru import logger
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from bot.config import settings


# Last week's bot.log had 11 sync_account failures over 8 days from
# transient connect/read timeouts to Alpaca. Wrapping the read paths in
# tenacity gives us automatic exponential backoff so a 5-second blip
# doesn't show up as a "failed" job in the dashboard.
_NETWORK_RETRY = retry(
    retry=retry_if_exception_type((TimeoutError, ConnectionError, OSError)),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    reraise=True,
)


@dataclass
class AccountSummary:
    equity: float
    cash: float
    buying_power: float
    pattern_day_trader: bool


@dataclass
class PositionInfo:
    symbol: str
    qty: float
    avg_entry_price: float
    market_price: float
    market_value: float
    unrealized_pl: float


class AlpacaClient:
    """All Alpaca interactions live here — strategy code never talks to the SDK directly."""

    def __init__(self) -> None:
        self.trading = TradingClient(
            api_key=settings.alpaca_api_key,
            secret_key=settings.alpaca_api_secret,
            paper=True,
        )
        self.data = StockHistoricalDataClient(
            api_key=settings.alpaca_api_key,
            secret_key=settings.alpaca_api_secret,
        )

    # ---------- account ----------
    @_NETWORK_RETRY
    def account(self) -> AccountSummary:
        a = self.trading.get_account()
        return AccountSummary(
            equity=float(a.equity),
            cash=float(a.cash),
            buying_power=float(a.buying_power),
            pattern_day_trader=bool(a.pattern_day_trader),
        )

    @_NETWORK_RETRY
    def positions(self) -> list[PositionInfo]:
        items = self.trading.get_all_positions()
        out: list[PositionInfo] = []
        for p in items:
            out.append(
                PositionInfo(
                    symbol=p.symbol,
                    qty=float(p.qty),
                    avg_entry_price=float(p.avg_entry_price),
                    market_price=float(p.current_price),
                    market_value=float(p.market_value),
                    unrealized_pl=float(p.unrealized_pl),
                )
            )
        return out

    # ---------- quotes ----------
    @_NETWORK_RETRY
    def latest_quotes(self, symbols: Iterable[str]) -> dict[str, float]:
        syms = [s for s in symbols if s]
        if not syms:
            return {}
        req = StockLatestQuoteRequest(symbol_or_symbols=syms, feed=DataFeed.IEX)
        resp = self.data.get_stock_latest_quote(req)
        prices: dict[str, float] = {}
        for sym, q in resp.items():
            ask = float(q.ask_price or 0)
            bid = float(q.bid_price or 0)
            if ask and bid:
                prices[sym] = (ask + bid) / 2
            elif ask:
                prices[sym] = ask
            elif bid:
                prices[sym] = bid
        return prices

    def daily_closes(self, symbol: str, limit: int = 260) -> list[tuple]:
        """Returns [(date, close)] for up to `limit` trading days."""
        from datetime import datetime, timedelta, timezone
        end = datetime.now(timezone.utc)
        start = end - timedelta(days=limit * 2)  # weekends/holidays
        req = StockBarsRequest(
            symbol_or_symbols=symbol,
            timeframe=TimeFrame.Day,
            start=start,
            end=end,
            feed=DataFeed.IEX,
        )
        try:
            bars = self.data.get_stock_bars(req)
        except Exception as exc:
            logger.warning("daily_closes failed for {}: {}", symbol, exc)
            return []
        rows = bars.data.get(symbol, [])
        return [(b.timestamp, float(b.close)) for b in rows[-limit:]]

    # ---------- orders ----------
    def submit_limit(
        self,
        symbol: str,
        qty: float,
        side: str,  # "buy" or "sell"
        limit_price: float,
    ) -> str:
        req = LimitOrderRequest(
            symbol=symbol,
            qty=qty,
            side=OrderSide.BUY if side == "buy" else OrderSide.SELL,
            time_in_force=TimeInForce.DAY,
            limit_price=round(limit_price, 2),
        )
        order = self.trading.submit_order(req)
        logger.info("submitted {} {} {} @ {}", side, qty, symbol, limit_price)
        return str(order.id)

    def submit_market(self, symbol: str, qty: float, side: str) -> str:
        """Market order, DAY TIF. The LLM-era workhorse — swing entries don't
        need to chase ticks, and Alpaca's price improvement is good on paper.
        """
        req = MarketOrderRequest(
            symbol=symbol,
            qty=qty,
            side=OrderSide.BUY if side == "buy" else OrderSide.SELL,
            time_in_force=TimeInForce.DAY,
        )
        order = self.trading.submit_order(req)
        logger.info("submitted market {} {} {}", side, qty, symbol)
        return str(order.id)

    def submit_trailing_stop(self, symbol: str, qty: float, trail_percent: float) -> str:
        """Attach a GTC trailing stop to a long position. ``trail_percent`` is
        fractional (0.10 = 10%); Alpaca's SDK wants the whole-number form so
        we scale it once here.
        """
        req = TrailingStopOrderRequest(
            symbol=symbol,
            qty=qty,
            side=OrderSide.SELL,  # always protecting a long
            time_in_force=TimeInForce.GTC,
            trail_percent=round(trail_percent * 100, 2),
        )
        order = self.trading.submit_order(req)
        logger.info("submitted trailing-stop {} {} trail={}%", qty, symbol, round(trail_percent * 100, 2))
        return str(order.id)

    def cancel_order_by_id(self, order_id: str) -> bool:
        try:
            self.trading.cancel_order_by_id(order_id)
            return True
        except Exception as exc:
            logger.warning("cancel_order {} failed: {}", order_id, exc)
            return False

    def open_orders(self) -> list[dict]:
        """Return open (submitted / partially filled / pending) orders as plain dicts."""
        req = GetOrdersRequest(status=QueryOrderStatus.OPEN, limit=200)
        orders = self.trading.get_orders(filter=req)
        out: list[dict] = []
        for o in orders:
            out.append({
                "id": str(o.id),
                "symbol": o.symbol,
                "qty": float(o.qty or 0),
                "side": str(o.side.value if hasattr(o.side, "value") else o.side),
                "type": str(o.order_type.value if hasattr(o.order_type, "value") else o.order_type),
                "status": str(o.status.value if hasattr(o.status, "value") else o.status),
                "submitted_at": o.submitted_at.isoformat() if o.submitted_at else None,
            })
        return out

    @_NETWORK_RETRY
    def market_is_open(self) -> bool:
        return bool(self.trading.get_clock().is_open)
