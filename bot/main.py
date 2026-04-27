"""Bot entrypoint. Tick every 5 minutes during market hours."""
from __future__ import annotations

import signal
import sys
from datetime import datetime, timezone, timedelta

import pandas_market_calendars as mcal
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger
from loguru import logger

from bot.alpaca_client import AlpacaClient
from bot.config import FIXED_INCOME_UNIVERSE, EQUITY_UNIVERSE, FULL_UNIVERSE, ROOT, settings
from bot.db import (
    JobRun,
    Position,
    PortfolioSnapshot,
    PriceHistory,
    SessionLocal,
    init_db,
)
from bot.executor import execute
from bot.news.article_scraper import scrape_pending
from bot.news.rss_scraper import fetch_all, persist_new
from bot.signals import aggregator
from bot.signals.sentiment import rescore_scraped_articles, score_unscored
from bot.strategy import plan
from bot.signals import investors as investor_job
from bot.signals import politicians as politician_job


_nyse = mcal.get_calendar("NYSE")


def _is_market_open_now() -> bool:
    now = datetime.now(timezone.utc)
    schedule = _nyse.schedule(start_date=now.date(), end_date=now.date())
    if schedule.empty:
        return False
    open_at = schedule.iloc[0]["market_open"].to_pydatetime()
    close_at = schedule.iloc[0]["market_close"].to_pydatetime()
    return open_at <= now <= close_at


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


def _sync_account_and_positions(alpaca: AlpacaClient) -> None:
    acct = alpaca.account()
    # Snapshot portfolio value
    spy_price = alpaca.latest_quotes(["SPY"]).get("SPY")
    with SessionLocal.begin() as s:
        s.add(PortfolioSnapshot(
            equity=acct.equity, cash=acct.cash,
            buying_power=acct.buying_power, spy_close=spy_price,
        ))

    live_positions = {p.symbol: p for p in alpaca.positions()}
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
            else:
                row.qty = lp.qty
                row.avg_cost = lp.avg_entry_price
                row.market_price = lp.market_price
                row.market_value = lp.market_value
                row.unrealized_pnl = lp.unrealized_pl
                if lp.market_price > (row.peak_price or 0):
                    row.peak_price = lp.market_price
                row.updated_at = datetime.now(timezone.utc)
        # Remove rows that Alpaca no longer reports (fully closed positions).
        for sym in list(existing.keys()):
            if sym not in live_positions:
                s.delete(existing[sym])


def _refresh_price_history(alpaca: AlpacaClient) -> None:
    """Load up to ~1yr of daily closes for the universe so momentum/dip scoring works."""
    universe = EQUITY_UNIVERSE + FIXED_INCOME_UNIVERSE + ["SPY"]
    # Deduplicate
    universe = list(dict.fromkeys(universe))
    for ticker in universe:
        bars = alpaca.daily_closes(ticker, limit=260)
        if not bars:
            continue
        with SessionLocal.begin() as s:
            # Replace prior closes for this ticker. Simpler than merge.
            s.query(PriceHistory).filter(PriceHistory.ticker == ticker).delete()
            for ts, close in bars:
                s.add(PriceHistory(ticker=ticker, trade_date=ts, close=close))


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
    """News + article scraping only — no trading. Runs every 15 min 24/7 so
    the bot stays warm overnight/weekends. Bails out when the market is open
    because the 5-min `tick` is already doing this work and we don't want two
    jobs hammering RSS feeds simultaneously."""
    if _is_market_open_now():
        return
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


def weekly_investor_refresh() -> None:
    _log_job("investors_weekly", investor_job.run)


# --- Phase 5: LLM routines (gated on settings.llm_routines_enabled) ---
def _llm_premarket() -> None:
    from bot.routines import premarket
    _log_job("llm_premarket", premarket.run)


def _llm_execute() -> None:
    from bot.routines import execute as ex
    _log_job("llm_execute", ex.run)


def _llm_midday() -> None:
    from bot.routines import midday
    _log_job("llm_midday", midday.run)


def _llm_close() -> None:
    from bot.routines import close as cl
    _log_job("llm_close", cl.run)


def _llm_weekly_review() -> None:
    from bot.routines import weekly_review
    _log_job("llm_weekly_review", weekly_review.run)


def _setup_logging() -> None:
    logger.remove()
    logger.add(sys.stderr, level=settings.log_level)
    logger.add(ROOT / "bot.log", rotation="5 MB", retention=5, level=settings.log_level)


def main(run_once: bool = False) -> None:
    _setup_logging()
    init_db()

    if run_once:
        logger.info("run-once mode (forcing tick regardless of market hours)")
        tick(force=True)
        return

    scheduler = BlockingScheduler(timezone="UTC")

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

    # Daily price refresh at 20:30 UTC (4:30pm ET, after close) — still runs;
    # the LLM strategy doesn't need it directly but it keeps PriceHistory
    # warm for the dashboard's tape + any future sparkline charts.
    scheduler.add_job(daily_price_refresh, CronTrigger(
        day_of_week="mon-fri", hour="20", minute="30", timezone="UTC"),
        id="price_refresh")

    # --- LLM routines (Phase 5 cutover) -----------------------------
    # Anchored to America/New_York so DST is automatic and times track NYSE.
    # Five routines per week, each a Claude tool-use loop. Gated on
    # settings.llm_routines_enabled so this can be flipped off without a
    # code change if anything goes sideways.
    if settings.llm_routines_enabled:
        scheduler.add_job(_llm_premarket, CronTrigger(
            day_of_week="mon-fri", hour=7, minute=0, timezone="America/New_York"),
            id="llm_premarket", max_instances=1, coalesce=True)
        scheduler.add_job(_llm_execute, CronTrigger(
            day_of_week="mon-fri", hour=9, minute=30, timezone="America/New_York"),
            id="llm_execute", max_instances=1, coalesce=True)
        scheduler.add_job(_llm_midday, CronTrigger(
            day_of_week="mon-fri", hour=13, minute=0, timezone="America/New_York"),
            id="llm_midday", max_instances=1, coalesce=True)
        scheduler.add_job(_llm_close, CronTrigger(
            day_of_week="mon-fri", hour=16, minute=0, timezone="America/New_York"),
            id="llm_close", max_instances=1, coalesce=True)
        scheduler.add_job(_llm_weekly_review, CronTrigger(
            day_of_week="fri", hour=17, minute=0, timezone="America/New_York"),
            id="llm_weekly_review", max_instances=1, coalesce=True)
        logger.info("LLM routines registered (5 jobs, America/New_York timezone)")
    else:
        logger.info("LLM_ROUTINES_ENABLED=false; routines NOT scheduled")

    # 24/7 news + article research — every 15 min, all days. The job self-gates
    # so it becomes a no-op during market hours (the 5-min `tick` covers that
    # window). This is what keeps sentiment fresh overnight/weekends/holidays
    # so we open Monday with already-scored news.
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

    logger.info("scheduler started (DRY_RUN={})", settings.dry_run)
    signal.signal(signal.SIGINT, lambda *_: scheduler.shutdown())
    signal.signal(signal.SIGTERM, lambda *_: scheduler.shutdown())
    scheduler.start()


if __name__ == "__main__":
    main(run_once="--once" in sys.argv)
