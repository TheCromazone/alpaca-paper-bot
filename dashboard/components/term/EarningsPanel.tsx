"use client";

/**
 * EVTS — earnings on deck. /earnings/upcoming grouped by report day:
 * ticker (held flag) · BMO/AMC · EPS estimate · last-4Q surprise bars
 * (oldest → newest) · average surprise. Held names inside the 2-day buy
 * blackout (bot/llm/tools.py EARNINGS_BLACKOUT_DAYS) get a warn marker.
 */
import { useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, term, type EarningsEvent } from "@/lib/api";
import { fmtChg, tone } from "@/lib/format";
import { Empty, Panel, Seg, Skeleton, useNow } from "./ui";
import { HeldKey, ScrollArea, Tkr, dayDiff, dayLabel, etKey, useHeld } from "./feedKit";
import s from "./feeds.module.css";

const BLACKOUT_DAYS = 2;
// Fixed minimums for the Launchpad tile; spare width spreads across columns on wide pages.
const COLS = "minmax(48px,1.2fr) minmax(28px,.5fr) minmax(42px,.7fr) 30px minmax(46px,.7fr) minmax(24px,.4fr) minmax(46px,.7fr) 10px";

type Filter = "ALL" | "HELD";

function session(tod: string | null): { code: string; title: string } {
  const t = (tod ?? "").toLowerCase();
  if (t.includes("pre") || t.includes("bmo")) return { code: "BMO", title: "Before market open" };
  if (t.includes("aft") || t.includes("post") || t.includes("amc")) return { code: "AMC", title: "After market close" };
  return { code: "TNS", title: "Time not supplied" };
}

const pct = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(1)}%`;

/** Four-quarter EPS surprise bars, oldest → newest, centred on zero. sqrt scale, ±30% saturates. */
function SurpriseBars({ vals }: { vals: (number | null)[] }) {
  const seq = [...vals].reverse(); // API is newest-first
  while (seq.length < 4) seq.unshift(null);
  const H = 18;
  const mid = H / 2;
  const bw = 5;
  const gap = 2;
  const W = 4 * bw + 3 * gap;
  const title = `EPS surprise, oldest → newest: ${seq.map((v) => (v == null ? "—" : pct(v))).join("  ")}`;
  return (
    <svg width={W} height={H} className={s.svg} role="img" aria-label={title}>
      <title>{title}</title>
      <line x1={-1} x2={W + 1} y1={mid} y2={mid} stroke="var(--line-2)" strokeWidth={1} />
      {seq.map((v, i) => {
        const x = i * (bw + gap);
        if (v == null) return <rect key={i} x={x} y={mid - 0.5} width={bw} height={1} fill="var(--ink-4)" />;
        const h = Math.max(1, Math.sqrt(Math.min(1, Math.abs(v) / 0.3)) * (mid - 1));
        return (
          <rect
            key={i}
            x={x}
            y={v >= 0 ? mid - h : mid}
            width={bw}
            height={h}
            fill={v >= 0 ? "var(--up)" : "var(--down)"}
            opacity={i === 3 ? 1 : 0.72}
          />
        );
      })}
    </svg>
  );
}

export function EarningsPanel({ className = "", style, days = 21 }: { className?: string; style?: CSSProperties; days?: number }) {
  const [filter, setFilter] = useState<Filter>("ALL");
  const { data, isLoading, isError } = useQuery<EarningsEvent[]>({
    queryKey: ["earnings", days],
    queryFn: () => api.earnings(days),
    refetchInterval: 600_000,
  });
  const held = useHeld();
  const { data: heat } = useQuery({ queryKey: ["heatmap"], queryFn: term.heatmap, refetchInterval: 60_000 });
  const chg5 = useMemo(() => new Map((heat?.cells ?? []).map((c) => [c.ticker, c.chg_5d])), [heat]);
  const now = useNow(60_000);
  const today = now ? etKey(now) : null;

  const groups = useMemo(() => {
    const evs = (data ?? []).filter((e) => filter === "ALL" || held.has(e.ticker));
    const m = new Map<string, EarningsEvent[]>();
    for (const e of evs) {
      const k = e.report_date.slice(0, 10); // date-only: never shift through a zone
      const arr = m.get(k) ?? [];
      arr.push(e);
      m.set(k, arr);
    }
    return [...m.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, arr]) => ({
        key: k,
        rows: arr.sort((a, b) => Number(held.has(b.ticker)) - Number(held.has(a.ticker)) || a.ticker.localeCompare(b.ticker)),
      }));
  }, [data, filter, held]);

  const total = data?.length ?? 0;
  const heldCount = (data ?? []).filter((e) => held.has(e.ticker)).length;
  const blackoutHeld = today
    ? (data ?? []).filter((e) => {
        const d = dayDiff(today, e.report_date.slice(0, 10));
        return held.has(e.ticker) && d >= 0 && d <= BLACKOUT_DAYS;
      }).length
    : 0;

  return (
    <Panel
      code="EVTS"
      title="Earnings on deck"
      sub={
        data ? (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            {total} in {days}d · <HeldKey label={`${heldCount} held`} />
          </span>
        ) : undefined
      }
      actions={<Seg options={["ALL", "HELD"] as Filter[]} value={filter} onChange={setFilter} label="Earnings filter" />}
      flush
      className={className}
      style={style}
      testId="panel-earnings"
    >
      <div className={s.col}>
        <ScrollArea watch={`${filter}|${groups.length}`}>
          {isLoading ? (
            <Skeleton rows={9} height={14} />
          ) : isError ? (
            <Empty>
              <span className="alert">Earnings calendar unavailable</span> — /earnings/upcoming did not respond.
            </Empty>
          ) : groups.length === 0 ? (
            <div className={s.empty}>
              <span className={s.emptyHead}>{filter === "HELD" ? "No held names report" : "No earnings on deck"}</span>
              <span>
                {filter === "HELD"
                  ? `None of the ${total} reports in the next ${days} days are names the book owns.`
                  : `No universe names report in the next ${days} days. The calendar refreshes daily at 22:00 UTC.`}
              </span>
            </div>
          ) : (
            <>
              <div className={s.head} style={{ gridTemplateColumns: COLS, columnGap: 6 }}>
                <span>Tkr</span>
                <span>Time</span>
                <span className={s.r}>EPS est</span>
                <span title="EPS surprise, last 4 quarters (oldest → newest)">L4Q</span>
                <span className={s.r} title="Average EPS surprise, last 4 quarters">Surp</span>
                <span className={s.r} title="Beats in the last 4 quarters">Beat</span>
                <span className={s.r} title="Price change over the last 5 sessions — the run into the print">5D</span>
                <span />
              </div>
              {groups.map((g) => {
                const dd = today ? dayDiff(today, g.key) : null;
                const inBlackout = dd != null && dd >= 0 && dd <= BLACKOUT_DAYS;
                return (
                  <div key={g.key}>
                    <div className={s.dayRule} style={{ background: "var(--bg)" }}>
                      <span>{dayLabel(g.key)}</span>
                      <span className={s.dayRuleLine} />
                      {inBlackout && (
                        <span className="warn" style={{ fontSize: 9, letterSpacing: "0.08em", opacity: 0.8 }} title="No new buys inside 2 days of a report (tools.py)">
                          BUY BLACKOUT
                        </span>
                      )}
                      <span style={{ color: dd != null && dd <= 1 ? "var(--ink)" : "var(--ink-3)", fontWeight: 600 }} suppressHydrationWarning>
                        {dd == null ? "" : dd < 0 ? `${-dd}D AGO` : dd === 0 ? "TODAY" : dd === 1 ? "T+1D" : `T+${dd}D`}
                      </span>
                    </div>
                    {g.rows.map((e) => {
                      const isHeld = held.has(e.ticker);
                      const warn = isHeld && inBlackout;
                      const ses = session(e.time_of_day);
                      const v = e.last_4_surprise_pcts.filter((x): x is number => x != null);
                      const avg = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
                      const beats = v.filter((x) => x > 0).length;
                      return (
                        <div
                          key={e.ticker}
                          className={`${s.row}${warn ? ` ${s.rowWarn}` : ""}`}
                          style={{ gridTemplateColumns: COLS, columnGap: 6, background: warn ? "var(--warn-bg)" : undefined }}
                          data-row
                        >
                          <span>
                            <Tkr t={e.ticker} held={isHeld} />
                          </span>
                          <span className={s.time} title={ses.title} style={{ color: ses.code === "TNS" ? "var(--ink-4)" : "var(--ink-2)" }}>
                            {ses.code}
                          </span>
                          <span className={s.num}>{e.eps_estimate == null ? "—" : e.eps_estimate.toFixed(2)}</span>
                          <SurpriseBars vals={e.last_4_surprise_pcts} />
                          <span
                            className={`${s.num} ${avg == null ? "flat" : avg > 0 ? "up" : avg < 0 ? "down" : "flat"}`}
                            title={v.length ? `Average surprise over the last ${v.length} quarters` : "No surprise history"}
                          >
                            {avg == null ? "—" : pct(avg)}
                          </span>
                          <span className={s.num} style={{ fontSize: 10.5, color: v.length && beats === v.length ? "var(--ink)" : "var(--ink-3)" }} title={v.length ? `Beat ${beats} of last ${v.length} quarters` : undefined}>
                            {v.length ? `${beats}/${v.length}` : "—"}
                          </span>
                          <span className={`${s.num} ${tone(chg5.get(e.ticker))}`} style={{ fontSize: 11 }}>
                            {fmtChg(chg5.get(e.ticker), 1)}
                          </span>
                          <span
                            className="warn"
                            style={{ fontSize: 11, textAlign: "center", lineHeight: 1 }}
                            title={warn ? `Held · reports ${dd === 0 ? "today" : `in ${dd}d`} — inside the ${BLACKOUT_DAYS}-day buy blackout (no top-ups)` : undefined}
                          >
                            {warn ? "⚠" : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </>
          )}
        </ScrollArea>
        {blackoutHeld > 0 && (
          <div className={s.foot} style={{ background: "var(--warn-bg)", borderTopColor: "rgba(255,210,63,.3)" }}>
            <span className="warn" style={{ fontWeight: 600, letterSpacing: "0.06em" }}>
              ⚠ {blackoutHeld} HELD IN BLACKOUT
            </span>
            <span className="dim" style={{ fontSize: 10.5 }}>
              no top-ups within {BLACKOUT_DAYS}d of a print
            </span>
          </div>
        )}
      </div>
    </Panel>
  );
}
