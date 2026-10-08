"use client";

/**
 * Terminal primitives — the atoms every launchpad panel is built from.
 * Contract + tokens: design/TERMINAL.md, app/globals.css.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { fmtAge, fmtChg, tone } from "@/lib/format";

// ── Panel ────────────────────────────────────────────────────────────────

export function Panel({
  code,
  title,
  sub,
  actions,
  live,
  flush,
  scroll,
  className = "",
  style,
  bodyStyle,
  children,
  testId,
  id,
}: {
  /** DOM id — lets "#gp"-style command-line hashes target the panel. */
  id?: string;
  /** Function mnemonic shown in amber, e.g. "GP", "PORT". */
  code?: string;
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  /** ISO timestamp of the data's freshness → pulsing dot + age. */
  live?: string | null;
  flush?: boolean;
  scroll?: boolean;
  className?: string;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section id={id} className={`panel ${className}`} style={style} data-testid={testId}>
      <header className="panel-head">
        {code && <span className="panel-code">{code}</span>}
        <h2 className="panel-title">{title}</h2>
        {sub && <span className="panel-sub">{sub}</span>}
        <div className="panel-actions">
          {actions}
          {live !== undefined && <LiveAge at={live} />}
        </div>
      </header>
      <div className={`panel-body${flush ? " flush" : ""}${scroll ? " scroll" : ""}`} style={bodyStyle}>
        {children}
      </div>
    </section>
  );
}

/** Freshness indicator: a pulsing neutral dot when < 20 min old, a dim static
 * one after. Green/red stay reserved for direction. */
export function LiveAge({ at, staleAfterSec = 1200 }: { at: string | null; staleAfterSec?: number }) {
  const now = useNow(15_000);
  if (!at) return <span className="pill">no data</span>;
  const age = (now - new Date(at).getTime()) / 1000;
  const fresh = age < staleAfterSec;
  return (
    <span className="num" style={{ fontSize: 10, color: fresh ? "var(--ink-2)" : "var(--ink-3)", display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span className={`dot${fresh ? " live" : ""}`} style={fresh ? undefined : { color: "var(--ink-4)" }} />
      {fmtAge(at, now)}
    </span>
  );
}

// ── Segmented control ────────────────────────────────────────────────────

export function Seg<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly T[] | { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  const opts = (options as (T | { value: T; label: string })[]).map((o) =>
    typeof o === "string" ? { value: o, label: o } : o,
  );
  return (
    <div className="seg-group" role="group" aria-label={label}>
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          className="seg-btn"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Numbers ──────────────────────────────────────────────────────────────

/** Signed % change, colored. `value` is a fraction (0.012 = +1.20%). */
export function Chg({ value, digits = 2, className = "", style }: { value: number | null | undefined; digits?: number; className?: string; style?: CSSProperties }) {
  return (
    <span className={`num ${tone(value)} ${className}`} style={style}>
      {fmtChg(value, digits)}
    </span>
  );
}

/**
 * Wraps a value and flashes green/red when it changes between renders —
 * the "tick" feel of a live terminal.
 */
export function Flash({ value, children, className = "" }: { value: number | null | undefined; children: ReactNode; className?: string }) {
  const prev = useRef(value);
  const [cls, setCls] = useState("");
  useEffect(() => {
    if (prev.current != null && value != null && value !== prev.current) {
      setCls(value > prev.current ? "flash-up" : "flash-down");
      const t = setTimeout(() => setCls(""), 1200);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);
  return <span className={`${className} ${cls}`}>{children}</span>;
}

// ── Micro charts ─────────────────────────────────────────────────────────

/** SVG sparkline. Colored by first→last direction unless `color` given. */
export function Spark({
  data,
  width = 72,
  height = 20,
  color,
  fill = true,
  baseline,
  strokeWidth = 1.25,
}: {
  data: (number | null | undefined)[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  /** Optional reference value drawn as a dotted line (e.g. avg cost). */
  baseline?: number | null;
  strokeWidth?: number;
}) {
  const gid = useId().replace(/:/g, "");
  const pts = data.filter((v): v is number => v != null && Number.isFinite(v));
  if (pts.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const all = baseline != null ? [...pts, baseline] : pts;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const x = (i: number) => (i / (pts.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const c = color ?? (pts[pts.length - 1] >= pts[0] ? "var(--up)" : "var(--down)");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ display: "block", overflow: "visible" }}>
      {fill && (
        <>
          <defs>
            <linearGradient id={`g${gid}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={c} stopOpacity={0.22} />
              <stop offset="100%" stopColor={c} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={`${d}L${x(pts.length - 1).toFixed(1)},${height}L${x(0).toFixed(1)},${height}Z`} fill={`url(#g${gid})`} />
        </>
      )}
      {baseline != null && (
        <line x1={0} x2={width} y1={y(baseline)} y2={y(baseline)} stroke="var(--ink-3)" strokeWidth={0.75} strokeDasharray="2 2" />
      )}
      <path d={d} fill="none" stroke={c} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1])} r={1.6} fill={c} />
    </svg>
  );
}

/** 52-week (or any) low→high range with a marker at `pos` (0..1). */
export function RangeBar({ pos, width = 64, title }: { pos: number | null | undefined; width?: number; title?: string }) {
  const p = pos == null ? null : Math.max(0, Math.min(1, pos));
  return (
    <span title={title} style={{ display: "inline-block", position: "relative", width, height: 10, verticalAlign: "middle" }}>
      <span style={{ position: "absolute", left: 0, right: 0, top: 4.5, height: 1, background: "var(--line-2)" }} />
      <span style={{ position: "absolute", left: 0, top: 2, width: 1, height: 6, background: "var(--ink-4)" }} />
      <span style={{ position: "absolute", right: 0, top: 2, width: 1, height: 6, background: "var(--ink-4)" }} />
      {p != null && (
        <span
          style={{
            position: "absolute",
            left: `calc(${(p * 100).toFixed(1)}% - 1.5px)`,
            top: 0,
            width: 3,
            height: 10,
            // Position in range is not a direction — neutral marker; callers
            // print the percentile next to it when it matters.
            background: "var(--ink)",
          }}
        />
      )}
    </span>
  );
}

/** Horizontal bar for weights / loads: 0..1 of `max`, optional cap marker. */
export function Bar({ value, max = 1, cap, color = "var(--blue)", width = 80, height = 6 }: { value: number; max?: number; cap?: number; color?: string; width?: number | string; height?: number }) {
  const pct = Math.max(0, Math.min(1, value / max));
  return (
    <span style={{ display: "inline-block", position: "relative", width, height, background: "var(--bg-3)", verticalAlign: "middle" }}>
      <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct * 100}%`, background: color }} />
      {cap != null && (
        <span style={{ position: "absolute", top: -2, bottom: -2, width: 1, left: `${Math.min(1, cap / max) * 100}%`, background: "var(--warn)" }} />
      )}
    </span>
  );
}

/**
 * Diverging heat color for a fractional change. ±`scale` saturates.
 * Returns a background + readable text color.
 */
export function heat(pct: number | null | undefined, scale = 0.03): { bg: string; fg: string } {
  if (pct == null || !Number.isFinite(pct)) return { bg: "var(--bg-2)", fg: "var(--ink-3)" };
  const t = Math.max(-1, Math.min(1, pct / scale));
  const a = Math.abs(t);
  if (a < 0.04) return { bg: "#141a21", fg: "var(--ink-2)" };
  // Interpolate from a dark neutral to the saturated status color.
  const [r, g, b] = t > 0 ? [18, 168, 92] : [214, 52, 52];
  const base = [16, 21, 27];
  const k = 0.18 + 0.82 * Math.pow(a, 0.8);
  const mix = (i: number) => Math.round(base[i] + ([r, g, b][i] - base[i]) * k);
  return { bg: `rgb(${mix(0)},${mix(1)},${mix(2)})`, fg: k > 0.55 ? "#fff" : "var(--ink)" };
}

// ── Bot health ───────────────────────────────────────────────────────────

/** The bot runs a routine every weekday morning, so no LLM routine for ~3.5
 *  days (covers a weekend + holiday) means it has stopped. One rule for every
 *  panel that says "is the bot alive / are synthetic stops enforced?". */
export const BOT_STALE_MS = 84 * 3600 * 1000;

// ── Loading / empty ──────────────────────────────────────────────────────

export function Skeleton({ rows = 6, height = 18 }: { rows?: number; height?: number }) {
  return (
    <div style={{ display: "grid", gap: 6, padding: 8 }} aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skel" style={{ height, opacity: 1 - i * 0.1 }} />
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="panel-empty">{children}</div>;
}

// ── Clock hook ───────────────────────────────────────────────────────────

/**
 * Current epoch ms, re-rendering every `everyMs`. Returns 0 on the server /
 * first client render so time-derived text never causes a hydration
 * mismatch — callers should treat 0 as "not yet known".
 */
export function useNow(everyMs = 1000): number {
  const clock = clockFor(everyMs);
  return useSyncExternalStore(clock.subscribe, clock.get, serverNow);
}

// One shared ticking clock per interval, so fifty panels asking for "now
// every 15s" share a single timer instead of fifty.
type Clock = { now: number; subs: Set<() => void>; id?: ReturnType<typeof setInterval>; subscribe: (cb: () => void) => () => void; get: () => number };
const clocks = new Map<number, Clock>();
const serverNow = () => 0;

function clockFor(everyMs: number): Clock {
  let c = clocks.get(everyMs);
  if (c) return c;
  const clock: Clock = {
    now: 0,
    subs: new Set(),
    get: () => clock.now,
    subscribe: (cb) => {
      clock.subs.add(cb);
      if (clock.id === undefined) {
        clock.now = Date.now();
        clock.id = setInterval(() => {
          clock.now = Date.now();
          clock.subs.forEach((f) => f());
        }, everyMs);
      }
      return () => {
        clock.subs.delete(cb);
        if (!clock.subs.size && clock.id !== undefined) {
          clearInterval(clock.id);
          clock.id = undefined;
        }
      };
    },
  };
  c = clock;
  clocks.set(everyMs, c);
  return c;
}

/** NYSE session state from a wall clock (holidays not modeled here). */
export function marketSession(now: number): { label: string; tone: "up" | "warn" | "flat"; detail: string } {
  if (!now) return { label: "—", tone: "flat", detail: "" };
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  const mins = (parseInt(get("hour"), 10) % 24) * 60 + parseInt(get("minute"), 10);
  const weekend = wd === "Sat" || wd === "Sun";
  const fmt = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  // Minutes to the next 09:30 ET weekday open (holidays not modelled).
  const toOpen = () => {
    if (mins < 570) return 570 - mins;
    const days = wd === "Fri" ? 3 : 1;
    return (1440 - mins) + (days - 1) * 1440 + 570;
  };
  if (weekend) return { label: "Closed", tone: "flat", detail: "opens Mon 09:30" };
  if (mins >= 570 && mins < 960) return { label: "Open", tone: "up", detail: `${fmt(960 - mins)} to close` };
  if (mins >= 240 && mins < 570) return { label: "Pre-mkt", tone: "warn", detail: `opens in ${fmt(570 - mins)}` };
  const open = toOpen();
  const detail = open < 1440 ? `opens in ${fmt(open)}` : "opens Mon 09:30";
  if (mins >= 960 && mins < 1200) return { label: "After-hrs", tone: "warn", detail };
  return { label: "Closed", tone: "flat", detail };
}
