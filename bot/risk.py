"""Risk checks and position sizing."""
from __future__ import annotations

from dataclasses import dataclass

from bot.config import (
    CASH_RESERVE_PCT,
    MAX_POSITION_PCT,
    MAX_POSITIONS,
    MAX_SECTOR_PCT,
    REBALANCE_TRIM_PCT,
    SECTOR_MAP,
    TRAILING_STOP_PCT,
)


@dataclass
class AllocationContext:
    equity: float
    cash: float
    buying_power: float
    current_positions: dict[str, float]  # ticker -> market value


def sector(ticker: str) -> str:
    return SECTOR_MAP.get(ticker, "Other")


def can_open_new(ctx: AllocationContext, ticker: str) -> tuple[bool, str]:
    if ticker in ctx.current_positions:
        return False, "already holding"
    if len(ctx.current_positions) >= MAX_POSITIONS:
        return False, f"already at MAX_POSITIONS ({MAX_POSITIONS})"
    # Sector cap
    sec = sector(ticker)
    sector_exposure = sum(
        mv for t, mv in ctx.current_positions.items() if sector(t) == sec
    )
    max_sector_dollars = ctx.equity * MAX_SECTOR_PCT
    target_size_dollars = ctx.equity * MAX_POSITION_PCT
    if sector_exposure + target_size_dollars > max_sector_dollars:
        return False, f"sector {sec} would exceed {MAX_SECTOR_PCT*100:.0f}% cap"
    # Preserve cash reserve
    reserve = ctx.equity * CASH_RESERVE_PCT
    if ctx.cash - target_size_dollars < reserve:
        return False, "would breach cash reserve"
    return True, "ok"


def size_new_position(ctx: AllocationContext) -> float:
    """Dollar size for a new entry."""
    return ctx.equity * MAX_POSITION_PCT


def should_trim_for_rebalance(ctx: AllocationContext, ticker: str) -> float:
    """Returns dollars to sell back toward MAX_POSITION_PCT if the position has grown."""
    mv = ctx.current_positions.get(ticker, 0.0)
    if ctx.equity <= 0:
        return 0.0
    weight = mv / ctx.equity
    if weight < REBALANCE_TRIM_PCT:
        return 0.0
    target_mv = ctx.equity * MAX_POSITION_PCT
    return max(0.0, mv - target_mv)


def trailing_stop_triggered(peak_price: float, current_price: float) -> bool:
    if peak_price <= 0:
        return False
    return current_price < peak_price * (1 - TRAILING_STOP_PCT)
