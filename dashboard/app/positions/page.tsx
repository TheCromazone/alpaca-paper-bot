"use client";

import { useQuery } from "@tanstack/react-query";
import { api, PositionRow } from "@/lib/api";
import { fmtPct, fmtUSD } from "@/lib/format";
import { SectionHead } from "@/components/SectionHead";
import { PnlLabel } from "@/components/PnlLabel";

export default function PositionsPage() {
  const { data } = useQuery<PositionRow[]>({
    queryKey: ["positions"],
    queryFn: api.positions,
  });
  const rows = data ?? [];

  return (
    <div className="pt-6">
      <SectionHead
        eyebrow="Holdings"
        title="The Book"
        right={<span>{rows.length} open positions</span>}
      />

      <div className="rule-thick">
        <table className="w-full mono text-[12px]">
          <thead>
            <tr className="smallcaps text-[10px] tracking-[0.2em] text-ink-faint rule-bot">
              <Th className="text-left">Ticker</Th>
              <Th className="text-left">Sector</Th>
              <Th className="text-right">Qty</Th>
              <Th className="text-right">Avg Cost</Th>
              <Th className="text-right">Price</Th>
              <Th className="text-right">Mkt Value</Th>
              <Th className="text-right">P&amp;L $</Th>
              <Th className="text-right">P&amp;L %</Th>
              <Th className="text-right">Stop</Th>
              <Th className="w-[120px]">To Stop</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.ticker} className="rule-hair hover:bg-paper-deep">
                <td className="py-2 display text-lg">{p.ticker}</td>
                <td className="py-2 text-ink-muted">{p.sector}</td>
                <td className="py-2 text-right tabular-nums">{p.qty}</td>
                <td className="py-2 text-right tabular-nums">{fmtUSD(p.avg_cost)}</td>
                <td className="py-2 text-right tabular-nums">{fmtUSD(p.market_price)}</td>
                <td className="py-2 text-right tabular-nums">
                  {fmtUSD(p.market_value, { compact: true })}
                </td>
                <td className="py-2 text-right tabular-nums">
                  <PnlLabel value={p.unrealized_pnl}>
                    {fmtUSD(p.unrealized_pnl, { sign: true })}
                  </PnlLabel>
                </td>
                <td className="py-2 text-right tabular-nums">
                  <PnlLabel value={p.unrealized_pct}>
                    {fmtPct(p.unrealized_pct)}
                  </PnlLabel>
                </td>
                <td className="py-2 text-right tabular-nums text-ink-muted">
                  {fmtUSD(p.stop_price)}
                </td>
                <td className="py-2">
                  <StopBar pct={p.distance_to_stop_pct} />
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={10} className="py-12 text-center text-ink-faint italic">
                  No open positions. The bot will seed a book once market hours hit.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`py-2 px-1 font-normal ${className}`}>
      {children}
    </th>
  );
}

function StopBar({ pct }: { pct: number }) {
  // pct represents distance of current price above the stop (0 = at stop, 0.07 = 7% above)
  // 0.07 is "safe". >0.07 means peak went up. <=0 means stop is hit.
  const clamped = Math.max(0, Math.min(0.15, pct));
  const width = (clamped / 0.15) * 100;
  const color =
    pct <= 0.02 ? "#7a1616" : pct <= 0.05 ? "#a26a00" : "#1f4d2e";
  return (
    <div className="relative h-[6px] bg-paper-deep border border-rule-hair">
      <div
        className="absolute top-0 left-0 h-full"
        style={{ width: `${width}%`, background: color }}
      />
      <div className="absolute -top-[1px] bottom-[-1px] w-[1px] bg-ink" style={{ left: `${(0.07 / 0.15) * 100}%` }} />
    </div>
  );
}
