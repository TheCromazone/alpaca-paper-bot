"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, BotStatus } from "@/lib/api";
import { LiveDot } from "./PnlLabel";

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
  const { data: bot } = useQuery<BotStatus>({
    queryKey: ["bot-status"],
    queryFn: api.botStatus,
    refetchInterval: 15_000,
  });

  const intervalSec = bot?.interval_seconds ?? 300;
  const lastTickMs = bot?.last_tick_at ? new Date(bot.last_tick_at).getTime() : null;

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const elapsed = lastTickMs != null ? Math.max(0, (now - lastTickMs) / 1000) : 0;
  const cycleElapsed = Math.min(intervalSec, elapsed % intervalSec);
  const remaining = Math.max(0, intervalSec - cycleElapsed);
  const pct = cycleElapsed / intervalSec;
  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(Math.floor(remaining % 60)).padStart(2, "0");

  const lastDecision = bot?.last_decision;
  const actionColor =
    lastDecision?.action === "buy" || lastDecision?.action === "add"
      ? "var(--lime)"
      : lastDecision?.action === "sell"
      ? "var(--rose)"
      : "var(--ink-muted)";

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
          every 5 minutes &middot; market hours
        </div>
      </StatCard>

      <StatCard label="Next cycle in" accent="var(--cyan)">
        <span
          className="display tabular-nums"
          style={{
            fontSize: 22,
            fontWeight: 600,
            color: "var(--cyan)",
            textShadow: "0 0 12px var(--cyan-glow)",
          }}
        >
          {mm}:{ss}
        </span>
        <div className="cadence-bar" style={{ marginTop: 8 }}>
          <span style={{ width: `${pct * 100}%`, transition: "width 900ms linear" }} />
        </div>
      </StatCard>

      <StatCard label="Last signal" accent="var(--violet)">
        {lastDecision ? (
          <>
            <span className="display" style={{ fontSize: 18, fontWeight: 600 }}>
              {lastDecision.ticker}{" "}
              <span
                className="chip"
                style={{
                  marginLeft: 6,
                  color: actionColor,
                  borderColor: actionColor,
                  textTransform: "uppercase",
                }}
              >
                {lastDecision.action}
              </span>
            </span>
            <div
              className="mono"
              style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 4 }}
            >
              composite {lastDecision.composite_score.toFixed(2)}
            </div>
          </>
        ) : (
          <span style={{ color: "var(--ink-faint)", fontStyle: "italic", fontSize: 13 }}>
            no decisions yet
          </span>
        )}
      </StatCard>
    </div>
  );
}
