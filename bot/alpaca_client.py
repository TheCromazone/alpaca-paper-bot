"""Thin wrapper around the alpaca-py SDK."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from typing import Iterable

import requests

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

# alpaca-py's RESTClient calls ``requests.Session.request`` with no timeout,
# so a half-open connection blocks the calling thread forever. Every
# scheduled job runs with max_instances=1, so one hung call silently skips
# every later run of that job — a stuck sync_account means no synthetic
# stops; a stuck llm_execute means no buys — until the process restarts
# (and the 06:25 Task Scheduler trigger is a no-op while it's alive).
# requests' Timeout is an OSError, so _NETWORK_RETRY retries it on reads.
HTTP_TIMEOUT_S = 30


def _install_default_timeout(sdk_client: object, timeout: float = HTTP_TIMEOUT_S) -> None:
    session = getattr(sdk_client, "_session", None)
    if session is None or not hasattr(session, "request"):
        # alpaca-py internals moved: calls on this client can hang forever
        # again. Say so loudly rather than silently running unprotected.
        logger.warning(
            "alpaca-py {} has no requests session at `_session`; HTTP timeout "
            "NOT installed — Alpaca calls on it can block indefinitely",
            type(sdk_client).__name__,
        )
        return
    if getattr(session, "_bot_default_timeout", False):
        return
    original = session.request

    def request(method, url, **kwargs):
        if kwargs.get("timeout") is None:
            kwargs["timeout"] = timeout
        return original(method, url, **kwargs)

    session.request = request
    session._bot_default_timeout = True


def _http_status(exc: BaseException | None) -> int | None:
    """HTTP status of an alpaca-py APIError (None for anything else)."""
    try:
        return getattr(exc, "status_code", None)
    except Exception:
        return None


def _is_duplicate_client_id(exc: BaseException) -> bool:
    text = str(exc).lower()
    return "client_order_id" in text and any(w in text for w in ("unique", "duplicate", "already"))


# Order statuses after which an order holds no shares and can't fill further.
_TERMINAL_ORDER_STATUSES = {
    "canceled", "filled", "expired", "rejected", "done_for_day", "replaced",
    "stopped", "suspended",
}
CANCEL_CONFIRM_POLLS = 10
CANCEL_CONFIRM_POLL_S = 0.5


def cancel_and_wait(client, orders: list[dict], *, polls: int = CANCEL_CONFIRM_POLLS,
                    poll_s: float = CANCEL_CONFIRM_POLL_S) -> dict:
    """Cancel ``orders`` (open-order dicts) and wait — bounded, ~5 s — until
    Alpaca reports each one terminal.

    Alpaca cancels are asynchronous: until an order leaves ``pending_cancel``
    its shares stay held, so an exit submitted straight after the cancel
    request was rejected for insufficient qty. Returns
    ``{"cancelled": [ids], "filled": [ids], "unresolved": [order dicts]}`` —
    ``filled`` = executed before the cancel landed (e.g. the stop fired),
    ``unresolved`` = still open when the wait ran out. Callers re-check the
    position before selling whenever either list is non-empty.
    """
    out: dict = {"cancelled": [], "filled": [], "unresolved": []}
    if not orders:
        return out
    for o in orders:
        client.cancel_order_by_id(o["id"])
    pending = {o["id"]: o for o in orders}
    for attempt in range(polls + 1):
        for oid in list(pending):
            info = client.order_by_id(oid) or {}
            status = (info.get("status") or "").lower()
            if status in _TERMINAL_ORDER_STATUSES:
                out["filled" if status == "filled" else "cancelled"].append(oid)
                pending.pop(oid)
        if not pending or attempt == polls:
            break
        time.sleep(poll_s)
    out["unresolved"] = list(pending.values())
    if out["unresolved"]:
        logger.warning("cancel not confirmed within {:.0f}s for order(s) {}",
                       polls * poll_s, [o["id"] for o in out["unresolved"]])
    return out


def remaining_qty(order: dict) -> float:
    """Unfilled quantity of an open-order dict."""
    return max(float(order.get("qty") or 0) - float(order.get("filled_qty") or 0), 0.0)


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
        _install_default_timeout(self.trading)
        _install_default_timeout(self.data)

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

    def daily_bars(self, symbol: str, limit: int = 260) -> list[tuple]:
        """Returns [(date, open, high, low, close, volume)] for up to `limit`
        trading days. Same request as ``daily_closes`` (IEX feed), keeping the
        full bar; volume is IEX-only, so it is a relative measure."""
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
            logger.warning("daily_bars failed for {}: {}", symbol, exc)
            return []
        rows = bars.data.get(symbol, [])

        def _f(v) -> float | None:
            return float(v) if v is not None else None

        return [
            (b.timestamp, _f(b.open), _f(b.high), _f(b.low), float(b.close), _f(b.volume))
            for b in rows[-limit:]
        ]

    # ---------- orders ----------
    # A timeout or dropped connection on submit doesn't mean Alpaca rejected
    # the order — it may have been accepted with the response lost. Without a
    # client_order_id the order became a ghost: no Trade/Decision/stop row,
    # and the model, seeing an error, could retry into a duplicate. Every
    # submit now carries a unique client_order_id; on a transport error — or
    # a duplicate-client_order_id rejection, which is what alpaca-py's own
    # same-body re-POST after a 504 gets when the first attempt landed — we
    # look the order up and, if Alpaca has it, return its id like a normal
    # submit. Only a 404 on the final lookup means "never landed"; any other
    # lookup failure leaves the outcome unknown and says so.
    _LOST_RESPONSE_ERRORS = (requests.exceptions.Timeout, requests.exceptions.ConnectionError)
    _LOOKUP_DELAYS_S = (0, 1, 2)   # a fresh order can briefly 404 (eventual consistency)

    def _submit(self, req) -> str:
        try:
            return str(self.trading.submit_order(req).id)
        except Exception as exc:
            if not (isinstance(exc, self._LOST_RESPONSE_ERRORS) or _is_duplicate_client_id(exc)):
                raise
            order, last_error = None, None
            for delay in self._LOOKUP_DELAYS_S:
                if delay:
                    time.sleep(delay)
                try:
                    order = self.trading.get_order_by_client_id(req.client_order_id)
                    break
                except Exception as lookup_exc:
                    last_error = lookup_exc
            if order is None:
                if _http_status(last_error) == 404:
                    raise  # Alpaca has no such order: it never landed
                raise RuntimeError(
                    f"order outcome unknown: submit failed ({exc!r}) and lookup of "
                    f"client_order_id={req.client_order_id} failed ({last_error!r}); "
                    "check open orders before retrying"
                ) from exc
            status = str(getattr(order.status, "value", order.status) or "").lower()
            if status == "rejected":
                raise RuntimeError(
                    f"order {order.id} (client_order_id={req.client_order_id}) was "
                    f"rejected by Alpaca after a lost response: {exc!r}"
                ) from exc
            logger.warning(
                "submit {} {}: response lost ({!r}), but Alpaca accepted it as {} ({})",
                req.side, req.symbol, exc, order.id, status or "unknown status",
            )
            return str(order.id)

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
            client_order_id=uuid.uuid4().hex,
        )
        order_id = self._submit(req)
        logger.info("submitted {} {} {} @ {}", side, qty, symbol, limit_price)
        return order_id

    def submit_market(self, symbol: str, qty: float, side: str) -> str:
        """Market order, DAY TIF. The LLM-era workhorse — swing entries don't
        need to chase ticks, and Alpaca's price improvement is good on paper.
        """
        req = MarketOrderRequest(
            symbol=symbol,
            qty=qty,
            side=OrderSide.BUY if side == "buy" else OrderSide.SELL,
            time_in_force=TimeInForce.DAY,
            client_order_id=uuid.uuid4().hex,
        )
        order_id = self._submit(req)
        logger.info("submitted market {} {} {}", side, qty, symbol)
        return order_id

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
            client_order_id=uuid.uuid4().hex,
        )
        order_id = self._submit(req)
        logger.info("submitted trailing-stop {} {} trail={}%", qty, symbol, round(trail_percent * 100, 2))
        return order_id

    def cancel_order_by_id(self, order_id: str) -> bool:
        try:
            self.trading.cancel_order_by_id(order_id)
            return True
        except Exception as exc:
            logger.warning("cancel_order {} failed: {}", order_id, exc)
            return False

    @_NETWORK_RETRY
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
                # notional-sized orders carry no qty; filled_qty lets callers
                # value only the unfilled remainder of a working order.
                "notional": float(getattr(o, "notional", None) or 0),
                "filled_qty": float(getattr(o, "filled_qty", None) or 0),
                "side": str(o.side.value if hasattr(o.side, "value") else o.side),
                "type": str(o.order_type.value if hasattr(o.order_type, "value") else o.order_type),
                "status": str(o.status.value if hasattr(o.status, "value") else o.status),
                "submitted_at": o.submitted_at.isoformat() if o.submitted_at else None,
            })
        return out

    @_NETWORK_RETRY
    def closed_orders(self, days: int = 30, limit: int = 200) -> list[dict]:
        """Return Alpaca's closed (filled / partially_filled / canceled) orders
        from the last ``days`` days. We use this to surface trailing-stop SELL
        fills in the dashboard — those execute on Alpaca's side and never
        write a row to our local ``Trade`` table because the LLM didn't
        place them.
        """
        from datetime import datetime, timedelta, timezone

        after = datetime.now(timezone.utc) - timedelta(days=days)
        req = GetOrdersRequest(
            status=QueryOrderStatus.CLOSED,
            after=after,
            limit=limit,
            direction="desc",
        )
        try:
            orders = self.trading.get_orders(filter=req)
        except Exception as exc:
            logger.warning("closed_orders failed: {}", exc)
            return []
        out: list[dict] = []
        for o in orders:
            # Skip non-filled (rejected/canceled with no fill — noise on the trade tape)
            filled_qty = float(o.filled_qty or 0)
            if filled_qty <= 0:
                continue
            avg_price = float(o.filled_avg_price or 0)
            out.append({
                "id": str(o.id),
                "client_order_id": str(o.client_order_id) if o.client_order_id else None,
                "symbol": o.symbol,
                "qty": filled_qty,
                "side": str(o.side.value if hasattr(o.side, "value") else o.side),
                "type": str(o.order_type.value if hasattr(o.order_type, "value") else o.order_type),
                "status": str(o.status.value if hasattr(o.status, "value") else o.status),
                "price": avg_price,
                "notional": filled_qty * avg_price,
                "submitted_at": o.submitted_at.isoformat() if o.submitted_at else None,
                "filled_at": o.filled_at.isoformat() if o.filled_at else None,
            })
        return out

    def order_by_id(self, order_id: str) -> dict | None:
        """Current state of a single order — used by the sync job to
        reconcile local Trade rows (status/fill price/fill time) against
        Alpaca. Returns None when the order can't be fetched (unknown id,
        transient network error) so callers just skip and retry next sync.
        """
        try:
            o = self.trading.get_order_by_id(order_id)
        except Exception as exc:
            logger.warning("order_by_id {} failed: {}", order_id, exc)
            return None
        return {
            "id": str(o.id),
            "symbol": o.symbol,
            "status": str(o.status.value if hasattr(o.status, "value") else o.status),
            "filled_qty": float(o.filled_qty or 0),
            "filled_avg_price": float(o.filled_avg_price or 0),
            "filled_at": o.filled_at,
        }

    @_NETWORK_RETRY
    def market_is_open(self) -> bool:
        return bool(self.trading.get_clock().is_open)
