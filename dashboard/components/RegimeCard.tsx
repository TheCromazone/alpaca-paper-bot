"use client";

import { useQuery } from "@tanstack/react-query";
import { api, RegimeSnapshot } from "@/lib/api";

/**
 * Macro-regime card. Three buckets the LLM uses to size positions:
 *   risk_on  → green badge, comfortable opening at 5% cap
 *   neutral  → amber badge, default sizing
 *   risk_off → rose badge, skip new buys / size down
 *
 * Surfaces the inputs (VIX, breadth, 10Y-2Y, SPY trend) so it's auditable
 * — if the label looks wrong, you can see which signal is driving it.
 */
export function RegimeCard() {
  const { data, isError } = useQuery<RegimeSnapshot>({
    queryKey: ["regime"],
    queryFn: api.regime,
    refetchInterval: 60_000,
    retry: false,
  });

  const label = data?.regime_label ?? "—";
  const accent =
    label === "risk_on"
      ? "var(--lime)"
      : label === "risk_off"
      ? "var(--rose)"
      : "var(--amber, #f59e0b)";

  return (
    <div className="stat-card" style={{ borderTop: `2px solid ${accent}` }}>
      <div
        className="mono smallcaps"
        style={{
          fontSize: 9,
          letterSpacing: "0.25em",
          color: "var(--ink-faint)",
          marginBottom: 6,
        }}
      >
        Market regime
      </div>
      <div
        className="display mono tabular-nums"
        style={{ fontSize: 20, fontWeight: 600, color: accent, textTransform: "uppercase" }}
      >
        {isError ? "—" : label.replace("_", " ")}
      </div>
      <div
        className="mono"
        style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 8, lineHeight: 1.5 }}
      >
        VIX{" "}
        <span style={{ color: "var(--ink)" }}>
          {data?.vix != null ? data.vix.toFixed(1) : "—"}
        </span>
        {data?.vix_5d_change != null && (
          <span style={{ color: data.vix_5d_change > 0 ? "var(--rose)" : "var(--lime)" }}>
            {" "}({data.vix_5d_change > 0 ? "+" : ""}{data.vix_5d_change.toFixed(1)})
          </span>
        )}
        {" · "}
        breadth{" "}
        <span style={{ color: "var(--ink)" }}>
          {data?.breadth_pct != null ? `${data.breadth_pct.toFixed(0)}%` : "—"}
        </span>
        {" · "}
        10Y-2Y{" "}
        <span style={{ color: "var(--ink)" }}>
          {data?.t10y2y != null ? `${data.t10y2y > 0 ? "+" : ""}${data.t10y2y.toFixed(2)}` : "—"}
        </span>
      </div>
    </div>
  );
}
