"""The tool layer is the trust boundary: every hard cap lives in a handler.

These tests drive the handlers directly with Alpaca faked out. Each cap gets
a "rejects what it should" and an "allows what it should" case, plus
regression tests for the bypasses fixed alongside this suite.
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select

from bot.config import (
    LLM_MAX_POSITIONS,
    LLM_MAX_TOOL_RESULT_SIGNALS,
    LLM_MEMORY_READ_MAX_CHARS,
    LLM_MIN_THESIS_CHARS,
    LLM_TRAILING_STOP_PCT,
    settings,
)
from bot.db import Decision, EarningsCalendar, EarningsHistory, Position, SessionLocal, Signal, Trade
from bot.llm import tools
from bot.llm.tools import ToolError
from tests.conftest import utcnow

THESIS = (
    "Catalyst: Q3 print next month. Why mispriced: consensus anchors on last "
    "quarter. Variant view: margins inflect. Datable catalyst: 2026-11-01. "
    "Key risk: guide cut."
)
assert len(THESIS) >= LLM_MIN_THESIS_CHARS


def buy(symbol="AAPL", notional=1000.0, thesis=THESIS):
    return tools._h_place_buy({"symbol": symbol, "notional_usd": notional, "thesis": thesis})


def sell(symbol="AAPL", qty="all", reason=THESIS):
    return tools._h_place_sell({"symbol": symbol, "qty": qty, "reason": reason})


def add_trade(ticker, side, *, days_ago=0.0, status="filled", notional=1000.0, dry_run=False):
    with SessionLocal.begin() as s:
        s.add(Trade(ticker=ticker, side=side, qty=10, price=100, notional=notional,
                    status=status, dry_run=dry_run,
                    submitted_at=utcnow() - timedelta(days=days_ago)))


def add_position_row(ticker, *, opened_days_ago=10, stop_order_id=None, qty=10.0,
                     price=100.0, peak=None, trail_pct=None):
    with SessionLocal.begin() as s:
        s.add(Position(ticker=ticker, qty=qty, avg_cost=price, market_price=price,
                       market_value=qty * price, unrealized_pnl=0.0,
                       peak_price=peak if peak is not None else price,
                       opened_at=utcnow() - timedelta(days=opened_days_ago),
                       stop_order_id=stop_order_id, trail_pct=trail_pct))


def get_position(ticker):
    with SessionLocal() as s:
        return s.get(Position, ticker)


def trades():
    with SessionLocal() as s:
        return s.scalars(select(Trade).order_by(Trade.id)).all()


@pytest.fixture
def quotes(fake):
    fake.quotes.update({"AAPL": 100.0, "MSFT": 100.0, "NVDA": 100.0, "PFE": 100.0,
                        "DIS": 100.0, "BRK.B": 100.0, "XYZ": 100.0})
    return fake.quotes


# ---------------------------------------------------------------------------
# Routine tool filtering
# ---------------------------------------------------------------------------

ORDER_TOOLS = {"place_buy", "place_sell", "set_trailing_stop", "cancel_order"}


@pytest.mark.parametrize("routine, must_have, must_not_have", [
    ("premarket", {"read_memory", "append_memory", "get_recent_news"},
     ORDER_TOOLS | {"write_memory", "list_open_orders"}),
    ("execute", {"place_buy", "get_portfolio", "write_memory"}, {"place_sell"}),
    ("midday", {"place_sell", "set_trailing_stop", "get_portfolio"}, {"place_buy"}),
    ("close", {"get_portfolio", "write_memory"}, ORDER_TOOLS),
    ("weekly_review", {"get_performance_stats", "read_memory"}, ORDER_TOOLS | {"write_memory"}),
])
def test_routine_sees_only_its_tools(routine, must_have, must_not_have):
    names = {d["name"] for d in tools.tools_for_routine(routine)}
    assert must_have <= names
    assert not (must_not_have & names)
    for name in must_not_have:
        assert not tools.routine_allows(name, routine)


def test_order_tools_each_live_in_exactly_one_routine():
    assert tools.REGISTRY["place_buy"].routines == frozenset({"execute"})
    assert tools.REGISTRY["place_sell"].routines == frozenset({"midday"})


def test_unknown_routine_and_tool_rejected():
    with pytest.raises(KeyError):
        tools.tools_for_routine("after_hours")
    with pytest.raises(ToolError):
        tools.handler_for("transfer_funds")
    assert not tools.routine_allows("transfer_funds", "execute")


def test_tool_descriptions_state_the_real_thesis_minimum():
    for name, field in (("place_buy", "thesis"), ("place_sell", "reason")):
        d = tools.REGISTRY[name].definition
        assert f"≥{LLM_MIN_THESIS_CHARS}" in d["description"]
        assert d["input_schema"]["properties"][field]["minLength"] == LLM_MIN_THESIS_CHARS


# ---------------------------------------------------------------------------
# place_buy — size caps
# ---------------------------------------------------------------------------


def test_buy_rejects_over_5pct_and_allows_exactly_5pct(fake, quotes):
    with pytest.raises(ToolError, match="exceeds 5.0% cap"):
        buy(notional=5_000.02)
    assert fake.mutations() == []
    out = buy(notional=5_000.0)
    assert out["status"] == "submitted"


def test_risk_off_halves_the_cap(fake, quotes, regime):
    regime["label"] = "risk_off"
    with pytest.raises(ToolError, match="risk_off"):
        buy(notional=2_600)
    assert buy(notional=2_500)["status"] == "submitted"


def test_top_up_cannot_push_position_over_cap(fake, quotes):
    fake.add_position("AAPL", qty=40, avg=100)  # $4,000 held of a $5,000 cap
    with pytest.raises(ToolError, match="would make it"):
        buy("AAPL", 1_500)
    assert buy("AAPL", 1_000)["status"] == "submitted"


def test_cap_uses_equity_requeried_at_order_time(fake, quotes):
    tools._h_get_portfolio({})          # model looks at a $100k account...
    fake.equity = 10_000.0              # ...equity drops before it orders
    with pytest.raises(ToolError, match="exceeds"):
        buy(notional=4_000)             # fine against stale $100k, not live $10k


def test_buying_power_checked(fake, quotes):
    fake.buying_power = 500.0
    with pytest.raises(ToolError, match="buying power"):
        buy(notional=1_000)


@pytest.mark.parametrize("bad", ["nan", "NaN", float("nan"), "inf", float("inf"), 0, -5, "abc", None])
def test_buy_rejects_non_finite_or_non_positive_notional(fake, quotes, bad):
    # NaN used to pass every comparison (cap, buying power) and reach Alpaca.
    with pytest.raises(ToolError):
        buy(notional=bad)
    assert fake.mutations() == []


def test_qty_is_floored_so_fill_never_exceeds_notional(fake, quotes):
    fake.quotes["AAPL"] = 100.1336
    out = buy(notional=300)             # 2.99599… shares: round() gave 3.00 ($300.40)
    assert out["qty"] == 2.99
    assert out["qty"] * 100.1336 <= 300


def test_no_quote_refuses_to_size(fake):
    with pytest.raises(ToolError, match="no live quote"):
        buy("AAPL", 1_000)
    assert fake.mutations() == []


# ---------------------------------------------------------------------------
# place_buy — position count, fresh names/day, pending orders
# ---------------------------------------------------------------------------


def _fill_book(fake, n):
    for i in range(n):
        fake.add_position(f"H{i:02d}", qty=1, avg=100)


def test_max_positions_blocks_new_name_but_not_top_up(fake, quotes):
    _fill_book(fake, LLM_MAX_POSITIONS)
    with pytest.raises(ToolError, match="max positions"):
        buy("AAPL", 1_000)
    fake.quotes["H00"] = 100.0
    assert buy("H00", 1_000)["status"] == "submitted"


def test_unfilled_buy_orders_count_toward_max_positions(fake, quotes):
    _fill_book(fake, LLM_MAX_POSITIONS - 1)
    fake.add_order("XYZ", "buy", qty=5)      # a new name being opened, not yet filled
    with pytest.raises(ToolError, match="max positions"):
        buy("AAPL", 1_000)


def test_open_buy_order_on_unheld_name_is_still_a_fresh_name(fake, quotes):
    # A working buy order the bot didn't place today (stale order, placed in
    # the Alpaca UI, ...) must not turn a brand-new name into a "top-up" that
    # skips the fresh-names/day cap.
    buy("AAPL")
    buy("MSFT")
    fake.add_order("XYZ", "buy", qty=5)
    with pytest.raises(ToolError, match="new positions today"):
        buy("XYZ")


def test_open_buy_order_on_unheld_name_cannot_exceed_max_positions(fake, quotes):
    _fill_book(fake, LLM_MAX_POSITIONS)
    fake.add_order("XYZ", "buy", qty=5)
    with pytest.raises(ToolError, match="max positions"):
        buy("XYZ")                            # would be position #26


def test_open_buy_order_on_unheld_name_can_fill_last_slot(fake, quotes):
    _fill_book(fake, LLM_MAX_POSITIONS - 1)
    fake.add_order("XYZ", "buy", qty=5)       # XYZ is the 25th name either way
    assert buy("XYZ", 1_000)["status"] == "submitted"


def test_same_turn_rebuy_of_todays_name_is_not_a_second_fresh_name(fake, quotes):
    fake.leave_orders_open = True
    buy("AAPL", 2_000)
    buy("MSFT", 2_000)
    assert buy("AAPL", 1_000)["status"] == "submitted"   # AAPL already counted today


def test_same_turn_double_buy_counts_unfilled_order(fake, quotes):
    # Both calls run back-to-back inside one model turn; the first market
    # order hasn't filled into a position when the second is checked.
    fake.leave_orders_open = True
    assert buy("AAPL", 3_000)["status"] == "submitted"
    with pytest.raises(ToolError, match="unfilled buy orders"):
        buy("AAPL", 3_000)                    # would be $6,000 > $5,000
    assert buy("AAPL", 2_000)["status"] == "submitted"   # exactly at the cap


def test_same_turn_double_buy_blocked_in_dry_run_too(fake, quotes, monkeypatch):
    monkeypatch.setattr(settings, "dry_run", True)
    buy("AAPL", 3_000)
    with pytest.raises(ToolError, match="would make it"):
        buy("AAPL", 3_000)


def test_fresh_name_cap_two_per_day(fake, quotes):
    buy("AAPL")
    buy("MSFT")
    with pytest.raises(ToolError, match="new positions today"):
        buy("NVDA")


def test_fresh_name_cap_one_per_day_in_risk_off(fake, quotes, regime):
    regime["label"] = "risk_off"
    buy("AAPL")
    with pytest.raises(ToolError, match="caps fresh names at 1/day"):
        buy("MSFT")


def test_top_ups_do_not_count_as_fresh_names(fake, quotes):
    fake.add_position("DIS", qty=10, avg=100)
    add_position_row("DIS", opened_days_ago=20)   # held since before today
    buy("DIS", 500)
    buy("AAPL")
    buy("MSFT")                                   # 2 fresh names, DIS doesn't count
    with pytest.raises(ToolError, match="new positions today"):
        buy("NVDA")


def test_reentry_into_previously_traded_name_counts_as_fresh(fake, quotes):
    # PFE was bought and stopped out a month ago. Re-entering today is a new
    # position. The old "any Trade row before today" proxy treated it as a
    # top-up, so the 2/day cap silently grew with trade history.
    add_trade("PFE", "buy", days_ago=40)
    add_trade("PFE", "sell", days_ago=30)
    buy("PFE")
    buy("DIS")
    with pytest.raises(ToolError, match="already opened 2 new positions"):
        buy("MSFT")


# ---------------------------------------------------------------------------
# place_buy — wash window, earnings blackout, thesis, session
# ---------------------------------------------------------------------------


def test_wash_window_blocks_rebuy_after_recent_sell(fake, quotes):
    add_trade("AAPL", "sell", days_ago=2)
    with pytest.raises(ToolError, match="wash window"):
        buy("AAPL")
    assert fake.mutations() == []


def test_wash_window_expires(fake, quotes):
    add_trade("AAPL", "sell", days_ago=4)
    assert buy("AAPL")["status"] == "submitted"


def _earnings(ticker, days_ahead, hour=0):
    day = utcnow().replace(hour=hour, minute=0, second=0, microsecond=0) + timedelta(days=days_ahead)
    with SessionLocal.begin() as s:
        s.add(EarningsCalendar(ticker=ticker, report_date=day))


def test_earnings_blackout_blocks_report_tomorrow(fake, quotes):
    _earnings("AAPL", 1)
    with pytest.raises(ToolError, match="earnings blackout"):
        buy("AAPL")


def test_earnings_blackout_covers_day_plus_two_late_stamp(fake, quotes):
    # Calendar rows carried the refresh job's time-of-day (~22:00 UTC); the
    # old `<= now + 2d` bound let a morning execute buy into a day+2 report.
    _earnings("AAPL", 2, hour=23)
    with pytest.raises(ToolError, match="earnings blackout"):
        buy("AAPL")


def test_earnings_outside_blackout_allowed(fake, quotes):
    _earnings("AAPL", 4)
    assert buy("AAPL")["status"] == "submitted"


def test_short_thesis_rejected(fake, quotes):
    with pytest.raises(ToolError, match="too-short"):
        buy(thesis="too short")


def test_whitespace_padded_thesis_rejected(fake, quotes):
    with pytest.raises(ToolError, match="too-short"):
        buy(thesis="x" + " " * 200)


def test_market_closed_rejects_without_side_effects(fake, quotes):
    fake.is_open = False
    with pytest.raises(ToolError, match="market is closed"):
        buy()
    assert fake.mutations() == []
    assert trades() == []


# ---------------------------------------------------------------------------
# place_buy — symbols
# ---------------------------------------------------------------------------


def test_symbol_normalised_to_alpaca_form(fake, quotes):
    out = buy(" brk-b ", 1_000)
    assert out["symbol"] == "BRK.B"
    assert trades()[0].ticker == "BRK.B"
    assert fake.mutations()[0] == ("submit_market", "BRK.B", 10.0, "buy")


def test_symbol_variants_cannot_dodge_wash_window(fake, quotes):
    add_trade("BRK.B", "sell", days_ago=1)
    for variant in ("brk/b", "BRK-B", " BRK.B"):
        with pytest.raises(ToolError, match="wash window"):
            buy(variant)


@pytest.mark.parametrize("bad", ["", "   ", "AAPL; DROP", "AAPL MSFT", "123", "TOOLONGNAME"])
def test_invalid_symbols_rejected(fake, quotes, bad):
    with pytest.raises(ToolError):
        buy(bad)
    assert fake.mutations() == []


# ---------------------------------------------------------------------------
# place_buy — execution, dry-run, best-effort stop, pre-cancel
# ---------------------------------------------------------------------------


def test_live_buy_submits_market_then_10pct_trailing_stop(fake, quotes, memory_dir):
    out = buy("AAPL", 1_000)
    assert fake.mutations() == [
        ("submit_market", "AAPL", 10.0, "buy"),
        ("submit_trailing_stop", "AAPL", 10.0, LLM_TRAILING_STOP_PCT),
    ]
    assert out["status"] == "submitted" and out["stop_order_id"]
    (t,) = trades()
    assert (t.side, t.status, t.dry_run, t.alpaca_order_id) == ("buy", "submitted", False, out["order_id"])
    with SessionLocal() as s:
        d = s.scalars(select(Decision)).one()
    assert d.trade_id == t.id and d.reason == THESIS
    assert "BUY  AAPL" in (memory_dir / "trade_log.md").read_text()


def test_dry_run_buy_never_mutates_broker(fake, quotes, monkeypatch, memory_dir):
    monkeypatch.setattr(settings, "dry_run", True)
    # A held position with a real broker stop, plus a resting sell order: the
    # dry run used to cancel both via the sell-side pre-cancel.
    fake.add_position("AAPL", qty=10, avg=100)
    add_position_row("AAPL", stop_order_id="real-stop")
    fake.add_order("AAPL", "sell", type="trailing_stop", qty=10, oid="real-stop")
    out = buy("AAPL", 1_000)
    assert fake.mutations() == []
    assert out["status"] == "dry_run" and out["order_id"].startswith("DRY-")
    assert [o["id"] for o in fake.orders] == ["real-stop"]
    assert get_position("AAPL").stop_order_id == "real-stop"   # no DRY id written
    (t,) = trades()
    assert t.status == "dry_run" and t.dry_run is True
    assert "BUY  AAPL" in (memory_dir / "trade_log.md").read_text()


def test_trailing_stop_failure_never_rolls_back_parent_buy(fake, quotes):
    fake.stop_error = RuntimeError("fractional orders must be DAY orders")
    out = buy("AAPL", 1_050)
    assert out["status"] == "submitted"
    assert out["stop_order_id"] is None
    assert [c[0] for c in fake.mutations()] == ["submit_market", "submit_trailing_stop"]
    (t,) = trades()
    assert t.alpaca_order_id == out["order_id"] and t.status == "submitted"


def test_buy_cancels_open_sells_first_but_not_buys(fake, quotes):
    sell_id = fake.add_order("AAPL", "sell", type="limit", qty=5)
    buy_id = fake.add_order("AAPL", "buy", type="limit", qty=1)
    other = fake.add_order("MSFT", "sell", type="limit", qty=5)
    buy("AAPL", 1_000)
    names = fake.names()
    assert ("cancel_order_by_id", sell_id) in fake.calls
    assert ("cancel_order_by_id", buy_id) not in fake.calls
    assert ("cancel_order_by_id", other) not in fake.calls
    assert names.index("cancel_order_by_id") < names.index("submit_market")


def test_top_up_resizes_stop_to_cover_whole_position(fake, quotes):
    # The sell-side pre-cancel removes the stop on the existing 10 shares;
    # the replacement must cover all 14, not just the 4 being added.
    fake.add_position("AAPL", qty=10, avg=100)
    add_position_row("AAPL", stop_order_id="old-stop")
    fake.add_order("AAPL", "sell", type="trailing_stop", qty=10, oid="old-stop")
    out = buy("AAPL", 400)
    assert ("cancel_order_by_id", "old-stop") in fake.calls
    assert ("submit_trailing_stop", "AAPL", 14.0, LLM_TRAILING_STOP_PCT) in fake.calls
    assert get_position("AAPL").stop_order_id == out["stop_order_id"]


def test_top_up_stop_also_covers_unfilled_buys(fake, quotes):
    # 10 held + 5 still being bought (its stop was just pre-cancelled) + 4 now.
    fake.add_position("AAPL", qty=10, avg=100)
    fake.add_order("AAPL", "buy", qty=5)
    buy("AAPL", 400)
    assert ("submit_trailing_stop", "AAPL", 19.0, LLM_TRAILING_STOP_PCT) in fake.calls


def test_same_turn_second_buy_stop_covers_both_buys(fake, quotes):
    fake.leave_orders_open = True
    buy("AAPL", 2_000)                        # 20 sh, stop for 20
    buy("AAPL", 2_000)                        # pre-cancel kills that stop
    stops = [c for c in fake.calls if c[0] == "submit_trailing_stop"]
    assert stops[-1] == ("submit_trailing_stop", "AAPL", 40.0, LLM_TRAILING_STOP_PCT)


def test_top_up_keeps_a_tightened_trail(fake, quotes):
    # Midday tightened this winner to 7%; a top-up must not reset it to 10%.
    fake.add_position("AAPL", qty=10, avg=100)
    add_position_row("AAPL", stop_order_id="old-stop", trail_pct=0.07)
    fake.add_order("AAPL", "sell", type="trailing_stop", qty=10, oid="old-stop")
    buy("AAPL", 400)
    assert ("submit_trailing_stop", "AAPL", 14.0, 0.07) in fake.calls


# ---------------------------------------------------------------------------
# place_sell
# ---------------------------------------------------------------------------


def test_sell_requires_a_position(fake, quotes):
    with pytest.raises(ToolError, match="no position"):
        sell("AAPL")


@pytest.mark.parametrize("bad", [11, 0, -1, "nan", float("nan"), "half"])
def test_sell_qty_must_be_within_position(fake, quotes, bad):
    fake.add_position("AAPL", qty=10, avg=100)
    with pytest.raises(ToolError):
        sell("AAPL", qty=bad)
    assert fake.mutations() == []


def test_sell_all_sells_live_qty(fake, quotes):
    fake.add_position("AAPL", qty=7.25, avg=100)
    out = sell("AAPL")
    assert out["qty"] == 7.25
    assert ("submit_market", "AAPL", 7.25, "sell") in fake.calls


def test_sell_wash_window(fake, quotes):
    fake.add_position("AAPL", qty=10, avg=100)
    add_trade("AAPL", "buy", days_ago=1)
    with pytest.raises(ToolError, match="wash window"):
        sell("AAPL")


def test_sell_short_reason_rejected(fake, quotes):
    fake.add_position("AAPL", qty=10, avg=100)
    with pytest.raises(ToolError, match="too-short"):
        sell("AAPL", reason="stop hit")


def test_sell_cancels_open_buys_and_recorded_stop_before_submitting(fake, quotes):
    fake.add_position("AAPL", qty=10, avg=100)
    add_position_row("AAPL", stop_order_id="stop-1")
    fake.add_order("AAPL", "sell", type="trailing_stop", qty=10, oid="stop-1")
    buy_id = fake.add_order("AAPL", "buy", type="limit", qty=2)
    other = fake.add_order("MSFT", "buy", type="limit", qty=2)
    sell("AAPL")
    muts = fake.mutations()
    assert muts[-1][0] == "submit_market"
    assert ("cancel_order_by_id", buy_id) in muts[:-1]
    assert ("cancel_order_by_id", "stop-1") in muts[:-1]
    assert ("cancel_order_by_id", other) not in muts
    assert get_position("AAPL").stop_order_id is None


def test_sell_cancels_every_open_sell_including_split_stops(fake, quotes):
    # Sync records only the first of two stops (10 + 4 shares). Cancelling
    # only that one left the 4-share stop holding shares, and the 14-share
    # sell was rejected for insufficient qty — the midday cut failed.
    fake.add_position("AAPL", qty=14, avg=100)
    add_position_row("AAPL", stop_order_id="s10")
    fake.add_order("AAPL", "sell", type="trailing_stop", qty=10, oid="s10")
    fake.add_order("AAPL", "sell", type="trailing_stop", qty=4, oid="s4")
    sell("AAPL")
    muts = fake.mutations()
    assert muts[-1] == ("submit_market", "AAPL", 14.0, "sell")
    assert {("cancel_order_by_id", "s10"), ("cancel_order_by_id", "s4")} <= set(muts[:-1])


def test_sell_cancels_unrecorded_partial_stop(fake, quotes):
    # Partial coverage → sync leaves stop_order_id None; the stop still
    # holds 4 shares and must be cancelled before selling all 10.
    fake.add_position("AAPL", qty=10, avg=100)
    add_position_row("AAPL")
    fake.add_order("AAPL", "sell", type="trailing_stop", qty=4, oid="s4")
    sell("AAPL")
    muts = fake.mutations()
    assert ("cancel_order_by_id", "s4") in muts[:-1]
    assert muts[-1] == ("submit_market", "AAPL", 10.0, "sell")


def _index(calls, call):
    return max(i for i, c in enumerate(calls) if c == call)


def test_sell_waits_for_async_cancel_before_submitting(fake, quotes):
    fake.add_position("AAPL", qty=10, avg=100)
    fake.add_order("AAPL", "sell", type="trailing_stop", qty=10, oid="s1")
    fake.cancel_lag["s1"] = 2                 # pending_cancel for two polls
    sell("AAPL")
    assert fake.order_info["s1"]["status"] == "canceled"
    assert _index(fake.calls, ("order_by_id", "s1")) < fake.names().index("submit_market")


def test_sell_when_stop_fires_during_cancel_submits_nothing(fake, quotes):
    fake.add_position("AAPL", qty=10, avg=100)
    fake.add_order("AAPL", "sell", type="trailing_stop", qty=10, oid="s1")
    fake.fill_on_cancel.add("s1")
    with pytest.raises(ToolError, match="closed"):
        sell("AAPL")
    assert "submit_market" not in fake.names()


def test_sell_all_sells_only_shares_freed_when_a_cancel_never_confirms(fake, quotes):
    fake.add_position("AAPL", qty=10, avg=100)
    fake.add_order("AAPL", "sell", type="trailing_stop", qty=4, oid="stuck")
    fake.cancel_lag["stuck"] = 10**6
    out = sell("AAPL")
    assert out["qty"] == 6.0
    assert fake.mutations()[-1] == ("submit_market", "AAPL", 6.0, "sell")


def test_dry_run_sell_never_mutates_broker(fake, quotes, monkeypatch):
    monkeypatch.setattr(settings, "dry_run", True)
    fake.add_position("AAPL", qty=10, avg=100)
    add_position_row("AAPL", stop_order_id="stop-1")
    fake.add_order("AAPL", "sell", type="trailing_stop", qty=10, oid="stop-1")
    fake.add_order("AAPL", "buy", type="limit", qty=2)
    out = sell("AAPL")
    assert fake.mutations() == []
    assert out["status"] == "dry_run" and out["order_id"].startswith("DRY-")
    assert get_position("AAPL").stop_order_id == "stop-1"
    assert trades()[0].status == "dry_run"


def test_sell_price_falls_back_to_position_mark(fake):
    fake.add_position("AAPL", qty=10, avg=100, price=93.0)
    fake.quotes.clear()
    sell("AAPL")
    (t,) = trades()
    assert t.price == 93.0 and t.notional == pytest.approx(930.0)


# ---------------------------------------------------------------------------
# set_trailing_stop / cancel_order
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("trail", [0.02, 0.30, "nan", -0.1])
def test_trailing_stop_range_enforced(fake, quotes, trail):
    fake.add_position("AAPL", qty=10, avg=100)
    with pytest.raises(ToolError):
        tools._h_set_trailing_stop({"symbol": "AAPL", "trail_percent": trail})
    assert fake.mutations() == []


def test_trailing_stop_requires_position(fake, quotes):
    with pytest.raises(ToolError, match="no open position"):
        tools._h_set_trailing_stop({"symbol": "AAPL", "trail_percent": 0.07})


def test_dry_run_set_trailing_stop_leaves_real_stop_alone(fake, quotes, monkeypatch):
    monkeypatch.setattr(settings, "dry_run", True)
    fake.add_position("AAPL", qty=10, avg=100)
    add_position_row("AAPL", stop_order_id="real-stop")
    fake.add_order("AAPL", "sell", type="trailing_stop", qty=10, oid="real-stop")
    out = tools._h_set_trailing_stop({"symbol": "AAPL", "trail_percent": 0.07})
    assert out["mode"] == "dry_run"
    assert fake.mutations() == []
    row = get_position("AAPL")
    assert row.stop_order_id == "real-stop" and row.trail_pct is None


def test_fractional_rejection_records_synthetic_trail_even_before_sync(fake, quotes):
    # Position opened minutes ago: the 5-min sync hasn't created its row yet.
    # The synthetic trail used to be dropped while the tool reported success.
    fake.add_position("AAPL", qty=10.5, avg=100)
    fake.stop_error = RuntimeError("fractional orders must be DAY orders")
    out = tools._h_set_trailing_stop({"symbol": "AAPL", "trail_percent": 0.07})
    assert out["mode"] == "synthetic"
    row = get_position("AAPL")
    assert row is not None and row.trail_pct == 0.07 and row.stop_order_id is None


def test_broker_stop_replaces_prior_and_is_recorded(fake, quotes):
    fake.add_position("AAPL", qty=10, avg=100)
    add_position_row("AAPL", stop_order_id="old-stop")
    fake.add_order("AAPL", "sell", type="trailing_stop", qty=10, oid="old-stop")
    out = tools._h_set_trailing_stop({"symbol": "AAPL", "trail_percent": 0.07})
    assert out["mode"] == "broker"
    assert ("cancel_order_by_id", "old-stop") in fake.calls
    assert ("submit_trailing_stop", "AAPL", 10.0, 0.07) in fake.calls
    row = get_position("AAPL")
    assert row.stop_order_id == out["order_id"] and row.trail_pct == 0.07


def test_set_trailing_stop_cancels_every_open_stop_before_replacing(fake, quotes):
    fake.add_position("AAPL", qty=14, avg=100)
    add_position_row("AAPL", stop_order_id="s10")
    fake.add_order("AAPL", "sell", type="trailing_stop", qty=10, oid="s10")
    fake.add_order("AAPL", "sell", type="trailing_stop", qty=4, oid="s4")
    fake.cancel_lag["s4"] = 2
    tools._h_set_trailing_stop({"symbol": "AAPL", "trail_percent": 0.07})
    muts = fake.mutations()
    assert muts[-1] == ("submit_trailing_stop", "AAPL", 14.0, 0.07)
    assert {("cancel_order_by_id", "s10"), ("cancel_order_by_id", "s4")} <= set(muts[:-1])
    assert _index(fake.calls, ("order_by_id", "s4")) < fake.names().index("submit_trailing_stop")


def test_set_trailing_stop_never_cancels_a_working_exit(fake, quotes):
    fake.add_position("AAPL", qty=10, avg=100)
    fake.add_order("AAPL", "sell", type="market", qty=10, oid="exit")
    with pytest.raises(ToolError, match="sell order is working"):
        tools._h_set_trailing_stop({"symbol": "AAPL", "trail_percent": 0.07})
    assert fake.mutations() == []


def test_cancel_order_dry_run_is_a_no_op(fake, monkeypatch):
    monkeypatch.setattr(settings, "dry_run", True)
    fake.add_order("AAPL", "sell", type="trailing_stop", oid="stop-1")
    assert tools._h_cancel_order({"order_id": "stop-1"})["dry_run"] is True
    assert fake.mutations() == []


def test_cancelling_a_recorded_stop_rearms_synthetic_engine(fake):
    add_position_row("AAPL", stop_order_id="stop-1")
    fake.add_order("AAPL", "sell", type="trailing_stop", oid="stop-1")
    assert tools._h_cancel_order({"order_id": "stop-1"})["ok"] is True
    assert get_position("AAPL").stop_order_id is None


# ---------------------------------------------------------------------------
# Memory + read tools
# ---------------------------------------------------------------------------


def test_read_memory_returns_newest_content_cut_at_section(memory_dir):
    body = "".join(f"## 2026-07-{i:02d}\n" + ("old note. " * 400) + "\n" for i in range(1, 29))
    body += "## 2026-10-07\n### Pre-market\nNEWEST ENTRY\n"
    (memory_dir / "research_log.md").write_text(body, encoding="utf-8")
    out = tools._h_read_memory({"name": "research_log"})
    assert out["truncated"] is True and out["total_chars"] == len(body)
    assert out["content"].rstrip().endswith("NEWEST ENTRY")
    assert "## 2026-07-01\n" not in out["content"]
    shown = out["content"].split("]\n\n", 1)[1]
    assert shown.startswith("## ") and len(shown) <= LLM_MEMORY_READ_MAX_CHARS


def test_read_memory_headerless_file_cut_at_line(memory_dir):
    lines = "".join(f"- 2026-07-{i % 28 + 1:02d} | BUY  X{i:04d} qty=1 thesis: {'y' * 150}\n"
                    for i in range(400))
    (memory_dir / "trade_log.md").write_text(lines, encoding="utf-8")
    out = tools._h_read_memory({"name": "trade_log"})
    shown = out["content"].split("]\n\n", 1)[1]
    assert shown.startswith("- 2026-")
    assert shown.endswith(lines.splitlines()[-1] + "\n")


def test_llm_cannot_write_strategy_or_trade_log(memory_dir):
    with pytest.raises(ToolError):
        tools._h_write_memory({"name": "strategy", "content": "new rules"})
    with pytest.raises(ToolError):
        tools._h_append_memory({"name": "trade_log", "content": "- fake BUY"})
    assert tools._h_write_memory({"name": "portfolio", "content": "# book"})["ok"]
    assert tools._h_append_memory({"name": "research_log", "content": "## note"})["ok"]


def test_politician_trades_filters_before_limit():
    with SessionLocal.begin() as s:
        s.add(Signal(ticker="NVDA", kind="politician", source="Nancy Pelosi", direction="buy",
                     amount=1.0, as_of=utcnow() - timedelta(days=20),
                     meta={"politician": "Nancy Pelosi"}))
        for i in range(60):    # 60 newer disclosures by other members
            s.add(Signal(ticker="AAPL", kind="politician", source=f"Member {i}", direction="buy",
                         amount=1.0, as_of=utcnow() - timedelta(hours=i)))
    by_name = tools._h_get_politician_trades({"name": "pelosi"})["trades"]
    by_ticker = tools._h_get_politician_trades({"ticker": "nvda"})["trades"]
    assert [t["ticker"] for t in by_name] == ["NVDA"]
    assert [t["politician"] for t in by_ticker] == ["Nancy Pelosi"]


def _signal(kind, ticker, days_ago, source="X"):
    with SessionLocal.begin() as s:
        s.add(Signal(ticker=ticker, kind=kind, source=source, direction="buy",
                     amount=1.0, as_of=utcnow() - timedelta(days=days_ago)))


def test_13f_signals_visible_by_default_despite_quarterly_filing_dates():
    # 13F rows are dated by the SEC filing (~45 days after quarter end, e.g.
    # Aug 14 for Q2); a 14-day default window hid every one of them.
    _signal("investor", "NVDA", 54, source="Berkshire Hathaway")
    _signal("politician", "AAPL", 5)
    _signal("politician", "MSFT", 30)                  # outside politician default
    by_kind = tools._h_get_recent_signals({"kind": "investor"})["signals"]
    mixed = tools._h_get_recent_signals({})["signals"]
    assert [s["ticker"] for s in by_kind] == ["NVDA"]
    assert sorted(s["ticker"] for s in mixed) == ["AAPL", "NVDA"]


def test_explicit_days_applies_to_every_kind():
    _signal("investor", "NVDA", 54)
    _signal("politician", "AAPL", 30)
    assert tools._h_get_recent_signals({"days": 14})["signals"] == []
    assert len(tools._h_get_recent_signals({"days": 60})["signals"]) == 2


def test_signals_days_clamped_to_schema_range():
    _signal("politician", "AAPL", 0.5)
    _signal("politician", "OLD", 200)
    assert [s["ticker"] for s in tools._h_get_recent_signals({"days": 10**9})["signals"]] == ["AAPL"]
    assert [s["ticker"] for s in tools._h_get_recent_signals({"days": -5})["signals"]] == ["AAPL"]


def _13f(fund, ticker, amount, *, weight, change="add", days_ago=50, period="2026-06-30",
         value_new=None, value_old=None, book_total=None):
    meta = {"weight": weight, "change": change, "period": period,
            "prior_period": "2026-03-31", "investor": fund}
    if value_new is not None:
        meta["value_new"] = value_new
    if value_old is not None:
        meta["value_old"] = value_old
    if book_total is not None:
        meta["book_total"] = book_total
    with SessionLocal.begin() as s:
        s.add(Signal(ticker=ticker, kind="investor", source=fund, direction="buy",
                     amount=amount, as_of=utcnow() - timedelta(days=days_ago), meta=meta))


def test_13f_rows_carry_change_weight_and_period():
    _13f("Berkshire Hathaway", "GOOGL", 4.3e9, weight=2.0, change="new")
    (row,) = tools._h_get_recent_signals({"kind": "investor"})["signals"]
    assert (row["change"], row["weight"], row["period"]) == ("new", 2.0, "2026-06-30")


def test_multistrat_funds_cannot_crowd_out_13f_results():
    # A multi-strat files ~100 rebalances per quarter, all newer than
    # Berkshire's one conviction buy; newest-first + LIMIT showed only them.
    for i in range(10):
        _13f("Citadel Advisors", f"C{i}", 50e6, weight=0.8, days_ago=40 - i * 0.1)
    _13f("Berkshire Hathaway", "GOOGL", 30e6, weight=2.0, days_ago=55)
    _13f("Third Point", "AMZN", 10e6, weight=1.3, days_ago=60)
    rows = tools._h_get_recent_signals({"kind": "investor"})["signals"]
    assert [r["source"] for r in rows] == [
        "Berkshire Hathaway", "Third Point", "Citadel Advisors", "Citadel Advisors"]
    assert rows[0]["ticker"] == "GOOGL"


def test_13f_ranked_by_conviction_not_dollar_size():
    # A multi-strat's $200M rebalance (0.8) is a rounding error on a ~$50B
    # book; Duquesne's $40M initiation (1.6) is its whole move. Dollar
    # ranking (0.8 x 200M > 1.6 x 40M) put the rebalance first.
    _13f("Citadel Advisors", "MSFT", 200e6, weight=0.8, value_old=1.8e9, value_new=2.0e9, days_ago=40)
    for i in range(20):
        _13f("Citadel Advisors", f"C{i}", 5e6, weight=0.8, value_old=2.4e9, value_new=2.4e9, days_ago=41)
    _13f("Stanley Druckenmiller", "NVDA", 40e6, weight=1.6, change="new",
         value_old=0, value_new=40e6, days_ago=55)
    rows = tools._h_get_recent_signals({"kind": "investor"})["signals"]
    assert (rows[0]["source"], rows[0]["ticker"]) == ("Stanley Druckenmiller", "NVDA")


def test_13f_book_spans_the_whole_window_under_a_ticker_filter():
    # With ticker="NVDA" the matching rows are one per fund. Approximating
    # each book from only those rows would make Citadel's $200M NVDA add
    # look like 100% of its book and rank it above Fund Z's half-of-book add.
    _13f("Citadel Advisors", "NVDA", 200e6, weight=0.8, value_old=0, value_new=200e6, days_ago=40)
    for i in range(20):
        _13f("Citadel Advisors", f"C{i}", 5e6, weight=0.8, value_old=2.4e9, value_new=2.4e9, days_ago=41)
    _13f("Fund Z", "NVDA", 30e6, weight=1.0, value_old=30e6, value_new=60e6, days_ago=50)
    rows = tools._h_get_recent_signals({"kind": "investor", "ticker": "NVDA"})["signals"]
    assert [r["source"] for r in rows] == ["Fund Z", "Citadel Advisors"]


def test_13f_new_and_exit_rank_above_add_trim_at_similar_conviction():
    # Same weight; the add is 50% of its book, the initiation ~45% — close
    # enough that the initiation should lead.
    _13f("Fund A", "AAPL", 50e6, weight=1.0, value_old=50e6, value_new=100e6, days_ago=40)
    _13f("Fund B", "NVDA", 50e6, weight=1.0, change="new", value_old=0, value_new=50e6, days_ago=50)
    _13f("Fund B", "META", 1e6, weight=1.0, value_old=59e6, value_new=60e6, days_ago=50)
    rows = tools._h_get_recent_signals({"kind": "investor"})["signals"]
    assert [r["ticker"] for r in rows][:2] == ["NVDA", "AAPL"]


def test_13f_much_stronger_add_still_beats_a_weak_initiation():
    _13f("Fund A", "AAPL", 100e6, weight=1.0, value_old=0.1, value_new=100e6, days_ago=40)
    _13f("Fund B", "NVDA", 10e6, weight=1.0, change="new", value_old=0, value_new=10e6, days_ago=50)
    _13f("Fund B", "META", 1e6, weight=1.0, value_old=39e6, value_new=40e6, days_ago=50)
    rows = tools._h_get_recent_signals({"kind": "investor"})["signals"]
    assert [r["ticker"] for r in rows][0] == "AAPL"


def test_13f_uses_reported_book_total_when_present():
    _13f("Fund X", "AAPL", 50e6, weight=1.0, value_old=10e6, value_new=60e6, book_total=10e9, days_ago=40)
    _13f("Fund Y", "MSFT", 5e6, weight=1.0, value_old=1e6, value_new=6e6, days_ago=50)
    rows = tools._h_get_recent_signals({"kind": "investor"})["signals"]
    assert [r["ticker"] for r in rows] == ["MSFT", "AAPL"]


def test_mixed_query_keeps_both_kinds_visible():
    for i in range(10):
        _signal("politician", f"P{i}", i * 0.1)
    _13f("Berkshire Hathaway", "GOOGL", 30e6, weight=2.0)
    rows = tools._h_get_recent_signals({})["signals"]
    kinds = [r["kind"] for r in rows]
    assert "investor" in kinds and "politician" in kinds
    assert len(rows) <= LLM_MAX_TOOL_RESULT_SIGNALS


def test_signals_tool_documents_per_kind_windows():
    d = tools.REGISTRY["get_recent_signals"].definition
    assert "120" in d["description"] and "14" in d["description"]
    assert d["input_schema"]["properties"]["days"]["maximum"] >= 120


def test_upcoming_earnings_surprise_is_reported_in_percent():
    today = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    with SessionLocal.begin() as s:
        s.add(EarningsCalendar(ticker="AAPL", report_date=today + timedelta(days=3)))
        s.add(EarningsHistory(ticker="AAPL", quarter="2026-Q2", surprise_pct=0.045))
        s.add(EarningsHistory(ticker="AAPL", quarter="2026-Q1", surprise_pct=-0.012))
        s.add(EarningsHistory(ticker="AAPL", quarter="2025-Q4", surprise_pct=None))
    (ev,) = tools._h_get_upcoming_earnings({"days": 7})["events"]
    assert ev["last_4_eps_surprise_pct"] == [4.5, -1.2, None]
    assert "last_4_surprise_pcts" not in ev            # no ambiguous fraction field
    desc = tools.REGISTRY["get_upcoming_earnings"].definition["description"]
    assert "last_4_eps_surprise_pct" in desc and "4.5 = " in desc


def test_signals_limit_cannot_go_unbounded():
    with SessionLocal.begin() as s:
        for i in range(30):
            s.add(Signal(ticker="AAPL", kind="politician", source=f"P{i}",
                         direction="buy", amount=1.0, as_of=utcnow()))
    out = tools._h_get_recent_signals({"limit": -1})   # SQLite: LIMIT -1 = no limit
    assert 1 <= len(out["signals"]) <= LLM_MAX_TOOL_RESULT_SIGNALS
