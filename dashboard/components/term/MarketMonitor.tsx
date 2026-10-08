"use client";

/**
 * WEI — cross-asset monitor. Four views:
 *
 *  MKTS    the first screen: a two-column board with breadth across every
 *          asset class — US equity, global equity, FX, the Treasury curve
 *          (as yields, Δ in bp), credit spreads + VIX, commodities, crypto.
 *          The period Seg picks the single change column it shows.
 *  EQ      US indices, the 11 SPDR sectors and global equity, all horizons.
 *  RATES   yield-curve shape (today vs 1M ago), yields, spreads, funding,
 *          dollar/oil/vol, then the rate and credit ETFs.
 *  FX·CMD  currencies, commodities and crypto.
 *
 * Conventions (stated in the footer):
 *  · prices (equity, FX, commodities, crypto): green up / red down.
 *  · rates, spreads and VIX are risk-ambiguous (a falling yield or VIX is
 *    neither "good" nor "bad"), so they print in neutral ink with a ▲/▼
 *    glyph and a grey fill.
 *  · fill intensity = the move ÷ that row's own typical daily move (σ of
 *    its recent daily changes, √t-scaled for longer horizons); under ¼σ is
 *    "near zero": an empty outlined box.
 *  · ETF rows: the fund's LAST, plus the real underlying level (SPOT, from
 *    FRED) — dimmed when T-2 or older, "—" when there's no free series.
 *  · 52W is the position in the 52-week range (FRED rows: 3-month range);
 *    fixed, it does not follow the horizon switch.
 */
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { term, type MacroRow, type MonitorResp, type QuoteRow } from "@/lib/api";
import { fmtChg, fmtNum, fmtPx } from "@/lib/format";
import { Empty, Flash, Panel, RangeBar, Seg, Skeleton, Spark } from "./ui";
import s from "./MarketMonitor.module.css";

type View = "MKTS" | "EQ" | "RATES" | "FXC";
type Kind = "px" | "idx" | "vix" | "yld" | "spr";
/** A concrete horizon. */
type H = "1D" | "5D" | "1M" | "3M" | "YTD";
/** Seg state; "L" is the view's long horizon — 3M where FRED series live
 *  (they have no YTD), YTD for the equity / FX·commodity tables. */
type Period = "1D" | "5D" | "1M" | "L";
const longOf = (v: View): H => (v === "MKTS" || v === "RATES" ? "3M" : "YTD");
const horizonOf = (p: Period, v: View): H => (p === "L" ? longOf(v) : p);
const horizonsOf = (v: View): H[] => ["1D", "5D", "1M", longOf(v)];
const keyOf = (h: H): Period => (h === "3M" || h === "YTD" ? "L" : h);

const VIEWS: { value: View; label: string }[] = [
  { value: "MKTS", label: "MKTS" },
  { value: "EQ", label: "EQ" },
  { value: "RATES", label: "RATES" },
  { value: "FXC", label: "FX·CMD" },
];

/** Fallback typical daily move when a row has too little history. */
const SIGMA_FALLBACK: Record<Kind, number> = { px: 0.01, idx: 0.008, vix: 0.06, yld: 0.05, spr: 0.04 };
/** Fill saturates at this many typical moves. */
const Z_SAT = 3;
/** Under this many typical moves a change is "near zero": neutral, no pill. */
const Z_ZERO = 0.25;

const COMPACT: Record<string, string> = { T10Y2Y: "2s10s", T10Y3M: "3m10y", DTWEXBGS: "Broad USD" };
/** What each ETF tracks — shown beside the ticker (never as its price). */
const UNDER: Record<string, string> = {
  SPY: "S&P 500", QQQ: "Nasdaq 100", DIA: "Dow 30", IWM: "Russell 2k", VTI: "Total US",
  XLK: "Tech", XLF: "Financials", XLV: "Health", XLY: "Discretion.", XLP: "Staples", XLI: "Industrials",
  XLE: "Energy", XLB: "Materials", XLU: "Utilities", XLRE: "Real estate", XLC: "Comm svcs",
  EFA: "EAFE", EEM: "Emerging", EWJ: "Japan", FXI: "China", EWG: "Germany",
  TLT: "UST 20Y+", IEF: "UST 7–10Y", SHY: "UST 1–3Y", AGG: "US Agg", LQD: "IG corp", HYG: "HY corp", TIP: "TIPS",
  UUP: "USD index", FXE: "Euro", FXY: "Yen", FXB: "Sterling",
  GLD: "Gold", SLV: "Silver", USO: "WTI oil", UNG: "Nat gas", CPER: "Copper", DBA: "Ags",
  IBIT: "Bitcoin", ETHA: "Ether",
};
/** Board-width names (≈ 40px at 10px); the full name is in the tooltip. */
const BOARD_NAME: Record<string, string> = {
  QQQ: "Nasdaq", IWM: "Russell", VTI: "Total US", UUP: "Dollar", EEM: "EM", XLY: "Discr.", XLRE: "REIT", XLC: "Comm.",
};
/** Long descriptions for the hover card. */
const SHORT: Record<string, string> = {
  SPY: "S&P 500", QQQ: "Nasdaq 100", DIA: "Dow 30", IWM: "Russell 2000", VTI: "Total US market",
  XLK: "Technology", XLF: "Financials", XLV: "Health care", XLY: "Consumer discretionary", XLP: "Consumer staples",
  XLI: "Industrials", XLE: "Energy", XLB: "Materials", XLU: "Utilities", XLRE: "Real estate", XLC: "Communication services",
  EFA: "MSCI EAFE", EEM: "MSCI Emerging Markets", EWJ: "MSCI Japan", FXI: "China large-cap", EWG: "MSCI Germany",
  TLT: "UST 20Y+", IEF: "UST 7–10Y", SHY: "UST 1–3Y", AGG: "US Aggregate bonds", LQD: "IG corporates", HYG: "High yield", TIP: "TIPS",
  UUP: "US dollar index", FXE: "Euro", FXY: "Japanese yen", FXB: "British pound",
  GLD: "Gold", SLV: "Silver", USO: "WTI crude", UNG: "Natural gas", CPER: "Copper", DBA: "Agriculture",
  IBIT: "Bitcoin", ETHA: "Ether",
};
const nameOf = (r: { key: string; label: string; macro: boolean }) => (r.macro ? (COMPACT[r.key] ?? r.label) : (UNDER[r.key] ?? r.label));

/** ETF → the FRED series carrying its real underlying level. */
/** ETF → its real underlying: same-day Yahoo close first, FRED fallback. */
const SPOT: Record<string, { series: string[]; dp?: number; note: string; tag?: string }> = {
  SPY: { series: ["YF:^GSPC", "SP500"], note: "S&P 500 index" },
  QQQ: { series: ["YF:^NDX"], note: "Nasdaq-100 index" },
  DIA: { series: ["YF:^DJI", "DJIA"], note: "Dow Jones Industrial Average" },
  IWM: { series: ["YF:^RUT"], note: "Russell 2000 index" },
  EWJ: { series: ["YF:^N225"], note: "Nikkei 225 (EWJ tracks MSCI Japan; the Nikkei is the nearest free benchmark)" },
  EWG: { series: ["YF:^GDAXI"], note: "DAX (EWG tracks MSCI Germany; the DAX is the nearest free benchmark)" },
  FXI: { series: ["YF:^HSI"], note: "Hang Seng (FXI tracks FTSE China 50; the Hang Seng is the nearest free benchmark)" },
  UUP: { series: ["YF:DX-Y.NYB", "DTWEXBGS"], dp: 2, note: "US dollar index (DXY)" },
  FXE: { series: ["YF:EURUSD=X", "DEXUSEU"], dp: 4, note: "EURUSD" },
  FXY: { series: ["YF:JPY=X", "DEXJPUS"], dp: 2, note: "USDJPY level; FXY tracks the yen, so the change shown is the yen's (JPY up = FXY up)" },
  FXB: { series: ["YF:GBPUSD=X", "DEXUSUK"], dp: 4, note: "GBPUSD" },
  GLD: { series: ["YF:GC=F"], note: "Gold front-month future, $/oz" },
  SLV: { series: ["YF:SI=F"], note: "Silver front-month future, $/oz" },
  USO: { series: ["YF:CL=F", "DCOILWTICO"], note: "WTI crude front-month future, $/bbl" },
  UNG: { series: ["YF:NG=F", "DHHNGSP"], note: "Henry Hub natural gas future, $/MMBtu" },
  CPER: { series: ["YF:HG=F"], note: "Copper front-month future, $/lb" },
  IBIT: { series: ["YF:BTC-USD", "CBBTCUSD"], note: "BTC/USD" },
  ETHA: { series: ["YF:ETH-USD", "CBETHUSD"], note: "ETH/USD" },
};
/** FX: the currency rate is the primary value; the ETF's price is secondary. */
const FX_PRIMARY = new Set(["UUP", "FXE", "FXY", "FXB"]);

/** FRED series → short code + kind. */
const MACRO_META: Record<string, { code: string; kind: Kind; label?: string }> = {
  DGS3MO: { code: "3M", kind: "yld" },
  DGS2: { code: "2Y", kind: "yld" },
  DGS5: { code: "5Y", kind: "yld" },
  DGS10: { code: "10Y", kind: "yld" },
  DGS30: { code: "30Y", kind: "yld" },
  T10Y2Y: { code: "2s10s", kind: "spr", label: "2s10s curve" },
  T10Y3M: { code: "3m10y", kind: "spr", label: "3m10y curve" },
  BAMLC0A0CM: { code: "IG", kind: "spr", label: "IG OAS" },
  BAMLH0A0HYM2: { code: "HY", kind: "spr", label: "HY OAS" },
  SOFR: { code: "SOFR", kind: "yld", label: "SOFR" },
  DTWEXBGS: { code: "USD", kind: "idx", label: "Broad dollar" },
  DCOILWTICO: { code: "WTI", kind: "idx", label: "WTI spot" },
  DCOILBRENTEU: { code: "BRENT", kind: "idx", label: "Brent spot" },
  VIXCLS: { code: "VIX", kind: "vix", label: "VIX" },
};

type Spot = { v: number; dp?: number; asOf: string; note: string; series: string; chg1d: number | null; tag?: string };
/** FX rows whose quoted spot moves opposite to the ETF (USDJPY vs FXY). */
const INVERTED = new Set(["FXY"]);
const inv = (c: number | null | undefined) => (c == null ? null : 1 / (1 + c) - 1);

type Row = {
  key: string;
  code: string;
  label: string;
  href: string | null;
  kind: Kind;
  held: boolean;
  macro: boolean;
  last: number | null;
  chg: Record<H, number | null>;
  /** Typical daily move: σ of recent daily changes (fraction, or pp for rates). */
  sigma: number;
  spark: (number | null)[];
  spark60?: (number | null)[];
  pos: number | null;
  posWin: string;
  lo: number | null;
  hi: number | null;
  asOf: string | null;
  spot: Spot | null;
  /** FX rows: the ETF's own moves (the change cells show the currency's). */
  fxEtf?: Partial<Record<H, number | null>>;
  card: [string, ReactNode][];
};

// ── formatting ───────────────────────────────────────────────────────────

const MINUS = "−";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-07" → "Oct 07" without a timezone round-trip. */
function dayLabel(d: string | null | undefined): string {
  if (!d) return "—";
  const [, m, day] = d.slice(0, 10).split("-");
  const mi = parseInt(m, 10) - 1;
  return MONTHS[mi] ? `${MONTHS[mi]} ${day}` : d;
}
const signed = (n: number, body: string) => `${n > 0 ? "+" : n < 0 ? MINUS : ""}${body}`;
/** Percentage points → basis points. */
const fmtBp = (pp: number | null | undefined, plus = true) => {
  if (pp == null || !Number.isFinite(pp)) return "—";
  const bp = Math.round(pp * 100);
  return plus ? `${signed(bp, String(Math.abs(bp)))}bp` : `${bp < 0 ? MINUS : ""}${Math.abs(bp)}bp`;
};
/** One precision rule for levels: ≥ 1,000 → whole numbers; ≥ 10 → 2 dp;
 *  < 10 → 3 dp. FX quotes keep market convention (EURUSD/GBPUSD 4 dp). */
const fmtLevel = (v: number, dp?: number) => {
  const a = Math.abs(v);
  const d = dp ?? (a >= 1_000 ? 0 : a >= 10 ? 2 : 3);
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};

function fmtLast(r: Row): string {
  const v = r.last;
  if (v == null) return "—";
  switch (r.kind) {
    case "yld":
      return `${v.toFixed(2)}%`;
    case "spr":
      return fmtBp(v, false);
    case "px":
      return fmtPx(v);
    default:
      return fmtLevel(v);
  }
}
const fmtDelta = (r: Row, v: number | null) => (r.kind === "yld" || r.kind === "spr" ? fmtBp(v) : fmtChg(v));

/** Business days from a print's date to the equity close (0 = same day). */
function lagDays(asOf: string | null | undefined, close: string | null | undefined): number {
  if (!asOf || !close) return 0;
  const a = asOf.slice(0, 10);
  const c = close.slice(0, 10);
  if (a >= c) return 0;
  const d = new Date(`${a}T12:00:00Z`);
  const end = new Date(`${c}T12:00:00Z`);
  let n = 0;
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

/** Trading days a horizon spans (for √t scaling of the typical move). */
function horizonDays(h: H, close?: string): number {
  if (h === "1D") return 1;
  if (h === "5D") return 5;
  if (h === "1M") return 21;
  if (h === "3M") return 63;
  if (!close) return 190;
  return Math.max(1, lagDays(`${close.slice(0, 4)}-01-01`, close));
}

/** z = move in units of the row's typical move over that horizon. */
const zOf = (r: Row, v: number | null, h: H, close?: string) => (v == null || !Number.isFinite(v) ? null : v / (r.sigma * Math.sqrt(horizonDays(h, close))));

/** Rates, spreads and VIX: risk-ambiguous — neutral ink + ▲/▼, grey fill. */
const neutralKind = (r: Row) => r.kind === "yld" || r.kind === "spr" || r.kind === "vix";

/** Text tone: sign color for prices; neutral for rates/vol; near-zero flat. */
function dir(r: Row, v: number | null, h: H, close?: string): "up" | "down" | "flat" | "ntrl" {
  const z = zOf(r, v, h, close);
  if (z == null || Math.abs(z) < Z_ZERO) return "flat";
  if (neutralKind(r)) return "ntrl";
  return z > 0 ? "up" : "down";
}

/** Filled cell: intensity = |z| / Z_SAT. Prices: sign hue. Rates/vol: grey.
 *  Near zero: an empty outlined box (the cell keeps its shape). */
function fill(r: Row, v: number | null, h: H, close?: string): { bg: string; fg: string; ring: boolean } {
  const z = zOf(r, v, h, close);
  if (z == null) return { bg: "transparent", fg: "var(--ink-4)", ring: true };
  if (Math.abs(z) < Z_ZERO) return { bg: "transparent", fg: "var(--ink-2)", ring: true };
  // Prices: move ÷ typical move. Rates/spreads/VIX: graded by the size of
  // the move itself (10bp, or 10% for VIX, = full) so ▼9bp outweighs ▼1bp.
  const a = neutralKind(r)
    ? Math.min(1, Math.abs(v ?? 0) / (r.kind === "vix" ? 0.1 : 0.1) / Math.sqrt(horizonDays(h, close)))
    : Math.min(1, Math.abs(z) / Z_SAT);
  const [cr, cg, cb] = neutralKind(r) ? [150, 162, 178] : z > 0 ? [18, 168, 92] : [214, 52, 52];
  const base = [21, 27, 35];
  const k = 0.2 + 0.8 * Math.pow(a, 0.8);
  const mix = (c: number, i: number) => Math.round(base[i] + (c - base[i]) * k);
  return { bg: `rgb(${mix(cr, 0)},${mix(cg, 1)},${mix(cb, 2)})`, fg: k > 0.6 ? "#fff" : "var(--ink)", ring: false };
}

/** The change as printed: rates/vol carry a ▲/▼ glyph (their color is neutral). */
function deltaText(r: Row, v: number | null): string {
  const t = fmtDelta(r, v);
  if (!neutralKind(r) || v == null || t === "—") return t;
  const rounded = r.kind === "vix" ? Math.round(v * 10000) : Math.round(v * 100);
  if (rounded === 0) return t.replace(/^[+−]/, "");
  return `${v > 0 ? "▲" : "▼"}${t.replace(/^[+−]/, "")}`;
}

/** Change text with the ▲/▼ glyph set smaller than the figures. */
function Delta({ r, v }: { r: Row; v: number | null }) {
  const t = deltaText(r, v);
  if (t.startsWith("▲") || t.startsWith("▼"))
    return (
      <>
        <span className={s.gl}>{t[0]}</span>
        {t.slice(1)}
      </>
    );
  return <>{t}</>;
}

/** A filled change cell. */
function ChgCell({ r, v, h, close, extra = "" }: { r: Row; v: number | null; h: H; close?: string; extra?: string }) {
  const f = fill(r, v, h, close);
  return (
    <span className={`${s.num} ${s.chg} ${s.hot} ${f.ring ? s.ring : ""} ${extra}`} style={{ background: f.bg, color: f.fg }}>
      <Delta r={r} v={v} />
    </span>
  );
}

// ── data → rows ──────────────────────────────────────────────────────────

const finite = (xs: (number | null)[]) => xs.filter((x): x is number => x != null && Number.isFinite(x));

/** σ of the last ≤60 daily changes (returns, or pp differences for rates). */
function dailySigma(series: (number | null)[], kind: Kind): number {
  const pts = finite(series);
  const ch: number[] = [];
  for (let i = 1; i < pts.length; i++) ch.push(kind === "yld" || kind === "spr" ? pts[i] - pts[i - 1] : pts[i] / pts[i - 1] - 1);
  const xs = ch.slice(-60);
  if (xs.length < 8) return SIGMA_FALLBACK[kind];
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
  return sd > 0 ? sd : SIGMA_FALLBACK[kind];
}

function fromQuote(q: QuoteRow, macro: Map<string, MacroRow>): Row {
  const rv = q.rel_volume;
  const sp = SPOT[q.ticker];
  const sid = sp?.series.find((id) => macro.get(id)?.last != null);
  const m = sid ? macro.get(sid) : undefined;
  const spot: Spot | null = m && m.last != null ? { v: m.last, dp: sp!.dp, asOf: m.as_of, note: sp!.note, series: sid!, chg1d: m.chg_1d, tag: sp!.tag } : null;
  // FX: the currency is the primary value, so its own move drives the change
  // cells (in the ETF's direction — the yen for FXY); the ETF's move goes to
  // the hover card. 3M/YTD fall back to the ETF (the spot series is 60 obs).
  const fxSpot = FX_PRIMARY.has(q.ticker) && m ? m : null;
  const flip = INVERTED.has(q.ticker);
  const fx = (c: number | null | undefined) => (c == null ? null : flip ? inv(c) : c);
  const fxSpark = fxSpot ? fxSpot.spark.map((x) => (x == null ? null : flip ? 1 / x : x)) : null;
  return {
    key: q.ticker,
    code: q.ticker,
    label: SHORT[q.ticker] ?? q.name,
    href: `/security/${encodeURIComponent(q.ticker)}`,
    kind: "px",
    held: q.held,
    macro: false,
    last: q.last,
    chg: fxSpot
      ? { "1D": fx(fxSpot.chg_1d), "5D": fx(fxSpot.chg_5d), "1M": fx(fxSpot.chg_1m), "3M": q.chg_3m, YTD: q.chg_ytd }
      : { "1D": q.chg_1d, "5D": q.chg_5d, "1M": q.chg_1m, "3M": q.chg_3m, YTD: q.chg_ytd },
    fxEtf: fxSpot ? { "1D": q.chg_1d, "5D": q.chg_5d, "1M": q.chg_1m } : undefined,
    sigma: dailySigma(fxSpark ?? q.spark, "px"),
    spark: fxSpark ? fxSpark.slice(-30) : q.spark,
    pos: q.pos_52w,
    posWin: "52W",
    lo: q.lo_52w,
    hi: q.hi_52w,
    asOf: q.as_of,
    spot,
    card: [
      ["Prev", fmtPx(q.prev)],
      ["3M", <span key="3" className={q.chg_3m == null ? "" : q.chg_3m >= 0 ? "up" : "down"}>{fmtChg(q.chg_3m)}</span>],
      ["52W lo", fmtPx(q.lo_52w)],
      ["1Y", <span key="y" className={q.chg_1y == null ? "" : q.chg_1y >= 0 ? "up" : "down"}>{fmtChg(q.chg_1y)}</span>],
      ["52W hi", fmtPx(q.hi_52w)],
      ["Vol 20D", q.vol_20d != null ? `${(q.vol_20d * 100).toFixed(1)}%` : "—"],
      ["Rel vol", rv != null ? `${rv.toFixed(2)}×` : "—"],
      ["Close", dayLabel(q.as_of)],
    ],
  };
}

function fromMacro(m: MacroRow): Row {
  const meta = MACRO_META[m.series_id] ?? { code: m.label, kind: m.unit === "pct" ? "yld" : "idx" };
  const pts = finite(m.spark);
  const lo = pts.length ? Math.min(...pts) : null;
  const hi = pts.length ? Math.max(...pts) : null;
  // 3M ≈ the full 60-observation window: pp delta for rates, fractional otherwise.
  const first = pts[0];
  const c3m = m.last == null || first == null ? null : meta.kind === "yld" || meta.kind === "spr" ? m.last - first : m.last / first - 1;
  const r: Row = {
    key: m.series_id,
    code: meta.code,
    label: meta.label ?? m.label,
    href: null,
    kind: meta.kind,
    held: false,
    macro: true,
    last: m.last,
    chg: { "1D": m.chg_1d, "5D": m.chg_5d, "1M": m.chg_1m, "3M": c3m, YTD: null },
    sigma: dailySigma(m.spark, meta.kind),
    spark: m.spark.slice(-30),
    spark60: m.spark,
    pos: lo != null && hi != null && m.last != null && hi > lo ? (m.last - lo) / (hi - lo) : null,
    posWin: "3M",
    lo,
    hi,
    asOf: m.as_of,
    spot: null,
    card: [],
  };
  const lv = (v: number | null) => fmtLast({ ...r, last: v });
  r.card = [
    ["3M lo", lv(lo)],
    ["3M hi", lv(hi)],
    ["FRED", <span key="id" style={{ color: "var(--ink-3)" }}>{m.series_id}</span>],
    ["As of", dayLabel(m.as_of)],
  ];
  return r;
}

/** VIX from the intraday-fresh monitor.vix (FRED's VIXCLS lags a day). */
function fromVix(v: NonNullable<MonitorResp["vix"]>, fred?: MacroRow): Row {
  const pts = finite(v.spark);
  const last = v.last ?? pts[pts.length - 1] ?? null;
  const back = (n: number) => (pts.length > n && last != null ? last / pts[pts.length - 1 - n] - 1 : null);
  const ref = fred ? finite(fred.spark) : pts;
  const lo = ref.length ? Math.min(...ref, last ?? Infinity) : null;
  const hi = ref.length ? Math.max(...ref, last ?? -Infinity) : null;
  const win = fred ? "3M" : "30D";
  return {
    key: "VIX",
    code: "VIX",
    label: "VIX",
    href: null,
    kind: "vix",
    held: false,
    macro: true,
    last,
    chg: { "1D": back(1), "5D": back(5), "1M": back(21), "3M": ref.length && last != null && fred ? last / ref[0] - 1 : null, YTD: null },
    sigma: dailySigma(fred ? fred.spark : v.spark, "vix"),
    spark: v.spark,
    pos: lo != null && hi != null && last != null && hi > lo ? (last - lo) / (hi - lo) : null,
    posWin: win,
    lo,
    hi,
    asOf: v.as_of,
    spot: null,
    card: [
      [`${win} lo`, fmtNum(lo, 2)],
      [`${win} hi`, fmtNum(hi, 2)],
      ["5D", v.chg_5d_abs != null ? `${signed(v.chg_5d_abs, Math.abs(v.chg_5d_abs).toFixed(2))} pts` : "—"],
      ["Source", "CBOE"],
    ],
  };
}

// ── layout definitions ───────────────────────────────────────────────────

type Group = { label: string; keys: string[]; sortable?: boolean; curve?: boolean; trim?: boolean; subhead?: boolean };

/** Extra board groups, added per column (in order) only when they fit whole. */
const BOARD_EXTRA: Group[][] = [
  [{ label: "Sectors", keys: ["XLK", "XLF", "XLV", "XLY", "XLP", "XLI", "XLE", "XLB", "XLU", "XLRE", "XLC"], sortable: true, trim: true }],
  [
    { label: "Front end · funding", keys: ["DGS3MO", "DGS5", "T10Y3M", "SOFR"] },
    { label: "Gas · metals · ags", keys: ["UNG", "CPER", "SLV", "DBA"] },
  ],
];
const B_ROW = 16;
const B_GROUP = 16;
const B_HEAD = 18;
/** The Treasury-curve row under the Treasuries header. */
const B_CURVE = 36;
/** Column sub-header inside a block (ETF rows under a rates header). */
const B_SUB = 14;

const BOARD: Group[][] = [
  [
    { label: "US equity", keys: ["SPY", "QQQ", "DIA", "IWM"] },
    { label: "Global", keys: ["EFA", "EEM", "EWJ", "FXI", "EWG"] },
    { label: "FX", keys: ["UUP", "FXE", "FXY", "FXB"] },
  ],
  [
    { label: "Treasuries", keys: ["DGS2", "DGS10", "T10Y2Y"], curve: true },
    { label: "Credit · vol", keys: ["BAMLC0A0CM", "BAMLH0A0HYM2", "VIX"] },
    { label: "Commodities · crypto", keys: ["GLD", "USO", "IBIT", "ETHA"], subhead: true },
  ],
];

const TABLES: Record<Exclude<View, "MKTS">, Group[]> = {
  EQ: [
    { label: "US equity", keys: ["SPY", "QQQ", "DIA", "IWM", "VTI"] },
    { label: "Sectors", keys: ["XLK", "XLF", "XLV", "XLY", "XLP", "XLI", "XLE", "XLB", "XLU", "XLRE", "XLC"], sortable: true },
    { label: "Global", keys: ["EFA", "EEM", "EWJ", "FXI", "EWG"], sortable: true },
  ],
  RATES: [
    { label: "Treasury curve", keys: ["DGS3MO", "DGS2", "DGS5", "DGS10", "DGS30"] },
    { label: "Spreads · funding", keys: ["T10Y2Y", "T10Y3M", "BAMLC0A0CM", "BAMLH0A0HYM2", "SOFR"] },
    { label: "Dollar · oil · vol", keys: ["DTWEXBGS", "DCOILWTICO", "DCOILBRENTEU", "VIX"] },
    { label: "Rate ETFs", keys: ["SHY", "IEF", "TLT"] },
    { label: "Credit ETFs", keys: ["AGG", "LQD", "HYG", "TIP"] },
  ],
  FXC: [
    { label: "FX", keys: ["UUP", "FXE", "FXY", "FXB"], sortable: true },
    { label: "Commodities", keys: ["GLD", "SLV", "USO", "UNG", "CPER", "DBA"], sortable: true },
    { label: "Crypto", keys: ["IBIT", "ETHA"], sortable: true },
  ],
};
const CURVE = ["DGS3MO", "DGS2", "DGS5", "DGS10", "DGS30"];

const P52_TIP =
  "52W: where the last price sits in its 52-week range (left = 52-week low, right = 52-week high). FRED rows use their 3-month range. Fixed — it does not follow the horizon switch.";
const SPOT_TIP =
  "SPOT: the real level of what the ETF tracks (FRED). T-n = that print is n business days behind today's close; dimmed when T-2 or older. — = no free spot series.";

// ── component ────────────────────────────────────────────────────────────

type Hover = { key: string; top: number; side: "l" | "r" };

export function MarketMonitor({ className = "", style }: { className?: string; style?: CSSProperties }) {
  const [period, setPeriod] = useState<Period>("1D");
  const [view, setView] = useState<View>("MKTS");
  const [hover, setHover] = useState<Hover | null>(null);
  const [wrapH, setWrapH] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);
  const wrapRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWrapH(Math.round(e.contentRect.height)));
    ro.observe(el);
    roRef.current = ro;
  }, []);
  const { data, isLoading, isError } = useQuery({ queryKey: ["monitor"], queryFn: () => term.monitor(), refetchInterval: 60_000 });

  const rows = useMemo(() => {
    const m = new Map<string, Row>();
    if (!data) return m;
    const macro = new Map((data.macro ?? []).map((x) => [x.series_id, x]));
    for (const q of data.rows) m.set(q.ticker, fromQuote(q, macro));
    for (const x of data.macro ?? []) m.set(x.series_id, fromMacro(x));
    const fredVix = macro.get("VIXCLS");
    if (data.vix) m.set("VIX", fromVix(data.vix, fredVix));
    else if (fredVix) m.set("VIX", { ...fromMacro(fredVix), key: "VIX" });
    return m;
  }, [data]);

  const h = horizonOf(period, view);
  const close = data?.rows.find((r) => r.group === "Equity")?.as_of ?? data?.rows[0]?.as_of;
  const hovered = hover ? rows.get(hover.key) : undefined;
  const onHover = (key: string, el: HTMLElement, side: "l" | "r") => {
    const host = el.closest(`.${s.wrap}`) as HTMLElement | null;
    const top = host ? el.getBoundingClientRect().bottom - host.getBoundingClientRect().top + host.scrollTop + 1 : 0;
    setHover({ key, top, side });
  };

  return (
    <Panel
      code="WEI"
      title="Cross-asset"
      className={className}
      style={style}
      flush
      actions={
        <>
          <Seg options={VIEWS} value={view} onChange={(v) => { setView(v); setHover(null); }} label="Monitor view" />
          <Seg options={horizonsOf(view).map((x) => ({ value: keyOf(x), label: x }))} value={period} onChange={setPeriod} label="Change horizon" />
        </>
      }
      testId="wei"
    >
      {isLoading ? (
        <Skeleton rows={9} height={16} />
      ) : isError ? (
        <Empty>Cross-asset monitor unavailable — API did not respond.</Empty>
      ) : !rows.size ? (
        <Empty>No monitor data yet — the daily price refresh has not run.</Empty>
      ) : (
        <div className={s.shell}>
          <div ref={wrapRef} className={`${s.wrap} ${view === "MKTS" ? s.fixed : ""}`} onMouseLeave={() => setHover(null)}>
            {view === "MKTS" ? (
              <Board rows={rows} h={h} close={close} height={wrapH} onHover={onHover} onMacro={() => setView("RATES")} />
            ) : (
              <Table
                rows={rows}
                groups={TABLES[view]}
                hs={horizonsOf(view)}
                h={h}
                setH={(x) => setPeriod(keyOf(x))}
                onHover={onHover}
                curve={view === "RATES" ? CURVE.map((k) => rows.get(k)).filter((r): r is Row => !!r) : null}
                spread={view === "RATES" ? rows.get("T10Y2Y") : undefined}
                close={close}
              />
            )}
            {hovered && hover && <HoverCard r={hovered} top={hover.top} side={hover.side} close={close} h={h} />}
          </div>
          <Legend close={close} held={view === "RATES"} />
        </div>
      )}
    </Panel>
  );
}

/** A level with a dim "T-n" suffix when its print isn't today's; dimmed
 *  as a whole when T-2 or older. */
function Lvl({ text, asOf, close, className = "", tag }: { text: string; asOf: string | null | undefined; close?: string; className?: string; tag?: string }) {
  const n = lagDays(asOf, close);
  return (
    <span
      className={`${className} ${n >= 2 ? s.stale : ""}`}
      title={asOf ? `As of ${dayLabel(asOf)}${n ? ` — ${n} business day${n > 1 ? "s" : ""} behind the ${dayLabel(close)} close` : ""}` : undefined}
    >
      {tag && <span className={s.lag}>{tag}</span>}
      {n > 0 && <span className={s.lag}>T-{n}</span>}
      {text}
    </span>
  );
}

/** Just the T-n tag, right-aligned in its own cell (macro rows). */
function LagTag({ asOf, close }: { asOf: string | null | undefined; close?: string }) {
  const n = lagDays(asOf, close);
  return (
    <span className={`${s.spot} ${s.lagCell}`} title={asOf ? `As of ${dayLabel(asOf)}${n ? ` — ${n} business day${n > 1 ? "s" : ""} behind the ${dayLabel(close)} close` : ""}` : undefined}>
      {n > 0 && <span className={s.lag}>T-{n}</span>}
    </span>
  );
}

/** The SPOT cell: the underlying's real level, or "—". */
function SpotCell({ r, close }: { r: Row; close?: string }) {
  if (r.spot)
    return (
      <span className={`${s.spot} ${FX_PRIMARY.has(r.key) ? s.primary : ""}`} title={`${r.spot.note} · ${dayLabel(r.spot.asOf)} · ${r.spot.series.replace(/^YF:/, "Yahoo ")}`}>
        <Lvl text={fmtLevel(r.spot.v, r.spot.dp)} asOf={r.spot.asOf} close={close} tag={r.spot.tag} />
      </span>
    );
  return (
    <span className={s.noSpot} title={`${SHORT[r.key] ?? r.label}: no free spot series — the ETF's LAST is the only price shown`}>
      —
    </span>
  );
}

// ── board (MKTS) ─────────────────────────────────────────────────────────

function Board({
  rows,
  h: period,
  close,
  height,
  onHover,
  onMacro,
}: {
  rows: Map<string, Row>;
  h: H;
  close?: string;
  height: number;
  onHover: (k: string, el: HTMLElement, side: "l" | "r") => void;
  onMacro: () => void;
}) {
  const curveRows = CURVE.map((k) => rows.get(k));
  const curve = curveRows.map((r) => r?.last ?? null);
  const curve1m = curveRows.map((r) => {
    const sp = r?.spark60 ? finite(r.spark60) : [];
    return sp.length > 21 ? sp[sp.length - 22] : null;
  });
  const cols = BOARD.map((base, ci) => {
    const out = [...base];
    let used = B_HEAD + base.reduce((a, g) => a + B_GROUP + (g.curve ? B_CURVE : 0) + (g.subhead ? B_SUB : 0) + g.keys.filter((k) => rows.has(k)).length * B_ROW, 0);
    for (const g of BOARD_EXTRA[ci]) {
      const keys = g.keys.filter((k) => rows.has(k));
      const need = B_GROUP + keys.length * B_ROW;
      if (keys.length && used + need <= height) {
        out.push(g);
        used += need;
      } else if (g.trim && keys.length) {
        // Not enough room for all: show the leaders and the laggards.
        const fit = Math.floor((height - used - B_GROUP) / B_ROW);
        if (fit >= 4) {
          const sorted = [...keys].sort((a, b) => (rows.get(b)?.chg[period] ?? -Infinity) - (rows.get(a)?.chg[period] ?? -Infinity));
          const top = Math.ceil(fit / 2);
          out.push({ ...g, label: `${g.label} · best / worst`, keys: [...sorted.slice(0, top), ...sorted.slice(sorted.length - (fit - top))] });
          used += B_GROUP + fit * B_ROW;
        }
      }
    }
    return out;
  });
  return (
    <div className={s.board}>
      {cols.map((col, ci) => (
        <div key={ci} className={s.bcol}>
          {ci === 0 ? (
            <div className={`${s.bgrid} ${s.head}`}>
              <span className={s.hcell} style={{ textAlign: "left", gridColumn: "span 2" }} title="ETF ticker and what it tracks">
                ETF<span className={s.wideOnly}> · tracks</span>
              </span>
              <span className={`${s.hcell} ${s.spotHead}`} title={SPOT_TIP}>
                Spot
              </span>
              <span className={s.hcell} title="Last price of the ETF">
                Last
              </span>
              <span className={s.hcell} style={{ color: "var(--amber)" }} title="Change over the selected horizon (FX rows: the currency's own move)">
                {period}
              </span>
              {period !== "5D" && (
                <span className={`${s.hcell} ${s.wide2}`} title="5-day change">
                  5D
                </span>
              )}
            </div>
          ) : (
            <div className={`${s.bgrid} ${s.head}`}>
              <span className={s.hcell} style={{ textAlign: "left", gridColumn: "span 2" }} title="US Treasury yields, curve spreads, credit spreads (FRED) and VIX — true levels, not ETFs">
                Rates
              </span>
              <span className={`${s.hcell} ${s.spotHead}`} title="Days behind today's close (FRED publishes with a lag)">
                {"\u00a0"}
              </span>
              <span className={s.hcell} title="Yield / spread level (VIX in points)">
                Level
              </span>
              <span className={s.hcell} style={{ color: "var(--amber)" }} title="Change over the selected horizon: basis points for rates and spreads, % for VIX">
                {period} bp
              </span>
              {period !== "5D" && (
                <span className={`${s.hcell} ${s.wide2}`} title="5-day change">
                  5D
                </span>
              )}
            </div>
          )}
          {col.map((g) => (
            <div key={g.label} style={{ display: "contents" }}>
              <div className={s.bgroup}>
                <span className={s.groupLabel}>{g.label}</span>
                <span className={s.groupRule} />
                {g.curve && (
                  <span className={s.curveKey} title="Yield curve below: latest (solid) vs one month ago (dashed)">
                    <i className={s.ckSolid} /> latest <i className={s.ckDash} /> 1M ago
                  </span>
                )}
              </div>
              {g.curve && <CurveRow ys={curve} ago={curve1m} asOf={curveRows[0]?.asOf} close={close} onClick={onMacro} />}
              {g.subhead && (
                <div className={`${s.bgrid} ${s.subhead}`}>
                  <span style={{ gridColumn: "span 2" }} title="ETF ticker and what it tracks">
                    ETF
                  </span>
                  <span className={s.r} title={SPOT_TIP}>
                    Spot
                  </span>
                  <span className={s.r} title="Last price of the ETF">
                    Last
                  </span>
                  <span className={s.r} title="Change over the selected horizon">
                    {period}
                  </span>
                </div>
              )}
              {(g.sortable && !g.label.includes("best / worst") ? [...g.keys].sort((a, b) => (rows.get(b)?.chg[period] ?? -Infinity) - (rows.get(a)?.chg[period] ?? -Infinity)) : g.keys).map((k) => {
                const r = rows.get(k);
                if (!r) return null;
                const v = r.chg[period];
                const body = (
                  <>
                    {r.macro ? (
                      <>
                        <span className={`${s.bmacro} ${s.bmacroSpan}`}>
                          {nameOf(r)}
                          {lagDays(r.asOf, close) > 0 && <span className={`${s.lag} ${s.lagNarrow}`}> T-{lagDays(r.asOf, close)}</span>}
                        </span>
                        <LagTag asOf={r.asOf} close={close} />
                      </>
                    ) : (
                      <>
                        <span className={`${s.btkr} ${r.held ? s.held : ""}`}>{r.code}</span>
                        <span className={s.bname} title={SHORT[r.key] ?? r.label}>
                          {BOARD_NAME[r.key] ?? nameOf(r)}
                        </span>
                        <SpotCell r={r} close={close} />
                      </>
                    )}
                    <span className={`${s.num} ${FX_PRIMARY.has(r.key) && r.spot ? s.secondary : ""}`}>
                      {r.macro ? (
                        <span className={lagDays(r.asOf, close) >= 2 ? s.stale : undefined}>{fmtLast(r)}</span>
                      ) : (
                        <Flash value={r.last}>{fmtLast(r)}</Flash>
                      )}
                    </span>
                    <ChgCell r={r} v={v} h={period} close={close} />
                    {period !== "5D" && <ChgCell r={r} v={r.chg["5D"]} h="5D" close={close} extra={s.wide2} />}
                  </>
                );
                const common = {
                  className: `${s.bgrid} ${s.row} ${s.brow}`,
                  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => onHover(k, e.currentTarget, ci === 0 ? "l" : "r"),
                  onFocus: (e: React.FocusEvent<HTMLElement>) => onHover(k, e.currentTarget, ci === 0 ? "l" : "r"),
                };
                return r.href ? (
                  <Link key={k} href={r.href} {...common} aria-label={`${r.code}, ${SHORT[r.key] ?? r.label} ETF, last ${fmtLast(r)}, ${period} ${fmtDelta(r, v)}`}>
                    {body}
                  </Link>
                ) : (
                  <button key={k} type="button" {...common} onClick={onMacro} title={`${r.label} — open RATES`}>
                    {body}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Treasury curve row: the curve (latest solid, 1M ago dashed) over the
 *  tenor yields it is drawn from. */
const TENORS = ["3M", "2Y", "5Y", "10Y", "30Y"];
/** Tenors labelled under the curve (5Y is drawn but not printed). */
const SHOWN_TENORS = new Set(["3M", "2Y", "10Y", "30Y"]);
function CurveRow({ ys, ago, asOf, close, onClick }: { ys: (number | null)[]; ago: (number | null)[]; asOf?: string | null; close?: string; onClick: () => void }) {
  const all = [...ys, ...ago].filter((v): v is number => v != null);
  if (ys.filter((v) => v != null).length < 3) return null;
  const min = Math.min(...all);
  const span = Math.max(...all) - min || 1;
  const W = 200;
  const H = 18;
  const x = (i: number) => 14 + (i / (ys.length - 1)) * (W - 28);
  const y = (v: number) => 2 + (1 - (v - min) / span) * (H - 4);
  const path = (vs: (number | null)[]) => vs.map((v, i) => (v == null ? "" : `${i && vs[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join("");
  const lag = lagDays(asOf, close);
  return (
    <button
      type="button"
      className={s.curveRow}
      onClick={onClick}
      title={`US Treasury yield curve${lag ? ` (T-${lag}, ${dayLabel(asOf)})` : ""}: latest solid, one month ago dashed — open RATES`}
    >
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" aria-hidden="true">
        <path d={path(ago)} fill="none" stroke="var(--ink-3)" strokeWidth={1} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
        <path d={path(ys)} fill="none" stroke="var(--ink)" strokeWidth={1.4} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className={s.curveVals}>
        {TENORS.map((t, i) =>
          SHOWN_TENORS.has(t) ? (
            <span key={t}>
              <i>{t}</i>
              {ys[i] != null ? ys[i]!.toFixed(2) : "—"}
            </span>
          ) : null,
        )}
      </span>
    </button>
  );
}

// ── tables (EQ / RATES / FX·CMD) ─────────────────────────────────────────

function Table({
  rows,
  groups,
  hs: PERIODS,
  h: period,
  setH: setPeriod,
  onHover,
  curve,
  spread,
  close,
}: {
  rows: Map<string, Row>;
  groups: Group[];
  hs: H[];
  h: H;
  setH: (h: H) => void;
  onHover: (k: string, el: HTMLElement, side: "l" | "r") => void;
  curve: Row[] | null;
  spread?: Row;
  close?: string;
}) {
  const sorts = groups.some((g) => g.sortable);
  return (
    <>
      <div className={`${s.grid} ${s.head}`}>
        <span className={s.hcell} style={{ textAlign: "left" }} title="ETF ticker">
          Tkr
        </span>
        <span className={s.hcell} style={{ textAlign: "left" }} title="What the ETF tracks; FRED rows are true levels">
          Tracks
        </span>
        <span className={s.hcell} title={SPOT_TIP}>
          Spot
        </span>
        <span className={s.hcell} title="Last price of the ETF (or the series value for FRED rows)">
          Last
        </span>
        {PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            className={`${s.hcell} ${p === "5D" ? s.c5d : ""}`}
            aria-pressed={p === period}
            onClick={() => setPeriod(p)}
            title={sorts ? `Fill and sort rotation groups by ${p}` : `Fill ${p}`}
          >
            {p}
            {sorts && p === period ? " ▾" : ""}
          </button>
        ))}
        <span className={`${s.hcell} ${s.hcenter}`} title={P52_TIP}>
          52W
        </span>
      </div>
      {curve && curve.length >= 3 && <CurveChart rows={curve} spread={spread} close={close} />}
      {groups.map((g) => {
        let list = g.keys.map((k) => rows.get(k)).filter((r): r is Row => !!r);
        if (!list.length) return null;
        if (g.sortable) list = [...list].sort((a, b) => (b.chg[period] ?? -Infinity) - (a.chg[period] ?? -Infinity));
        const vals = list.filter((r) => !r.macro).map((r) => r.chg[period]).filter((v): v is number => v != null);
        const avg = vals.length > 1 && !g.label.startsWith("FX") ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        const avgTone = avg == null ? "flat" : Math.round(avg * 10000) === 0 ? "flat" : avg > 0 ? "up" : "down";
        return (
          <div key={g.label} style={{ display: "contents" }}>
            <div className={`${s.grid} ${s.group}`}>
              <span className={s.groupHead}>
                <span className={s.groupLabel}>{g.label}</span>
              </span>
              <span />
              <span />
              <span />
              {PERIODS.map((p) => (
                <span key={p} className={p === "5D" ? s.c5d : undefined} style={{ display: p === period ? "flex" : undefined, justifyContent: "flex-end" }}>
                  {p === period && avg != null && (
                    <span className={`${s.groupAvg} ${avgTone}`} title={`Equal-weight average ${p} change, ${g.label}`}>
                      <span style={{ color: "var(--ink-3)" }}>avg </span>
                      {fmtChg(avg)}
                    </span>
                  )}
                </span>
              ))}
              <span />
            </div>
            {list.map((r) => (
              <TableRow key={r.key} r={r} hs={PERIODS} period={period} onHover={onHover} close={close} />
            ))}
          </div>
        );
      })}
    </>
  );
}

function TableRow({ r, hs: PERIODS, period, onHover, close }: { r: Row; hs: H[]; period: H; onHover: (k: string, el: HTMLElement, side: "l" | "r") => void; close?: string }) {
  const cells = (
    <>
      {r.macro ? (
        <span className={s.sec} style={{ gridColumn: "span 3" }}>
          <span className={s.mlabel}>{r.label}</span>
        </span>
      ) : (
        <>
          <span className={`${s.tkr} ${r.held ? s.held : ""}`}>{r.code}</span>
          <span className={s.name}>{nameOf(r)}</span>
          <SpotCell r={r} close={close} />
        </>
      )}
      <span className={`${s.num} ${FX_PRIMARY.has(r.key) && r.spot ? s.secondary : ""}`}>
        {r.macro ? <Lvl text={fmtLast(r)} asOf={r.asOf} close={close} /> : <Flash value={r.last}>{fmtLast(r)}</Flash>}
      </span>
      {PERIODS.map((p) => {
        const v = r.chg[p];
        const cls = `${s.num} ${s.chg} ${p === "5D" ? s.c5d : ""}`;
        if (p === period && v != null) return <ChgCell key={p} r={r} v={v} h={p} close={close} extra={p === "5D" ? s.c5d : ""} />;
        const t = dir(r, v, p, close);
        return (
          <span key={p} className={`${cls} ${t === "ntrl" ? "" : t}`} style={v == null ? { color: "var(--ink-4)" } : t === "ntrl" ? { color: "var(--ink)" } : undefined}>
            <Delta r={r} v={v} />
          </span>
        );
      })}
      <span className={s.rng}>
        <Pctile pos={r.pos} win={r.posWin} />
      </span>
    </>
  );
  const common = {
    className: `${s.grid} ${s.row}`,
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => onHover(r.key, e.currentTarget, "r"),
    onFocus: (e: React.FocusEvent<HTMLElement>) => onHover(r.key, e.currentTarget, "r"),
  };
  return r.href ? (
    <Link href={r.href} {...common} aria-label={`${r.code} ${r.label}, last ${fmtLast(r)}, ${period} ${fmtDelta(r, r.chg[period])}`}>
      {cells}
    </Link>
  ) : (
    <div {...common} tabIndex={0} aria-label={`${r.label}, ${fmtLast(r)}, ${period} ${fmtDelta(r, r.chg[period])}`}>
      {cells}
    </div>
  );
}

/** Shared range glyph (neutral marker, as in PORT); the number is on hover. */
function Pctile({ pos, win }: { pos: number | null; win: string }) {
  const p = pos == null ? null : Math.max(0, Math.min(1, pos));
  return (
    <span className={s.pctile} title={p != null ? `${Math.round(p * 100)}% of the way from the ${win} low to the ${win} high` : `${win} range n/a`}>
      <RangeBar pos={p} width={34} />
    </span>
  );
}

/** Treasury curve today vs one month ago, tenors evenly spaced. */
function CurveChart({ rows, spread, close }: { rows: Row[]; spread?: Row; close?: string }) {
  const W = 440;
  const H = 66;
  const padL = 16;
  const padR = 92;
  const padT = 14;
  const padB = 14;
  const today = rows.map((r) => r.last);
  const ago = rows.map((r) => {
    const sp = r.spark60 ? finite(r.spark60) : [];
    return sp.length > 21 ? sp[sp.length - 22] : null;
  });
  const all = [...today, ...ago].filter((v): v is number => v != null);
  if (all.length < 3) return null;
  const min = Math.floor(Math.min(...all) * 10) / 10 - 0.05;
  const max = Math.ceil(Math.max(...all) * 10) / 10 + 0.05;
  const x = (i: number) => padL + (i / (rows.length - 1)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  const path = (vs: (number | null)[]) =>
    vs.map((v, i) => (v == null ? "" : `${i && vs[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join("");
  // The 2s10s print comes from FRED's own T10Y2Y series so it matches the table.
  const steep = spread?.last ?? null;
  const steep1m = spread?.chg["1M"] ?? null;
  const lag = lagDays(rows[0]?.asOf, close);
  return (
    <div className={s.curve}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" aria-label="US Treasury yield curve, today vs one month ago">
        {[0, 0.5, 1].map((t) => (
          <line key={t} x1={padL} x2={W - padR} y1={padT + t * (H - padT - padB)} y2={padT + t * (H - padT - padB)} stroke="var(--line)" strokeWidth={1} />
        ))}
        <path d={path(ago)} fill="none" stroke="var(--ink-3)" strokeWidth={1} strokeDasharray="3 2" />
        <path d={path(today)} fill="none" stroke="var(--ink)" strokeWidth={1.4} strokeLinejoin="round" />
        {today.map((v, i) =>
          v == null ? null : (
            <g key={i}>
              <circle cx={x(i)} cy={y(v)} r={2} fill="var(--ink)" />
              <text x={x(i)} y={y(v) - 5} textAnchor="middle" className={s.ylab}>
                {v.toFixed(2)}
              </text>
            </g>
          ),
        )}
        {rows.map((r, i) => (
          <text key={r.key} x={x(i)} y={H - 2} textAnchor="middle" className={s.axis}>
            {r.code}
          </text>
        ))}
        <g transform={`translate(${W - padR + 14}, ${padT + 2})`}>
          <line x1={0} x2={14} y1={0} y2={0} stroke="var(--ink)" strokeWidth={1.4} />
          <text x={18} y={3} className={s.axis}>{lag ? `T-${lag} ${dayLabel(rows[0]?.asOf)}` : "today"}</text>
          <line x1={0} x2={14} y1={13} y2={13} stroke="var(--ink-3)" strokeDasharray="3 2" />
          <text x={18} y={16} className={s.axis}>1M ago</text>
          <text x={0} y={33} className={s.axis}>2s10s</text>
          <text x={34} y={33} className={s.ylab}>{steep != null ? fmtBp(steep, false) : "—"}</text>
          {steep1m != null && (
            <text x={0} y={45} className={s.axis}>
              {fmtBp(steep1m)} 1M
            </text>
          )}
        </g>
      </svg>
    </div>
  );
}

// ── hover card + legend ──────────────────────────────────────────────────

function HoverCard({ r, top, side, close, h }: { r: Row; top: number; side: "l" | "r"; close?: string; h: H }) {
  const z = zOf(r, r.chg[h], h, close);
  const sigmaTxt = r.kind === "yld" || r.kind === "spr" ? `${(r.sigma * 100).toFixed(1)}bp` : `${(r.sigma * 100).toFixed(2)}%`;
  return (
    <div className={s.card} style={{ top, ...(side === "l" ? { left: 8 } : { right: 8 }) }} role="tooltip">
      <div className={s.cardHead}>
        {!r.macro && <span className="tkr" style={{ color: r.held ? "var(--blue)" : undefined }}>{r.code}</span>}
        <span style={{ color: r.macro ? "var(--ink)" : "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
        {!r.macro && <span className={s.etfTag} title={`${r.code} is an ETF; its price is the fund's, not the underlying's`}>ETF</span>}
        <span style={{ marginLeft: "auto" }} className="num">
          {r.pos != null ? `${Math.round(r.pos * 100)}% of ${r.posWin} range` : ""}
        </span>
      </div>
      <div className={s.cardSpark}>
        <Spark data={r.spark} width={218} height={26} strokeWidth={1.1} color={neutralKind(r) ? "var(--ink-2)" : undefined} />
        <span className={s.cardNote}>last 30 sessions</span>
      </div>
      {r.spot && (
        <div className={s.cardSpot}>
          <span className={s.k}>Spot</span>
          <span className="num" style={{ color: "var(--ink)" }}>{fmtLevel(r.spot.v, r.spot.dp)}</span>
          {r.spot.chg1d != null && <span className={`num ${r.spot.chg1d > 0 ? "up" : r.spot.chg1d < 0 ? "down" : "flat"}`}>{fmtChg(r.spot.chg1d)}</span>}
          <span className={s.cardNote}>
            {r.spot.note} · {dayLabel(r.spot.asOf)}
          </span>
        </div>
      )}
      <div className={s.cardGrid}>
        {r.card.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <span className={s.k}>{k}</span>
            <span className={s.v}>{v}</span>
          </div>
        ))}
      </div>
      {r.fxEtf && (
        <div className={s.cardSpot}>
          <span className={s.k}>{r.code} ETF</span>
          {(["1D", "5D", "1M"] as H[]).map((hh) => (
            <span key={hh} className="num">
              <span style={{ color: "var(--ink-3)" }}>{hh} </span>
              <span className={(r.fxEtf![hh] ?? 0) > 0 ? "up" : (r.fxEtf![hh] ?? 0) < 0 ? "down" : "flat"}>{fmtChg(r.fxEtf![hh])}</span>
            </span>
          ))}
        </div>
      )}
      <div style={{ marginTop: 5, fontSize: 10, color: "var(--ink-3)" }}>
        {r.fxEtf && <>Change cells show the {INVERTED.has(r.key) ? "yen's" : "currency's"} move · </>}
        Typical daily move σ {sigmaTxt}
        {z != null && ` · ${h} move = ${Math.abs(z).toFixed(1)}σ`}
        {r.held && <span style={{ color: "var(--blue)" }}> · held in the book</span>}
      </div>
    </div>
  );
}

function Legend({ close, held }: { close?: string; held: boolean }) {
  return (
    <div className={s.legend}>
      <div className={s.legendRow}>
        <span title="Equity, FX, commodity and crypto rows: green up, red down. Rates, spreads and VIX are risk-ambiguous, so they print in neutral ink with ▲/▼ and a grey fill.">
          <span className="up">▲</span>
          <span className="down">▼</span> prices · <span className={s.ntrlKey}>▲▼</span> rates · spreads · VIX neutral
        </span>
        <span className={s.asof} title="Equity close; FRED rows carry their own T-n tag">
          close <span className="num">{dayLabel(close)}</span>
        </span>
      </div>
      <div className={s.legendRow}>
        {held && (
          <span>
            <span className={s.heldKey} /> held
          </span>
        )}
        <span title="Tickers are ETFs; LAST is the fund's price. SPOT is the real level of what it tracks (FRED), dimmed when T-2 or older.">
          <b className={s.legendKey}>ETF</b> last · spot <span className={s.lag}>T-n</span> days behind
        </span>
        <span title="Prices: fill intensity = the move ÷ that row's typical daily move (σ of recent daily changes, √t-scaled); saturates at 3σ; under ¼σ an empty box. Rates, spreads and VIX: grey fill graded by the move itself (10bp or 10% = full).">
          fill: px ÷ typ. move · rates by bp
        </span>
      </div>
    </div>
  );
}
