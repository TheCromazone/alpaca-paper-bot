"use client";

import { useQuery } from "@tanstack/react-query";
import { api, BotStatus } from "@/lib/api";
import { LiveDot } from "./PnlLabel";
import { NextRoutine } from "./NextRoutine";
import { LLMCostCard } from "./LLMCostCard";

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

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        gap: 12,
        marginBottom: 20,
        marginTop: 16,
      }}
    >
      <StatCard label="Bot status" accent="var(--lime)">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <LiveDot on={running} color={running ? "var(--lime)" : "var(--ink-faint)"} />
          <span
            style={{
              fontWeight: 700,
              color: running ? "var(--lime)" : "var(--ink-muted)",
              textShadow: running ? "0 0 8px var(--lime-glow)" : "none",
            }}
          >
            {running ? "Running" : "Idle"}
          </span>
        </span>
        <div
          className="mono"
          style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 4 }}
        >
          five routines/day &middot; ET-aligned
        </div>
      </StatCard>

      <NextRoutine />
      <LLMCostCard />
    </div>
  );
}
