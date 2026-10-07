"""Bot entrypoint. Tick every 5 minutes during market hours."""
from __future__ import annotations

import signal
import sys
from datetime import datetime, timezone, timedelta

import pandas_market_calendars as mcal
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger
from loguru import logger
from sqlalchemy import select as sa_select

from bot.alpaca_client import AlpacaClient, cancel_and_wait, remaining_qty
from bot.config import (
    FIXED_INCOME_UNIVERSE,
    EQUITY_UNIVERSE,
    FULL_UNIVERSE,
    LLM_TRAILING_STOP_PCT,
    MONITOR_EXTRA,
    ROOT,
    settings,
)
from bot.db import (
    Decision,
    JobRun,
    Position,
    PortfolioSnapshot,
    PriceHistory,
    SessionLocal,
    Trade,
    init_db,
)
from bot.executor import execute
from bot.news.article_scraper import scrape_pending
from bot.news.rss_scraper import fetch_all, persist_new
from bot.signals import aggregator
from bot.signals.sentiment import rescore_scraped_articles, score_unscored
from bot.strategy import plan
from bot.signals import earnings as earnings_job
from bot.signals import investors as investor_job
from bot.signals import macro as macro_job
from bot.signals import profiles as profiles_job
from bot.signals import politicians as politician_job
from bot.signals import regime as regime_job
from bot.signals import senate as senate_job


_nyse = mcal.get_calendar("NYSE")


def _is_market_open_now() -> bool:
    now = datetime.now(timezone.utc)
    schedule = _nyse.schedule(start_date=now.date(), end_date=now.date())
    if schedule.empty:
        return False
    open_at = schedule.iloc[0]["market_open"].to_pydatetime()
    close_at = schedule.iloc[0]["market_close"].to_pydatetime()
    return open_at <= now <= close_at


def _is_trading_day() -> bool:
    """True when NYSE trades today (all LLM routines fire 07:00–17:00 ET,
    where the UTC calendar date equals the ET date, so a UTC 'today' is safe)."""
    today = datetime.now(timezone.utc).date()
    return not _nyse.schedule(start_date=today, end_date=today).empty


def _skip_job(name: str, reason: str, status: str = "skipped") -> None:
    """Record a skipped scheduled job so the dashboard's job feed shows the
    routine was considered and deliberately not run (vs. silently missing)."""
    now = datetime.now(timezone.utc)
    with SessionLocal.begin() as s:
        s.add(JobRun(job_name=name, started_at=now, finished_at=now,
                     status=status, message=reason))
    logger.info("{} {}: {}", name, status, reason)


# Scheduler job id -> the JobRun series name(s) its function records via
# _log_job, so a missed run lands in the same dashboard series as real runs.
_JOB_RUN_NAMES: dict[str, tuple[str, ...]] = {
    "price_refresh": ("price_refresh",),
    "research": ("news_refresh_offhours", "article_scrape_offhours"),
    "politicians": ("politicians_daily",),
    "investors": ("investors_weekly",),
    "senate": ("senate_daily",),
    "regime": ("regime_daily",),
    "macro": ("macro_daily",),
    "profiles": ("profiles_weekly",),
    "earnings": ("earnings_daily",),
    "sync_account": ("sync_account",),
    "llm_premarket": ("llm_premarket",),
    "llm_execute": ("llm_execute",),
    "llm_midday": ("llm_midday",),
    "llm_close": ("llm_close",),
    "llm_weekly_review": ("llm_weekly_review",),
}


def _on_job_not_run(event) -> None:
    """APScheduler listener for runs that never started: a misfire (fired
    later than the job's grace window — e.g. the PC woke from sleep, or the
    worker pool was saturated) or a skip because the previous run of the same
    job is still going (max_instances=1 — usually a hung network call).
    APScheduler only logs these as warnings, so a missed execute or a wedged
    sync was invisible on the dashboard. Never raises into the scheduler."""
    try:
        from apscheduler.events import EVENT_JOB_MISSED
        when = getattr(event, "scheduled_run_time", None) or (
            (getattr(event, "scheduled_run_times", None) or [None])[0]
        )
        when_s = when.isoformat() if when else "unknown time"
        if event.code == EVENT_JOB_MISSED:
            reason = f"missed: scheduler fired too late for {when_s}"
        else:
            reason = f"previous run still in progress at {when_s}"
        for name in _JOB_RUN_NAMES.get(event.job_id, (event.job_id,)):
            _skip_job(name, reason, status="missed")
    except Exception:
        logger.exception("could not record missed run for job {}", getattr(event, "job_id", "?"))


def _log_job(name: str, fn):
    started = datetime.now(timezone.utc)
    with SessionLocal.begin() as s:
        jr = JobRun(job_name=name, started_at=started, status="running")
        s.add(jr)
        s.flush()
        jr_id = jr.id
    status, msg = "ok", ""
    try:
        fn()
    except Exception as exc:
        status = "failed"
        msg = repr(exc)
        logger.exception("{} job failed", name)
    finally:
        with SessionLocal.begin() as s:
            jr = s.get(JobRun, jr_id)
            jr.finished_at = datetime.now(timezone.utc)
            jr.status = status
            jr.message = msg


# Order types that will take a long position out on their own — if sell
# orders of these types already cover the position, the synthetic stop must
# not stack another sell on top of them.
_EXITING_ORDER_TYPES = {"market", "stop", "stop_limit", "trailing_stop"}


_remaining_qty = remaining_qty  # unfilled qty of an open-order dict


def _sync_account_and_positions(alpaca: AlpacaClient) -> None:
    acct = alpaca.account()
    # Snapshot portfolio value. The SPY mark is cosmetic (benchmark column);
    # a data-API hiccup here used to abort the whole sync, synthetic stops
    # included.
    try:
        spy_price = alpaca.latest_quotes(["SPY"]).get("SPY")
    except Exception as exc:
        logger.warning("sync: SPY quote failed, snapshot without benchmark: {}", exc)
        spy_price = None
    with SessionLocal.begin() as s:
        s.add(PortfolioSnapshot(
            equity=acct.equity, cash=acct.cash,
            buying_power=acct.buying_power, spy_close=spy_price,
        ))

    live_positions = {p.symbol: p for p in alpaca.positions()}

    # Open orders, fetched once per sync. Used to (a) reconcile which
    # positions really have a live broker-side trailing stop and (b) keep
    # the synthetic stop from stacking a sell on a symbol that already has
    # an exit working. None = unknown: skip both rather than guess.
    try:
        open_orders: list[dict] | None = alpaca.open_orders()
    except Exception as exc:
        logger.warning("sync: open-orders fetch failed; skipping stop reconciliation "
                       "and synthetic stops this cycle: {}", exc)
        open_orders = None
    open_sells: dict[str, list[dict]] = {}
    for o in open_orders or []:
        if (o.get("side") or "").lower() == "sell":
            open_sells.setdefault((o.get("symbol") or "").upper(), []).append(o)

    # Synthetic-stop candidates collected here so we can sell *outside* the
    # `with SessionLocal.begin()` block — submitting an Alpaca order while
    # holding a write transaction risks deadlock if the order callback also
    # touches the DB.
    synthetic_sells: list[tuple[str, float, float, float, float]] = []  # (sym, qty, peak, mkt, trail)
    with SessionLocal.begin() as s:
        existing = {p.ticker: p for p in s.query(Position).all()}
        for sym, lp in live_positions.items():
            row = existing.get(sym)
            if row is None:
                row = Position(
                    ticker=sym, qty=lp.qty, avg_cost=lp.avg_entry_price,
                    market_price=lp.market_price, market_value=lp.market_value,
                    unrealized_pnl=lp.unrealized_pl, peak_price=lp.market_price,
                )
                s.add(row)
                is_new_row = True
            else:
                is_new_row = False
                row.qty = lp.qty
                row.avg_cost = lp.avg_entry_price
                row.market_price = lp.market_price
                row.market_value = lp.market_value
                row.unrealized_pnl = lp.unrealized_pl
                if lp.market_price > (row.peak_price or 0):
                    row.peak_price = lp.market_price
                row.updated_at = datetime.now(timezone.utc)

            # --- Broker-stop reconciliation ---
            # stop_order_id is what disarms the synthetic stop below, so it
            # must reflect a stop that actually exists. It went stale whenever
            # the stop was cancelled by another path (a dashboard manual buy's
            # sell-side pre-cancel, the LLM's cancel_order, a DRY-STOP id from
            # a dry-run), leaving the position with no stop of either kind;
            # and a new name's stop was never recorded at all because place_buy
            # runs before this sync has created the row.
            # A position only counts as broker-protected when its live trailing
            # stops cover the WHOLE quantity: a stop sized before a top-up (or
            # for one lot of several) would otherwise disarm the synthetic stop
            # for the unprotected remainder.
            if open_orders is not None:
                live_stops = [
                    o for o in open_sells.get(sym.upper(), [])
                    if (o.get("type") or "").lower() == "trailing_stop"
                ]
                covered = sum(_remaining_qty(o) for o in live_stops) >= float(lp.qty or 0) - 1e-6
                stop_ids = [o["id"] for o in live_stops]
                if not (covered and stop_ids):
                    row.stop_order_id = None
                elif row.stop_order_id not in stop_ids:
                    row.stop_order_id = stop_ids[0]

            if is_new_row:
                continue

            # --- Synthetic trailing stop (added 2026-05-07) ---
            # Alpaca rejects GTC trailing stops on fractional positions, so
            # the LLM's place_buy auto-stop fails on most buys (13/14 had
            # no stop_order_id as of audit). The midday 7%-from-cost rule
            # is the only safety net, and it can't catch overnight gaps.
            # This synthetic stop fires every 5 min: if the position has
            # no Alpaca-side stop, we drift its peak up with price, and
            # if price falls more than LLM_TRAILING_STOP_PCT below peak,
            # we force-close at market. ~5 min noise window before stop
            # is armed, to avoid flushing fresh entries on a tick wiggle.
            _ARM_AGE_S = 300  # 5 min
            # Per-position trail: set_trailing_stop records trail_pct when
            # the broker rejects a fractional GTC stop (e.g. midday
            # tightening a winner to 7%); default stays 10%.
            trail = row.trail_pct or LLM_TRAILING_STOP_PCT
            if (
                not settings.dry_run
                and not row.stop_order_id
                and lp.market_price > 0
                and (row.peak_price or 0) > 0
                and lp.market_price < (row.peak_price or 0) * (1 - trail)
                and row.opened_at is not None
                and (
                    datetime.now(timezone.utc)
                    - (row.opened_at if row.opened_at.tzinfo else row.opened_at.replace(tzinfo=timezone.utc))
                ).total_seconds() > _ARM_AGE_S
            ):
                synthetic_sells.append(
                    (sym, float(lp.qty or 0), float(row.peak_price or 0), float(lp.market_price), trail)
                )
        # Remove rows that Alpaca no longer reports (fully closed positions).
        for sym in list(existing.keys()):
            if sym not in live_positions:
                s.delete(existing[sym])

    # Fire any synthetic-stop sells outside the DB transaction.
    for sym, qty, peak, mkt, trail in synthetic_sells:
        if open_orders is None:
            break  # can't tell whether an exit is already working; retry next sync
        working = [
            o for o in open_sells.get(sym.upper(), [])
            if (o.get("type") or "").lower() in _EXITING_ORDER_TYPES
        ]
        if working and sum(_remaining_qty(o) for o in working) >= qty - 1e-6:
            # An exit covering the position is already in flight: midday's
            # place_sell racing this sync, our own sell from a previous cycle
            # still queued (e.g. fired after hours, waiting for the open), or
            # an unrecorded broker stop. Stacking a second full-size sell on
            # top of it got rejected for insufficient qty every 5 minutes.
            logger.info(
                "synthetic stop {}: exit already working (order {}); not stacking another sell",
                sym, working[0].get("id"),
            )
            continue
        try:
            # Defensive: pre-cancel every other open order on the symbol —
            # buys (the same wash-trade guard as place_sell), resting
            # non-exit sells such as a limit, and partial exits (a stop or
            # trim covering only part of the position) — all of which hold
            # shares the full-size exit below needs. Cancels are async, so
            # wait (bounded) for Alpaca to confirm: selling while an order
            # is still pending_cancel was rejected and cost a 5-min cycle.
            res = cancel_and_wait(
                alpaca, [o for o in open_orders if (o.get("symbol") or "").upper() == sym.upper()]
            )
            if res["filled"] or res["unresolved"]:
                # Something executed instead of cancelling (e.g. the partial
                # stop fired) or still holds shares: sell only what is free
                # now and let the next sync finish the rest.
                live = next((p for p in alpaca.positions() if p.symbol == sym), None)
                held_by_orders = sum(
                    _remaining_qty(o) for o in res["unresolved"]
                    if (o.get("side") or "").lower() == "sell"
                )
                qty = round(float(live.qty) - held_by_orders, 9) if live else 0.0
                if qty <= 0:
                    logger.info(
                        "synthetic stop {}: nothing free to sell after cancels "
                        "(filled={}, unresolved={})",
                        sym, res["filled"], [o["id"] for o in res["unresolved"]],
                    )
                    continue
            order_id = alpaca.submit_market(sym, qty, "sell")
            drop_pct = (peak - mkt) / peak * 100 if peak else 0
            logger.warning(
                "synthetic trailing stop fired: {} sold {} @ ~${} (peak ${} → {:.2f}% drop). order_id={}",
                sym, qty, mkt, peak, drop_pct, order_id,
            )
            with SessionLocal.begin() as s:
                trade = Trade(
                    ticker=sym, side="sell", qty=qty, price=mkt,
                    notional=qty * mkt, status="submitted", alpaca_order_id=order_id,
                    dry_run=False,
                )
                s.add(trade)
                # Flush to populate trade.id BEFORE creating the Decision, then
                # link via trade_id. Without this the Decision is orphaned and
                # /trades (which reads trade.decisions) shows the sell with no
                # reason — this was the bug that hid every synthetic-stop
                # rationale on the dashboard prior to 2026-06.
                s.flush()
                s.add(Decision(
                    ticker=sym, action="sell", composite_score=0.0,
                    score_breakdown={"kind": "synthetic_trailing_stop"},
                    reason=f"synthetic trailing stop: ${mkt:.2f} fell >{trail:.0%} from peak ${peak:.2f}",
                    dry_run=False,
                    trade_id=trade.id,
                ))
        except Exception as exc:
            logger.exception("synthetic stop for {} failed: {}", sym, exc)

    # Reconcile fills last — best-effort; never fails the sync job.
    try:
        _reconcile_trade_fills(alpaca)
    except Exception as exc:
        logger.warning("trade-fill reconciliation failed: {}", exc)


_RECONCILE_LOOKBACK_DAYS = 60
_RECONCILE_MAX_PER_RUN = 100
# Alpaca terminal statuses that mean "this order will never fill".
_ORDER_DEAD_STATUSES = {"canceled", "expired", "rejected", "done_for_day", "stopped", "suspended"}


def _reconcile_trade_fills(alpaca: AlpacaClient) -> None:
    """Update local Trade rows whose orders have since filled or died.

    Every LLM-era trade was stuck at status='submitted' with filled_at=NULL
    forever because nothing ever asked Alpaca what happened to the order.
    That skews the FIFO realized-P&L analytics (which price entries/exits at
    the submit-time mid rather than the actual fill) and leaves canceled
    orders looking like real trades. Runs inside the 5-min sync job; after
    the first backfill there is at most a handful of open orders to check.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=_RECONCILE_LOOKBACK_DAYS)
    with SessionLocal() as s:
        pending = s.scalars(
            sa_select(Trade)
            .where(Trade.status == "submitted")
            .where(Trade.dry_run == False)  # noqa: E712 — SQLAlchemy needs the comparison
            .where(Trade.submitted_at >= cutoff)
            # Newest first, so a backlog of rows Alpaca can't resolve never
            # starves today's orders out of the per-run window.
            .order_by(Trade.submitted_at.desc())
            .limit(_RECONCILE_MAX_PER_RUN)
        ).all()
        candidates = [
            (t.id, t.alpaca_order_id) for t in pending
            if t.alpaca_order_id and not t.alpaca_order_id.startswith("DRY")
        ]
    if not candidates:
        return

    updated = 0
    for trade_id, order_id in candidates:
        info = alpaca.order_by_id(order_id)
        if info is None:
            continue
        status = (info["status"] or "").lower()
        with SessionLocal.begin() as s:
            t = s.get(Trade, trade_id)
            if t is None or t.status != "submitted":
                continue
            # A dead order with a partial fill (e.g. a DAY order expiring
            # half-filled) is a real trade for the filled part; it used to
            # match neither branch and sat at 'submitted', re-polled, forever.
            if status == "filled" or (status in _ORDER_DEAD_STATUSES and info["filled_qty"] > 0):
                t.status = "filled"
                if info["filled_qty"] > 0:
                    t.qty = info["filled_qty"]
                if info["filled_avg_price"] > 0:
                    t.price = info["filled_avg_price"]
                    t.notional = info["filled_qty"] * info["filled_avg_price"]
                t.filled_at = info["filled_at"] or datetime.now(timezone.utc)
                updated += 1
            elif status in _ORDER_DEAD_STATUSES:
                t.status = "canceled"
                updated += 1
            # partially_filled / new / accepted → leave as 'submitted';
            # the next sync will pick up the terminal state.
    if updated:
        logger.info("reconciled {} trade fill(s) against Alpaca", updated)


def _refresh_price_history(alpaca: AlpacaClient) -> None:
    """Load up to ~1yr of daily bars for the universe (momentum/dip scoring,
    regime breadth) plus the monitor-only instruments the dashboard shows
    (sectors, global, FX, commodities, crypto — never tradable)."""
    universe = EQUITY_UNIVERSE + FIXED_INCOME_UNIVERSE + ["SPY"] + list(MONITOR_EXTRA)
    # Deduplicate
    universe = list(dict.fromkeys(universe))
    for ticker in universe:
        bars = alpaca.daily_bars(ticker, limit=260)
        if not bars:
            continue
        with SessionLocal.begin() as s:
            # Replace prior bars for this ticker. Simpler than merge.
            s.query(PriceHistory).filter(PriceHistory.ticker == ticker).delete()
            for ts, o, h, lo, close, vol in bars:
                s.add(PriceHistory(
                    ticker=ticker, trade_date=ts, close=close,
                    open=o, high=h, low=lo, volume=vol,
                ))


def tick(force: bool = False) -> None:
    """Single 5-min cycle. `force=True` bypasses the NYSE-hours gate so a
    manual run can refresh news + queue limit orders before open."""
    if not force and not _is_market_open_now():
        logger.debug("market closed, skipping tick")
        return

    logger.info("=== tick start ({}) ===", datetime.now(timezone.utc).isoformat())
    alpaca = AlpacaClient()

    _log_job("news_refresh", lambda: (
        persist_new(fetch_all()),
        score_unscored(),
    ))
    # Article bodies come second — fetching can be slow, and we only scrape
    # headlines that already matched a universe ticker. After the scrape we
    # re-score the matched items with their full body so the next tick's
    # composite score sees the richer sentiment.
    _log_job("article_scrape", lambda: (
        scrape_pending(FULL_UNIVERSE),
        rescore_scraped_articles(),
    ))
    _log_job("sync_account", lambda: _sync_account_and_positions(alpaca))

    def _plan_and_execute():
        acct = alpaca.account()
        scores = aggregator.compute_all()
        orders = plan(scores, acct.equity, acct.cash, acct.buying_power)
        execute(orders, alpaca)

    _log_job("strategy_tick", _plan_and_execute)
    logger.info("=== tick done ===")


def research_tick() -> None:
    """News + article scraping only — no trading. Runs every 15 min 24/7.

    This used to bail out during market hours because the 5-min quant
    ``tick()`` covered that window — but the quant tick was retired in the
    Phase-5 LLM cutover and is no longer scheduled, which silently left news
    un-refreshed from 09:30 to 16:00 ET every trading day (last in-hours
    news_refresh: 2026-04-24). The LLM's execute/midday routines were reading
    up-to-6.5-hour-stale headlines. Now it always runs."""
    logger.info("=== research tick ({}) ===", datetime.now(timezone.utc).isoformat())
    _log_job("news_refresh_offhours", lambda: (
        persist_new(fetch_all()),
        score_unscored(),
    ))
    _log_job("article_scrape_offhours", lambda: (
        scrape_pending(FULL_UNIVERSE),
        rescore_scraped_articles(),
    ))
    logger.info("=== research tick done ===")


def daily_price_refresh() -> None:
    _log_job("price_refresh", lambda: _refresh_price_history(AlpacaClient()))


def daily_politician_refresh() -> None:
    _log_job("politicians_daily", politician_job.run)


def daily_senate_refresh() -> None:
    _log_job("senate_daily", senate_job.run)


def weekly_investor_refresh() -> None:
    _log_job("investors_weekly", investor_job.run)


def daily_regime_refresh() -> None:
    _log_job("regime_daily", regime_job.run)


def daily_macro_refresh() -> None:
    # macro_job.run records its own JobRun ("macro_daily"); errors per series
    # are logged and never abort the rest.
    macro_job.run()


def weekly_profile_refresh() -> None:
    profiles_job.run()


def daily_earnings_refresh() -> None:
    _log_job("earnings_daily", earnings_job.run)


def sync_account_job() -> None:
    """Standalone account+positions sync. Was previously called only from
    the retired ``tick()``; when the quant strategy was retired in Phase 5
    the local DB stopped being refreshed and drifted 7+ days out of date.
    This job restores the sync as a first-class scheduled job, independent
    of the LLM routines, so PortfolioSnapshot history keeps rolling and the
    /positions DB-fallback stays warm.
    """
    _log_job("sync_account", lambda: _sync_account_and_positions(AlpacaClient()))


# --- Phase 5: LLM routines (gated on settings.llm_routines_enabled) ---
# Each daily routine is additionally gated on the NYSE calendar. On 2026-07-03
# (Independence Day observed) premarket + execute + midday + close all ran
# anyway: ~600k input tokens spent planning and attempting trades that
# place_buy correctly rejected with "market is closed". The calendar check
# costs nothing and records a 'skipped' JobRun for the dashboard. The Friday
# weekly_review stays ungated — a holiday Friday still had a week to review.
def _llm_premarket() -> None:
    if not _is_trading_day():
        _skip_job("llm_premarket", "NYSE holiday — market closed today")
        return
    from bot.routines import premarket
    _log_job("llm_premarket", premarket.run)


def _llm_execute() -> None:
    if not _is_trading_day():
        _skip_job("llm_execute", "NYSE holiday — market closed today")
        return
    from bot.routines import execute as ex
    _log_job("llm_execute", ex.run)


def _llm_midday() -> None:
    if not _is_trading_day():
        _skip_job("llm_midday", "NYSE holiday — market closed today")
        return
    from bot.routines import midday
    _log_job("llm_midday", midday.run)


def _llm_close() -> None:
    if not _is_trading_day():
        _skip_job("llm_close", "NYSE holiday — market closed today")
        return
    from bot.routines import close as cl
    _log_job("llm_close", cl.run)


def _llm_weekly_review() -> None:
    from bot.routines import weekly_review
    _log_job("llm_weekly_review", weekly_review.run)


def _setup_logging() -> None:
    logger.remove()
    logger.add(sys.stderr, level=settings.log_level)
    logger.add(ROOT / "bot.log", rotation="5 MB", retention=5, level=settings.log_level)


# APScheduler's default misfire_grace_time is ONE second: a job whose thread
# starts >1s after its scheduled time is dropped as "missed" with only a log
# warning. Waking from sleep a few seconds after 09:30 ET, or a busy worker
# pool, silently cost that day's only buy window. Data jobs get 10 minutes of
# slack; LLM routines 30 (place_buy still refuses when the market is closed,
# so a late execute can't trade outside the session).
_DEFAULT_MISFIRE_GRACE_S = 600
_LLM_MISFIRE_GRACE_S = 1800


def build_scheduler() -> BlockingScheduler:
    """Construct the production scheduler with every job registered (not
    started). Split out of ``main`` so the wiring is testable."""
    from apscheduler.events import EVENT_JOB_MAX_INSTANCES, EVENT_JOB_MISSED

    scheduler = BlockingScheduler(
        timezone="UTC",
        job_defaults={"misfire_grace_time": _DEFAULT_MISFIRE_GRACE_S, "coalesce": True},
    )
    scheduler.add_listener(_on_job_not_run, EVENT_JOB_MISSED | EVENT_JOB_MAX_INSTANCES)

    # --- RETIRED: composite-score quant tick ---
    # Replaced by the five LLM routines registered below. The function
    # ``tick()`` stays callable for `python -m bot.main --once` so the
    # quant strategy can be A/B'd manually. Reason for retirement: in
    # 8 days (2026-04-20 through 2026-04-24) the strategy underperformed
    # SPY by 67 bps while doing 579 trades on three tickers, hit a 44%
    # wash-trade rejection rate from Alpaca, and never crossed its own
    # ±1.0 conviction thresholds so no new positions were opened.
    # ---------------------------------------------------------------
    # scheduler.add_job(tick, CronTrigger(
    #     day_of_week="mon-fri", hour="13-19", minute="*/5", timezone="UTC"),
    #     id="tick", max_instances=1, coalesce=True)
    # scheduler.add_job(tick, CronTrigger(
    #     day_of_week="mon-fri", hour="20", minute="0", timezone="UTC"),
    #     id="close_tick", max_instances=1)

    # Daily price refresh at 16:30 ET (after close) — still runs; the LLM
    # strategy doesn't need it directly but it keeps PriceHistory warm for
    # the regime snapshot and the dashboard's tape. Anchored to New York:
    # the old 20:30 UTC trigger was 15:30 ET under EST (Nov–Mar), i.e. it
    # captured a partial intraday bar as the day's close half the year.
    scheduler.add_job(daily_price_refresh, CronTrigger(
        day_of_week="mon-fri", hour=16, minute=30, timezone="America/New_York"),
        id="price_refresh")

    # --- LLM routines (Phase 5 cutover) -----------------------------
    # Anchored to America/New_York so DST is automatic and times track NYSE.
    # Five routines per week, each a Claude tool-use loop. Gated on
    # settings.llm_routines_enabled so this can be flipped off without a
    # code change if anything goes sideways.
    if settings.llm_routines_enabled:
        for func, job_id, dow, hour, minute in (
            (_llm_premarket, "llm_premarket", "mon-fri", 7, 0),
            (_llm_execute, "llm_execute", "mon-fri", 9, 30),
            (_llm_midday, "llm_midday", "mon-fri", 13, 0),
            (_llm_close, "llm_close", "mon-fri", 16, 0),
            (_llm_weekly_review, "llm_weekly_review", "fri", 17, 0),
        ):
            scheduler.add_job(func, CronTrigger(
                day_of_week=dow, hour=hour, minute=minute, timezone="America/New_York"),
                id=job_id, max_instances=1, coalesce=True,
                misfire_grace_time=_LLM_MISFIRE_GRACE_S)
        logger.info("LLM routines registered (5 jobs, America/New_York timezone)")
    else:
        logger.info("LLM_ROUTINES_ENABLED=false; routines NOT scheduled")

    # 24/7 news + article research — every 15 min, all days. This is what
    # keeps sentiment fresh overnight/weekends/holidays so we open Monday
    # with already-scored news (and in-session for execute/midday).
    scheduler.add_job(research_tick, CronTrigger(minute="*/15", timezone="UTC"),
                      id="research", max_instances=1, coalesce=True)

    # Daily politician disclosure refresh — 07:00 UTC (pre-US-open). Disclosures
    # trickle in throughout the day; checking daily means a new filing shows up
    # in signals within 24h.
    scheduler.add_job(daily_politician_refresh, CronTrigger(
        hour="7", minute="0", timezone="UTC"),
        id="politicians")

    # Weekly investor 13F refresh — Sunday 06:00 UTC. 13Fs update quarterly in
    # reality, but checking weekly catches new filings the same week they land.
    scheduler.add_job(weekly_investor_refresh, CronTrigger(
        day_of_week="sun", hour="6", minute="0", timezone="UTC"),
        id="investors")

    # Daily Senate PTR refresh — 07:30 UTC, half hour after House so the
    # eFD's session cookie won't collide with the politician scrape.
    scheduler.add_job(daily_senate_refresh, CronTrigger(
        hour="7", minute="30", timezone="UTC"),
        id="senate")

    # Daily market-regime snapshot — 17:20 ET, after the 16:30 ET price
    # refresh so SPY closes are loaded before we compute MA crosses + breadth.
    # The :20 keeps it off 22:00 UTC, where it collided with the earnings
    # refresh (one long SQLite write transaction) every winter: a "database
    # is locked" there left a stale regime label behind.
    scheduler.add_job(daily_regime_refresh, CronTrigger(
        hour=17, minute=20, timezone="America/New_York"),
        id="regime")
    # FRED posts most daily series by ~16:15 ET; 17:40 ET also keeps clear of
    # the regime (17:20) and earnings (22:00 UTC) write transactions.
    scheduler.add_job(daily_macro_refresh, CronTrigger(
        hour=17, minute=40, timezone="America/New_York"),
        id="macro")
    scheduler.add_job(weekly_profile_refresh, CronTrigger(
        day_of_week="sun", hour="5", minute="0", timezone="UTC"),
        id="profiles")

    # Daily earnings calendar + surprise-history refresh — 22:00 UTC.
    scheduler.add_job(daily_earnings_refresh, CronTrigger(
        hour="22", minute="0", timezone="UTC"),
        id="earnings")

    # Account + positions sync — every 5 min, all hours. Cheap (one Alpaca
    # account+positions call) and keeps PortfolioSnapshot history rolling
    # so the equity chart never goes stale. The /positions and
    # /portfolio/summary endpoints hit Alpaca live anyway, but this snapshot
    # is what the equity chart and the DB-fallback path read.
    scheduler.add_job(sync_account_job, CronTrigger(minute="*/5", timezone="UTC"),
                      id="sync_account", max_instances=1, coalesce=True)
    return scheduler


def main(run_once: bool = False) -> None:
    _setup_logging()
    init_db()

    if run_once:
        logger.info("run-once mode (forcing tick regardless of market hours)")
        tick(force=True)
        return

    scheduler = build_scheduler()
    logger.info("scheduler started (DRY_RUN={})", settings.dry_run)
    signal.signal(signal.SIGINT, lambda *_: scheduler.shutdown())
    signal.signal(signal.SIGTERM, lambda *_: scheduler.shutdown())
    scheduler.start()


if __name__ == "__main__":
    main(run_once="--once" in sys.argv)
