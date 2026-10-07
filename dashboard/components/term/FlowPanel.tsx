"use client";

/**
 * FLOW — insider & smart-money flow. Congressional PTRs (House/Senate) and
 * 13F position changes from /signals, grouped by filing date:
 *   trade date (or 13F quarter) · filing lag · filer · action · ticker ·
 *   amount · position change.
 * PTR amounts are disclosed *ranges* (the API stores the band midpoint), so
 * we print the band. 13F rows are quarter-over-quarter position changes:
 * NEW / ADD / TRIM / EXIT, the share change valued at the newer price, and
 * the % change in shares. Identical duplicate rows collapse into one "×n".
 */
import { Fragment, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api, type SignalRow } from "@/lib/api";
import { Panel, Seg, Skeleton } from "./ui";
import { BANDS, DayRule, HeldKey, ScrollArea, Tkr, dayDiff, dayOf, fmtK, mmdd, useHeld } from "./feedKit";
import s from "./feeds.module.css";

type Filter = "ALL" | "PTR" | "13F" | "HELD";

// Minimums fit the Launchpad tile; spare width spreads across columns on the full FLOW page.
const COLS = "40px 28px minmax(0,2.4fr) minmax(34px,.5fr) minmax(44px,.5fr) minmax(70px,.7fr) minmax(44px,.5fr)";
const COLS_PTR = "40px 28px minmax(0,2.4fr) minmax(34px,.5fr) minmax(44px,.5fr) minmax(74px,.7fr)";
const LATE_DAYS = 45; // STOCK Act PTR deadline; also the 13F filing deadline

type FRow = {
  key: string;
  kind: "PTR" | "13F";
  who: string;
  tag: "H" | "S" | "13F" | "—";
  tagTitle: string;
  side: "buy" | "sell";
  act: string;
  ticker: string;
  amount: number;
  filed: string;
  traded: string | null;
  tradedLabel: string;
  lag: number | null;
  url: string | null;
  n: number;
  amtText: string;
  amtKnown: boolean;
  posText: string;
  posTone: "up" | "down" | "flat";
  title: string;
};

const qLabel = (period: string) => {
  const m = Number(period.slice(5, 7));
  return `Q${Math.ceil(m / 3)}'${period.slice(2, 4)}`;
};

function normalize(r: SignalRow): Omit<FRow, "key" | "n"> {
  const meta = (r.meta ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof meta[k] === "string" ? (meta[k] as string) : null);
  const num = (k: string) => (typeof meta[k] === "number" ? (meta[k] as number) : null);
  const amount = r.amount ?? 0;
  if (r.kind === "investor") {
    const who = str("investor") || r.source;
    const filed = str("filed") || dayOf(r.as_of);
    const period = str("period");
    const change = (str("change") || (r.direction === "buy" ? "add" : "trim")).toLowerCase();
    const vo = num("value_old") ?? 0;
    const vn = num("value_new") ?? 0;
    let posText = "";
    let posTone: FRow["posTone"] = r.direction === "buy" ? "up" : "down";
    if (change === "new") posText = "NEW";
    else if (change === "exit") posText = "−100%";
    else {
      // amount = |Δshares| × newer price → share change vs the old share count.
      const base = r.direction === "buy" ? vn - amount : vn + amount;
      const pct = base > 0 ? (r.direction === "buy" ? amount : -amount) / base : null;
      posText = pct == null ? "—" : `${pct > 0 ? "+" : "−"}${Math.abs(pct * 100) >= 100 ? Math.round(Math.abs(pct * 100)) : Math.abs(pct * 100).toFixed(1)}%`;
      if (pct == null) posTone = "flat";
    }
    const form = str("form") || "13F";
    return {
      kind: "13F",
      who,
      tag: "13F",
      tagTitle: `${form} — quarterly holdings`,
      side: r.direction,
      act: change.toUpperCase(),
      ticker: r.ticker,
      amount,
      filed,
      traded: period,
      tradedLabel: period ? qLabel(period) : "—",
      lag: period ? dayDiff(period, filed) : null,
      url: str("source_url"),
      amtText: amount ? fmtK(r.direction === "buy" ? amount : -amount, true) : "—",
      amtKnown: amount > 0,
      posText,
      posTone,
      title: `${who} ${change.toUpperCase()} ${r.ticker} · ${form} for ${period ?? "?"} filed ${filed}\nPosition ${fmtK(vo)} → ${fmtK(vn)} · share change valued ${fmtK(amount)} at quarter-end price`,
    };
  }
  const who = str("politician") || r.source;
  const ch = (str("chamber") || "").toLowerCase();
  const tag: FRow["tag"] = ch.startsWith("sen") ? "S" : ch.startsWith("hou") ? "H" : "—";
  const filed = str("disclosed_on") || dayOf(r.as_of);
  const traded = str("traded_on");
  const band = amount ? BANDS[Math.round(amount)] : undefined;
  return {
    kind: "PTR",
    who,
    tag,
    tagTitle: tag === "S" ? "Senate PTR (eFD)" : tag === "H" ? "House PTR" : "Periodic transaction report",
    side: r.direction,
    act: r.direction === "buy" ? "BUY" : "SELL",
    ticker: r.ticker,
    amount,
    filed,
    traded,
    tradedLabel: traded ? mmdd(traded) : "—",
    lag: traded ? dayDiff(traded, filed) : null,
    url: str("source_url"),
    amtText: amount ? (band ?? `~${fmtK(amount)}`) : "n/d",
    amtKnown: amount > 0,
    posText: "",
    posTone: "flat",
    title: `${who} ${r.direction.toUpperCase()} ${r.ticker} · traded ${traded ?? "n/a"} · filed ${filed}${amount ? ` · ${band ?? fmtK(amount)}` : " · amount not disclosed"}`,
  };
}

type Net = { ticker: string; net: number; buyers: number; sellers: number };

export function FlowPanel({ className = "", style }: { className?: string; style?: CSSProperties }) {
  const [filter, setFilter] = useState<Filter>("ALL");
  const ptrQ = useQuery<SignalRow[]>({
    queryKey: ["signals", 200, "politician"],
    queryFn: () => api.signals(200, "politician"),
    refetchInterval: 300_000,
  });
  const f13Q = useQuery<SignalRow[]>({
    queryKey: ["signals", 500, "investor"],
    queryFn: () => api.signals(500, "investor"),
    refetchInterval: 600_000,
  });
  const held = useHeld();
  const isLoading = ptrQ.isLoading || f13Q.isLoading;
  const isError = ptrQ.isError && f13Q.isError;

  // Normalise + collapse identical duplicates (same filer/ticker/side/amount/dates).
  const all = useMemo<FRow[]>(() => {
    const m = new Map<string, FRow>();
    for (const r of [...(ptrQ.data ?? []), ...(f13Q.data ?? [])]) {
      const n = normalize(r);
      const key = [n.kind, n.who, n.ticker, n.side, n.amount, n.filed, n.traded ?? ""].join("|");
      const prev = m.get(key);
      if (prev) prev.n++;
      else m.set(key, { ...n, key, n: 1 });
    }
    return [...m.values()].sort(
      (a, b) => b.filed.localeCompare(a.filed) || (a.kind === b.kind ? 0 : a.kind === "PTR" ? -1 : 1) || b.amount - a.amount,
    );
  }, [ptrQ.data, f13Q.data]);

  const rows = useMemo(() => {
    if (filter === "PTR") return all.filter((r) => r.kind === "PTR");
    if (filter === "13F") return all.filter((r) => r.kind === "13F");
    if (filter === "HELD") return all.filter((r) => held.has(r.ticker));
    return all;
  }, [all, filter, held]);

  const net = useMemo<Net[]>(() => {
    const m = new Map<string, { net: number; b: Set<string>; s: Set<string> }>();
    for (const r of rows) {
      const e = m.get(r.ticker) ?? { net: 0, b: new Set<string>(), s: new Set<string>() };
      e.net += (r.side === "buy" ? 1 : -1) * r.amount * r.n;
      (r.side === "buy" ? e.b : e.s).add(r.who);
      m.set(r.ticker, e);
    }
    return [...m.entries()]
      .map(([ticker, e]) => ({ ticker, net: e.net, buyers: e.b.size, sellers: e.s.size }))
      .sort((a, b) => b.net - a.net || b.buyers - b.sellers - (a.buyers - a.sellers) || a.ticker.localeCompare(b.ticker))
      .slice(0, 5);
  }, [rows]);

  const perDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.filed, (m.get(r.filed) ?? 0) + r.n);
    return m;
  }, [rows]);

  const has13 = rows.some((r) => r.kind === "13F");
  const cols = has13 ? COLS : COLS_PTR;
  const nPtr = all.filter((r) => r.kind === "PTR").reduce((a, r) => a + r.n, 0);
  const n13 = all.filter((r) => r.kind === "13F").reduce((a, r) => a + r.n, 0);
  const nBuy = rows.filter((r) => r.side === "buy").reduce((a, r) => a + r.n, 0);
  const nAll = rows.reduce((a, r) => a + r.n, 0);
  const lagged = all.filter((r) => r.kind === "PTR" && r.lag != null);
  const medLag = lagged.length ? [...lagged].map((r) => r.lag as number).sort((a, b) => a - b)[Math.floor(lagged.length / 2)] : null;

  return (
    <Panel
      code="FLOW"
      title="Filings"
      sub={
        all.length ? (
          <span>
            {nPtr} PTR · {n13} 13F{medLag != null ? ` · median lag ${medLag}d` : ""}
          </span>
        ) : undefined
      }
      actions={<Seg options={["ALL", "PTR", "13F", "HELD"] as Filter[]} value={filter} onChange={setFilter} label="Flow filter" />}
      flush
      className={className}
      style={style}
      testId="panel-flow"
    >
      {isLoading ? (
        <Skeleton rows={9} height={14} />
      ) : isError ? (
        <FlowEmpty title="Signals unavailable" note="/signals did not respond — retrying every 5 min." alert />
      ) : all.length === 0 ? (
        <FlowEmpty title="No disclosures on file" note="Nothing scraped yet in this database. The jobs below populate this panel:" />
      ) : (
        <div className={s.col}>
          {rows.length > 0 && (
            <div className={s.strip}>
              <div className={s.stripLabel}>
                <span>
                  Net disclosed $ · top {net.length}
                  {filter === "ALL" ? " · 13F-weighted" : ""}
                </span>
                <span className="num" style={{ fontSize: 10, letterSpacing: 0, textTransform: "none", display: "inline-flex", gap: 8 }}>
                  <span>
                    <span className="up">{nBuy} buy</span> <span className="dim">/</span> <span className="down">{nAll - nBuy} sell</span>
                  </span>
                  <span className="dim">
                    <HeldKey label="blue = held" />
                  </span>
                </span>
              </div>
              <div className={s.tiles} style={{ gridTemplateColumns: `repeat(${Math.max(net.length, 1)}, minmax(0,1fr))` }}>
                {net.map((n) => (
                  <NetTile key={n.ticker} n={n} held={held.has(n.ticker)} />
                ))}
              </div>
            </div>
          )}
          <ScrollArea watch={`${filter}|${rows.length}`}>
            {rows.length > 0 && (
              <div className={s.head} style={{ gridTemplateColumns: cols, columnGap: 6 }}>
                <span title="PTR: transaction date · 13F: quarter reported">Trade</span>
                <span className={s.r} title="Days from trade (or quarter end) to filing">Lag</span>
                <span>Filer</span>
                <span>Act</span>
                <span>Tkr</span>
                <span className={s.r}>Amount</span>
                {has13 && (
                  <span className={s.r} title="13F: change in shares held">
                    ΔPos
                  </span>
                )}
              </div>
            )}
            {rows.length === 0 ? (
              filter === "13F" ? (
                <FlowEmpty title="No 13F changes on file" note={`13F holdings (30 funds) refresh weekly — Sun 06:00 UTC. ${nPtr} congressional PTRs are on file; switch to PTR.`} compact />
              ) : (
                <FlowEmpty title="No filings in held names" note={`None of the ${all.length} disclosures touch a ticker the book owns.`} compact />
              )
            ) : (
              rows.map((r, i) => {
                const rule = i === 0 || rows[i - 1].filed !== r.filed ? r.filed : null;
                const late = r.lag != null && r.lag > LATE_DAYS;
                return (
                  <Fragment key={r.key}>
                    {rule && (
                      <DayRule
                        dayKey={rule}
                        prefix="FILED"
                        right={
                          <span className="dim" style={{ fontWeight: 500 }}>
                            {perDay.get(rule)}
                          </span>
                        }
                      />
                    )}
                    <div className={s.row} style={{ gridTemplateColumns: cols, columnGap: 6 }} data-row title={r.title}>
                      <span className={s.time} style={{ color: r.kind === "13F" ? "var(--ink-3)" : "var(--ink-2)" }}>
                        {r.tradedLabel}
                      </span>
                      <span className={s.time} style={{ textAlign: "right", color: late ? "var(--warn)" : "var(--ink-3)" }} title={r.lag != null ? `${r.lag} days from ${r.kind === "13F" ? "quarter end" : "trade"} to filing${late ? ` — past the ${LATE_DAYS}-day deadline` : ""}` : "No trade date"}>
                        {r.lag != null ? `${r.lag}d` : "—"}
                      </span>
                      <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                        <span className={s.chamber} title={r.tagTitle}>
                          {r.tag}
                        </span>
                        <span className={s.ell} style={{ fontSize: 12, color: "var(--ink)" }}>
                          {r.who}
                        </span>
                        {r.n > 1 && (
                          <span className="num dim" style={{ fontSize: 10, flex: "none" }} title={`${r.n} identical filings`}>
                            ×{r.n}
                          </span>
                        )}
                      </span>
                      <span className={`${s.side} ${r.side === "buy" ? "up" : "down"}`} style={{ fontSize: r.act.length > 3 ? 10 : 10.5 }}>
                        {r.act}
                      </span>
                      <span>
                        <Tkr t={r.ticker} held={held.has(r.ticker)} />
                      </span>
                      <span className={s.num} style={{ color: r.amtKnown ? (r.kind === "13F" ? (r.side === "buy" ? "var(--up)" : "var(--down)") : "var(--ink)") : "var(--ink-4)", fontSize: 11 }}>
                        {r.url ? (
                          <a href={r.url} target="_blank" rel="noopener noreferrer" className={s.docLink} title={`${r.title}\nOpen filing ↗`}>
                            {r.amtText}
                          </a>
                        ) : (
                          r.amtText
                        )}
                      </span>
                      {has13 && (
                        <span className={`${s.num} ${r.posTone}`} style={{ fontSize: 10.5 }}>
                          {r.posText}
                        </span>
                      )}
                    </div>
                  </Fragment>
                );
              })
            )}
          </ScrollArea>
        </div>
      )}
    </Panel>
  );
}

function NetTile({ n, held }: { n: Net; held: boolean }) {
  const tot = n.buyers + n.sellers || 1;
  const buyShare = n.buyers / tot;
  return (
    <Link
      href={`/security/${encodeURIComponent(n.ticker)}`}
      className={s.tile}
      title={`${n.ticker}: ${n.buyers} filer${n.buyers === 1 ? "" : "s"} buying / ${n.sellers} selling · net ${fmtK(n.net, true)}`}
    >
      <span className={s.tileTop}>
        <span className={`${s.tkr}${held ? ` ${s.tkrHeldText}` : ""}`} style={{ fontSize: 11, flex: "none" }}>
          {n.ticker}
        </span>
        <span className={s.time} style={{ fontSize: 9.5, flex: "none", letterSpacing: "-0.03em" }}>
          {n.buyers}
          <span className="up">▲</span>
          {n.sellers > 0 && (
            <>
              {n.sellers}
              <span className="down">▼</span>
            </>
          )}
        </span>
      </span>
      <span className={`${s.mono} ${n.net > 0 ? "up" : n.net < 0 ? "down" : "flat"}`} style={{ fontSize: 13, fontWeight: 500 }}>
        {n.net === 0 ? "$0" : fmtK(n.net, true)}
      </span>
      <svg width="100%" height={3} aria-hidden="true" className={s.svg} preserveAspectRatio="none" viewBox="0 0 100 3" style={{ alignSelf: "end" }}>
        <rect x={0} y={0} width={100} height={3} fill="var(--bg-3)" />
        <rect x={0} y={0} width={buyShare * 100} height={3} fill="var(--up)" opacity={0.55} />
        {buyShare < 1 && <rect x={buyShare * 100} y={0} width={(1 - buyShare) * 100} height={3} fill="var(--down)" opacity={0.55} />}
      </svg>
    </Link>
  );
}

function FlowEmpty({ title, note, compact, alert }: { title: string; note: string; compact?: boolean; alert?: boolean }) {
  return (
    <div className={s.empty}>
      <span className={s.emptyHead} style={alert ? { color: "var(--alert)" } : undefined}>
        {title}
      </span>
      <span>{note}</span>
      {!compact && (
        <div className={s.sched}>
          <span className="amber">PTR·H</span>
          <span>House periodic transaction reports</span>
          <span className="dim">daily 07:00 UTC</span>
          <span className="amber">PTR·S</span>
          <span>Senate eFD disclosures</span>
          <span className="dim">daily 07:30 UTC</span>
          <span className="amber">13F</span>
          <span>30 tracked funds, position deltas</span>
          <span className="dim">weekly Sun 06:00</span>
        </div>
      )}
    </div>
  );
}
