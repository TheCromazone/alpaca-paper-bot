"""Read-only performance audit. Prints LLM run health, trade + position
state, job-failure breakdown, thesis-length distribution, and equity vs SPY
since inception, plus the Codex-era LLMRun ledger.
"""
from __future__ import annotations

import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import asc, desc, func, select  # noqa: E402

from bot.db import (  # noqa: E402
    Decision,
    JobRun,
    LLMRun,
    Position,
    PortfolioSnapshot,
    PriceHistory,
    SessionLocal,
    Trade,
)


def main() -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(days=14)
    s = SessionLocal()

    print("=== LLM runs by routine + status (14d) ===")
    rows = s.execute(
        select(
            LLMRun.routine,
            LLMRun.status,
            func.count(LLMRun.id),
            func.sum(LLMRun.input_tokens),
            func.sum(LLMRun.output_tokens),
            func.sum(LLMRun.usd_cost),
            func.avg(LLMRun.tool_calls),
        )
        .where(LLMRun.started_at >= cutoff)
        .group_by(LLMRun.routine, LLMRun.status)
        .order_by(LLMRun.routine, LLMRun.status)
    ).all()
    print(f"{'routine':<14}{'status':<14}{'n':>4}{'tok_in':>12}{'tok_out':>10}{'usd':>8}{'tools_avg':>10}")
    for r in rows:
        print(
            f"{r[0]:<14}{r[1]:<14}{r[2]:>4}"
            f"{r[3] or 0:>12}{r[4] or 0:>10}"
            f"{(r[5] or 0.0):>8.2f}{(r[6] or 0.0):>10.1f}"
        )

    print("\n=== LLM cost / cache hit by day (14d) ===")
    rows = s.execute(
        select(
            func.date(LLMRun.started_at).label("d"),
            func.count(LLMRun.id),
            func.sum(LLMRun.input_tokens),
            func.sum(LLMRun.cache_read_tokens),
            func.sum(LLMRun.usd_cost),
            func.sum(LLMRun.tool_calls),
        )
        .where(LLMRun.started_at >= cutoff)
        .group_by("d")
        .order_by("d")
    ).all()
    print(f"{'date':<12}{'runs':>5}{'in_tok':>12}{'cache_r':>10}{'usd':>8}{'tools':>7}")
    for r in rows:
        print(
            f"{str(r[0]):<12}{r[1]:>5}"
            f"{r[2] or 0:>12}{r[3] or 0:>10}"
            f"{(r[4] or 0.0):>8.2f}{r[5] or 0:>7}"
        )

    print("\n=== Failed LLM runs (last 15 of 14d) ===")
    fails = s.execute(
        select(LLMRun)
        .where(LLMRun.status != "ok")
        .where(LLMRun.started_at >= cutoff)
        .order_by(desc(LLMRun.started_at))
    ).scalars().all()
    for r in fails[:15]:
        e = (r.error or "")[:90]
        print(f"{r.started_at}  {r.routine:>14}  {r.status:>12}  {e}")
    print(f"total failures (14d): {len(fails)}")

    print("\n=== Trades + portfolio (14d) ===")
    ts = s.execute(
        select(Trade)
        .where(Trade.submitted_at >= cutoff)
        .order_by(desc(Trade.submitted_at))
    ).scalars().all()
    print(f"trades_14d = {len(ts)}")
    buys = [t for t in ts if t.side == "buy"]
    sells = [t for t in ts if t.side == "sell"]
    print(f"buys = {len(buys)} | sells = {len(sells)}")
    syms = Counter(t.ticker for t in ts)
    print(f"top symbols (14d): {dict(syms.most_common(10))}")

    ps = s.execute(select(Position)).scalars().all()
    print(f"open_positions = {len(ps)}")
    pcts = [
        (getattr(p, "ticker", getattr(p, "symbol", "?")),
         ((p.market_price / p.avg_cost - 1) * 100) if p.avg_cost else 0.0)
        for p in ps
    ]
    pcts.sort(key=lambda x: x[1])
    print(f"worst3: {pcts[:3]}")
    print(f"best3: {list(reversed(pcts[-3:]))}")

    print("\n=== Job failures (14d) ===")
    rows = s.execute(
        select(JobRun.job_name, JobRun.status, func.count(JobRun.id))
        .where(JobRun.started_at >= cutoff)
        .group_by(JobRun.job_name, JobRun.status)
        .order_by(JobRun.job_name, JobRun.status)
    ).all()
    for r in rows:
        print(f"{r[0]:<28}{r[1]:<14}{r[2]:>4}")

    print("\n=== Decision thesis length distribution (14d) ===")
    ds = s.execute(select(Decision).where(Decision.created_at >= cutoff)).scalars().all()
    buckets: Counter = Counter()
    for d in ds:
        L = len(d.reason or "")
        if L == 0:
            b = "0"
        elif L < 50:
            b = "1-50"
        elif L < 120:
            b = "50-120"
        elif L < 300:
            b = "120-300"
        else:
            b = "300+"
        buckets[b] += 1
    print(f"length_buckets: {dict(buckets)} | total={len(ds)}")

    print("\n=== Equity vs SPY since inception ===")
    snaps = s.execute(
        select(PortfolioSnapshot).order_by(asc(PortfolioSnapshot.captured_at))
    ).scalars().all()
    print(f"snapshots = {len(snaps)}")
    if snaps:
        f0, fl = snaps[0], snaps[-1]
        print(f"first {f0.captured_at} eq={f0.equity:.2f}")
        print(f"last  {fl.captured_at} eq={fl.equity:.2f}")
        if f0.equity:
            print(f"bot_return = {(fl.equity / f0.equity - 1) * 100:+.2f}%")
    spy = s.execute(
        select(PriceHistory)
        .where(PriceHistory.symbol == "SPY")
        .order_by(asc(PriceHistory.captured_at))
    ).scalars().all()
    if len(spy) >= 2:
        print(f"SPY first {spy[0].captured_at} close={spy[0].close:.2f}")
        print(f"SPY last  {spy[-1].captured_at} close={spy[-1].close:.2f}")
        print(f"SPY return = {(spy[-1].close / spy[0].close - 1) * 100:+.2f}%")

    print("\n=== Codex era (May 20+) LLMRun ledger ===")
    codex_cut = datetime(2026, 5, 20, tzinfo=timezone.utc)
    crows = s.execute(
        select(LLMRun)
        .where(LLMRun.started_at >= codex_cut)
        .order_by(asc(LLMRun.started_at))
    ).scalars().all()
    for r in crows:
        print(
            f"{r.started_at}  {r.routine:>14}  {r.status:>12}  "
            f"tools={r.tool_calls:>3}  in={r.input_tokens:>6}  out={r.output_tokens:>5}  "
            f"err={(r.error or '')[:60]}"
        )


if __name__ == "__main__":
    main()
