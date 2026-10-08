"use client";

/**
 * BOT — the machine. Operations console for the LLM trading bot: liveness,
 * next-routine countdown over the full ET schedule, LLM spend vs budget and
 * the routine log with per-run summary + tool-call trace. `variant="page"`
 * adds the routine×day activity matrix and tool-usage stats (/bot).
 */
import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type BotStatus, type LLMRunRow, type RoutinesNext } from "@/lib/api";
import { fmtAge, fmtBig, fmtET } from "@/lib/format";
import { BOT_STALE_MS, Empty, Panel, Skeleton, useNow } from "./ui";
import s from "./BotPanel.module.css";

// ── schedule (mirrors bot/main.py; times are America/New_York) ───────────

const ROUTINES = [
  { name: "premarket", hh: 7, mm: 0, fri: false, role: "research", rule: "research only · no orders" },
  { name: "execute", hh: 9, mm: 30, fri: false, role: "buy window", rule: "buys ≤5% · 2 new names/day" },
  { name: "midday", hh: 13, mm: 0, fri: false, role: "sell window", rule: "sells ≥7% under cost" },
  { name: "close", hh: 16, mm: 0, fri: false, role: "log P/L", rule: "logs day P/L" },
  { name: "weekly_review", hh: 17, mm: 0, fri: true, role: "review", rule: "post-mortem · proposals" },
] as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── ET helpers (no hydration risk: only called with real timestamps) ────

const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function etParts(ms: number) {
  const p = ET_FMT.formatToParts(new Date(ms));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return {
    key: `${g("year")}-${g("month")}-${g("day")}`,
    wd: g("weekday"),
    mins: (parseInt(g("hour"), 10) % 24) * 60 + parseInt(g("minute"), 10),
  };
}

/** "2026-07-20" → "MON JUL 20" without any timezone shift. */
function dayLabel(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = dt.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" });
  const mo = dt.toLocaleDateString("en-US", { timeZone: "UTC", month: "short" });
  return `${wd} ${mo} ${String(d).padStart(2, "0")}`.toUpperCase();
}

const pad = (n: number) => String(n).padStart(2, "0");

function fmtCountdown(sec: number) {
  const t = Math.max(0, Math.floor(sec));
  const d = Math.floor(t / 86400);
  const hms = `${pad(Math.floor((t % 86400) / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
  return d ? `${d}d ${hms}` : hms;
}

function durSec(r: LLMRunRow) {
  if (!r.finished_at) return null;
  return Math.max(0, (new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000);
}

const fmtDur = (sec: number | null) =>
  sec == null ? "—" : sec < 90 ? `${Math.round(sec)}s` : `${Math.floor(sec / 60)}m${pad(Math.round(sec % 60))}`;

const fmtETs = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

const fmtCost = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);

// Status ≠ direction: action states use --alert, never --down.
const STATUS: Record<string, { c: string; label: string; glyph: string }> = {
  ok: { c: "var(--ink-3)", label: "ok", glyph: "✓" },
  failed: { c: "var(--alert)", label: "failed", glyph: "!" },
  budget_halt: { c: "var(--alert)", label: "budget halt", glyph: "!" },
  skipped: { c: "var(--ink-4)", label: "skipped", glyph: "–" },
  running: { c: "var(--cyan)", label: "running", glyph: "●" },
};
const statusOf = (st: string) => STATUS[st] ?? { c: "var(--ink-3)", label: st, glyph: "?" };

function argSummary(args: Record<string, unknown>) {
  return Object.entries(args ?? {})
    .map(([k, v]) => {
      const raw = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${raw.length > 26 ? `${raw.slice(0, 24)}…` : raw}`;
    })
    .join(" ");
}

// ── Markdown-ish renderer (summaries, memory docs) ───────────────────────

type MdBlock =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "note"; text: string }
  | { t: "li"; depth: number; num?: string; text: string }
  | { t: "hr" }
  | { t: "table"; head: string[]; right: boolean[]; rows: string[][] };

function splitRow(line: string) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

export function parseMd(src: string): MdBlock[] {
  const lines = src.replace(/\r/g, "").split("\n");
  const out: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    const text = para.join(" ").trim();
    if (/^_.*_$/.test(text) && text.length > 2) out.push({ t: "note", text: text.slice(1, -1) });
    else if (text) out.push({ t: "p", text });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ t: "h", level: h[1].length, text: h[2] });
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flush();
      out.push({ t: "hr" });
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      i--;
      const head = splitRow(rows[0]);
      const sep = rows[1] && /^[\s|:-]+$/.test(rows[1]) ? splitRow(rows[1]) : null;
      const body = rows.slice(sep ? 2 : 1).map(splitRow);
      out.push({ t: "table", head, right: head.map((_, j) => !!sep?.[j]?.endsWith(":")), rows: body });
      continue;
    }
    const li = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      out.push({ t: "li", depth: Math.min(2, Math.floor(li[1].length / 2)), num: li[3] ? `${li[3]}.` : undefined, text: li[4] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // Indented continuation of the previous bullet.
    const prev = out[out.length - 1];
    if (!para.length && prev?.t === "li" && /^\s+\S/.test(line)) {
      prev.text += ` ${line.trim()}`;
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out;
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s<>()]*[^\s<>().,;:'"\]])/g;
const TICKER_RE = /^[A-Z]{1,5}(\.[A-Z])?$/;

function inline(text: string, kp: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  // Fresh regex per call: `inline` recurses for bold spans, and a shared
  // global regex would have its lastIndex reset underneath the outer loop.
  const re = new RegExp(INLINE.source, "g");
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${kp}-${i++}`;
    if (tok.startsWith("**")) {
      const inner = tok.slice(2, -2);
      out.push(
        TICKER_RE.test(inner) ? (
          <Link key={key} href={`/security/${encodeURIComponent(inner)}`} className={s.tick}>
            {inner}
          </Link>
        ) : (
          <strong key={key}>{inline(inner, key)}</strong>
        ),
      );
    } else if (tok.startsWith("`")) {
      out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    } else {
      let host = tok;
      try {
        host = new URL(tok).hostname.replace(/^www\./, "");
      } catch {
        /* keep raw */
      }
      out.push(
        <a key={key} href={tok} target="_blank" rel="noopener noreferrer" className={s.url} title={tok}>
          {host}↗
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function MdTable({ b, k }: { b: Extract<MdBlock, { t: "table" }>; k: string }) {
  const tickerCol = b.head.findIndex((h) => /^(ticker|symbol)$/i.test(h));
  return (
    <table>
      <thead>
        <tr>
          {b.head.map((h, j) => (
            <th key={j} data-r={b.right[j] || undefined}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {b.rows.map((r, ri) => (
          <tr key={ri}>
            {r.map((c, j) => (
              <td key={j} data-r={b.right[j] || undefined}>
                {j === tickerCol && TICKER_RE.test(c) ? (
                  <Link href={`/security/${encodeURIComponent(c)}`} className={s.tick}>
                    {c}
                  </Link>
                ) : (
                  inline(c.replace(/^-\$/, "−$").replace(/^-(\d)/, "−$1"), `${k}-${ri}-${j}`)
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Md({ text, className = "", style, blocks }: { text?: string; className?: string; style?: CSSProperties; blocks?: MdBlock[] }) {
  const parsed = useMemo(() => blocks ?? parseMd(text ?? ""), [blocks, text]);
  const nodes: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flushList = (k: string) => {
    if (list.length) nodes.push(<ul key={`ul-${k}`}>{list}</ul>);
    list = [];
  };
  parsed.forEach((b, i) => {
    const k = String(i);
    if (b.t === "li") {
      list.push(
        <li key={k} data-depth={b.depth} data-num={b.num}>
          {inline(b.text, k)}
        </li>,
      );
      return;
    }
    flushList(k);
    if (b.t === "h") {
      const H = (`h${b.level}` as "h1" | "h2" | "h3" | "h4");
      nodes.push(<H key={k}>{inline(b.text, k)}</H>);
    } else if (b.t === "p") nodes.push(<p key={k}>{inline(b.text, k)}</p>);
    else if (b.t === "note") nodes.push(<p key={k} className={s.note}>{inline(b.text, k)}</p>);
    else if (b.t === "hr") nodes.push(<hr key={k} />);
    else if (b.t === "table") nodes.push(<MdTable key={k} b={b} k={k} />);
  });
  flushList("end");
  return (
    <div className={`${s.md} ${className}`} style={style}>
      {nodes}
    </div>
  );
}

// ── what a run DID, derived from its tool trace (+ summary for P/L, ideas) ──

type Act =
  | { k: "buy" | "sell"; sym: string; size: string | null; ok: boolean }
  | { k: "stops"; n: number }
  | { k: "fail"; name: string }
  | { k: "web"; n: number }
  | { k: "pnl"; text: string; short: string; sign: number }
  | { k: "ideas"; syms: string[] }
  | { k: "note"; text: string };

const compactUSD = (n: number) => (Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : `$${Math.round(n)}`);
const signOf = (s: string) => (s === "-" || s === "−" ? -1 : 1);

export function runActs(r: LLMRunRow): Act[] {
  const out: Act[] = [];
  const tr = r.tool_trace ?? [];
  for (const t of tr) {
    if (t.name !== "place_buy" && t.name !== "place_sell") continue;
    const a = (t.args ?? {}) as Record<string, unknown>;
    const sym = String(a.symbol ?? a.ticker ?? "?").toUpperCase();
    const notional = typeof a.notional === "number" ? a.notional : typeof a.notional_usd === "number" ? a.notional_usd : null;
    const qty = typeof a.qty === "number" ? a.qty : null;
    const size = notional != null ? compactUSD(notional) : qty != null ? `${+qty.toFixed(2)} sh` : null;
    out.push({ k: t.name === "place_buy" ? "buy" : "sell", sym, size, ok: t.ok });
  }
  const stops = tr.filter((t) => t.name === "set_trailing_stop" && t.ok).length;
  if (stops) out.push({ k: "stops", n: stops });
  for (const t of tr) if (!t.ok && t.name !== "place_buy" && t.name !== "place_sell") out.push({ k: "fail", name: t.name });
  const web = (r.web_search_calls || 0) + tr.filter((t) => t.name === "web_search").length;
  const orders = out.some((a) => a.k === "buy" || a.k === "sell");
  const sum = r.summary ?? "";
  if (r.routine === "premarket") {
    const ideas = [...new Set([...sum.matchAll(/^\s*[-*]\s+\*\*([A-Z]{1,5})\*\*/gm)].map((m) => m[1]))];
    out.push(ideas.length ? { k: "ideas", syms: ideas.slice(0, 4) } : { k: "note", text: "research logged" });
  } else if (r.routine === "close") {
    const m = /Day P\/L[^$]*?([+\-−]?)\$([\d,]+(?:\.\d+)?)\s*\(([+\-−]?)([\d.]+)%\)/.exec(sum);
    if (m) {
      const sg = signOf(m[1]);
      const usd = parseFloat(m[2].replace(/,/g, "")) || 0;
      // Basis points: from the dollar P/L over the equity the summary quotes
      // (2-dp percents round small days to "0.00%"), else from the percent.
      const eq = /equity[^$\d]{0,40}\$([\d,]{4,}(?:\.\d+)?)/i.exec(sum);
      const equity = eq ? parseFloat(eq[1].replace(/,/g, "")) : 0;
      const bp = equity > 0 ? (usd / equity) * 1e4 : parseFloat(m[4]) * 100;
      const bpTxt = `${sg < 0 ? "−" : "+"}${bp < 10 ? bp.toFixed(1) : Math.round(bp)} bp`;
      out.push({
        k: "pnl",
        text: `day ${sg < 0 ? "−" : "+"}$${m[2]} · ${bpTxt}`,
        short: `day ${sg < 0 ? "−" : "+"}$${m[2]}`,
        sign: sg * usd,
      });
    } else out.push({ k: "note", text: "day P/L logged" });
  } else if (r.routine === "weekly_review") {
    const m = /bot return\W*([+\-−]?[\d.]+)%\W*vs\W*SPY\W*([+\-−]?[\d.]+)%/i.exec(sum);
    if (m) {
      const a = parseFloat(m[1].replace("−", "-"));
      const b = parseFloat(m[2].replace("−", "-"));
      const al = a - b;
      out.push({
        k: "pnl",
        text: `bot ${a >= 0 ? "+" : "−"}${Math.abs(a)}% vs SPY ${b >= 0 ? "+" : "−"}${Math.abs(b)}%`,
        short: `${al >= 0 ? "+" : "−"}${Math.abs(al).toFixed(2)} pts vs SPY`,
        sign: al,
      });
    } else out.push({ k: "note", text: "post-mortem logged" });
  } else if (!orders && !stops) {
    out.push({ k: "note", text: r.routine === "execute" ? "no buys" : r.routine === "midday" ? "no cuts" : "no orders" });
  }
  if (web) out.push({ k: "web", n: web });
  return out;
}

function Act1({ a, compact }: { a: Act; compact?: boolean }) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  switch (a.k) {
    case "buy":
    case "sell": {
      const c = !a.ok ? "var(--alert)" : a.k === "buy" ? "var(--up)" : "var(--down)";
      return (
        <span className={s.act} title={a.ok ? undefined : "Rejected by the tool layer (cap / blackout / wash window)"}>
          <b style={{ color: c }}>
            {a.ok ? "" : "✕ "}
            {a.k.toUpperCase()}
          </b>{" "}
          <Link href={`/security/${encodeURIComponent(a.sym)}`} className="tkr" onClick={stop} style={{ textDecoration: a.ok ? undefined : "line-through" }}>
            {a.sym}
          </Link>
          {a.size && !compact && <span className={s.actDim}> {a.size}</span>}
        </span>
      );
    }
    case "stops":
      return (
        <span className={s.act} style={{ color: "var(--ink-2)" }}>
          ⇡ {a.n} stop{a.n === 1 ? "" : "s"} tightened
        </span>
      );
    case "fail":
      return (
        <span className={s.act} style={{ color: "var(--alert)" }}>
          ✕ {a.name}
        </span>
      );
    case "web":
      return <span className={s.actDim}>{a.n} search{a.n === 1 ? "" : "es"}</span>;
    case "pnl":
      return (
        <span className={`${s.act} ${a.sign > 0 ? "up" : a.sign < 0 ? "down" : "flat"}`} title={compact ? a.text : undefined}>
          {compact ? a.short : a.text}
        </span>
      );
    case "ideas":
      return (
        <span className={s.act}>
          <span className={s.actDim}>ideas </span>
          {a.syms.map((t, i) => (
            <Fragment key={t}>
              {i > 0 && " "}
              <Link href={`/security/${encodeURIComponent(t)}`} className="tkr" onClick={stop} style={{ color: "var(--ink)" }}>
                {t}
              </Link>
            </Fragment>
          ))}
        </span>
      );
    case "note":
      return <span className={s.actDim}>{a.text}</span>;
  }
}

function Acts({ acts, max, compact }: { acts: Act[]; max?: number; compact?: boolean }) {
  const list = max ? acts.slice(0, max) : acts;
  return (
    <>
      {list.map((a, i) => (
        <Fragment key={i}>
          {i > 0 && <span className={s.sep}> · </span>}
          <Act1 a={a} compact={compact} />
        </Fragment>
      ))}
    </>
  );
}

// ── status card: status banner · stop protection · facts ────────────────

/** A routine older than this is stale (covers a long weekend). */
const STALE_HOURS = BOT_STALE_MS / 3_600_000; // shared rule (ui.tsx)

type Health = "none" | "off" | "stale" | "failed" | "active";

/** /bot/status fields added server-side (not yet in lib/api types). */
type BotStatusX = BotStatus & {
  scheduler_alive?: boolean;
  synthetic_stops?: boolean;
  dry_run?: boolean;
  last_sync_at?: string | null;
};

function useBotHealth(now: number, next: RoutinesNext | undefined) {
  const q = useQuery({ queryKey: ["bot-status"], queryFn: api.botStatus, refetchInterval: 30_000 });
  const data = q.data as BotStatusX | undefined;
  const run = data?.last_llm_run ?? null;
  const enabled = data?.routines_enabled ?? next?.routines_enabled ?? true;
  // Shared rule from /bot/status; fall back to the same 84h threshold.
  const stale = data?.stale ?? (!!run && !!now && now - new Date(run.started_at).getTime() > BOT_STALE_MS);
  const failed = !!run && run.status !== "ok" && run.status !== "running";
  const health: Health = !run ? "none" : !enabled ? "off" : failed ? "failed" : stale ? "stale" : "active";
  return { ...q, data, run, enabled, stale, health };
}

/**
 * What actually protects positions while routines are off: breached
 * trailing stops without a broker order are sold by the 5-min sync_account
 * job — only while the scheduler is alive and DRY_RUN is off.
 */
function Protection({ data, now }: { data: BotStatusX | undefined; now: number }) {
  if (!data || data.synthetic_stops == null) return null;
  const armed = !!data.synthetic_stops;
  const why = [data.scheduler_alive === false ? "scheduler down" : null, data.dry_run ? "dry run" : null].filter(Boolean).join(" · ");
  const sync = data.last_sync_at && now ? `last sync ${fmtAge(data.last_sync_at, now)} ago` : null;
  return (
    <div className={s.protect}>
      <span className={s.protectLbl} title="Breached trailing stops without a broker order are sold by the 5-minute sync_account job (needs the scheduler alive and DRY_RUN off). The −7% cut needs the midday routine.">
        Synthetic stops
      </span>
      <span className={`pill ${armed ? "" : "alert"} ${s.banner}`}>{armed ? "Armed" : `Not armed${why ? ` — ${why}` : ""}`}</span>
      {sync && <span className={s.protectSync}>{sync}</span>}
    </div>
  );
}

function StatusCard({ now, runs, bot }: { now: number; runs: LLMRunRow[]; bot: ReturnType<typeof useBotHealth> }) {
  const { data, isLoading, run, health, stale } = bot;
  const { data: cost } = useQuery({ queryKey: ["llm-cost"], queryFn: api.llmCost, refetchInterval: 30_000 });
  const model = runs[0]?.model;
  const subscription = !!cost && cost.week_usd === 0 && !!model && /^(gpt|o\d|codex)/i.test(model);
  const n = runs.length;
  const failRuns = runs.filter((r) => r.status !== "ok" && r.status !== "running").length;
  const toolsPer = n ? runs.reduce((a, r) => a + r.tool_calls, 0) / n : null;
  const lastKey = runs[0] ? etParts(new Date(runs[0].started_at).getTime()).key : null;
  const old = stale || health === "off";
  const banner =
    health === "off"
      ? { tone: "alert", text: "Bot off — routines disabled" }
      : health === "stale"
        ? { tone: "alert", text: `Stale — no routine in ${STALE_HOURS / 24}+ days` }
        : health === "failed"
          ? { tone: "alert", text: `Last run ${run?.status === "budget_halt" ? "halted (budget)" : "failed"}` }
          : health === "active"
            ? { tone: "cyan", text: "Active — routines armed" }
            : null;
  return (
    <div className={`stat-card ${s.status}`} data-health={health}>
      <div className={s.statusHead}>
        <span className={s.cardLabel}>Bot status</span>
        {isLoading ? (
          <span className="skel" style={{ width: 180, height: 18 }} />
        ) : (
          banner && (
            <span className={`pill ${banner.tone} ${s.banner}`} title={health === "off" ? "LLM routines are switched off in the bot's config; data jobs still run" : undefined}>
              {banner.text}
            </span>
          )
        )}
      </div>
      <Protection data={data} now={now} />
      <div className={s.facts}>
        <span className={s.fk}>last run</span>
        <span className={s.fv} data-dim={old || undefined}>
          {run ? (
            <>
              <b>{run.routine}</b> {now ? `${fmtAge(run.started_at, now)} ago` : "—"}
            </>
          ) : (
            "none yet"
          )}
        </span>
        <span className={s.fk}>spend</span>
        <span className={s.fv} title={cost ? `Daily budget cap $${cost.budget_usd.toFixed(2)} · $${cost.remaining_usd.toFixed(2)} left today` : undefined}>
          {cost ? (subscription ? "$0 Codex sub" : `${fmtCost(cost.today_usd)} today`) : "—"}
          {cost && <span className={s.kvDim}> · budget ${cost.budget_usd.toFixed(0)}/d</span>}
        </span>

        <span className={s.fk}>ran</span>
        <span className={s.fv} data-dim={old || undefined}>
          {run ? `${fmtET(run.started_at)} · #${run.id} · ${statusOf(run.status).label}` : "—"}
        </span>
        <span className={s.fk} title={lastKey ? `Window: the last ${n} routine runs, through ${dayLabel(lastKey)}` : undefined}>
          {n} runs
        </span>
        <span className={s.fv} data-dim={old || undefined} title={lastKey ? `Over the last ${n} runs, through ${dayLabel(lastKey)}` : undefined}>
          {n ? (
            <>
              <span style={{ color: failRuns ? "var(--alert)" : undefined }}>{((failRuns / n) * 100).toFixed(0)}%</span> fail · {toolsPer?.toFixed(1)} tools/run
            </>
          ) : (
            "—"
          )}
        </span>
      </div>
    </div>
  );
}

// ── expected-vs-actual: flag routines that should have run but didn't ───

// NYSE full-day closures for 2026 (routines skip these by design).
const NYSE_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
]);

function addDays(key: string, n: number) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
const wdOf = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/**
 * For each routine, the expected run dates inside the logged window that
 * have no run. The window starts the day AFTER the oldest loaded run (that
 * day may be truncated by the fetch limit) and ends on the newest run day.
 */
function missedRuns(runs: LLMRunRow[]) {
  const out = new Map<string, string[]>();
  if (runs.length < 2) return out;
  const keys = runs.map((r) => etParts(new Date(r.started_at).getTime()).key);
  const newest = keys.reduce((a, b) => (a > b ? a : b));
  const oldest = keys.reduce((a, b) => (a < b ? a : b));
  const ran = new Set(runs.map((r, i) => `${r.routine}|${keys[i]}`));
  for (const rt of ROUTINES) {
    const miss: string[] = [];
    for (let k = addDays(oldest, 1); k <= newest; k = addDays(k, 1)) {
      const wd = wdOf(k);
      const expected = rt.fri ? wd === 5 : wd >= 1 && wd <= 5;
      if (expected && !NYSE_HOLIDAYS.has(k) && !ran.has(`${rt.name}|${k}`)) miss.push(k);
    }
    out.set(rt.name, miss);
  }
  return out;
}
const shortDay = (key: string) => {
  const [, m, d] = key.split("-").map(Number);
  return `${MONTHS[m - 1]} ${pad(d)}`;
};

// ── schedule table: routine · time · mandate · last · missed · state ────

function Schedule({ data, runs, now, enabled }: { data: RoutinesNext | undefined; runs: LLMRunRow[]; now: number; enabled: boolean }) {
  const today = now ? etParts(now) : null;
  const nextName = enabled ? data?.next?.name : undefined;
  const lastBy = useMemo(() => {
    const m = new Map<string, LLMRunRow>();
    for (const r of runs) if (!m.has(r.routine)) m.set(r.routine, r);
    return m;
  }, [runs]);
  // Missed runs only mean something while routines are enabled — a disabled
  // routine that doesn't run is doing exactly what it was told.
  const missed = useMemo(() => (enabled ? missedRuns(runs) : new Map<string, string[]>()), [runs, enabled]);
  return (
    <div className={s.schedTbl} data-off={!enabled || undefined}>
      <div className={`${s.schedRow} ${s.schedHead}`}>
        <span>Schedule · ET</span>
        <span />
        <span>Mandate</span>
        <span style={{ textAlign: "right" }}>Last</span>
        {enabled && (
          <span style={{ textAlign: "right" }} title="Expected runs inside the logged window that never happened">
            Missed
          </span>
        )}
        <span style={{ textAlign: "right" }}>State</span>
      </div>
      {ROUTINES.map((r) => {
        const last = lastBy.get(r.name);
        const lastKey = last ? etParts(new Date(last.started_at).getTime()).key : null;
        const ranToday = !!(lastKey && today && lastKey === today.key);
        const miss = missed.get(r.name) ?? [];
        const latestMiss = miss.length ? miss[miss.length - 1] : null;
        const missedAfterLast = !!latestMiss && (!lastKey || latestMiss > lastKey);
        const isNext = r.name === nextName;
        const entry = data?.all.find((e) => e.name === r.name);
        const fire = entry ? new Date(entry.next_fire_utc) : null;
        const secs = fire && now ? (fire.getTime() - now) / 1000 : null;
        return (
          <div
            key={r.name}
            className={s.schedRow}
            data-next={isNext || undefined}
            title={`${r.name} · ${r.role} · ${pad(r.hh)}:${pad(r.mm)} ET ${r.fri ? "Fridays" : "Mon–Fri"}${last ? ` · last run ${fmtET(last.started_at)} ET (#${last.id})` : ""}${miss.length ? ` · missed: ${miss.map(shortDay).join(", ")}` : ""}`}
          >
            <span className={s.schedName}>{r.name}</span>
            <span className={s.schedTime}>
              {pad(r.hh)}:{pad(r.mm)} <small>{r.fri ? "Fri" : "M–F"}</small>
            </span>
            <span className={s.schedRule}>{r.rule}</span>
            <span className={s.schedLast}>{last ? (ranToday ? "today" : shortDay(lastKey!)) : "never"}</span>
            {enabled && (
              <span className={s.schedMiss}>
                {missedAfterLast ? <span className="warn">{shortDay(latestMiss!)}</span> : miss.length ? <span className="warn">{miss.length}×</span> : <span className={s.offText}>—</span>}
              </span>
            )}
            <span className={s.schedState}>
              {!enabled ? (
                <span className={s.offText}>disabled</span>
              ) : isNext && secs != null ? (
                <span className="cyan">in {fmtCountdown(secs)}</span>
              ) : fire ? (
                <span>
                  {fire.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" })} {pad(r.hh)}:{pad(r.mm)}
                </span>
              ) : (
                "—"
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── live data-job feed (shown when the routines are off / stale) ────────

/** Python-dict job messages → short, neutral result text. */
function jobMsg(m: string | null | undefined) {
  if (!m) return "";
  const pairs = [...m.matchAll(/'(\w+)':\s*('([^']*)'|[^,}]+)/g)]
    .map((x) => [x[1], (x[3] ?? x[2]).trim()] as const)
    .filter(([k, v]) => !(k === "error" && v === "None"));
  if (!pairs.length) return m;
  return pairs
    .map(([k, v]) => {
      if (k === "count") return `${v} new`;
      if (k.endsWith("_added")) return `${k.replace(/_added$/, "")} +${v}`;
      if (k === "label") return v.replace(/_/g, " ");
      if (k === "error") return `error: ${v}`;
      return `${k.replace(/_/g, " ")} ${v}`;
    })
    .join(" · ");
}

const JOB_COLS = { gridTemplateColumns: "12px 158px 58px minmax(0, 1fr)" } as const;

function JobFeed({ now }: { now: number }) {
  const { data, isLoading } = useQuery({ queryKey: ["jobs"], queryFn: api.jobs, refetchInterval: 30_000 });
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const all = data ?? [];
    const names = new Set(all.map((j) => j.job_name));
    return all
      // "<x>_daily"/"<x>_weekly" are cron wrappers around "<x>_refresh" — show the worker once.
      .filter((j) => !(/_(daily|weekly)$/.test(j.job_name) && names.has(j.job_name.replace(/_(daily|weekly)$/, "_refresh"))))
      .filter((j) => (seen.has(j.job_name) ? false : (seen.add(j.job_name), true)))
      .sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  }, [data]);
  if (isLoading) return <Skeleton rows={5} height={14} />;
  if (!rows.length) return <Empty>No scheduler jobs recorded.</Empty>;
  return (
    <div className={s.jobs}>
      {rows.map((j) => {
        const dur = j.finished_at ? (new Date(j.finished_at).getTime() - new Date(j.started_at).getTime()) / 1000 : null;
        const msg = jobMsg(j.message);
        const bad = j.status === "failed" || j.status === "error";
        return (
          <div key={j.job_name} className={s.jobRow} style={JOB_COLS} data-row="" data-cut-ok="" title={`${j.job_name} · ${j.status} · ${fmtET(j.started_at)} ET${dur != null ? ` · ${dur.toFixed(1)}s` : ""}${j.message ? ` · ${j.message}` : ""}`}>
            <span className={s.jobSt} style={{ color: bad ? "var(--alert)" : j.status === "skipped" ? "var(--ink-4)" : "var(--ink-3)" }}>
              {bad ? "!" : j.status === "skipped" ? "–" : "✓"}
            </span>
            <span className={s.jobName}>{j.job_name}</span>
            <span className={s.jobAge}>{now ? `${fmtAge(j.started_at, now)} ago` : ""}</span>
            <span className={s.jobMsg} style={{ color: bad ? "var(--alert)" : undefined }}>
              {msg}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Section head that doubles as the job feed's column header. */
function JobHead() {
  return (
    <div className={`${s.jobRow} ${s.jobHead}`} style={JOB_COLS}>
      <span />
      <span title="Scheduled data jobs keep running while LLM routines are off">Data jobs · live</span>
      <span style={{ textAlign: "right" }}>Ran</span>
      <span>Result</span>
    </div>
  );
}

// ── scroll host: whole rows only + a footer "▾ N more" row ──────────────

const FOOT_H = 20;

/**
 * Absolute-fill scroller (never grows the Launchpad row) whose viewport ends
 * on a whole row: only elements marked `data-cut-ok` may be the last visible
 * one (a day header with < 2 of its rows never dangles at the fold), rows
 * marked `data-row` are counted for the "▾ N more" footer.
 */
export function ScrollHost({ children, minHeight, watch }: { children: ReactNode; minHeight?: number; watch?: unknown }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState<number | null>(null);
  const [more, setMore] = useState(0);

  const count = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.getBoundingClientRect().bottom;
    let n = 0;
    el.querySelectorAll<HTMLElement>("[data-row]").forEach((r) => {
      if (r.getBoundingClientRect().bottom > bottom + 1) n++;
    });
    setMore(n);
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
    const top = content.getBoundingClientRect().top + (scrollRef.current?.scrollTop ?? 0);
    let best = 0;
    content.querySelectorAll<HTMLElement>("[data-cut-ok]").forEach((r) => {
      const b = r.getBoundingClientRect().bottom + (scrollRef.current?.scrollTop ?? 0) - top;
      if (b <= H - FOOT_H + 0.5 && b > best) best = b;
    });
    setCut(best > 30 ? Math.floor(best) : H - FOOT_H);
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    const content = contentRef.current;
    if (!wrap || !content) return;
    const ro = new ResizeObserver(() => layout());
    ro.observe(wrap);
    ro.observe(content);
    return () => ro.disconnect();
  }, [layout]);
  useEffect(() => {
    layout();
  }, [watch, layout]);
  useEffect(() => {
    count();
  }, [cut, watch, count]);

  return (
    <div className={s.fill} style={minHeight ? { minHeight } : undefined}>
      <div ref={wrapRef} className={s.fillCol}>
        <div ref={scrollRef} className={s.rowScroll} style={cut != null ? { flex: "none", height: cut } : undefined} onScroll={count}>
          <div ref={contentRef}>{children}</div>
        </div>
        {cut != null && (
          <div className={s.foot}>
            {more > 0 ? (
              <button
                type="button"
                className={s.footBtn}
                onClick={() => scrollRef.current?.scrollBy({ top: (scrollRef.current?.clientHeight ?? 200) - 24, behavior: "smooth" })}
              >
                ▾ {more} more
              </button>
            ) : (
              <button type="button" className={s.footBtn} onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}>
                ▴ top
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── run log ──────────────────────────────────────────────────────────────

function RunDetail({ run, wide }: { run: LLMRunRow; wide: boolean }) {
  const trace = run.tool_trace ?? [];
  const totalMs = trace.reduce((a, t) => a + (t.ms || 0), 0) || 1;
  // Cumulative offsets → a sequential tool-time waterfall.
  const starts = trace.map((_, i) => trace.slice(0, i).reduce((a, t) => a + (t.ms || 0), 0) / totalMs);
  const tok = run.input_tokens + run.output_tokens;
  return (
    <div className={s.detail} data-wide={wide}>
      <div className={s.detailMeta}>
        <span>
          RUN <b>#{run.id}</b>
        </span>
        <span>
          <b>{fmtETs(run.started_at)}</b> → <b>{run.finished_at ? fmtETs(run.finished_at) : "…"}</b> ET · {fmtDur(durSec(run))}
        </span>
        <span>
          model <b>{run.model}</b>
        </span>
        <span title="input / output / cache-read / cache-write tokens">
          tok{" "}
          <b>{tok ? `${fmtBig(run.input_tokens)} in · ${fmtBig(run.output_tokens)} out · ${fmtBig(run.cache_read_tokens)} cached` : "not metered"}</b>
        </span>
        <span>
          web <b>{run.web_search_calls}</b>
        </span>
        <span>
          cost <b>{fmtCost(run.usd_cost)}</b>
        </span>
        <span style={{ color: statusOf(run.status).c }}>● {statusOf(run.status).label}</span>
      </div>
      <div className={s.summary}>
        {run.error && (
          <div className="num" style={{ color: "var(--alert)", fontSize: 11, marginBottom: 6, whiteSpace: "pre-wrap" }}>
            {run.error}
          </div>
        )}
        {run.summary ? <Md text={run.summary} /> : <span className="dim">No summary recorded.</span>}
      </div>
      <div className={s.trace}>
        <div className={s.traceRow} style={{ color: "var(--ink-4)", fontSize: 9, letterSpacing: "0.06em" }}>
          <span>#</span>
          <span>TOOL</span>
          <span>ARGS</span>
          <span />
          <span style={{ textAlign: "right" }}>MS</span>
          <span>TOOL TIME</span>
        </div>
        {trace.length === 0 && <div className={s.traceRow}><span /><span className="dim">no tool calls</span></div>}
        {trace.map((t, i) => {
          const start = starts[i];
          const sym = (t.args?.symbol ?? t.args?.ticker) as string | undefined;
          return (
            <div key={i} className={s.traceRow} title={`${t.name} ${JSON.stringify(t.args ?? {})}`}>
              <span className={s.traceIdx}>{pad(i + 1)}</span>
              <span className={s.traceName}>{t.name}</span>
              <span className={s.traceArgs}>
                {sym && typeof sym === "string" ? (
                  <Link href={`/security/${encodeURIComponent(sym)}`} className="tkr" onClick={(e) => e.stopPropagation()}>
                    {sym}
                  </Link>
                ) : null}{" "}
                {argSummary(Object.fromEntries(Object.entries(t.args ?? {}).filter(([k]) => k !== "symbol" && k !== "ticker")))}
              </span>
              <span style={{ color: t.ok ? "var(--ink-3)" : "var(--alert)", fontSize: 10 }}>{t.ok ? "✓" : "✕"}</span>
              <span className={s.traceMs}>{t.ms >= 1000 ? `${(t.ms / 1000).toFixed(1)}s` : Math.round(t.ms)}</span>
              <span className={s.traceTrack}>
                <span className={s.traceBar} data-fail={!t.ok || undefined} style={{ left: `${start * 100}%`, width: `${((t.ms || 0) / totalMs) * 100}%` }} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The ET trading day before `key` (weekends skipped; holidays not modeled). */
function prevTradingDay(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  do dt.setUTCDate(dt.getUTCDate() - 1);
  while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6);
  return dt.toISOString().slice(0, 10);
}

function RunLog({
  runs,
  openId,
  setOpenId,
  wide,
  now,
  expanded,
  setExpanded,
}: {
  runs: LLMRunRow[];
  openId: number | null;
  setOpenId: (id: number | null) => void;
  wide: boolean;
  now: number;
  expanded: boolean;
  setExpanded: (v: boolean) => void;
}) {
  const groups = useMemo(() => {
    const out: { key: string; runs: LLMRunRow[] }[] = [];
    for (const r of runs) {
      const key = etParts(new Date(r.started_at).getTime()).key;
      const g = out[out.length - 1];
      if (g && g.key === key) g.runs.push(r);
      else out.push({ key, runs: [r] });
    }
    return out;
  }, [runs]);
  // Rows older than one trading day are history: dimmed.
  const freshFrom = now ? prevTradingDay(etParts(now).key) : null;
  const shown = expanded ? groups : groups.slice(0, 1);
  const earlier = groups.slice(1).reduce((a, g) => a + g.runs.length, 0);
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());
  useEffect(() => {
    if (openId == null) return;
    rowRefs.current.get(openId)?.scrollIntoView({ block: "nearest" });
  }, [openId]);

  return (
    <table className={`tbl ${s.runs}`}>
      <thead>
        <tr>
          <th style={{ width: 22 }} aria-label="Status" />
          <th style={{ textAlign: "left", width: 104 }}>Routine</th>
          <th style={{ width: 48 }}>ET</th>
          <th style={{ width: 44 }}>Dur</th>
          <th style={{ width: 46 }} title="Tool calls (failures marked)">Tools</th>
          <th style={{ textAlign: "left" }}>Actions · outcome</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((g) => {
          const old = !!freshFrom && g.key < freshFrom;
          const orders = g.runs.flatMap((r) => runActs(r)).filter((a) => a.k === "buy" || a.k === "sell").length;
          const fails = g.runs.reduce((a, r) => a + (r.tool_trace ?? []).filter((t) => !t.ok).length, 0);
          return (
            <Fragment key={g.key}>
              <tr className={s.dayRow}>
                <td colSpan={6}>
                  <span className={s.dayKey}>{dayLabel(g.key)}</span> · {g.runs.length} run{g.runs.length === 1 ? "" : "s"} · {orders} order{orders === 1 ? "" : "s"}
                  {fails > 0 && <span className="alert"> · {fails} failed call{fails === 1 ? "" : "s"}</span>}
                </td>
              </tr>
              {g.runs.map((r, ri) => {
                const open = openId === r.id;
                const st = statusOf(r.status);
                const nFail = (r.tool_trace ?? []).filter((t) => !t.ok).length;
                // Never end the viewport on a group's first row when the
                // group has more: show at least two rows of any day started.
                const cutOk = ri > 0 || g.runs.length === 1;
                return (
                  <Fragment key={r.id}>
                    <tr
                      ref={(el) => {
                        if (el) rowRefs.current.set(r.id, el);
                        else rowRefs.current.delete(r.id);
                      }}
                      data-row=""
                      data-cut-ok={cutOk ? "" : undefined}
                      data-old={old || undefined}
                      className={`${s.run} ${open ? s.open : ""}`}
                      onClick={() => setOpenId(open ? null : r.id)}
                      aria-expanded={open}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setOpenId(open ? null : r.id);
                        }
                      }}
                    >
                      <td title={st.label} className={s.stCell} style={{ color: st.c }}>
                        {st.glyph}
                      </td>
                      <td style={{ textAlign: "left" }}>
                        <span className={s.caret}>▶</span> <span className={s.routine}>{r.routine}</span>
                      </td>
                      <td className={s.cellDim}>{fmtET(r.started_at, false)}</td>
                      <td className={s.cellDim}>{fmtDur(durSec(r))}</td>
                      <td title={nFail ? `${nFail} of ${r.tool_calls} tool calls failed` : `${r.tool_calls} tool calls`}>
                        {r.tool_calls}
                        {nFail > 0 && <span className="alert"> ✕{nFail}</span>}
                      </td>
                      <td className={s.actCell}>
                        <div>
                          <Acts acts={runActs(r)} />
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className={s.detailRow} data-cut-ok="">
                        <td colSpan={6}>
                          <RunDetail run={r} wide={wide} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </Fragment>
          );
        })}
        {earlier > 0 && (
          <tr className={s.moreRow} data-cut-ok="">
            <td colSpan={6}>
              <button type="button" className={s.moreBtn} onClick={() => setExpanded(!expanded)}>
                {expanded ? "▴ collapse to last day" : `▸ ${earlier} earlier run${earlier === 1 ? "" : "s"} · ${groups.length - 1} day${groups.length === 2 ? "" : "s"}`}
              </button>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

// ── page-variant insights ────────────────────────────────────────────────

function ActivityMatrix({ runs, onPick }: { runs: LLMRunRow[]; onPick: (id: number) => void }) {
  const { days, cells, maxTools } = useMemo(() => {
    const cells = new Map<string, LLMRunRow>();
    const daySet = new Set<string>();
    let maxTools = 1;
    for (const r of runs) {
      const k = etParts(new Date(r.started_at).getTime()).key;
      daySet.add(k);
      const id = `${r.routine}|${k}`;
      const prev = cells.get(id);
      // Keep the worst status if a routine fired twice in a day.
      if (!prev || (prev.status === "ok" && r.status !== "ok")) cells.set(id, r);
      maxTools = Math.max(maxTools, r.tool_calls);
    }
    return { days: [...daySet].sort().slice(-24), cells, maxTools };
  }, [runs]);
  if (!days.length) return <Empty>No routine runs yet.</Empty>;
  const cols = `92px repeat(${days.length}, minmax(12px, 1fr))`;
  return (
    <div className={s.matrix}>
      <div className={s.mRow} style={{ gridTemplateColumns: cols }}>
        <span />
        {days.map((d, i) => {
          const [, m, dd] = d.split("-");
          const newMonth = i === 0 || days[i - 1].split("-")[1] !== m;
          return (
            <span key={d} className={s.mHead} title={dayLabel(d)}>
              {newMonth ? `${m}/` : ""}
              {dd}
            </span>
          );
        })}
      </div>
      {ROUTINES.map((rt) => (
        <div key={rt.name} className={s.mRow} style={{ gridTemplateColumns: cols }}>
          <span className={s.mLbl}>{rt.name}</span>
          {days.map((d) => {
            const r = cells.get(`${rt.name}|${d}`);
            const [y, m, dd] = d.split("-").map(Number);
            const wd = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
            const expected = rt.fri ? wd === 5 : wd >= 1 && wd <= 5;
            if (!r) {
              return <span key={d} className={s.mCell} data-miss={expected || undefined} title={expected ? `${rt.name} · ${dayLabel(d)} · no run` : undefined} />;
            }
            const bg =
              r.status === "ok"
                ? `rgba(86, 212, 255, ${(0.25 + 0.65 * (r.tool_calls / maxTools)).toFixed(2)})`
                : r.status === "budget_halt"
                  ? "var(--alert)"
                  : r.status === "running"
                    ? "var(--cyan)"
                    : "var(--alert)";
            return (
              <button
                type="button"
                key={d}
                className={s.mCell}
                data-has="true"
                style={{ background: bg }}
                title={`${rt.name} · ${dayLabel(d)} · ${statusOf(r.status).label} · ${r.tool_calls} tools · ${fmtDur(durSec(r))}`}
                onClick={() => onPick(r.id)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ToolStats({ runs }: { runs: LLMRunRow[] }) {
  const rows = useMemo(() => {
    const m = new Map<string, { calls: number; fails: number; ms: number }>();
    for (const r of runs)
      for (const t of r.tool_trace ?? []) {
        const e = m.get(t.name) ?? { calls: 0, fails: 0, ms: 0 };
        e.calls++;
        if (!t.ok) e.fails++;
        e.ms += t.ms || 0;
        m.set(t.name, e);
      }
    return [...m.entries()].map(([name, e]) => ({ name, ...e })).sort((a, b) => b.calls - a.calls);
  }, [runs]);
  const max = Math.max(1, ...rows.map((r) => r.calls));
  return (
    <div className={s.tools}>
      <div className={`${s.toolRow} ${s.toolHead}`}>
        <span>Tool</span>
        <span>Calls</span>
        <span />
        <span>Fail</span>
        <span>Avg ms</span>
      </div>
      {rows.map((r) => (
        <div key={r.name} className={s.toolRow}>
          <span style={{ color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
          <span>{r.calls}</span>
          <span style={{ display: "block", height: 5, background: "var(--bg-3)", position: "relative" }}>
            <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(r.calls / max) * 100}%`, background: "rgba(86, 212, 255, 0.7)" }} />
          </span>
          <span style={{ color: r.fails ? "var(--alert)" : "var(--ink-4)" }}>{r.fails ? `${((r.fails / r.calls) * 100).toFixed(0)}%` : "0"}</span>
          <span>{Math.round(r.ms / r.calls)}</span>
        </div>
      ))}
    </div>
  );
}

// ── compact (bot off): the last routine day as one line ────────────────

function LastDay({ runs }: { runs: LLMRunRow[] }) {
  const key = runs[0] ? etParts(new Date(runs[0].started_at).getTime()).key : null;
  if (!key) return null;
  const day = runs.filter((r) => etParts(new Date(r.started_at).getTime()).key === key);
  const acts = day.flatMap((r) => runActs(r));
  const orders = acts.filter((a) => a.k === "buy" || a.k === "sell").length;
  const pnl = acts.find((a) => a.k === "pnl");
  const fails = day.filter((r) => r.status !== "ok" && r.status !== "running").length;
  return (
    <div className={s.lastDay} title="The most recent day the routines ran">
      <span className={s.secTitle}>Last routine day</span>
      <span className={s.lastDayBody}>
        <b>{dayLabel(key)}</b> · {day.length} run{day.length === 1 ? "" : "s"} · {orders} order{orders === 1 ? "" : "s"}
        {fails > 0 && <span className="alert"> · {fails} failed</span>}
        {pnl && pnl.k === "pnl" && (
          <>
            {" · "}
            <span className={pnl.sign > 0 ? "up" : pnl.sign < 0 ? "down" : "flat"}>{pnl.short}</span>
          </>
        )}
      </span>
      <Link href="/bot" className={s.lastDayLink}>
        full log ▸
      </Link>
    </div>
  );
}

// ── the panel ────────────────────────────────────────────────────────────

export function BotPanel({
  className = "",
  style,
  variant = "panel",
}: {
  className?: string;
  style?: CSSProperties;
  variant?: "panel" | "page";
}) {
  const page = variant === "page";
  const now = useNow(1000);
  const limit = page ? 100 : 30;
  const { data: runs, isLoading, isError } = useQuery({
    queryKey: ["llm-runs", limit],
    queryFn: () => api.llmRuns(limit),
    refetchInterval: 30_000,
  });
  const { data: next, refetch: refetchNext } = useQuery({ queryKey: ["routines-next"], queryFn: api.routinesNext, refetchInterval: 60_000 });
  const [pickedId, setPickedId] = useState<number | null>(null);
  const [touched, setTouched] = useState(false);
  const setOpenId = (id: number | null) => {
    setTouched(true);
    setPickedId(id);
  };
  const [expanded, setExpanded] = useState(false);
  const bot = useBotHealth(now, next);

  // When the countdown crosses zero, pull the new schedule (and fresh runs).
  const fireAt = next?.next ? new Date(next.next.next_fire_utc).getTime() : null;
  const fired = fireAt != null && now > 0 && now >= fireAt;
  useEffect(() => {
    if (fired) void refetchNext();
  }, [fired, refetchNext]);

  const list = runs ?? [];
  const last = list[0];
  const models = [...new Set(list.map((r) => r.model))];
  // On /bot the newest run is open by default so its summary + trace fill the page.
  const openId = touched ? pickedId : page ? last?.id ?? null : null;
  const quiet = bot.health === "off" || bot.health === "stale";

  return (
    <Panel
      code="BOT"
      title="The machine"
      sub={
        last ? (
          <span title={models.length > 1 ? `Earlier runs also used: ${models.slice(1).join(", ")}` : undefined}>{last.model} · autonomous tool-use loop</span>
        ) : (
          "autonomous tool-use loop"
        )
      }
      className={`${className} ${quiet ? s.quiet : ""}`}
      style={style}
      bodyStyle={{ display: "flex", flexDirection: "column", padding: 0 }}
    >
      <StatusCard now={now} runs={list} bot={bot} />
      <Schedule data={next} runs={list} now={now} enabled={bot.enabled} />

      {page && (
        <div className={s.insights}>
          <div>
            <div className={s.secHead}>
              <span className={s.secTitle}>Activity · routine × day</span>
              <span className={s.secMeta}>shade = tool calls · click to open</span>
            </div>
            {isLoading ? <Skeleton rows={4} height={12} /> : <ActivityMatrix runs={list} onPick={setOpenId} />}
          </div>
          <div>
            <div className={s.secHead}>
              <span className={s.secTitle}>Tool usage</span>
              <span className={s.secMeta}>last {list.length} runs</span>
            </div>
            {isLoading ? <Skeleton rows={4} height={12} /> : <ToolStats runs={list} />}
          </div>
        </div>
      )}

      {quiet && !page ? (
        <>
          <LastDay runs={list} />
          <JobHead />
          <ScrollHost watch="jobs">
            <JobFeed now={now} />
          </ScrollHost>
        </>
      ) : (
        <>
          <div className={s.secHead}>
            <span className={s.secTitle} title="Click a run for its summary, tokens and tool-call trace">
              Routine log
            </span>
          </div>
          <ScrollHost watch={`${list.length}-${openId}-${expanded}`}>
            {isLoading ? (
              <Skeleton rows={7} height={16} />
            ) : isError ? (
              <Empty>Routine log unavailable — API did not answer /llm/runs.</Empty>
            ) : list.length === 0 ? (
              <Empty>No LLM routine has run yet. The first fires at premarket 07:00 ET.</Empty>
            ) : (
              <RunLog runs={list} openId={openId} setOpenId={setOpenId} wide={page} now={now} expanded={expanded} setExpanded={setExpanded} />
            )}
          </ScrollHost>
        </>
      )}
    </Panel>
  );
}
