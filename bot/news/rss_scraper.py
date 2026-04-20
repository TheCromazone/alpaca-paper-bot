"""Polls financial-news RSS feeds. Writes new items to the DB."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

import feedparser
from loguru import logger
from sqlalchemy import select

from bot.db import NewsItem, SessionLocal


# Only RSS — we do not scrape HTML or circumvent paywalls.
FEEDS: dict[str, str] = {
    "CNBC Top News":       "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    "CNBC Markets":        "https://www.cnbc.com/id/10000664/device/rss/rss.html",
    "CNBC Business":       "https://www.cnbc.com/id/10001147/device/rss/rss.html",
    "Yahoo Finance":       "https://finance.yahoo.com/news/rssindex",
    "CNN Business":        "https://rss.cnn.com/rss/money_news_international.rss",
    "Seeking Alpha":       "https://seekingalpha.com/market_currents.xml",
    "Reuters Markets":     "https://news.google.com/rss/search?q=when:1d+allinurl:reuters.com+markets&hl=en-US&gl=US&ceid=US:en",
    "MarketWatch Top":     "https://www.marketwatch.com/rss/topstories",
}


@dataclass
class FeedItem:
    title: str
    url: str
    summary: str
    source: str
    published_at: datetime


def _parse_published(entry) -> datetime:
    if getattr(entry, "published_parsed", None):
        return datetime(*entry.published_parsed[:6], tzinfo=timezone.utc)
    if getattr(entry, "updated_parsed", None):
        return datetime(*entry.updated_parsed[:6], tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


def fetch_all() -> list[FeedItem]:
    items: list[FeedItem] = []
    for source, url in FEEDS.items():
        try:
            parsed = feedparser.parse(url, request_headers={"User-Agent": "Mozilla/5.0"})
        except Exception as exc:
            logger.warning("feed {} failed: {}", source, exc)
            continue
        for entry in parsed.entries[:50]:
            title = (getattr(entry, "title", "") or "").strip()
            link = (getattr(entry, "link", "") or "").strip()
            if not title or not link:
                continue
            summary = (getattr(entry, "summary", "") or "").strip()
            items.append(
                FeedItem(
                    title=title,
                    url=link,
                    summary=summary,
                    source=source,
                    published_at=_parse_published(entry),
                )
            )
    logger.info("fetched {} items from {} feeds", len(items), len(FEEDS))
    return items


def _hash(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def persist_new(items: Iterable[FeedItem]) -> list[NewsItem]:
    """Returns the list of NewsItem rows that were new (already committed)."""
    # Dedup within the batch first (multiple feeds often carry the same story).
    seen: dict[str, FeedItem] = {}
    for item in items:
        seen.setdefault(_hash(item.url), item)
    new_rows: list[NewsItem] = []
    with SessionLocal.begin() as s:
        hashes = list(seen.keys())
        existing = set(
            s.scalars(select(NewsItem.url_hash).where(NewsItem.url_hash.in_(hashes)))
            .all()
        )
        for h, item in seen.items():
            if h in existing:
                continue
            row = NewsItem(
                url_hash=h,
                url=item.url,
                title=item.title,
                summary=item.summary,
                source=item.source,
                published_at=item.published_at,
            )
            s.add(row)
            new_rows.append(row)
        s.flush()
    return new_rows
