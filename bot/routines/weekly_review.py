"""Friday post-mortem — 17:00 ET.

Reads the last five trading days of research_log.md + trade_log.md, identifies
patterns, proposes (in text) up to three edits to strategy.md. The user
applies strategy.md edits manually — the LLM cannot write it directly.
"""
from __future__ import annotations

from bot.llm.runner import run_routine


def run() -> int:
    return run_routine("weekly_review")
