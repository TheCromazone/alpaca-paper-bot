"use client";

import { useQuery } from "@tanstack/react-query";
import { api, BotStatus } from "@/lib/api";
import { LiveDot } from "./PnlLabel";
import { NextRoutine } from "./NextRoutine";
import { LLMCostCard } from "./LLMCostCard";
import { RegimeCard } from "./RegimeCard";

function StatCard({
  label,
  children,
  accent = "var(--cyan)",
}: {
  label: string;
  children: React.ReactNode;
  accent?: string;
}) {
  return (
    <div
      className="stat-card"
      style={{
        borderTop: `2px solid ${accent}`,
      }}
    >
      <div
        className="mono smallcaps"
        style={{
          fontSize: 9,
          letterSpacing: "0.25em",
          color: "var(--ink-faint)",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div style={{ fontFamily: "var(--font-inter), Inter, sans-serif", fontSize: 14 }}>
        {children}
      </div>
    </div>
  );
}

export function BotRibbon() {
  // Kept for the "Bot status" heartbeat card. The middle + right cards now
  // come from NextRoutine / LLMCostCard which have their own queries.
  const { data: bot } = useQuery<BotStatus>({
    queryKey: ["bot-status"],
    queryFn: api.botStatus,
    refetchInterval: 15_000,
  });

  const running = !!bot?.last_tick_at && bot.last_tick_status !== "failed";

  const llm = bot?.last_llm_run ?? null;
  const lastActivity = bot?.last_tick_at ? new Date(bot.last_tick_at) : null;
  const ageMin = lastActivity
    ? Math.max(0, Math.round((Date.now() - lastActivity.getTime()) / 60_000))
    : null;
  const ageStr =
    ageMin == null
      ? "—"
      : ageMin < 1
      ? "just now"
      : ageMin < 60
      ? `${ageMin}m ago`
      : `${Math.round(ageMin / 60)}h ago`;
  const stale = ageMin != null && ageMin > 30;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 12,
        marginBottom: 20,
        marginTop: 16,
      }}
    >
      <StatCard label="Bot status" accent={stale ? "var(--amber, #f59e0b)" : "var(--lime)"}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <LiveDot on={running && !stale} color={stale ? "var(--amber, #f59e0b)" : running ? "var(--lime)" : "var(--ink-faint)"} />
          <span
            style={{
              fontWeight: 700,
              color: stale ? "var(--amber, #f59e0b)" : running ? "var(--lime)" : "var(--ink-muted)",
              textShadow: !stale && running ? "0 0 8px var(--lime-glow)" : "none",
            }}
          >
            {!running ? "Idle" : stale ? "Stale" : "Running"}
          </span>
        </span>
        <div
          className="mono"
          style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 4 }}
        >
          {llm
            ? `${llm.routine} ${ageStr} · ${llm.tool_calls} tools · $${llm.usd_cost.toFixed(2)}`
            : `last activity ${ageStr}`}
        </div>
      </StatCard>

      <NextRoutine />
      <RegimeCard />
      <LLMCostCard />
    </div>
  );
}
