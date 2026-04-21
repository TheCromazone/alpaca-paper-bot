"""Market-open execution routine — 09:30 ET Mon-Fri.

Reads today's pre-market theses, executes buys (with 10% trailing stops
attached automatically), rewrites portfolio.md. The only routine that
places buy orders.
"""
from __future__ import annotations

from bot.llm.runner import run_routine


def run() -> int:
    return run_routine("execute")
