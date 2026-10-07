"use client";

import Link from "next/link";
import { Fragment, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, term, type PositionRow, type RiskResp } from "@/lib/api";
import { fmtChg, fmtDay, fmtSignedUSD, tone } from "@/lib/format";
import { thesisParts } from "@/lib/thesis";
import { Empty, Panel, Skeleton, useNow } from "./ui";

/**
 * WHY — one card per holding with the bot's entry thesis broken into its
 * rubric fields, alongside what has happened since: P&L, weight, days held,
 * how close it is to its stop, and whether its catalyst (earnings) is near.
 */
export function ThesisBoard({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  const now = useNow(60_000);
  const { data: positions, isLoading } = useQuery<PositionRow[]>({ queryKey: ["positions"], queryFn: api.positions });
  const { data: risk } = useQuery<RiskResp>({ queryKey: ["risk"], queryFn: term.risk, refetchInterval: 60_000 });
  const guards = useMemo(() => new Map((risk?.guards ?? []).map((g) => [g.ticker, g])), [risk]);
  const equity = risk?.equity ?? null;
  const rows = [...(positions ?? [])].sort((a, b) => b.market_value - a.market_value);

  return (
    <Panel code="WHY" title="Why we own it" sub="entry thesis vs what happened since" className={className} style={style} scroll testId="thesis-board">
      {isLoading ? (
        <Skeleton rows={8} />
      ) : !rows.length ? (
        <Empty>The book is flat — no open positions.</Empty>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 6 }}>
          {rows.map((p) => {
            const g = guards.get(p.ticker);
            const parts = thesisParts(p.thesis);
            const opened = p.decision_at ?? p.opened_at;
            const days = opened && now ? Math.floor((now - new Date(opened).getTime()) / 86_400_000) : null;
            const nearStop = g?.cut_distance != null && g.cut_distance < 0.02;
            return (
              <article
                key={p.ticker}
                style={{
                  border: "1px solid var(--line)",
                  borderLeft: `2px solid ${nearStop ? "var(--down)" : p.unrealized_pct >= 0 ? "var(--up)" : "var(--line-2)"}`,
                  background: "var(--bg-1)",
                  padding: "8px 10px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  minWidth: 0,
                }}
              >
                <header style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                  <Link href={`/security/${encodeURIComponent(p.ticker)}`} className="tkr" style={{ fontSize: 14 }}>
                    {p.ticker}
                  </Link>
                  <span className={`num ${tone(p.unrealized_pct)}`}>{fmtChg(p.unrealized_pct)}</span>
                  <span className={`num ${tone(p.unrealized_pnl)}`}>{fmtSignedUSD(p.unrealized_pnl, 0)}</span>
                  <span className="num dim" style={{ marginLeft: "auto", fontSize: 10.5 }}>
                    {equity ? `${((p.market_value / equity) * 100).toFixed(1)}% wt` : ""}
                    {days != null ? ` · ${days}d` : ""}
                    {opened ? ` · since ${fmtDay(opened)}` : ""}
                  </span>
                </header>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {g?.stop_distance != null && (
                    <span className={`pill ${g.stop_distance < 0.03 ? "warn" : ""}`}>stop {fmtChg(-g.stop_distance, 1)}</span>
                  )}
                  {g?.cut_distance != null && <span className={`pill ${nearStop ? "down" : ""}`}>−7% cut {fmtChg(-g.cut_distance, 1)}</span>}
                  {g?.earnings_in_days != null && (
                    <span className={`pill ${g.earnings_in_days <= 2 ? "warn" : ""}`}>earnings {Math.max(0, Math.round(g.earnings_in_days))}d</span>
                  )}
                  <span className="pill">{g?.broker_stop ? "broker stop" : "synthetic stop"}</span>
                </div>
                {parts.length ? (
                  <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "88px 1fr", columnGap: 10, rowGap: 4, fontSize: 11.5 }}>
                    {parts.map((t, i) => (
                      <Fragment key={i}>
                        <dt className="label" style={{ color: t.k === "Key risk" ? "var(--down)" : t.k === "Catalyst" ? "var(--cyan)" : "var(--ink-3)", paddingTop: 1 }}>
                          {t.k || "Note"}
                        </dt>
                        <dd style={{ margin: 0, color: "var(--ink-2)", lineHeight: 1.45 }}>{t.v}</dd>
                      </Fragment>
                    ))}
                  </dl>
                ) : (
                  <span className="dim">No thesis on record for this position.</span>
                )}
              </article>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
