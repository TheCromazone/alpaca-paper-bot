"use client";

import { useQuery } from "@tanstack/react-query";
import { api, SignalRow } from "@/lib/api";
import { fmtTimeAgo, fmtUSD } from "@/lib/format";

/**
 * Direction badge — a *big*, color-coded icon so politician/13F BUY vs SELL is
 * legible at a glance from across the room. Red ▼ for sells, emerald ▲ for
 * buys, with a glow that picks up the page's neon palette.
 */
function DirectionIcon({ direction }: { direction: "buy" | "sell" }) {
  const isBuy = direction === "buy";
  return (
    <div
      title={isBuy ? "Insider BUY" : "Insider SELL"}
      style={{
        width: 32,
        height: 32,
        borderRadius: 6,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        background: isBuy
          ? "rgba(0, 230, 130, 0.12)"
          : "rgba(255, 90, 110, 0.14)",
        border: `1px solid ${
          isBuy ? "var(--emerald)" : "var(--rose)"
        }`,
        boxShadow: `0 0 12px ${
          isBuy ? "var(--emerald-glow)" : "var(--rose-glow)"
        }, inset 0 0 6px ${
          isBuy ? "rgba(0,230,130,0.18)" : "rgba(255,90,110,0.22)"
        }`,
        color: isBuy ? "var(--emerald)" : "var(--rose)",
        fontSize: 17,
        fontWeight: 700,
        lineHeight: 1,
        textShadow: `0 0 6px ${
          isBuy ? "var(--emerald-glow)" : "var(--rose-glow)"
        }`,
      }}
    >
      {isBuy ? "▲" : "▼"}
    </div>
  );
}

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
      {signals.map((s, i) => {
        const isBuy = s.direction === "buy";
        return (
          <li
            key={s.id}
            className="rule-hair rise"
            style={{
              padding: "11px 0",
              display: "grid",
              gridTemplateColumns: "auto auto 1fr auto",
              gap: 10,
              alignItems: "center",
              animationDelay: `${i * 60}ms`,
            }}
          >
            <DirectionIcon direction={isBuy ? "buy" : "sell"} />
            <span
              className="display"
              style={{ fontSize: 17, fontWeight: 600, color: "var(--ink)" }}
            >
              {s.ticker}
            </span>
            <div style={{ minWidth: 0 }}>
              <div
                className="mono smallcaps"
                style={{
                  fontSize: 9,
                  letterSpacing: "0.18em",
                  color: isBuy ? "var(--emerald)" : "var(--rose)",
                  fontWeight: 600,
                }}
              >
                {isBuy ? "BUY" : "SELL"}
                <span
                  style={{
                    color: "var(--ink-faint)",
                    fontWeight: 400,
                    marginLeft: 6,
                  }}
                >
                  · {s.kind === "politician" ? "Congress" : "13F"} · {fmtTimeAgo(s.as_of)}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--ink-muted)",
                  fontFamily: "var(--font-inter), Inter, sans-serif",
                  marginTop: 2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {s.source}
              </div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              {s.amount != null && s.amount > 0 && (
                <div
                  className="mono tabular-nums"
                  style={{
                    fontSize: 11,
                    color: isBuy ? "var(--emerald)" : "var(--rose)",
                    fontWeight: 600,
                  }}
                >
                  {fmtUSD(s.amount, { compact: true })}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
