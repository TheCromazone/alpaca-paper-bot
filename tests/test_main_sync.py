"""bot/main.py: the 5-min sync (broker-stop reconciliation, synthetic
trailing stop), fill reconciliation, scheduler wiring and the holiday gate."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from bot import main as bot_main
from bot.config import settings
from bot.db import Decision, JobRun, Position, SessionLocal, Trade
from tests.conftest import FakeAlpaca, utcnow
from tests.test_tools_trust_boundary import add_position_row, get_position


def sync(fa):
    bot_main._sync_account_and_positions(fa)


def sells(fa):
    return [c for c in fa.calls if c[0] == "submit_market" and c[3] == "sell"]


@pytest.fixture
def fa():
    f = FakeAlpaca()
    f.quotes["SPY"] = 500.0
    return f


def armed_drop(fa, *, stop_order_id=None, price=85.0):
    """A position that peaked at $100, is now down 15%, armed long ago."""
    fa.add_position("AAPL", qty=10, avg=95, price=price)
    add_position_row("AAPL", opened_days_ago=3, peak=100.0, stop_order_id=stop_order_id)


# ---------------------------------------------------------------------------
# Synthetic trailing stop
# ---------------------------------------------------------------------------


def test_synthetic_stop_fires_on_10pct_drop_from_peak(fa):
    armed_drop(fa)
    sync(fa)
    assert sells(fa) == [("submit_market", "AAPL", 10.0, "sell")]
    with SessionLocal() as s:
        t = s.scalars(select(Trade)).one()
        d = s.scalars(select(Decision)).one()
    assert t.side == "sell" and d.trade_id == t.id
    assert d.score_breakdown == {"kind": "synthetic_trailing_stop"}


def test_synthetic_stop_respects_tightened_trail(fa):
    fa.add_position("AAPL", qty=10, avg=95, price=92.0)          # -8% from peak
    add_position_row("AAPL", opened_days_ago=3, peak=100.0, trail_pct=0.07)
    sync(fa)
    assert len(sells(fa)) == 1


def test_synthetic_stop_not_armed_for_new_position(fa):
    fa.add_position("AAPL", qty=10, avg=100, price=85.0)         # no local row yet
    sync(fa)
    assert sells(fa) == []
    assert get_position("AAPL") is not None


def test_synthetic_stop_does_not_stack_on_working_sell(fa):
    # midday's place_sell (or our own queued after-hours sell from the last
    # cycle) is already working on the symbol.
    armed_drop(fa)
    fa.add_order("AAPL", "sell", type="market", qty=10, oid="midday-sell")
    sync(fa)
    assert sells(fa) == []
    assert ("cancel_order_by_id", "midday-sell") not in fa.calls


def test_synthetic_stop_fires_once_across_cycles_while_order_queued(fa):
    armed_drop(fa)
    fa.leave_orders_open = True           # e.g. fired after hours, queued for the open
    sync(fa)
    sync(fa)
    sync(fa)
    assert len(sells(fa)) == 1


def test_unrecorded_broker_stop_is_adopted_and_disarms_synthetic(fa):
    # place_buy runs before the sync creates the row, so a new name's broker
    # stop id was never recorded; the synthetic engine then raced it.
    armed_drop(fa)
    fa.add_order("AAPL", "sell", type="trailing_stop", qty=10, oid="broker-stop")
    sync(fa)
    assert get_position("AAPL").stop_order_id == "broker-stop"
    assert sells(fa) == []


def test_partial_broker_stop_does_not_count_as_protection(fa):
    # A trailing stop for 4 of 10 shares (e.g. one sized before a top-up)
    # must not disarm the synthetic stop for the whole position.
    armed_drop(fa)
    fa.add_order("AAPL", "sell", type="trailing_stop", qty=4, oid="partial-stop")
    sync(fa)
    assert get_position("AAPL").stop_order_id is None
    muts = fa.mutations()
    assert ("cancel_order_by_id", "partial-stop") in muts     # frees the held shares
    assert muts[-1] == ("submit_market", "AAPL", 10.0, "sell")


def _last(calls, call):
    return max(i for i, c in enumerate(calls) if c == call)


def test_synthetic_waits_for_cancel_to_land_before_selling(fa):
    # Alpaca cancels are async: selling while the stop is pending_cancel got
    # rejected (shares still held) and delayed the exit by a full cycle.
    armed_drop(fa)
    fa.add_order("AAPL", "sell", type="trailing_stop", qty=4, oid="partial")
    fa.cancel_lag["partial"] = 2
    sync(fa)
    sell_i = fa.names().index("submit_market")
    assert _last(fa.calls, ("order_by_id", "partial")) < sell_i
    assert fa.calls[sell_i] == ("submit_market", "AAPL", 10.0, "sell")


def test_synthetic_rechecks_qty_when_stop_fills_instead_of_cancelling(fa):
    armed_drop(fa)
    fa.add_order("AAPL", "sell", type="trailing_stop", qty=4, oid="partial")
    fa.fill_on_cancel.add("partial")          # fired before the cancel landed
    sync(fa)
    assert sells(fa) == [("submit_market", "AAPL", 6.0, "sell")]


def test_synthetic_submits_nothing_when_resting_order_closed_position(fa):
    armed_drop(fa)
    fa.add_order("AAPL", "sell", type="limit", qty=10, oid="tp")
    fa.fill_on_cancel.add("tp")
    sync(fa)
    assert sells(fa) == []


def test_synthetic_sells_only_free_qty_when_cancel_never_confirms(fa):
    armed_drop(fa)
    fa.add_order("AAPL", "sell", type="trailing_stop", qty=4, oid="stuck")
    fa.cancel_lag["stuck"] = 10**6
    sync(fa)
    assert sells(fa) == [("submit_market", "AAPL", 6.0, "sell")]


def test_stops_covering_full_qty_count_as_protection(fa):
    armed_drop(fa)
    fa.add_order("AAPL", "sell", type="trailing_stop", qty=6, oid="s1")
    fa.add_order("AAPL", "sell", type="trailing_stop", qty=4, oid="s2")
    sync(fa)
    assert get_position("AAPL").stop_order_id in {"s1", "s2"}
    assert sells(fa) == []


@pytest.mark.parametrize("stale", ["cancelled-elsewhere", "DRY-STOP-1234abcd"])
def test_stale_stop_id_cleared_and_synthetic_rearmed(fa, stale):
    # A manual dashboard buy or the LLM's cancel_order killed the broker stop,
    # or a dry-run left a fake id: either way the row claimed a stop that
    # didn't exist, which disarmed the synthetic engine permanently.
    armed_drop(fa, stop_order_id=stale)
    sync(fa)
    assert get_position("AAPL").stop_order_id is None
    assert len(sells(fa)) == 1


def test_resting_limit_sell_is_cancelled_before_synthetic_exit(fa):
    armed_drop(fa)
    fa.add_order("AAPL", "sell", type="limit", qty=10, oid="take-profit")
    fa.add_order("AAPL", "buy", type="limit", qty=2, oid="dip-add")
    sync(fa)
    muts = fa.mutations()
    assert ("cancel_order_by_id", "take-profit") in muts
    assert ("cancel_order_by_id", "dip-add") in muts
    assert muts[-1] == ("submit_market", "AAPL", 10.0, "sell")


def test_no_synthetic_sells_in_dry_run(fa, monkeypatch):
    monkeypatch.setattr(settings, "dry_run", True)
    armed_drop(fa)
    sync(fa)
    assert fa.mutations() == []


def test_spy_quote_failure_does_not_abort_sync(fa):
    armed_drop(fa)

    def quotes(symbols):
        raise RuntimeError("IEX 503")
    fa.latest_quotes = quotes
    sync(fa)
    assert get_position("AAPL").market_price == 85.0
    assert len(sells(fa)) == 1


def test_open_orders_failure_skips_stops_but_still_syncs(fa):
    armed_drop(fa, stop_order_id="keep-me")

    def broken():
        raise ConnectionError("reset")
    fa.open_orders = broken
    sync(fa)
    row = get_position("AAPL")
    assert row.market_price == 85.0 and row.stop_order_id == "keep-me"
    assert sells(fa) == []


def test_closed_positions_removed(fa):
    add_position_row("GONE")
    sync(fa)
    assert get_position("GONE") is None


# ---------------------------------------------------------------------------
# Fill reconciliation
# ---------------------------------------------------------------------------


def _submitted(order_id, qty=10.0):
    with SessionLocal.begin() as s:
        s.add(Trade(ticker="AAPL", side="buy", qty=qty, price=100.0, notional=qty * 100,
                    status="submitted", alpaca_order_id=order_id, dry_run=False))


def _trade():
    with SessionLocal() as s:
        return s.scalars(select(Trade)).one()


def test_reconcile_marks_fills(fa):
    _submitted("o1")
    fa.order_info["o1"] = {"status": "filled", "filled_qty": 10.0,
                           "filled_avg_price": 101.0, "filled_at": utcnow()}
    bot_main._reconcile_trade_fills(fa)
    t = _trade()
    assert (t.status, t.price, t.notional) == ("filled", 101.0, 1010.0)


def test_reconcile_partial_fill_then_expired_books_filled_part(fa):
    _submitted("o1")
    fa.order_info["o1"] = {"status": "expired", "filled_qty": 4.0,
                           "filled_avg_price": 99.0, "filled_at": None}
    bot_main._reconcile_trade_fills(fa)
    t = _trade()
    assert (t.status, t.qty, t.price) == ("filled", 4.0, 99.0)


def test_reconcile_dead_without_fill_is_canceled(fa):
    _submitted("o1")
    fa.order_info["o1"] = {"status": "canceled", "filled_qty": 0.0,
                           "filled_avg_price": 0.0, "filled_at": None}
    bot_main._reconcile_trade_fills(fa)
    assert _trade().status == "canceled"


# ---------------------------------------------------------------------------
# Scheduler wiring
# ---------------------------------------------------------------------------


def _jobs():
    sched = bot_main.build_scheduler()
    return sched, {j.id: j for j in sched.get_jobs()}


def test_llm_routines_tolerate_late_start():
    # APScheduler's default grace is 1s: waking from sleep at 09:30:03 used
    # to drop the day's only buy window silently.
    sched, jobs = _jobs()
    for jid in ("llm_premarket", "llm_execute", "llm_midday", "llm_close", "llm_weekly_review"):
        assert jobs[jid].misfire_grace_time >= 900, jid
    assert sched._job_defaults["misfire_grace_time"] >= 60


@pytest.mark.parametrize("job_id, winter_utc, summer_utc", [
    ("price_refresh", (21, 30), (20, 30)),   # 16:30 ET — after the close all year
    ("regime", (22, 20), (21, 20)),          # 17:20 ET — after the price refresh
    ("llm_execute", (14, 30), (13, 30)),     # 09:30 ET
])
def test_close_anchored_jobs_track_new_york_time(job_id, winter_utc, summer_utc):
    _, jobs = _jobs()
    trig = jobs[job_id].trigger
    winter = trig.get_next_fire_time(None, datetime(2027, 1, 12, 12, 0, tzinfo=timezone.utc))
    summer = trig.get_next_fire_time(None, datetime(2027, 7, 13, 12, 0, tzinfo=timezone.utc))
    assert (winter.astimezone(timezone.utc).hour, winter.minute) == winter_utc
    assert (summer.astimezone(timezone.utc).hour, summer.minute) == summer_utc


def test_regime_never_collides_with_earnings_refresh():
    # The earnings refresh holds one long SQLite write transaction; a regime
    # insert in the same minute could fail "database is locked", leaving a
    # stale regime label (and risk_off halving not engaging).
    _, jobs = _jobs()
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    for job_id in ("regime", "earnings"):
        assert job_id in jobs
    regime_times, earnings_times = set(), set()
    for jid, acc in (("regime", regime_times), ("earnings", earnings_times)):
        t = start
        for _ in range(400):
            t = jobs[jid].trigger.get_next_fire_time(None, t + timedelta(seconds=1))
            acc.add(t.astimezone(timezone.utc).replace(second=0, microsecond=0))
    assert not (regime_times & earnings_times)


def test_db_waits_for_locks_instead_of_failing():
    from bot.db import engine

    with engine.connect() as conn:
        assert conn.exec_driver_sql("PRAGMA busy_timeout").scalar() >= 30_000
        assert conn.exec_driver_sql("PRAGMA journal_mode").scalar().lower() == "wal"


def test_missed_run_is_recorded_for_the_dashboard():
    from apscheduler.events import EVENT_JOB_MISSED, JobExecutionEvent

    ev = JobExecutionEvent(EVENT_JOB_MISSED, "llm_execute", "default",
                           datetime(2026, 10, 7, 13, 30, tzinfo=timezone.utc))
    bot_main._on_job_not_run(ev)
    with SessionLocal() as s:
        jr = s.scalars(select(JobRun)).one()
    assert (jr.job_name, jr.status) == ("llm_execute", "missed")


@pytest.mark.parametrize("job_id, expected", [
    ("regime", {"regime_daily"}),
    ("earnings", {"earnings_daily"}),
    ("politicians", {"politicians_daily"}),
    ("senate", {"senate_daily"}),
    ("investors", {"investors_weekly"}),
    ("research", {"news_refresh_offhours", "article_scrape_offhours"}),
    ("sync_account", {"sync_account"}),
    ("price_refresh", {"price_refresh"}),
])
def test_missed_runs_use_the_same_series_names_as_real_runs(job_id, expected):
    from apscheduler.events import EVENT_JOB_MISSED, JobExecutionEvent

    bot_main._on_job_not_run(JobExecutionEvent(
        EVENT_JOB_MISSED, job_id, "default", datetime(2026, 10, 7, 21, 0, tzinfo=timezone.utc)))
    with SessionLocal() as s:
        names = set(s.scalars(select(JobRun.job_name)).all())
    assert names == expected


def test_every_scheduled_job_has_a_series_name():
    _, jobs = _jobs()
    assert set(jobs) <= set(bot_main._JOB_RUN_NAMES)


def test_still_running_previous_instance_is_recorded():
    from apscheduler.events import EVENT_JOB_MAX_INSTANCES, JobSubmissionEvent

    ev = JobSubmissionEvent(EVENT_JOB_MAX_INSTANCES, "sync_account", "default",
                            [datetime(2026, 10, 7, 13, 35, tzinfo=timezone.utc)])
    bot_main._on_job_not_run(ev)
    with SessionLocal() as s:
        jr = s.scalars(select(JobRun)).one()
    assert jr.status == "missed" and "still in progress" in jr.message


# ---------------------------------------------------------------------------
# Holiday gate
# ---------------------------------------------------------------------------


def _freeze(monkeypatch, when: datetime):
    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return when if tz else when.replace(tzinfo=None)
    monkeypatch.setattr(bot_main, "datetime", Frozen)


def test_execute_skipped_on_nyse_holiday(monkeypatch):
    _freeze(monkeypatch, datetime(2026, 12, 25, 14, 30, tzinfo=timezone.utc))
    ran = []
    monkeypatch.setattr(bot_main, "_log_job", lambda name, fn: ran.append(name))
    bot_main._llm_execute()
    assert ran == []
    with SessionLocal() as s:
        jr = s.scalars(select(JobRun)).one()
    assert (jr.job_name, jr.status) == ("llm_execute", "skipped")


def test_execute_runs_on_trading_day(monkeypatch):
    _freeze(monkeypatch, datetime(2026, 10, 7, 13, 30, tzinfo=timezone.utc))
    ran = []
    monkeypatch.setattr(bot_main, "_log_job", lambda name, fn: ran.append(name))
    bot_main._llm_execute()
    assert ran == ["llm_execute"]
