"use client";

import { useQuery } from "@tanstack/react-query";
import { api, LLMCost } from "@/lib/api";
import { fmtUSD } from "@/lib/format";

/**
 * Today's Claude spend vs daily budget. Bar fills green→amber→red as we
 * approach the cap. Also surfaces the prompt-cache hit ratio (>60% means
 * the strategy.md breakpoint is doing its job; if it drops, something in
 * how we assemble the system prompt changed and we're paying full price
 * on repeat calls).
 */
export function LLMCostCard() {
  const { data } = useQuery<LLMCost>({
    queryKey: ["llm-cost"],
    queryFn: api.llmCost,
    refetchInterval: 30_000,
  });

  const today = data?.today_usd ?? 0;
  const budget = data?.budget_usd ?? 5;
  const pct = budget > 0 ? Math.min(1, today / budget) : 0;
  const hit = data?.cache_hit_ratio;

  const barColor =
    pct > 0.9
      ? "var(--rose)"
      : pct > 0.6
      ? "var(--amber, #f59e0b)"
      : "var(--lime)";

  return (
    <div className="stat-card" style={{ borderTop: "2px solid var(--violet)" }}>
      <div
        className="mono smallcaps"
        style={{
          fontSize: 9,
          letterSpacing: "0.25em",
          color: "var(--ink-faint)",
          marginBottom: 6,
        }}
      >
        LLM spend · today
      </div>
      <div
        className="display mono tabular-nums"
        style={{
          fontSize: 22,
          fontWeight: 600,
          color: "var(--ink)",
        }}
      >
        {fmtUSD(today, { sign: false })}
        <span
          style={{
            fontSize: 11,
            color: "var(--ink-faint)",
            fontWeight: 400,
            marginLeft: 6,
          }}
        >
          / {fmtUSD(budget, { sign: false })}
        </span>
      </div>
      <div
        className="cadence-bar"
        style={{ marginTop: 8, background: "rgba(255,255,255,0.04)" }}
      >
        <span
          style={{
            width: `${pct * 100}%`,
            background: barColor,
            transition: "width 600ms linear",
          }}
        />
      </div>
      <div
        className="mono"
        style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 6 }}
      >
        cache hit{" "}
        <span style={{ color: hit != null && hit >= 0.6 ? "var(--lime)" : "var(--ink)" }}>
          {hit != null ? `${Math.round(hit * 100)}%` : "—"}
        </span>
        {" · "}
        remaining {fmtUSD(data?.remaining_usd ?? budget, { sign: false })}
      </div>
    </div>
  );
}
