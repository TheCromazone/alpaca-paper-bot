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
from alpaca.trading.requests import LimitOrderRequest
from loguru import logger

from bot.config import settings


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
    def account(self) -> AccountSummary:
        a = self.trading.get_account()
        return AccountSummary(
            equity=float(a.equity),
            cash=float(a.cash),
            buying_power=float(a.buying_power),
            pattern_day_trader=bool(a.pattern_day_trader),
        )

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

    def market_is_open(self) -> bool:
        return bool(self.trading.get_clock().is_open)
