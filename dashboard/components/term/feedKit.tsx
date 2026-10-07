"use client";

/**
 * Shared bits for the feed panels (TOP news, FLOW, EVTS, WIRE, BLTR):
 * deterministic ET date helpers, the held-ticker set, ticker chips and the
 * small SVG markers. Owned by the feeds builder — not a general primitive.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import s from "./feeds.module.css";

// ── ET time helpers (explicit time zone → identical on server and client) ──

const ET = "America/New_York";
const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" });
const hmFmt = new Intl.DateTimeFormat("en-GB", { timeZone: ET, hour: "2-digit", minute: "2-digit", hour12: false });
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WD = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** ET calendar day of an instant: "2026-10-07". */
export const etKey = (t: string | number) => keyFmt.format(new Date(t));
/** ET wall-clock "16:41". */
export const etHM = (t: string | number) => hmFmt.format(new Date(t));
/** "2026-10-07" → "10/07" (no tz math — the key is already a calendar day). */
export const mmdd = (key: string) => `${key.slice(5, 7)}/${key.slice(8, 10)}`;
/** "2026-10-07" → "WED 07 OCT" (computed in UTC on the bare date — no shift). */
export const dayLabel = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WD[wd]} ${String(d).padStart(2, "0")} ${MON[m - 1]}`;
};
/**
 * Calendar day of a timestamp that may be a bare date stored as midnight UTC
 * (filing dates: "2026-10-05T00:00:00+00:00"). Those keep their own date —
 * converting them to ET would shift them to the previous evening.
 */
export const isDateOnly = (iso: string) => /T00:00:00(\.0+)?(\+00:00|Z)$/.test(iso);
export const dayOf = (iso: string) => (isDateOnly(iso) ? iso.slice(0, 10) : etKey(iso));

/** Whole calendar days from day `a` to day `b` (both "YYYY-MM-DD"). */
export const dayDiff = (a: string, b: string) => {
  const p = (k: string) => {
    const [y, m, d] = k.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((p(b) - p(a)) / 86_400_000);
};

/** Compact dollars with U+2212: $8K, $1.2M, −$16K. */
export const fmtK = (n: number, sign = false) => {
  const a = Math.abs(n);
  const sg = n < 0 ? "−" : sign && n > 0 ? "+" : "";
  if (a >= 1e9) return `${sg}$${(a / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${sg}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${sg}$${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, "")}K`;
  return `${sg}$${a.toFixed(0)}`;
};

/** Band midpoint (politicians.py `_AMOUNT_RANGES`) → compact disclosed range. */
export const BANDS: Record<number, string> = {
  8_000: "$1K–15K",
  32_500: "$15K–50K",
  75_000: "$50K–100K",
  175_000: "$100K–250K",
  375_000: "$250K–500K",
  750_000: "$500K–1M",
  3_000_000: "$1M–5M",
  15_000_000: "$5M–25M",
  37_500_000: "$25M–50M",
  75_000_000: "$50M+",
};

// ── Held tickers (shares the ["positions"] cache with PORT) ────────────────

export function useHeld(): Set<string> {
  const { data } = useQuery({ queryKey: ["positions"], queryFn: api.positions });
  return useMemo(() => new Set((data ?? []).map((p) => p.ticker)), [data]);
}

// ── Ticker link / chip ─────────────────────────────────────────────────────

export function Tkr({
  t,
  held,
  chip = false,
  title,
  heldAs = "text",
}: {
  t: string;
  held?: boolean;
  chip?: boolean;
  title?: string;
  /** Terminal-wide convention: a held name's symbol is blue ("text"). "square" is legacy. */
  heldAs?: "square" | "text";
}) {
  const heldCls = held ? ` ${heldAs === "text" ? s.tkrHeldText : s.tkrHeld}` : "";
  return (
    <Link
      href={`/security/${encodeURIComponent(t)}`}
      className={chip ? `${s.chip}${held ? ` ${s.chipHeld}` : ""}` : `${s.tkr}${heldCls}`}
      title={title ?? (held ? `${t} · held position` : t)}
      onClick={(e) => e.stopPropagation()}
    >
      {t}
    </Link>
  );
}

// ── Sentiment micro-bar: diverging from a centre tick, ±1 saturates ───────
// Sentiment is a *text score*, not a price move, so it never uses arrows and
// stays muted; anything under SENT_STRONG reads as a neutral dot.

/** Same cut the server uses to admit headlines to /terminal/wire. */
export const SENT_STRONG = 0.25;

export function SentBar({ v, width = 26 }: { v: number | null | undefined; width?: number }) {
  const h = 8;
  const mid = width / 2;
  if (v == null || !Number.isFinite(v)) {
    return (
      <svg width={width} height={h} aria-hidden="true" className={s.svg}>
        <line x1={mid} x2={mid} y1={1} y2={h - 1} stroke="var(--ink-4)" strokeWidth={1} />
      </svg>
    );
  }
  const label = `Headline sentiment (VADER) ${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}${Math.abs(v) < SENT_STRONG ? " · neutral / uncertain" : ""}`;
  if (Math.abs(v) < SENT_STRONG) {
    return (
      <svg width={width} height={h} className={s.svg} role="img" aria-label={label}>
        <title>{label}</title>
        <rect x={0} y={h / 2 - 0.5} width={width} height={1} fill="var(--line)" />
        <circle cx={mid} cy={h / 2} r={1.75} fill="var(--ink-3)" />
      </svg>
    );
  }
  const len = Math.max(2, Math.min(1, Math.abs(v)) * (mid - 1));
  const c = v > 0 ? "var(--up)" : "var(--down)";
  const x = v >= 0 ? mid : mid - len;
  return (
    <svg width={width} height={h} className={s.svg} role="img" aria-label={label}>
      <title>{label}</title>
      <rect x={0} y={h / 2 - 0.5} width={width} height={1} fill="var(--line-2)" />
      <rect x={x} y={2} width={len} height={h - 4} fill={c} opacity={0.6} />
      <line x1={mid} x2={mid} y1={0} y2={h} stroke="var(--ink-3)" strokeWidth={1} />
    </svg>
  );
}

/** Legend for the terminal-wide held convention: blue ticker = the book holds it. */
export function HeldKey({ label = "held" }: { label?: string }) {
  return (
    <span style={{ color: "var(--blue)", whiteSpace: "nowrap" }} title="Blue ticker = the book holds this name">
      {label}
    </span>
  );
}

// ── Scroll area that ends on whole rows, with a "▾ N more" cue ─────────────
// Panels have fixed heights, so a naive list clips its last row mid-way. We
// size the scroller to end exactly on a row boundary and use the leftover
// sliver below it for a "▾ N more" cue (click to page down). Rows opt in
// with `data-row`; expanded detail blocks are also valid cut points
// (`data-cut`). Separators never are — a list must not end on a header.

const CUE_H = 18;

export function ScrollArea({ children, watch }: { children: ReactNode; watch?: unknown }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState<number | null>(null);
  const [more, setMore] = useState(0);
  const raf = useRef(0);

  const countMore = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      const bottom = el.getBoundingClientRect().bottom;
      let n = 0;
      el.querySelectorAll<HTMLElement>("[data-row]").forEach((r) => {
        if (r.getBoundingClientRect().bottom > bottom + 1) n++;
      });
      setMore(n);
    });
  }, []);

  const layout = useCallback(() => {
    const wrap = wrapRef.current;
    const content = contentRef.current;
    if (!wrap || !content) return;
    const H = wrap.clientHeight;
    if (content.scrollHeight <= H + 1) {
      setCut(null);
      return;
    }
    const top = content.getBoundingClientRect().top;
    let best = 0;
    content.querySelectorAll<HTMLElement>("[data-row], [data-cut]").forEach((r) => {
      const b = r.getBoundingClientRect().bottom - top;
      if (b <= H - CUE_H + 0.5 && b > best) best = b;
    });
    setCut(best > 40 ? Math.floor(best) : H - CUE_H);
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    const content = contentRef.current;
    if (!wrap || !content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => layout());
    ro.observe(wrap);
    ro.observe(content);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf.current);
    };
  }, [layout]);

  useEffect(() => {
    layout();
  }, [watch, layout]);

  useEffect(() => {
    countMore();
  }, [cut, watch, countMore]);

  return (
    <div ref={wrapRef} className={s.scrollWrap}>
      <div ref={scrollRef} className={s.scroll} style={cut != null ? { flex: "none", height: cut } : undefined} onScroll={countMore}>
        <div ref={contentRef}>{children}</div>
      </div>
      {cut != null && (
        <div className={s.cue}>
          {more > 0 && (
            <button
              type="button"
              className={s.cueBtn}
              tabIndex={-1}
              onClick={() => scrollRef.current?.scrollBy({ top: (scrollRef.current?.clientHeight ?? 200) - 24, behavior: "smooth" })}
            >
              ▾ {more} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Thin day separator row used by chronological feeds. */
export function DayRule({ dayKey, right, prefix }: { dayKey: string; right?: React.ReactNode; prefix?: string }) {
  return (
    <div className={s.dayRule} role="separator">
      <span>
        {prefix && <span style={{ color: "var(--ink-3)", marginRight: 6 }}>{prefix}</span>}
        {dayLabel(dayKey)}
      </span>
      <span className={s.dayRuleLine} />
      {right}
    </div>
  );
}
