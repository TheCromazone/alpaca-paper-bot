"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, TradeRow } from "@/lib/api";
import { fmtDatetime, fmtUSD } from "@/lib/format";
import { SectionHead } from "@/components/SectionHead";

export default function TradesPage() {
  const { data } = useQuery<TradeRow[]>({
    queryKey: ["trades", 200],
    queryFn: () => api.trades(200),
  });
  const trades = data ?? [];
  const [openId, setOpenId] = useState<number | null>(null);

  return (
    <div className="pt-6">
      <SectionHead
        eyebrow="Trade Journal"
        title="Every order, with reasoning"
        right={<span>{trades.length} records</span>}
      />

      <ul className="rule-thick">
        {trades.map((t) => {
          const isOpen = openId === t.id;
          return (
            <li key={t.id} className="rule-hair">
              <button
                className="w-full text-left py-4 grid grid-cols-12 gap-3 items-baseline hover:bg-paper-deep px-2"
                onClick={() => setOpenId(isOpen ? null : t.id)}
              >
                <div className="col-span-1 mono text-[10px] text-ink-faint uppercase tracking-[0.2em]">
                  {fmtDatetime(t.submitted_at)}
                </div>
                <div className="col-span-1">
                  <span
                    className="smallcaps mono text-[10px] tracking-[0.2em] px-[6px] py-[1px] border border-ink"
                    style={{
                      background: t.side === "buy" ? "#14110f" : "transparent",
                      color: t.side === "buy" ? "#f5efe3" : "#14110f",
                    }}
                  >
                    {t.side}
                  </span>
                </div>
                <div className="col-span-2 display text-2xl">{t.ticker}</div>
                <div className="col-span-1 mono text-xs text-right tabular-nums">
                  {t.qty.toFixed(2)}
                </div>
                <div className="col-span-2 mono text-xs text-right tabular-nums">
                  {fmtUSD(t.price)}
                </div>
                <div className="col-span-2 mono text-xs text-right tabular-nums">
                  {fmtUSD(t.notional, { compact: true })}
                </div>
                <div className="col-span-2 mono text-[11px] text-ink-muted italic truncate">
                  {t.reason ?? (t.dry_run ? "dry run" : "—")}
                </div>
                <div className="col-span-1 text-right mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                  {t.dry_run ? "dry" : t.status}
                </div>
              </button>
              {isOpen && (
                <div className="px-4 pb-5 pt-1 grid grid-cols-12 gap-6">
                  <div className="col-span-12 lg:col-span-7 text-[14px] leading-relaxed">
                    <div className="smallcaps mono text-[10px] tracking-[0.2em] text-ink-faint mb-1">
                      why
                    </div>
                    <p className="italic">{t.reason ?? "—"}</p>
                  </div>
                  <div className="col-span-12 lg:col-span-5">
                    <div className="smallcaps mono text-[10px] tracking-[0.2em] text-ink-faint mb-1">
                      composite score{" "}
                      <span className="text-ink">
                        {t.composite_score?.toFixed(2) ?? "—"}
                      </span>
                    </div>
                    <pre className="mono text-[11px] bg-paper-deep p-3 rule-top rule-bot overflow-x-auto">
                      {JSON.stringify(t.score_breakdown ?? {}, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {!trades.length && (
          <li className="py-12 text-center text-ink-faint italic">
            No trades logged yet.
          </li>
        )}
      </ul>
    </div>
  );
}
