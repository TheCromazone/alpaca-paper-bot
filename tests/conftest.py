"""Shared fixtures: an isolated environment for every test.

Isolation has to be in place *before* any ``bot`` module is imported:

* ``bot.config`` calls ``load_dotenv(.env, override=True)`` at import, which
  would clobber the env vars below with the developer's real .env (real
  Alpaca keys, the real DB path, DRY_RUN=false). We neutralise
  ``dotenv.load_dotenv`` first; pydantic-settings still reads .env for any
  field not set here, but env vars take precedence over the file.
* ``bot.db`` builds its engine from ``DB_PATH`` at import, so the temp DB
  path must be in the environment by then.

No test touches the network: Alpaca is replaced by ``FakeAlpaca`` and the
memory directory is redirected to a per-test temp dir.
"""
from __future__ import annotations

import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import dotenv

dotenv.load_dotenv = lambda *a, **k: False  # see module docstring

_TMP = Path(tempfile.mkdtemp(prefix="alpaca-bot-tests-"))
os.environ.update({
    "DB_PATH": str(_TMP / "test.db"),
    "ALPACA_API_KEY": "test-key",
    "ALPACA_API_SECRET": "test-secret",
    "ALPACA_BASE_URL": "https://paper-api.alpaca.markets/v2",
    "DRY_RUN": "false",
    "LLM_PROVIDER": "anthropic",
    "ANTHROPIC_API_KEY": "test-anthropic-key",
    "LLM_DAILY_USD_BUDGET": "12",
    "LLM_ROUTINES_ENABLED": "true",
    "LOG_LEVEL": "WARNING",
})

import pytest  # noqa: E402

from bot.config import settings  # noqa: E402
from bot.db import Base, engine, init_db  # noqa: E402

assert Path(settings.db_path) == _TMP / "test.db", "tests must never touch the real DB"
init_db()


# ---------------------------------------------------------------------------
# Fake Alpaca
# ---------------------------------------------------------------------------


class FakeAlpaca:
    """In-memory stand-in for ``bot.alpaca_client.AlpacaClient``.

    Records every call in ``calls`` (name, args) so tests can assert both
    *whether* a broker mutation happened and in what order.
    """

    MUTATING = {"submit_market", "submit_trailing_stop", "submit_limit", "cancel_order_by_id"}

    def __init__(self) -> None:
        self.equity = 100_000.0
        self.cash = 50_000.0
        self.buying_power = 200_000.0
        self.positions_list: list[SimpleNamespace] = []
        self.quotes: dict[str, float] = {}
        self.orders: list[dict] = []
        self.is_open = True
        self.calls: list[tuple] = []
        self.stop_error: Exception | None = None
        self.market_error: Exception | None = None
        self.order_info: dict[str, dict] = {}
        self.leave_orders_open = False
        # Async-cancel simulation: cancel_lag[oid] = number of status polls
        # that still report pending_cancel (the order keeps holding shares);
        # fill_on_cancel = orders that execute before the cancel lands.
        self.cancel_lag: dict[str, int] = {}
        self.fill_on_cancel: set[str] = set()
        self._n = 0

    # -- helpers for tests --
    def add_position(self, symbol: str, qty: float, avg: float, price: float | None = None) -> None:
        price = avg if price is None else price
        self.positions_list.append(SimpleNamespace(
            symbol=symbol, qty=qty, avg_entry_price=avg, market_price=price,
            market_value=qty * price, unrealized_pl=qty * (price - avg),
        ))
        self.quotes.setdefault(symbol, price)

    def add_order(self, symbol: str, side: str, *, type: str = "market", qty: float = 1.0,
                  notional: float = 0.0, filled_qty: float = 0.0, oid: str | None = None) -> str:
        oid = oid or f"ord-{len(self.orders) + 1}"
        self.orders.append({
            "id": oid, "symbol": symbol, "qty": qty, "notional": notional,
            "filled_qty": filled_qty, "side": side, "type": type, "status": "new",
            "submitted_at": None,
        })
        return oid

    def mutations(self) -> list[tuple]:
        return [c for c in self.calls if c[0] in self.MUTATING]

    def names(self) -> list[str]:
        return [c[0] for c in self.calls]

    # -- AlpacaClient surface --
    def account(self):
        self.calls.append(("account",))
        return SimpleNamespace(equity=self.equity, cash=self.cash,
                               buying_power=self.buying_power, pattern_day_trader=False)

    def positions(self):
        self.calls.append(("positions",))
        return list(self.positions_list)

    def latest_quotes(self, symbols):
        syms = list(symbols)
        self.calls.append(("latest_quotes", tuple(syms)))
        return {s: self.quotes[s] for s in syms if s in self.quotes}

    def market_is_open(self) -> bool:
        self.calls.append(("market_is_open",))
        return self.is_open

    def open_orders(self) -> list[dict]:
        self.calls.append(("open_orders",))
        return [dict(o) for o in self.orders]

    @staticmethod
    def _info(status: str, filled_qty: float = 0.0) -> dict:
        return {"status": status, "filled_qty": filled_qty, "filled_avg_price": 0.0, "filled_at": None}

    def _reduce_position(self, symbol: str, qty: float) -> None:
        for i, p in enumerate(self.positions_list):
            if p.symbol == symbol:
                left = p.qty - qty
                if left <= 1e-9:
                    self.positions_list.pop(i)
                else:
                    self.positions_list[i] = SimpleNamespace(
                        **{**vars(p), "qty": left, "market_value": left * p.market_price})
                return

    def cancel_order_by_id(self, order_id: str) -> bool:
        self.calls.append(("cancel_order_by_id", order_id))
        order = next((o for o in self.orders if o["id"] == order_id), None)
        if order is None:
            return False
        if order_id in self.fill_on_cancel:
            # Executed before the cancel landed; Alpaca refuses the cancel.
            self.orders.remove(order)
            self.order_info[order_id] = self._info("filled", order["qty"])
            if order["side"] == "sell":
                self._reduce_position(order["symbol"], order["qty"])
            return False
        if self.cancel_lag.get(order_id):
            self.order_info[order_id] = self._info("pending_cancel")
            return True
        self.orders.remove(order)
        self.order_info[order_id] = self._info("canceled")
        return True

    def submit_market(self, symbol: str, qty: float, side: str) -> str:
        self.calls.append(("submit_market", symbol, qty, side))
        if self.market_error:
            raise self.market_error
        self._n += 1
        oid = f"mkt-{self._n}"
        if self.leave_orders_open:
            # Simulate a market order that hasn't filled yet.
            self.add_order(symbol, side, type="market", qty=qty, oid=oid)
        return oid

    def submit_trailing_stop(self, symbol: str, qty: float, trail_percent: float) -> str:
        self.calls.append(("submit_trailing_stop", symbol, qty, trail_percent))
        if self.stop_error:
            raise self.stop_error
        self._n += 1
        oid = f"stop-{self._n}"
        self.add_order(symbol, "sell", type="trailing_stop", qty=qty, oid=oid)
        return oid

    def order_by_id(self, order_id: str):
        self.calls.append(("order_by_id", order_id))
        info = self.order_info.get(order_id)
        if info and info["status"] == "pending_cancel" and self.cancel_lag.get(order_id):
            self.cancel_lag[order_id] -= 1
            if self.cancel_lag[order_id] <= 0:
                self.orders = [o for o in self.orders if o["id"] != order_id]
                self.order_info[order_id] = info = self._info("canceled")
        return info


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def clean_db():
    """Fresh schema for every test."""
    Base.metadata.drop_all(engine)
    init_db()
    yield


@pytest.fixture(autouse=True)
def memory_dir(tmp_path, monkeypatch):
    """Redirect memory/*.md to a temp dir so tests never write the real
    research_log / trade_log."""
    from bot.llm import memory

    d = tmp_path / "memory"
    d.mkdir()
    (d / "trade_log.md").write_text("# Trade log\n", encoding="utf-8")
    (d / "research_log.md").write_text("# Research log\n", encoding="utf-8")
    monkeypatch.setattr(memory, "MEMORY_DIR", d)
    return d


@pytest.fixture(autouse=True)
def live_mode(monkeypatch):
    """Default to live (non-dry-run) so caps are exercised on the real path;
    dry-run tests flip it explicitly."""
    monkeypatch.setattr(settings, "dry_run", False)


@pytest.fixture(autouse=True)
def no_broker_sleep(monkeypatch):
    """Broker-side waits (cancel confirmation polling, order-lookup retries)
    run instantly in tests."""
    import bot.alpaca_client as ac

    monkeypatch.setattr(ac.time, "sleep", lambda *_: None)


@pytest.fixture
def fake(monkeypatch):
    """A FakeAlpaca wired into every module that constructs AlpacaClient."""
    from bot.llm import tools

    fa = FakeAlpaca()
    monkeypatch.setattr(tools, "_alpaca", lambda: fa)
    return fa


@pytest.fixture
def regime(monkeypatch):
    """Set the market-regime label the tool layer sees."""
    from bot.llm import tools

    state = {"label": "neutral"}
    monkeypatch.setattr(tools, "_current_regime_label", lambda: state["label"])
    return state


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
