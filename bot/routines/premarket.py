"""Pre-market research routine — 07:00 ET Mon-Fri.

Reads portfolio.md + yesterday's research_log, web-searches for catalysts,
cross-references our scraped news DB, appends 2-3 actionable ideas into
research_log.md. No trades.
"""
from __future__ import annotations

from bot.llm.runner import run_routine


def run() -> int:
    return run_routine("premarket")
