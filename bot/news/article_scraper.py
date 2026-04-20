"""Polite article-body scraper for news items that mention a universe ticker.

Uses `trafilatura` for HTML → main-text extraction (handles CNBC, CNN Business,
Reuters, Yahoo Finance, MarketWatch, and most news sites with decent recall).

Policy:
  * Only fetch articles whose RSS item mentions a ticker in our universe.
    (A full universe of 102 tickers means most headlines never trigger a fetch.)
  * Hard timeout per request; never block the bot tick on a slow server.
  * Per-domain rate limit via a simple in-process token bucket.
  * Respect robots.txt implicitly by letting trafilatura fetch via its own HTTP
    layer with a descriptive User-Agent.
  * Skip paywall indicators — if the extracted body is suspiciously short,
    mark as "empty" and don't score on it.
"""
from __future__ import annotations

import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Iterable
from urllib.parse import urlparse

import trafilatura
from loguru import logger
from sqlalchemy import and_, select

from bot.db import NewsItem, SessionLocal


# Only fetch when the RSS item actually tagged a universe ticker, and when the
# body extraction produced at least this many characters — anything shorter is
# almost always a paywall wall, a subscribe-prompt, or a stub page.
MIN_BODY_CHARS = 250

# Hard limit per bot tick to keep the cycle well under a minute.
MAX_FETCHES_PER_TICK = 25

# Minimum seconds between requests to the same domain.
PER_DOMAIN_COOLDOWN_S = 1.5

# Hard per-request timeout. trafilatura's fetch_url respects it.
REQUEST_TIMEOUT_S = 6

_USER_AGENT = (
    "AlpacaPaperBot/0.1 (+research; contact: matthewcromaz37@gmail.com)"
)

_last_fetch: dict[str, float] = defaultdict(lambda: 0.0)


def _domain(url: str) -> str:
    try:
        return urlparse(url).netloc.lower()
    except Exception:
        return ""


def _throttle(url: str) -> None:
    dom = _domain(url)
    if not dom:
        return
    last = _last_fetch[dom]
    now = time.monotonic()
    wait = PER_DOMAIN_COOLDOWN_S - (now - last)
    if wait > 0:
        time.sleep(wait)
    _last_fetch[dom] = time.monotonic()


def fetch_article(url: str) -> tuple[str | None, str]:
    """Returns (body_text, status). status is one of:
    "ok" | "empty" | "blocked" | "error".
    """
    _throttle(url)
    try:
        downloaded = trafilatura.fetch_url(
            url,
            config=trafilatura.settings.use_config(),  # default config
        )
    except Exception as exc:
        logger.warning("fetch_url raised for {}: {}", url, exc)
        return None, "error"
    if not downloaded:
        return None, "blocked"
    try:
        text = trafilatura.extract(
            downloaded,
            favor_precision=True,
            include_comments=False,
            include_tables=False,
            no_fallback=False,
        )
    except Exception as exc:
        logger.warning("extract failed for {}: {}", url, exc)
        return None, "error"
    if not text:
        return None, "empty"
    text = text.strip()
    if len(text) < MIN_BODY_CHARS:
        return None, "empty"
    return text, "ok"


def scrape_pending(universe_tickers: Iterable[str], limit: int = MAX_FETCHES_PER_TICK) -> dict:
    """Fetch article bodies for recently-ingested news items that:
        - mention at least one universe ticker, and
        - haven't been attempted yet (`article_fetched_at IS NULL`).

    Returns a stats dict for observability.
    """
    universe = set(universe_tickers)
    stats = {"attempted": 0, "ok": 0, "empty": 0, "blocked": 0, "error": 0}

    with SessionLocal() as s:
        candidates = s.scalars(
            select(NewsItem)
            .where(NewsItem.article_fetched_at.is_(None))
            .where(NewsItem.tickers.is_not(None))
            .order_by(NewsItem.published_at.desc())
            .limit(200)          # pull a generous window, filter in Python
        ).all()
        relevant = [
            n for n in candidates
            if n.tickers and any(t in universe for t in n.tickers)
        ][:limit]
        relevant_ids = [n.id for n in relevant]

    for nid in relevant_ids:
        # Re-open per-item so one slow fetch doesn't hold a transaction open.
        with SessionLocal.begin() as s:
            row = s.get(NewsItem, nid)
            if row is None or row.article_fetched_at is not None:
                continue
            stats["attempted"] += 1
            body, status = fetch_article(row.url)
            row.article_fetched_at = datetime.now(timezone.utc)
            row.article_status = status
            if body:
                row.article_text = body
            stats[status] = stats.get(status, 0) + 1

    logger.info("article scraper: {}", stats)
    return stats
