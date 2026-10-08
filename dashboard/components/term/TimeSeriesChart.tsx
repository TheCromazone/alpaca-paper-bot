"use client";

/**
 * TimeSeriesChart — a hand-rolled SVG daily time-series chart in the
 * Bloomberg GP idiom, sized by ResizeObserver to whatever box it is given.
 *
 *  · N series on a shared trading-day x-axis (index-spaced: no weekend gaps)
 *  · right-hand value axis with nice ticks; end-value tags sit INSIDE the
 *    plot in a reserved gutter, so every axis label stays readable
 *  · date axis: "May 18"-style labels at day/week/half-month density, month
 *    names ("Jun", "2027") at month density and coarser
 *  · hover crosshair: hairlines, axis read-outs, point markers and a legend
 *    box (series values, extra rows, events at the cursor)
 *  · optional: area fill, a lead/lag band between two series, horizontal
 *    reference lines, high/low call-outs, event markers anchored on a series
 *    (buy ▲ below / sell ▼ above, merged per session with a count),
 *    background shading runs (e.g. market regime) and a key for them
 *  · optional sub-pane (histogram / underwater area / line) sharing the
 *    x-axis, captioned in its own strip so the caption never sits on data
 *
 * Dates are "YYYY-MM-DD" (or ISO; only the date part is used) and are never
 * routed through a timezone, so a session date always renders as itself.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

const MINUS = "−";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CHAR_W = 6.02; // IBM Plex Mono advance at 10px
const MONO = "var(--font-plex-mono), ui-monospace, monospace";
const SANS = "var(--font-plex-cond), ui-sans-serif, sans-serif";

export type TSSeries = {
  id: string;
  label: string;
  data: (number | null | undefined)[];
  color: string;
  width?: number;
  dash?: string;
  /** Gradient area fill under the line. */
  area?: boolean;
  /** Last-value tag (default true). */
  tag?: boolean;
  /** Include in the legend box (default true). */
  legend?: boolean;
  /** Value formatter for legend + tag; falls back to the chart's `fmt`. */
  fmt?: (v: number) => string;
};

export type TSRef = {
  value: number;
  label: string;
  color?: string;
  dash?: string;
  /** Stretch the y-domain so the line is visible (default true). */
  inDomain?: boolean;
};

export type TSSub = {
  label: string;
  kind: "bars" | "area" | "line";
  data: (number | null | undefined)[];
  /** Area / line color. Bars are colored by sign. */
  color?: string;
  fmt?: (v: number) => string;
  /** Number formatting for the sub-pane axis (default "pct"). */
  axis?: "pct" | "price" | "usd" | "num";
  /** Share of the drawable height given to the sub-pane (default .24). */
  ratio?: number;
  /** Right-aligned note in the caption strip (e.g. the window's date range). */
  note?: ReactNode;
};

export type TSBand = { a: string; b: string; up?: string; down?: string; opacity?: number };

export type TSLegendExtra = { label: string; value: string; color?: string };

/** An event pinned to a session on a series (e.g. a trade). */
export type TSMarker = { i: number; side: "buy" | "sell"; label: string; value?: string; date?: string };

/** A background shading run across sessions i0..i1 (inclusive). */
export type TSShade = { i0: number; i1: number; color: string; opacity?: number };

/** A labelled vertical marker at a session (e.g. "bot idle since Jul 20"). */
export type TSAnnotation = { i: number; label: string; color?: string; /** label line (0 = top) so neighbours never collide */ row?: number };

/** Key items shown in the main pane (markers / shading legend). */
export type TSKey = { glyph: "buy" | "sell" | "box" | "line" | "chip"; color: string; label: string; opacity?: number; text?: string };

export type TimeSeriesChartProps = {
  dates: string[];
  series: TSSeries[];
  sub?: TSSub | null;
  refs?: TSRef[];
  /** Shade between series `a` and `b`: green where a > b, red where a < b. */
  band?: TSBand | null;
  /** Event markers anchored on `markerSeries` (default: the first series). */
  markers?: TSMarker[];
  markerSeries?: string;
  /** Background shading runs (behind grid and data). */
  shade?: TSShade[];
  /** "fill" = full-height bands; "strip" = a thin bar along the plot's
   *  bottom edge (keeps band colors from muddying lead/lag fills). */
  shadeStyle?: "fill" | "strip";
  /** Labelled vertical markers. */
  annotations?: TSAnnotation[];
  /** Draw `markers` in their own lane under the price plot (one segment per
   *  day or run of adjacent days, buys above the midline, sells below, the
   *  trade count inside) instead of on the series line. */
  markerLane?: boolean;
  /** Repeat the value-axis labels inside the plot's left edge. */
  leftAxis?: boolean;
  /** Where the value axis lives: right (default, Bloomberg) or left — with
   *  "left", the right column carries only end-value tags. */
  valueAxis?: "right" | "left";
  /** Key items for markers / shading, shown top-left in the main pane. */
  keys?: TSKey[];
  /** Where end-value tags go: inside the plot's right gutter (default; keeps
   *  every axis label readable) or on the axis itself (Bloomberg-style). */
  tagPlacement?: "inside" | "axis";
  /** Drives default number formatting: fractions as %, prices, dollars. */
  kind?: "pct" | "price" | "usd" | "num";
  /** Formatter for values (legend + tags). */
  fmt?: (v: number) => string;
  /** Formatter for axis ticks; receives the tick step for precision. */
  tickFmt?: (v: number, step: number) => string;
  /** Emphasize the 0 line (default: on for kind="pct"). */
  zeroLine?: boolean;
  /** "H 181.36" / "L 154.22" call-outs on the first series. */
  markExtremes?: boolean;
  /** Extra legend rows computed for the hovered (or last) index. */
  legendExtra?: (i: number) => TSLegendExtra[];
  /** "hover" = only while the cursor is on the chart; "auto" (default) also
   *  parks it when the plot is roomy; "always" parks it regardless. */
  legend?: "hover" | "auto" | "always";
  /** Fixed pixel height; omit to fill the parent. */
  height?: number;
  className?: string;
  style?: CSSProperties;
  onHover?: (i: number | null) => void;
  emptyText?: ReactNode;
};

// ── formatting ───────────────────────────────────────────────────────────

const sgn = (v: number, plus = false) => (v < 0 ? MINUS : plus && v > 0 ? "+" : "");
const grp = (v: number, d: number) =>
  Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
/** Decimals needed to print every multiple of `step` exactly (2.5 → 1, 0.25 → 2). */
const decFor = (step: number) => {
  for (let k = 0; k < 4; k++) {
    const m = step * 10 ** k;
    if (Math.abs(m - Math.round(m)) < 1e-6 * Math.max(1, m)) return k;
  }
  return 4;
};

function defaultTick(kind: TimeSeriesChartProps["kind"]) {
  return (v: number, step: number) => {
    if (Math.abs(v) < step * 1e-6) v = 0;
    if (kind === "pct") return `${sgn(v)}${Math.abs(v * 100).toFixed(Math.max(1, decFor(step * 100)))}%`;
    if (kind === "usd") {
      const a = Math.abs(v);
      if (a >= 1e6 && step >= 1e4) return `${sgn(v)}${(a / 1e6).toFixed(step >= 1e5 ? 1 : 2)}M`;
      if (a >= 1e4 && step >= 100) return `${sgn(v)}${(a / 1e3).toFixed(step >= 1000 ? 0 : 1)}K`;
      return `${sgn(v)}${grp(v, decFor(step))}`;
    }
    return `${sgn(v)}${grp(v, decFor(step))}`;
  };
}

function defaultFmt(kind: TimeSeriesChartProps["kind"]) {
  return (v: number) => {
    if (kind === "pct") return `${sgn(v, true)}${Math.abs(v * 100).toFixed(2)}%`;
    if (kind === "usd") return `${sgn(v)}$${grp(v, 2)}`;
    return `${sgn(v)}${grp(v, Math.abs(v) < 1 ? 4 : 2)}`;
  };
}

// ── dates ────────────────────────────────────────────────────────────────

type DP = { y: number; m: number; d: number; t: number };

function parseD(s: string): DP {
  const y = +s.slice(0, 4);
  const m = +s.slice(5, 7);
  const d = +s.slice(8, 10);
  return { y, m, d, t: Math.round(Date.UTC(y, m - 1, d) / 86_400_000) };
}

const fmtLegendDate = (p: DP) =>
  `${DOW[new Date(p.t * 86_400_000).getUTCDay()]} ${MON[p.m - 1]} ${String(p.d).padStart(2, "0")} ${p.y}`;
const monDay = (p: DP) => `${MON[p.m - 1]} ${String(p.d).padStart(2, "0")}`;

type Tick = { i: number; label: string; major: boolean };

/**
 * Choose the finest calendar boundary level that fits `maxTicks`.
 * Finer than monthly → every label is "May 18" (month turns included, so a
 * reader never sees a bare day number); monthly and coarser → "Jun", with
 * the year at January.
 */
function dateTicks(ds: DP[], maxTicks: number): Tick[] {
  if (ds.length < 2) return [];
  const keys: ((p: DP) => number)[] = [
    (p) => p.t, // every session
    (p) => Math.floor((p.t + 3) / 7), // ISO week (Mon)
    (p) => p.y * 24 + (p.m - 1) * 2 + (p.d >= 16 ? 1 : 0), // half-month
    (p) => p.y * 12 + p.m, // month
    (p) => p.y * 6 + Math.floor((p.m - 1) / 2), // bi-month
    (p) => p.y * 4 + Math.floor((p.m - 1) / 3), // quarter
    (p) => p.y * 2 + (p.m > 6 ? 1 : 0), // half-year
    (p) => p.y, // year
  ];
  let chosen: number[] = [];
  let level = 0;
  for (let k = 0; k < keys.length; k++) {
    const idx: number[] = [];
    for (let i = 1; i < ds.length; i++) if (keys[k](ds[i]) !== keys[k](ds[i - 1])) idx.push(i);
    chosen = idx;
    level = k;
    if (idx.length <= maxTicks) break;
  }
  if (level < 3) {
    // always mark where the month turns; drop day ticks crowding it
    const months: number[] = [];
    for (let i = 1; i < ds.length; i++) if (ds[i].m !== ds[i - 1].m) months.push(i);
    const gap = Math.max(2, Math.ceil((ds.length / Math.max(1, maxTicks)) * 0.6));
    chosen = [...months, ...chosen.filter((i) => months.every((m) => Math.abs(m - i) >= gap))].sort((a, b) => a - b);
    return chosen.map((i) => ({ i, label: monDay(ds[i]), major: ds[i].m !== ds[i - 1].m }));
  }
  return chosen.map((i) => {
    const p = ds[i];
    const q = ds[i - 1];
    if (p.y !== q.y) return { i, label: String(p.y), major: true };
    return { i, label: MON[p.m - 1], major: true };
  });
}

// ── numbers ──────────────────────────────────────────────────────────────

function niceStep(range: number, target: number) {
  const raw = range / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

function niceTicks(min: number, max: number, target: number) {
  const step = niceStep(max - min || Math.abs(max) || 1, target);
  const out: number[] = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return { ticks: out, step };
}

const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

function lastIdx(arr: (number | null | undefined)[]) {
  for (let i = arr.length - 1; i >= 0; i--) if (finite(arr[i])) return i;
  return -1;
}

/** Polyline path with gaps at nulls. */
function linePath(data: (number | null | undefined)[], x: (i: number) => number, y: (v: number) => number) {
  let d = "";
  let pen = false;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!finite(v)) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** Closed area between a series and a horizontal baseline (per finite run). */
function areaPath(data: (number | null | undefined)[], x: (i: number) => number, y: (v: number) => number, baseY: number) {
  let d = "";
  let start = -1;
  let prev = -1;
  const close = () => {
    if (start >= 0) d += `L${x(prev).toFixed(1)},${baseY.toFixed(1)}L${x(start).toFixed(1)},${baseY.toFixed(1)}Z`;
  };
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!finite(v)) {
      close();
      start = -1;
      continue;
    }
    if (start < 0) {
      start = i;
      d += `M${x(i).toFixed(1)},${baseY.toFixed(1)}L${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    } else d += `L${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    prev = i;
  }
  close();
  return d;
}

/** Triangle glyph centred on (cx, cy): ▲ (up=true) or ▼. */
const tri = (cx: number, cy: number, up: boolean, s = 3.6) =>
  up
    ? `M${cx},${cy - s}L${cx + s},${cy + s * 0.8}L${cx - s},${cy + s * 0.8}Z`
    : `M${cx},${cy + s}L${cx + s},${cy - s * 0.8}L${cx - s},${cy - s * 0.8}Z`;

// ── size hook ────────────────────────────────────────────────────────────

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      setSize((s) => (Math.abs(s.w - r.width) < 0.5 && Math.abs(s.h - r.height) < 0.5 ? s : { w: Math.floor(r.width), h: Math.floor(r.height) }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

// ── component ────────────────────────────────────────────────────────────

export function TimeSeriesChart({
  dates,
  series,
  sub,
  refs = [],
  band,
  markers = [],
  markerSeries,
  shade = [],
  shadeStyle = "fill",
  annotations = [],
  markerLane = false,
  leftAxis = false,
  valueAxis = "right",
  keys = [],
  tagPlacement = "inside",
  kind = "num",
  fmt,
  tickFmt,
  zeroLine,
  markExtremes = false,
  legendExtra,
  legend = "auto",
  height,
  className = "",
  style,
  onHover,
  emptyText = "No data",
}: TimeSeriesChartProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [boxRef, { w, h }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; y: number | null } | null>(null);

  const n = dates.length;
  const ds = useMemo(() => dates.map(parseD), [dates]);
  const vFmt = useMemo(() => fmt ?? defaultFmt(kind), [fmt, kind]);
  const tFmt = useMemo(() => tickFmt ?? defaultTick(kind), [tickFmt, kind]);
  const showZero = zeroLine ?? kind === "pct";
  const inside = tagPlacement === "inside";
  const capH = sub ? 17 : 0; // caption strip between panes

  // ── y-domain (main) ──
  const dom = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series)
      for (const v of s.data) {
        if (!finite(v)) continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    if (!Number.isFinite(lo)) return null;
    for (const r of refs) {
      if (r.inDomain === false || !finite(r.value)) continue;
      lo = Math.min(lo, r.value);
      hi = Math.max(hi, r.value);
    }
    if (showZero && lo > 0 && lo < (hi - lo) * 0.25) lo = 0;
    const span = hi - lo || Math.abs(hi) * 0.02 || 1;
    return { lo: lo - span * (markers.length ? 0.12 : 0.08), hi: hi + span * (markers.length || keys.length ? 0.16 : 0.1) };
  }, [series, refs, showZero, markers.length, keys.length]);

  // ── layout ──
  const geo = useMemo(() => {
    if (!dom || !w || !h) return null;
    const padT = 6;
    const dateH = 17;
    const laneH = markerLane && markers.length ? 26 : 0;
    const drawH = Math.max(40, h - padT - dateH - capH - laneH);
    const subH = sub ? Math.round(drawH * (sub.ratio ?? 0.24)) : 0;
    const mainH = drawH - subH;
    const yT = niceTicks(dom.lo, dom.hi, Math.max(2, Math.floor(mainH / 28)));
    const tagTexts = [
      ...series.filter((s) => s.tag !== false).map((s) => {
        const li = lastIdx(s.data);
        return li >= 0 ? (s.fmt ?? vFmt)(s.data[li] as number) : "";
      }),
      ...refs.map((r) => vFmt(r.value)),
    ];
    const tagLen = Math.max(0, ...tagTexts.map((t) => t.length));
    const tickLen = Math.max(4, ...yT.ticks.map((t) => tFmt(t, yT.step).length));
    const leftV = valueAxis === "left";
    const axisW = leftV ? Math.ceil(Math.max(tagLen, 4) * CHAR_W + 13) : Math.ceil((inside ? tickLen : Math.max(tickLen, tagLen)) * CHAR_W + 13);
    const tagW = Math.ceil(tagLen * CHAR_W + 10);
    const x0 = leftV ? Math.ceil(Math.max(tickLen, 6) * CHAR_W + 12) : 0;
    const x1 = w - axisW; // axis line
    const gutter = inside && tagLen ? tagW + 12 : 7; // room right of the last point
    const xr = x1 - gutter;
    const mainTop = padT;
    const mainBot = padT + mainH;
    const laneTop = mainBot;
    const laneBot = mainBot + laneH;
    const capTop = laneBot;
    const subTop = laneBot + capH;
    const subBot = subTop + subH;
    const x = (i: number) => x0 + 2 + (n <= 1 ? 0 : (i / (n - 1)) * (xr - x0 - 2));
    const y = (v: number) => mainBot - ((v - dom.lo) / (dom.hi - dom.lo)) * mainH;
    const yInv = (py: number) => dom.lo + ((mainBot - py) / mainH) * (dom.hi - dom.lo);
    const step = n > 1 ? (xr - x0 - 2) / (n - 1) : 8;
    // tags: inside → right-aligned to the axis within the gutter; axis → on the axis
    const tagX = inside ? x1 - tagW - 2 : x1 + 1;
    const tagRectW = inside ? tagW : axisW - 1;
    return { axisW, tagW: tagRectW, tagX, x0, x1, xr, mainTop, mainBot, laneTop, laneBot, laneH, capTop, subTop, subBot, subH, x, y, yInv, yT, step, leftV, dateY: sub ? subBot : laneBot };
  }, [dom, w, h, sub, capH, series, refs, n, tFmt, vFmt, inside, markerLane, markers.length, valueAxis]);

  // ── sub-pane scale: floor/ceil to a nice tick so the extreme is labelled
  // and the series never sits on the pane edge ──
  const subGeo = useMemo(() => {
    if (!sub || !geo) return null;
    let lo = 0;
    let hi = 0;
    for (const v of sub.data) {
      if (!finite(v)) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const range = hi - lo || Math.abs(lo) || 1e-4;
    const tgt = Math.max(2, Math.floor(geo.subH / 22));
    const st = niceStep(range, tgt);
    const L = lo < 0 ? Math.floor(lo / st - 1e-9) * st : 0;
    const H = hi > 0 ? Math.ceil(hi / st - 1e-9) * st : 0;
    // pixel padding: zero/top tick sits 5px under the pane top, the floor tick
    // 9px above its bottom, so the floor label never meets the date row
    const top = geo.subTop + 5;
    const bot = geo.subBot - 9;
    const y = (v: number) => bot - ((v - L) / (H - L || 1)) * (bot - top);
    const ticks: number[] = [];
    for (let v = L; v <= H + st * 1e-9; v += st) ticks.push(+v.toPrecision(12));
    return { y, ticks, step: st, zero: y(0) };
  }, [sub, geo]);

  // ── static paths (memoized: only recomputed on data/size change) ──
  const paths = useMemo(() => {
    if (!geo) return null;
    const { x, y, mainBot, mainTop } = geo;
    const lines = series.map((s) => ({ s, d: linePath(s.data, x, y), area: s.area ? areaPath(s.data, x, y, mainBot) : null }));
    let bandP: { belowA: string; aboveB: string; belowB: string; aboveA: string } | null = null;
    if (band) {
      const A = series.find((s) => s.id === band.a);
      const B = series.find((s) => s.id === band.b);
      if (A && B) {
        const both = A.data.map((v, i) => (finite(v) && finite(B.data[i]) ? i : -1)).filter((i) => i >= 0);
        if (both.length > 1) {
          const f = both[0];
          const l = both[both.length - 1];
          const seg = (data: (number | null | undefined)[]) =>
            both
              .map((i) => `L${x(i).toFixed(1)},${y(data[i] as number).toFixed(1)}`)
              .join("")
              .replace(/^L/, "M");
          const belowOf = (data: (number | null | undefined)[]) => `${seg(data)}L${x(l).toFixed(1)},${mainBot}L${x(f).toFixed(1)},${mainBot}Z`;
          const aboveOf = (data: (number | null | undefined)[]) => `${seg(data)}L${x(l).toFixed(1)},${mainTop}L${x(f).toFixed(1)},${mainTop}Z`;
          bandP = { belowA: belowOf(A.data), aboveB: aboveOf(B.data), belowB: belowOf(B.data), aboveA: aboveOf(A.data) };
        }
      }
    }
    let subP: { d?: string; area?: string; bars?: { x: number; y: number; h: number; up: boolean }[]; bw?: number } | null = null;
    if (sub && subGeo) {
      if (sub.kind === "bars") {
        const bw = Math.max(1, Math.min(9, geo.step * 0.7));
        subP = {
          bw,
          bars: sub.data.flatMap((v, i) => {
            if (!finite(v) || v === 0) return [];
            const yv = subGeo.y(v);
            return [{ x: x(i) - bw / 2, y: Math.min(yv, subGeo.zero), h: Math.max(1, Math.abs(yv - subGeo.zero)), up: v > 0 }];
          }),
        };
      } else {
        subP = { d: linePath(sub.data, x, subGeo.y), area: sub.kind === "area" ? areaPath(sub.data, x, subGeo.y, subGeo.zero) : undefined };
      }
    }
    // high / low call-outs on the primary series
    let ext: { hi: [number, number]; lo: [number, number] } | null = null;
    if (markExtremes && series[0]) {
      let hiI = -1;
      let loI = -1;
      series[0].data.forEach((v, i) => {
        if (!finite(v)) return;
        if (hiI < 0 || v > (series[0].data[hiI] as number)) hiI = i;
        if (loI < 0 || v < (series[0].data[loI] as number)) loI = i;
      });
      if (hiI >= 0 && loI >= 0 && hiI !== loI) ext = { hi: [hiI, series[0].data[hiI] as number], lo: [loI, series[0].data[loI] as number] };
    }
    // event markers: anchored ON the series at a session (a dot). Trades are
    // merged per (session, side), then sessions whose glyphs would sit within
    // 14px of each other merge into one cluster (anchored at its busiest
    // session) with a combined count; buys hang below, sells sit above.
    const ms = series.find((s) => s.id === markerSeries) ?? series[0];
    const grouped = new Map<string, { i: number; side: "buy" | "sell"; count: number }>();
    for (const m of markers) {
      if (m.i < 0 || m.i >= n || !ms || !finite(ms.data[m.i])) continue;
      const k = `${m.i}:${m.side}`;
      const g = grouped.get(k);
      if (g) g.count++;
      else grouped.set(k, { i: m.i, side: m.side, count: 1 });
    }
    type Glyph = { i: number; side: "buy" | "sell"; count: number; sessions: number[]; cx: number; ly: number; cy: number; dir: number };
    const glyphs: Glyph[] = [];
    for (const side of ["buy", "sell"] as const) {
      const list = [...grouped.values()].filter((g) => g.side === side).sort((a, b) => a.i - b.i);
      let cur: { x0: number; count: number; sessions: number[]; anchor: number; best: number } | null = null;
      const flush = () => {
        if (!cur) return;
        const ly = y(ms.data[cur.anchor] as number);
        const dir = side === "buy" ? 1 : -1;
        glyphs.push({ i: cur.anchor, side, count: cur.count, sessions: cur.sessions, cx: x(cur.anchor), ly, dir, cy: ly + dir * (cur.count > 1 ? 13 : 10) });
      };
      for (const g of list) {
        const gx = x(g.i);
        if (cur && gx - cur.x0 < 14) {
          cur.count += g.count;
          cur.sessions.push(g.i);
          if (g.count > cur.best) {
            cur.best = g.count;
            cur.anchor = g.i;
          }
        } else {
          flush();
          cur = { x0: gx, count: g.count, sessions: [g.i], anchor: g.i, best: g.count };
        }
      }
      flush();
    }
    // trade lane: one tick per trading day at its exact date, height scaled by
    // the number of trades; days merge only when ticks would sit <3px apart
    type Seg = { side: "buy" | "sell"; i0: number; i1: number; count: number; sessions: number[]; cx: number };
    const lane: Seg[] = [];
    if (markerLane) {
      for (const side of ["buy", "sell"] as const) {
        const days = [...grouped.values()].filter((g) => g.side === side).sort((a, b) => a.i - b.i);
        let cur: Seg | null = null;
        for (const g of days) {
          if (cur && x(g.i) - x(cur.i1) < 3) {
            cur.i1 = g.i;
            cur.count += g.count;
            cur.sessions.push(g.i);
            cur.cx = (x(cur.i0) + x(cur.i1)) / 2;
          } else {
            if (cur) lane.push(cur);
            cur = { side, i0: g.i, i1: g.i, count: g.count, sessions: [g.i], cx: x(g.i) };
          }
        }
        if (cur) lane.push(cur);
      }
    }
    return { lines, bandP, subP, ext, glyphs: markerLane ? [] : glyphs, lane };
  }, [geo, subGeo, series, band, sub, n, markExtremes, markers, markerSeries, markerLane]);

  const xTicks = useMemo(() => (geo ? dateTicks(ds, Math.max(2, Math.floor((geo.xr - geo.x0) / 64))) : []), [ds, geo]);

  // ── end-value tags (collision-resolved) ──
  const tags = useMemo(() => {
    if (!geo) return [];
    const out: { y: number; text: string; bg: string; fg: string; outline?: boolean; px?: number }[] = [];
    for (const s of series) {
      if (s.tag === false) continue;
      const li = lastIdx(s.data);
      if (li < 0) continue;
      const v = s.data[li] as number;
      out.push({ y: geo.y(v), text: (s.fmt ?? vFmt)(v), bg: s.color, fg: "#000", px: geo.x(li) });
    }
    for (const r of refs) {
      const yy = geo.y(r.value);
      if (yy < geo.mainTop || yy > geo.mainBot) continue;
      out.push({ y: yy, text: vFmt(r.value), bg: "var(--bg-1)", fg: r.color ?? "var(--ink-2)", outline: true });
    }
    out.sort((a, b) => a.y - b.y);
    const H = 14;
    for (let k = 1; k < out.length; k++) if (out[k].y - out[k - 1].y < H) out[k].y = out[k - 1].y + H;
    const over = out.length ? out[out.length - 1].y + H / 2 - geo.mainBot : 0;
    if (over > 0)
      for (let k = out.length - 1; k >= 0; k--) {
        out[k].y -= over;
        if (k > 0 && out[k].y - out[k - 1].y >= H) break;
      }
    return out;
  }, [geo, series, refs, vFmt]);

  // events for the legend: hovering any session of a cluster lists the whole cluster
  const markersAt = useMemo(() => {
    const bySession = new Map<number, TSMarker[]>();
    for (const mk of markers) bySession.set(mk.i, [...(bySession.get(mk.i) ?? []), mk]);
    const out = new Map<number, TSMarker[]>();
    const groups = [...(paths?.glyphs ?? []).map((g) => ({ side: g.side, sessions: g.sessions })), ...(paths?.lane ?? []).map((g) => ({ side: g.side, sessions: g.sessions }))];
    for (const g of groups) {
      const evs = g.sessions.flatMap((i) => (bySession.get(i) ?? []).filter((m) => m.side === g.side));
      // the whole run is hoverable, not just the days with fills
      const span = g.sessions.length ? [g.sessions[0], g.sessions[g.sessions.length - 1]] : [];
      for (let i = span[0]; span.length && i <= span[1]; i++) out.set(i, [...(out.get(i) ?? []), ...evs]);
    }
    return out;
  }, [markers, paths]);

  // ── pointer ──
  const onMove = useCallback(
    (e: React.PointerEvent<SVGRectElement>) => {
      if (!geo || n < 1) return;
      const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const i = Math.max(0, Math.min(n - 1, Math.round(((mx - geo.x0 - 2) / (geo.xr - geo.x0 - 2)) * (n - 1))));
      const inMain = my >= geo.mainTop && my <= geo.mainBot;
      setHover((p) => (p && p.i === i && p.y === (inMain ? my : null) ? p : { i, y: inMain ? my : null }));
      onHover?.(i);
    },
    [geo, n, onHover],
  );
  const onLeave = useCallback(() => {
    setHover(null);
    onHover?.(null);
  }, [onHover]);

  const empty = n < 2 || !dom;
  const li = n - 1;
  const at = hover?.i ?? li;

  // ── legend placement: the corner that hides the fewest data points, never
  // the one the cursor is in, and never the key's corner (top-left) ──
  const legendRows =
    series.filter((s) => s.legend !== false).length + (legendExtra && li >= 0 ? legendExtra(li).length : 0) + Math.min(4, markersAt.get(at)?.length ?? 0);
  const corners = useMemo(() => {
    if (!geo) return [];
    const W = 196;
    const H = 22 + 15 * legendRows;
    const right = geo.xr - 4;
    const cands = (["tl", "bl", "tr", "br"] as const).filter((c) => !(keys.length && c === "tl"));
    const boxes = cands.map((c, order) => {
      const left = c[1] === "l" ? geo.x0 + 6 : right - W;
      const top = c[0] === "t" ? geo.mainTop + 6 : geo.mainBot - 6 - H;
      // sample along every segment (not just vertices) so sparse windows score right
      let hits = 0;
      const inBox = (px: number, py: number) => px >= left - 4 && px <= left + W + 4 && py >= top - 4 && py <= top + H + 4;
      for (const s of series)
        for (let i = 0; i < s.data.length; i++) {
          const v = s.data[i];
          if (!finite(v)) continue;
          const nx = s.data[i + 1];
          const xa = geo.x(i);
          const ya = geo.y(v);
          if (!finite(nx)) {
            if (inBox(xa, ya)) hits++;
            continue;
          }
          const xb = geo.x(i + 1);
          const yb = geo.y(nx);
          const steps = Math.max(1, Math.ceil(Math.hypot(xb - xa, yb - ya) / 6));
          for (let k = 0; k < steps; k++) if (inBox(xa + ((xb - xa) * k) / steps, ya + ((yb - ya) * k) / steps)) hits++;
        }
      return { c, left, top, W, H, score: hits * 10 + order };
    });
    return boxes.sort((a, b) => a.score - b.score);
  }, [geo, series, legendRows, keys.length]);
  const legendBox = (() => {
    if (!corners.length) return null;
    if (!hover || !geo) return corners[0];
    const hx = geo.x(hover.i);
    const hy = hover.y ?? -1;
    return corners.find((b) => !(hx >= b.left - 10 && hx <= b.left + b.W + 10 && (hover.y == null || (hy >= b.top - 10 && hy <= b.top + b.H + 10)))) ?? corners[0];
  })();
  const roomy = !!geo && geo.x1 - geo.x0 >= 360 && geo.mainBot - geo.mainTop >= 170;
  const showLegend = !!hover || legend === "always" || (legend === "auto" && roomy);

  return (
    <div
      ref={boxRef}
      className={className}
      style={{ position: "relative", width: "100%", height: height ?? "100%", minHeight: 0, minWidth: 0, userSelect: "none", ...style }}
    >
      {empty ? (
        <div className="panel-empty" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
          {emptyText}
        </div>
      ) : geo && paths ? (
        <>
          <svg width={w} height={h} style={{ display: "block", fontFamily: MONO, fontVariantNumeric: "tabular-nums" }} role="img" aria-label={series.map((s) => s.label).join(" vs ")}>
            <defs>
              {series.map((s, k) =>
                s.area ? (
                  <linearGradient key={k} id={`a${uid}${k}`} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.2} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0.01} />
                  </linearGradient>
                ) : null,
              )}
              {paths.bandP && (
                <>
                  <clipPath id={`ab${uid}`}>
                    <path d={paths.bandP.aboveB} />
                  </clipPath>
                  <clipPath id={`aa${uid}`}>
                    <path d={paths.bandP.aboveA} />
                  </clipPath>
                </>
              )}
              {sub?.kind === "area" && (
                <linearGradient id={`s${uid}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={sub.color ?? "var(--down)"} stopOpacity={0.06} />
                  <stop offset="100%" stopColor={sub.color ?? "var(--down)"} stopOpacity={0.34} />
                </linearGradient>
              )}
              <clipPath id={`m${uid}`}>
                <rect x={geo.x0} y={geo.mainTop} width={geo.x1 - geo.x0} height={geo.mainBot - geo.mainTop} />
              </clipPath>
            </defs>

            {/* background shading runs: full-height bands, or a thin strip on the plot's bottom edge */}
            {shade.map((r, k) => {
              const xa = Math.max(geo.x0, geo.x(r.i0) - geo.step / 2);
              const xb = Math.min(geo.xr + geo.step / 2, geo.x(r.i1) + geo.step / 2);
              if (shadeStyle === "strip")
                return (
                  <rect key={k} x={xa} y={geo.mainBot - 5} width={Math.max(3, xb - xa)} height={5} fill={r.color} fillOpacity={r.opacity ?? 0.9} shapeRendering="crispEdges" />
                );
              return (
                <g key={k} fill={r.color} fillOpacity={r.opacity ?? 0.12} shapeRendering="crispEdges">
                  <rect x={xa} y={geo.mainTop} width={Math.max(2, xb - xa)} height={geo.mainBot - geo.mainTop} />
                  {sub && <rect x={xa} y={geo.subTop} width={Math.max(2, xb - xa)} height={geo.subBot - geo.subTop} />}
                </g>
              );
            })}

            {/* annotations: labelled vertical markers */}
            {annotations.map((a, k) => {
              const xx = Math.round(geo.x(Math.max(0, Math.min(n - 1, a.i)))) + 0.5;
              const right = xx > geo.xr - 150;
              return (
                <g key={`an${k}`}>
                  <line x1={xx} x2={xx} y1={geo.mainTop} y2={geo.dateY} stroke={a.color ?? "var(--ink-3)"} strokeDasharray="2 3" shapeRendering="crispEdges" />
                  <text
                    x={right ? xx - 5 : xx + 5}
                    y={geo.mainTop + 11 + (a.row ?? 0) * 13}
                    textAnchor={right ? "end" : "start"}
                    fontSize={10}
                    fill={a.color ?? "var(--ink-2)"}
                    stroke="var(--bg-1)"
                    strokeWidth={3}
                    paintOrder="stroke"
                    strokeLinejoin="round"
                    style={{ fontFamily: SANS, fontWeight: 600, letterSpacing: "0.02em" }}
                  >
                    {a.label}
                  </text>
                </g>
              );
            })}

            {/* grid */}
            <g shapeRendering="crispEdges">
              {geo.yT.ticks.map((t) => {
                const yy = Math.round(geo.y(t)) + 0.5;
                if (yy < geo.mainTop || yy > geo.mainBot) return null;
                return <line key={t} x1={geo.x0} x2={geo.x1} y1={yy} y2={yy} stroke="var(--line)" />;
              })}
              {xTicks.map((t) => {
                const xx = Math.round(geo.x(t.i)) + 0.5;
                return (
                  <g key={t.i} stroke={t.major ? "var(--line-2)" : "var(--line)"} strokeOpacity={t.major ? 0.7 : 1}>
                    <line x1={xx} x2={xx} y1={geo.mainTop} y2={geo.mainBot} />
                    {sub && <line x1={xx} x2={xx} y1={geo.subTop} y2={geo.subBot} />}
                  </g>
                );
              })}
              {showZero && dom.lo < 0 && dom.hi > 0 && (
                <line x1={geo.x0} x2={geo.x1} y1={Math.round(geo.y(0)) + 0.5} y2={Math.round(geo.y(0)) + 0.5} stroke="var(--ink-4)" />
              )}
              {/* frame: axis spine, caption-strip rules, date baseline */}
              <line x1={geo.x1 + 0.5} x2={geo.x1 + 0.5} y1={geo.mainTop} y2={geo.dateY} stroke="var(--line-2)" />
              {capH > 0 && (
                <>
                  <line x1={geo.x0} x2={geo.x1} y1={geo.capTop + 0.5} y2={geo.capTop + 0.5} stroke="var(--line-2)" />
                  <line x1={geo.x0} x2={geo.x1} y1={geo.subTop + 0.5} y2={geo.subTop + 0.5} stroke="var(--line)" />
                </>
              )}
              <line x1={geo.x0} x2={geo.x1 + 4} y1={geo.dateY + 0.5} y2={geo.dateY + 0.5} stroke="var(--line-2)" />
              {geo.leftV && <line x1={geo.x0 - 0.5} x2={geo.x0 - 0.5} y1={geo.mainTop} y2={geo.dateY} stroke="var(--line-2)" />}
            </g>

            {/* y labels: right axis (on-axis tags hide only the labels they would cover) */}
            <g fontSize={10} fill="var(--ink-3)">
              {geo.yT.ticks.map((t) => {
                const yy = geo.y(t);
                if (yy < geo.mainTop + 4 || yy > geo.mainBot - 3) return null;
                if (!geo.leftV && !inside && tags.some((tg) => Math.abs(tg.y - yy) < 12)) return null;
                return geo.leftV ? (
                  <text key={t} x={geo.x0 - 6} y={yy} textAnchor="end" dominantBaseline="central">
                    {tFmt(t, geo.yT.step)}
                  </text>
                ) : (
                  <text key={t} x={geo.x1 + 6} y={yy} dominantBaseline="central">
                    {tFmt(t, geo.yT.step)}
                  </text>
                );
              })}
            </g>
            {/* left axis: the same ticks, inside the plot, so mid-chart values read without crossing the pane */}
            {leftAxis && (
              <g fontSize={9.5} fill="var(--ink-3)" stroke="var(--bg-1)" strokeWidth={3} paintOrder="stroke" strokeLinejoin="round">
                {geo.yT.ticks.map((t) => {
                  const yy = geo.y(t);
                  if (yy < geo.mainTop + 14 || yy > geo.mainBot - 8) return null;
                  return (
                    <text key={t} x={geo.x0 + 4} y={yy - 5}>
                      {tFmt(t, geo.yT.step)}
                    </text>
                  );
                })}
              </g>
            )}

            {/* x labels — centered on their gridlines; the first session is always dated */}
            <g fontSize={10}>
              {(() => {
                const out: ReactNode[] = [];
                if (geo.leftV)
                  out.push(
                    <text key="yr" x={geo.x0 - 6} y={geo.dateY + 12} textAnchor="end" fill="var(--ink-2)" fontWeight={500}>
                      {ds[0].y}
                    </text>,
                  );
                const startText = geo.leftV ? MON[ds[0].m - 1] : monDay(ds[0]);
                const startW = startText.length * CHAR_W;
                let lastRight = -Infinity;
                const firstTick = xTicks[0];
                if (!firstTick || geo.x(firstTick.i) - (firstTick.label.length * CHAR_W) / 2 > geo.x(0) + 2 + startW + 6) {
                  out.push(
                    <text key="start" x={geo.x(0) + 2} y={geo.dateY + 12} fill="var(--ink-2)" fontWeight={500}>
                      {startText}
                    </text>,
                  );
                  lastRight = geo.x(0) + 2 + startW;
                }
                for (const t of xTicks) {
                  const xx = geo.x(t.i);
                  const tw = t.label.length * CHAR_W;
                  if (xx - tw / 2 < lastRight + 6 || xx + tw / 2 > geo.x1 - 2 || xx - tw / 2 < geo.x0) continue;
                  lastRight = xx + tw / 2;
                  out.push(
                    <text key={t.i} x={xx} textAnchor="middle" y={geo.dateY + 12} fill={t.major ? "var(--ink-2)" : "var(--ink-3)"} fontWeight={t.major ? 500 : 400}>
                      {t.label}
                    </text>,
                  );
                }
                return out;
              })()}
            </g>

            {/* reference lines */}
            <g clipPath={`url(#m${uid})`}>
              {refs.map((r, k) => {
                const yy = Math.round(geo.y(r.value)) + 0.5;
                return (
                  <line
                    key={k}
                    x1={geo.x0}
                    x2={geo.x1}
                    y1={yy}
                    y2={yy}
                    stroke={r.color ?? "var(--ink-2)"}
                    strokeOpacity={0.85}
                    strokeDasharray={r.dash ?? "4 3"}
                    shapeRendering="crispEdges"
                  />
                );
              })}
            </g>

            {/* lead / lag band between two series */}
            {paths.bandP && (
              <g>
                <path d={paths.bandP.belowA} fill={band?.up ?? "var(--up)"} fillOpacity={band?.opacity ?? 0.22} clipPath={`url(#ab${uid})`} />
                <path d={paths.bandP.belowB} fill={band?.down ?? "var(--down)"} fillOpacity={band?.opacity ?? 0.22} clipPath={`url(#aa${uid})`} />
              </g>
            )}

            {/* series */}
            {paths.lines.map(({ s, d, area }, k) => (
              <g key={s.id}>
                {area && <path d={area} fill={`url(#a${uid}${k})`} />}
                <path d={d} fill="none" stroke={s.color} strokeWidth={s.width ?? 1.4} strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            ))}

            {/* trade lane: buys above the midline, sells below, count inside */}
            {geo.laneH > 0 && (
              <g>
                <rect x={geo.x0} y={geo.laneTop + 1} width={geo.x1 - geo.x0} height={geo.laneH - 1} fill="var(--bg-2)" fillOpacity={0.55} shapeRendering="crispEdges" />
                <line x1={geo.x0} x2={geo.x1} y1={geo.laneTop + 0.5} y2={geo.laneTop + 0.5} stroke="var(--line-2)" shapeRendering="crispEdges" />
                <line
                  x1={geo.x0}
                  x2={geo.x1}
                  y1={Math.round(geo.laneTop + geo.laneH / 2) + 0.5}
                  y2={Math.round(geo.laneTop + geo.laneH / 2) + 0.5}
                  stroke="var(--line-2)"
                  strokeDasharray="2 3"
                  shapeRendering="crispEdges"
                />
                <title>Trades per day — tick height = number of trades; buys above the line, sells below</title>
                <text x={geo.x1 + 6} y={geo.laneTop + geo.laneH * 0.27} dominantBaseline="central" fontSize={9.5} fill="var(--up)" style={{ fontFamily: SANS, fontWeight: 600 }}>
                  buys
                </text>
                <text x={geo.x1 + 6} y={geo.laneTop + geo.laneH * 0.75} dominantBaseline="central" fontSize={9.5} fill="var(--down)" style={{ fontFamily: SANS, fontWeight: 600 }}>
                  sells
                </text>
                {paths.lane.map((g, k) => {
                  const active = hover != null && hover.i >= g.i0 && hover.i <= g.i1;
                  const mid = geo.laneTop + geo.laneH / 2;
                  const hh = Math.min(geo.laneH / 2 - 2, 3 + 2 * g.count);
                  const c = g.side === "buy" ? "var(--up)" : "var(--down)";
                  const bw = active ? 4 : 3;
                  return (
                    <rect
                      key={`ln${k}`}
                      x={g.cx - bw / 2}
                      y={g.side === "buy" ? mid - 1 - hh : mid + 1}
                      width={bw}
                      height={hh}
                      fill={c}
                      fillOpacity={active ? 1 : 0.9}
                      shapeRendering="crispEdges"
                    />
                  );
                })}
              </g>
            )}

            {/* event markers: dot on the line, stem, ▲/▼ (single) or a count chip (cluster) */}
            <g>
              {paths.glyphs.map((g) => {
                const active = hover != null && g.sessions.includes(hover.i);
                const c = g.side === "buy" ? "var(--up)" : "var(--down)";
                if (g.count === 1) {
                  const s = active ? 4.4 : 3.5;
                  return (
                    <g key={`${g.i}${g.side}`}>
                      <line x1={g.cx} x2={g.cx} y1={g.ly + g.dir * 2} y2={g.cy - g.dir * s} stroke={c} strokeWidth={1} strokeOpacity={0.8} />
                      <circle cx={g.cx} cy={g.ly} r={2} fill="var(--bg-1)" stroke={c} strokeWidth={1.25} />
                      <path d={tri(g.cx, g.cy, g.side === "buy", s)} fill={c} stroke="var(--bg-1)" strokeWidth={1} paintOrder="stroke" />
                    </g>
                  );
                }
                const txt = String(g.count);
                const cw = 7 + txt.length * 6;
                const ch = 11;
                const top = g.cy - ch / 2;
                const tipY = g.dir > 0 ? top : top + ch; // edge facing the line
                return (
                  <g key={`${g.i}${g.side}`}>
                    <line x1={g.cx} x2={g.cx} y1={g.ly + g.dir * 2} y2={tipY - g.dir * 2} stroke={c} strokeWidth={1} strokeOpacity={0.8} />
                    <circle cx={g.cx} cy={g.ly} r={2} fill="var(--bg-1)" stroke={c} strokeWidth={1.25} />
                    <path d={`M${g.cx - 3},${tipY}L${g.cx},${tipY - g.dir * 3}L${g.cx + 3},${tipY}Z`} fill={c} />
                    <rect
                      x={g.cx - cw / 2}
                      y={top}
                      width={cw}
                      height={ch}
                      rx={1.5}
                      fill={c}
                      stroke={active ? "var(--ink)" : "var(--bg-1)"}
                      strokeWidth={1}
                    />
                    <text x={g.cx} y={g.cy + 0.5} textAnchor="middle" dominantBaseline="central" fontSize={9} fontWeight={700} fill="#000">
                      {txt}
                    </text>
                  </g>
                );
              })}
            </g>

            {/* last-value connectors (to the tag) */}
            {tags.map((t, k) =>
              t.px != null ? (
                <line key={`lv${k}`} x1={t.px} x2={geo.tagX} y1={t.y} y2={t.y} stroke={t.bg} strokeOpacity={0.55} strokeDasharray="1 2" />
              ) : null,
            )}
            {series.map((s) => {
              if (s.tag === false) return null;
              const i = lastIdx(s.data);
              if (i < 0) return null;
              return <circle key={`ld${s.id}`} cx={geo.x(i)} cy={geo.y(s.data[i] as number)} r={2.2} fill={s.color} />;
            })}

            {/* extremes */}
            {paths.ext &&
              (["hi", "lo"] as const).map((kk) => {
                const [i, v] = paths.ext![kk];
                const xx = geo.x(i);
                const yy = geo.y(v);
                const anchor = xx > geo.xr - 70 ? "end" : xx < geo.x0 + 50 ? "start" : "middle";
                return (
                  <g key={kk} fontSize={9.5}>
                    <line x1={xx} x2={xx} y1={yy} y2={kk === "hi" ? yy - 4 : yy + 4} stroke="var(--ink-3)" />
                    <text
                      x={xx}
                      y={kk === "hi" ? yy - 7 : yy + 14}
                      textAnchor={anchor}
                      fill="var(--ink-2)"
                      stroke="var(--bg-1)"
                      strokeWidth={3}
                      paintOrder="stroke"
                      strokeLinejoin="round"
                    >
                      <tspan fill="var(--ink-3)" style={{ fontFamily: SANS, fontWeight: 600 }}>
                        {kk === "hi" ? "H " : "L "}
                      </tspan>
                      {(series[0].fmt ?? vFmt)(v)}
                    </text>
                  </g>
                );
              })}

            {/* reference labels — above the data, haloed so a crossing line never obscures them */}
            <g clipPath={`url(#m${uid})`}>
              {refs.map((r, k) => {
                const yy = Math.round(geo.y(r.value)) + 0.5;
                return (
                  <text
                    key={k}
                    x={geo.x0 + 6}
                    y={yy - 4}
                    fontSize={9.5}
                    fill={r.color ?? "var(--ink-2)"}
                    stroke="var(--bg-1)"
                    strokeWidth={3}
                    paintOrder="stroke"
                    strokeLinejoin="round"
                    style={{ fontFamily: SANS, letterSpacing: "0.06em", fontWeight: 600 }}
                  >
                    {r.label.toUpperCase()}
                  </text>
                );
              })}
            </g>

            {/* sub-pane */}
            {sub && subGeo && paths.subP && (
              <g>
                <g shapeRendering="crispEdges">
                  {subGeo.ticks.map((t) => (
                    <line
                      key={t}
                      x1={geo.x0}
                      x2={geo.x1}
                      y1={Math.round(subGeo.y(t)) + 0.5}
                      y2={Math.round(subGeo.y(t)) + 0.5}
                      stroke={Math.abs(t) < 1e-12 ? "var(--ink-4)" : "var(--line)"}
                    />
                  ))}
                </g>
                {paths.subP.bars && (
                  <g shapeRendering="crispEdges">
                    {paths.subP.bars.map((b, k) => (
                      <rect key={k} x={b.x} y={b.y} width={paths.subP!.bw} height={b.h} fill={b.up ? "var(--up)" : "var(--down)"} fillOpacity={0.85} />
                    ))}
                  </g>
                )}
                {paths.subP.area && <path d={paths.subP.area} fill={`url(#s${uid})`} />}
                {paths.subP.d && <path d={paths.subP.d} fill="none" stroke={sub.color ?? "var(--down)"} strokeWidth={1.1} strokeLinejoin="round" />}
                <g fontSize={10} fill="var(--ink-3)">
                  {subGeo.ticks.map((t) => {
                    const yy = subGeo.y(t);
                    if (yy < geo.subTop + 4 || yy > geo.subBot - 6) return null;
                    return (
                      <text key={t} x={geo.leftV ? geo.x0 - 6 : geo.x1 + 6} textAnchor={geo.leftV ? "end" : "start"} y={yy} dominantBaseline="central">
                        {defaultTick(sub.axis ?? "pct")(t, subGeo.step)}
                      </text>
                    );
                  })}
                </g>
              </g>
            )}

            {/* end-value tags */}
            <g fontSize={10} fontWeight={600}>
              {tags.map((t, k) => (
                <g key={k}>
                  {inside && !t.outline && <path d={`M${geo.tagX - 4},${t.y}L${geo.tagX},${t.y - 4}L${geo.tagX},${t.y + 4}Z`} fill={t.bg} />}
                  <rect
                    x={geo.tagX}
                    y={Math.round(t.y - 7)}
                    width={geo.tagW}
                    height={14}
                    fill={t.bg}
                    stroke={t.outline ? t.fg : "none"}
                    strokeOpacity={0.8}
                    shapeRendering="crispEdges"
                  />
                  <text x={geo.tagX + geo.tagW / 2} y={Math.round(t.y - 7) + 7.5} textAnchor="middle" dominantBaseline="central" fill={t.fg}>
                    {t.text}
                  </text>
                </g>
              ))}
            </g>

            {/* crosshair */}
            {hover && (
              <g pointerEvents="none">
                <line
                  x1={Math.round(geo.x(hover.i)) + 0.5}
                  x2={Math.round(geo.x(hover.i)) + 0.5}
                  y1={geo.mainTop}
                  y2={geo.dateY}
                  stroke="var(--ink-3)"
                  strokeDasharray="3 3"
                  shapeRendering="crispEdges"
                />
                {hover.y != null && (
                  <>
                    <line
                      x1={geo.x0}
                      x2={geo.x1}
                      y1={Math.round(hover.y) + 0.5}
                      y2={Math.round(hover.y) + 0.5}
                      stroke="var(--ink-3)"
                      strokeDasharray="3 3"
                      shapeRendering="crispEdges"
                    />
                    <rect x={geo.x1 + 1} y={Math.round(hover.y - 7)} width={geo.axisW - 1} height={14} fill="var(--ink)" shapeRendering="crispEdges" />
                    <text x={geo.x1 + 5} y={Math.round(hover.y - 7) + 7.5} dominantBaseline="central" fontSize={10} fontWeight={600} fill="#000">
                      {vFmt(geo.yInv(hover.y))}
                    </text>
                  </>
                )}
                {series.map((s) => {
                  const v = s.data[hover.i];
                  if (!finite(v)) return null;
                  return <circle key={s.id} cx={geo.x(hover.i)} cy={geo.y(v)} r={3} fill="var(--bg)" stroke={s.color} strokeWidth={1.5} />;
                })}
                {sub && subGeo && finite(sub.data[hover.i]) && sub.kind !== "bars" && (
                  <circle cx={geo.x(hover.i)} cy={subGeo.y(sub.data[hover.i] as number)} r={2.5} fill="var(--bg)" stroke={sub.color ?? "var(--down)"} strokeWidth={1.25} />
                )}
                {(() => {
                  const label = fmtLegendDate(ds[hover.i]).slice(4);
                  const tw = label.length * CHAR_W + 10;
                  const cx = Math.max(geo.x0 + tw / 2, Math.min(geo.x1 - tw / 2, geo.x(hover.i)));
                  return (
                    <g>
                      <rect x={Math.round(cx - tw / 2)} y={geo.dateY + 1} width={Math.round(tw)} height={15} fill="var(--ink)" shapeRendering="crispEdges" />
                      <text x={cx} y={geo.dateY + 9} textAnchor="middle" dominantBaseline="central" fontSize={10} fontWeight={600} fill="#000">
                        {label}
                      </text>
                    </g>
                  );
                })()}
              </g>
            )}

            {/* hit area */}
            <rect
              x={geo.x0}
              y={geo.mainTop}
              width={geo.x1 - geo.x0}
              height={geo.dateY - geo.mainTop}
              fill="transparent"
              style={{ cursor: "crosshair" }}
              onPointerMove={onMove}
              onPointerDown={onMove}
              onPointerLeave={onLeave}
            />
          </svg>

          {/* key (markers / shading) — in the main pane, top-left */}
          {keys.length > 0 && (
            <div
              style={{
                position: "absolute",
                left: geo.x0 + 6,
                top: geo.mainTop + 5,
                display: "flex",
                gap: 10,
                alignItems: "center",
                padding: "2px 6px",
                background: "rgba(7, 9, 12, 0.82)",
                border: "1px solid var(--line)",
                pointerEvents: "none",
                whiteSpace: "nowrap",
              }}
            >
              {keys.map((k) => (
                <span key={k.label} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--ink-2)" }}>
                  <KeyGlyph k={k} />
                  {k.label}
                </span>
              ))}
            </div>
          )}

          {/* caption strip: sub-pane caption, off the data */}
          {sub && (
            <div
              style={{
                position: "absolute",
                left: geo.x0 + 6,
                width: geo.x1 - geo.x0 - 12,
                top: geo.capTop + 1,
                height: capH - 1,
                display: "flex",
                alignItems: "center",
                gap: 6,
                pointerEvents: "none",
                whiteSpace: "nowrap",
                overflow: "hidden",
              }}
            >
              <span className="label" style={{ fontSize: 9, color: "var(--ink-3)" }}>
                {sub.label}
              </span>
              {finite(sub.data[at]) && (
                <span
                  className="num"
                  style={{
                    color: sub.kind === "bars" ? ((sub.data[at] as number) >= 0 ? "var(--up)" : "var(--down)") : (sub.color ?? "var(--down)"),
                    fontSize: 10,
                  }}
                >
                  {(sub.fmt ?? defaultFmt(sub.axis ?? "pct"))(sub.data[at] as number)}
                </span>
              )}
              {hover && (
                <span className="num" style={{ fontSize: 9.5, color: "var(--ink-4)" }}>
                  {monDay(ds[at])}
                </span>
              )}
              {sub.note != null && <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--ink-3)", overflow: "hidden", textOverflow: "ellipsis" }}>{sub.note}</span>}
            </div>
          )}

          {/* legend box */}
          {showLegend && (
            <Legend
              date={ds[at]}
              live={!hover}
              place={
                legendBox
                  ? {
                      left: legendBox.left,
                      ...(legendBox.c[0] === "t" ? { top: geo.mainTop + 6 } : { bottom: h - (geo.mainBot - 6) }),
                    }
                  : { left: geo.x0 + 6, top: geo.mainTop + 6 }
              }
              rows={series
                .filter((s) => s.legend !== false)
                .map((s) => {
                  const v = s.data[at];
                  return {
                    key: s.id,
                    label: s.label,
                    color: s.color,
                    dash: s.dash,
                    value: finite(v) ? (s.fmt ?? vFmt)(v) : "—",
                    tone: kind === "pct" && finite(v) ? (v > 0 ? "var(--up)" : v < 0 ? "var(--down)" : "var(--ink)") : "var(--ink)",
                  };
                })}
              extra={legendExtra?.(at) ?? []}
              events={markersAt.get(at) ?? []}
            />
          )}
        </>
      ) : null}
    </div>
  );
}

export function KeyGlyph({ k }: { k: TSKey }) {
  return (
    <svg width={10} height={10} aria-hidden="true">
      {k.glyph === "chip" ? (
        <>
          <rect x={0} y={1} width={10} height={8} rx={1.5} fill={k.color} />
          <text x={5} y={5.5} textAnchor="middle" dominantBaseline="central" fontSize={7} fontWeight={700} fill="#000">
            {k.text ?? "n"}
          </text>
        </>
      ) : k.glyph === "buy" || k.glyph === "sell" ? (
        <path d={tri(5, 5, k.glyph === "buy", 3.6)} fill={k.color} />
      ) : k.glyph === "box" ? (
        <rect x={0} y={0.5} width={10} height={9} fill={k.color} fillOpacity={k.opacity ?? 0.35} />
      ) : (
        <line x1={0} x2={10} y1={5} y2={5} stroke={k.color} strokeWidth={2} />
      )}
    </svg>
  );
}

function Legend({
  date,
  live,
  place,
  rows,
  extra,
  events,
}: {
  date: DP;
  live: boolean;
  place: CSSProperties;
  rows: { key: string; label: string; color: string; dash?: string; value: string; tone: string }[];
  extra: TSLegendExtra[];
  events: TSMarker[];
}) {
  const shown = events.slice(0, 4);
  const multiDay = new Set(events.map((e) => e.i)).size > 1;
  return (
    <div
      style={{
        position: "absolute",
        ...place,
        width: 196,
        pointerEvents: "none",
        background: "rgba(5, 7, 10, 0.92)",
        border: "1px solid var(--line-2)",
        padding: "3px 7px 4px",
        backdropFilter: "blur(2px)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, borderBottom: "1px solid var(--line)", paddingBottom: 2, marginBottom: 2 }}>
        <span className="label" style={{ fontSize: 9, color: live ? "var(--amber)" : "var(--ink-2)" }}>
          {live ? "Last" : "Cursor"}
        </span>
        <span className="num" style={{ fontSize: 10, color: "var(--ink-2)" }}>
          {fmtLegendDate(date)}
        </span>
      </div>
      {rows.map((r) => (
        <div key={r.key} style={{ display: "grid", gridTemplateColumns: "12px 1fr auto", alignItems: "center", gap: 6, height: 15 }}>
          <svg width={12} height={4} aria-hidden="true">
            <line x1={0} x2={12} y1={2} y2={2} stroke={r.color} strokeWidth={2} strokeDasharray={r.dash} />
          </svg>
          <span style={{ fontSize: 10.5, color: "var(--ink-2)", whiteSpace: "nowrap" }}>{r.label}</span>
          <span className="num" style={{ fontSize: 11, color: r.tone, textAlign: "right" }}>
            {r.value}
          </span>
        </div>
      ))}
      {extra.map((r) => (
        <div key={r.label} style={{ display: "grid", gridTemplateColumns: "12px 1fr auto", alignItems: "center", gap: 6, height: 15 }}>
          <span />
          <span style={{ fontSize: 10.5, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{r.label}</span>
          <span className="num" style={{ fontSize: 11, color: r.color ?? "var(--ink)", textAlign: "right" }}>
            {r.value}
          </span>
        </div>
      ))}
      {shown.length > 0 && (
        <div style={{ borderTop: "1px solid var(--line)", marginTop: 2, paddingTop: 2 }}>
          {shown.map((e, k) => (
            <div key={k} style={{ display: "grid", gridTemplateColumns: "12px 1fr auto", alignItems: "center", gap: 6, height: 15 }}>
              <svg width={12} height={10} aria-hidden="true">
                <path d={tri(6, 5, e.side === "buy", 3.6)} fill={e.side === "buy" ? "var(--up)" : "var(--down)"} />
              </svg>
              <span className="num" style={{ fontSize: 10.5, color: "var(--ink)", whiteSpace: "nowrap" }}>
                {multiDay && e.date ? <span style={{ color: "var(--ink-3)" }}>{e.date} </span> : null}
                {e.label}
              </span>
              <span className="num" style={{ fontSize: 11, color: "var(--ink-2)", textAlign: "right" }}>
                {e.value ?? ""}
              </span>
            </div>
          ))}
          {events.length > shown.length && (
            <div className="num" style={{ fontSize: 10, color: "var(--ink-3)", paddingLeft: 18 }}>
              +{events.length - shown.length} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}
