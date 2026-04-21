"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, RoutinesNext } from "@/lib/api";

const LABELS: Record<string, string> = {
  premarket:     "Pre-market research",
  execute:       "Market-open execute",
  midday:        "Midday risk scan",
  close:         "Close wrap-up",
  weekly_review: "Weekly review",
};

/**
 * Countdown card: "Next routine: midday in 02:24:48". Reads the canonical
 * schedule from `/routines/next`, then re-renders once per second against
 * the locally tracked clock so the seconds tick down smoothly without
 * hammering the API.
 *
 * When the countdown crosses zero, we re-fetch — the API will compute the
 * *next* firing time (tomorrow's run, or the same-day follow-up).
 */
export function NextRoutine() {
  const { data, refetch } = useQuery<RoutinesNext>({
    queryKey: ["routines-next"],
    queryFn: api.routinesNext,
    refetchInterval: 60_000,
  });

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Compute live remaining seconds from the API's next_fire_utc so local
  // clock drift between API and browser doesn't matter.
  const next = data?.next;
  const targetMs = next ? new Date(next.next_fire_utc).getTime() : null;
  const remaining =
    targetMs != null
      ? Math.max(0, Math.floor((targetMs - Date.now()) / 1000))
      : 0;

  // Auto-refresh when we cross zero.
  useEffect(() => {
    if (targetMs != null && Date.now() >= targetMs) {
      const t = setTimeout(() => refetch(), 1500);
      return () => clearTimeout(t);
    }
  }, [targetMs, remaining, refetch]);

  const hh = String(Math.floor(remaining / 3600)).padStart(2, "0");
  const mm = String(Math.floor((remaining % 3600) / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");

  return (
    <div
      className="stat-card"
      style={{ borderTop: "2px solid var(--cyan)" }}
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
        Next routine
      </div>
      <div
        style={{
          fontFamily: "var(--font-inter), Inter, sans-serif",
          fontSize: 14,
          color: "var(--ink)",
          marginBottom: 4,
        }}
      >
        {next ? LABELS[next.name] ?? next.name : "—"}
      </div>
      <div
        className="display mono tabular-nums"
        style={{
          fontSize: 22,
          fontWeight: 600,
          color: "var(--cyan)",
          textShadow: "0 0 12px var(--cyan-glow)",
          letterSpacing: "0.02em",
        }}
      >
        {next ? `${hh}:${mm}:${ss}` : "--:--:--"}
      </div>
      {data && !data.routines_enabled && (
        <div
          className="mono smallcaps"
          style={{
            fontSize: 9,
            letterSpacing: "0.18em",
            color: "var(--ink-faint)",
            marginTop: 6,
          }}
        >
          <span style={{ color: "var(--rose)" }}>●</span> routines disabled
          (feature flag off)
        </div>
      )}
    </div>
  );
}
