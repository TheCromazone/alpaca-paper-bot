"""Market-close wrap-up — 16:00 ET Mon-Fri.

Logs the day's P/L, winners/losers, and one thing to watch tomorrow.
Rewrites portfolio.md with closing state. No trades.
"""
from __future__ import annotations

from bot.llm.runner import run_routine


def run() -> int:
    return run_routine("close")
