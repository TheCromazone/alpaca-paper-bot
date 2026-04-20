"use client";

import { useQuery } from "@tanstack/react-query";
import { api, TapeRow } from "@/lib/api";

export function TickerStrip() {
  const { data } = useQuery<TapeRow[]>({
    queryKey: ["tape"],
    queryFn: api.tape,
    refetchInterval: 60_000,
  });
  const tape = data ?? [];
  if (!tape.length) {
    return (
      <div
        className="ticker-strip"
        style={{ height: 32, display: "flex", alignItems: "center", padding: "0 16px" }}
      >
        <span className="mono smallcaps" style={{ fontSize: 10, color: "var(--ink-faint)" }}>
          loading ticker tape…
        </span>
      </div>
    );
  }
  const items = [...tape, ...tape];
  return (
    <div className="ticker-strip">
      <div className="ticker-track marquee-track">
        {items.map((t, i) => (
          <span className="ticker-item" key={i}>
            <span className="sym">{t.s}</span>
            <span className="tabular-nums">
              {t.p.toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
            <span className={t.c >= 0 ? "up" : "down"}>
              {t.c >= 0 ? "▲" : "▼"} {(Math.abs(t.c) * 100).toFixed(2)}%
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
