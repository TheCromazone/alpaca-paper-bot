"""Quick post-mortem of last 5 trading days under the quant strategy.

Pulls trades, decisions, equity snapshots, and position lifecycle from the DB
so we can see what the bot actually did and where it leaked money before
flipping over to the LLM strategy.
"""
import sys
from pathlib import Path
from datetime import datetime, timedelta, timezone
from collections import Counter

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import desc, select, func
from bot.db import (
    SessionLocal,
    Trade,
    Decision,
    PortfolioSnapshot,
    Position,
    JobRun,
)


def main() -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(days=8)

    with SessionLocal() as s:
        # ---- Equity curve ----
        snaps = s.scalars(
            select(PortfolioSnapshot)
            .where(PortfolioSnapshot.at >= cutoff)
            .order_by(PortfolioSnapshot.at)
        ).all()
        if snaps:
            first = snaps[0]
            last = snaps[-1]
            print("=== Equity curve (last 8 days) ===")
            print(f"  first @ {first.at.isoformat(timespec='minutes')}: equity=${first.equity:.2f} cash=${first.cash:.2f} spy=${first.spy_close}")
            print(f"  last  @ {last.at.isoformat(timespec='minutes')}: equity=${last.equity:.2f} cash=${last.cash:.2f} spy=${last.spy_close}")
            chg_usd = last.equity - first.equity
            chg_pct = chg_usd / first.equity if first.equity else 0
            print(f"  delta_equity: ${chg_usd:+.2f} ({chg_pct:+.2%})")
            if first.spy_close and last.spy_close:
                spy_chg = (last.spy_close / first.spy_close) - 1
                print(f"  delta_spy:    {spy_chg:+.2%}")
                print(f"  alpha:   {(chg_pct - spy_chg):+.2%}")

        # ---- Trades ----
        trades = s.scalars(
            select(Trade)
            .where(Trade.submitted_at >= cutoff)
            .order_by(Trade.submitted_at)
        ).all()
        print(f"\n=== Trades ({len(trades)} in last 8 days) ===")

        by_ticker: Counter[str] = Counter()
        by_side: Counter[str] = Counter()
        by_status: Counter[str] = Counter()
        rejected = 0
        gross_buy_notional = 0.0
        gross_sell_notional = 0.0
        for t in trades:
            by_ticker[t.ticker] += 1
            by_side[t.side] += 1
            by_status[t.status] += 1
            if t.status in ("rejected", "failed"):
                rejected += 1
            if t.side == "buy":
                gross_buy_notional += t.notional
            else:
                gross_sell_notional += t.notional

        print("  by ticker:", dict(by_ticker.most_common()))
        print("  by side:  ", dict(by_side))
        print("  by status:", dict(by_status))
        print(f"  gross buy notional:  ${gross_buy_notional:,.2f}")
        print(f"  gross sell notional: ${gross_sell_notional:,.2f}")
        print(f"  rejected count:      {rejected}")

        if trades:
            print(f"\n  First 5 + last 5 trades:")
            for t in (trades[:5] + (["..."] if len(trades) > 10 else []) + trades[-5:]):
                if t == "...":
                    print("    …")
                    continue
                print(f"    {t.submitted_at.isoformat(timespec='minutes')} {t.side:4s} {t.ticker:6s} qty={t.qty:>8.2f} @ ${t.price:>7.2f} = ${t.notional:>9.2f} {t.status}")

        # ---- Decisions: hold vs action ratio ----
        decisions = s.execute(
            select(Decision.action, func.count())
            .where(Decision.at >= cutoff)
            .group_by(Decision.action)
        ).all()
        print(f"\n=== Decision distribution (last 8 days) ===")
        for action, count in sorted(decisions, key=lambda x: -x[1]):
            print(f"  {action:8s} {count}")

        # ---- Composite score histogram ----
        scores = s.scalars(
            select(Decision.composite_score)
            .where(Decision.at >= cutoff)
        ).all()
        if scores:
            buckets = {
                ">+1.0":   0, "+0.5..+1.0": 0, "0..+0.5": 0,
                "-0.5..0": 0, "-1.0..-0.5": 0, "<-1.0": 0,
            }
            for sc in scores:
                if sc > 1.0: buckets[">+1.0"] += 1
                elif sc > 0.5: buckets["+0.5..+1.0"] += 1
                elif sc > 0: buckets["0..+0.5"] += 1
                elif sc > -0.5: buckets["-0.5..0"] += 1
                elif sc > -1.0: buckets["-1.0..-0.5"] += 1
                else: buckets["<-1.0"] += 1
            print(f"\n=== Composite score buckets ({len(scores)} decisions) ===")
            for k, v in buckets.items():
                pct = 100 * v / len(scores)
                bar = "#" * int(pct / 2)
                print(f"  {k:12s} {v:>5d}  {pct:5.1f}%  {bar}")
            min_s = min(scores)
            max_s = max(scores)
            print(f"  min={min_s:+.3f} max={max_s:+.3f}")
            print(f"  pct above +1.0: {100*sum(1 for s in scores if s>1.0)/len(scores):.2f}%")
            print(f"  pct below -1.0: {100*sum(1 for s in scores if s<-1.0)/len(scores):.2f}%")

        # ---- Current positions ----
        positions = s.scalars(select(Position)).all()
        print(f"\n=== Live positions ({len(positions)}) ===")
        total_unreal = 0.0
        for p in sorted(positions, key=lambda x: -x.unrealized_pnl):
            total_unreal += p.unrealized_pnl
            pct = ((p.market_price / p.avg_cost) - 1) if p.avg_cost else 0
            print(f"  {p.ticker:6s} qty={p.qty:>8.4f} cost=${p.avg_cost:>7.2f} mkt=${p.market_price:>7.2f} {pct:>+6.1%} unreal=${p.unrealized_pnl:>+8.2f}")
        print(f"  total unrealized: ${total_unreal:+.2f}")

        # ---- Job run failures ----
        failed_jobs = s.scalars(
            select(JobRun)
            .where(JobRun.started_at >= cutoff)
            .where(JobRun.status == "failed")
            .order_by(desc(JobRun.started_at))
            .limit(20)
        ).all()
        print(f"\n=== Failed job runs (last 8 days, up to 20) ===")
        if not failed_jobs:
            print("  none")
        for j in failed_jobs:
            print(f"  {j.started_at.isoformat(timespec='minutes')} {j.job_name:24s} {(j.message or '')[:100]}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
