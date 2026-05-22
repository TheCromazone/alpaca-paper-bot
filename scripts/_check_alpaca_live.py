"""Quick comparison: live Alpaca state vs local DB state.

Run as `.venv\\Scripts\\python.exe scripts\\_check_alpaca_live.py` whenever
you suspect the dashboard is showing stale numbers. Prints both side by
side so you can see which one is lying.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from datetime import datetime, timezone
from sqlalchemy import desc, select
from bot.alpaca_client import AlpacaClient
from bot.db import PortfolioSnapshot, Position, SessionLocal, Trade

c = AlpacaClient()
acct = c.account()
positions = c.positions()
oo = c.open_orders()

print("=" * 70)
print("LIVE ALPACA")
print("=" * 70)
print(f"Equity     ${acct.equity:>12,.2f}")
print(f"Cash       ${acct.cash:>12,.2f}")
print(f"BP         ${acct.buying_power:>12,.2f}")
print()
print(f"Positions ({len(positions)}):")
for p in sorted(positions, key=lambda p: -p.market_value):
    print(
        f"  {p.symbol:6s} qty={p.qty:>10.4f} avg=${p.avg_entry_price:>9.2f} "
        f"mkt=${p.market_price:>9.2f} mv=${p.market_value:>11.2f} "
        f"pl=${p.unrealized_pl:>+10.2f}"
    )
print()
print(f"Open orders ({len(oo)}):")
for o in oo[:25]:
    sub = (o.get("submitted_at") or "")[:19]
    print(
        f"  {o['symbol']:6s} {o['side']:4s} {o['type']:14s} "
        f"qty={o['qty']:>9.2f} status={o['status']:10s} {sub}"
    )

print()
print("=" * 70)
print("LOCAL DB")
print("=" * 70)

with SessionLocal() as s:
    snap = s.scalars(
        select(PortfolioSnapshot).order_by(desc(PortfolioSnapshot.at)).limit(1)
    ).first()
    if snap:
        age_min = (datetime.now(timezone.utc) - snap.at.replace(tzinfo=timezone.utc)).total_seconds() / 60
        print(
            f"PortfolioSnapshot: equity ${snap.equity:,.2f} cash ${snap.cash:,.2f} "
            f"BP ${snap.buying_power:,.2f}  ({age_min:.1f}m old)"
        )
    else:
        print("No PortfolioSnapshot rows.")

    rows = s.scalars(select(Position).order_by(desc(Position.market_value))).all()
    print(f"Positions table ({len(rows)}):")
    for p in rows[:25]:
        age_min = (
            (datetime.now(timezone.utc) - p.updated_at.replace(tzinfo=timezone.utc)).total_seconds() / 60
            if p.updated_at else None
        )
        print(
            f"  {p.ticker:6s} qty={p.qty:>10.4f} avg=${p.avg_cost:>9.2f} "
            f"mkt=${p.market_price:>9.2f} mv=${p.market_value:>11.2f} "
            f"pl=${p.unrealized_pnl:>+10.2f} age={age_min:.0f}m" if age_min else ""
        )

    print()
    print("Recent trades (last 10):")
    trades = s.scalars(select(Trade).order_by(desc(Trade.submitted_at)).limit(10)).all()
    for t in trades:
        ts = t.submitted_at.isoformat(timespec="seconds") if t.submitted_at else "?"
        print(
            f"  {ts}  {t.side.upper():4s} {t.ticker:6s} qty={t.qty:>9.4f} "
            f"@ ${t.price:>8.2f}  status={t.status}  dry={'Y' if t.dry_run else 'N'}"
        )
