"use client";

/**
 * TOP — top news, Bloomberg TOP/CN style. One dense line per story:
 * ET time (HH:MM today, MM/DD before) · VADER micro-bar · headline (opens the
 * source) · ticker chips (held names outlined blue) · source code.
 * Reusable: `limit` and `ticker` let the full /news page and the security
 * screen's CN tab share it.
 */
import { useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type NewsRow } from "@/lib/api";
import { Empty, Panel, Seg, Skeleton, useNow } from "./ui";
import { DataAge } from "./DataAge";
import { HeldKey, SENT_STRONG, ScrollArea, SentBar, Tkr, etHM, etKey, mmdd, useHeld } from "./feedKit";
import s from "./feeds.module.css";

type Filter = "ALL" | "HELD" | "POS" | "NEG";

const COLS = "34px 26px minmax(0,1fr) auto 32px";

/** Short wire code for a feed name: "CNBC Markets" → CNBC, "MarketWatch Top" → MW. */
function srcCode(src: string): string {
  const s0 = src.toLowerCase();
  const known: [RegExp, string][] = [
    [/cnbc/, "CNBC"],
    [/marketwatch/, "MW"],
    [/seeking ?alpha/, "SA"],
    [/reuters/, "RTRS"],
    [/bloomberg/, "BBG"],
    [/yahoo/, "YHOO"],
    [/wall street journal|wsj/, "WSJ"],
    [/barron/, "BARR"],
    [/benzinga/, "BZ"],
    [/financial times|\bft\b/, "FT"],
    [/investing\.com/, "INV"],
    [/motley/, "FOOL"],
    [/sec\b|edgar/, "SEC"],
  ];
  for (const [rx, code] of known) if (rx.test(s0)) return code;
  const w = src.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w.map((x) => x[0]).join("") : (w[0] ?? "—")).slice(0, 4).toUpperCase();
}

export function NewsPanel({
  className = "",
  style,
  limit = 150,
  ticker,
}: {
  className?: string;
  style?: CSSProperties;
  /** Max stories to request (API caps at 200). */
  limit?: number;
  /** Only stories tagged with this ticker. */
  ticker?: string;
}) {
  const [filter, setFilter] = useState<Filter>("ALL");
  const tk = ticker?.toUpperCase();
  const { data, isLoading, isError } = useQuery<NewsRow[]>({
    queryKey: tk ? ["news", limit, tk] : ["news", limit],
    queryFn: () => api.news(Math.min(200, limit), tk),
    refetchInterval: 60_000,
  });
  const held = useHeld();
  const now = useNow(30_000);
  const today = now ? etKey(now) : null;

  const all = useMemo(() => data ?? [], [data]);
  const rows = useMemo(() => {
    switch (filter) {
      case "HELD":
        return all.filter((n) => n.tickers.some((t) => held.has(t)));
      case "POS":
        return all.filter((n) => (n.vader_score ?? 0) >= SENT_STRONG);
      case "NEG":
        return all.filter((n) => (n.vader_score ?? 0) <= -SENT_STRONG);
      default:
        return all;
    }
  }, [all, filter, held]);

  const stats = useMemo(() => {
    let pos = 0;
    let neg = 0;
    let sum = 0;
    let k = 0;
    let heldHits = 0;
    const srcs = new Set<string>();
    for (const n of all) {
      const v = n.vader_score ?? 0;
      if (v >= SENT_STRONG) pos++;
      else if (v <= -SENT_STRONG) neg++;
      if (n.vader_score != null) {
        sum += n.vader_score;
        k++;
      }
      if (n.tickers.some((t) => held.has(t))) heldHits++;
      srcs.add(srcCode(n.source));
    }
    return { pos, neg, neu: all.length - pos - neg, avg: k ? sum / k : null, heldHits, srcs: srcs.size };
  }, [all, held]);

  const latest = all[0]?.published_at ?? null;
  const opts: Filter[] = tk ? ["ALL", "POS", "NEG"] : ["ALL", "HELD", "POS", "NEG"];

  return (
    <Panel
      code={tk ? "CN" : "TOP"}
      title={tk ? `${tk} headlines` : "Headlines"}
      sub={data ? `${all.length} stories · ${stats.srcs} src` : undefined}
      actions={
        <>
          <Seg options={opts} value={filter} onChange={setFilter} label="News filter" />
          {data && <DataAge at={latest} />}
        </>
      }
      flush
      className={className}
      style={style}
      testId="panel-news"
    >
      <div className={s.col}>
        <ScrollArea watch={`${filter}|${rows.length}`}>
          {isLoading ? (
            <Skeleton rows={9} height={14} />
          ) : isError ? (
            <Empty>
              <span className="alert">News feed unavailable</span> — /news did not respond. Retrying every 60s.
            </Empty>
          ) : rows.length === 0 ? (
            <Empty>
              {filter === "HELD"
                ? `None of the last ${all.length} stories tag a held name.`
                : filter === "ALL"
                  ? tk
                    ? `No recent stories tagged ${tk}.`
                    : "No headlines yet — the RSS scrape runs every 15 min."
                  : `No ${filter === "POS" ? "positive" : "negative"} stories in the last ${all.length}.`}
            </Empty>
          ) : (
            rows.map((n) => {
              const day = etKey(n.published_at);
              const isToday = today != null && day === today;
              const ageMin = now ? (now - new Date(n.published_at).getTime()) / 60_000 : Infinity;
              const showChips = n.tickers.filter((t) => t !== tk);
              const chips = [...showChips].sort((a, b) => Number(held.has(b)) - Number(held.has(a)));
              return (
                <div key={n.id} className={s.row} style={{ gridTemplateColumns: COLS }} data-row>
                  <span
                    className={`${s.time}${ageMin < 60 ? ` ${s.timeFresh}` : ""}`}
                    title={`${day} ${etHM(n.published_at)} ET`}
                    suppressHydrationWarning
                  >
                    {today == null || isToday ? etHM(n.published_at) : mmdd(day)}
                  </span>
                  <SentBar v={n.vader_score} />
                  <a
                    className={s.hl}
                    href={n.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={n.summary ? `${n.title}\n\n${n.summary}` : n.title}
                  >
                    {n.title}
                  </a>
                  <span className={s.chips}>
                    {chips.slice(0, 3).map((t) => (
                      <Tkr key={t} t={t} chip held={held.has(t)} />
                    ))}
                    {chips.length > 3 && <span className={s.more}>+{chips.length - 3}</span>}
                  </span>
                  <span className={s.src} title={n.source}>
                    {srcCode(n.source)}
                  </span>
                </div>
              );
            })
          )}
          {data && filter !== "ALL" && rows.length > 0 && (
            <div className={s.empty} style={{ paddingTop: 10, gap: 6 }}>
              <span className="num" style={{ fontSize: 10.5 }}>
                {rows.length} of {all.length} stories{" "}
                {filter === "HELD" ? "tag a held name" : filter === "POS" ? `score sentiment ≥ +${SENT_STRONG.toFixed(2)}` : `score sentiment ≤ −${SENT_STRONG.toFixed(2)}`}
              </span>
              {filter === "HELD" && held.size > 0 && (
                <span className={s.chips} style={{ flexWrap: "wrap" }}>
                  <span className="label" style={{ marginRight: 4 }}>Book</span>
                  {[...held].sort().map((t) => (
                    <Tkr key={t} t={t} chip held />
                  ))}
                </span>
              )}
            </div>
          )}
        </ScrollArea>
        {data && all.length > 0 && (
          <div className={s.foot}>
            <span className={s.footLabel} title="Headline sentiment (VADER text score) — not price direction">
              Sent
            </span>
            <ToneBar pos={stats.pos} neu={stats.neu} neg={stats.neg} />
            <span className="num" style={{ fontSize: 10.5, color: "var(--ink-2)" }}>
              S+ {stats.pos} <span className="dim">· {stats.neu} ·</span> S− {stats.neg}
            </span>
            <span className={s.footLabel} style={{ marginLeft: 6 }}>
              Avg
            </span>
            <span
              className="num"
              style={{ fontSize: 10.5, color: "var(--ink-2)" }}
            >
              {stats.avg == null ? "—" : `${stats.avg >= 0 ? "+" : "−"}${Math.abs(stats.avg).toFixed(2)}`}
            </span>
            {!tk && (
              <>
                <span className={s.footLabel} style={{ marginLeft: 6 }}>
                  <HeldKey label="Held tags" />
                </span>
                <span className="num" style={{ fontSize: 10.5, color: stats.heldHits ? "var(--blue)" : "var(--ink-3)" }}>
                  {stats.heldHits}
                </span>
              </>
            )}
            <span className="num dim" style={{ marginLeft: "auto", fontSize: 10 }}>
              |s|&lt;{SENT_STRONG.toFixed(2)} = neutral · ET
            </span>
          </div>
        )}
      </div>
    </Panel>
  );
}

/** Three-segment breadth bar: positive / neutral / negative share. */
function ToneBar({ pos, neu, neg, width = 84 }: { pos: number; neu: number; neg: number; width?: number }) {
  const tot = pos + neu + neg || 1;
  const a = (pos / tot) * width;
  const b = (neu / tot) * width;
  return (
    <svg width={width} height={6} aria-hidden="true" className={s.svg}>
      <rect x={0} y={0} width={a} height={6} fill="var(--up)" opacity={0.6} />
      <rect x={a} y={0} width={b} height={6} fill="var(--ink-4)" />
      <rect x={a + b} y={0} width={width - a - b} height={6} fill="var(--down)" opacity={0.6} />
    </svg>
  );
}
