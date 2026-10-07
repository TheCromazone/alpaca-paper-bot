"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type PositionRow, type SignalRow } from "@/lib/api";
import { fmtBig, fmtDay } from "@/lib/format";
import { Empty, Panel, Skeleton } from "./ui";

type Who = {
  name: string;
  kind: string;
  chamber: string | null;
  n: number;
  buys: number;
  sells: number;
  net: number;
  last: string;
  tickers: Map<string, number>;
};

/**
 * WHO — the disclosers: every politician and fund in the signal feed with
 * their trade count, buy/sell mix, net disclosed dollars, most-traded
 * tickers (held names flagged) and latest disclosure.
 */
export function PoliticianBoard({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  const { data: signals, isLoading } = useQuery<SignalRow[]>({ queryKey: ["signals", 500], queryFn: () => api.signals(500) });
  const { data: positions } = useQuery<PositionRow[]>({ queryKey: ["positions"], queryFn: api.positions });
  const held = useMemo(() => new Set((positions ?? []).map((p) => p.ticker)), [positions]);

  const rows = useMemo<Who[]>(() => {
    const by = new Map<string, Who>();
    for (const s of signals ?? []) {
      const meta = (s.meta ?? {}) as { politician?: string; chamber?: string };
      const name = meta.politician || s.source;
      const w =
        by.get(name) ??
        ({ name, kind: s.kind, chamber: meta.chamber ?? null, n: 0, buys: 0, sells: 0, net: 0, last: s.as_of, tickers: new Map() } as Who);
      w.n += 1;
      if (s.direction === "buy") w.buys += 1;
      else w.sells += 1;
      w.net += (s.direction === "buy" ? 1 : -1) * (s.amount ?? 0);
      if (s.as_of > w.last) w.last = s.as_of;
      w.tickers.set(s.ticker, (w.tickers.get(s.ticker) ?? 0) + 1);
      by.set(name, w);
    }
    return [...by.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
  }, [signals]);

  return (
    <Panel code="WHO" title="Disclosers" sub={rows.length ? `${rows.length} filers` : undefined} className={className} style={style} flush scroll testId="politician-board">
      {isLoading ? (
        <Skeleton rows={10} />
      ) : !rows.length ? (
        <Empty>No politician or 13F disclosures ingested yet. The House job runs daily at 07:00 UTC, Senate at 07:30, 13F weekly on Sunday.</Empty>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Filer</th>
              <th>Src</th>
              <th>N</th>
              <th>Buy/Sell</th>
              <th>Net $</th>
              <th style={{ textAlign: "left" }}>Tickers</th>
              <th>Last</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => {
              const tick = [...w.tickers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
              const src = w.kind === "investor" ? "13F" : w.chamber === "senate" ? "SEN" : "HSE";
              return (
                <tr key={w.name}>
                  <td className="txt" style={{ color: "var(--ink)", fontWeight: 500 }}>{w.name}</td>
                  <td>
                    <span className="label" style={{ color: src === "13F" ? "var(--cyan)" : "var(--ink-2)" }}>{src}</span>
                  </td>
                  <td>{w.n}</td>
                  <td>
                    <span className="up">{w.buys}</span>
                    <span className="dim"> / </span>
                    <span className="down">{w.sells}</span>
                  </td>
                  <td className={w.net > 0 ? "up" : w.net < 0 ? "down" : "dim"}>{w.net ? `${w.net > 0 ? "+" : "−"}$${fmtBig(Math.abs(w.net))}` : "n/d"}</td>
                  <td className="txt">
                    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                      {tick.map(([t, c]) => (
                        <Link key={t} href={`/security/${encodeURIComponent(t)}#flow`} className={`tkr${held.has(t) ? " held" : ""}`} style={{ fontSize: 11 }}>
                          {t}
                          {c > 1 && <span className="dim" style={{ fontWeight: 400 }}>×{c}</span>}
                        </Link>
                      ))}
                    </span>
                  </td>
                  <td className="dim">{fmtDay(w.last)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
