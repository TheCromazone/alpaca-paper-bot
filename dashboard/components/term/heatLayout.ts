/**
 * HEAT layout — pure functions (no React), so the rules can be tested in
 * isolation (Node strips the types: import this file directly).
 *
 * Rules, in priority order:
 *  1. Every sector is its own block (header strip + tiles); block area ∝ the
 *     sector's summed name weight.
 *  2. Name weight = cap^p. p is chosen per panel size: the steepest of
 *     0.6 → ⅓ that keeps ≤ 20 names grouped (else ⅓); the legend states it.
 *  3. Held names are never aggregated: own tile, label always fits (area
 *     raised to a legible minimum when needed — `floored`).
 *  4. Every name tile carries "TKR / ±x.x%" horizontally at ≥ 10px; names
 *     too small for that share one "N others" tile per sector (never split
 *     into look-alike twins).
 *  5. An aggregate is never the largest tile in its sector while promoting
 *     its biggest members still fits.
 */
import type { HeatCell } from "@/lib/api";

export type R = { x: number; y: number; w: number; h: number };
export type Member = { c: HeatCell; cap: number };
export type TileKind = "name" | "agg";
export type Tile = {
  kind: TileKind;
  /** Ticker for names; the aggregate's words ("15 others", "Utilities"). */
  label: string;
  members: Member[];
  cap: number;
  r: R;
  /** Sector key. */
  sector: string;
  /** Area raised to a legible minimum (held / promoted / aggregate). */
  floored: boolean;
  /** Why a name has its own tile despite its size. */
  why?: "held" | "promoted";
  /** Aggregate drawn smaller than its combined weight (never the largest tile). */
  capped?: boolean;
};
export type Block = { key: string; name: string; short: string; r: R; tiles: Tile[]; members: Member[]; cap: number };

export const OTHER = "__other";
export const HEAD = 14; // one-line sector header (10px type)
export const SGAP = 3; // gutter between sector blocks
/** px² a name needs before it is tried as its own tile. */
const AREA_MIN = 1000;
/** Smallest type on the map. */
export const FONT_MIN = 10;
/** Change-label length for fit decisions ("−4.8%"), so the layout never
 *  depends on the horizon; 10%+ moves render as whole percents if needed. */
export const PLEN = 5;

/** Sector names: spelled out (never a symbol-shaped code), long + short. */
const SECTOR_WORDS: Record<string, [string, string]> = {
  Technology: ["Technology", "Tech"],
  "Communication Services": ["Communication", "Comm."],
  "Consumer Cyclical": ["Discretionary", "Discr."],
  "Consumer Defensive": ["Staples", "Staples"],
  "Financial Services": ["Financials", "Fin."],
  Healthcare: ["Health care", "Health"],
  Industrials: ["Industrials", "Indus."],
  Energy: ["Energy", "Energy"],
  Utilities: ["Utilities", "Utils."],
  "Basic Materials": ["Materials", "Matls."],
  "Real Estate": ["Real estate", "Realty"],
  Tech: ["Technology", "Tech"],
  Consumer: ["Consumer", "Cons."],
  Financials: ["Financials", "Fin."],
  Materials: ["Materials", "Matls."],
  RealEstate: ["Real estate", "Realty"],
};
export const wordsOf = (key: string): [string, string] => SECTOR_WORDS[key] ?? [key, key];
export const groupOf = (c: HeatCell & { gics?: string | null }) => c.gics || c.sector;
/** Header needs: name + a 5-char change at 10px, one line. */
const headerW = (text: string) => text.length * 4.9 + 41;

// ── treemap ──────────────────────────────────────────────────────────────

/** Squarified treemap (Bruls, Huizing, van Wijk). Values must be > 0. */
export function squarify<T>(items: { v: number; d: T }[], rect: R, keepOrder = false): { d: T; r: R }[] {
  const out: { d: T; r: R }[] = [];
  const sorted = keepOrder ? [...items] : [...items].sort((a, b) => b.v - a.v);
  const total = sorted.reduce((a, b) => a + b.v, 0);
  if (!total || rect.w <= 0 || rect.h <= 0) return out;
  const k = (rect.w * rect.h) / total;
  const areas = sorted.map((it) => ({ a: it.v * k, d: it.d }));
  let { x, y, w, h } = rect;
  const worst = (row: { a: number }[], side: number) => {
    let sum = 0;
    let mx = 0;
    let mn = Infinity;
    for (const r of row) {
      sum += r.a;
      mx = Math.max(mx, r.a);
      mn = Math.min(mn, r.a);
    }
    return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
  };
  const lay = (row: { a: number; d: T }[]) => {
    const sum = row.reduce((a, b) => a + b.a, 0);
    if (w >= h) {
      const cw = sum / h;
      let yy = y;
      for (const r of row) {
        const hh = r.a / cw;
        out.push({ d: r.d, r: { x, y: yy, w: cw, h: hh } });
        yy += hh;
      }
      x += cw;
      w -= cw;
    } else {
      const rh = sum / w;
      let xx = x;
      for (const r of row) {
        const ww = r.a / rh;
        out.push({ d: r.d, r: { x: xx, y, w: ww, h: rh } });
        xx += ww;
      }
      y += rh;
      h -= rh;
    }
  };
  let row: { a: number; d: T }[] = [];
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    const cand = [...row, areas[i]];
    if (!row.length || worst(row, side) >= worst(cand, side)) {
      row = cand;
      i++;
    } else {
      lay(row);
      row = [];
    }
  }
  if (row.length) lay(row);
  return out;
}

/** Proportional rows treemap: n rows, row height ∝ row weight, tiles in a
 *  row ∝ their weight (largest-first into the lightest row). */
export function rows<T>(items: { v: number; d: T }[], rect: R, n: number): { d: T; r: R }[] {
  const sorted = [...items].sort((a, b) => b.v - a.v);
  const k = Math.max(1, Math.min(n, sorted.length));
  const bins: { v: number; d: T }[][] = Array.from({ length: k }, () => []);
  const load = new Array(k).fill(0);
  for (const it of sorted) {
    let j = 0;
    for (let i = 1; i < k; i++) if (load[i] < load[j]) j = i;
    bins[j].push(it);
    load[j] += it.v;
  }
  const total = load.reduce((a, b) => a + b, 0) || 1;
  const out: { d: T; r: R }[] = [];
  let y = rect.y;
  bins
    .map((b, i) => ({ b, v: load[i] }))
    .sort((a, b) => b.v - a.v)
    .forEach(({ b, v }) => {
      const h = (rect.h * v) / total;
      let x = rect.x;
      for (const it of b) {
        const w = (rect.w * it.v) / v;
        out.push({ d: it.d, r: { x, y, w, h } });
        x += w;
      }
      y += h;
    });
  return out;
}

export const snap = (r: R, gap: number): R => {
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  return { x, y, w: Math.round(r.x + r.w) - x - gap, h: Math.round(r.y + r.h) - y - gap };
};

// ── label fitting ────────────────────────────────────────────────────────

export type Fit = { tk: number; pc: number };

/** Ticker over change, both ≥ 10px, horizontal — or no fit (no slivers). */
export function fitLabel(w: number, h: number, len: number, plen = PLEN): Fit | null {
  if (w < 34 || h < 26) return null;
  const tkW = (w - 4) / (len * 0.61);
  const pcW = (w - 4) / (plen * 0.6);
  const budget = h - 5;
  const tk = Math.min(19, tkW, budget * 0.56);
  const pc = Math.min(13, pcW, budget - tk, Math.max(FONT_MIN, tk * 0.78));
  return tk >= FONT_MIN && pc >= FONT_MIN ? { tk, pc } : null;
}

/** Aggregate label: one small-caps line ("15 others") or stacked words
 *  ("15 / others", "Real / estate"), over a small change. */
export type AggFit = "line" | "stack";
export function aggFit(w: number, h: number, label: string): AggFit | null {
  // 10px small caps ≈ 5.5px/char; change line 10px mono below.
  // The change line ("−1.4%", 10px mono) needs 34px too.
  if (w >= Math.max(label.length * 5.5 + 7, 34) && h >= 26) return "line";
  const words = label.split(" ");
  const longest = Math.max(...words.map((x) => x.length));
  if (words.length > 1 && w >= Math.max(longest * 5.5 + 7, 34) && h >= 12 * words.length + 14) return "stack";
  return null;
}
/** First label variant that fits, or null. */
export const pickAgg = (w: number, h: number, labels: string[]) => labels.find((l) => aggFit(w, h, l) != null) ?? null;

// ── one block ────────────────────────────────────────────────────────────

type U = { id: string; kind: TileKind; members: Member[]; labels: string[]; floor: number; why?: "held" | "promoted" };
type Cand = { placed: { d: U; r: R }[]; score: number; shown: number; hard: number };

/** Floors (px²) tried for names that need one (held / promoted). */
const FLOORS = [AREA_MIN, 1150, 1350, 1600, 1950, 2300, 2700];
/** Floor for an aggregate whose true area is too small for its label. */
const AGG_FLOOR = 50 * 30;
/** Max share of the block the (non-held) floors may add on top of true area. */
const MAX_INFLATION = 0.3;
/** Held tiles keep 3px clear of their 2px outline. */
const HELD_PAD = 4;

/**
 * Search: which names get their own tile (held + the top-k by weight) and
 * how big the floors are, over a few layout variants; every layout is
 * scored against the rules and the best wins.
 */
export function layoutBlock(members: Member[], inner: R, block: string, exp = 1): { tiles: Tile[]; hard: number } {
  const wt = (m: Member) => Math.pow(m.cap, exp);
  const sorted = [...members].sort((a, b) => b.cap - a.cap);
  const total = sorted.reduce((a, m) => a + wt(m), 0);
  const area = inner.w * inner.h;
  const pxPerW = area / Math.max(1e-9, total);
  const trueArea = (m: Member) => wt(m) * pxPerW;
  const held = sorted.filter((m) => m.c.held);
  const free = sorted.filter((m) => !m.c.held);

  type Variant = { order: "sorted" | "aggLast" | "strip" | "rows"; transpose: boolean; n?: number };
  const VARIANTS: Variant[] = [
    { order: "sorted", transpose: false },
    { order: "aggLast", transpose: false },
    { order: "strip", transpose: false },
    { order: "sorted", transpose: true },
    { order: "strip", transpose: true },
    ...[1, 2, 3, 4].flatMap((n) => [
      { order: "rows" as const, transpose: false, n },
      { order: "rows" as const, transpose: true, n },
    ]),
  ];
  const run = (units: U[], vr: Variant) => {
    const items = units.map((u) => ({ v: Math.max(u.members.reduce((a, m) => a + wt(m), 0), u.floor / pxPerW), d: u }));
    // Rule 5: a bucket is never drawn larger than 90% of the largest name.
    const maxNameV = Math.max(0, ...items.filter((i) => i.d.kind === "name").map((i) => i.v));
    if (maxNameV > 0) for (const i of items) if (i.d.kind === "agg" && i.v > maxNameV * 0.9) i.v = Math.max(maxNameV * 0.9, i.d.floor / pxPerW);
    const byV = (a: { v: number }, b: { v: number }) => b.v - a.v;
    const nm = items.filter((i) => i.d.kind === "name").sort(byV);
    const ag = items.filter((i) => i.d.kind === "agg").sort(byV);
    const rect: R = vr.transpose ? { x: inner.y, y: inner.x, w: inner.h, h: inner.w } : inner;
    let out: { d: U; r: R }[];
    if (vr.order === "rows") {
      out = rows(items, rect, vr.n ?? 2);
    } else if (vr.order === "strip" && ag.length && nm.length) {
      const tot = items.reduce((a, i) => a + i.v, 0);
      const sh = rect.h * (ag.reduce((a, i) => a + i.v, 0) / tot);
      out = [
        ...squarify(nm, { x: rect.x, y: rect.y, w: rect.w, h: rect.h - sh }),
        ...squarify(ag, { x: rect.x, y: rect.y + rect.h - sh, w: rect.w, h: sh }),
      ];
    } else {
      out = squarify(vr.order === "aggLast" ? [...nm, ...ag] : [...items].sort(byV), rect, true);
    }
    return out.map(({ d, r }) => ({ d, r: snap(vr.transpose ? { x: r.y, y: r.x, w: r.h, h: r.w } : r, 1) }));
  };
  const nameFits = (p: { d: U; r: R }) => {
    const pad = p.d.why === "held" || p.d.members[0].c.held ? HELD_PAD : 0;
    return fitLabel(p.r.w - pad, p.r.h - pad, p.d.labels[0].length) != null;
  };

  const evaluate = (k: number, F: number, vr: Variant): Cand | null => {
    const top = free.slice(0, k);
    const shownSet = new Set([...held, ...top].map((m) => m.c.ticker));
    const rest = sorted.filter((m) => !shownSet.has(m.c.ticker));
    if (rest.length === 1) return null; // a one-name remainder is just that name
    const units: U[] = [];
    for (const m of sorted) {
      if (!shownSet.has(m.c.ticker)) continue;
      const needs = trueArea(m) < F;
      units.push({ id: m.c.ticker, kind: "name", members: [m], labels: [m.c.ticker], floor: needs ? F : 0, why: m.c.held ? "held" : needs ? "promoted" : undefined });
    }
    if (rest.length) {
      // A bucket holding the whole sector is just "N names".
      const whole = rest.length === sorted.length;
      const u: U = { id: "agg", kind: "agg", members: rest, labels: whole ? [`${rest.length} names`] : [`${rest.length} others`, `${rest.length} more`], floor: 0 };
      if (rest.reduce((a, m) => a + trueArea(m), 0) < AGG_FLOOR) u.floor = AGG_FLOOR;
      units.push(u);
    }
    let extra = 0;
    let capped = 0;
    for (const u of units) {
      const x = Math.max(0, u.floor - u.members.reduce((a, m) => a + trueArea(m), 0));
      extra += x;
      if (u.why !== "held") capped += x;
    }
    if (capped / area > MAX_INFLATION || extra / area > 0.6) return null;
    const placed = run(units, vr);
    let score = 0;
    let hard = 0;
    const names = placed.filter((p) => p.d.kind === "name");
    const aggs = placed.filter((p) => p.d.kind === "agg");
    for (const p of names)
      if (!nameFits(p)) {
        score += p.d.why === "held" ? 1000 : 200;
        hard++;
      }
    for (const p of aggs)
      if (!pickAgg(p.r.w, p.r.h, p.d.labels)) {
        score += 200;
        hard++;
      }
    const maxName = Math.max(0, ...names.map((p) => p.r.w * p.r.h));
    for (const p of aggs) if (p.r.w * p.r.h >= maxName && names.length) score += 25; // soft: rule 5
    score += (extra / area) * 60;
    score += names.filter((p) => p.d.why === "promoted").length * 1.5;
    score -= names.filter((p) => !p.d.why).length * 3;
    for (const p of aggs) for (const m of p.d.members) if (trueArea(m) >= AREA_MIN) score += 30 + 10 * (trueArea(m) / AREA_MIN);
    // Fewer hidden names is the point of the map.
    for (const p of aggs) score += p.d.members.length * 7;
    return { placed, score, shown: names.length, hard };
  };

  let best: Cand | null = null;
  const better = (a: Cand, b: Cand | null) => !b || a.score < b.score - 1e-9 || (Math.abs(a.score - b.score) < 1e-9 && a.shown > b.shown);
  for (let k = 0; k <= free.length; k++)
    for (const F of FLOORS)
      for (const vr of VARIANTS) {
        const c = evaluate(k, F, vr);
        if (c && better(c, best)) best = c;
      }
  if (!best) return { tiles: [], hard: 99 };
  const tiles = best.placed.map(({ d, r }) => ({
    kind: d.kind,
    label: d.kind === "agg" ? (pickAgg(r.w, r.h, d.labels) ?? d.labels[d.labels.length - 1]) : d.labels[0],
    members: d.members,
    cap: d.members.reduce((a, m) => a + m.cap, 0),
    r,
    sector: block,
    floored: d.floor > 0 && d.floor > d.members.reduce((a, m) => a + trueArea(m), 0),
    why: d.why,
    capped: d.kind === "agg" && best!.placed.some((p) => p.d.kind === "name") && r.w * r.h < d.members.reduce((a, m) => a + trueArea(m), 0) * 0.92,
  }));
  return { tiles, hard: best.hard };
}

// ── blocks ───────────────────────────────────────────────────────────────

/** Place sector blocks so each block's tile area (minus header) ∝ its weight —
 *  raised to `min` px² where a sector needs room for its held names. */
function solveBlocks(secs0: { key: string; cap: number; min?: number }[], W: number, H: number) {
  const usable = W * H * 0.86;
  let secs = secs0;
  for (let i = 0; i < 3; i++) {
    const tw = secs.reduce((a, x) => a + x.cap, 0);
    secs = secs.map((x) => ({ ...x, cap: Math.max(x.cap, ((x.min ?? 0) / usable) * tw) }));
  }
  const total = secs.reduce((a, x) => a + x.cap, 0);
  const area = W * H;
  const wts = new Map(secs.map((x) => [x.key, (x.cap / total) * area * 0.88 + HEAD * Math.sqrt((x.cap / total) * area) * 1.1]));
  let placed: { d: { key: string; cap: number }; r: R }[] = [];
  for (let iter = 0; iter < 8; iter++) {
    placed = squarify(secs.map((x) => ({ v: wts.get(x.key)!, d: x })), { x: 0, y: 0, w: W + SGAP, h: H + SGAP });
    const inner = placed.map(({ d, r }) => ({ key: d.key, cap: d.cap, I: Math.max(1, (r.w - SGAP) * (r.h - SGAP - HEAD)) }));
    const Isum = inner.reduce((a, x) => a + x.I, 0);
    let worst = 0;
    for (const x of inner) {
      const ratio = x.cap / total / (x.I / Isum);
      worst = Math.max(worst, Math.abs(ratio - 1));
      wts.set(x.key, wts.get(x.key)! * Math.pow(ratio, 0.9));
    }
    if (worst < 0.01) break;
  }
  return placed;
}

/** One full layout at a given area exponent. */
function layoutAt(by: Map<string, Member[]>, W: number, H: number, exp: number): { blocks: Block[]; grouped: number; hard: number } {
  const wOf = (key: string) => (by.get(key) ?? []).reduce((a, m) => a + Math.pow(m.cap, exp), 0);
  const capOf = (key: string) => (by.get(key) ?? []).reduce((a, m) => a + m.cap, 0);
  // Held names need a legible tile each, plus room for the rest's bucket.
  const minOf = (key: string) => {
    const ms = by.get(key) ?? [];
    const h = ms.filter((m) => m.c.held).length;
    return h ? h * 2200 + (ms.length > h ? 1900 : 0) : 0;
  };
  const secs = [...by.keys()].map((key) => ({ key, cap: wOf(key), min: minOf(key) }));
  const placed = solveBlocks(secs, W, H);
  let grouped = 0;
  let hard = 0;
  const blocks = placed.map(({ d, r }) => {
    const br = snap(r, SGAP);
    const inner: R = { x: 0, y: HEAD, w: br.w + 1, h: br.h - HEAD + 1 };
    const members = by.get(d.key)!;
    const [name, short] = wordsOf(d.key);
    const res = layoutBlock(members, inner, d.key, exp);
    grouped += res.tiles.filter((t) => t.kind === "agg").reduce((a, t) => a + t.members.length, 0);
    hard += res.hard;
    return { key: d.key, name, short, r: br, tiles: res.tiles, members, cap: capOf(d.key) };
  });
  return { blocks, grouped, hard };
}

/** Area exponents tried, steepest (most cap-faithful) first. */
export const EXPONENTS = [0.6, 0.5, 0.4, 1 / 3];

export function layout(cells: HeatCell[], W: number, H: number): { blocks: Block[]; exp: number; grouped: number } {
  const by = new Map<string, Member[]>();
  // Unknown caps take the sector median so a missing number never hides a name.
  const raw = new Map<string, HeatCell[]>();
  for (const c of cells) raw.set(groupOf(c), [...(raw.get(groupOf(c)) ?? []), c]);
  for (const [key, list] of raw) {
    const known = list.map((c) => c.mcap ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
    const med = known.length ? known[Math.floor(known.length / 2)] : 1;
    by.set(key, list.map((c) => ({ c, cap: c.mcap && c.mcap > 0 ? c.mcap : med })));
  }
  // Steepest exponent that keeps ≤ 20 names grouped with no defects; else
  // the one with the fewest (grouped + defects), steeper on ties.
  let best: { blocks: Block[]; grouped: number; hard: number; exp: number } | null = null;
  for (const exp of EXPONENTS) {
    const res = { ...layoutAt(by, W, H, exp), exp };
    if (res.grouped <= 20 && res.hard === 0) return res;
    if (!best || res.grouped + 5 * res.hard < best.grouped + 5 * best.hard) best = res;
  }
  return { blocks: best!.blocks, exp: best!.exp, grouped: best!.grouped };
}

/** Header text that fits a block width; null avg when even that won't fit. */
export const headerText = (b: Block) => (b.r.w >= headerW(b.name) ? b.name : b.short);
export const headerHasAvg = (b: Block) => b.r.w >= headerW(b.short);
