"""Midday risk scan — 13:00 ET Mon-Fri.

Force-closes positions down ≥7% from avg cost; tightens trailing stops on
positions up ≥15%. The only routine that places sell orders.
"""
from __future__ import annotations

from bot.llm.runner import run_routine


def run() -> int:
    return run_routine("midday")
