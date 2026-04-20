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


def _split_sentences(text: str) -> list[str]:
    """Cheap sentence splitter — good enough for VADER averaging."""
    import re
    # Split on sentence-ending punctuation followed by whitespace + capital/quote,
    # or on double newlines (paragraph breaks).
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z\"'])|\n\n+", text)
    return [p.strip() for p in parts if p and len(p.strip()) >= 5]


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


def score_item(
    title: str,
    summary: str,
    article_text: str | None = None,
    use_finbert: bool = False,
) -> dict:
    # Use the article body when we have it — much richer context than a
    # 100-character headline. VADER's `compound` score saturates on long
    # inputs (a 2 KB article of even mildly-positive prose scores 0.99),
    # which would dwarf headline-only items in the aggregator's z-score
    # baseline. Score per-sentence and average to get a comparable value.
    if article_text:
        text = f"{title}. {article_text[:4000]}"
        sentences = _split_sentences(text)
        if sentences:
            scores = [_vader.polarity_scores(s)["compound"] for s in sentences]
            vader = sum(scores) / len(scores)
        else:
            vader = _vader.polarity_scores(text)["compound"]
    else:
        text = title if not summary else f"{title}. {summary}"
        vader = _vader.polarity_scores(text)["compound"]
    out = {"vader": vader, "finbert_label": None, "finbert_score": None}
    if use_finbert:
        fb = _finbert()
        if fb is not None:
            try:
                # FinBERT's max input is 512 tokens — headline + lead paragraph.
                fb_input = (title + ". " + (article_text or summary or ""))[:1500]
                res = fb(fb_input[:510])[0]
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
                article_text=row.article_text,
                use_finbert=bool(tickers),  # only escalate on relevant headlines
            )
            row.vader_score = scores["vader"]
            row.finbert_label = scores["finbert_label"]
            row.finbert_score = scores["finbert_score"]
            count += 1
    return count


def rescore_scraped_articles(limit: int = 100) -> int:
    """Re-score items whose article body was scraped after initial sentiment
    was assigned. Headline-only VADER is a weak signal; the full body is much
    richer — this lets that signal flow into the composite score on the next
    tick."""
    with SessionLocal() as s:
        ids = list(
            s.scalars(
                select(NewsItem.id)
                .where(NewsItem.article_text.is_not(None))
                .where(NewsItem.article_status == "ok")
                .order_by(NewsItem.article_fetched_at.desc())
                .limit(limit)
            ).all()
        )
    if not ids:
        return 0
    return score_news_items(ids)


def score_unscored() -> int:
    """Score everything in the DB missing a vader score."""
    with SessionLocal() as s:
        ids = list(
            s.scalars(select(NewsItem.id).where(NewsItem.vader_score.is_(None))).all()
        )
    if not ids:
        return 0
    return score_news_items(ids)
