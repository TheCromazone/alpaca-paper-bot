"use client";

import { PositionRow } from "@/lib/api";
import { fmtPct, fmtUSD } from "@/lib/format";
import { Sparkline, genSpark } from "./Sparkline";

export function Leaderboard({ rows }: { rows: PositionRow[] }) {
  if (!rows.length)
    return (
      <p style={{ color: "var(--ink-faint)", fontStyle: "italic", fontSize: 13 }}>
        No positions.
      </p>
    );
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.unrealized_pct))) || 0.01;

  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {rows.map((p, idx) => {
        const gainColor = p.unrealized_pnl >= 0 ? "var(--gain)" : "var(--loss)";
        const gainGlow =
          p.unrealized_pnl >= 0 ? "var(--gain-glow)" : "var(--loss-glow)";
        return (
          <li
            key={p.ticker}
            className="rule-hair rise"
            style={{
              display: "grid",
              gridTemplateColumns: "1.1fr 1fr auto",
              alignItems: "center",
              gap: 14,
              padding: "11px 0",
              animationDelay: `${idx * 80}ms`,
            }}
          >
            <div>
              <div>
                <span
                  className="display"
                  style={{ fontSize: 22, fontWeight: 600, color: "var(--ink)" }}
                >
                  {p.ticker}
                </span>
                <span
                  className="mono smallcaps"
                  style={{
                    fontSize: 9,
                    letterSpacing: "0.2em",
                    color: "var(--ink-faint)",
                    marginLeft: 8,
                  }}
                >
                  {p.sector}
                </span>
              </div>
              <div
                className="mono"
                style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 3 }}
              >
                {p.qty} sh &middot; {fmtUSD(p.avg_cost)} → {fmtUSD(p.market_price)}
              </div>
            </div>
            <div>
              <Sparkline points={genSpark(p.unrealized_pct, 0.015)} color={gainColor} />
              <div className="bar-track" style={{ marginTop: 6 }}>
                <div
                  className={
                    "bar-fill grow-w " +
                    (p.unrealized_pct >= 0 ? "gain" : "loss")
                  }
                  style={
                    {
                      ["--w" as never]: `${Math.min(
                        100,
                        (Math.abs(p.unrealized_pct) / maxAbs) * 100
                      )}%`,
                      width: 0,
                    } as React.CSSProperties
                  }
                />
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div
                className="display tabular-nums"
                style={{
                  fontSize: 18,
                  color: gainColor,
                  fontWeight: 600,
                  textShadow: `0 0 10px ${gainGlow}`,
                }}
              >
                {fmtUSD(p.unrealized_pnl, { sign: true })}
              </div>
              <div
                className="mono"
                style={{ fontSize: 11, color: gainColor, fontWeight: 500 }}
              >
                {fmtPct(p.unrealized_pct)}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
