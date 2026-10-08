"use client";

/**
 * PORT — the holdings monitor. One dense row per position (Bloomberg security
 * monitor idiom): 30-session spark, last, 1D, avg cost, weight, unrealized,
 * the GUARD that binds (S = 10% trailing stop, C = −7% cut from cost —
 * whichever is higher fires first) and the distance to it. Sortable; rows
 * open the security; hover shows the entry thesis.
 *
 * One severity rule everywhere: BREACHED (red tag, tinted row) when price is
 * at or below the binding guard; amber within 3% of it; neutral otherwise.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { api, term, type QuoteRow, type RiskGuard, type RiskResp } from "@/lib/api";
import { fmtChg, fmtNum, fmtPx, fmtSignedUSD, tone } from "@/lib/format";
import { Empty, Panel, Skeleton, useNow } from "./ui";
import { DataAge } from "./DataAge";
import { useHeldMonitor, usePositions } from "./useHeld";
import s from "./PortMonitor.module.css";

const MINUS = "−";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NEAR = 0.02; // "near" = within 2% above the binding guard
const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
const toneVar = (v: number | null | undefined) => (tone(v) === "up" ? "var(--up)" : tone(v) === "down" ? "var(--down)" : "var(--ink-2)");
const usdK = (v: number | null | undefined) => {
  if (!finite(v)) return "—";
  const a = Math.abs(v);
  const sg = v < 0 ? MINUS : "";
  return a >= 1e6 ? `${sg}$${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `${sg}$${(a / 1e3).toFixed(2)}K` : `${sg}$${fmtNum(a, 0)}`;
};
/** ISO → "Jun 24 '26" without timezone drift for date-only strings. */
const isoDay = (iso: string | null) => (iso ? `${MON[+iso.slice(5, 7) - 1]} ${iso.slice(8, 10)} ’${iso.slice(2, 4)}` : "—");

const SECTOR_ABBR: Record<string, string> = {
  Technology: "TECH",
  Financials: "FINL",
  Consumer: "CONS",
  Healthcare: "HLTH",
  Materials: "MATL",
  FixedIncome: "BOND",
  Industrials: "INDU",
  Energy: "ENRG",
  Utilities: "UTIL",
  RealEstate: "REIT",
  Communication: "COMM",
  Index: "INDX",
};

type Severity = "breached" | "near" | "ok";

/** /terminal/risk guard fields added by the API (single source with the
 *  BRIEF): the binding guard, its distance, $ already past it, and who would
 *  actually sell. Typed locally until lib/api.ts carries them. */
type GuardX = RiskGuard & {
  guard_kind?: "stop" | "cut";
  guard_price?: number | null;
  guard_distance?: number | null;
  usd_beyond?: number | null;
  stop_enforced_by?: "broker" | "synthetic" | "none";
};
type Protection = { scheduler_alive?: boolean; synthetic_stops?: boolean; dry_run?: boolean; last_sync_at?: string | null };

type Row = {
  t: string;
  name: string;
  sector: string;
  qty: number;
  avg: number;
  last: number;
  chg1d: number | null;
  mv: number;
  w: number | null;
  pnl: number;
  pnlPct: number;
  stopPx: number;
  stopDist: number | null;
  cutPx: number;
  cutDist: number | null;
  trail: number;
  /** The guard that fires first (the higher price) and the distance to it. */
  guardKind: "S" | "C";
  guardPx: number;
  guard: number | null;
  sev: Severity;
  /** 0 ok · 1 near · 2 breached — for sorting the Status column. */
  sevRank: number;
  /** Today's $ change on the position: qty × (last − previous close). */
  day: number | null;
  broker: boolean;
  /** Who would actually close this position at its guard. */
  order: "broker" | "synthetic" | "none";
  orderWhy: string;
  /** $ already through the binding guard ((guard − last) × qty), 0 if not breached. */
  usdBeyond: number;
  opened: string | null;
  days: number | null;
  spark: (number | null)[];
  thesis: string | null;
  thesisAt: string | null;
  earnIn: number | null;
};

type Key = "t" | "last" | "chg1d" | "day" | "qty" | "avg" | "mv" | "w" | "pnl" | "pnlPct" | "guardPx" | "guard" | "status" | "order" | "days";

/** Responsive column classes (see the @container rules in the CSS module). */
const HIDE: Partial<Record<Key | "spark", string>> = {
  qty: s["c-qty"],
  avg: s["c-avg"],
  days: s["c-days"],
  spark: s["c-spark"],
  w: s["c-wt"],
  day: s["c-day"],
};
/** First column of each visual group gets extra lead-in space. */
const GRP: Partial<Record<Key | "spark", string>> = { last: s.grpWide, qty: s.grp, pnl: s.grp, guardPx: s.grp };
const cx = (k: Key | "spark") => [HIDE[k], GRP[k]].filter(Boolean).join(" ") || undefined;

const COLS: { k: Key | "spark"; label: string; title: string; w?: number }[] = [
  { k: "t", label: "Ticker", title: "Ticker — E6 = earnings in 6 days" },
  { k: "spark", label: "30D", title: "Last 30 sessions, colored by the 30-day direction", w: 50 },
  { k: "last", label: "Last", title: "Last price" },
  { k: "chg1d", label: "1D", title: "1-day change, %" },
  { k: "day", label: "Day $", title: "Today's P&L on the position: qty × (last − previous close)" },
  { k: "qty", label: "Qty", title: "Shares held" },
  { k: "avg", label: "Avg cost", title: "Average cost per share" },
  { k: "mv", label: "Mkt val", title: "Market value ($)" },
  { k: "w", label: "Wt %", title: "Weight, % of equity" },
  { k: "pnl", label: "P&L $", title: "Unrealized P&L ($)" },
  { k: "pnlPct", label: "P&L %", title: "Unrealized P&L (% of cost)" },
  {
    k: "guardPx",
    label: "Guard lvl",
    title: "Level the bot watches — S = 10% trailing stop off the peak, C = −7% cut from cost; whichever is higher binds. See ORDER for what would actually sell.",
  },
  { k: "guard", label: "Dist", title: "Distance from price to the binding guard" },
  { k: "status", label: "Status", title: "BREACHED = price at/below the binding guard · NEAR = within 2% of it. Default order: breached, near, then by weight." },
  {
    k: "order",
    label: "Order",
    title: "What would close the position at its guard — broker: a live stop order at Alpaca · synthetic: no broker order, the midday routine sells · none: no broker order and the bot is off, so nothing sells automatically",
  },
  { k: "days", label: "Days", title: "Days held" },
];

export function PortMonitor({ className = "", style }: { className?: string; style?: CSSProperties }) {
  const router = useRouter();
  const now = useNow(60_000);
  const positions = usePositions();
  const monitor = useHeldMonitor(positions.data);
  const summary = useQuery({ queryKey: ["summary"], queryFn: api.summary, refetchInterval: 15_000 });
  const risk = useQuery({ queryKey: ["risk"], queryFn: term.risk, refetchInterval: 60_000 });
  const bot = useQuery({ queryKey: ["bot-status"], queryFn: api.botStatus, refetchInterval: 30_000 });
  const botActive = bot.data?.active ?? true;
  const botRoutines = bot.data?.routines_enabled;
  // default: what needs attention first — breached, then near, then by weight
  const [sort, setSort] = useState<{ k: Key; dir: 1 | -1 }>({ k: "status", dir: -1 });
  const [tip, setTip] = useState<{ row: Row; rect: DOMRect; panel: DOMRect } | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const equity = summary.data?.equity ?? risk.data?.equity ?? null;

  const prot = (risk.data as (RiskResp & { protection?: Protection }) | undefined)?.protection;

  const rows = useMemo<Row[]>(() => {
    const quotes = new Map<string, QuoteRow>((monitor.data?.rows ?? []).map((q) => [q.ticker, q]));
    const guards = new Map<string, GuardX>(((risk.data?.guards ?? []) as GuardX[]).map((g) => [g.ticker, g]));
    return (positions.data ?? []).map((p) => {
      const q = quotes.get(p.ticker);
      const g = guards.get(p.ticker);
      const last = p.market_price || q?.last || 0;
      const stopPx = g?.stop_price ?? p.stop_price;
      const cutPx = g?.cut_price ?? p.avg_cost * 0.93;
      // the API's binding guard is the single source (BRIEF shows the same numbers)
      const guardPx = g?.guard_price ?? Math.max(stopPx, cutPx);
      const guard = g?.guard_distance ?? (guardPx > 0 && last ? last / guardPx - 1 : null);
      const kind: "S" | "C" = g?.guard_kind ? (g.guard_kind === "cut" ? "C" : "S") : stopPx >= cutPx ? "S" : "C";
      const sev: Severity = guard == null ? "ok" : guard <= 0 ? "breached" : guard < NEAR ? "near" : "ok";
      const order: Row["order"] = g?.stop_enforced_by ?? (g?.broker_stop || p.stop_order_id ? "broker" : botActive ? "synthetic" : "none");
      const why: string[] = [];
      if (order === "none") {
        if (prot?.scheduler_alive === false) why.push("the scheduler is down");
        if (prot?.dry_run) why.push("dry-run mode is on, so orders are only simulated");
        if (kind === "C" && botRoutines === false) why.push("LLM routines are off and the −7% cut is sold by the midday routine");
      }
      const orderWhy =
        order === "broker"
          ? "A live stop order is working at Alpaca"
          : order === "synthetic"
            ? kind === "C"
              ? "No broker order — the midday routine sells at the −7% cut"
              : "No broker order — the 5-minute account sync sells once the trailing stop is breached"
            : `Nothing will sell this automatically${why.length ? `: ${why.join("; ")}` : ""}.${sev === "breached" ? " Sell it by hand." : ""}`;
      return {
        t: p.ticker,
        name: q?.name ?? p.ticker,
        sector: q?.sector ?? p.sector,
        qty: p.qty,
        avg: p.avg_cost,
        last,
        chg1d: q?.chg_1d ?? null,
        day: q && finite(q.last) && finite(q.prev) ? p.qty * (q.last - q.prev) : null,
        mv: p.market_value,
        w: equity ? p.market_value / equity : null,
        pnl: p.unrealized_pnl,
        pnlPct: p.unrealized_pct,
        stopPx,
        stopDist: stopPx > 0 && last ? last / stopPx - 1 : null,
        cutPx,
        cutDist: cutPx > 0 && last ? last / cutPx - 1 : null,
        trail: g?.trail_pct ?? 0.1,
        guardKind: kind,
        guardPx,
        guard,
        sev,
        sevRank: sev === "breached" ? 2 : sev === "near" ? 1 : 0,
        broker: g?.broker_stop ?? !!p.stop_order_id,
        order,
        orderWhy,
        usdBeyond: g?.usd_beyond ?? (sev === "breached" && guard != null ? Math.max(0, (guardPx - last) * p.qty) : 0),
        opened: p.opened_at,
        days: now && p.opened_at ? Math.max(0, Math.floor((now - new Date(p.opened_at).getTime()) / 86_400_000)) : null,
        spark: q?.spark ?? [],
        thesis: p.thesis,
        thesisAt: p.decision_at,
        earnIn: g?.earnings_in_days ?? null,
      };
    });
  }, [positions.data, monitor.data, risk.data, equity, now, botActive, botRoutines, prot]);

  const sorted = useMemo(() => {
    const { k, dir } = sort;
    if (k === "status")
      // same order as the BRIEF: status group, then $ already past the guard,
      // then distance — deepest breach first, closest call first otherwise
      return [...rows].sort((a, b) => {
        const g = (a.sevRank - b.sevRank) * dir;
        if (g) return g;
        const usd = (b.usdBeyond || 0) - (a.usdBeyond || 0);
        if (usd) return usd;
        const da = Math.abs(a.guard ?? 0);
        const db = Math.abs(b.guard ?? 0);
        return a.sev === "breached" ? db - da : da - db;
      });
    return [...rows].sort((a, b) => {
      const va = a[k];
      const vb = b[k];
      if (typeof va === "string" && typeof vb === "string") return va.localeCompare(vb) * dir;
      const na = finite(va as number) ? (va as number) : -Infinity;
      const nb = finite(vb as number) ? (vb as number) : -Infinity;
      return (na - nb) * dir;
    });
  }, [rows, sort]);

  const tot = useMemo(() => {
    const mv = rows.reduce((a, r) => a + r.mv, 0);
    const pnl = rows.reduce((a, r) => a + r.pnl, 0);
    const basis = mv - pnl;
    const dayRows = rows.filter((r) => r.day != null);
    return {
      mv,
      pnl,
      pnlPct: basis > 0 ? pnl / basis : null,
      day: dayRows.length ? dayRows.reduce((a, r) => a + (r.day as number), 0) : null,
      w: equity ? mv / equity : null,
      breached: rows.filter((r) => r.sev === "breached").length,
      near: rows.filter((r) => r.sev === "near").length,
      beyond: rows.reduce((a, r) => a + (r.usdBeyond || 0), 0),
      dayBase: dayRows.reduce((a, r) => a + r.mv - (r.day as number), 0),
    };
  }, [rows, equity]);

  // book day % on equity (prior close) — the same base as the KPI strip and the BRIEF
  const dayPctEq = tot.day != null && equity ? tot.day / (equity - tot.day) : null;

  const sectors = useMemo(() => {
    const load = risk.data?.sector_load;
    if (load?.length) return [...load].sort((a, b) => b.weight - a.weight);
    return (summary.data?.sector_breakdown ?? []).map((x) => ({ sector: x.sector, weight: x.weight, cap: 0.25, over: x.weight > 0.25 }));
  }, [risk.data, summary.data]);

  const n = rows.length;

  // Fit to the height we're given, always showing whole, dense rows (22px;
  // up to 24 to absorb slack). Leftover room buys the badge legend first,
  // then the sector strip. If even 22px rows can't all fit, show a whole
  // number of rows and cue how many more are below.
  const [fit, setFit] = useState({ rowH: 22, legend: false, sectors: false, visible: 0 });
  useEffect(() => {
    const el = panelRef.current;
    if (!el || !n) return;
    const ro = new ResizeObserver(() => {
      const avail = el.clientHeight - (statsRef.current?.offsetHeight ?? 36) - 21 - 25 - 1;
      let next: { rowH: number; legend: boolean; sectors: boolean; visible: number };
      if (avail >= n * 22) {
        const legend = avail - 24 >= n * 22;
        const sectors = legend && avail - 48 >= n * 22;
        const rest = avail - (legend ? 24 : 0) - (sectors ? 24 : 0);
        next = { rowH: Math.min(24, Math.floor(rest / n)), legend, sectors, visible: n };
      } else {
        const visible = Math.max(1, Math.floor(avail / 22));
        next = { rowH: Math.floor(avail / visible), legend: false, sectors: false, visible };
      }
      setFit((p) => (p.rowH === next.rowH && p.legend === next.legend && p.sectors === next.sectors && p.visible === next.visible ? p : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [n]);
  const below = fit.visible ? Math.max(0, n - fit.visible - Math.round(scrollTop / fit.rowH)) : 0;

  useEffect(() => () => void (tipTimer.current && clearTimeout(tipTimer.current)), []);

  const onSort = (k: Key) => setSort((p) => (p.k === k ? { k, dir: p.dir === 1 ? -1 : 1 } : { k, dir: k === "t" ? 1 : -1 }));
  const enter = (row: Row, el: HTMLElement) => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => {
      const panel = panelRef.current?.getBoundingClientRect();
      if (panel) setTip({ row, rect: el.getBoundingClientRect(), panel });
    }, 160);
  };
  const leave = () => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    setTip(null);
  };

  let body: ReactNode;
  if (positions.isLoading) body = <Skeleton rows={10} height={16} />;
  else if (positions.isError && !positions.data) body = <Empty>Positions unavailable — the API could not reach Alpaca or the local snapshot.</Empty>;
  else if (!n) body = <Empty>The book is flat. New positions only open in the 09:30 ET execute routine (max 2 a day, 5% each).</Empty>;
  else
    body = (
      <div className={s.wrap} ref={panelRef}>
        <div className={s.stats} ref={statsRef}>
          <Stat label="Invested / equity">
            {usdK(tot.mv)}
            <span className={s.statSub}>{tot.w != null ? `${(tot.w * 100).toFixed(1)}%` : ""}</span>
          </Stat>
          <Stat label="Cash / equity" className={s.statOpt}>
            {usdK(summary.data?.cash ?? risk.data?.cash)}
            <span className={s.statSub}>{finite(risk.data?.cash_pct) ? `${(risk.data!.cash_pct! * 100).toFixed(1)}%` : ""}</span>
          </Stat>
          <Stat label="Buying power" title="Buying power, including margin">
            {usdK(summary.data?.buying_power)}
          </Stat>
          <Stat label="Day P&L" title="Today's P&L on the held book (Σ qty × (last − previous close)), % of equity at the prior close">
            <span style={{ color: toneVar(tot.day) }}>{tot.day == null ? "—" : fmtSignedUSD(tot.day, 0)}</span>
            <span className={s.statSub} style={{ color: toneVar(tot.day) }}>
              {dayPctEq != null ? fmtChg(dayPctEq) : ""}
            </span>
          </Stat>
          <Stat label="$ past guards" title="Σ (guard − last) × qty across breached positions — what is already below the binding guards">
            <span style={{ color: tot.beyond > 0 ? "var(--alert)" : "var(--ink-2)" }}>{usdK(tot.beyond)}</span>
            <span className={s.statSub}>{tot.breached ? `in ${tot.breached} names` : "none"}</span>
          </Stat>
        </div>

        <div
          className={s.scroll}
          onMouseLeave={leave}
          onScroll={(e) => {
            leave();
            setScrollTop(e.currentTarget.scrollTop);
          }}
        >
          <table className={s.tbl} style={{ "--row-h": `${fit.rowH}px` } as CSSProperties}>
            <thead>
              <tr>
                {COLS.map((c) =>
                  c.k === "spark" ? (
                    <th key={c.k} title={c.title} className={HIDE[c.k]} style={{ textAlign: "center", width: c.w }}>
                      {c.label}
                    </th>
                  ) : (
                    <th key={c.k} title={c.title} className={cx(c.k)} aria-sort={sort.k === c.k ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                      <button type="button" onClick={() => onSort(c.k as Key)}>
                        {c.label}
                        {sort.k === c.k && <span className={s.caret}>{sort.dir === 1 ? "▲" : "▼"}</span>}
                      </button>
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr
                  key={r.t}
                  className={r.sev === "breached" ? s.sevB : r.sev === "near" ? s.sevN : undefined}
                  onClick={() => router.push(`/security/${encodeURIComponent(r.t)}`)}
                  onMouseEnter={(e) => enter(r, e.currentTarget)}
                  onMouseLeave={leave}
                >
                  <td>
                    <Link href={`/security/${encodeURIComponent(r.t)}`} className={s.tkr} onClick={(e) => e.stopPropagation()} prefetch={false}>
                      {r.t}
                      {finite(r.earnIn) && r.earnIn >= -0.5 && r.earnIn <= 7 && (
                        <span
                          className={r.earnIn <= 2 ? `pill warn ${s.chip}` : s.evt}
                          title={`Earnings in ${r.earnIn < 1 ? "under a day" : `${Math.round(r.earnIn)} days`}${r.earnIn <= 2 ? " — inside the 2-day earnings blackout" : ""}`}
                        >
                          E{Math.max(0, Math.round(r.earnIn))}
                        </span>
                      )}
                    </Link>
                  </td>
                  <td className={HIDE.spark} style={{ padding: "0 3px" }}>
                    <span className={s.spk}>
                      <Spark30 data={r.spark} />
                      <span className={`num ${s.spkPct}`} style={{ color: toneVar(spark30(r.spark)) }}>
                        {fmtChg(spark30(r.spark), 1)}
                      </span>
                    </span>
                  </td>
                  <td className={GRP.last}>{fmtPx(r.last)}</td>
                  <td style={{ color: toneVar(r.chg1d) }}>{fmtChg(r.chg1d)}</td>
                  <td className={HIDE.day} style={{ color: toneVar(r.day) }}>
                    {r.day == null ? "—" : fmtSignedUSD(r.day, 0).replace("$", "")}
                  </td>
                  <td className={cx("qty")} style={{ color: "var(--ink-2)" }}>
                    {fmtNum(r.qty, Number.isInteger(r.qty) ? 0 : 2)}
                  </td>
                  <td className={HIDE.avg} style={{ color: "var(--ink-2)" }}>
                    {fmtPx(r.avg)}
                  </td>
                  <td>{fmtNum(r.mv, 0)}</td>
                  <td className={HIDE.w} style={{ color: "var(--ink-2)" }}>
                    {r.w != null ? `${(r.w * 100).toFixed(1)}%` : "—"}
                  </td>
                  <td className={GRP.pnl} style={{ color: toneVar(r.pnl) }}>
                    {fmtSignedUSD(r.pnl, 0).replace("$", "")}
                  </td>
                  <td style={{ color: toneVar(r.pnlPct) }}>{fmtChg(r.pnlPct, 1)}</td>
                  <td
                    className={GRP.guardPx}
                    style={{ color: "var(--ink-2)" }}
                    title={`${r.guardKind === "S" ? `S — ${Math.round(r.trail * 100)}% trailing stop` : "C — −7% cut from cost"} binds at ${fmtPx(r.guardPx)}. Avg cost ${fmtPx(r.avg)} · trail stop ${fmtPx(r.stopPx)} (${fmtChg(r.stopDist, 1)}) · cut ${fmtPx(r.cutPx)} (${fmtChg(r.cutDist, 1)})`}
                  >
                    {fmtPx(r.guardPx)}
                    <span className={s.gk} title={`${r.guardKind === "S" ? "Trailing-stop level" : "−7% cut level"} the bot watches — not an order; see ORDER for what would sell`}>
                      {r.guardKind}
                    </span>
                  </td>
                  <td style={{ color: r.sev === "breached" ? "var(--alert)" : r.sev === "near" ? "var(--warn)" : "var(--ink-2)" }}>{fmtChg(r.guard, 1)}</td>
                  <td>
                    {r.sev === "breached" ? (
                      <span className={`pill alert ${s.chip}`}>BREACHED</span>
                    ) : r.sev === "near" ? (
                      <span className={`pill warn ${s.chip}`}>NEAR</span>
                    ) : (
                      <span className={s.statusOk}>OK</span>
                    )}
                  </td>
                  <td
                    title={r.orderWhy}
                    style={{
                      fontFamily: "var(--font-plex-cond), sans-serif",
                      fontSize: 10.5,
                      color: r.order === "broker" ? "var(--ink-2)" : r.order === "synthetic" ? "var(--ink-2)" : r.sev === "breached" ? "var(--alert)" : "var(--ink-3)",
                    }}
                  >
                    {r.order === "broker" ? "broker" : r.order === "synthetic" ? "synthetic" : r.sev === "breached" ? "manual" : "none"}
                  </td>
                  <td className={HIDE.days} style={{ color: "var(--ink-2)" }}>
                    {r.days ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td style={{ fontFamily: "var(--font-plex-cond), sans-serif" }} title="Totals: Σ sums across positions; P&L % is the aggregate (Σ P&L ÷ Σ cost)">
                  <span className="label" style={{ fontSize: 9, color: "var(--ink-2)" }}>
                    Σ Total
                  </span>
                  {below > 0 && (
                    <span className={s.more} title="Scroll for more positions">
                      +{below} ↓
                    </span>
                  )}
                </td>
                <td className={HIDE.spark} />
                <td className={GRP.last} />
                <td style={{ color: toneVar(dayPctEq) }} title="Book day change, % of equity at the prior close">
                  {fmtChg(dayPctEq)}
                </td>
                <td className={HIDE.day} style={{ color: toneVar(tot.day) }} title="Σ today's P&L across positions">
                  {tot.day == null ? "—" : fmtSignedUSD(tot.day, 0).replace("$", "")}
                </td>
                <td className={cx("qty")} />
                <td className={HIDE.avg} />
                <td title="Σ market value">{fmtNum(tot.mv, 0)}</td>
                <td className={HIDE.w} style={{ color: "var(--ink-2)" }} title="Σ weight — invested share of equity">
                  {tot.w != null ? `${(tot.w * 100).toFixed(1)}%` : "—"}
                </td>
                <td className={GRP.pnl} style={{ color: toneVar(tot.pnl) }} title="Σ unrealized P&L">
                  {fmtSignedUSD(tot.pnl, 0).replace("$", "")}
                </td>
                <td style={{ color: toneVar(tot.pnlPct) }} title="Aggregate unrealized P&L ÷ total cost">
                  {fmtChg(tot.pnlPct, 1)}
                </td>
                <td className={GRP.guardPx} />
                <td colSpan={2} title="Positions at/below their binding guard · within 2% of it">
                  <span style={{ color: tot.breached ? "var(--alert)" : "var(--ink-3)" }}>{tot.breached}</span>
                  <span className={s.agg} style={{ margin: "0 6px 0 3px" }}>
                    breached
                  </span>
                  <span style={{ color: tot.near ? "var(--warn)" : "var(--ink-3)" }}>{tot.near}</span>
                  <span className={s.agg} style={{ margin: "0 0 0 3px" }}>
                    near
                  </span>
                </td>
                <td />
                <td className={HIDE.days} />
              </tr>
            </tfoot>
          </table>
        </div>
        {fit.legend && (
          <div className={s.legend}>
            <span>
              <span className={s.gk} style={{ marginLeft: 0, marginRight: 4 }}>
                S
              </span>
              <b>trailing stop</b>
            </span>
            <span>
              <span className={s.gk} style={{ marginLeft: 0, marginRight: 4 }}>
                C
              </span>
              <b>−7% cut</b>
            </span>
            <span>
              <span className={s.evt} style={{ marginRight: 4 }}>
                E6
              </span>
              <b>earnings</b> in 6d
            </span>
            <span>
              <span className={`pill alert ${s.chip}`}>BREACHED</span> at/below guard <span className={`pill warn ${s.chip}`}>NEAR</span> within 2%
            </span>
          </div>
        )}
        {fit.sectors && sectors.length > 0 && (
          <div className={s.sectors} title={`Sector weight of equity; bars fill toward the ${Math.round((sectors[0]?.cap ?? 0.25) * 100)}% sector cap`}>
            <span className="label" style={{ fontSize: 9 }}>
              Sector load
            </span>
            {sectors.map((x) => (
              <span key={x.sector} className={s.sector}>
                <span style={{ color: "var(--ink-3)", fontWeight: 600, letterSpacing: "0.04em", fontSize: 9.5 }}>{SECTOR_ABBR[x.sector] ?? x.sector.slice(0, 4).toUpperCase()}</span>
                <span className="num" style={{ color: x.over ? "var(--warn)" : "var(--ink-2)" }}>
                  {(x.weight * 100).toFixed(1)}
                </span>
                <span className={s.sectorBar}>
                  <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(1, x.weight / x.cap) * 100}%`, background: x.over ? "var(--warn)" : "var(--ink-3)" }} />
                </span>
              </span>
            ))}
          </div>
        )}
        {tip && <ThesisTip {...tip} />}
      </div>
    );

  return (
    <Panel
      code="PORT"
      title="Portfolio monitor"
      sub={n ? `${n} / ${risk.data?.max_positions ?? 25} positions · ${sort.k === "status" ? "needs attention first" : `by ${COLS.find((c) => c.k === sort.k)?.label.toLowerCase() ?? sort.k}`}` : undefined}
      className={className}
      style={style}
      flush
      testId="panel-port"
      actions={<DataAge at={positions.data?.[0]?.updated_at ?? summary.data?.as_of} snapshot={summary.data?.source === "db_fallback"} bookAt={summary.data?.as_of} />}
    >
      {body}
    </Panel>
  );
}

// ── cells ────────────────────────────────────────────────────────────────

function Stat({ label, title, className, children }: { label: string; title?: string; className?: string; children: ReactNode }) {
  return (
    <div className={`${s.stat}${className ? ` ${className}` : ""}`} title={title}>
      <div className={s.statLabel}>{label}</div>
      <div className={s.statValue}>{children}</div>
    </div>
  );
}

/** 30-session sparkline, line and fill colored by its own 30-day direction. */
function Spark30({ data, w = 30, h = 16 }: { data: (number | null)[]; w?: number; h?: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const pts = data.map((v) => (finite(v) ? v : null));
  const vals = pts.filter(finite);
  if (vals.length < 2) return <svg width={w} height={h} aria-hidden="true" />;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || hi * 0.01 || 1;
  const x = (i: number) => 1 + (i / (pts.length - 1)) * (w - 4);
  const y = (v: number) => h - 2 - ((v - lo) / span) * (h - 4);
  let d = "";
  let first = -1;
  let last = -1;
  pts.forEach((v, i) => {
    if (v == null) return;
    d += `${first < 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    if (first < 0) first = i;
    last = i;
  });
  const up = (pts[last] as number) >= (pts[first] as number);
  const c = up ? "var(--up)" : "var(--down)";
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" style={{ display: "block", margin: "0 auto", overflow: "visible" }}>
      <defs>
        <linearGradient id={`g${uid}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={c} stopOpacity={0.24} />
          <stop offset="100%" stopColor={c} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${d}L${x(last).toFixed(1)},${h}L${x(first).toFixed(1)},${h}Z`} fill={`url(#g${uid})`} />
      <path d={d} fill="none" stroke={c} strokeWidth={1.15} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last)} cy={y(pts[last] as number)} r={1.7} fill={c} />
    </svg>
  );
}

/** 30-session change from the spark's first to last close. */
function spark30(data: (number | null)[]): number | null {
  const v = data.filter(finite);
  return v.length > 1 && v[0] ? v[v.length - 1] / v[0] - 1 : null;
}

// ── thesis tooltip ───────────────────────────────────────────────────────

function ThesisTip({ row: r, rect, panel }: { row: Row; rect: DOMRect; panel: DOMRect }) {
  const W = 372;
  const estH = 270;
  const vh = typeof window !== "undefined" ? window.innerHeight : 900;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1440;
  // Prefer the gutter left of the panel (PORT sits on the right of the grid).
  const leftSide = panel.left - W - 8 >= 4;
  const left = leftSide ? panel.left - W - 8 : Math.min(vw - W - 6, Math.max(6, rect.left + 40));
  const top = leftSide ? Math.max(6, Math.min(vh - estH - 30, rect.top - 6)) : rect.bottom + 4 + estH > vh ? rect.top - estH - 4 : rect.bottom + 4;
  const raw = (r.thesis ?? "").replace(/\s+/g, " ").trim();
  const text = raw.length > 280 ? `${raw.slice(0, 280).replace(/\s+\S*$/, "")}…` : raw;
  const cell = (label: string, value: ReactNode, color?: string) => (
    <div>
      <div className="label" style={{ fontSize: 8.5 }}>
        {label}
      </div>
      <div className="num" style={{ fontSize: 11.5, color: color ?? "var(--ink)", marginTop: 1 }}>
        {value}
      </div>
    </div>
  );
  const sevC = (d: number | null) => (d == null ? undefined : d <= 0 ? "var(--down)" : d < NEAR ? "var(--warn)" : undefined);
  return createPortal(
    <div className={s.tip} style={{ left, top }} role="tooltip">
      <div className={s.tipHead}>
        <span className="num" style={{ fontWeight: 600, fontSize: 13, color: "var(--ink)" }}>
          {r.t}
        </span>
        <span style={{ color: "var(--ink-2)", fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
        {r.sev === "breached" && <span className={`pill alert ${s.chip}`}>BREACHED</span>}
        <span className="label" style={{ marginLeft: "auto", fontSize: 9 }}>
          {r.sector}
        </span>
      </div>
      <div className={s.tipBody}>
        <div className="label" style={{ fontSize: 9, color: "var(--cyan)", marginBottom: 3 }}>
          Entry thesis{r.thesisAt ? ` · ${isoDay(r.thesisAt)}` : ""}
        </div>
        {text ? <span>{text}</span> : <span className={s.dim}>No thesis on file — seeded or manual position.</span>}
      </div>
      <div className={s.tipGrid}>
        {cell("Qty · avg cost", `${fmtNum(r.qty, 2)} @ ${fmtPx(r.avg)}`)}
        {cell("Value · weight", `$${fmtNum(r.mv, 0)} · ${r.w != null ? (r.w * 100).toFixed(1) : "—"}%`)}
        {cell("Unrealized", `${fmtSignedUSD(r.pnl, 0)} ${fmtChg(r.pnlPct, 1)}`, toneVar(r.pnl))}
        {cell(`S · trail stop ${Math.round(r.trail * 100)}%${r.guardKind === "S" ? " ◆" : ""}`, `${fmtPx(r.stopPx)} ${fmtChg(r.stopDist, 1)}`, sevC(r.stopDist))}
        {cell(`C · −7% cut${r.guardKind === "C" ? " ◆" : ""}`, `${fmtPx(r.cutPx)} ${fmtChg(r.cutDist, 1)}`, sevC(r.cutDist))}
        {cell(
          "Opened · earnings",
          <>
            {isoDay(r.opened)}
            {finite(r.earnIn) && r.earnIn >= -0.5 ? <span style={{ color: "var(--ink-2)" }}> · E{Math.max(0, Math.round(r.earnIn))}</span> : null}
          </>,
        )}
      </div>
      <div className="label" style={{ fontSize: 8.5, padding: "4px 9px 5px", borderTop: "1px solid var(--line)", color: "var(--ink-3)" }}>
        ◆ binding guard{r.broker ? "" : " · no broker-side stop — enforced by the midday routine"}
      </div>
    </div>,
    document.body,
  );
}
