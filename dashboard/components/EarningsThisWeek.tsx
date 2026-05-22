"use client";

import { useQuery } from "@tanstack/react-query";
import { api, EarningsEvent, PositionRow } from "@/lib/api";
import { SectionHead } from "@/components/SectionHead";

/**
 * Upcoming earnings (next 14 days) for universe tickers. Held positions
 * are highlighted — those reports can blow out a thesis. The LLM uses the
 * same data via get_upcoming_earnings to avoid opening fresh positions
 * within 5 days of an earnings release unless the thesis IS the beat.
 */
export function EarningsThisWeek() {
  const { data: events } = useQuery<EarningsEvent[]>({
    queryKey: ["earnings", 14],
    queryFn: () => api.earnings(14),
    refetchInterval: 5 * 60_000,
  });
  const { data: positions } = useQuery<PositionRow[]>({
    queryKey: ["positions"],
    queryFn: api.positions,
  });

  const heldSet = new Set((positions ?? []).map((p) => p.ticker));
  const list = (events ?? []).slice(0, 12);

  return (
    <article style={{ minWidth: 0 }}>
      <SectionHead
        eyebrow="Calendar — next 14 days"
        title="Earnings on deck"
        right={<span>{list.length} reports</span>}
      />
      {list.length === 0 ? (
        <div
          className="mono"
          style={{ fontSize: 12, color: "var(--ink-faint)", padding: "12px 0" }}
        >
          No earnings in tracked tickers.
        </div>
      ) : (
        <div className="panel rise" style={{ overflowX: "auto" }}>
          <table
            className="mono"
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 12,
              tableLayout: "fixed",
            }}
          >
            <thead>
              <tr
                style={{
                  color: "var(--ink-faint)",
                  textAlign: "left",
                  borderBottom: "1px solid var(--rule)",
                }}
              >
                <th
                  style={{
                    padding: "10px 14px",
                    width: "18%",
                    letterSpacing: "0.2em",
                    textTransform: "uppercase",
                    fontSize: 10,
                  }}
                >
                  Ticker
                </th>
                <th
                  style={{
                    padding: "10px 14px",
                    width: "30%",
                    letterSpacing: "0.2em",
                    textTransform: "uppercase",
                    fontSize: 10,
                  }}
                >
                  Date
                </th>
                <th
                  style={{
                    padding: "10px 14px",
                    width: "16%",
                    letterSpacing: "0.2em",
                    textTransform: "uppercase",
                    fontSize: 10,
                  }}
                >
                  Time
                </th>
                <th
                  style={{
                    padding: "10px 14px",
                    width: "18%",
                    textAlign: "right",
                    letterSpacing: "0.2em",
                    textTransform: "uppercase",
                    fontSize: 10,
                  }}
                >
                  EPS est.
                </th>
                <th
                  style={{
                    padding: "10px 14px",
                    width: "18%",
                    textAlign: "right",
                    letterSpacing: "0.2em",
                    textTransform: "uppercase",
                    fontSize: 10,
                  }}
                >
                  Last 4 surp.
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((e, idx) => {
                const isHeld = heldSet.has(e.ticker);
                // The API serves report_date as an ISO datetime; pin it to noon
                // UTC so toLocaleDateString shows the same calendar day in PT.
                const date = new Date(e.report_date);
                const daysUntil = Math.round(
                  (date.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
                );
                const soon = daysUntil <= 5;
                const tod = e.time_of_day?.includes("pre")
                  ? "BMO"
                  : e.time_of_day?.includes("aft")
                  ? "AMC"
                  : e.time_of_day || "—";
                const lastSurp = e.last_4_surprise_pcts.find((s) => s != null);
                return (
                  <tr
                    key={`${e.ticker}-${e.report_date}`}
                    className="rise"
                    style={{
                      borderTop: "1px solid var(--rule-hair)",
                      // Held positions get an emerald wash so they pop;
                      // upcoming reports on names you own move the P/L.
                      background: isHeld ? "rgba(0,230,130,0.05)" : "transparent",
                      animationDelay: `${idx * 40}ms`,
                    }}
                  >
                    <td
                      style={{
                        padding: "10px 14px",
                        fontWeight: 700,
                        color: isHeld ? "var(--emerald)" : "var(--ink)",
                      }}
                    >
                      {e.ticker}
                      {isHeld && (
                        <span
                          style={{
                            fontSize: 9,
                            marginLeft: 8,
                            color: "var(--emerald)",
                            letterSpacing: "0.18em",
                          }}
                        >
                          · HELD
                        </span>
                      )}
                    </td>
                    <td
                      style={{
                        padding: "10px 14px",
                        color: soon ? "var(--rose)" : "var(--ink)",
                      }}
                    >
                      {date.toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        weekday: "short",
                      })}
                      <span style={{ color: "var(--ink-faint)", marginLeft: 6 }}>
                        ({daysUntil}d)
                      </span>
                    </td>
                    <td style={{ padding: "10px 14px", color: "var(--ink-faint)" }}>
                      {tod}
                    </td>
                    <td
                      style={{
                        padding: "10px 14px",
                        textAlign: "right",
                        color: "var(--ink)",
                      }}
                      className="tabular-nums"
                    >
                      {e.eps_estimate != null ? `$${e.eps_estimate.toFixed(2)}` : "—"}
                    </td>
                    <td
                      style={{
                        padding: "10px 14px",
                        textAlign: "right",
                        color:
                          lastSurp == null
                            ? "var(--ink-faint)"
                            : lastSurp > 0
                            ? "var(--emerald)"
                            : "var(--rose)",
                        textShadow:
                          lastSurp != null
                            ? `0 0 8px ${
                                lastSurp > 0 ? "var(--emerald-glow)" : "var(--loss-glow)"
                              }`
                            : "none",
                      }}
                      className="tabular-nums"
                    >
                      {lastSurp != null
                        ? `${lastSurp > 0 ? "+" : ""}${lastSurp.toFixed(1)}%`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}
