/**
 * HEAT layout — pure functions (no React), so the rules can be tested in
 * isolation (Node strips the types: import this file directly).
 *
 * Rules, in priority order:
 *  1. Sector blocks: area ∝ sector market cap (header strip excluded).
 *     Sectors too small to hold a one-line header share an OTHER block.
 *  2. Held names are never aggregated: own tile, label always fits (their
 *     area is raised to a legible minimum when needed — `floored`).
 *  3. Every name tile carries "TKR / ±x.x%" horizontally at ≥ 10px; names
 *     too small for that share a neutral aggregate ("N others"; in OTHER,
 *     each small sector's remainder, spelled out: "Industrials").
 *  4. In a real sector an aggregate is never the largest tile: its biggest
 *     members are promoted out (floored to a legible size) while space
 *     allows, otherwise the remainder is split into balanced aggregates.
 *  5. Everything else: area = market cap, squarified.
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
  /** Sector key, or OTHER. */
  sector: string;
  /** Area raised to a legible minimum (held / promoted / aggregate). */
  floored: boolean;
  /** Why a name has its own tile despite its size. */
  why?: "held" | "promoted";
};
export type Block = { key: string; name: string; short: string; r: R; tiles: Tile[]; members: Member[]; cap: number };

export const OTHER = "__other";
export const HEAD = 15; // one-line sector header (10px type)
export const SGAP = 3; // gutter between sector blocks
const BLOCK_MIN_H = HEAD + 28;
/** px² a name needs before it is tried as its own tile. */
const AREA_MIN = 1150;
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
  "Real Estate": ["Real estate", "RE"],
  Tech: ["Technology", "Tech"],
  Consumer: ["Consumer", "Cons."],
  Financials: ["Financials", "Fin."],
  Materials: ["Materials", "Matls."],
  RealEstate: ["Real estate", "RE"],
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
  if (w >= label.length * 5.5 + 7 && h >= 26) return "line";
  const words = label.split(" ");
  const longest = Math.max(...words.map((x) => x.length));
  if (words.length > 1 && w >= longest * 5.5 + 7 && h >= 12 * words.length + 14) return "stack";
  return null;
}
/** First label variant that fits, or null. */
export const pickAgg = (w: number, h: number, labels: string[]) => labels.find((l) => aggFit(w, h, l) != null) ?? null;

// ── one block ────────────────────────────────────────────────────────────

type U = { id: string; kind: TileKind; members: Member[]; labels: string[]; floor: number; why?: "held" | "promoted" };
type Cand = { placed: { d: U; r: R }[]; score: number; shown: number; hard: number };

/** Floors (px²) tried for names that need one (held / promoted). */
const FLOORS = [AREA_MIN, 1400, 1750, 2200];
/** Floor for an aggregate whose true area is too small for its label. */
const AGG_FLOOR = 46 * 34;
/** Max share of the block the floors may add on top of true area. */
const MAX_INFLATION = 0.22;

/** Balanced split of a remainder into k tiles (largest into the lightest). */
function split(ms: Member[], k: number): Member[][] {
  const bins: Member[][] = Array.from({ length: k }, () => []);
  const ld = new Array(k).fill(0);
  for (const m of ms) {
    let j = 0;
    for (let i = 1; i < k; i++) if (ld[i] < ld[j]) j = i;
    bins[j].push(m);
    ld[j] += m.cap;
  }
  return bins.filter((b) => b.length);
}

/**
 * Search: which names get their own tile (held + the top-k by cap), how the
 * remainder is split, and how big the floors are. Every layout is scored
 * against the rules; the best valid one (most names shown) wins, else the
 * one with the cheapest violations.
 */
export function layoutBlock(members: Member[], inner: R, block: string): { tiles: Tile[]; hard: number } {
  const sorted = [...members].sort((a, b) => b.cap - a.cap);
  const total = sorted.reduce((a, m) => a + m.cap, 0);
  const area = inner.w * inner.h;
  const pxPerCap = area / Math.max(1, total);
  const isOther = block === OTHER;
  const trueArea = (m: Member) => m.cap * pxPerCap;
  const sectorOf = (m: Member) => groupOf(m.c);
  const held = sorted.filter((m) => m.c.held);
  const free = sorted.filter((m) => !m.c.held);

  /** Layout variants: squarify order (aggregates sorted in / first / last)
   *  and orientation (transposed), for better-shaped label tiles. */
  type Variant = { order: "sorted" | "aggFirst" | "aggLast" | "strip"; transpose: boolean };
  const VARIANTS: Variant[] = [
    { order: "sorted", transpose: false },
    { order: "aggLast", transpose: false },
    { order: "aggFirst", transpose: false },
    { order: "strip", transpose: false },
    { order: "sorted", transpose: true },
    { order: "aggLast", transpose: true },
    { order: "strip", transpose: true },
  ];
  const run = (units: U[], vr: Variant) => {
    const items = units.map((u) => ({ v: Math.max(u.members.reduce((a, m) => a + m.cap, 0), u.floor / pxPerCap), d: u }));
    const byV = (a: { v: number }, b: { v: number }) => b.v - a.v;
    const nm = items.filter((i) => i.d.kind === "name").sort(byV);
    const ag = items.filter((i) => i.d.kind === "agg").sort(byV);
    const rect: R = vr.transpose ? { x: inner.y, y: inner.x, w: inner.h, h: inner.w } : inner;
    let out: { d: U; r: R }[];
    if (vr.order === "strip" && ag.length && nm.length) {
      // Aggregates get a full-width strip along the bottom of the block.
      const tot = items.reduce((a, i) => a + i.v, 0);
      const share = ag.reduce((a, i) => a + i.v, 0) / tot;
      const sh = rect.h * share;
      out = [
        ...squarify(nm, { x: rect.x, y: rect.y, w: rect.w, h: rect.h - sh }),
        ...squarify(ag, { x: rect.x, y: rect.y + rect.h - sh, w: rect.w, h: sh }),
      ];
    } else {
      const ordered = vr.order === "aggFirst" ? [...ag, ...nm] : vr.order === "aggLast" ? [...nm, ...ag] : [...items].sort(byV);
      out = squarify(ordered, rect, true);
    }
    return out.map(({ d, r }) => ({ d, r: snap(vr.transpose ? { x: r.y, y: r.x, w: r.h, h: r.w } : r, 1) }));
  };

  const evaluate = (k: number, chunks: number, F: number, merge: number, vr: Variant): Cand | null => {
    const top = free.slice(0, k);
    const shownSet = new Set([...held, ...top].map((m) => m.c.ticker));
    const rest = sorted.filter((m) => !shownSet.has(m.c.ticker));
    if (!isOther && rest.length === 1) return null; // a one-name remainder is just that name
    const units: U[] = [];
    for (const m of sorted) {
      if (!shownSet.has(m.c.ticker)) continue;
      const needs = trueArea(m) < F;
      units.push({
        id: m.c.ticker,
        kind: "name",
        members: [m],
        labels: [m.c.ticker],
        floor: needs ? F : 0,
        why: m.c.held ? "held" : needs ? "promoted" : undefined,
      });
    }
    if (!isOther) {
      if (rest.length) {
        const k2 = Math.max(1, Math.min(chunks, Math.floor(rest.length / 2)));
        if (k2 !== chunks && chunks > 1) return null;
        // Split only when one remainder would out-size the largest name (rule 4).
        if (chunks > 1) {
          const restA = rest.reduce((a, m) => a + trueArea(m), 0);
          const maxA = Math.max(0, ...sorted.filter((m) => shownSet.has(m.c.ticker)).map(trueArea));
          if (restA / (chunks - 1) < maxA * 0.95) return null;
        }
        split(rest, k2).forEach((b, i) =>
          units.push({ id: `agg:${i}`, kind: "agg", members: b, labels: [`${b.length} others`, `${b.length} more`], floor: 0 }),
        );
      }
    } else {
      const bySec = new Map<string, Member[]>();
      for (const m of rest) bySec.set(sectorOf(m), [...(bySec.get(sectorOf(m)) ?? []), m]);
      const secs = [...bySec.entries()].sort((a, b) => a[1].reduce((x, m) => x + m.cap, 0) - b[1].reduce((x, m) => x + m.cap, 0));
      if (merge > secs.length || merge === 1) return null;
      const merged = secs.slice(0, merge).flatMap(([, ms]) => ms);
      if (merged.length) units.push({ id: "agg:merge", kind: "agg", members: merged, labels: [`${merge} sectors`], floor: 0 });
      for (const [key, ms] of secs.slice(merge)) units.push({ id: `agg:${key}`, kind: "agg", members: ms, labels: [wordsOf(key)[0]], floor: 0 });
    }
    // Aggregates too small for their label get a label-sized floor.
    for (const u of units) if (u.kind === "agg" && u.members.reduce((a, m) => a + trueArea(m), 0) < AGG_FLOOR) u.floor = AGG_FLOOR;
    let extra = 0;
    let capped = 0; // held floors are a rule, so only the others are capped
    for (const u of units) {
      const x = Math.max(0, u.floor - u.members.reduce((a, m) => a + trueArea(m), 0));
      extra += x;
      if (u.why !== "held") capped += x;
    }
    if (capped / area > MAX_INFLATION || extra / area > 0.6) return null;
    const placed = run(units, vr);
    // ── score: hard violations, then honesty, then coverage ──
    let score = 0;
    let hard = 0;
    const names = placed.filter((p) => p.d.kind === "name");
    const aggs = placed.filter((p) => p.d.kind === "agg");
    for (const p of names)
      if (!fitLabel(p.r.w, p.r.h, p.d.labels[0].length)) {
        score += p.d.why === "held" ? 1000 : 120;
        hard++;
      }
    for (const p of aggs)
      if (!pickAgg(p.r.w, p.r.h, p.d.labels)) {
        score += 60;
        hard++;
      }
    if (!isOther) {
      const maxName = Math.max(0, ...names.map((p) => p.r.w * p.r.h));
      for (const p of aggs)
        if (p.r.w * p.r.h >= maxName) {
          score += 80;
          hard++;
        }
    }
    score += (extra / area) * 60; // area = cap: floors cost
    score += names.filter((p) => p.d.why === "promoted").length * 4;
    score += (chunks - 1) * 3 + merge * 8;
    score -= names.filter((p) => !p.d.why).length * 3; // names shown at true size
    // Hiding a name that is big enough for its own tile is expensive.
    for (const p of aggs) for (const m of p.d.members) if (trueArea(m) >= AREA_MIN) score += 30 + 10 * (trueArea(m) / AREA_MIN);
    return { placed, score, shown: names.length, hard };
  };

  let best: Cand | null = null;
  const better = (a: Cand, b: Cand | null) => !b || a.score < b.score - 1e-9 || (Math.abs(a.score - b.score) < 1e-9 && a.shown > b.shown);
  for (let k = 0; k <= free.length; k++) {
    for (const F of FLOORS) {
      for (let chunks = 1; chunks <= (isOther ? 1 : 4); chunks++) {
        for (let merge = 0; merge <= (isOther ? 6 : 0); merge++) {
          for (const vr of VARIANTS) {
            const c = evaluate(k, chunks, F, merge, vr);
            if (c && better(c, best)) best = c;
          }
        }
      }
    }
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
  }));
  return { tiles, hard: best.hard };
}

// ── blocks ───────────────────────────────────────────────────────────────

/** Place sector blocks so each block's tile area (minus header) ∝ its cap. */
function solveBlocks(secs: { key: string; cap: number }[], W: number, H: number) {
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

export function layout(cells: HeatCell[], W: number, H: number): Block[] {
  const by = new Map<string, Member[]>();
  // Unknown caps take the sector median so a missing number never hides a name.
  const raw = new Map<string, HeatCell[]>();
  for (const c of cells) raw.set(groupOf(c), [...(raw.get(groupOf(c)) ?? []), c]);
  for (const [key, list] of raw) {
    const known = list.map((c) => c.mcap ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
    const med = known.length ? known[Math.floor(known.length / 2)] : 1;
    by.set(key, list.map((c) => ({ c, cap: c.mcap && c.mcap > 0 ? c.mcap : med })));
  }
  const capOf = (key: string) => (by.get(key) ?? []).reduce((a, m) => a + m.cap, 0);

  // Sectors whose block can't hold a one-line header — or whose best tile
  // layout still breaks a rule — move to OTHER (smallest first) until every
  // remaining sector block is clean. The five largest sectors never move.
  const keys = [...by.keys()].sort((a, b) => capOf(b) - capOf(a));
  const small = new Set<string>();
  let out: Block[] = [];
  for (let guard = 0; guard <= keys.length; guard++) {
    const secs = keys.filter((k) => !small.has(k)).map((key) => ({ key, cap: capOf(key) }));
    if (small.size) secs.push({ key: OTHER, cap: [...small].reduce((a, x) => a + capOf(x), 0) });
    const placed = solveBlocks(secs, W, H);
    const headFail = placed.filter((p) => p.d.key !== OTHER && (p.r.w - SGAP < headerW(wordsOf(p.d.key)[1]) || p.r.h - SGAP < BLOCK_MIN_H));
    if (headFail.length) {
      small.add(headFail.sort((a, b) => a.d.cap - b.d.cap)[0].d.key);
      continue;
    }
    const hardBy = new Map<string, number>();
    out = placed.map(({ d, r }) => {
      const br = snap(r, SGAP);
      const inner: R = { x: 0, y: HEAD, w: br.w + 1, h: br.h - HEAD + 1 };
      if (d.key === OTHER) {
        const members = [...small].flatMap((k) => by.get(k)!);
        const { tiles } = layoutBlock(members, inner, OTHER);
        return { key: OTHER, name: "Other sectors", short: "Other", r: br, tiles, members, cap: d.cap };
      }
      const members = by.get(d.key)!;
      const [name, short] = wordsOf(d.key);
      const { tiles, hard } = layoutBlock(members, inner, d.key);
      hardBy.set(d.key, hard);
      return { key: d.key, name, short, r: br, tiles, members, cap: d.cap };
    });
    const movable = [...hardBy.entries()].filter(([k, h]) => h > 0 && keys.indexOf(k) >= 5).map(([k]) => k);
    if (!movable.length) break;
    small.add(movable.sort((a, b) => capOf(a) - capOf(b))[0]);
  }
  return out;
}

/** Header text that fits a block width. */
export const headerText = (b: Block) => (b.r.w >= headerW(b.name) ? b.name : b.short);
