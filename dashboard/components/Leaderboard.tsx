"use client";

import { PositionRow } from "@/lib/api";
import { fmtPct, fmtUSD } from "@/lib/format";
import { Sparkline, genSpark } from "./Sparkline";

/**
 * Gainers/Laggards leaderboard. Each row also exposes the LATEST buy thesis
 * (LLM `Decision.reason` or manual note) on hover via the same `.trade-row`
 * reveal pattern used in RecentTrades — so you can mouse over any holding
 * and see *why we own it*.
 */
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
            // .trade-row reveals .detail on hover (defined in globals.css);
            // reusing that here gives holdings the same expand-on-hover UX
            // as the trade journal.
            className="trade-row rule-hair rise"
            style={{
              padding: "11px 10px",
              animationDelay: `${idx * 80}ms`,
              marginLeft: -10,
              marginRight: -10,
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1.1fr 1fr auto",
                alignItems: "center",
                gap: 14,
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
                  {p.qty.toFixed(2)} sh &middot; {fmtUSD(p.avg_cost)} → {fmtUSD(p.market_price)}
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
            </div>

            {/* Hover reveal: the buy thesis + entry / stop info */}
            <div className="detail">
              <div
                style={{
                  marginTop: 10,
                  paddingTop: 10,
                  borderTop: "1px solid var(--rule-hair)",
                }}
              >
                <div
                  className="mono smallcaps"
                  style={{
                    fontSize: 9,
                    letterSpacing: "0.25em",
                    color: "var(--emerald)",
                    marginBottom: 4,
                  }}
                >
                  <span className="accent-bar" />
                  {p.decision_action === "manual_buy"
                    ? "Manual entry"
                    : p.decision_action === "buy"
                    ? "LLM thesis"
                    : "Why we own this"}
                </div>
                <p
                  style={{
                    margin: 0,
                    fontSize: 12.5,
                    color: "var(--ink)",
                    lineHeight: 1.5,
                  }}
                >
                  {p.thesis ??
                    "No thesis recorded — this position pre-dates the LLM era or was opened directly on Alpaca."}
                </p>
                <div
                  className="mono"
                  style={{
                    marginTop: 8,
                    fontSize: 10,
                    color: "var(--ink-faint)",
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 14,
                  }}
                >
                  {p.opened_at && (
                    <span>
                      opened{" "}
                      <span style={{ color: "var(--ink-muted)" }}>
                        {new Date(p.opened_at).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </span>
                    </span>
                  )}
                  {p.peak_price > 0 && (
                    <span>
                      peak{" "}
                      <span style={{ color: "var(--ink-muted)" }}>
                        {fmtUSD(p.peak_price)}
                      </span>{" "}
                      · trailing stop{" "}
                      <span style={{ color: "var(--mint)" }}>
                        {fmtUSD(p.stop_price)}
                      </span>{" "}
                      ({fmtPct(p.distance_to_stop_pct, 1)} away)
                    </span>
                  )}
                  {p.stop_order_id && p.stop_order_id !== null && (
                    <span style={{ color: "var(--mint)" }}>
                      stop attached
                    </span>
                  )}
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
