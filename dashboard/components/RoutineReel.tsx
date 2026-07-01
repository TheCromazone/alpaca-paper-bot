"use client";

import { useQuery } from "@tanstack/react-query";
import { api, LLMRunRow, LLMCost } from "@/lib/api";

/**
 * The Routine Reel — every LLM routine run rendered as a frame of film on a
 * horizontal strip (sprocket holes via .reel-frame CSS). Newest frame first.
 * Each frame: routine name, ET timestamp, status glow, cost, tool count and
 * the first few tools it reached for; hover lifts the frame and the title
 * attribute carries the run summary. Footer line shows today's burn vs the
 * daily budget from /llm/cost.
 */

const STATUS_WORD: Record<string, string> = {
  ok: "clean take",
  running: "rolling",
  failed: "failed",
  budget_halt: "budget halt",
};

function etTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

function topTools(run: LLMRunRow, max = 3): string[] {
  const seen: string[] = [];
  for (const t of run.tool_trace ?? []) {
    if (!seen.includes(t.name)) seen.push(t.name);
    if (seen.length >= max) break;
  }
  return seen;
}

export function RoutineReel({ limit = 12 }: { limit?: number }) {
  const { data: runs } = useQuery<LLMRunRow[]>({
    queryKey: ["llm-runs", limit],
    queryFn: () => api.llmRuns(limit),
    refetchInterval: 30_000,
  });
  const { data: cost } = useQuery<LLMCost>({
    queryKey: ["llm-cost"],
    queryFn: api.llmCost,
    refetchInterval: 60_000,
  });

  if (!runs?.length) {
    return (
      <div
        className="mono smallcaps"
        style={{ fontSize: 10, color: "var(--ink-faint)", padding: "18px 2px" }}
      >
        no routine runs on the reel yet — first scene shoots at 07:00 ET
      </div>
    );
  }

  return (
    <div>
      <div className="reel">
        {runs.map((run, i) => {
          const statusClass =
            run.status in STATUS_WORD ? run.status : "failed";
          const tools = topTools(run);
          return (
            <div
              key={run.id}
              className={`reel-frame ${statusClass}`}
              style={{ ["--i" as never]: i } as React.CSSProperties}
              title={run.summary || undefined}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span
                  className="display"
                  style={{ fontSize: 15, color: "var(--ink)" }}
                >
                  {run.routine.replace("_", " ")}
                </span>
                <span
                  className="mono tabular-nums"
                  style={{ fontSize: 11, color: "var(--ink-muted)" }}
                >
                  ${run.usd_cost.toFixed(2)}
                </span>
              </div>

              <div
                className="mono"
                style={{ fontSize: 9.5, color: "var(--ink-faint)", marginTop: 4 }}
              >
                {etTime(run.started_at)} ET
              </div>

              <div
                className="mono smallcaps reel-status"
                style={{ fontSize: 9, letterSpacing: "0.2em", marginTop: 10 }}
              >
                <span className="dot" aria-hidden="true" />
                {STATUS_WORD[statusClass]}
                <span style={{ color: "var(--ink-faint)", textShadow: "none" }}>
                  · {run.tool_calls} tools
                </span>
              </div>

              {tools.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    gap: 4,
                    flexWrap: "wrap",
                    marginTop: 10,
                  }}
                  className="mono"
                >
                  {tools.map((t) => (
                    <span key={t} className="tool-tick">
                      {t}
                    </span>
                  ))}
                  {run.tool_calls > tools.length && (
                    <span className="tool-tick">
                      +{run.tool_calls - tools.length}
                    </span>
                  )}
                </div>
              )}

              {run.error && (
                <div
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    color: "var(--rose)",
                    marginTop: 8,
                    lineHeight: 1.4,
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {run.error}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {cost && (
        <div
          className="mono smallcaps"
          style={{
            fontSize: 9.5,
            letterSpacing: "0.2em",
            color: "var(--ink-faint)",
            marginTop: 4,
            display: "flex",
            gap: 18,
            flexWrap: "wrap",
          }}
        >
          <span>
            today&apos;s burn{" "}
            <span style={{ color: "var(--emerald)" }}>
              ${cost.today_usd.toFixed(2)}
            </span>{" "}
            / ${cost.budget_usd.toFixed(0)} budget
          </span>
          <span>week ${cost.week_usd.toFixed(2)}</span>
          {cost.cache_hit_ratio != null && (
            <span>cache hit {(cost.cache_hit_ratio * 100).toFixed(0)}%</span>
          )}
        </div>
      )}
    </div>
  );
}
