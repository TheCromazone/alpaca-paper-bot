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


def tick() -> None:
    """Single 5-min cycle."""
    if not _is_market_open_now():
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


def daily_price_refresh() -> None:
    _log_job("price_refresh", lambda: _refresh_price_history(AlpacaClient()))


def weekly_politician_refresh() -> None:
    _log_job("politicians_weekly", politician_job.run)


def quarterly_investor_refresh() -> None:
    _log_job("investors_quarterly", investor_job.run)


def _setup_logging() -> None:
    logger.remove()
    logger.add(sys.stderr, level=settings.log_level)
    logger.add(ROOT / "bot.log", rotation="5 MB", retention=5, level=settings.log_level)


def main(run_once: bool = False) -> None:
    _setup_logging()
    init_db()

    if run_once:
        logger.info("run-once mode")
        tick()
        return

    scheduler = BlockingScheduler(timezone="UTC")

    # Tick every 5 minutes 9:30am-4:00pm ET (13:30-20:00 UTC). The tick itself
    # double-checks calendar so holidays are handled.
    scheduler.add_job(tick, CronTrigger(
        day_of_week="mon-fri", hour="13-19", minute="*/5", timezone="UTC"),
        id="tick", max_instances=1, coalesce=True)
    scheduler.add_job(tick, CronTrigger(
        day_of_week="mon-fri", hour="20", minute="0", timezone="UTC"),
        id="close_tick", max_instances=1)

    # Daily price refresh at 20:30 UTC (4:30pm ET, after close)
    scheduler.add_job(daily_price_refresh, CronTrigger(
        day_of_week="mon-fri", hour="20", minute="30", timezone="UTC"),
        id="price_refresh")

    # Weekly politician job — Monday 07:00 UTC
    scheduler.add_job(weekly_politician_refresh, CronTrigger(
        day_of_week="mon", hour="7", minute="0", timezone="UTC"),
        id="politicians")

    # Quarterly investor job — 1st of month 06:00 UTC (cheap to run monthly)
    scheduler.add_job(quarterly_investor_refresh, CronTrigger(
        day="1", hour="6", minute="0", timezone="UTC"),
        id="investors")

    logger.info("scheduler started (DRY_RUN={})", settings.dry_run)
    signal.signal(signal.SIGINT, lambda *_: scheduler.shutdown())
    signal.signal(signal.SIGTERM, lambda *_: scheduler.shutdown())
    scheduler.start()


if __name__ == "__main__":
    main(run_once="--once" in sys.argv)
