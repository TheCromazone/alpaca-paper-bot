"use client";

/**
 * BRIEF — the intelligence brief (our answer to Bloomberg's ASKB): what an
 * analyst would tell you about the book right now.
 *
 *  · header: labelled severity counts (BREACH / ACT / WATCH / INFO = ALL)
 *  · kicker: bot state first (an alert pill when off / stale), then the age
 *    of the book data — dimmed when older than a trading day
 *  · hero: the book's session move, sign-colored; vs SPY as muted context
 *  · ALL lists EVERY breach as a one-line row (ticker · status · to stop ·
 *    $ past), then one line each for events, performance, macro, flow and
 *    the bot (with its age and a "+N" to open the rest).
 *  · RISK: single-line header; each guard on two lines — LAST · P&L ·
 *    STATUS, then a labelled line (wt · to cut · to stop · $ past).
 *
 * Status ≠ direction: action states use --alert pills (solid = the broker
 * stop didn't fill, outlined = a manual sell is due), watch / scheduled
 * states --warn pills. Distances are ink numbers in a state-tinted cell
 * (alert when through the level, warn within 2%). Green/red only ever mark
 * the sign of a number (P&L, the book, vs SPY).
 * One marker system: every row carries its severity mark (■ breach, ○ act,
 * ■ watch in warn, □ info).
 * The list never ends mid-line: rows that don't fit fold into "+N more".
 */
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, term, type BriefItem } from "@/lib/api";
import { fmtAge, fmtChg, fmtPx } from "@/lib/format";
import { Empty, Panel, Skeleton, useNow } from "./ui";
import s from "./Brief.module.css";

type Kind = BriefItem["kind"];
/** Section order: what needs action first. */
const KINDS: { kind: Kind; tag: string; name: string }[] = [
  { kind: "risk", tag: "RISK", name: "Risk guards" },
  { kind: "catalyst", tag: "EVTS", name: "Events / earnings" },
  { kind: "perf", tag: "PERF", name: "Performance" },
  { kind: "macro", tag: "MACRO", name: "Macro regime" },
  { kind: "flow", tag: "FLOW", name: "Insider flow" },
  { kind: "bot", tag: "BOT", name: "The machine" },
];
const RANK = new Map(KINDS.map((k, i) => [k.kind, i]));
const TAG = new Map(KINDS.map((k) => [k.kind, k.tag]));

/** Round-7 fields the shared type may not carry yet (built defensively). */
type Metrics = NonNullable<BriefItem["metrics"]> & {
  guard_kind?: "stop" | "cut" | string | null;
  guard_price?: number | null;
  guard_distance?: number | null;
  stop_enforced_by?: string | null;
  reason?: string | null;
};
const metricsOf = (it: BriefItem): Metrics => (it.metrics ?? {}) as Metrics;
/** Distance to the binding guard (same as PORT's GUARD/DIST). */
const guardDist = (m: Metrics) => m.guard_distance ?? (m.stop_distance != null && m.cut_distance != null ? Math.min(m.stop_distance, m.cut_distance) : (m.stop_distance ?? m.cut_distance ?? null));

/** Rank within a severity tier: $ already through the tightest breached
 *  guard (value × depth), then position size. */
const rankKey = (it: BriefItem): [number, number] => [metricsOf(it).usd_beyond ?? 0, metricsOf(it).market_value ?? 0];


type Sev = 0 | 1 | 2 | 3;
const SEV_LABEL = ["INFO", "WATCH", "ACT", "BREACH"] as const;

/** Severity from the API, falling back to tone for older payloads. */
function sevOf(it: BriefItem): Sev {
  const s0 = it.severity ?? 0;
  if (s0 > 0) return Math.min(3, s0) as Sev;
  if (it.kind === "perf" || it.kind === "flow" || it.kind === "bot") return 0;
  return it.tone === "warn" ? 1 : it.tone === "down" && it.kind === "risk" ? 2 : 0;
}

// ── markers ──────────────────────────────────────────────────────────────

/** One marker system: every row carries its severity square. */
function Marker({ it }: { it: BriefItem }) {
  return <SevMark sev={sevOf(it)} />;
}
function SevMark({ sev }: { sev: Sev }) {
  return <span className={`${s.mk} ${s[`sev${sev}`]}`} aria-label={SEV_LABEL[sev].toLowerCase()} title={SEV_LABEL[sev]} />;
}

// ── prose → tokens ───────────────────────────────────────────────────────

/** Ticker-shaped words, dollar amounts, percents, signed decimals. */
const TOKEN =
  /\b([A-Z]{1,5}(?:\.[A-Z])?)\b|((?<![\w.])[+\-−]?~?\$\d[\d,]*(?:\.\d+)?[KMB]?|(?<![\w.])[+\-−]?\d[\d,]*(?:\.\d+)?%|(?<![\w.])[+\-−]\d+\.\d+)/g;

function rich(text: string, tickers: Set<string>, own: string | null, color = true): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    const [whole, word, num] = m;
    if (word) {
      // Single letters only link when they are the item's own ticker (V, F…).
      if (!(word === own || (word.length > 1 && tickers.has(word)))) continue;
      if (i > last) out.push(text.slice(last, i));
      out.push(
        <Link key={k++} href={`/security/${encodeURIComponent(word)}`} className={s.t}>
          {word}
        </Link>,
      );
    } else if (num) {
      if (i > last) out.push(text.slice(last, i));
      const v = num.replace(/^-/, "−");
      const neg = v.startsWith("−");
      const pos = v.startsWith("+");
      // Color only P/L-shaped figures (signed $, signed % with decimals);
      // thresholds like "−7% cut" stay neutral.
      const pnl = color && (neg || pos) && (v.includes("$") || (v.includes("%") && v.includes(".")));
      out.push(
        <span key={k++} className={s.n} style={pnl ? { color: neg ? "var(--down)" : "var(--up)" } : undefined}>
          {v}
        </span>,
      );
    }
    last = i + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const tailOf = (text: string) => {
  const cut = text.indexOf(" — ");
  return cut < 0 ? null : text.slice(cut + 3);
};

/** "a · b · c" lists wrap only between items, never inside one. */
function segments(text: string, tickers: Set<string>, own: string | null): ReactNode {
  if (!text.includes(" · ")) return rich(text, tickers, own);
  const parts = text.split(" · ");
  return parts.map((p, i) => (
    <span key={i}>
      <span className={s.nowrap}>{rich(p, tickers, own)}</span>
      {i < parts.length - 1 ? " · " : ""}
    </span>
  ));
}

/** Fact bright, boilerplate tail (repeated, or on info lines) dimmed. */
function sentence(text: string, tickers: Set<string>, own: string | null, dimTail: boolean, wrapAtDots = true): ReactNode {
  // One-line clamps fill to the true edge; multi-line text wraps at " · ".
  const seg = (t: string) => (wrapAtDots ? segments(t, tickers, own) : rich(t, tickers, own));
  const cut = text.indexOf(" — ");
  if (cut < 0 || !dimTail) return seg(text);
  return (
    <>
      {seg(text.slice(0, cut))}
      <span className={s.aside}>
        {" — "}
        {seg(text.slice(cut + 3))}
      </span>
    </>
  );
}

/** When an item's fact happened / happens: ages read "3h ago", upcoming
 *  events read "in 1d" (or "today"), so a date is never mistaken for an age. */
function ageOf(at: string | null | undefined, now: number): { text: string; title: string; future: boolean } | null {
  if (!at || !now) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) {
    const [y, m, d] = at.split("-").map(Number);
    const today = new Date(now);
    const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const days = Math.round((Date.UTC(y, m - 1, d) - t0) / 86_400_000);
    if (days > 0) return { text: `in ${days}d`, title: `Scheduled for ${at}`, future: true };
    if (days === 0) return { text: "today", title: `Today, ${at}`, future: true };
    return { text: `${-days}d ago`, title: `${at} — ${-days} day${days < -1 ? "s" : ""} ago`, future: false };
  }
  const secs = (now - new Date(at).getTime()) / 1000;
  if (secs < 90) return { text: "now", title: at, future: false };
  return { text: `${fmtAge(at, now)} ago`, title: `${at} — ${fmtAge(at, now)} ago`, future: false };
}

// ── rows model (flat, so the list can end on whole rows) ─────────────────

type RowModel =
  | { type: "sec"; key: string; tag: string; text: string }
  | { type: "thead"; key: string }
  | { type: "bhead"; key: string; n: number }
  | { type: "bfoot"; key: string; n: number; names: string }
  | { type: "guard"; key: string; it: BriefItem }
  | { type: "breach"; key: string; it: BriefItem }
  | { type: "item"; key: string; it: BriefItem; tag?: string; more?: number }
  | { type: "kmore"; key: string; kind: Kind; n: number; text: string };

const MORE_H = 22;

/** Distance to a level → cell tint: through it = alert, within 2% = warn.
 *  The number itself stays ink: this is a state, not a P&L sign. */
const distTint = (d: number | null | undefined) => (d == null ? "" : d < 0 ? s.tAlert : d < 0.02 ? s.tWarn : "");

type Status = { main: string; short?: string; sub?: string; pill: "solid" | "alert" | "warn" | "plain" };

/** API action → status pill (round-7 vocabulary). Alert = nothing / no one
 *  is selling it yet; warn = the system will act, or a level is near.
 *    STOP UNFILLED    broker stop exists, hasn't filled     solid alert
 *    MANUAL SELL      nothing will sell it (`reason`)        outlined alert
 *    SELL @ next sync synthetic 5-min stop will sell         warn
 *    SELL @ midday    cut breached, routines active          warn
 *    WATCH cut|stop   within 2% of a level                   warn */
function status(action: string | undefined, reason?: string | null): Status {
  const a = (action ?? "").trim();
  const [main0, ...rest] = a.split(" · ");
  const main = main0.toUpperCase();
  const sub = rest.join(" · ") || reason || undefined;
  if (main.startsWith("STOP UNFILLED") || main.startsWith("STOP BREACHED") || main === "STOP")
    return { main: "STOP UNFILLED", short: "UNFILLED", sub: "broker stop placed, not filled", pill: "solid" };
  if (main.startsWith("MANUAL SELL")) return { main: "SELL MANUALLY", short: "SELL NOW", sub: sub ? `nothing will sell it — ${sub}` : "nothing will sell it", pill: "alert" };
  if (main.startsWith("SELL @ NEXT SYNC")) return { main: "SELLS @ SYNC", short: "@ SYNC", sub: "the 5-min synthetic stop will sell", pill: "warn" };
  if (main.startsWith("SELL @ MIDDAY")) return { main: "SELL @ MIDDAY", short: "MIDDAY", sub: "cut breached — the midday routine sells", pill: "warn" };
  if (main.startsWith("SELL")) return { main, sub, pill: "warn" };
  if (main.startsWith("WATCH")) {
    const what = main.replace(/^WATCH\s*/, "");
    return { main: `WATCH ${what}`.trim(), short: "WATCH", sub: `within 2% of the ${what.toLowerCase() || "guard"}`, pill: "warn" };
  }
  return { main: main || "—", sub, pill: "plain" };
}

// ── component ────────────────────────────────────────────────────────────

export function Brief({ className = "", style }: { className?: string; style?: CSSProperties }) {
  const [only, setOnly] = useState<Kind | "all">("all");
  const [expanded, setExpanded] = useState(false);
  const now = useNow(15_000);
  const { data, isLoading, isError } = useQuery({ queryKey: ["brief"], queryFn: term.brief, refetchInterval: 60_000 });
  const { data: universe } = useQuery({ queryKey: ["universe"], queryFn: term.universe, refetchInterval: 300_000, staleTime: 120_000 });
  const { data: summary } = useQuery({ queryKey: ["summary"], queryFn: api.summary, refetchInterval: 15_000 });
  const { data: bot } = useQuery({ queryKey: ["bot-status"], queryFn: api.botStatus, refetchInterval: 30_000 });
  const tickers = useMemo(() => new Set((universe ?? []).map((u) => u.ticker)), [universe]);

  const items = useMemo(() => {
    if (!data) return [];
    // The headline is the first perf line verbatim — don't say it twice.
    return data.items
      .filter((it) => it.text.trim() !== data.headline.trim())
      .map((it, i) => ({ it, i }))
      .sort((a, b) => (RANK.get(a.it.kind) ?? 99) - (RANK.get(b.it.kind) ?? 99) || a.i - b.i)
      .map((x) => x.it);
  }, [data]);

  const kindCount = useMemo(() => {
    const c = new Map<Kind, number>();
    for (const it of items) c.set(it.kind, (c.get(it.kind) ?? 0) + 1);
    return c;
  }, [items]);
  // The API's `counts` are the single truth (the top bar uses them too);
  // fall back to counting items (headline included) for older payloads.
  const sevCount = useMemo(() => {
    const k = data?.counts;
    if (k) return [k.info, k.watch, k.act, k.breach];
    const c = [0, 0, 0, 0];
    for (const it of data?.items ?? []) c[sevOf(it)]++;
    return c;
  }, [data]);
  const allN = sevCount.reduce((a, b) => a + b, 0);
  const tailCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) {
      const t = tailOf(it.text);
      if (t) m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  }, [items]);

  const [listH, setListH] = useState(0);
  // When ALL overflows, wrapped info lines drop to one line — lowest
  // priority first, only as many as needed — before anything is hidden.
  const [clampSt, setClampSt] = useState<{ key: string; keys: string[] } | null>(null);
  const capKey = `${data?.as_of}|${only}|${tickers.size}|${listH}`;
  const clamped = new Set(clampSt?.key === capKey ? clampSt.keys : []);

  const rows: RowModel[] = useMemo(() => {
    const out: RowModel[] = [];
    const risk = items.filter((it) => it.kind === "risk");
    const guards = risk
      .filter((it) => it.metrics && it.ticker)
      .sort((a, b) => sevOf(b) - sevOf(a) || rankKey(b)[0] - rankKey(a)[0] || rankKey(b)[1] - rankKey(a)[1]);
    const notes = risk.filter((it) => !(it.metrics && it.ticker));
    const riskText = () => {
      const by = [3, 2, 1].map((sv) => [sv, guards.filter((g) => sevOf(g) === sv).length] as const).filter(([, n]) => n);
      const parts = by.map(([sv, n]) => `${n} ${SEV_LABEL[sv].toLowerCase()}`);
      return `${guards.length} guards${parts.length ? ` (${parts.join(", ")})` : ""}${notes.length ? ` + ${notes.length} note` : ""}`;
    };
    if (only === "all") {
      // Digest: every kind on one screen.
      if (risk.length) {
        // Every breach (and act) gets a one-line row; the rest fold to "+N".
        const urgent = guards.filter((g) => sevOf(g) >= 2);
        const restN = risk.length - urgent.length;
        const names = `${guards.filter((g) => sevOf(g) < 2).map((g) => g.ticker).join(" ")}${notes.length ? " · slots note" : ""}`.trim();
        out.push({ type: "bhead", key: "bhead", n: urgent.length });
        urgent.forEach((it, i) => out.push({ type: "breach", key: `b-${it.ticker}-${i}`, it }));
        if (restN > 0) out.push({ type: "bfoot", key: "bfoot", n: restN, names });
      }
      for (const k of KINDS) {
        if (k.kind === "risk") continue;
        const list = items.filter((it) => it.kind === k.kind);
        if (!list.length) continue;
        const top = [...list].sort((a, b) => sevOf(b) - sevOf(a))[0];
        out.push({ type: "item", key: `d-${k.kind}`, it: top, tag: k.tag, more: list.length - 1 });
      }
      return out;
    }
    const k = KINDS.find((x) => x.kind === only)!;
    const list = items.filter((it) => it.kind === only);
    if (only === "risk") {
      out.push({ type: "sec", key: "sec-risk", tag: k.tag, text: riskText() });
      if (guards.length) out.push({ type: "thead", key: "thead" });
      guards.forEach((it, i) => out.push({ type: "guard", key: `g-${it.ticker}-${i}`, it }));
      notes.forEach((it, i) => out.push({ type: "item", key: `rn-${i}`, it }));
    } else {
      out.push({ type: "sec", key: `sec-${k.kind}`, tag: k.tag, text: `${list.length} ${list.length === 1 ? "item" : "items"}` });
      list.forEach((it, i) => out.push({ type: "item", key: `${k.kind}-${i}`, it }));
    }
    return out;
  }, [items, only]);

  // ── fit: end on whole rows, never mid-line ──
  const listEl = useRef<HTMLDivElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const listRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    listEl.current = el;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setListH(Math.round(e.contentRect.height)));
    ro.observe(el);
    roRef.current = ro;
  }, []);
  const fitKey = `${data?.as_of}|${only}|${listH}|${rows.length}|${tickers.size}|${[...clamped].join(",")}`;
  const [fit, setFit] = useState<{ key: string; from: number } | null>(null);
  useLayoutEffect(() => {
    const el = listEl.current;
    if (!el || expanded || (fit && fit.key === fitKey)) return;
    const top = el.getBoundingClientRect().top;
    const kids = [...el.querySelectorAll<HTMLElement>("[data-row]")];
    const bottom = (r: HTMLElement) => r.getBoundingClientRect().bottom - top;
    const over = kids.length > 0 && bottom(kids[kids.length - 1]) > el.clientHeight + 0.5;
    // In ALL: clamp the next wrapped info line (info → watch → act; bottom
    // rows first) before hiding anything.
    if (over && only === "all") {
      const cands = [...el.querySelectorAll<HTMLElement>("[data-clamp]")]
        .filter((r) => r.dataset.noclamp == null && !clamped.has(r.dataset.clamp!) && (r.querySelector<HTMLElement>("[data-text]")?.offsetHeight ?? 0) > 20)
        .sort((a, b) => Number(a.dataset.prio) - Number(b.dataset.prio));
      if (cands.length) {
        setClampSt({ key: capKey, keys: [...clamped, cands[0].dataset.clamp!] });
        return;
      }
    }
    let from = kids.length;
    if (over) {
      const limit = el.clientHeight - MORE_H;
      from = kids.findIndex((r) => bottom(r) > limit);
      // Never leave a section or table header orphaned at the bottom.
      while (from > 0 && kids[from - 1].dataset.row !== "body") from--;
    }
    setFit({ key: fitKey, from });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `clamped` is encoded in fitKey
  }, [fitKey, fit, expanded, only, capKey]);
  const cutFrom = !expanded && fit && fit.key === fitKey ? fit.from : Infinity;
  const hiddenRows = rows.slice(cutFrom).filter((r): r is Extract<RowModel, { it: BriefItem }> => r.type === "guard" || r.type === "breach" || r.type === "item");
  const hiddenItems = hiddenRows.length;

  const pick = (k: Kind | "all") => {
    setOnly(k);
    setExpanded(false);
  };

  const rel = data?.rel_spy_1d;
  const relTxt =
    rel == null ? null : Math.abs(rel) < 0.01 ? `${rel > 0 ? "+" : rel < 0 ? "−" : ""}${Math.abs(rel * 10000).toFixed(Math.abs(rel) < 0.001 ? 1 : 0)}bp` : fmtChg(rel);
  // "Book −$117 (−0.22%) vs SPY −0.24%." → book move (hero), SPY context.
  const head = (data?.headline ?? "").replace(/\s+on the session\b/i, "");
  const vsM = head.match(/^(.*?)\s+vs\s+SPY\s+(.+?)\.?$/);
  const heroTxt = (vsM ? vsM[1] : head).replace(/\.$/, "");
  const heroM = heroTxt.match(/^(Book)\s+(.*)$/);
  const heroSign = /[−-]\$|\(−|\(-/.test(heroTxt) ? "down" : /\+\$|\(\+/.test(heroTxt) ? "up" : "";
  const botState = data?.bot;
  const botAt = botState?.last_run_at ?? bot?.last_llm_run?.started_at ?? null;
  const botAgeDays = botAt && now ? (now - new Date(botAt).getTime()) / 86_400_000 : 0;
  const botLabel = botState
    ? botState.active
      ? "bot live"
      : botState.routines_enabled === false
        ? "bot off"
        : botState.stale
          ? "bot stale"
          : "bot idle"
    : botAgeDays > 2
      ? "bot stale"
      : "bot";
  const botWarn = botState ? !botState.active : botAgeDays > 2;
  const bookAsOf = summary?.as_of;
  // Older than one trading day (≈ 3 calendar days across a weekend) → dim.
  const bookAgeH = bookAsOf && now ? (now - new Date(bookAsOf).getTime()) / 3_600_000 : 0;
  const bookStale = bookAgeH > (new Date(now || 0).getUTCDay() === 1 ? 72 : 26);

  return (
    <Panel
      code="BRIEF"
      title="Intelligence"
      className={className}
      style={style}
      flush
      testId="brief"
      actions={
        data ? (
          <span className={s.counts} aria-label="Items by severity">
            {([3, 2, 1, 0] as Sev[]).map((sv) =>
              sevCount[sv] ? (
                <span key={sv} className={`${s.count}${sv === 0 ? ` ${s.countInfo}` : ""}`} title={`${sevCount[sv]} ${SEV_LABEL[sv].toLowerCase()}`}>
                  <SevMark sev={sv} />
                  <b>{sevCount[sv]}</b>
                  {SEV_LABEL[sv]}
                </span>
              ) : null,
            )}
          </span>
        ) : undefined
      }
    >
      {isLoading ? (
        <Skeleton rows={8} height={16} />
      ) : isError ? (
        <Empty>Brief unavailable — API did not respond.</Empty>
      ) : !data || (!data.headline && !items.length) ? (
        <Empty>Nothing to brief yet — no positions, guards or catalysts on file.</Empty>
      ) : (
        <div className={s.wrap}>
          <div className={s.lead}>
            <div className={s.kicker}>
              <span
                className={`pill ${botWarn ? "alert" : "up"} ${s.botPill}`}
                title={`Routines ${botState?.routines_enabled === false ? "disabled in the bot's config" : "enabled"}${botAt ? ` · last LLM routine ${botAt}` : ""}`}
              >
                {botLabel.toUpperCase()}
              </span>
              {botAt && <span className={botWarn ? s.stale : undefined}>last ran {now ? `${fmtAge(botAt, now)} ago` : "—"}</span>}
              {bookAsOf && (
                <span className={bookStale ? s.stale : s.age} title={`Newest portfolio snapshot ${bookAsOf}${bookStale ? " — older than one trading day" : ""}`}>
                  · book data {now ? `${fmtAge(bookAsOf, now)} old` : "—"}
                </span>
              )}
            </div>
            <p className={`${s.headline} ${bookStale ? s.heroStale : ""}`}>
              <span className={s.nowrap}>
                {heroM ? (
                  <>
                    <span className={s.heroLab}>{heroM[1]} </span>
                    <span className={bookStale ? "" : heroSign}>{heroM[2].replace(/-/g, "−")}</span>
                  </>
                ) : (
                  rich(heroTxt, tickers, null, false)
                )}
              </span>
              {vsM && (
                <span className={s.vs} title="SPY's session move, and the book's return minus SPY's (one session)">
                  vs SPY {vsM[2].replace(/^-/, "−")}
                  {relTxt && (
                    <>
                      {" · "}
                      <span className={rel! > 0 ? "up" : rel! < 0 ? "down" : ""}>{relTxt}</span> (1d)
                    </>
                  )}
                </span>
              )}
            </p>
          </div>

          <div className={s.filters} role="group" aria-label="Filter brief by kind">
            <button type="button" className={s.chip} aria-pressed={only === "all"} onClick={() => pick("all")} title="Digest of every kind">
              ALL <span className={s.chipN}>{allN}</span>
            </button>
            {KINDS.filter((k) => kindCount.get(k.kind)).map((k) => (
              <button key={k.kind} type="button" className={s.chip} aria-pressed={only === k.kind} onClick={() => pick(only === k.kind ? "all" : k.kind)} title={k.name}>
                {k.tag} <span className={s.chipN}>{kindCount.get(k.kind)}</span>
              </button>
            ))}
          </div>

          <div ref={listRef} className={`${s.list} ${expanded ? s.scroll : ""}`}>
            {rows.map((r, idx) => {
              const hide = idx >= cutFrom ? { display: "none" } : undefined;
              if (r.type === "sec")
                return (
                  <div key={r.key} data-row="head" className={s.sec} style={hide}>
                    <span className={s.secTag}>{r.tag}</span>
                    <span className={s.secN}>{r.text}</span>
                    <span className={s.secRule} />
                  </div>
                );
              if (r.type === "thead")
                return (
                  <div key={r.key} data-row="head" className={`${s.gt} ${s.gthead}`} style={hide}>
                    <span />
                    <span title="Ticker">TKR</span>
                    <span className={s.r} title="Last price">
                      LAST
                    </span>
                    <span className={s.r} title="Unrealized P&L on cost, $ and %">
                      P&amp;L
                    </span>
                    <span
                      className={s.stHead}
                      title="STOP UNFILLED (solid) = the trailing stop was breached but the broker order didn't fill; SELL MANUALLY (outlined) = below the −7% cut and the bot is off; WATCH = near a level"
                    >
                      STATUS
                    </span>
                  </div>
                );
              if (r.type === "bhead")
                return (
                  <div key={r.key} data-row="head" className={`${s.bt} ${s.bthead}`} style={hide}>
                    <span className={s.btag} title={`${r.n} position${r.n === 1 ? "" : "s"} through a guard`}>
                      RISK
                    </span>
                    <span title="SELL MANUALLY (outlined) = nothing will sell it; STOP UNFILLED (solid) = a broker stop exists but hasn't filled; SELL @ MIDDAY / SELLS @ SYNC (warn) = the bot will sell">
                      STATUS
                    </span>
                    <span className={s.r} title="Last price vs the binding guard (the tighter of the 10% trailing stop and the −7% cut) — same as PORT's DIST. Negative = already through it.">
                      TO GUARD
                    </span>
                    <span className={`${s.r} ${s.sorted}`} title="Sorted by this column, largest first: $ value below the binding guard = (guard − last) × shares">
                      $ BELOW ▾
                    </span>
                    <span className={s.r} title="Position weight in the book">
                      WT
                    </span>
                  </div>
                );
              if (r.type === "bfoot")
                return (
                  <button key={r.key} type="button" data-row="body" className={s.bfoot} style={hide} onClick={() => pick("risk")} title={`${r.n} more risk items: ${r.names}`}>
                    <span>+{r.n} more risk</span>
                    <span className={s.bfootNames}>{r.names}</span>
                    <span className={s.go}>→</span>
                  </button>
                );
              if (r.type === "breach") return <BreachRow key={r.key} it={r.it} style={hide} />;
              if (r.type === "guard") return <GuardRow key={r.key} it={r.it} style={hide} />;
              if (r.type === "kmore")
                return (
                  <button key={r.key} type="button" data-row="body" className={s.kmore} style={hide} onClick={() => pick(r.kind)}>
                    +{r.n} more {TAG.get(r.kind)?.toLowerCase()}
                    {r.text && <span className={s.kmoreList}>{r.text}</span>}
                    <span className={s.go}>→</span>
                  </button>
                );
              const it = r.it;
              const dim = it.tone === "info" || (tailCount.get(tailOf(it.text) ?? "") ?? 0) > 1;
              const at = (it as BriefItem & { at?: string | null }).at;
              const age = ageOf(at, now);
              // The age column already dates a disclosure: don't say it twice.
              const text = r.tag && at ? it.text.replace(/,\s*disclosed [A-Z][a-z]{2} \d{1,2}\.?$/, ".") : it.text;
              const lines = r.tag ? (clamped.has(r.key) ? s.clamp1 : s.clamp2) : "";
              // Clamp priority: info before watch before act; lower rows first.
              const prio = sevOf(it) * 100 - idx;
              return (
                <div
                  key={r.key}
                  data-row="body"
                  data-clamp={r.tag ? r.key : undefined}
                  data-noclamp={it.kind === "catalyst" || it.kind === "macro" ? "" : undefined}
                  data-prio={prio}
                  className={`${s.item}${r.tag ? ` ${s.digest}` : ""}`}
                  style={hide}
                >
                  {r.tag && <span className={s.dtag}>{r.tag}</span>}
                  <Marker it={it} />
                  <span data-text className={`${s.text}${sevOf(it) >= 1 ? ` ${s.strong}` : ""} ${lines}`} title={r.tag ? it.text : undefined}>
                    {sentence(text, tickers, it.ticker, dim, lines !== s.clamp1)}
                  </span>
                  <span className={`${s.ageCell} ${age?.future ? s.ageFuture : ""}`} title={age?.title}>
                    {age?.text ?? ""}
                  </span>
                  {r.tag &&
                    (r.more ? (
                      <button type="button" className={s.dmore} onClick={() => pick(it.kind)} title={`Show all ${TAG.get(it.kind)}`}>
                        +{r.more}
                      </button>
                    ) : (
                      <span className={s.dmoreGap} />
                    ))}
                </div>
              );
            })}
            {hiddenItems > 0 && (
              <button type="button" className={s.more} onClick={() => setExpanded(true)}>
                +{hiddenItems} more <span className={s.moreGo}>show ↓</span>
              </button>
            )}
            {expanded && (
              <button type="button" className={s.more} onClick={() => setExpanded(false)}>
                show less ↑
              </button>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

const fmtUsd0 = (v: number | null | undefined) => (v == null ? "—" : `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(0)}`);
const sign = (v: number | null | undefined) => (v == null ? "" : v > 0 ? "up" : v < 0 ? "down" : "");

function Pill({ st }: { st: Status }) {
  return (
    <span className={`pill ${st.pill === "solid" ? `alert ${s.solid}` : st.pill === "plain" ? "" : st.pill} ${s.stPill}`}>
      <span className={st.short ? s.pillLong : undefined}>{st.main}</span>
      {st.short && <span className={s.pillShort}>{st.short}</span>}
    </span>
  );
}

/** RISK tab: two lines — LAST · P&L · STATUS, then a labelled detail line. */
function GuardRow({ it, style }: { it: BriefItem; style?: CSSProperties }) {
  const m = metricsOf(it);
  const t = it.ticker ?? "";
  const st = status(m.action, m.reason);
  const gd = guardDist(m);
  return (
    <Link href={`/security/${encodeURIComponent(t)}`} data-row="body" className={`${s.gt} ${s.grow}`} style={style} title={it.text}>
      <SevMark sev={sevOf(it)} />
      <span className={s.gtkr}>{t}</span>
      <span className={s.r}>{fmtPx(m.last)}</span>
      <span className={`${s.r} ${sign(m.pnl_usd)}`}>
        {fmtUsd0(m.pnl_usd)} <span className={s.pnlPct}>{fmtChg(m.pnl_pct, 1)}</span>
      </span>
      <span className={s.st} title={st.sub}>
        <Pill st={st} />
      </span>
      <span className={s.detail}>
        <span>wt {m.weight != null ? `${(m.weight * 100).toFixed(1)}%` : "—"}</span>
        <span
          title={`Binding guard: ${m.guard_kind ?? "—"} at ${fmtPx(m.guard_price)} (same as PORT's DIST)\n−7% cut ${fmtPx(m.cut_price)} (${fmtChg(m.cut_distance, 1)}) · 10% trailing stop ${fmtPx(m.stop_price)} (${fmtChg(m.stop_distance, 1)})`}
        >
          to {m.guard_kind ?? "guard"} <b className={distTint(gd)}>{fmtChg(gd, 1)}</b>
        </span>
        {m.usd_beyond ? (
          <span>
            <b className={s.tAlert}>${Math.round(m.usd_beyond)}</b> below guard
          </span>
        ) : null}
        {m.reason && <span className={s.why}>{m.reason}</span>}
      </span>
    </Link>
  );
}

/** ALL view: one line per breach — TKR · STATUS · TO GUARD · $ BELOW · WT. */
function BreachRow({ it, style }: { it: BriefItem; style?: CSSProperties }) {
  const m = metricsOf(it);
  const t = it.ticker ?? "";
  const st = status(m.action, m.reason);
  const gd = guardDist(m);
  return (
    <Link
      href={`/security/${encodeURIComponent(t)}`}
      data-row="body"
      className={`${s.bt} ${s.brow}`}
      style={style}
      title={`${it.text}\nLast ${fmtPx(m.last)} · P&L ${fmtUsd0(m.pnl_usd)} ${fmtChg(m.pnl_pct, 1)} · ${m.guard_kind ?? "guard"} ${fmtPx(m.guard_price)}`}
    >
      <span className={s.bname}>
        <SevMark sev={sevOf(it)} />
        <span className={s.gtkr}>{t}</span>
      </span>
      <span className={s.st} title={st.sub}>
        <Pill st={st} />
      </span>
      <span className={`${s.r} ${s.cell} ${distTint(gd)}`} title={m.guard_kind ? `binding guard: ${m.guard_kind} at ${fmtPx(m.guard_price)}` : undefined}>
        {fmtChg(gd, 1)}
        {m.guard_kind && <i className={s.gk}>{m.guard_kind}</i>}
      </span>
      <span className={`${s.r} ${s.cell} ${m.usd_beyond ? s.tAlert : ""}`}>{m.usd_beyond ? `$${Math.round(m.usd_beyond)}` : "—"}</span>
      <span className={`${s.r} ${s.wt}`}>{m.weight != null ? `${(m.weight * 100).toFixed(1)}%` : "—"}</span>
    </Link>
  );
}
