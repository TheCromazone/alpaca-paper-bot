"""Composite-score aggregator.

Inputs per ticker:
  - news_sentiment_z  : mean vader of recent headlines mentioning the ticker, z-scored
  - politician_signal : net dollar-weighted politician buys/sells in last 60d
  - investor_signal   : net dollar-weighted 13F changes from tracked investors (latest quarter)
  - momentum          : 20-day return minus SPY's 20-day return
  - dip_bonus         : +1 if drawdown from 52w high > 25%

Outputs a ScoreBreakdown per ticker so we can show it on the dashboard.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from loguru import logger
from sqlalchemy import select, and_

from bot.config import (
    FULL_UNIVERSE,
    WEIGHT_DIP_BONUS,
    WEIGHT_INVESTOR,
    WEIGHT_MOMENTUM,
    WEIGHT_NEWS,
    WEIGHT_POLITICIAN,
)
from bot.db import NewsItem, PriceHistory, SessionLocal, Signal


@dataclass
class ScoreBreakdown:
    ticker: str
    composite: float = 0.0
    news: float = 0.0
    politician: float = 0.0
    investor: float = 0.0
    momentum: float = 0.0
    dip: float = 0.0
    components: dict = field(default_factory=dict)  # raw values for dashboard


def _news_score(session, ticker: str) -> tuple[float, dict]:
    since = datetime.now(timezone.utc) - timedelta(days=7)
    rows = session.scalars(
        select(NewsItem).where(
            and_(NewsItem.published_at >= since, NewsItem.vader_score.is_not(None))
        )
    ).all()
    ticker_scores: list[float] = []
    all_scores: list[float] = []
    for r in rows:
        v = r.vader_score
        if v is None:
            continue
        all_scores.append(v)
        if r.tickers and ticker in r.tickers:
            ticker_scores.append(v)
    if not ticker_scores or len(all_scores) < 10:
        return 0.0, {"headlines": len(ticker_scores), "baseline_n": len(all_scores)}
    baseline_mean = statistics.mean(all_scores)
    baseline_std = statistics.pstdev(all_scores) or 0.1
    z = (statistics.mean(ticker_scores) - baseline_mean) / baseline_std
    return z, {
        "headlines": len(ticker_scores),
        "avg_vader": round(statistics.mean(ticker_scores), 3),
        "baseline_n": len(all_scores),
    }


def _politician_score(session, ticker: str) -> tuple[float, dict]:
    since = datetime.now(timezone.utc) - timedelta(days=60)
    rows = session.scalars(
        select(Signal).where(
            and_(Signal.ticker == ticker, Signal.kind == "politician", Signal.as_of >= since)
        )
    ).all()
    if not rows:
        return 0.0, {"trades": 0}
    net = sum((r.amount or 0) * (1 if r.direction == "buy" else -1) for r in rows)
    # Normalize: $500k net → +/- 1.0
    score = max(-3.0, min(3.0, net / 500_000))
    return score, {"trades": len(rows), "net_usd": net}


def _investor_score(session, ticker: str) -> tuple[float, dict]:
    rows = session.scalars(
        select(Signal).where(
            and_(Signal.ticker == ticker, Signal.kind == "investor")
        )
    ).all()
    if not rows:
        return 0.0, {"changes": 0}
    net = sum((r.amount or 0) * (1 if r.direction == "buy" else -1) for r in rows)
    # 13F deltas are much larger; $50M → +/- 1.0
    score = max(-3.0, min(3.0, net / 50_000_000))
    return score, {"changes": len(rows), "net_usd": net}


def _momentum_score(session, ticker: str, spy_return: float) -> tuple[float, dict]:
    rows = session.execute(
        select(PriceHistory.close, PriceHistory.trade_date)
        .where(PriceHistory.ticker == ticker)
        .order_by(PriceHistory.trade_date.desc())
        .limit(21)
    ).all()
    if len(rows) < 21:
        return 0.0, {"bars": len(rows)}
    closes = [r[0] for r in rows]
    ret = (closes[0] / closes[-1]) - 1
    alpha = ret - spy_return
    score = max(-3.0, min(3.0, alpha * 20))  # 5% alpha → 1.0
    return score, {"ret_20d": round(ret, 4), "vs_spy": round(alpha, 4)}


def _dip_score(session, ticker: str) -> tuple[float, dict]:
    rows = session.execute(
        select(PriceHistory.close)
        .where(PriceHistory.ticker == ticker)
        .order_by(PriceHistory.trade_date.desc())
        .limit(252)
    ).all()
    if len(rows) < 20:
        return 0.0, {"drawdown": 0.0}
    closes = [r[0] for r in rows]
    peak = max(closes)
    drawdown = (closes[0] / peak) - 1  # negative if below peak
    if drawdown < -0.25:
        return 1.0, {"drawdown": round(drawdown, 3)}
    return 0.0, {"drawdown": round(drawdown, 3)}


def _spy_return(session) -> float:
    rows = session.execute(
        select(PriceHistory.close)
        .where(PriceHistory.ticker == "SPY")
        .order_by(PriceHistory.trade_date.desc())
        .limit(21)
    ).all()
    if len(rows) < 21:
        return 0.0
    closes = [r[0] for r in rows]
    return (closes[0] / closes[-1]) - 1


def compute_all(tickers: list[str] | None = None) -> list[ScoreBreakdown]:
    tickers = tickers or FULL_UNIVERSE
    out: list[ScoreBreakdown] = []
    with SessionLocal() as s:
        spy_ret = _spy_return(s)
        for t in tickers:
            sb = ScoreBreakdown(ticker=t)
            sb.news, comp_news = _news_score(s, t)
            sb.politician, comp_pol = _politician_score(s, t)
            sb.investor, comp_inv = _investor_score(s, t)
            sb.momentum, comp_mom = _momentum_score(s, t, spy_ret)
            sb.dip, comp_dip = _dip_score(s, t)
            sb.composite = (
                WEIGHT_NEWS * sb.news
                + WEIGHT_POLITICIAN * sb.politician
                + WEIGHT_INVESTOR * sb.investor
                + WEIGHT_MOMENTUM * sb.momentum
                + WEIGHT_DIP_BONUS * sb.dip
            )
            sb.components = {
                "news": comp_news,
                "politician": comp_pol,
                "investor": comp_inv,
                "momentum": comp_mom,
                "dip": comp_dip,
                "spy_ret_20d": round(spy_ret, 4),
            }
            out.append(sb)
    logger.info("aggregator: computed {} scores", len(out))
    return out
