"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type NewsRow, type PositionRow } from "@/lib/api";
import { fmtAge, fmtNum } from "@/lib/format";
import { Empty, Panel, Skeleton, useNow } from "./ui";

type Row = { ticker: string; n: number; avg: number; pos: number; neg: number; latest: NewsRow };

/** Diverging score bar centered at zero, −1..+1. */
function ScoreBar({ v }: { v: number }) {
  const w = Math.min(1, Math.abs(v)) * 50;
  return (
    <span style={{ position: "relative", display: "inline-block", width: 84, height: 8, background: "var(--bg-3)", verticalAlign: "middle" }}>
      <span style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: "var(--ink-4)" }} />
      <span
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: v >= 0 ? "50%" : `${50 - w}%`,
          width: `${w}%`,
          background: v >= 0 ? "var(--up)" : "var(--down)",
          opacity: 0.85,
        }}
      />
    </span>
  );
}

/**
 * SENT — headline sentiment rolled up by ticker: how much the tape is
 * talking about each name, the average VADER tone, the positive/negative
 * split, and the newest headline. Held names are flagged.
 */
export function SentimentBoard({ className = "", style, limit = 200 }: { className?: string; style?: React.CSSProperties; limit?: number }) {
  const now = useNow(30_000);
  const { data: news, isLoading } = useQuery({ queryKey: ["news", limit], queryFn: () => api.news(limit) });
  const { data: positions } = useQuery<PositionRow[]>({ queryKey: ["positions"], queryFn: api.positions });
  const held = useMemo(() => new Set((positions ?? []).map((p) => p.ticker)), [positions]);

  const rows = useMemo<Row[]>(() => {
    const by = new Map<string, NewsRow[]>();
    for (const n of news ?? []) for (const t of n.tickers ?? []) by.set(t, [...(by.get(t) ?? []), n]);
    return [...by.entries()]
      .map(([ticker, items]) => {
        const scored = items.filter((i) => i.vader_score != null);
        const avg = scored.length ? scored.reduce((a, i) => a + (i.vader_score ?? 0), 0) / scored.length : 0;
        return {
          ticker,
          n: items.length,
          avg,
          pos: scored.filter((i) => (i.vader_score ?? 0) >= 0.2).length,
          neg: scored.filter((i) => (i.vader_score ?? 0) <= -0.2).length,
          latest: items.reduce((a, b) => (a.published_at > b.published_at ? a : b)),
        };
      })
      .sort((a, b) => Number(held.has(b.ticker)) - Number(held.has(a.ticker)) || b.n - a.n);
  }, [news, held]);

  return (
    <Panel code="SENT" title="Sentiment by ticker" sub={news ? `${news.length} headlines` : undefined} className={className} style={style} flush scroll testId="sentiment-board">
      {isLoading ? (
        <Skeleton rows={10} />
      ) : !rows.length ? (
        <Empty>No ticker-tagged headlines yet — the news job tags tickers every 15 minutes.</Empty>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>N</th>
              <th style={{ textAlign: "center" }}>Tone</th>
              <th>Avg</th>
              <th>+/−</th>
              <th style={{ textAlign: "left" }}>Latest</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ticker}>
                <td>
                  <Link href={`/security/${encodeURIComponent(r.ticker)}#cn`} className={`tkr${held.has(r.ticker) ? " held" : ""}`}>
                    {r.ticker}
                  </Link>
                </td>
                <td>{r.n}</td>
                <td style={{ textAlign: "center" }}>
                  <ScoreBar v={r.avg} />
                </td>
                <td className={r.avg >= 0.05 ? "up" : r.avg <= -0.05 ? "down" : "flat"}>{fmtNum(r.avg, 2)}</td>
                <td>
                  <span className="up">{r.pos}</span>
                  <span className="dim">/</span>
                  <span className="down">{r.neg}</span>
                </td>
                <td className="txt" style={{ maxWidth: 0, width: "55%", overflow: "hidden", textOverflow: "ellipsis" }}>
                  <a href={r.latest.url} target="_blank" rel="noopener noreferrer" title={r.latest.title} style={{ color: "var(--ink-2)" }}>
                    <span className="num dim" style={{ marginRight: 6 }}>{now ? fmtAge(r.latest.published_at, now) : ""}</span>
                    {r.latest.title}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
