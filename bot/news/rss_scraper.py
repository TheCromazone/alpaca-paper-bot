"""Polls financial-news RSS feeds. Writes new items to the DB."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

import feedparser
import requests
from loguru import logger
from sqlalchemy import select

from bot.db import NewsItem, SessionLocal


# Only RSS for discovery — we do not scrape HTML on first sight. The article
# scraper (bot/news/article_scraper.py) fetches full article bodies *after*
# a headline has been tagged with at least one universe ticker, and only
# from direct publisher URLs (not from Google News redirect wrappers).
FEEDS: dict[str, str] = {
    "CNBC Top News":       "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    "CNBC Markets":        "https://www.cnbc.com/id/10000664/device/rss/rss.html",
    "CNBC Business":       "https://www.cnbc.com/id/10001147/device/rss/rss.html",
    "Yahoo Finance":       "https://finance.yahoo.com/news/rssindex",
    "CNN Business":        "https://rss.cnn.com/rss/money_news_international.rss",
    "Seeking Alpha":       "https://seekingalpha.com/market_currents.xml",
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


FEED_TIMEOUT_S = 20


def _fetch_one_feed(url: str, source: str):
    """Pull one feed with up to 3 attempts on transient failure (DNS / 429 /
    socket timeout). Off-hours scrapers used to drop ~5 jobs/14d on flaky
    feeds; retrying inline keeps the batch healthy.

    The HTTP fetch goes through requests with a timeout: feedparser's own
    fetcher (urllib) has none, so one stalled feed server could block the
    research job forever — and with max_instances=1 every later run is then
    skipped, freezing the news the LLM routines read."""
    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"},
                                timeout=FEED_TIMEOUT_S)
            # Treat 5xx + network exceptions as retryable; other non-200s
            # parse to an empty feed, as feedparser's own fetcher did.
            if 500 <= resp.status_code < 600:
                raise RuntimeError(f"HTTP {resp.status_code} from {source}")
            # feedparser only reads lowercase header keys; servers send
            # "Content-Type", which it then ignored (feed flagged bozo, charset
            # dropped). content-location keeps relative-link resolution
            # working as it did when feedparser fetched the URL itself.
            headers = {k.lower(): v for k, v in resp.headers.items()}
            headers.setdefault("content-location", resp.url or url)
            return feedparser.parse(resp.content, response_headers=headers)
        except Exception as exc:
            last_exc = exc
            if attempt < 2:
                import time as _t
                _t.sleep(2 ** attempt)  # 1s, 2s
    logger.warning("feed {} failed after retries: {}", source, last_exc)
    return None


def fetch_all() -> list[FeedItem]:
    items: list[FeedItem] = []
    for source, url in FEEDS.items():
        parsed = _fetch_one_feed(url, source)
        if parsed is None:
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
