"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ClosedLot, type PerformanceSummary } from "@/lib/api";
import { fmtDay, fmtNum, fmtPx, fmtSignedUSD, tone } from "@/lib/format";
import { thesisParts } from "@/lib/thesis";
import { Empty, Panel, Skeleton } from "./ui";

function heldDays(lot: ClosedLot): number | null {
  if (!lot.entry_at || !lot.exit_at) return null;
  return Math.max(0, Math.round((new Date(lot.exit_at).getTime() - new Date(lot.entry_at).getTime()) / 86_400_000));
}

function Stat({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      <span className="label">{label}</span>
      <span className={`num ${cls}`} style={{ fontSize: 14, fontWeight: 500 }}>{value}</span>
    </div>
  );
}

/**
 * PL — realized performance: FIFO-matched closed lots with hit rate, profit
 * factor and payoff, each lot expandable to its entry thesis and exit reason.
 */
export function ClosedLots({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  const { data, isLoading } = useQuery<PerformanceSummary>({ queryKey: ["performance"], queryFn: api.performance, refetchInterval: 60_000 });
  const [open, setOpen] = useState<number | null>(null);
  const r = data?.realized as (PerformanceSummary["realized"] & { avg_win_pct?: number; avg_loss_pct?: number }) | undefined;
  const payoff = r && r.avg_loss ? Math.abs(r.avg_win / r.avg_loss) : null;

  return (
    <Panel
      code="PL"
      title="Realized P&L"
      sub={r ? `${r.closed_lots} closed lots · FIFO` : undefined}
      className={className}
      style={style}
      flush
      scroll
      testId="closed-lots"
    >
      {isLoading ? (
        <Skeleton rows={8} />
      ) : !r || !r.closed_lots ? (
        <Empty>No closed lots yet — realized P&L appears once the bot exits a position.</Empty>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(92px, 1fr))", gap: 10, padding: "8px 10px", borderBottom: "1px solid var(--line)" }}>
            <Stat label="Realized" value={fmtSignedUSD(r.realized_pnl, 2)} cls={tone(r.realized_pnl)} />
            <Stat label="Hit rate" value={`${fmtNum(r.hit_rate_pct, 1)}%`} cls={r.hit_rate_pct >= 50 ? "up" : "flat"} />
            <Stat label="W / L" value={`${r.wins} / ${r.losses}`} />
            <Stat label="Profit factor" value={r.profit_factor == null ? "—" : fmtNum(r.profit_factor, 2)} cls={r.profit_factor != null && r.profit_factor >= 1 ? "up" : "down"} />
            <Stat label="Avg win" value={`${fmtSignedUSD(r.avg_win, 0)}${r.avg_win_pct != null ? ` · ${fmtNum(r.avg_win_pct, 1)}%` : ""}`} cls="up" />
            <Stat label="Avg loss" value={`${fmtSignedUSD(r.avg_loss, 0)}${r.avg_loss_pct != null ? ` · ${fmtNum(r.avg_loss_pct, 1)}%` : ""}`} cls="down" />
            <Stat label="Payoff" value={payoff == null ? "—" : `${fmtNum(payoff, 2)}×`} />
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>Days</th>
                <th>Qty</th>
                <th>Entry px</th>
                <th>Exit px</th>
                <th>P&amp;L</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              {r.recent.map((lot, i) => {
                const isOpen = open === i;
                return (
                  <Fragment key={`${lot.ticker}-${lot.exit_at}-${i}`}>
                    <tr onClick={() => setOpen(isOpen ? null : i)} style={{ cursor: "pointer" }} className={isOpen ? "sel" : undefined}>
                      <td>
                        <span className="dim" style={{ display: "inline-block", width: 10 }}>{isOpen ? "▾" : "▸"}</span>
                        <Link href={`/security/${encodeURIComponent(lot.ticker)}`} className="tkr" onClick={(e) => e.stopPropagation()}>
                          {lot.ticker}
                        </Link>
                      </td>
                      <td className="dim">{fmtDay(lot.entry_at)}</td>
                      <td className="dim">{fmtDay(lot.exit_at)}</td>
                      <td>{heldDays(lot) ?? "—"}</td>
                      <td>{fmtNum(lot.qty, lot.qty % 1 ? 3 : 0)}</td>
                      <td>{fmtPx(lot.entry_price)}</td>
                      <td>{fmtPx(lot.exit_price)}</td>
                      <td className={tone(lot.pnl)}>{fmtSignedUSD(lot.pnl, 2)}</td>
                      <td className={tone(lot.pnl_pct)}>{`${lot.pnl_pct > 0 ? "+" : lot.pnl_pct < 0 ? "−" : ""}${Math.abs(lot.pnl_pct).toFixed(2)}%`}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={9} className="txt" style={{ whiteSpace: "normal", height: "auto", padding: "8px 10px 10px 26px", background: "var(--bg-2)" }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                            {(
                              [
                                ["Entry thesis", lot.entry_thesis, "var(--cyan)"],
                                ["Exit reason", lot.exit_reason, "var(--amber)"],
                              ] as const
                            ).map(([h, text, c]) => (
                              <div key={h} style={{ minWidth: 0 }}>
                                <div className="label" style={{ color: c, marginBottom: 4 }}>{h}</div>
                                {thesisParts(text).length ? (
                                  <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 10, rowGap: 3 }}>
                                    {thesisParts(text).map((p, j) => (
                                      <Fragment key={j}>
                                        <dt className="label" style={{ color: "var(--ink-3)", paddingTop: 2 }}>{p.k}</dt>
                                        <dd style={{ margin: 0, color: "var(--ink-2)", lineHeight: 1.45 }}>{p.v}</dd>
                                      </Fragment>
                                    ))}
                                  </dl>
                                ) : (
                                  <span className="dim">—</span>
                                )}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  );
}
