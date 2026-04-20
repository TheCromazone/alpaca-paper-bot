"""Extracts tickers from a headline+summary.

Matches use three passes:
  1. Explicit cashtags like `$AAPL`.
  2. Standalone uppercase tickers that exist in our universe whitelist.
  3. Company-name lookups (case-insensitive) from `TICKER_NAMES`.
"""
from __future__ import annotations

import re

from bot.config import FULL_UNIVERSE, TICKER_NAMES

_CASHTAG_RE = re.compile(r"\$([A-Z]{1,5}(?:\.[A-Z])?)\b")
# Require word boundaries so "HD" doesn't match "HD display".
_UNIVERSE_RE = re.compile(
    r"\b(" + "|".join(re.escape(t) for t in FULL_UNIVERSE) + r")\b"
)

_NAME_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\b" + re.escape(name) + r"\b", re.IGNORECASE), ticker)
    for ticker, names in TICKER_NAMES.items()
    for name in names
    if len(name) > 2  # avoid "V", "MA" false positives via name
]


def extract_tickers(title: str, summary: str = "") -> list[str]:
    text = f"{title} {summary}"
    hits: set[str] = set()

    for m in _CASHTAG_RE.findall(text):
        if m in FULL_UNIVERSE:
            hits.add(m)

    for m in _UNIVERSE_RE.findall(text):
        hits.add(m)

    for pattern, ticker in _NAME_PATTERNS:
        if pattern.search(text):
            hits.add(ticker)

    return sorted(hits)
