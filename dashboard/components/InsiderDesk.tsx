"use client";

import { useQuery } from "@tanstack/react-query";
import { api, SignalRow } from "@/lib/api";
import { fmtTimeAgo, fmtUSD } from "@/lib/format";

export function InsiderDesk({ limit = 12 }: { limit?: number }) {
  const { data } = useQuery<SignalRow[]>({
    queryKey: ["signals-desk", limit],
    queryFn: () => api.signals(limit),
  });
  const signals = data ?? [];

  if (!signals.length) {
    return (
      <p
        style={{
          color: "var(--ink-faint)",
          fontStyle: "italic",
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        No signals yet. Congressional disclosures refresh weekly; 13F filings monthly.
      </p>
    );
  }

  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {signals.map((s, i) => (
        <li
          key={s.id}
          className="rule-hair rise"
          style={{
            padding: "10px 0",
            display: "grid",
            gridTemplateColumns: "auto 1fr auto",
            gap: 12,
            alignItems: "center",
            animationDelay: `${i * 60}ms`,
          }}
        >
          <span
            className="display"
            style={{ fontSize: 18, fontWeight: 600, color: "var(--ink)" }}
          >
            {s.ticker}
          </span>
          <div>
            <div
              className="mono smallcaps"
              style={{
                fontSize: 9,
                letterSpacing: "0.2em",
                color: "var(--ink-faint)",
              }}
            >
              {s.kind === "politician" ? "Congress" : "13F"} &middot; {fmtTimeAgo(s.as_of)}
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--ink-muted)",
                fontFamily: "var(--font-inter), Inter, sans-serif",
                marginTop: 2,
              }}
            >
              {s.source}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <span className={"chip " + s.direction}>{s.direction.toUpperCase()}</span>
            {s.amount != null && (
              <div
                className="mono tabular-nums"
                style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 4 }}
              >
                {fmtUSD(s.amount, { compact: true })}
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
