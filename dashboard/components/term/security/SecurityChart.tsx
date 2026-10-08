"use client";

/**
 * GP — the security price graph. Hand-rolled SVG, sized to its container:
 * price pane (line+area or OHLC candles, SMA 50/200, SPY rebased, avg-cost /
 * trailing-stop / midday-cut reference lines, trade markers, hi/lo callouts)
 * over a VOLUME pane (up/down bars, 20-day average, relative-volume readout)
 * and a relative-strength-vs-SPY pane — one x scale, one crosshair. The floating
 * legend box appears only while scrubbing (mouse or ←/→ keys).
 */
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import type { SecurityResp } from "@/lib/api";
import { fmtBig, fmtChg, fmtNum, fmtPx, tone } from "@/lib/format";
import { Empty, Panel, Seg } from "../ui";
import { addMonths, clamp, dayNum, etDate, fmtD, niceTicks, stepDigits, weekday, ymd, MONTHS } from "./util";
import s from "./security.module.css";

const RANGES = ["1M", "3M", "6M", "YTD", "1Y", "2Y"] as const;
type Range = (typeof RANGES)[number];
const RANGE_MONTHS: Record<Exclude<Range, "YTD">, number> = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "2Y": 24 };

type Trade = SecurityResp["trades"][number];
type Bar = SecurityResp["series"][number];
type Mode = "line" | "candle";
const MODES = [
  { value: "line" as Mode, label: "LINE" },
  { value: "candle" as Mode, label: "CANDLE" },
];
const CANDLE_DEFAULT: Range[] = ["1M", "3M", "6M"];
/** Position levels; `from` = the day the position opened (YYYY-MM-DD, ET) — lines start there. */
export type ChartLevels = {
  avg: number;
  stop: number;
  cut: number;
  peak: number;
  from: string | null;
  /** Is anything acting on the stop / the cut? (enforcement.ts — same source as the POS panel.) false → dashed, dimmed, "off". */
  stopArmed: boolean;
  cutArmed: boolean;
} | null;
/** The API's own window stats, so every "1Y"/"Max DD" on the page is one number. */
export type ChartApiStats = { ret: Partial<Record<Range, number | null>>; mdd1y: number | null; rel3m: number | null };
type Key = "sma50" | "sma200" | "spy" | "avg" | "stop" | "cut";

const C = {
  px: "#e8edf2",
  sma50: "#b4a3f2",
  sma200: "#8d9aab",
  spy: "#a7b1bd", // --ink-2, dashed — distinct from the solid grey SMA200
  avg: "var(--blue)",
  // Levels are not moves: a breached level takes --alert (see `breached`); red/green mean sign only.
  stop: "var(--warn)",
  cut: "#c3cbd5",
} as const;

const DASH: Record<Key, string | undefined> = {
  sma50: undefined,
  sma200: undefined,
  spy: "4 3",
  avg: "4 3",
  stop: "4 3",
  cut: "1.5 2.5",
};

const LABEL: Record<Key, string> = {
  sma50: "SMA 50",
  sma200: "SMA 200",
  spy: "SPY rebased",
  avg: "Avg cost",
  stop: "Trail stop",
  cut: "−7% cut",
};

const SHORT: Record<Key, string> = {
  sma50: "SMA50",
  sma200: "SMA200",
  spy: "SPY",
  avg: "AVG",
  stop: "STOP",
  cut: "CUT",
};

// Geometry constants (px).
const AXW = 62; // right gutter: price tags only (last, levels, crosshair) — never tick labels
const LBW = 66; // outermost gutter: the name of each tag (LAST, AVG COST, TRAIL STOP…) — never in the plot
const LAX = 40; // left gutter: every pane's tick labels — so tags can never cover a tick
const ANN = 15; // reserved annotation band above/below the price data (HI/LO, SMA starts)
const PT = 3; // top pad
const XAX = 20; // bottom axis band
const GAP = 9; // between panes

/** Mean of the previous `n` non-null values (excludes the current bar) — matches the API's rel_volume. */
function priorMean(v: (number | null)[], n: number): (number | null)[] {
  return v.map((_, i) => {
    let sum = 0;
    let k = 0;
    for (let j = Math.max(0, i - n); j < i; j++) {
      const x = v[j];
      if (x != null && x > 0) {
        sum += x;
        k++;
      }
    }
    return k >= Math.min(n, 5) ? sum / k : null;
  });
}

function rolling(v: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(v.length).fill(null);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= n) sum -= v[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function useSize(ref: RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      setSize((p) => (p.w === Math.floor(r.width) && p.h === Math.floor(r.height) ? p : { w: Math.floor(r.width), h: Math.floor(r.height) }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

const px = (v: number) => v.toFixed(1);
/** Fractional return difference as signed points: −0.106 → "−10.6pt". */
const fmtPts = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(d)}pt`;
const crisp = (v: number) => Math.round(v) + 0.5;

export function SecurityChart({
  ticker,
  series,
  spy,
  trades,
  levels,
  api,
  className = "",
  style,
}: {
  ticker: string;
  series: Bar[];
  spy: { d: string; c: number }[];
  trades: Trade[];
  levels: ChartLevels;
  api?: ChartApiStats;
  className?: string;
  style?: CSSProperties;
}) {
  const [range, setRange] = useState<Range>("1Y");
  const [modePick, setModePick] = useState<Mode | null>(null);
  const [hidden, setHidden] = useState<Set<Key>>(() => new Set<Key>());
  const [hoverRaw, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const { w, h } = useSize(wrapRef);
  const n = series.length;

  // ── full-series derivations ────────────────────────────────────────────
  const full = useMemo(() => {
    const c = series.map((p) => p.c);
    const chg = c.map((v, i) => (i ? v / c[i - 1] - 1 : null));
    const spyMap = new Map(spy.map((p) => [p.d, p.c]));
    let carry: number | null = null;
    const spyA = series.map((p) => {
      const v = spyMap.get(p.d);
      if (v != null) carry = v;
      return carry;
    });
    const marks = new Map<number, Trade[]>();
    if (n) {
      const first = series[0].d;
      const last = series[n - 1].d;
      for (const t of trades) {
        const dd = etDate(t.filled_at ?? t.submitted_at);
        if (dd < first) continue;
        let i = series.findIndex((p) => p.d >= dd);
        if (i < 0) {
          if (dayNum(dd) - dayNum(last) > 5) continue;
          i = n - 1;
        }
        marks.set(i, [...(marks.get(i) ?? []), t]);
      }
    }
    const o = series.map((p) => (p.o != null && Number.isFinite(p.o) ? p.o : null));
    const hh = series.map((p) => (p.h != null && Number.isFinite(p.h) ? p.h : null));
    const ll = series.map((p) => (p.l != null && Number.isFinite(p.l) ? p.l : null));
    const v = series.map((p) => (p.v != null && p.v > 0 ? p.v : null));
    const ohlc = n > 0 && o[n - 1] != null && hh[n - 1] != null && ll[n - 1] != null;
    const hasVol = v.some((x) => x != null);
    // Candle colour: close vs open; line/fallback: close vs previous close.
    const upDay = c.map((x, i) => (o[i] != null ? x >= (o[i] as number) : i ? x >= c[i - 1] : true));
    const vAvg = priorMean(v, 20);
    // Relative volume: each session vs its own prior-20 average (feed-agnostic).
    const rel = v.map((x, i) => (x != null && vAvg[i] ? x / (vAvg[i] as number) : null));
    return { c, o, hh, ll, v, ohlc, hasVol, upDay, vAvg, rel, chg, spyA, marks, sma50: rolling(c, 50), sma200: rolling(c, 200) };
  }, [series, spy, trades, n]);
  const mode: Mode = full.ohlc ? (modePick ?? (CANDLE_DEFAULT.includes(range) ? "candle" : "line")) : "line";
  const candle = mode === "candle";

  // ── window (range) ─────────────────────────────────────────────────────
  const win = useMemo(() => {
    if (!n) return null;
    const last = series[n - 1].d;
    const from = range === "YTD" ? `${ymd(last)[0] - 1}-12-31` : addMonths(last, -RANGE_MONTHS[range]);
    let start = 0;
    for (let i = n - 1; i >= 0; i--) {
      if (series[i].d <= from) {
        start = i;
        break;
      }
    }
    const { c, chg, spyA, hh, ll } = full;
    let hi = start;
    let lo = start;
    let hiH = start;
    let loL = start;
    let sum = 0;
    let peak = c[start];
    let mdd = 0;
    const rets: number[] = [];
    for (let i = start; i < n; i++) {
      if (c[i] > c[hi]) hi = i;
      if (c[i] < c[lo]) lo = i;
      if ((hh[i] ?? c[i]) > (hh[hiH] ?? c[hiH])) hiH = i;
      if ((ll[i] ?? c[i]) < (ll[loL] ?? c[loL])) loL = i;
      sum += c[i];
      peak = Math.max(peak, c[i]);
      mdd = Math.min(mdd, c[i] / peak - 1);
      if (i > start && chg[i] != null) rets.push(chg[i] as number);
    }
    const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
    const spyBase = spyA[start];
    const spyRet = spyBase && spyA[n - 1] ? (spyA[n - 1] as number) / spyBase - 1 : null;
    return {
      start,
      m: n - start,
      hi,
      lo,
      hiH,
      loL,
      avg: sum / (n - start),
      ret: c[n - 1] / c[start] - 1,
      spyRet,
      vol: rets.length > 5 ? sd * Math.sqrt(252) : null,
      mdd,
      spyBase,
      truncated: start === 0 && series[0].d > from,
    };
  }, [n, series, range, full]);

  // A cursor outside the current window (after a range/data change) is no cursor.
  const hover = hoverRaw != null && win && hoverRaw >= win.start && hoverRaw < n ? hoverRaw : null;

  const show = (k: Key) => !hidden.has(k) && (k !== "avg" && k !== "stop" && k !== "cut" ? true : levels != null);
  const toggle = (k: Key) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const spyReb = (i: number): number | null => {
    if (!win || !win.spyBase) return null;
    const v = full.spyA[i];
    return v == null ? null : (v / win.spyBase) * full.c[win.start];
  };

  // ── geometry + static layer ────────────────────────────────────────────
  const g = useMemo(() => {
    if (!win || w < 120 || h < 120) return null;
    const { start, m } = win;
    const { c, chg, sma50, sma200, hh, ll, rel, hasVol, o, upDay } = full;
    const volH = hasVol ? clamp(Math.round(h * 0.17), 58, 100) : 0; // ≥ 44px of bars under the caption
    const histH = clamp(Math.round(h * 0.13), 58, 92);
    const annTop = PT; // top annotation band [annTop, pTop)
    const pTop = PT + ANN;
    const pFrame = h - XAX - histH - GAP - (hasVol ? volH + GAP : 0); // price pane's bottom edge
    const pBot = pFrame - ANN; // data area ends here; [pBot, pFrame) is the bottom annotation band
    const vTop = pFrame + GAP;
    const vBot = vTop + volH;
    const hTop = (hasVol ? vBot : pFrame) + GAP;
    const hBot = h - XAX;
    const L = LAX;
    const R = w - AXW - LBW;
    const step = (R - L) / m;
    const x = (i: number) => L + (i - start + 0.5) * step;

    // y-domain: price + visible overlays + nearby reference levels
    let lo = Infinity;
    let hi = -Infinity;
    const take = (v: number | null | undefined) => {
      if (v == null || !Number.isFinite(v)) return;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    };
    for (let i = start; i < n; i++) {
      take(c[i]);
      if (candle) {
        take(hh[i]);
        take(ll[i]);
      }
      if (show("sma50")) take(sma50[i]);
      if (show("sma200")) take(sma200[i]);
      if (show("spy")) take(spyReb(i));
    }
    const span0 = hi - lo || Math.abs(hi) * 0.02 || 1;
    const lvl: { k: Key; v: number }[] = [];
    if (levels) {
      (["avg", "stop", "cut"] as const).forEach((k) => {
        if (show(k)) lvl.push({ k, v: levels[k] });
      });
    }
    for (const l of lvl) if (l.v >= lo - 0.4 * span0 && l.v <= hi + 0.4 * span0) take(l.v);
    const pad = (hi - lo || span0) * 0.08;
    const yMin = lo - pad;
    const yMax = hi + pad;
    const y = (v: number) => pBot - ((v - yMin) / (yMax - yMin)) * (pBot - pTop);
    const yt = niceTicks(yMin, yMax, Math.max(3, Math.floor((pBot - pTop) / 44)));
    const yDigits = Math.max(stepDigits(yt.step), 0);

    // Relative performance vs SPY since the window's first session, in points:
    // (ticker/ticker₀ − 1) − (SPY/SPY₀ − 1) — the same definition as the header's
    // "REL", so the pane's last value equals it. Symmetric autoscale, 1pt floor.
    const rs: (number | null)[] = new Array(n).fill(null);
    const sb = full.spyA[start];
    let rLo = 0;
    let rHi = 0;
    for (let i = start; i < n; i++) {
      const sv = full.spyA[i];
      if (!sb || !sv) continue;
      rs[i] = c[i] / c[start] - 1 - (sv / sb - 1);
      rLo = Math.min(rLo, rs[i] as number);
      rHi = Math.max(rHi, rs[i] as number);
    }
    const hasRs = rs.some((v) => v != null);
    // Fit the data range, always including 0 (asymmetric is fine): 12% headroom, 1pt floor.
    const rSpan = Math.max(rHi - rLo, 0.01);
    const hMax = rHi + rSpan * 0.12;
    const hMin = rLo - rSpan * 0.12;
    const hT = hTop + 13; // below the caption
    const yh = (v: number) => hBot - 2 - ((v - hMin) / (hMax - hMin)) * (hBot - 2 - hT);
    const hZero = yh(0);
    // Labelled extremes: the data's own min/max, rounded outward to whole points, if they clear 0 by 12px.
    const hTicks = [Math.ceil(rHi * 100) / 100, Math.floor(rLo * 100) / 100].filter((t) => t !== 0 && Math.abs(yh(t) - hZero) >= 12 && yh(t) >= hT - 2 && yh(t) <= hBot);
    const hLim = Math.max(Math.abs(rHi), Math.abs(rLo));
    const hStep = hLim;
    let rsLine = "";
    {
      let pen = false;
      for (let i = start; i < n; i++) {
        const v = rs[i];
        if (v == null) {
          pen = false;
          continue;
        }
        rsLine += `${pen ? "L" : "M"}${px(x(i))},${px(yh(v))}`;
        pen = true;
      }
    }
    const firstRs = rs.findIndex((v) => v != null);
    const lastRs = n - 1;
    const rsArea = rsLine && firstRs >= 0 ? `${rsLine}L${px(x(lastRs))},${px(hZero)}L${px(x(firstRs))},${px(hZero)}Z` : "";
    void chg;

    // paths
    const seg = (get: (i: number) => number | null) => {
      let d = "";
      let pen = false;
      for (let i = start; i < n; i++) {
        const v = get(i);
        if (v == null) {
          pen = false;
          continue;
        }
        d += `${pen ? "L" : "M"}${px(x(i))},${px(y(v))}`;
        pen = true;
      }
      return d;
    };
    const line = seg((i) => c[i]);
    const area = `${line}L${px(x(n - 1))},${pBot}L${px(x(start))},${pBot}Z`;

    // candles: one wick path + one body path per direction (cheap to render)
    const bw = Math.max(1, Math.min(step * 0.66, 11));
    let wickUp = "";
    let wickDn = "";
    let bodyUp = "";
    let bodyDn = "";
    if (candle) {
      for (let i = start; i < n; i++) {
        const oo = o[i] ?? c[i];
        const hi_ = hh[i] ?? Math.max(oo, c[i]);
        const lo_ = ll[i] ?? Math.min(oo, c[i]);
        const xc = Math.round(x(i)) + 0.5;
        const wick = `M${xc},${px(y(hi_))}V${px(y(lo_))}`;
        const top = y(Math.max(oo, c[i]));
        const bh = Math.max(1, y(Math.min(oo, c[i])) - top);
        const body = `M${px(x(i) - bw / 2)},${px(top)}h${px(bw)}v${px(bh)}h${px(-bw)}Z`;
        if (upDay[i]) {
          wickUp += wick;
          bodyUp += body;
        } else {
          wickDn += wick;
          bodyDn += body;
        }
      }
    }

    // volume scale (shares): top ≈ 97th percentile ×1.15 so one spike can't flatten the rest;
    // bars above it are clipped with a cap mark.
    const vs = full.v.slice(start).filter((x): x is number => x != null).sort((a, b) => a - b);
    let vAvgMax = 0;
    for (let i = start; i < n; i++) vAvgMax = Math.max(vAvgMax, full.vAvg[i] ?? 0);
    const vP95 = vs.length ? vs[Math.min(vs.length - 1, Math.floor(vs.length * 0.95))] : 1;
    const vCap = Math.max(vP95 * 1.05, vAvgMax * 1.25, 1);
    const yv = (val: number) => vBot - (Math.min(val, vCap) / vCap) * (volH - 14);
    let vAvgPath = "";
    {
      let pen = false;
      for (let i = start; i < n; i++) {
        const a = full.vAvg[i];
        if (a == null) {
          pen = false;
          continue;
        }
        vAvgPath += `${pen ? "L" : "M"}${px(x(i))},${px(yv(a))}`;
        pen = true;
      }
    }
    void rel;

    // position levels start where the position does
    let lvlStart = start;
    if (levels?.from) {
      const k = series.findIndex((p) => p.d >= (levels.from as string));
      lvlStart = k < 0 ? n - 1 : Math.max(start, k);
    }
    const lvlX0 = x(lvlStart) - step / 2;

    // x ticks: weekly for ≤ ~6 weeks, monthly otherwise; years are majors
    const spanDays = dayNum(series[n - 1].d) - dayNum(series[start].d);
    const raw: { i: number; label: string; major: boolean }[] = [];
    for (let i = start + 1; i < n; i++) {
      const [yy, mm] = ymd(series[i].d);
      const [, pm] = ymd(series[i - 1].d);
      if (spanDays <= 50) {
        if (weekday(series[i].d) < weekday(series[i - 1].d)) raw.push({ i, label: fmtD(series[i].d, "md"), major: mm !== pm });
      } else if (mm !== pm) {
        raw.push({ i, label: mm === 1 ? String(yy) : MONTHS[mm - 1], major: mm === 1 });
      }
    }
    const minGap = spanDays <= 50 ? 52 : 34;
    const kept: typeof raw = raw.filter((t) => t.major && spanDays > 50);
    for (const t of raw) {
      if (kept.includes(t)) continue;
      if (kept.every((k) => Math.abs(x(k.i) - x(t.i)) >= minGap)) kept.push(t);
    }
    kept.sort((a, b) => a.i - b.i);

    // A moving average that starts inside the window is "partial" — flagged where it begins.
    const smaStart = (arr: (number | null)[]) => {
      if (arr[start] != null) return null;
      const k = arr.findIndex((v, i) => i >= start && v != null);
      return k < 0 ? null : k;
    };
    return { annTop, pTop, pBot, pFrame, vTop, vBot, hTop, hBot, L, R, step, x, y, yh, yv, vCap, vAvgPath, lvlX0, bw, wickUp, wickDn, bodyUp, bodyDn, hZero, hLim, hStep, hTicks, rs, hasRs, rsLine, rsArea, yt, yDigits, line, area, lvl, yMin, yMax, xt: kept,
      sma50Start: smaStart(sma50),
      sma200Start: smaStart(sma200),
      sma50: show("sma50") ? seg((i) => sma50[i]) : "",
      sma200: show("sma200") ? seg((i) => sma200[i]) : "",
      spy: show("spy") ? seg(spyReb) : "",
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win, w, h, full, hidden, levels, n, series, candle]);

  if (!n || !win) {
    return (
      <Panel code="GP" title={`${ticker} US Equity`} className={className} style={style}>
        <Empty>No price history for {ticker}.</Empty>
      </Panel>
    );
  }

  const { start } = win;
  const last = full.c[n - 1];
  // A stop/cut is "breached" when the last close is through it — the only time a level takes the alert colour.
  const breached = (k: Key) => !!levels && (k === "stop" || k === "cut") && last < levels[k];
  /** Stop/cut with nothing acting on them (synthetic + bot off) — drawn as inactive, not as live orders. */
  const inactive = (k: Key) => !!levels && ((k === "stop" && !levels.stopArmed) || (k === "cut" && !levels.cutArmed));
  const lvlColor = (k: Key) => (breached(k) ? "var(--alert)" : inactive(k) ? "var(--ink-3)" : C[k]);
  /** SPY's own return since the range start (what its rebased line shows). */
  const spyRet = (i: number): number | null => (win.spyBase && full.spyA[i] ? (full.spyA[i] as number) / win.spyBase - 1 : null);
  // Same windows as the API (close on/before the same calendar date) — show the API's
  // own numbers so the header grid and this panel can never disagree by rounding.
  const apiRet = win.truncated ? null : api?.ret[range];
  const ret = apiRet ?? win.ret;
  const mdd = range === "1Y" && !win.truncated && api?.mdd1y != null ? api.mdd1y : win.mdd;
  const relSpy = range === "3M" && api?.rel3m != null ? api.rel3m : win.spyRet != null ? ret - win.spyRet : null;
  const at = hover ?? n - 1;
  const dir = win.ret >= 0 ? "var(--up)" : "var(--down)";

  // ── interaction ────────────────────────────────────────────────────────
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!g) return;
    const r = e.currentTarget.getBoundingClientRect();
    const xx = e.clientX - r.left;
    if (xx > g.R + 2) return setHover(null);
    setHover(clamp(Math.floor((xx - g.L) / g.step) + start, start, n - 1));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = e.key;
    if (k === "ArrowLeft" || k === "ArrowRight") {
      e.preventDefault();
      const d = (k === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 5 : 1);
      setHover((p) => clamp((p ?? n - 1) + d, start, n - 1));
    } else if (k === "Home") setHover(start);
    else if (k === "End") setHover(n - 1);
    else if (k === "Escape") setHover(null);
  };

  // ── legend values (follow the cursor) ──────────────────────────────────
  const val: Record<Key, number | null> = {
    sma50: full.sma50[at],
    sma200: full.sma200[at],
    spy: spyReb(at),
    avg: levels?.avg ?? null,
    stop: levels?.stop ?? null,
    cut: levels?.cut ?? null,
  };
  const keys: Key[] = levels ? ["sma50", "sma200", "spy", "avg", "stop", "cut"] : ["sma50", "sma200", "spy"];
  const atChg = full.chg[at];
  const hiI = candle ? win.hiH : win.hi;
  const loI = candle ? win.loL : win.lo;
  const hiV = candle ? (full.hh[hiI] ?? full.c[hiI]) : full.c[hiI];
  const loV = candle ? (full.ll[loI] ?? full.c[loI]) : full.c[loI];
  // Where a trade marker sits: on the line, or just outside the candle's range.
  const markY = (i: number, side: "buy" | "sell") =>
    candle ? (side === "buy" ? (full.ll[i] ?? full.c[i]) : (full.hh[i] ?? full.c[i])) : full.c[i];
  const obstacles: [number, number, number][] = [];
  if (g && hover != null) {
    for (let i = start; i < n; i++) {
      const xi = g.x(i);
      obstacles.push([xi, g.y(full.c[i]), 1]);
      const a = full.sma50[i];
      const b = full.sma200[i];
      const r = show("spy") ? spyReb(i) : null;
      if (show("sma50") && a != null) obstacles.push([xi, g.y(a), 0.35]);
      if (show("sma200") && b != null) obstacles.push([xi, g.y(b), 0.35]);
      if (r != null) obstacles.push([xi, g.y(r), 0.35]);
    }
    for (const [i] of full.marks) if (i >= start) obstacles.push([g.x(i), g.y(full.c[i]), 80], [g.x(i), g.y(full.c[i]) + 12, 80]);
    obstacles.push([g.x(hiI), g.y(hiV) - 10, 40], [g.x(loI), g.y(loV) + 12, 40]);
  }
  const lastSpy = show("spy") ? spyReb(n - 1) : null;
  const lastSpyRet = spyRet(n - 1);
  const tags = g
    ? placeTags(g, [
        { key: "last", v: last, bg: "var(--ink)", fg: "#000", text: fmtPx(last), name: "LAST" },
        ...g.lvl.map((l) => ({
          key: l.k,
          v: l.v,
          bg: breached(l.k) ? "var(--alert)" : inactive(l.k) ? "var(--ink-3)" : C[l.k],
          fg: l.k === "avg" ? "#fff" : "#000",
          text: fmtPx(l.v),
          name: l.k === "avg" ? "AVG COST" : l.k === "stop" ? (inactive(l.k) ? "STOP · OFF" : "TRAIL STOP") : inactive(l.k) ? "CUT · OFF" : "−7% CUT",
          outline: inactive(l.k),
        })),
        ...(lastSpy != null && lastSpyRet != null
          ? [{ key: "spy", v: lastSpy, bg: "var(--ink-2)", fg: "var(--ink-2)", text: fmtChg(lastSpyRet, 1), name: "SPY REB.", outline: true, small: true }]
          : []),
      ])
    : [];

  // Y axis: tick labels live in their own left gutter, tags in the right one — so a
  // tag can never cover a tick. One tick per ~34px, all labelled.
  const yAxis = (() => {
    if (!g) return { ticks: [] as number[], digits: 2 };
    const t = niceTicks(g.yMin, g.yMax, Math.max(4, Math.floor((g.pBot - g.pTop) / 34)));
    return { ticks: t.ticks.filter((v) => g.y(v) >= g.pTop - 1 && g.y(v) <= g.pBot + 1), digits: stepDigits(t.step) };
  })();

  // Annotation band items (HI/LO, where SMAs begin), packed so labels never overlap.
  const annots: Annot[] = [];
  if (g) {
    const push = (a: Omit<Annot, "left">) => {
      const w = a.text.length * 6 + 4;
      const band = annots.filter((b) => b.band === a.band);
      const cands = [a.x - w / 2, a.x - w + 8, a.x - 8, a.x - w - 6, a.x + 6].map((l) => clamp(l, g.L + 2, g.R - 4 - w));
      const left = cands.find((l) => band.every((b) => l + w + 6 <= b.left || l >= b.left + b.text.length * 6 + 10));
      if (left != null) annots.push({ ...a, left });
    };
    push({ key: "hi", band: "top", x: g.x(hiI), py: g.y(hiV), text: `HI ${fmtPx(hiV)} ${fmtD(series[hiI].d, "dm")}`, color: "var(--ink-2)" });
    if (loI !== hiI) push({ key: "lo", band: "bot", x: g.x(loI), py: g.y(loV), text: `LO ${fmtPx(loV)} ${fmtD(series[loI].d, "dm")}`, color: "var(--ink-2)" });
    (["sma50", "sma200"] as const).forEach((k) => {
      const st = k === "sma50" ? g.sma50Start : g.sma200Start;
      const arr = k === "sma50" ? full.sma50 : full.sma200;
      if (st == null || !show(k) || arr[st] == null) return;
      push({ key: `s${k}`, band: "top", x: g.x(st), py: g.y(arr[st] as number), text: `${k === "sma50" ? "SMA50" : "SMA200"} starts`, color: C[k] });
    });
  }

  return (
    <Panel
      code="GP"
      title={`${ticker} US Equity`}
      sub={
        <span className={s.lgStats}>
          <Stat label={win.truncated ? "Max" : range} value={fmtChg(ret)} cls={tone(ret)} />
          {win.spyRet != null && <Stat label="SPY" value={fmtChg(win.spyRet)} cls={tone(win.spyRet)} />}
          {relSpy != null && (
            <Stat label="Rel" value={fmtPts(relSpy)} cls={tone(relSpy)} />
          )}
          <Stat label={`Vol ${win.truncated ? "max" : range}`} value={win.vol != null ? `${(win.vol * 100).toFixed(1)}%` : "—"} />
          <Stat label="Max DD" value={fmtChg(mdd, 1)} cls={mdd < 0 ? "down" : "flat"} />
        </span>
      }
      className={className}
      style={style}
      flush
      actions={
        <>
          {full.ohlc && <Seg options={MODES} value={mode} onChange={(m) => setModePick(m)} label="Chart type" />}
          <Seg
            options={RANGES}
            value={range}
            onChange={(r) => {
              setRange(r);
              setHover(null);
            }}
            label="Chart range"
          />
        </>
      }
    >
      <div className={s.chartBody}>
        <div className={s.legend}>
          <span className={s.lgItem} data-static>
            <span className={s.lgSw} style={{ background: C.px, height: 2 }} />
            <span className="tkr">{ticker}</span>
            <span className="num" style={{ color: "var(--ink)" }}>{fmtPx(full.c[at])}</span>
            <span className={`num ${tone(atChg)}`}>{fmtChg(atChg)}</span>
          </span>
          {keys.map((k) => {
            const on = !hidden.has(k);
            return (
              <button
                key={k}
                type="button"
                className={s.lgItem}
                aria-pressed={on}
                onClick={() => toggle(k)}
                title={`${on ? "Hide" : "Show"} ${LABEL[k]}${
                  k === "spy"
                    ? " — SPY's path rebased to this ticker's first close in the range; the % is SPY's own return since then"
                    : (k === "sma50" && g?.sma50Start != null) || (k === "sma200" && g?.sma200Start != null)
                      ? " — the line begins where enough history exists (marked “starts” above the chart)"
                      : inactive(k)
                        ? " — nothing is enforcing this level (synthetic stop, bot off)"
                        : ""
                }`}
              >
                <svg width="16" height="6" aria-hidden="true">
                  <line x1="0" x2="16" y1="3" y2="3" stroke={C[k]} strokeWidth={k === "spy" || k === "cut" ? 1.6 : 1.4} strokeDasharray={DASH[k]} />
                </svg>
                <span>
                  {k === "spy" ? "SPY rebased" : SHORT[k]}
                  {inactive(k) ? " (inactive)" : ""}
                </span>
                {/* Values only where the chart has no axis tag for the line, and only when it's drawn. */}
                {on && (k === "sma50" || k === "sma200") && <span className="num">{fmtPx(val[k])}</span>}
                {on && k === "spy" && spyRet(at) != null && <span className={`num ${tone(spyRet(at))}`}>{fmtChg(spyRet(at), 1)}</span>}
              </button>
            );
          })}

        </div>

        <div
          ref={wrapRef}
          className={s.chartWrap}
          tabIndex={0}
          role="img"
          aria-label={`${ticker} ${mode} chart, ${range}. Use left and right arrow keys to scrub.`}
          onKeyDown={onKey}
        >
          {g && (
            <svg
              width={w}
              height={h}
              viewBox={`0 0 ${w} ${h}`}
              className={s.chartSvg}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
            >
              <defs>
                <linearGradient id={`gp-area-${uid}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={dir} stopOpacity={0.16} />
                  <stop offset="100%" stopColor={dir} stopOpacity={0} />
                </linearGradient>
                <clipPath id={`gp-clip-${uid}`}>
                  <rect x={g.L} y={g.pTop - 4} width={g.R - g.L} height={g.pBot - g.pTop + 8} />
                </clipPath>
              </defs>

              {/* grid */}
              {yAxis.ticks.map((t) => (
                <line key={`yg${t}`} x1={g.L} x2={g.R} y1={crisp(g.y(t))} y2={crisp(g.y(t))} stroke="var(--line-2)" strokeOpacity={0.55} />
              ))}
              {g.xt.map((t) => (
                <line
                  key={`xg${t.i}`}
                  x1={crisp(g.x(t.i) - g.step / 2)}
                  x2={crisp(g.x(t.i) - g.step / 2)}
                  y1={g.pTop}
                  y2={g.hBot}
                  stroke={t.major ? "var(--line-2)" : "var(--line)"}
                />
              ))}
              {/* pane frames + axis spine */}
              <line x1={crisp(g.R)} x2={crisp(g.R)} y1={g.pTop - 6} y2={g.hBot} stroke="var(--line-2)" />
              <line x1={crisp(g.L)} x2={crisp(g.L)} y1={g.pTop - 6} y2={g.hBot} stroke="var(--line-2)" />
              <line x1={g.L} x2={g.R} y1={crisp(g.pFrame)} y2={crisp(g.pFrame)} stroke="var(--line-2)" />
              <line x1={g.L} x2={g.R} y1={crisp(g.hBot)} y2={crisp(g.hBot)} stroke="var(--line-2)" />

              {/* y-axis labels */}
              {yAxis.ticks.map((t) => (
                <text key={`yl${t}`} x={g.L - 5} y={g.y(t) + 3.5} textAnchor="end" className={s.axisText}>
                  {fmtNum(t, yAxis.digits)}
                </text>
              ))}

              {/* price layer */}
              <g clipPath={`url(#gp-clip-${uid})`}>
                {!candle && <path d={g.area} fill={`url(#gp-area-${uid})`} />}
                {g.spy && <path d={g.spy} fill="none" stroke={C.spy} strokeWidth={1} strokeDasharray={DASH.spy} opacity={0.75} />}
                {g.sma200 && <path d={g.sma200} fill="none" stroke={C.sma200} strokeWidth={1.1} strokeDasharray={DASH.sma200} />}
                {g.sma50 && <path d={g.sma50} fill="none" stroke={C.sma50} strokeWidth={1.1} />}
                {/* where a moving average begins inside the window — label lives in the annotation band */}
                {annots
                  .filter((a) => a.key.startsWith("s"))
                  .map((a) => (
                    <circle key={`pm${a.key}`} cx={a.x} cy={a.py} r={2.2} fill="var(--bg-1)" stroke={a.color} pointerEvents="none" />
                  ))}
                {/* last-price guide */}
                <line x1={g.L} x2={g.R} y1={crisp(g.y(last))} y2={crisp(g.y(last))} stroke="var(--ink-4)" strokeDasharray="1 3" />
                {/* reference levels (in range) */}
                {g.lvl.map((l) => {
                  if (l.v < g.yMin || l.v > g.yMax) return null;
                  const yy = crisp(g.y(l.v));
                  return (
                    <g key={l.k}>
                      <line
                        x1={g.lvlX0}
                        x2={g.R}
                        y1={yy}
                        y2={yy}
                        stroke={lvlColor(l.k)}
                        strokeWidth={1}
                        strokeDasharray={inactive(l.k) ? "2 5" : DASH[l.k]}
                        opacity={inactive(l.k) ? 0.5 : 0.9}
                      />
                      <line x1={crisp(g.lvlX0)} x2={crisp(g.lvlX0)} y1={yy - 3} y2={yy + 3} stroke={lvlColor(l.k)} opacity={inactive(l.k) ? 0.5 : 1} />
                    </g>
                  );
                })}
                {candle ? (
                  <>
                    <path d={g.wickUp} stroke="var(--up)" strokeWidth={1} fill="none" />
                    <path d={g.wickDn} stroke="var(--down)" strokeWidth={1} fill="none" />
                    <path d={g.bodyUp} fill="var(--up)" />
                    <path d={g.bodyDn} fill="var(--down)" />
                  </>
                ) : (
                  <path d={g.line} fill="none" stroke={C.px} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
                )}
              </g>

              {/* annotation bands: HI above the data, LO below, SMA starts above — never on the data */}
              <Annotations g={g} items={annots} />

              {/* trade markers */}
              {[...full.marks.entries()].map(([i, ts]) => {
                if (i < start) return null;
                const cx = g.x(i);
                const buys = ts.filter((t) => t.side === "buy");
                const sells = ts.filter((t) => t.side === "sell");
                const active = hover === i;
                return (
                  <g key={`tm${i}`}>
                    <line x1={crisp(cx)} x2={crisp(cx)} y1={g.vTop} y2={g.hBot} stroke={buys.length ? "var(--up)" : "var(--down)"} strokeDasharray="1 2" opacity={0.45} />
                    {buys.length > 0 && <Tri x={cx} y={g.y(markY(i, "buy")) + 4} up color="var(--up)" active={active} hollow={buys.every((t) => t.dry_run)} n={buys.length} />}
                    {sells.length > 0 && <Tri x={cx} y={g.y(markY(i, "sell")) - 4} up={false} color="var(--down)" active={active} hollow={sells.every((t) => t.dry_run)} n={sells.length} />}
                  </g>
                );
              })}

              {/* volume pane: shares, up/down coloured, prior-20-day average line */}
              {full.hasVol && (
                <g>
                  <line x1={g.L} x2={g.R} y1={crisp(g.vBot)} y2={crisp(g.vBot)} stroke="var(--line-2)" />
                  {[g.vCap, g.vCap / 2].map((t) => (
                    <g key={`vt${t}`}>
                      <line x1={g.L} x2={g.R} y1={crisp(g.yv(t))} y2={crisp(g.yv(t))} stroke="var(--line)" strokeDasharray="2 3" />
                      <text x={g.L - 5} y={g.yv(t) + 3.5} textAnchor="end" className={s.axisText}>
                        {fmtBig(t)}
                      </text>
                    </g>
                  ))}
                  {Array.from({ length: n - start }, (_, k) => {
                    const i = start + k;
                    const vv = full.v[i];
                    if (vv == null) return null;
                    const bw = Math.max(1, Math.min(g.step * 0.72, 9));
                    const top = g.yv(vv);
                    const clipped = vv > g.vCap;
                    return (
                      <g key={`vb${i}`} opacity={hover == null ? 0.6 : hover === i ? 1 : 0.32}>
                        <rect x={g.x(i) - bw / 2} y={top} width={bw} height={Math.max(0.75, g.vBot - top)} fill={full.upDay[i] ? "var(--up)" : "var(--down)"} />
                        {clipped && <rect x={g.x(i) - bw / 2 - 1} y={top - 2} width={bw + 2} height={1.5} fill="var(--ink-2)" />}
                      </g>
                    );
                  })}
                  {g.vAvgPath && <path d={g.vAvgPath} fill="none" stroke="var(--ink)" strokeWidth={1.4} opacity={0.85} />}
                  <VolLabel g={g} v={full.v[at]} avg={full.vAvg[at]} hover={hover != null} />
                </g>
              )}

              {/* relative strength vs SPY */}
              <defs>
                <clipPath id={`rs-up-${uid}`}>
                  <rect x={g.L} y={g.hTop} width={g.R - g.L} height={Math.max(0, g.hZero - g.hTop)} />
                </clipPath>
                <clipPath id={`rs-dn-${uid}`}>
                  <rect x={g.L} y={g.hZero} width={g.R - g.L} height={Math.max(0, g.hBot - g.hZero)} />
                </clipPath>
              </defs>
              <text x={g.L + 4} y={g.hTop + 9} className={s.paneLabel}>
                REL vs SPY
                {g.hasRs && (
                  <tspan className={s.paneVal} dx={6} style={{ fill: `var(--${tone(g.rs[at]) === "flat" ? "ink-2" : tone(g.rs[at])})` }}>
                    {fmtPts(g.rs[at])}
                  </tspan>
                )}
                <tspan className={s.paneVal} dx={4}>
                  {g.hasRs ? `return minus SPY's since ${fmtD(series[start].d, "dmy")} · 0 = in line` : "no SPY history"}
                </tspan>
              </text>
              <line x1={g.L} x2={g.R} y1={crisp(g.hZero)} y2={crisp(g.hZero)} stroke="var(--ink-3)" strokeDasharray="3 3" />
              {g.hTicks.map((t) => (
                <g key={`hy${t}`}>
                  <line x1={g.L} x2={g.R} y1={crisp(g.yh(t))} y2={crisp(g.yh(t))} stroke="var(--line)" />
                  <text x={g.L - 5} y={g.yh(t) + 3.5} textAnchor="end" className={s.axisText}>
                    {fmtPts(t, 0)}
                  </text>
                </g>
              ))}
              <text x={g.L - 5} y={g.hZero + 3.5} textAnchor="end" className={s.axisText}>0</text>
              {g.rsArea && (
                <>
                  <path d={g.rsArea} fill="var(--up)" opacity={0.14} clipPath={`url(#rs-up-${uid})`} />
                  <path d={g.rsArea} fill="var(--down)" opacity={0.14} clipPath={`url(#rs-dn-${uid})`} />
                  <path d={g.rsLine} fill="none" stroke="var(--ink-2)" strokeWidth={1.2} strokeLinejoin="round" />
                </>
              )}

              {/* x-axis labels */}
              {g.xt.map((t) => (
                <text
                  key={`xl${t.i}`}
                  x={g.x(t.i) - g.step / 2 + 4}
                  y={g.hBot + 13}
                  className={s.axisText}
                  style={t.major ? { fill: "var(--ink-2)", fontWeight: 600 } : undefined}
                >
                  {t.label}
                </text>
              ))}

              {/* right-axis tags: last price + reference levels (collision-relaxed) */}
              <AxisTags g={g} placed={tags} />

              {/* crosshair */}
              {hover != null && (
                <Crosshair g={g} i={hover} v={full.c[hover]} chg={g.rs[hover]} vol={full.hasVol ? full.v[hover] : null} d={series[hover].d} />
              )}
            </svg>
          )}
          {g && hover != null && (
            <LegendBox
              g={g}
              hover={hover}
              rows={buildBoxRows({ hover, win, full, series, ticker, val, show, levels, candle, rsAt: g.rs[hover], spyRetAt: spyRet(hover) })}
              title={fmtD(series[hover].d, "long").toUpperCase()}
              obstacles={obstacles}
            />
          )}
        </div>
      </div>
    </Panel>
  );
}

// ── pieces ──────────────────────────────────────────────────────────────

type G = {
  annTop: number;
  pTop: number;
  pBot: number;
  pFrame: number;
  vTop: number;
  vBot: number;
  yv: (v: number) => number;
  hTop: number;
  hBot: number;
  L: number;
  R: number;
  step: number;
  x: (i: number) => number;
  y: (v: number) => number;
  yh: (v: number) => number;
  hZero: number;
  yMin: number;
  yMax: number;
};

function Stat({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return (
    <span className={s.stat}>
      <span className={s.statK}>{label}</span>
      <span className={`num ${cls}`}>{value}</span>
    </span>
  );
}

function Tri({ x, y, up, color, active, hollow, n }: { x: number; y: number; up: boolean; color: string; active: boolean; hollow: boolean; n: number }) {
  const sz = active ? 7.5 : 6;
  const tip = y;
  const base = up ? y + sz * 1.45 : y - sz * 1.45;
  const pts = `${px(x)},${px(tip)} ${px(x - sz)},${px(base)} ${px(x + sz)},${px(base)}`;
  return (
    <g>
      <polygon points={pts} fill={hollow ? "var(--bg-1)" : color} stroke={hollow ? color : "#000"} strokeWidth={hollow ? 1.2 : 0.8} strokeLinejoin="round" />
      {n > 1 && (
        <text x={x + sz + 2} y={up ? base + 1 : base + 6} className={s.markN} fill={color}>
          ×{n}
        </text>
      )}
    </g>
  );
}



type Tag = { key: string; v: number; bg: string; fg: string; text: string; name?: string; outline?: boolean; small?: boolean };
/** `anchor` = the level's true y (where the pointer aims); `y` = the tag body's centre. */
type Placed = Tag & { y: number; anchor: number; off: "up" | "down" | null };
const TAG_H = 15;

/** Push tag bodies apart (sorted top→bottom), keeping them inside the price pane. */
function relaxTags(g: G, placed: Placed[]) {
  const H = TAG_H;
  placed.sort((a, b) => a.y - b.y);
  for (const t of placed) t.y = clamp(t.y, g.pTop + H / 2, g.pBot - H / 2);
  for (let k = 1; k < placed.length; k++) if (placed[k].y - placed[k - 1].y < H + 1) placed[k].y = placed[k - 1].y + H + 1;
  const over = placed.length ? placed[placed.length - 1].y - (g.pBot - H / 2) : 0;
  if (over > 0) {
    placed[placed.length - 1].y -= over;
    for (let k = placed.length - 2; k >= 0; k--) if (placed[k + 1].y - placed[k].y < H + 1) placed[k].y = placed[k + 1].y - H - 1;
  }
  return placed;
}

/** Pin off-scale levels to the pane edge (with an arrow) and relax overlaps. */
function placeTags(g: G, tags: Tag[]): Placed[] {
  return relaxTags(
    g,
    tags.map((t) => {
      const raw = g.y(t.v);
      const off: Placed["off"] = raw < g.pTop ? "up" : raw > g.pBot ? "down" : null;
      return { ...t, off, anchor: clamp(raw, g.pTop, g.pBot), y: raw };
    }),
  );
}

type Annot = { key: string; band: "top" | "bot"; x: number; py: number; text: string; color: string; left: number };

/** Labels in the reserved bands above/below the price data, each with a faint leader to its point. */
function Annotations({ g, items }: { g: G; items: Annot[] }) {
  return (
    <g pointerEvents="none">
      {items.map((a) => {
        const top = a.band === "top";
        const base = top ? g.annTop + 11 : g.pBot + 10.5;
        const y1 = top ? g.pTop - 1 : a.py + 4;
        const y2 = top ? a.py - 4 : g.pBot + 1;
        return (
          <g key={a.key}>
            {y2 - y1 > 2 && <line x1={crisp(a.x)} x2={crisp(a.x)} y1={y1} y2={y2} stroke={a.color} strokeDasharray="1 2" opacity={0.45} />}
            {!a.key.startsWith("s") && <circle cx={a.x} cy={a.py} r={2.2} fill="var(--bg-1)" stroke="var(--ink-2)" />}
            <text x={a.left} y={base} className={s.annText} fill={a.color}>
              {a.text}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** Notch when the body sits on its level; a slim leader wedge when it was nudged away. */
function tagPointer(R: number, anchor: number, y: number, H: number): string {
  if (Math.abs(anchor - y) <= H / 2) return `${R - 4},${anchor} ${R + 1},${y - H / 2} ${R + 1},${y + H / 2}`;
  const edge = anchor < y ? y - H / 2 : y + H / 2;
  const inward = anchor < y ? 5 : -5;
  return `${R - 4},${anchor} ${R + 1},${edge} ${R + 1},${edge + inward}`;
}

function AxisTags({ g, placed }: { g: G; placed: Placed[] }) {
  const H = TAG_H;
  return (
    <g>
      {placed.map((t) => (
        <g key={t.key}>
          {/* pointer aims at the exact level even when the body was nudged by a neighbour */}
          <polygon points={tagPointer(g.R, t.anchor, t.y, H)} fill={t.bg} opacity={t.outline ? 0.6 : 1} />
          {t.outline ? (
            <rect x={g.R + 1.5} y={t.y - H / 2 + 0.5} width={AXW - 3} height={H - 1} fill="var(--bg-1)" stroke={t.bg} strokeDasharray={t.small ? undefined : "2 2"} />
          ) : (
            <rect x={g.R + 1} y={t.y - H / 2} width={AXW - 2} height={H} fill={t.bg} />
          )}
          <text x={g.R + 5} y={t.y + 3.6} className={s.tagText} fill={t.outline ? (t.small ? t.fg : t.bg) : t.fg} style={t.small ? { fontWeight: 500 } : undefined}>
            {t.off === "up" ? "▲" : t.off === "down" ? "▼" : ""}
            {t.text}
          </text>
          {t.name && (
            <text x={g.R + AXW + 4} y={t.y + 3.4} className={s.tagName} fill={t.key === "last" ? "var(--ink-2)" : t.outline && !t.small ? "var(--ink-3)" : t.bg}>
              {t.name}
            </text>
          )}
        </g>
      ))}
    </g>
  );
}

/** Volume caption: the session's shares and its multiple of the prior 20-day average. */
function VolLabel({ g, v, avg, hover }: { g: G; v: number | null; avg: number | null; hover: boolean }) {
  const rel = v != null && avg ? v / avg : null;
  return (
    <>
      <text x={g.L + 4} y={g.vTop + 8} className={s.paneLabel}>
        VOLUME
        <tspan className={s.paneVal} dx={6} style={{ fill: "var(--ink)" }}>
          {v != null ? fmtBig(v) : "—"}
        </tspan>
        {rel != null && (
          <tspan className={s.paneVal} dx={5} style={rel >= 1.5 ? { fill: "var(--ink)" } : undefined}>
            {rel.toFixed(2)}× 20d avg{hover ? "" : " (last)"}
          </tspan>
        )}
      </text>
      <text x={g.R - 4} y={g.vTop + 8} textAnchor="end" className={s.paneNote}>
        shares · line = prior 20d avg
      </text>
    </>
  );
}

function Crosshair({ g, i, v, chg, vol, d }: { g: G; i: number; v: number; chg: number | null; vol: number | null; d: string }) {
  const cx = crisp(g.x(i));
  const cy = g.y(v);
  const label = fmtD(d, "dmy");
  const tw = 64;
  const tx = clamp(cx - tw / 2, g.L, g.R - tw);
  return (
    <g pointerEvents="none">
      <line x1={cx} x2={cx} y1={g.pTop - 6} y2={g.hBot} stroke="var(--ink-3)" strokeDasharray="2 2" />
      <line x1={g.L} x2={g.R} y1={crisp(cy)} y2={crisp(cy)} stroke="var(--ink-3)" strokeDasharray="2 2" />
      <circle cx={cx} cy={cy} r={3.2} fill="var(--ink)" stroke="#000" strokeWidth={1.5} />
      <rect x={g.R + 1} y={cy - 7.5} width={AXW - 2} height={15} fill="var(--amber)" />
      <text x={g.R + 5} y={cy + 3.6} className={s.tagText} fill="#000">
        {fmtPx(v)}
      </text>
      {vol != null && (
        <>
          <rect x={g.R + 1} y={clamp(g.yv(vol), g.vTop + 7.5, g.vBot - 7.5) - 7.5} width={AXW - 2} height={15} fill="var(--amber)" />
          <text x={g.R + 5} y={clamp(g.yv(vol), g.vTop + 7.5, g.vBot - 7.5) + 3.6} className={s.tagText} fill="#000">
            {fmtBig(vol)}
          </text>
        </>
      )}
      {chg != null && (
        <>
          <rect x={g.R + 1} y={g.yh(chg) - 7.5} width={AXW - 2} height={15} fill="var(--amber)" />
          <text x={g.R + 5} y={g.yh(chg) + 3.6} className={s.tagText} fill="#000">
            {fmtPts(chg)}
          </text>
        </>
      )}
      <rect x={tx} y={g.hBot + 2} width={tw} height={15} fill="var(--amber)" />
      <text x={tx + tw / 2} y={g.hBot + 13} textAnchor="middle" className={s.tagText} fill="#000">
        {label}
      </text>
    </g>
  );
}

type BoxRow = { sw?: { color: string; dash?: string; tri?: "up" | "down" }; k: string; v: string; cls?: string; pairs?: [string, string][] };

function buildBoxRows({
  hover,
  win,
  full,
  series,
  ticker,
  val,
  show,
  levels,
  candle,
  rsAt,
  spyRetAt,
}: {
  hover: number;
  rsAt: number | null;
  spyRetAt: number | null;
  win: { start: number };
  full: {
    c: number[];
    o: (number | null)[];
    hh: (number | null)[];
    ll: (number | null)[];
    v: (number | null)[];
    vAvg: (number | null)[];
    chg: (number | null)[];
    marks: Map<number, Trade[]>;
  };
  series: { d: string }[];
  ticker: string;
  val: Record<Key, number | null>;
  show: (k: Key) => boolean;
  levels: ChartLevels;
  candle: boolean;
}): BoxRow[] {
  const c = full.c;
  const chg = full.chg[hover];
  const prev = hover > 0 ? c[hover - 1] : null;
  const rows: BoxRow[] = [];
  if (candle && full.o[hover] != null) {
    rows.push({ k: "", v: "", pairs: [["O", fmtPx(full.o[hover])], ["H", fmtPx(full.hh[hover])]] });
    rows.push({ k: "", v: "", pairs: [["L", fmtPx(full.ll[hover])], ["C", fmtPx(c[hover])]] });
  } else {
    rows.push({ sw: { color: C.px }, k: `${ticker} Close`, v: fmtPx(c[hover]) });
  }
  rows.push({ k: "Change", v: prev != null ? `${c[hover] - prev >= 0 ? "+" : "−"}${fmtNum(Math.abs(c[hover] - prev))}  ${fmtChg(chg)}` : "—", cls: tone(chg) });
  const vv = full.v[hover];
  const va = full.vAvg[hover];
  if (vv != null) rows.push({ k: "Volume", v: `${fmtBig(vv)}${va ? ` · ${(vv / va).toFixed(2)}× 20d` : ""}` });
  (["sma50", "sma200"] as const).forEach((k) => {
    if (show(k) && val[k] != null) rows.push({ sw: { color: C[k], dash: DASH[k] }, k: LABEL[k], v: fmtPx(val[k]) });
  });
  if (show("spy") && spyRetAt != null) rows.push({ sw: { color: C.spy }, k: "SPY (rebased)", v: fmtChg(spyRetAt, 1), cls: tone(spyRetAt) });
  rows.push({ k: `From ${fmtD(series[win.start].d, "dmy")}`, v: fmtChg(c[hover] / c[win.start] - 1), cls: tone(c[hover] / c[win.start] - 1) });
  if (rsAt != null) rows.push({ sw: { color: C.spy }, k: "vs SPY (since range start)", v: fmtPts(rsAt), cls: tone(rsAt) });
  if (levels) rows.push({ sw: { color: C.avg, dash: DASH.avg }, k: "vs avg cost", v: fmtChg(c[hover] / levels.avg - 1), cls: tone(c[hover] / levels.avg - 1) });
  for (const t of full.marks.get(hover) ?? []) {
    rows.push({
      sw: { color: t.side === "buy" ? "var(--up)" : "var(--down)", tri: t.side === "buy" ? "up" : "down" },
      k: `${t.side.toUpperCase()}${t.dry_run ? " (dry)" : ""} ${fmtNum(t.qty, t.qty % 1 ? 2 : 0)} @ ${fmtPx(t.price)}`,
      v: `$${fmtNum(t.notional, 0)}`,
      cls: t.side === "buy" ? "up" : "down",
    });
  }
  return rows;
}

function LegendBox({
  g,
  hover,
  rows,
  title,
  obstacles,
}: {
  g: G;
  hover: number | null;
  rows: BoxRow[];
  title: string;
  /** [x, y, weight] — things the box should not cover (line points, trade markers, callouts). */
  obstacles: [number, number, number][];
}) {
  const BW = 214;
  const BH = 26 + rows.length * 16;
  const midX = (g.L + g.R - BW) / 2;
  const top = g.pTop + 4;
  const bot = g.pBot - 6 - BH;
  const corners = [
    { x: g.L + 8, y: top },
    { x: g.R - 10 - BW, y: top },
    { x: g.L + 8, y: bot },
    { x: g.R - 10 - BW, y: bot },
    { x: midX, y: top },
    { x: midX, y: bot },
  ];
  const hx = hover != null ? g.x(hover) : null;
  let best = 0;
  let bestScore = Infinity;
  let bestCover = Infinity;
  corners.forEach((c, k) => {
    let cover = 0;
    for (const [ox, oy, wt] of obstacles) if (ox >= c.x - 8 && ox <= c.x + BW + 8 && oy >= c.y - 8 && oy <= c.y + BH + 8) cover += wt;
    if (hx != null && hx >= c.x - 28 && hx <= c.x + BW + 28) cover += 100_000;
    const score = cover + k * 0.75; // mild preference order: TL, TR, BL, BR, TC, BC
    if (score < bestScore) {
      bestScore = score;
      bestCover = cover;
      best = k;
    }
  });
  const pos = corners[best];
  void bestCover;
  return (
    <div className={s.box} style={{ left: pos.x, top: pos.y, width: BW }} aria-live="off">
      <div className={s.boxTitle}>{title}</div>
      {rows.map((r, i) =>
        r.pairs ? (
          <div key={i} className={s.boxPairs}>
            {r.pairs.map(([k, v]) => (
              <span key={k}>
                <span className={s.boxK}>{k}</span>
                <span className="num" style={{ color: "var(--ink)" }}>{v}</span>
              </span>
            ))}
          </div>
        ) : (
        <div key={i} className={s.boxRow}>
          <span className={s.boxSw}>
            {r.sw &&
              (r.sw.tri ? (
                <svg width="10" height="8" aria-hidden="true">
                  <polygon points={r.sw.tri === "up" ? "5,0 10,8 0,8" : "0,0 10,0 5,8"} fill={r.sw.color} />
                </svg>
              ) : (
                <svg width="12" height="6" aria-hidden="true">
                  <line x1="0" x2="12" y1="3" y2="3" stroke={r.sw.color} strokeWidth={1.6} strokeDasharray={r.sw.dash} />
                </svg>
              ))}
          </span>
          <span className={s.boxK}>{r.k}</span>
          <span className={`num ${r.cls ?? ""}`} style={{ color: r.cls ? undefined : "var(--ink)" }}>
            {r.v}
          </span>
        </div>
        ),
      )}
    </div>
  );
}
