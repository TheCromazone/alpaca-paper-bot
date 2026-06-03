"""One-time backfill: link orphaned sell Decisions to their Trade rows.

Until 2026-06 the synthetic trailing-stop path in bot/main.py created a
Decision (carrying the human-readable "why this sold" reason) but never set
``trade_id`` — so the /trades endpoint, which reads ``Trade.decisions``,
surfaced every synthetic-stop sell with ``reason: null``. The dashboard
showed sells with no rationale.

The forward fix (flush + trade_id) is in bot/main.py. This script repairs the
historical rows: for each orphaned sell Decision (action='sell',
trade_id IS NULL), find the matching sell Trade — same ticker, no decision
yet linked, nearest timestamp (Decision.at ≈ Trade.submitted_at, since both
were created in the same transaction) — and link them.

Only links when the timestamp delta is within MAX_DELTA_SECONDS. Legit
Decision/Trade pairs are created in the same transaction (Δ≈0); a large delta
means the real partner trade was already claimed and the only remaining
candidate is unrelated (e.g. retired-quant RTX duplicates). Those stay
orphaned rather than get a misleading reason.

Idempotent: re-running skips already-linked decisions and never double-claims
a trade. Read-modify-write in a single transaction. Also repairs any prior
mis-link whose delta exceeds the guard (resets trade_id back to NULL).

Usage:
    .venv\\Scripts\\python.exe scripts\\_backfill_sell_decisions.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from bot.db import Decision, SessionLocal, Trade  # noqa: E402

# Legit Decision/Trade pairs are written in the same transaction, so their
# timestamps differ by milliseconds. Anything beyond a few minutes is a
# spurious match against an unrelated trade — refuse it.
MAX_DELTA_SECONDS = 300.0


def _ts(dt) -> float:
    """Epoch seconds for a (possibly tz-naive) datetime; 0.0 if None."""
    if dt is None:
        return 0.0
    return dt.timestamp()


def main() -> int:
    linked = 0
    skipped_no_match = 0
    skipped_too_far = 0
    repaired = 0

    with SessionLocal.begin() as s:
        # Repair pass: undo any prior link whose delta exceeds the guard.
        prior_linked = s.execute(
            select(Decision)
            .where(Decision.action == "sell")
            .where(Decision.trade_id.is_not(None))
        ).scalars().all()
        for d in prior_linked:
            t = d.trade
            if t is not None and abs(_ts(t.submitted_at) - _ts(d.at)) > MAX_DELTA_SECONDS:
                print(
                    f"  UNLINK {d.ticker:6s} dec#{d.id} -x- trade#{t.id} "
                    f"(Δ{abs(_ts(t.submitted_at) - _ts(d.at)):.0f}s > guard) — bad match"
                )
                d.trade_id = None
                repaired += 1

        orphans = s.execute(
            select(Decision)
            .where(Decision.action == "sell")
            .where(Decision.trade_id.is_(None))
            .order_by(Decision.id)
        ).scalars().all()

        if not orphans:
            print("No orphaned sell decisions — nothing to backfill.")
            return 0

        # Candidate sell trades that don't already have a linked decision.
        sell_trades = s.execute(
            select(Trade).where(Trade.side == "sell").order_by(Trade.submitted_at)
        ).scalars().all()
        # A trade is claimable if no Decision currently points at it.
        claimed: set[int] = {
            t.id for t in sell_trades if any(d.trade_id == t.id for d in t.decisions)
        }

        print(f"orphaned sell decisions: {len(orphans)}")
        print(f"sell trades total: {len(sell_trades)} | already-claimed: {len(claimed)}")
        print("-" * 72)

        for d in orphans:
            d_ts = _ts(d.at)
            # Same-ticker, unclaimed trades, ranked by timestamp proximity.
            candidates = [
                t for t in sell_trades
                if t.ticker == d.ticker and t.id not in claimed
            ]
            if not candidates:
                skipped_no_match += 1
                print(f"  SKIP  {d.ticker:6s} dec#{d.id} — no unclaimed sell trade")
                continue
            best = min(candidates, key=lambda t: abs(_ts(t.submitted_at) - d_ts))
            delta = abs(_ts(best.submitted_at) - d_ts)
            if delta > MAX_DELTA_SECONDS:
                skipped_too_far += 1
                print(
                    f"  SKIP  {d.ticker:6s} dec#{d.id} — nearest unclaimed trade "
                    f"is Δ{delta:.0f}s away (> guard); leaving orphaned"
                )
                continue
            d.trade_id = best.id
            claimed.add(best.id)
            linked += 1
            print(
                f"  LINK  {d.ticker:6s} dec#{d.id} -> trade#{best.id} "
                f"(Δ{delta:.1f}s)  reason: {d.reason[:50]}"
            )

    print("-" * 72)
    print(
        f"linked={linked}  repaired_unlinked={repaired}  "
        f"skipped_no_match={skipped_no_match}  skipped_too_far={skipped_too_far}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
