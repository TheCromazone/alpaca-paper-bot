"use client";

/**
 * RISK — guards & analytics over /terminal/risk. Panel variant (Launchpad):
 * risk stat list, sector load vs the 25% cap and the per-position guard
 * table (distance to trailing stop / midday −7% cut, stop type, earnings
 * blackout), most-at-risk first. Page variant (/risk) adds tiles, a wider
 * guard table and position weights. Also exports the /risk charts:
 * `RiskCurve` (return vs SPY + underwater drawdown) and `ReturnDist`.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { term, type RiskGuard, type RiskResp } from "@/lib/api";
import { fmtChg, fmtNum, fmtPx, fmtSignedUSD, tone } from "@/lib/format";
import { Bar, Chg, Empty, Panel, Seg, Skeleton } from "./ui";
import { ScrollHost } from "./BotPanel";
import s from "./RiskPanel.module.css";

const MIDDAY_CUT = 0.07;
const SECTOR_CAP = 0.25;
const POSITION_CAP = 0.05;
const BLACKOUT_DAYS = 2;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-06-12" → "Jun 12" (no timezone shift). */
const fmtD = (d: string | null | undefined) => {
  if (!d) return "—";
  const [, m, dd] = d.slice(0, 10).split("-");
  return `${MONTHS[Number(m) - 1]} ${dd}`;
};
const pct = (n: number | null | undefined, digits = 2) =>
  n == null || !Number.isFinite(n) ? "—" : `${n < 0 ? "−" : ""}${Math.abs(n * 100).toFixed(digits)}%`;

export function useRisk() {
  return useQuery({ queryKey: ["risk"], queryFn: term.risk, refetchInterval: 60_000 });
}

// ── derived analytics ────────────────────────────────────────────────────

function derive(d: RiskResp) {
  const rets: { d: string; r: number }[] = [];
  for (let i = 1; i < d.curve.length; i++) {
    const a = d.curve[i - 1].equity;
    const b = d.curve[i].equity;
    if (a > 0 && b > 0) rets.push({ d: d.curve[i].d, r: b / a - 1 });
  }
  const best = rets.reduce<{ d: string; r: number } | null>((m, x) => (!m || x.r > m.r ? x : m), null);
  const worst = rets.reduce<{ d: string; r: number } | null>((m, x) => (!m || x.r < m.r ? x : m), null);
  const trough = d.curve.reduce<{ d: string; dd: number } | null>(
    (m, x) => (x.dd != null && (!m || x.dd < m.dd) ? { d: x.d, dd: x.dd } : m),
    null,
  );
  const up = rets.filter((x) => x.r > 0).length;
  // Concentration on *invested* weights (the API's HHI is on equity weights,
  // which overstates effective N while the book is half cash).
  const inv = d.weights.reduce((a, w) => a + w.weight, 0);
  const effN = inv > 0 ? 1 / d.weights.reduce((a, w) => a + (w.weight / inv) ** 2, 0) : null;
  const top5Inv = inv > 0 && d.top5_weight != null ? d.top5_weight / inv : null;
  return { rets, best, worst, trough, up, inv, effN, top5Inv };
}

/** /terminal/risk fields added server-side (not yet in lib/api types). */
type GuardX = RiskGuard & {
  guard_kind?: "stop" | "cut";
  guard_price?: number | null;
  guard_distance?: number | null;
  usd_beyond?: number | null;
  stop_enforced_by?: "broker" | "synthetic" | "none";
};
type Protection = { last_sync_at?: string | null; scheduler_alive?: boolean; dry_run?: boolean; synthetic_stops?: boolean };
const protectionOf = (d: RiskResp) => (d as RiskResp & { protection?: Protection }).protection ?? null;

const minDist = (g: RiskGuard) => Math.min(g.stop_distance ?? 9, g.cut_distance ?? 9);
/** The binding guard: the higher of stop and cut (closest to / furthest through price). */
const binding = (g: GuardX) => {
  const d = g.guard_distance ?? minDist(g);
  const kind = g.guard_kind ?? ((g.stop_distance ?? 9) <= (g.cut_distance ?? 9) ? "stop" : "cut");
  return { d: d === 9 ? null : d, kind };
};

/** Config sector keys → display names ("FixedIncome" → "Fixed income"). */
const SECTOR_NAMES: Record<string, string> = { FixedIncome: "Fixed income", RealEstate: "Real estate", ConsumerStaples: "Consumer staples", ConsumerDiscretionary: "Consumer disc." };
export const sectorName = (k: string) =>
  SECTOR_NAMES[k] ?? k.replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`);

/** One color rule everywhere: red = beyond the level (price below it),
 *  amber = within 2% above it, neutral otherwise. Badges use the same. */
const NEAR = 0.02;
function distTone(d: number | null | undefined): "breach" | "near" | "ok" | "na" {
  if (d == null || !Number.isFinite(d)) return "na";
  if (d < 0) return "breach";
  if (d < NEAR) return "near";
  return "ok";
}

/** Distance cell: the number stays ink; the CELL is tinted by state. */
function DistCell({ d, title }: { d: number | null | undefined; title: string }) {
  const t = distTone(d);
  return (
    <td className={s.distCell} data-t={t} title={t === "breach" ? `${title} — price is BELOW this level` : t === "near" ? `${title} — within 2%` : title}>
      {d == null ? "—" : `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d * 100).toFixed(2)}%`}
    </td>
  );
}

/**
 * Cushion bars on ONE common axis for every row: x = % distance from price
 * down to the guard (0 = at the guard), fixed ±25%. Upper bar → trailing
 * stop, lower bar → midday cut. Right of 0 = cushion, left = breached.
 * Beyond ±25% the bar ends in an arrow with its value printed at the end.
 */
const AX = 0.25;
const axX = (v: number, w: number) => ((Math.max(-AX, Math.min(AX, v)) + AX) / (2 * AX)) * w;
const TONE_C = { breach: "var(--alert)", near: "var(--warn)", ok: "var(--ink-3)", na: "var(--ink-4)" } as const;
const TICKS = [-0.2, -0.1, 0.1, 0.2];

function CushionBars({ g, width = 150, height = 18 }: { g: GuardX; width?: number; height?: number }) {
  const { d, kind } = binding(g);
  const x0 = axX(0, width);
  const f = (v: number | null | undefined) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(2)}%`);
  const title = `${g.ticker} ${fmtPx(g.price)} · binding guard: ${kind} ${fmtPx(kind === "stop" ? g.stop_price : g.cut_price)} (${f(d)}) · to stop ${f(g.stop_distance)} · to cut ${f(g.cut_distance)}`;
  if (d == null || !Number.isFinite(d)) {
    return (
      <svg width={width} height={height} aria-hidden="true">
        <line x1={x0} x2={x0} y1={0} y2={height} stroke="var(--ink-2)" />
      </svg>
    );
  }
  const c = TONE_C[distTone(d)];
  const x1 = axX(d, width);
  const over = Math.abs(d) > AX;
  const bh = 10;
  const by = (height - bh) / 2;
  const label = `${kind === "stop" ? "S" : "C"} ${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)}`;
  const lw = label.length * 5.3 + 2;
  // Value sits at the bar's outer end; if that would leave the plot, it goes
  // inside the bar (dark text) or, for a hairline bar, on the other side of 0.
  let lx: number, anchor: "start" | "end", fill: string;
  if (d >= 0) {
    if (x1 + 3 + lw <= width) [lx, anchor, fill] = [x1 + 3, "start", c];
    else if (x1 - x0 >= lw + 6) [lx, anchor, fill] = [x1 - (over ? 9 : 3), "end", "#000"];
    else [lx, anchor, fill] = [x0 - 3, "end", c];
  } else {
    if (x1 - 3 - lw >= 0) [lx, anchor, fill] = [x1 - 3, "end", c];
    else if (x0 - x1 >= lw + 6) [lx, anchor, fill] = [x1 + (over ? 9 : 3), "start", "#000"];
    else [lx, anchor, fill] = [x0 + 3, "start", c];
  }
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block", marginLeft: "auto", overflow: "visible" }} role="img">
      <title>{title}</title>
      {TICKS.map((v) => (
        <line key={v} x1={axX(v, width)} x2={axX(v, width)} y1={1} y2={height - 1} stroke="var(--line-2)" strokeWidth={1} strokeDasharray="1 2" />
      ))}
      <rect x={Math.min(x0, x1) + (over && d < 0 ? 6 : 0)} y={by} width={Math.max(2, Math.abs(x1 - x0) - (over ? 6 : 0))} height={bh} fill={c} />
      {over && <path d={d > 0 ? `M${width - 7},${by - 2}L${width},${by + bh / 2}L${width - 7},${by + bh + 2}Z` : `M7,${by - 2}L0,${by + bh / 2}L7,${by + bh + 2}Z`} fill={c} />}
      <line x1={x0} x2={x0} y1={0} y2={height} stroke="var(--ink-2)" strokeWidth={1} />
      <text x={lx} y={by + bh - 1.5} textAnchor={anchor} fill={fill} fontSize={8.8} fontWeight={600} fontFamily="var(--font-plex-mono)">
        {label}
      </text>
    </svg>
  );
}

/** Header ticks for the common cushion axis (percent). */
function CushionAxis({ width = 150 }: { width?: number }) {
  return (
    <svg width={width} height={11} viewBox={`0 0 ${width} 11`} style={{ display: "block", marginLeft: "auto", overflow: "visible" }} aria-label="Cushion axis −25% to +25%">
      {[-0.2, -0.1, 0, 0.1, 0.2].map((v) => (
        <text
          key={v}
          x={axX(v, width)}
          y={9}
          textAnchor="middle"
          fill={v === 0 ? "var(--ink-2)" : "var(--ink-3)"}
          fontSize={9}
          fontFamily="var(--font-plex-mono)"
        >
          {v === 0 ? "0" : `${v > 0 ? "+" : "−"}${Math.abs(v * 100)}`}
        </text>
      ))}
    </svg>
  );
}

function RailKey() {
  return (
    <span className={s.railKey} title="One bar per row for the binding guard (the higher of the 10% trailing stop and the −7% cut), on a common ±25% axis. Left of 0 = price below the guard (breached).">
      <span className={s.key}>
        <svg width={18} height={12} aria-hidden="true">
          <rect x={9} y={1} width={9} height={10} fill="var(--ink-3)" />
          <line x1={9} x2={9} y1={0} y2={12} stroke="var(--ink-2)" />
        </svg>
        S stop · C cut
      </span>
      <span className={s.key}>left of 0 = breached</span>
    </span>
  );
}

function Ern({ g }: { g: RiskGuard }) {
  if (g.earnings_in_days == null) return <span style={{ color: "var(--ink-4)" }}>—</span>;
  const days = Math.max(0, Math.ceil(g.earnings_in_days));
  const blackout = days <= BLACKOUT_DAYS;
  return (
    <span
      className={s.ern}
      data-blackout={blackout || undefined}
      title={`Earnings ${fmtD(g.earnings_at)}${blackout ? " — inside the 2-day blackout: no new buys" : ""}`}
      style={{ color: blackout ? undefined : "var(--ink-2)" }}
    >
      {days}d
    </span>
  );
}

// ── stats ────────────────────────────────────────────────────────────────

type StatDef = { k: string; label: string; short?: string; value: ReactNode; sub?: ReactNode; title?: string; bar?: { v: number; c: string } };

function statDefs(d: RiskResp, x: ReturnType<typeof derive>): StatDef[] {
  return [
    { k: "vol", label: "Ann. vol", value: pct(d.ann_vol), sub: `SPY ${pct(d.spy_ann_vol)}`, title: "Annualised volatility of daily equity returns" },
    { k: "sharpe", label: "Sharpe", value: fmtNum(d.sharpe, 2), sub: `ann. ret ${fmtChg(d.ann_return)}` },
    { k: "sortino", label: "Sortino", value: fmtNum(d.sortino, 2), sub: "downside-dev adj." },
    { k: "up", label: "Up days", value: pct(d.up_days_pct, 1), sub: `${x.up} / ${x.rets.length} sessions` },
    { k: "beta", label: "Beta", value: fmtNum(d.beta, 2), sub: "vs SPY · daily" },
    { k: "corr", label: "Corr", value: fmtNum(d.corr, 2), sub: "ρ to SPY · daily" },
    {
      k: "best",
      label: "Best day",
      short: "Best",
      value: <Chg value={d.best_day} />,
      sub: fmtD(x.best?.d),
      title: `Best daily return over ${x.rets.length} sessions since ${fmtD(d.curve[0]?.d)}`,
    },
    {
      k: "worst",
      label: "Worst day",
      short: "Worst",
      value: <Chg value={d.worst_day} />,
      sub: fmtD(x.worst?.d),
      title: `Worst daily return over ${x.rets.length} sessions since ${fmtD(d.curve[0]?.d)}`,
    },
    {
      k: "mdd",
      label: "Max DD",
      value: <span className={tone(d.max_drawdown)}>{pct(d.max_drawdown)}</span>,
      sub: `trough ${fmtD(x.trough?.d)}`,
    },
    {
      k: "dd",
      label: "Cur. DD",
      value: <span className={d.drawdown && d.drawdown < -0.0005 ? "down" : "flat"}>{pct(d.drawdown)}</span>,
      sub: d.max_drawdown ? `${Math.round(((d.drawdown ?? 0) / d.max_drawdown) * 100)}% of max DD` : "—",
      bar: d.max_drawdown ? { v: Math.min(1, (d.drawdown ?? 0) / d.max_drawdown), c: "var(--down)" } : undefined,
    },
    {
      k: "effn",
      label: "Eff. N",
      value: fmtNum(d.effective_n != null && d.effective_n <= d.positions + 0.01 ? d.effective_n : x.effN, 1),
      sub: `of ${d.positions} held · max ${d.max_positions}`,
      title: "Eff. N = 1 / Σ w² over invested weights — how many equally-weighted names this book behaves like (10 equal names = 10)",
      bar: { v: d.positions / d.max_positions, c: "var(--blue)" },
    },
    {
      k: "top5",
      label: "Top-5 wt",
      value: pct(d.top5_weight, 1),
      sub: `${pct(x.top5Inv, 1)} of invested`,
      title: "Top-5 wt: share of total equity held in the five largest positions (concentration)",
    },
  ];
}

function StatList({ defs }: { defs: StatDef[] }) {
  return (
    <div className={s.stats}>
      {defs.map((d) => (
        <div key={d.k} className={s.stat} title={[d.title, typeof d.sub === "string" ? d.sub : null].filter(Boolean).join(" · ")}>
          <span className={s.statLbl}>{d.short ?? d.label}</span>
          <span className={s.statVal}>{d.value}</span>
        </div>
      ))}
    </div>
  );
}

function Tiles({ defs }: { defs: StatDef[] }) {
  return (
    <div className={s.tiles}>
      {defs.map((d) => (
        <div key={d.k} className={s.tile} title={d.title}>
          <span className={s.tileLbl}>{d.label}</span>
          <span className={s.tileVal}>{d.value}</span>
          <span className={s.tileSub}>{d.sub}</span>
          {d.bar && (
            <span className={s.tileBar}>
              <span style={{ width: `${Math.max(0, d.bar.v) * 100}%`, background: d.bar.c }} />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── sector load + weights ────────────────────────────────────────────────

function SectorLoad({ d, page }: { d: RiskResp; page: boolean }) {
  const max = 0.3;
  return (
    <div className={s.sectors} data-page={page || undefined}>
      {d.sector_load.length === 0 && <span className="dim">No positions.</span>}
      {d.sector_load.map((x) => {
        const c = x.over ? "var(--alert)" : x.weight >= x.cap * 0.8 ? "var(--warn)" : "rgba(59,140,255,0.8)";
        return (
          <div key={x.sector} className={s.sector} title={`${sectorName(x.sector)}: ${pct(x.weight)} of equity · cap ${pct(x.cap, 0)}`}>
            <span className={s.sectorName}>{sectorName(x.sector)}</span>
            <Bar value={x.weight} max={max} cap={x.cap} color={c} width="100%" height={page ? 7 : 5} />
            <span className={s.sectorVal} style={{ color: x.over ? "var(--alert)" : undefined }}>
              {pct(x.weight, 1)}
            </span>
            {page && (
              <span className={s.sectorVal} style={{ color: "var(--ink-3)" }}>
                {x.over ? "OVER" : `${pct(x.cap - x.weight, 1)}`}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Weights({ d }: { d: RiskResp }) {
  const max = Math.max(POSITION_CAP * 1.25, ...d.weights.map((w) => w.weight));
  return (
    <div style={{ padding: "3px 0" }}>
      {d.weights.map((w) => (
        <div key={w.ticker} className={s.wRow} data-row="" data-cut-ok="">
          <Link href={`/security/${encodeURIComponent(w.ticker)}`} className="tkr held">
            {w.ticker}
          </Link>
          <span style={{ color: "var(--ink-3)", fontFamily: "var(--font-plex-cond)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sectorName(w.sector)}</span>
          <Bar value={w.weight} max={max} cap={POSITION_CAP} color={w.weight > POSITION_CAP ? "var(--warn)" : "rgba(59,140,255,0.8)"} width="100%" height={6} />
          <span>{pct(w.weight, 2)}</span>
          <span style={{ color: "var(--ink-2)" }}>${fmtNum(w.market_value, 0)}</span>
        </div>
      ))}
    </div>
  );
}

// ── guard table ──────────────────────────────────────────────────────────

const enfOf = (g: GuardX) => g.stop_enforced_by ?? (g.broker_stop ? "broker" : "none");
/** The single exit-by value when every row agrees, else null. */
const uniformEnf = (d: RiskResp) => {
  const vals = new Set((d.guards as GuardX[]).map(enfOf));
  return vals.size === 1 ? [...vals][0] : null;
};

/** How breached stops get executed right now — said once for the book. */
function StopNote({ d }: { d: RiskResp }) {
  if (!d.guards.length) return null;
  const p = protectionOf(d);
  const why = [p?.scheduler_alive === false ? "scheduler down" : null, p?.dry_run ? "dry run" : null].filter(Boolean).join(" · ");
  const u = uniformEnf(d);
  if (u === "none")
    return (
      <span
        className="pill alert"
        title={`No broker stop orders, and the 5-min sync_account job that sells breached synthetic stops is not running${why ? ` (${why})` : ""}. Nothing sells a breach automatically; the −7% cut needs the midday routine.`}
      >
        Exit by: none{why ? ` — ${why.split(" · ")[0]}` : ""}
      </span>
    );
  if (u === "broker") return <span className="pill" title="Every position has a live Alpaca trailing-stop order">Exit by: broker</span>;
  if (u === "synthetic") return <span className="pill" title="Breached trailing stops are sold by the 5-min sync_account sweep">Exit by: sync job</span>;
  return (
    <span className={`pill ${p?.synthetic_stops ? "" : "alert"}`} title="Mixed: see the Exit by column">
      {p?.synthetic_stops ? "Synthetic stops armed" : "Stops not armed"}
    </span>
  );
}

const ENF_TEXT = { broker: "broker", synthetic: "sync job", none: "none" } as const;

function GuardTable({ d, page }: { d: RiskResp; page: boolean }) {
  const guards = useMemo(() => [...d.guards].sort((a, b) => minDist(a) - minDist(b)), [d.guards]);
  const wt = useMemo(() => new Map(d.weights.map((w) => [w.ticker, w.weight])), [d.weights]);
  const railW = page ? 200 : 160;
  const showEnf = uniformEnf(d) == null;
  if (!guards.length) return <Empty>No open positions — nothing to guard.</Empty>;
  return (
    <table className={`tbl ${s.guards}`}>
      <thead>
        <tr>
          <th>Tkr</th>
          {page && <th>Last</th>}
          {page && <th>Avg cost</th>}
          <th>P&amp;L</th>
          <th title="Binding guard (S = 10% trailing stop, C = −7% cut) on one common ±25% axis" style={{ paddingTop: 2, paddingBottom: 1 }}>
            <CushionAxis width={railW} />
          </th>
          {page && <th>Stop px</th>}
          <th title="Distance from price down to the trailing stop">→ Stop</th>
          {page && <th>Cut px</th>}
          <th title="Distance from price down to the midday −7% from-cost cut">→ Cut</th>
          {page && <th>Trail</th>}
          {showEnf && (
            <th title="Who executes the trailing stop on a breach: broker = live Alpaca order · sync job = 5-min synthetic-stop sweep · none = nothing will (manual action needed)">
              Exit by
            </th>
          )}
          <th title="Days to next earnings report (≤2 = blackout)">Ern</th>
          <th title="Weight of equity">Wt</th>
        </tr>
      </thead>
      <tbody>
        {(guards as GuardX[]).map((g) => {
          // Row state follows the BINDING guard — the same rule as the badges.
          const bt = distTone(binding(g).d);
          const enf = enfOf(g);
          return (
            <tr key={g.ticker} data-row="" data-cut-ok="" data-breach={bt === "breach" || undefined} data-near={bt === "near" || undefined}>
              <td>
                <Link href={`/security/${encodeURIComponent(g.ticker)}`} className="tkr">
                  {g.ticker}
                </Link>
              </td>
              {page && <td style={{ color: "var(--ink-2)" }}>{fmtPx(g.price)}</td>}
              {page && <td style={{ color: "var(--ink-3)" }}>{fmtPx(g.avg_cost)}</td>}
              <td>
                <Chg value={g.pnl_pct} />
              </td>
              <td style={{ paddingTop: 0, paddingBottom: 0 }}>
                <CushionBars g={g} width={railW} />
              </td>
              {page && <td style={{ color: "var(--ink-3)" }}>{fmtPx(g.stop_price)}</td>}
              <DistCell d={g.stop_distance} title={`Trailing stop ${fmtPx(g.stop_price)} (${pct(g.trail_pct, 0)} trail)`} />
              {page && <td style={{ color: "var(--ink-3)" }}>{fmtPx(g.cut_price)}</td>}
              <DistCell d={g.cut_distance} title={`Midday cut ${fmtPx(g.cut_price)} (cost −${MIDDAY_CUT * 100}%)`} />
              {page && <td style={{ color: "var(--ink-3)" }}>{pct(g.trail_pct, 0)}</td>}
              {showEnf && (
                <td
                  className={s.enf}
                  data-enf={enf}
                  title={
                    enf === "none"
                      ? `No broker order and the sync job is not armed${bt === "breach" && g.usd_beyond ? ` — $${fmtNum(g.usd_beyond, 0)} beyond the guard` : ""}`
                      : enf === "broker"
                        ? "Live Alpaca trailing-stop order"
                        : "Sold by the 5-min sync_account sweep on a breach"
                  }
                >
                  {ENF_TEXT[enf]}
                </td>
              )}
              <td>
                <Ern g={g} />
                {page && g.earnings_at && <span style={{ color: "var(--ink-4)", marginLeft: 5 }}>{fmtD(g.earnings_at)}</span>}
              </td>
              <td style={{ color: "var(--ink-3)" }}>{pct(wt.get(g.ticker), page ? 2 : 1)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── the panel ────────────────────────────────────────────────────────────

export function RiskPanel({
  className = "",
  style,
  variant = "panel",
}: {
  className?: string;
  style?: CSSProperties;
  variant?: "panel" | "page";
}) {
  const page = variant === "page";
  const { data, isLoading, isError } = useRisk();
  const x = useMemo(() => (data ? derive(data) : null), [data]);
  const defs = data && x ? statDefs(data, x) : null;
  // Badges count ROWS by their binding guard: breached = through it; within
  // 2% = NOT breached and the binding guard is less than 2% away.
  const bTones = data ? (data.guards as GuardX[]).map((g) => distTone(binding(g).d)) : [];
  const breaches = bTones.filter((x) => x === "breach").length;
  const near = bTones.filter((x) => x === "near").length;
  const blackout = data ? data.guards.filter((g) => g.earnings_in_days != null && Math.ceil(g.earnings_in_days) <= BLACKOUT_DAYS).length : 0;

  return (
    <Panel
      code="RISK"
      title={page ? "Guards & analytics" : "Guards"}
      sub={
        data
          ? `${data.positions}/${data.max_positions} pos · cash ${pct(data.cash_pct, 1)} · stats over ${data.observations} sessions since ${fmtD(data.curve[0]?.d)}`
          : undefined
      }
      className={className}
      style={style}
      bodyStyle={{ display: "flex", flexDirection: "column", padding: 0 }}
      live={data ? data.as_of : isLoading ? undefined : null}
      actions={
        data ? (
          <>
            {breaches > 0 && (
              <span className="pill alert" title="Positions trading below their binding guard (the higher of the trailing stop and the −7% cut)">
                {breaches} breached
              </span>
            )}
            {near > 0 && (
              <span className="pill warn" title="Positions NOT breached whose binding guard (the higher of stop and cut) is less than 2% below price">
                {near} within 2%
              </span>
            )}
            {blackout > 0 && page && <span className="pill warn">{blackout} blackout</span>}
          </>
        ) : null
      }
    >
      {isLoading ? (
        <Skeleton rows={8} height={16} />
      ) : isError || !data || !defs ? (
        <Empty>Risk model unavailable — /terminal/risk did not answer.</Empty>
      ) : page ? (
        <>
          <Tiles defs={defs} />
          <div className={s.split}>
            <div className={s.splitMain}>
              <div className={s.secHead}>
                <span className={s.secTitle}>Position guards · most at risk first</span>
                <span className={s.secMeta}>
                  <RailKey />
                  <StopNote d={data} />
                </span>
              </div>
              <ScrollHost>
                <GuardTable d={data} page />
              </ScrollHost>
            </div>
            <div className={s.splitSide}>
              <div className={s.secHead}>
                <span className={s.secTitle}>Sector load</span>
                <span className={s.secMeta}>
                  <span className={s.key}>
                    <span className={s.keySw} style={{ background: "var(--warn)" }} />
                    cap {pct(SECTOR_CAP, 0)}
                  </span>
                  headroom
                </span>
              </div>
              <SectorLoad d={data} page />
              <div className={s.secHead} style={{ borderTop: "1px solid var(--line)" }}>
                <span className={s.secTitle}>Position weights</span>
                <span className={s.secMeta}>
                  <span className={s.key}>
                    <span className={s.keySw} style={{ background: "var(--warn)" }} />
                    entry cap {pct(POSITION_CAP, 0)}
                  </span>
                  {pct(x?.inv, 1)} invested
                </span>
              </div>
              <ScrollHost minHeight={60}>
                <Weights d={data} />
              </ScrollHost>
            </div>
          </div>
        </>
      ) : (
        <>
          <StatList defs={defs} />
          <div className={s.secHead}>
            <span className={s.secTitle}>Sector load</span>
            <span className={s.secMeta}>
              <span className={s.key}>
                <span className={s.keySw} style={{ background: "var(--warn)" }} />
                cap {pct(SECTOR_CAP, 0)}
              </span>
            </span>
          </div>
          <SectorLoad d={data} page={false} />
          <div className={s.secHead}>
            <span className={s.secTitle} title="Sorted most at risk first">
              Guards ↓risk
            </span>
            <span className={s.secMeta}>
              <RailKey />
              <StopNote d={data} />
            </span>
          </div>
          <ScrollHost>
            <GuardTable d={data} page={false} />
          </ScrollHost>
        </>
      )}
    </Panel>
  );
}

// ── /risk charts ─────────────────────────────────────────────────────────

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

function niceTicks(lo: number, hi: number, n = 4) {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => span / k <= n + 0.5) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(Math.abs(v) < 1e-12 ? 0 : v);
  return out;
}

const RANGES = ["1M", "3M", "6M", "MAX"] as const;
type Range = (typeof RANGES)[number];
const RANGE_DAYS: Record<Range, number> = { "1M": 22, "3M": 64, "6M": 128, MAX: 100000 };

/** Cumulative return vs SPY (rebased to the window) + underwater drawdown. */
export function RiskCurve({ className = "", style }: { className?: string; style?: CSSProperties }) {
  const { data, isLoading } = useRisk();
  const [range, setRange] = useState<Range>("MAX");
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const pts = useMemo(() => {
    const c = data?.curve ?? [];
    const win = c.slice(-RANGE_DAYS[range]);
    if (!win.length) return [];
    const b0 = 1 + (win[0].bot_pct ?? 0);
    const s0 = 1 + (win[0].spy_pct ?? 0);
    return win.map((p) => ({
      d: p.d,
      eq: p.equity,
      bot: p.bot_pct == null ? null : (1 + p.bot_pct) / b0 - 1,
      spy: p.spy_pct == null ? null : (1 + p.spy_pct) / s0 - 1,
      dd: p.dd ?? 0,
    }));
  }, [data, range]);

  const last = pts[pts.length - 1];
  const R = 58; // right axis gutter
  const B = 16; // bottom axis
  const T = 26; // legend band
  const gap = 18;
  const iw = Math.max(10, w - R - 8);
  const topH = Math.max(40, (h - T - B - gap) * 0.7);
  const botH = Math.max(20, h - T - B - gap - topH);
  const vals = pts.flatMap((p) => [p.bot, p.spy]).filter((v): v is number => v != null);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const padv = (hi - lo) * 0.08 || 0.01;
  const yLo = lo - padv;
  const yHi = hi + padv;
  const ddLo = Math.min(-0.005, ...pts.map((p) => p.dd)) * 1.15;
  const X = (i: number) => 8 + (pts.length > 1 ? (i / (pts.length - 1)) * iw : iw / 2);
  const Y = (v: number) => T + (1 - (v - yLo) / (yHi - yLo)) * topH;
  const Y2 = (v: number) => T + topH + gap + (v / ddLo) * botH;
  const path = (k: "bot" | "spy") =>
    pts.reduce((acc, p, i) => (p[k] == null ? acc : `${acc}${acc ? "L" : "M"}${X(i).toFixed(1)},${Y(p[k] as number).toFixed(1)}`), "");
  const ddPath = pts.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y2(p.dd).toFixed(1)}`).join("");
  const botLine = path("bot");
  const tagYs = [last?.bot, last?.spy].filter((v): v is number => v != null).map((v) => Y(v));
  const yt = niceTicks(yLo, yHi, 6);
  const ddt = niceTicks(ddLo, 0, 2);
  const months = pts
    .map((p, i) => ({ i, m: p.d.slice(5, 7), d: p.d }))
    .filter((p, k, arr) => k === 0 || p.m !== arr[k - 1].m)
    .slice(1);
  const troughI = pts.reduce((m, p, i) => (p.dd < pts[m]?.dd ? i : m), 0);
  const hv = hover != null ? pts[hover] : null;
  const botTone = (last?.bot ?? 0) >= 0 ? "var(--up)" : "var(--down)";

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.round(((px - 8) / iw) * (pts.length - 1));
    setHover(i < 0 || i >= pts.length ? null : i);
  };

  return (
    <Panel
      code="MARS"
      title="Return vs SPY · drawdown"
      sub={last ? `since ${fmtD(pts[0].d)} · ${pts.length} sessions` : undefined}
      className={className}
      style={style}
      bodyStyle={{ padding: 0 }}
      actions={<Seg options={RANGES} value={range} onChange={setRange} label="Range" />}
    >
      <div ref={ref} className={s.chartHost}>
        {isLoading ? (
          <Skeleton rows={6} />
        ) : pts.length < 2 ? (
          <Empty>Not enough history for a curve yet.</Empty>
        ) : w > 0 && h > 0 ? (
          <>
            <svg width={w} height={h} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ cursor: "crosshair" }}>
              <defs>
                <linearGradient id="riskBotFill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={botTone} stopOpacity={0.16} />
                  <stop offset="100%" stopColor={botTone} stopOpacity={0} />
                </linearGradient>
              </defs>
              {/* grid + y axis (right, Bloomberg-style) */}
              {yt.map((v) => (
                <g key={`y${v}`}>
                  <line x1={8} x2={8 + iw} y1={Y(v)} y2={Y(v)} stroke={v === 0 ? "var(--ink-4)" : "var(--line)"} strokeDasharray={v === 0 ? "2 3" : undefined} />
                  {!tagYs.some((ty) => Math.abs(ty - Y(v)) < 13) && (
                    <text x={w - R + 6} y={Y(v) + 3.5} fill="var(--ink-3)" fontSize={10} fontFamily="var(--font-plex-mono)">
                      {fmtChg(v, 1)}
                    </text>
                  )}
                </g>
              ))}
              {months.map((m) => (
                <g key={m.d}>
                  <line x1={X(m.i)} x2={X(m.i)} y1={T} y2={T + topH + gap + botH} stroke="var(--line)" />
                  {(hover == null || Math.abs(X(m.i) + 12 - X(hover)) > 40) && (
                    <text x={X(m.i) + 3} y={h - 4} fill="var(--ink-3)" fontSize={10} fontFamily="var(--font-plex-mono)">
                      {MONTHS[Number(m.m) - 1]}
                    </text>
                  )}
                </g>
              ))}
              {/* bot area + lines */}
              {botLine && <path d={`${botLine}L${X(pts.length - 1)},${Y(0)}L${X(0)},${Y(0)}Z`} fill="url(#riskBotFill)" />}
              <path d={path("spy")} fill="none" stroke="var(--ink-3)" strokeWidth={1.1} strokeDasharray="3 2" />
              <path d={botLine} fill="none" stroke="var(--ink)" strokeWidth={1.5} strokeLinejoin="round" />
              {/* underwater pane */}
              <text x={10} y={T + topH + gap - 5} fill="var(--ink-3)" fontSize={9} fontFamily="var(--font-plex-cond)" letterSpacing="0.08em">
                DRAWDOWN
              </text>
              {ddt.map((v) => (
                <g key={`d${v}`}>
                  <line x1={8} x2={8 + iw} y1={Y2(v)} y2={Y2(v)} stroke="var(--line)" />
                  <text x={w - R + 6} y={Y2(v) + 3.5} fill="var(--ink-3)" fontSize={10} fontFamily="var(--font-plex-mono)">
                    {fmtChg(v, 1)}
                  </text>
                </g>
              ))}
              <path d={`${ddPath}L${X(pts.length - 1)},${Y2(0)}L${X(0)},${Y2(0)}Z`} fill="rgba(255,79,79,0.18)" />
              <path d={ddPath} fill="none" stroke="var(--down)" strokeWidth={1} />
              {pts[troughI] && pts[troughI].dd < 0 && (
                <g>
                  <circle cx={X(troughI)} cy={Y2(pts[troughI].dd)} r={2.5} fill="var(--down)" />
                  <text
                    x={X(troughI) + (X(troughI) > w * 0.75 ? -9 : 9)}
                    y={Y2(pts[troughI].dd) + 3}
                    textAnchor={X(troughI) > w * 0.75 ? "end" : "start"}
                    fill="var(--down)"
                    fontSize={9.5}
                    fontFamily="var(--font-plex-mono)"
                  >
                    MDD {fmtChg(pts[troughI].dd, 2)} {fmtD(pts[troughI].d)}
                  </text>
                </g>
              )}
              {/* last-value tags on the right axis */}
              {last?.spy != null && (
                <g>
                  <rect x={w - R + 1} y={Y(last.spy) - 7} width={R - 3} height={14} fill="var(--ink-3)" />
                  <text x={w - R + 5} y={Y(last.spy) + 3.5} fill="#000" fontSize={10} fontWeight={600} fontFamily="var(--font-plex-mono)">
                    {fmtChg(last.spy, 2)}
                  </text>
                </g>
              )}
              {last?.bot != null && (
                <g>
                  <rect x={w - R + 1} y={Y(last.bot) - 7} width={R - 3} height={14} fill="var(--ink)" />
                  <text x={w - R + 5} y={Y(last.bot) + 3.5} fill="#000" fontSize={10} fontWeight={600} fontFamily="var(--font-plex-mono)">
                    {fmtChg(last.bot, 2)}
                  </text>
                </g>
              )}
              {/* crosshair */}
              {hv && hover != null && (
                <g pointerEvents="none">
                  <line x1={X(hover)} x2={X(hover)} y1={T} y2={T + topH + gap + botH} stroke="var(--ink-3)" strokeDasharray="2 2" />
                  {hv.spy != null && <circle cx={X(hover)} cy={Y(hv.spy)} r={2.5} fill="var(--ink-3)" />}
                  {hv.bot != null && <circle cx={X(hover)} cy={Y(hv.bot)} r={3} fill="var(--ink)" stroke="#000" />}
                  <circle cx={X(hover)} cy={Y2(hv.dd)} r={2.5} fill="var(--down)" />
                  <rect x={X(hover) - 24} y={h - B + 1} width={48} height={14} fill="var(--amber)" />
                  <text x={X(hover)} y={h - 4} textAnchor="middle" fill="#000" fontSize={10} fontWeight={600} fontFamily="var(--font-plex-mono)">
                    {fmtD(hv.d)}
                  </text>
                </g>
              )}
            </svg>
            {(() => {
              const p = hv ?? last;
              if (!p) return null;
              const alpha = p.bot != null && p.spy != null ? p.bot - p.spy : null;
              return (
                <div className={s.legend}>
                  <span className={s.legendHead}>
                    {fmtD(p.d)} {p.d.slice(0, 4)}
                  </span>
                  <span>
                    <i className={s.sw} style={{ background: "var(--ink)" }} />
                    Bot <b className={tone(p.bot)}>{fmtChg(p.bot)}</b>
                  </span>
                  <span>
                    <i className={s.sw} style={{ background: "none", borderTop: "1.5px dashed var(--ink-3)", height: 0 }} />
                    SPY <b className={tone(p.spy)}>{fmtChg(p.spy)}</b>
                  </span>
                  <span>
                    Alpha <b className={tone(alpha)}>{alpha == null ? "—" : `${alpha >= 0 ? "+" : "−"}${Math.abs(alpha * 100).toFixed(2)} pts`}</b>
                  </span>
                  <span>
                    DD <b className={p.dd < 0 ? "down" : "flat"}>{fmtChg(p.dd)}</b>
                  </span>
                  <span>
                    Equity <b style={{ color: "var(--ink)" }}>${fmtNum(p.eq, 0)}</b>
                  </span>
                  {!hv && <span style={{ marginLeft: "auto", color: "var(--ink-4)" }}>hover for crosshair</span>}
                </div>
              );
            })()}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

/** Histogram of daily returns with a fitted normal and the 95% VaR line. */
export function ReturnDist({ className = "", style }: { className?: string; style?: CSSProperties }) {
  const { data, isLoading } = useRisk();
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const st = useMemo(() => {
    if (!data) return null;
    const r = derive(data).rets.map((x) => x.r);
    const n = r.length;
    if (n < 5) return null;
    const mean = r.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
    const skew = r.reduce((a, b) => a + ((b - mean) / sd) ** 3, 0) / n;
    const kurt = r.reduce((a, b) => a + ((b - mean) / sd) ** 4, 0) / n - 3;
    const sorted = [...r].sort((a, b) => a - b);
    const q = sorted[Math.max(0, Math.floor(0.05 * n) - 1)] ?? sorted[0];
    const tail = sorted.filter((v) => v <= q);
    const cvar = tail.reduce((a, b) => a + b, 0) / (tail.length || 1);
    const bw = 0.0025;
    const lo = Math.floor(sorted[0] / bw) * bw;
    const hi = Math.ceil(sorted[n - 1] / bw) * bw;
    const bins: { a: number; b: number; n: number }[] = [];
    for (let a = lo; a < hi - 1e-9; a += bw) bins.push({ a, b: a + bw, n: 0 });
    for (const v of r) {
      const i = Math.min(bins.length - 1, Math.max(0, Math.floor((v - lo) / bw)));
      bins[i].n++;
    }
    return { n, mean, sd, skew, kurt, var95: q, cvar, bins, bw, lo, hi };
  }, [data]);

  const L = 26;
  const B = 16;
  const T = 10;
  const iw = Math.max(10, w - L - 8);
  const ih = Math.max(10, h - T - B);
  const maxN = st ? Math.max(...st.bins.map((b) => b.n)) : 1;
  const X = (v: number) => (st ? L + ((v - st.lo) / (st.hi - st.lo)) * iw : 0);
  const Y = (n: number) => T + ih - (n / (maxN * 1.08)) * ih;
  const pdf = (x: number) => (st ? (1 / (st.sd * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * ((x - st.mean) / st.sd) ** 2) : 0);
  const normPath = st
    ? Array.from({ length: 80 }, (_, i) => {
        const v = st.lo + ((st.hi - st.lo) * i) / 79;
        return `${i ? "L" : "M"}${X(v).toFixed(1)},${Y(pdf(v) * st.n * st.bw).toFixed(1)}`;
      }).join("")
    : "";
  const xt = st ? niceTicks(st.lo, st.hi, 5) : [];
  const yt = niceTicks(0, maxN, 3);
  const eq = data?.equity ?? 0;

  return (
    <Panel code="DIST" title="Daily return distribution" sub={st ? `${st.n} sessions · 25bp bins` : undefined} className={className} style={style} bodyStyle={{ padding: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ position: "relative", flex: 1, minHeight: 120 }}>
        <div ref={ref} className={s.chartHost}>
          {isLoading ? (
            <Skeleton rows={5} />
          ) : !st ? (
            <Empty>Not enough sessions for a distribution.</Empty>
          ) : w > 0 && h > 0 ? (
            <svg width={w} height={h} onMouseLeave={() => setHover(null)}>
              {yt.map((v) => (
                <g key={v}>
                  <line x1={L} x2={L + iw} y1={Y(v)} y2={Y(v)} stroke="var(--line)" />
                  <text x={L - 5} y={Y(v) + 3.5} textAnchor="end" fill="var(--ink-3)" fontSize={9.5} fontFamily="var(--font-plex-mono)">
                    {v}
                  </text>
                </g>
              ))}
              {xt.map((v) => (
                <text key={v} x={X(v)} y={h - 4} textAnchor="middle" fill="var(--ink-3)" fontSize={9.5} fontFamily="var(--font-plex-mono)">
                  {fmtChg(v, 1)}
                </text>
              ))}
              {st.bins.map((b, i) => {
                const mid = (b.a + b.b) / 2;
                const c = Math.abs(mid) < 1e-9 ? "var(--ink-3)" : mid > 0 ? "var(--up)" : "var(--down)";
                const x0 = X(b.a) + 0.5;
                const bwPx = Math.max(1, X(b.b) - X(b.a) - 1);
                return (
                  <g key={i} onMouseEnter={() => setHover(i)}>
                    <rect x={x0} y={T} width={bwPx} height={ih} fill="transparent" />
                    <rect x={x0} y={Y(b.n)} width={bwPx} height={T + ih - Y(b.n)} fill={c} opacity={hover === i ? 1 : b.b <= st.var95 + 1e-9 ? 0.95 : 0.62} />
                  </g>
                );
              })}
              <path d={normPath} fill="none" stroke="var(--ink-2)" strokeWidth={1} strokeDasharray="3 2" pointerEvents="none" />
              <line x1={X(0)} x2={X(0)} y1={T} y2={T + ih} stroke="var(--ink-4)" pointerEvents="none" />
              <g pointerEvents="none">
                <line x1={X(st.var95)} x2={X(st.var95)} y1={T} y2={T + ih} stroke="var(--warn)" strokeDasharray="3 2" />
                <text x={X(st.var95) - 4} y={T + 9} textAnchor="end" fill="var(--warn)" fontSize={9.5} fontFamily="var(--font-plex-mono)">
                  VaR95 {fmtChg(st.var95, 2)}
                </text>
              </g>
              {hover != null && st.bins[hover] && (
                <g pointerEvents="none">
                  <rect x={Math.min(w - 132, Math.max(L, X(st.bins[hover].a) - 60))} y={T} width={128} height={30} fill="rgba(0,0,0,0.88)" stroke="var(--line-2)" />
                  <text x={Math.min(w - 132, Math.max(L, X(st.bins[hover].a) - 60)) + 6} y={T + 12} fill="var(--amber)" fontSize={10} fontFamily="var(--font-plex-mono)">
                    {fmtChg(st.bins[hover].a, 2)} … {fmtChg(st.bins[hover].b, 2)}
                  </text>
                  <text x={Math.min(w - 132, Math.max(L, X(st.bins[hover].a) - 60)) + 6} y={T + 25} fill="var(--ink)" fontSize={10} fontFamily="var(--font-plex-mono)">
                    {st.bins[hover].n} session{st.bins[hover].n === 1 ? "" : "s"} · {((st.bins[hover].n / st.n) * 100).toFixed(1)}%
                  </text>
                </g>
              )}
            </svg>
          ) : null}
        </div>
      </div>
      {st && (
        <div className={s.distStats}>
          {[
            ["Mean / day", <Chg key="m" value={st.mean} digits={3} />],
            ["σ / day", <span key="s" className="num">{pct(st.sd, 3)}</span>],
            ["Skew", <span key="k" className="num">{fmtNum(st.skew, 2)}</span>],
            ["Ex. kurt", <span key="x" className="num">{fmtNum(st.kurt, 2)}</span>],
            ["VaR 95 · 1d", <span key="v" className="num down">{pct(st.var95)}</span>],
            ["VaR $", <span key="vd" className="num down">{fmtSignedUSD(st.var95 * eq, 0)}</span>],
            ["CVaR 95", <span key="c" className="num down">{pct(st.cvar)}</span>],
            ["CVaR $", <span key="cd" className="num down">{fmtSignedUSD(st.cvar * eq, 0)}</span>],
          ].map(([k, v]) => (
            <div key={k as string}>
              <div className="label" style={{ fontSize: 9 }}>
                {k}
              </div>
              <div style={{ fontSize: 12 }}>{v}</div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
