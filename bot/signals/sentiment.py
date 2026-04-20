"""VADER sentiment scoring. FinBERT is optional (only loaded if installed)."""
from __future__ import annotations

from functools import lru_cache
from typing import Iterable

from loguru import logger
from sqlalchemy import select
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

from bot.db import NewsItem, SessionLocal
from bot.news.ticker_extractor import extract_tickers

_vader = SentimentIntensityAnalyzer()


@lru_cache(maxsize=1)
def _finbert():
    """Lazy-load FinBERT. Returns None if torch/transformers not installed."""
    try:
        from transformers import pipeline  # type: ignore

        return pipeline(
            "sentiment-analysis",
            model="ProsusAI/finbert",
            device=-1,  # CPU
        )
    except Exception as exc:
        logger.info("FinBERT not available ({}). Using VADER only.", exc)
        return None


def score_item(title: str, summary: str, use_finbert: bool = False) -> dict:
    text = title if not summary else f"{title}. {summary}"
    vader = _vader.polarity_scores(text)["compound"]
    out = {"vader": vader, "finbert_label": None, "finbert_score": None}
    if use_finbert:
        fb = _finbert()
        if fb is not None:
            try:
                res = fb(text[:510])[0]  # FinBERT max length is 512 tokens
                out["finbert_label"] = res["label"]
                out["finbert_score"] = float(res["score"])
            except Exception as exc:
                logger.warning("FinBERT failed on item: {}", exc)
    return out


def score_news_items(ids: Iterable[int]) -> int:
    """Scores the given news IDs in place. Returns count updated."""
    count = 0
    with SessionLocal.begin() as s:
        rows = s.scalars(select(NewsItem).where(NewsItem.id.in_(list(ids)))).all()
        for row in rows:
            tickers = extract_tickers(row.title, row.summary or "")
            row.tickers = tickers
            scores = score_item(
                row.title,
                row.summary or "",
                use_finbert=bool(tickers),  # only escalate on relevant headlines
            )
            row.vader_score = scores["vader"]
            row.finbert_label = scores["finbert_label"]
            row.finbert_score = scores["finbert_score"]
            count += 1
    return count


def score_unscored() -> int:
    """Score everything in the DB missing a vader score."""
    with SessionLocal() as s:
        ids = list(
            s.scalars(select(NewsItem.id).where(NewsItem.vader_score.is_(None))).all()
        )
    if not ids:
        return 0
    return score_news_items(ids)
