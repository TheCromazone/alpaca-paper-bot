"""Per-tick strategy: turn aggregated signals + account state into trade decisions.

Decisions are persisted to the Decision table with a human-readable `reason`
string so the dashboard can show a "why" panel next to every trade.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from loguru import logger

from bot.config import (
    CLOSE_SCORE_THRESHOLD,
    DIP_ADD_BOOST,
    DIP_ADD_DRAWDOWN,
    OPEN_SCORE_THRESHOLD,
    TRAILING_STOP_PCT,
    FIXED_INCOME_FLOOR,
    FIXED_INCOME_UNIVERSE,
)
from bot.db import Decision, Position, SessionLocal
from bot.risk import (
    AllocationContext,
    can_open_new,
    should_trim_for_rebalance,
    size_new_position,
    trailing_stop_triggered,
    sector,
)
from bot.signals.aggregator import ScoreBreakdown


@dataclass
class PlannedOrder:
    ticker: str
    side: str          # buy | sell
    dollar_size: float
    reason: str
    score: ScoreBreakdown
    action_label: str  # buy | sell | add | trim | stop | rebalance


def _context_from_positions(equity: float, cash: float, bp: float,
                            positions: dict[str, Position]) -> AllocationContext:
    return AllocationContext(
        equity=equity,
        cash=cash,
        buying_power=bp,
        current_positions={t: p.market_value for t, p in positions.items()},
    )


def _reason_for_score(score: ScoreBreakdown) -> str:
    parts = []
    c = score.components
    if c.get("news", {}).get("headlines", 0) > 0:
        parts.append(
            f"news avg_vader {c['news'].get('avg_vader', 0):+.2f} over "
            f"{c['news']['headlines']} headlines ({score.news:+.2f}σ)"
        )
    pol = c.get("politician", {})
    if pol.get("trades", 0) > 0:
        parts.append(f"{pol['trades']} politician trade(s), net ${pol['net_usd']:,.0f}")
    inv = c.get("investor", {})
    if inv.get("changes", 0) > 0:
        parts.append(f"{inv['changes']} 13F change(s), net ${inv['net_usd']:,.0f}")
    mom = c.get("momentum", {})
    if mom.get("bars", 21) >= 21:
        parts.append(
            f"20d return {mom.get('ret_20d', 0):+.1%} vs SPY {mom.get('vs_spy', 0):+.1%}"
        )
    dip = c.get("dip", {})
    if dip.get("drawdown", 0) < -0.25:
        parts.append(f"drawdown {dip['drawdown']:.0%} from 52w high")
    if not parts:
        parts.append("no strong signals")
    return "; ".join(parts) + f" | composite={score.composite:+.2f}"


def plan(scores: list[ScoreBreakdown], equity: float, cash: float,
         buying_power: float) -> list[PlannedOrder]:
    """Produce a list of orders. Persists Decision rows as a side effect."""
    with SessionLocal() as s:
        positions: dict[str, Position] = {p.ticker: p for p in s.query(Position).all()}
    ctx = _context_from_positions(equity, cash, buying_power, positions)

    orders: list[PlannedOrder] = []
    decisions: list[Decision] = []
    score_by_ticker: dict[str, ScoreBreakdown] = {sb.ticker: sb for sb in scores}

    # ---- 1. Evaluate existing positions: trailing stop, exit signal, or trim rebalance ----
    for ticker, pos in positions.items():
        sb = score_by_ticker.get(ticker)
        reason_base = _reason_for_score(sb) if sb else "no score available"

        # Trailing stop wins over everything.
        if trailing_stop_triggered(pos.peak_price, pos.market_price):
            r = f"trailing stop: price {pos.market_price:.2f} fell >{TRAILING_STOP_PCT*100:.0f}% from peak {pos.peak_price:.2f}"
            orders.append(PlannedOrder(ticker, "sell", pos.market_value, r, sb, "stop"))
            decisions.append(Decision(
                ticker=ticker, action="sell", composite_score=(sb.composite if sb else 0),
                score_breakdown=(sb.components if sb else {}), reason=r,
            ))
            continue

        if sb and sb.composite < CLOSE_SCORE_THRESHOLD:
            r = f"exit signal: {reason_base}"
            orders.append(PlannedOrder(ticker, "sell", pos.market_value, r, sb, "sell"))
            decisions.append(Decision(
                ticker=ticker, action="sell", composite_score=sb.composite,
                score_breakdown=sb.components, reason=r,
            ))
            continue

        # Rebalance trim
        trim_dollars = should_trim_for_rebalance(ctx, ticker)
        if trim_dollars > 0:
            r = f"rebalance trim: position is {pos.market_value/ctx.equity:.1%} of portfolio"
            orders.append(PlannedOrder(ticker, "sell", trim_dollars, r, sb, "trim"))
            decisions.append(Decision(
                ticker=ticker, action="sell", composite_score=(sb.composite if sb else 0),
                score_breakdown=(sb.components if sb else {}), reason=r,
            ))
            continue

        # Dip-add to winning thesis
        drawdown_from_cost = (pos.market_price / pos.avg_cost) - 1 if pos.avg_cost else 0
        if drawdown_from_cost <= -DIP_ADD_DRAWDOWN and sb and sb.composite > 0:
            add_dollars = pos.market_value * DIP_ADD_BOOST
            if ctx.cash >= add_dollars:
                r = f"dip add: -{abs(drawdown_from_cost):.0%} from cost but thesis still positive. {reason_base}"
                orders.append(PlannedOrder(ticker, "buy", add_dollars, r, sb, "add"))
                decisions.append(Decision(
                    ticker=ticker, action="add", composite_score=sb.composite,
                    score_breakdown=sb.components, reason=r,
                ))
                continue

        # Otherwise hold — log decision
        decisions.append(Decision(
            ticker=ticker, action="hold",
            composite_score=(sb.composite if sb else 0),
            score_breakdown=(sb.components if sb else {}),
            reason=f"hold: {reason_base}",
        ))

    # ---- 2. Evaluate new entries from top composite scores ----
    candidates = sorted(
        [sb for sb in scores
         if sb.ticker not in positions
         and sb.composite > OPEN_SCORE_THRESHOLD
         and sb.ticker not in FIXED_INCOME_UNIVERSE],  # bonds get their own floor logic
        key=lambda x: x.composite, reverse=True,
    )
    for sb in candidates:
        ok, why = can_open_new(ctx, sb.ticker)
        if not ok:
            continue
        size = size_new_position(ctx)
        if size <= 0:
            break
        r = f"open: {_reason_for_score(sb)}"
        orders.append(PlannedOrder(sb.ticker, "buy", size, r, sb, "buy"))
        decisions.append(Decision(
            ticker=sb.ticker, action="buy", composite_score=sb.composite,
            score_breakdown=sb.components, reason=r,
        ))
        # Reserve this cash in our context so sector/cash checks are consistent.
        ctx.cash -= size
        ctx.current_positions[sb.ticker] = size

    # ---- 3. Fixed-income floor maintenance ----
    fi_mv = sum(positions[t].market_value for t in FIXED_INCOME_UNIVERSE if t in positions)
    fi_target = equity * FIXED_INCOME_FLOOR
    if fi_mv < fi_target and ctx.cash > 0:
        deficit = min(fi_target - fi_mv, ctx.cash * 0.9)
        pick = "AGG"  # default: broad aggregate bond
        r = f"fixed-income floor: bonds at {fi_mv/equity:.1%} below {FIXED_INCOME_FLOOR:.0%} target"
        orders.append(PlannedOrder(pick, "buy", deficit, r, None, "buy"))
        decisions.append(Decision(
            ticker=pick, action="buy", composite_score=0,
            score_breakdown={"kind": "fixed_income_floor"}, reason=r,
        ))

    with SessionLocal.begin() as s:
        for d in decisions:
            s.add(d)
    logger.info("strategy planned {} orders across {} decisions", len(orders), len(decisions))
    return orders
