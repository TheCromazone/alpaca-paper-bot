"""Performance analytics — read-only computations over the trading DB.

Shared by the API (``/performance/*``) and the LLM tool layer
(``get_performance_stats``) so the dashboard, the API, and the weekly_review
routine all derive the same numbers from one place.

Two views:

* ``benchmark_since_inception`` — bot total return vs SPY total return + alpha,
  from the ``PortfolioSnapshot`` equity series (every row carries ``spy_close``).
  This is the project's headline KPI: did the bot beat the market.
* ``realized_performance`` — FIFO-matched realized P&L on closed / trimmed lots,
  with hit rate, profit factor, avg win/loss, and best/worst trade. Each closing
  lot is paired with its entry thesis and exit reason so the weekly_review can
  see which theses actually worked.

Everything here is strictly read-only — no Alpaca calls, no order placement.
The functions take an open SQLAlchemy session so callers control the lifecycle.
"""
from __future__ import annotations

from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import asc, or_, select
from sqlalchemy.orm import Session

from bot.db import PortfolioSnapshot, Signal, Trade


def _aware(dt: datetime | None) -> datetime | None:
    """Coerce a possibly tz-naive datetime (SQLite strips tz) to UTC-aware."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def benchmark_since_inception(
    session: Session, *, since: datetime | None = None
) -> dict[str, Any]:
    """Bot total return vs SPY total return since the first snapshot.

    Returns a dict with inception/latest timestamps, both returns in percent,
    and ``alpha_pct`` (bot − spy, in percentage points). ``available`` is False
    when there aren't yet two snapshots to compare.
    """
    q = select(PortfolioSnapshot).order_by(asc(PortfolioSnapshot.at))
    if since is not None:
        q = q.where(PortfolioSnapshot.at >= since)
    rows = session.scalars(q).all()
    if len(rows) < 2:
        return {"available": False, "note": "need ≥2 snapshots to compute a return"}

    first, last = rows[0], rows[-1]
    bot_return_pct = (
        (last.equity / first.equity - 1.0) * 100.0 if first.equity else 0.0
    )
    spy_return_pct: float | None = None
    if first.spy_close and last.spy_close:
        spy_return_pct = (last.spy_close / first.spy_close - 1.0) * 100.0
    alpha_pct = (
        bot_return_pct - spy_return_pct if spy_return_pct is not None else None
    )
    return {
        "available": True,
        "inception_at": _aware(first.at).isoformat() if first.at else None,
        "as_of": _aware(last.at).isoformat() if last.at else None,
        "start_equity": round(first.equity, 2),
        "equity": round(last.equity, 2),
        "bot_return_pct": round(bot_return_pct, 2),
        "spy_return_pct": round(spy_return_pct, 2) if spy_return_pct is not None else None,
        "alpha_pct": round(alpha_pct, 2) if alpha_pct is not None else None,
        "beating_market": (alpha_pct is not None and alpha_pct > 0),
    }


def _fifo_closed_lots(
    session: Session, *, since: datetime | None = None
) -> list[dict[str, Any]]:
    """Walk every trade chronologically and FIFO-match sells against buy lots.

    Returns the chronological list of closed-lot dicts. Shared by
    ``realized_performance`` (aggregate stats) and ``signal_attribution``
    (per-signal-kind rollup) so both derive from one matching pass.
    """
    # Simulated and never-filled orders are not realized P&L. dry_run rows
    # come from smoke tests; 'canceled' is stamped by the sync job's fill
    # reconciliation when Alpaca reports a terminal no-fill state. Rows the
    # reconciler hasn't seen yet remain 'submitted' and still count, as before.
    q = (
        select(Trade)
        .where(Trade.dry_run == False)  # noqa: E712 — SQLAlchemy comparison
        .where(or_(Trade.status.is_(None),
                   Trade.status.notin_(("canceled", "rejected"))))
        .order_by(asc(Trade.submitted_at))
    )
    if since is not None:
        q = q.where(Trade.submitted_at >= since)
    trades = session.scalars(q).all()

    lots: dict[str, deque] = defaultdict(deque)  # ticker -> deque[[qty, price, thesis, at]]
    closed: list[dict[str, Any]] = []

    for t in trades:
        decision = next((d for d in t.decisions), None)
        reason = decision.reason if decision else None
        if t.side == "buy":
            lots[t.ticker].append([t.qty, t.price, reason, _aware(t.submitted_at)])
        elif t.side == "sell":
            remaining = t.qty
            while remaining > 1e-6 and lots[t.ticker]:
                lot = lots[t.ticker][0]
                take = min(remaining, lot[0])
                pnl = (t.price - lot[1]) * take
                pnl_pct = (t.price / lot[1] - 1.0) * 100.0 if lot[1] else 0.0
                closed.append({
                    "ticker": t.ticker,
                    "qty": round(take, 4),
                    "entry_price": round(lot[1], 2),
                    "exit_price": round(t.price, 2),
                    "entry_at": lot[3].isoformat() if lot[3] else None,
                    "exit_at": _aware(t.submitted_at).isoformat() if t.submitted_at else None,
                    "pnl": round(pnl, 2),
                    "pnl_pct": round(pnl_pct, 2),
                    "entry_thesis": lot[2],
                    "exit_reason": reason,
                    # tz-aware datetime for in-module consumers (attribution
                    # windowing). Underscore-prefixed keys are stripped before
                    # lots are surfaced through realized_performance.
                    "_entry_dt": lot[3],
                })
                lot[0] -= take
                remaining -= take
                if lot[0] <= 1e-6:
                    lots[t.ticker].popleft()
    return closed


def realized_performance(
    session: Session, *, since: datetime | None = None, recent_limit: int = 20
) -> dict[str, Any]:
    """FIFO-matched realized P&L on closed / trimmed lots.

    Walks every trade chronologically, building a FIFO queue of open buy lots
    per ticker. Each sell consumes lots oldest-first and books realized P&L,
    pairing the closing lot with its entry thesis and the sell's exit reason.

    Returns aggregate stats plus the ``recent_limit`` most recent closed lots.
    Unrealized P&L on still-open lots is intentionally excluded — that's what
    the benchmark / live portfolio view is for.
    """
    closed = [
        {k: v for k, v in lot.items() if not k.startswith("_")}
        for lot in _fifo_closed_lots(session, since=since)
    ]

    wins = [c for c in closed if c["pnl"] > 0]
    losses = [c for c in closed if c["pnl"] <= 0]
    gross_profit = sum(c["pnl"] for c in wins)
    gross_loss = sum(c["pnl"] for c in losses)  # ≤ 0
    realized_pnl = gross_profit + gross_loss
    n = len(closed)

    best = max(closed, key=lambda c: c["pnl"], default=None)
    worst = min(closed, key=lambda c: c["pnl"], default=None)

    return {
        "closed_lots": n,
        "wins": len(wins),
        "losses": len(losses),
        "hit_rate_pct": round(100.0 * len(wins) / n, 1) if n else 0.0,
        "realized_pnl": round(realized_pnl, 2),
        "gross_profit": round(gross_profit, 2),
        "gross_loss": round(gross_loss, 2),
        # profit factor = gross profit / |gross loss|; None when no losses yet.
        "profit_factor": round(gross_profit / abs(gross_loss), 2) if gross_loss < 0 else None,
        "avg_win": round(gross_profit / len(wins), 2) if wins else 0.0,
        "avg_loss": round(gross_loss / len(losses), 2) if losses else 0.0,
        # Percentage-return views of the same (additive fields — the dashboard
        # types depend on the dollar fields above; never rename/remove those).
        "avg_win_pct": round(sum(c["pnl_pct"] for c in wins) / len(wins), 2) if wins else 0.0,
        "avg_loss_pct": round(sum(c["pnl_pct"] for c in losses) / len(losses), 2) if losses else 0.0,
        "best_trade": best,
        "worst_trade": worst,
        "recent": list(reversed(closed[-recent_limit:])),
    }


def signal_attribution(
    session: Session,
    *,
    since: datetime | None = None,
    lookback_days: int = 14,
) -> dict[str, dict[str, Any]]:
    """Per-signal-kind attribution of realized P&L (best-effort co-occurrence).

    Theses aren't machine-linked to signals, so we approximate: for each
    FIFO-closed lot, find the distinct ``Signal.kind`` values (politician /
    investor / …) recorded on that ticker in the ``lookback_days`` window
    *before* the lot's entry. Each kind found shares full credit for the lot
    (a lot backed by both a politician and a 13F signal counts in both
    buckets); lots with no matching signal land in ``"unattributed"``.

    Returns ``{kind: {lots, wins, pnl, hit_rate_pct}}``. Co-occurrence, not
    causation — read it as "how do trades near signal-flow perform", nothing
    stronger.
    """
    closed = _fifo_closed_lots(session, since=since)
    buckets: dict[str, dict[str, Any]] = {}
    for lot in closed:
        entry_dt = lot.get("_entry_dt")
        kinds: set[str] = set()
        if entry_dt is not None:
            rows = session.execute(
                select(Signal.kind)
                .where(Signal.ticker == lot["ticker"])
                .where(Signal.as_of >= entry_dt - timedelta(days=lookback_days))
                .where(Signal.as_of <= entry_dt)
                .distinct()
            ).scalars().all()
            kinds = {k for k in rows if k}
        for kind in kinds or {"unattributed"}:
            b = buckets.setdefault(kind, {"lots": 0, "wins": 0, "pnl": 0.0})
            b["lots"] += 1
            if lot["pnl"] > 0:
                b["wins"] += 1
            b["pnl"] += lot["pnl"]
    return {
        kind: {
            "lots": b["lots"],
            "wins": b["wins"],
            "pnl": round(b["pnl"], 2),
            "hit_rate_pct": round(100.0 * b["wins"] / b["lots"], 1) if b["lots"] else 0.0,
        }
        for kind, b in sorted(buckets.items(), key=lambda kv: -kv[1]["pnl"])
    }
