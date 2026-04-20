"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, SignalRow } from "@/lib/api";
import { SectionHead } from "@/components/SectionHead";
import { fmtDatetime, fmtUSDShort } from "@/lib/format";

export default function SignalsPage() {
  const [filter, setFilter] = useState<"all" | "politician" | "investor">("all");

  const { data } = useQuery<SignalRow[]>({
    queryKey: ["signals", 200, filter],
    queryFn: () => api.signals(200, filter === "all" ? undefined : filter),
  });
  const signals = data ?? [];

  return (
    <div className="pt-6">
      <SectionHead
        eyebrow="Insider Desk"
        title="Who is buying what"
        right={
          <div className="flex gap-3 smallcaps tracking-[0.2em] mono text-[10px]">
            <FilterBtn on={filter === "all"} onClick={() => setFilter("all")}>
              all
            </FilterBtn>
            <FilterBtn on={filter === "politician"} onClick={() => setFilter("politician")}>
              politicians
            </FilterBtn>
            <FilterBtn on={filter === "investor"} onClick={() => setFilter("investor")}>
              13F whales
            </FilterBtn>
          </div>
        }
      />

      <div className="rule-thick">
        <table className="w-full mono text-[12px]">
          <thead>
            <tr className="smallcaps text-[10px] tracking-[0.2em] text-ink-faint rule-bot">
              <th className="py-2 px-1 text-left font-normal">When</th>
              <th className="py-2 px-1 text-left font-normal">Source</th>
              <th className="py-2 px-1 text-left font-normal">Kind</th>
              <th className="py-2 px-1 text-left font-normal">Ticker</th>
              <th className="py-2 px-1 text-left font-normal">Side</th>
              <th className="py-2 px-1 text-right font-normal">Notional</th>
            </tr>
          </thead>
          <tbody>
            {signals.map((s) => (
              <tr key={s.id} className="rule-hair hover:bg-paper-deep">
                <td className="py-2 text-[10px] uppercase tracking-[0.15em] text-ink-faint">
                  {fmtDatetime(s.as_of)}
                </td>
                <td className="py-2">{s.source}</td>
                <td className="py-2 text-ink-muted">
                  {s.kind === "politician" ? "Congress" : "13F"}
                </td>
                <td className="py-2 display text-lg">{s.ticker}</td>
                <td className="py-2">
                  <span
                    className="smallcaps tracking-[0.2em] px-[6px] py-[1px] border border-ink"
                    style={{
                      background: s.direction === "buy" ? "#14110f" : "transparent",
                      color: s.direction === "buy" ? "#f5efe3" : "#14110f",
                    }}
                  >
                    {s.direction}
                  </span>
                </td>
                <td className="py-2 text-right tabular-nums">
                  {s.amount ? fmtUSDShort(s.amount) : "—"}
                </td>
              </tr>
            ))}
            {!signals.length && (
              <tr>
                <td colSpan={6} className="py-16 text-center text-ink-faint italic">
                  No signals captured yet. Congressional disclosures refresh
                  weekly; 13F filings refresh monthly.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FilterBtn({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 border ${
        on ? "border-ink bg-ink text-paper" : "border-rule-hair text-ink-muted hover:border-ink"
      }`}
    >
      {children}
    </button>
  );
}
