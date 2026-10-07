"""Dashboard manual trades: no conviction caps (by design), but the same
broker hygiene as the routines — confirmed cancels, every open sell cleared
before a sell, and dry-run never touching the broker."""
from __future__ import annotations

import pytest
from sqlalchemy import select

from bot import manual_trade as mt
from bot.config import settings
from bot.db import SessionLocal, Trade
from bot.manual_trade import ManualTradeError, manual_trade
from tests.conftest import FakeAlpaca


@pytest.fixture
def fa(monkeypatch):
    f = FakeAlpaca()
    f.quotes["AAPL"] = 100.0
    monkeypatch.setattr(mt, "_alpaca", lambda: f)
    return f


def _last(calls, call):
    return max(i for i, c in enumerate(calls) if c == call)


def test_manual_sell_waits_for_stop_cancel_to_land(fa):
    # Selling while the stop is still pending_cancel → "insufficient qty".
    fa.add_position("AAPL", qty=10, avg=100)
    fa.add_order("AAPL", "sell", type="trailing_stop", qty=10, oid="s1")
    fa.cancel_lag["s1"] = 2
    manual_trade(symbol="AAPL", side="sell", qty=10)
    assert fa.order_info["s1"]["status"] == "canceled"
    assert _last(fa.calls, ("order_by_id", "s1")) < fa.names().index("submit_market")


def test_manual_sell_cancels_every_open_order_on_the_symbol(fa):
    fa.add_position("AAPL", qty=10, avg=100)
    fa.add_order("AAPL", "sell", type="trailing_stop", qty=6, oid="s6")
    fa.add_order("AAPL", "sell", type="trailing_stop", qty=4, oid="s4")
    fa.add_order("AAPL", "buy", type="limit", qty=2, oid="b2")
    other = fa.add_order("MSFT", "sell", type="trailing_stop", qty=3)
    out = manual_trade(symbol="AAPL", side="sell", qty=10)
    muts = fa.mutations()
    assert muts[-1] == ("submit_market", "AAPL", 10.0, "sell")
    assert {("cancel_order_by_id", i) for i in ("s6", "s4", "b2")} <= set(muts[:-1])
    assert ("cancel_order_by_id", other) not in muts
    assert out["cancelled_open_opposite"] == 3


def test_manual_buy_cancels_open_sells_with_confirmation_but_not_buys(fa):
    fa.add_order("AAPL", "sell", type="limit", qty=5, oid="sl")
    fa.add_order("AAPL", "buy", type="limit", qty=1, oid="bl")
    fa.cancel_lag["sl"] = 1
    manual_trade(symbol="AAPL", side="buy", notional_usd=500)
    assert ("cancel_order_by_id", "bl") not in fa.calls
    assert _last(fa.calls, ("order_by_id", "sl")) < fa.names().index("submit_market")


def test_manual_trades_in_dry_run_never_touch_the_broker(fa, monkeypatch):
    monkeypatch.setattr(settings, "dry_run", True)
    fa.add_position("AAPL", qty=10, avg=100)
    fa.add_order("AAPL", "sell", type="trailing_stop", qty=10, oid="real-stop")
    fa.add_order("AAPL", "buy", type="limit", qty=1, oid="real-buy")
    manual_trade(symbol="AAPL", side="buy", notional_usd=500)
    manual_trade(symbol="AAPL", side="sell", qty=5)
    assert fa.mutations() == []
    with SessionLocal() as s:
        assert {t.status for t in s.scalars(select(Trade)).all()} == {"dry_run"}


def test_manual_sell_when_stop_fires_during_cancel_submits_nothing(fa):
    fa.add_position("AAPL", qty=10, avg=100)
    fa.add_order("AAPL", "sell", type="trailing_stop", qty=10, oid="s1")
    fa.fill_on_cancel.add("s1")
    with pytest.raises(ManualTradeError, match="closed"):
        manual_trade(symbol="AAPL", side="sell", qty=10)
    assert "submit_market" not in fa.names()


def test_manual_sell_refuses_shares_still_held_by_an_unconfirmed_cancel(fa):
    fa.add_position("AAPL", qty=10, avg=100)
    fa.add_order("AAPL", "sell", type="trailing_stop", qty=4, oid="stuck")
    fa.cancel_lag["stuck"] = 10**6
    with pytest.raises(ManualTradeError, match="only 6"):
        manual_trade(symbol="AAPL", side="sell", qty=10)
    assert "submit_market" not in fa.names()
    manual_trade(symbol="AAPL", side="sell", qty=6)          # the free part is fine
    assert fa.mutations()[-1] == ("submit_market", "AAPL", 6.0, "sell")
