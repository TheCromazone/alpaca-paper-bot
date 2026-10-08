"use client";

/**
 * WIRE — the system's live event tape (/terminal/wire): orders, LLM
 * routines, job failures, insider filings and strongly-scored headlines in
 * one chronological stream. Click a row to expand its thesis / routine
 * summary. New arrivals flash in on refetch.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { term, type WireEvent } from "@/lib/api";
import { Empty, Panel, Seg, Skeleton } from "./ui";
import { BANDS, DayRule, ScrollArea, Tkr, dayOf, etHM, fmtK, isDateOnly, useHeld } from "./feedKit";
import { DataAge } from "./DataAge";
import s from "./feeds.module.css";

type Kind = "ORD" | "LLM" | "JOB" | "PTR" | "13F" | "NEWS";
type Filter = "ALL" | Kind;

const TAGS: Record<Kind, { fg: string; bg: string; bd: string; title: string }> = {
  // Blue is reserved for "held"; orders use neutral ink, the bot layer cyan.
  ORD: { fg: "var(--ink)", bg: "var(--bg-3)", bd: "var(--ink-4)", title: "Order" },
  LLM: { fg: "var(--cyan)", bg: "rgba(86,212,255,.09)", bd: "rgba(86,212,255,.3)", title: "LLM routine" },
  JOB: { fg: "var(--warn)", bg: "rgba(255,210,63,.08)", bd: "rgba(255,210,63,.3)", title: "Scheduled job (failed / skipped)" },
  PTR: { fg: "#c3b1ff", bg: "rgba(160,132,255,.10)", bd: "rgba(160,132,255,.3)", title: "Congressional PTR" },
  "13F": { fg: "#eaa6dc", bg: "rgba(226,140,206,.09)", bd: "rgba(226,140,206,.28)", title: "13F position change" },
  NEWS: { fg: "var(--ink-3)", bg: "transparent", bd: "var(--line-2)", title: "Ticker-tagged headline with a non-neutral sentiment score" },
};

function kindOf(t: WireEvent["type"]): Kind {
  switch (t) {
    case "order":
      return "ORD";
    case "routine":
      return "LLM";
    case "job":
      return "JOB";
    case "politician":
      return "PTR";
    case "investor":
      return "13F";
    default:
      return "NEWS";
  }
}

// time · type · side · ticker · event · sentiment · expand
const COLS = "38px 38px 12px 52px minmax(0,1fr) 34px 12px";
const evKey = (e: WireEvent) => `${e.type}|${e.at}|${e.ticker ?? ""}|${e.text}`;

/** One-line preview of a markdown-ish summary: headings dropped, bullets joined. */
function plain(md: string): string {
  return md
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/^\s*[-*•]\s+/, "").trim())
    .filter(Boolean)
    .join(" · ")
    .replace(/\*\*/g, "")
    .slice(0, 220);
}

/** Tiny markdown renderer for routine summaries / theses: headings, bullets, paragraphs. */
function MiniMd({ text }: { text: string }) {
  const lines = text.replace(/\*\*/g, "").split("\n");
  return (
    <>
      {lines.map((l, i) => {
        const t = l.trim();
        if (!t) return null;
        if (/^#+\s/.test(t))
          return (
            <div key={i} className="label" style={{ color: "var(--ink-3)", marginTop: i ? 6 : 0, marginBottom: 1 }}>
              {t.replace(/^#+\s*/, "")}
            </div>
          );
        if (/^[-*•]\s/.test(t))
          return (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "10px 1fr" }}>
              <span className="dim">·</span>
              <span>{t.replace(/^[-*•]\s+/, "")}</span>
            </div>
          );
        return <div key={i}>{t}</div>;
      })}
    </>
  );
}

type Item = { e: WireEvent; group?: WireEvent[] };

const DETAIL_PAD = 8 + 38 + 8 + 38 + 8 + 12 + 8;

const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09-17" → "Sep 17" (bare date, no zone math). */
const monDay = (d: string) => `${MON3[Number(d.slice(5, 7)) - 1]} ${d.slice(8, 10)}`;
/** "Sep 08–17" / "Aug 31–Sep 14" / "Sep 17". */
function dateRange(ds: string[]): string {
  const xs = [...ds].sort();
  if (!xs.length) return "";
  const a = xs[0];
  const b = xs[xs.length - 1];
  if (a === b) return monDay(a);
  return a.slice(0, 7) === b.slice(0, 7) ? `${monDay(a)}–${b.slice(8, 10)}` : `${monDay(a)}–${monDay(b)}`;
}
/** 13F detail "13F 2026-06-30 vs 2026-03-31" → "Q2'26". */
function quarterOf(detail: string | null): string | null {
  const m = /(\d{4})-(\d{2})-\d{2}/.exec(detail ?? "");
  return m ? `Q${Math.ceil(Number(m[2]) / 3)}'${m[1].slice(2)}` : null;
}

/** Time-of-day cell text: filings carry a date only (midnight UTC) → no clock time. */
const clock = (at: string) => (isDateOnly(at) ? "" : etHM(at));
const when = (at: string) => (isDateOnly(at) ? `${dayOf(at)} (filing date)` : `${dayOf(at)} ${etHM(at)} ET`);

type Filing = { who: string; side: "BUY" | "SELL"; verb: string; tkr: string; amt: number; traded: string | null };

/**
 * "Kevin Hern SELL PG ~$8,000" / "Citadel Advisors ADD XOM ~$379,482,904" →
 * parts. 13F verbs (NEW/ADD/TRIM/EXIT) come from the event's `change`.
 */
function parseFiling(e: WireEvent): Filing | null {
  const m = /^(.*)\s(BUY|SELL|NEW|ADD|TRIM|EXIT)\s(\S+)(?:\s+~\$([\d,]+))?$/.exec(e.text);
  if (!m) return null;
  const verb = (e.change ?? m[2]).toUpperCase();
  const side: Filing["side"] = /^(BUY|NEW|ADD)$/.test(verb) ? "BUY" : "SELL";
  return { who: m[1], side, verb, tkr: m[3], amt: m[4] ? Number(m[4].replace(/,/g, "")) : 0, traded: e.traded_on ?? null };
}

const filingAmt = (p: Filing, kind: Kind) =>
  p.amt ? (kind === "PTR" ? BANDS[p.amt] ?? fmtK(p.amt) : fmtK(p.side === "BUY" ? p.amt : -p.amt, true)) : "amount n/d";

/** " · traded Sep 03–28" across a burst's transaction dates (PTR only). */
function tradedRange(parts: Filing[]): string {
  const ds = parts.map((p) => p.traded).filter((d): d is string => !!d);
  return ds.length ? ` · traded ${dateRange(ds)}` : "";
}

/** One line for a filer's burst: "Kevin Hern 4 filings SELL DIS PG LOW BA". */
function BurstText({ items, held, kind }: { items: WireEvent[]; held: Set<string>; kind: Kind }) {
  const parts = items.map(parseFiling).filter((p): p is Filing => p != null);
  const who = parts[0]?.who ?? "";
  // One leg per verb+ticker ("SELL JPM, SELL JPM" → "JPM ×2"); verbs grouped
  // in order of first appearance.
  const legs: { verb: string; side: Filing["side"]; tkr: string; n: number }[] = [];
  for (const p of parts) {
    const hit = legs.find((l) => l.verb === p.verb && l.tkr === p.tkr);
    if (hit) hit.n++;
    else legs.push({ verb: p.verb, side: p.side, tkr: p.tkr, n: 1 });
  }
  const order = [...new Set(legs.map((l) => l.verb))];
  legs.sort((a, b) => order.indexOf(a.verb) - order.indexOf(b.verb));
  return (
    <>
      <span style={{ color: "var(--ink)" }}>{who}</span>
      {items.length > 1 && (
        <span className="num dim" style={{ marginLeft: 6, fontSize: 10.5 }}>
          {items.length} {kind === "13F" ? "changes" : "filings"}
          {tradedRange(parts)}
        </span>
      )}
      {legs.map((l, i) => (
        <Fragment key={i}>
          {(i === 0 || legs[i - 1].verb !== l.verb) && (
            <span className={l.side === "BUY" ? "up" : "down"} style={{ fontWeight: 600, marginLeft: i === 0 ? 8 : 10 }}>
              {l.verb}
            </span>
          )}
          <span style={{ marginLeft: 6 }}>
            <Tkr t={l.tkr} held={held.has(l.tkr)} />
            {l.n > 1 && (
              <span className="num dim" style={{ fontSize: 10.5, marginLeft: 2 }}>
                ×{l.n}
              </span>
            )}
          </span>
        </Fragment>
      ))}
      {items.length === 1 && parts[0] && (
        <>
          <span className="num" style={{ marginLeft: 10, fontSize: 10.5, color: parts[0].amt ? "var(--ink-2)" : "var(--ink-4)" }}>
            {filingAmt(parts[0], kind)}
          </span>
          <span className="num dim" style={{ marginLeft: 10, fontSize: 10.5 }}>
            {parts[0].traded ? `traded ${monDay(parts[0].traded)}` : kind === "13F" && quarterOf(items[0].detail) ? `for ${quarterOf(items[0].detail)}` : ""}
          </span>
        </>
      )}
    </>
  );
}

// Status is not direction: action states use --alert, watch states --warn.
const ordStatusColor = (st: string) =>
  st === "filled" ? "var(--ink-2)" : st.includes("dry") ? "var(--cyan)" : /(reject|fail|cancel|expire)/.test(st) ? "var(--alert)" : "var(--warn)";

/**
 * Light syntax colouring of the server's one-line text (orders, routines).
 * The ticker has its own column, so it is dropped from order sentences.
 */
function renderText(e: WireEvent, k: Kind): ReactNode {
  if (k === "ORD") {
    const m = /^(BUY|SELL)\s+([\d.,]+)\s+(\S+)\s+@\s+\$([\d,.]+)\s+\((\$[\d,.]+)\)\s+·\s+(\w+)$/.exec(e.text);
    if (m) {
      const st = m[6].toLowerCase();
      return (
        <>
          <span className={m[1] === "BUY" ? "up" : "down"} style={{ fontWeight: 600 }}>
            {m[1]}
          </span>{" "}
          <span style={{ color: "var(--ink)" }}>{m[2]}</span>
          {!e.ticker && <span style={{ color: "var(--ink)" }}> {m[3]}</span>}
          <span className="dim"> @ </span>
          <span style={{ color: "var(--ink)" }}>{m[4]}</span>
          <span className="dim"> · </span>
          <span style={{ color: "var(--ink-2)" }}>{m[5]}</span>
          <span className="dim"> · </span>
          <span style={{ color: ordStatusColor(st) }}>{st}</span>
        </>
      );
    }
  }
  if (k === "LLM") {
    const [routine, ...rest] = e.text.split(" · ");
    const status = rest[0] ?? "";
    return (
      <>
        <span className="cyan" style={{ fontWeight: 600 }}>
          {routine}
        </span>
        {rest.map((p, i) => (
          <Fragment key={i}>
            <span className="dim"> · </span>
            <span style={{ color: i === 0 ? (status === "ok" ? "var(--ink-2)" : "var(--alert)") : "var(--ink-2)" }}>{p}</span>
          </Fragment>
        ))}
      </>
    );
  }
  return <span style={{ color: "var(--ink)" }}>{e.text}</span>;
}

export function WirePanel({ className = "", style, limit = 200 }: { className?: string; style?: CSSProperties; limit?: number }) {
  const [filter, setFilter] = useState<Filter>("ALL");
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading, isError } = useQuery<WireEvent[]>({
    queryKey: ["wire", limit],
    queryFn: () => term.wire(limit),
    refetchInterval: 20_000,
  });
  const held = useHeld();

  // Panel width → drop the per-type counts from the filter when narrow.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyW, setBodyW] = useState(0);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setBodyW(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const compact = bodyW > 0 && bodyW < 620;

  // Flash rows that arrive after the first load.
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!data) return;
    const keys = data.map(evKey);
    if (seen.current == null) {
      seen.current = new Set(keys);
      return;
    }
    const nw = keys.filter((k) => !seen.current!.has(k));
    keys.forEach((k) => seen.current!.add(k));
    if (nw.length) {
      setFresh(new Set(nw));
      const t = setTimeout(() => setFresh(new Set()), 2600);
      return () => clearTimeout(t);
    }
  }, [data]);

  const all = useMemo(() => data ?? [], [data]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of all) c[kindOf(e.type)] = (c[kindOf(e.type)] ?? 0) + 1;
    return c;
  }, [all]);
  const rows = useMemo(() => (filter === "ALL" ? all : all.filter((e) => kindOf(e.type) === filter)), [all, filter]);
  const latest = all.find((e) => e.at)?.at ?? null;
  const opts: Filter[] = ["ALL", "ORD", "LLM", "JOB", "PTR", "13F", "NEWS"];

  // On the ALL tape, collapse a filer's same-day burst of PTR/13F lines into
  // one row (expand to see each filing).
  const items = useMemo<Item[]>(() => {
    if (filter !== "ALL") return rows.map((e) => ({ e }));
    const out: Item[] = [];
    for (const e of rows) {
      const k = kindOf(e.type);
      const pz = k === "PTR" || k === "13F" ? parseFiling(e) : null;
      const prev = out[out.length - 1];
      if (pz && prev && kindOf(prev.e.type) === k) {
        const pp = parseFiling(prev.e);
        if (pp && pp.who === pz.who && prev.e.at && e.at && dayOf(prev.e.at) === dayOf(e.at)) {
          prev.group = prev.group ?? [prev.e];
          prev.group.push(e);
          continue;
        }
      }
      out.push({ e });
    }
    return out;
  }, [rows, filter]);

  // Day headers count both: events (what the filter holds) and rows (what is drawn).
  const perDay = useMemo(() => {
    const m = new Map<string, { ev: number; rows: number }>();
    for (const it of items) {
      if (!it.e.at) continue;
      const d = dayOf(it.e.at);
      const c = m.get(d) ?? { ev: 0, rows: 0 };
      c.ev += it.group?.length ?? 1;
      c.rows += 1;
      m.set(d, c);
    }
    return m;
  }, [items]);
  const countLabel = (ev: number, rws: number) => `${ev} ${ev === 1 ? "event" : "events"}${rws !== ev ? ` · ${rws} ${rws === 1 ? "row" : "rows"}` : ""}`;

  return (
    <Panel
      code="WIRE"
      title="Events"
      sub={
        data && compact ? (
          <span title={countLabel(rows.length, items.length)}>{rows.length} events</span>
        ) : data ? (
          <span>
            {countLabel(rows.length, items.length)} · <span style={{ color: "var(--blue)" }} title="Blue ticker = the book holds it">blue = held</span>

          </span>
        ) : undefined
      }
      actions={
        <>
          <Seg
          options={opts
            .filter((o) => o === "ALL" || o === filter || counts[o])
            .map((o) => ({ value: o, label: compact || o === "ALL" || !counts[o] ? o : `${o}·${counts[o]}` }))}
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setOpen(null);
          }}
          label="Wire type filter"
        />
          {data && <DataAge at={latest} />}
        </>
      }
      flush
      className={className}
      style={style}
      testId="panel-wire"
    >
      <div className={s.col} ref={bodyRef}>
        <ScrollArea watch={`${filter}|${items.length}|${open}`}>
          {isLoading ? (
            <Skeleton rows={10} height={14} />
          ) : isError ? (
            <Empty>
              <span className="alert">Wire unavailable</span> — /terminal/wire did not respond. Retrying every 20s.
            </Empty>
          ) : items.length === 0 ? (
            <Empty>
              {filter === "JOB"
                ? "No failed or skipped jobs on record — every scheduled job ran clean."
                : filter === "13F"
                  ? "No 13F filings on the wire yet — the 13F job runs weekly (Sun 06:00 UTC)."
                  : filter === "NEWS"
                    ? "No ticker-tagged headline with a non-neutral sentiment score in this window. The full feed is in TOP."
                    : filter === "ALL"
                    ? "Nothing on the wire yet."
                    : `No ${TAGS[filter as Kind].title.toLowerCase()} events in the last ${all.length}.`}
            </Empty>
          ) : (
            <>
            <div className={s.head} style={{ gridTemplateColumns: COLS }}>
              <span>Time</span>
              <span>Type</span>
              <span />
              <span>Tkr</span>
              <span>
                Event <span style={{ color: "var(--blue)", textTransform: "none", letterSpacing: 0, marginLeft: 6 }} title="Blue ticker = the book holds it">blue = held</span>
              </span>
              <span className={s.r} title="News: headline sentiment, VADER −1…+1 (a text score, not a price move)">
                Sent
              </span>
              <span />
            </div>
            {items.map((it, i) => {
              const e = it.e;
              const grp = it.group;
              const k = kindOf(e.type);
              const tag = TAGS[k];
              const key = grp ? `grp|${evKey(e)}` : evKey(e);
              const day = e.at ? dayOf(e.at) : "";
              const prevAt = i > 0 ? items[i - 1].e.at : null;
              const rule = day && (!prevAt || dayOf(prevAt) !== day) ? day : null;
              const expandable = grp ? true : !!e.detail && k !== "NEWS";
              const isOpen = open === key;
              const rawTone = grp ? (grp.every((x) => x.tone === "up") ? "up" : grp.every((x) => x.tone === "down") ? "down" : "mixed") : e.tone;
              // ▲▼ only for trade direction (orders, filings); a failed routine/job is a status.
              const isStatusKind = k === "LLM" || k === "JOB";
              const tone = isStatusKind && rawTone === "down" ? "alert" : rawTone;
              const sc = k === "NEWS" ? e.vader_score : undefined;
              const sentText = sc != null ? `${sc >= 0 ? "+" : "−"}${Math.abs(sc).toFixed(2).replace(/^0/, "")}` : "";
              // ▲▼ = trade side (orders, filings); "!" = a failed/skipped routine or job.
              const dirGlyph =
                k === "NEWS"
                  ? ""
                  : tone === "up"
                    ? "▲"
                    : tone === "down"
                      ? "▼"
                      : tone === "warn" || tone === "alert"
                        ? "!"
                        : tone === "mixed"
                          ? "◆"
                          : "";
              const dirColor =
                tone === "up" ? "var(--up)" : tone === "down" ? "var(--down)" : tone === "alert" ? "var(--alert)" : tone === "warn" ? "var(--warn)" : "var(--ink-3)";
              const isFiling = k === "PTR" || k === "13F";
              // The time column holds clock times only. Filings are date-only: the
              // cell says "filed"; the trade date lives in the row text.
              const tradedDates = (grp ?? [e]).map((x) => x.traded_on).filter((d): d is string => !!d);
              const timeTitle = isFiling
                ? `Filing — no time of day · filed ${day}${tradedDates.length ? ` · traded ${dateRange(tradedDates)}` : k === "13F" ? " · 13F reports quarter-end holdings" : ""}`
                : e.at
                  ? when(e.at)
                  : undefined;
              const isFresh = grp ? grp.some((x) => fresh.has(evKey(x))) : fresh.has(key);
              const toggle = () => setOpen(isOpen ? null : key);
              return (
                <Fragment key={`${key}-${i}`}>
                  {rule && (
                    <DayRule
                      dayKey={rule}
                      right={
                        <span className="dim" style={{ fontWeight: 500 }}>
                          {countLabel(perDay.get(rule)?.ev ?? 0, perDay.get(rule)?.rows ?? 0)}
                        </span>
                      }
                    />
                  )}
                  <div
                    className={`${s.row}${expandable ? ` ${s.rowBtn}` : ""}${isOpen ? ` ${s.rowOpen}` : ""}${isFresh ? ` ${s.arrive}` : ""}`}
                    data-row
                    style={{ gridTemplateColumns: COLS }}
                    onClick={expandable ? toggle : undefined}
                    role={expandable ? "button" : undefined}
                    tabIndex={expandable ? 0 : undefined}
                    aria-expanded={expandable ? isOpen : undefined}
                    onKeyDown={
                      expandable
                        ? (ev) => {
                            if (ev.key === "Enter" || ev.key === " ") {
                              ev.preventDefault();
                              toggle();
                            }
                          }
                        : undefined
                    }
                  >
                    {isFiling || !e.at || !clock(e.at) ? (
                      <span className={s.time} title={timeTitle} style={{ color: "var(--ink-4)", fontFamily: "var(--font-plex-cond), sans-serif", fontVariant: "all-small-caps", letterSpacing: "0.06em", fontSize: 11 }}>
                        {isFiling ? "filed" : "—"}
                      </span>
                    ) : (
                      <span className={s.time} title={timeTitle}>
                        {clock(e.at)}
                      </span>
                    )}
                    <span className={s.tag} style={{ color: tag.fg, background: tag.bg, borderColor: tag.bd }} title={tag.title}>
                      {k}
                    </span>
                    <span
                      className={s.mono}
                      style={{ color: dirColor, fontSize: 8.5, textAlign: "center" }}
                      title={tone === "alert" ? "Failed" : tone === "warn" ? "Skipped" : dirGlyph ? "Trade side" : undefined}
                    >
                      {dirGlyph}
                    </span>
                    {grp || ((k === "PTR" || k === "13F") && parseFiling(e)) ? (
                      <span className={s.ell} style={{ gridColumn: "4 / span 2", fontSize: 12 }}>
                        <BurstText items={grp ?? [e]} held={held} kind={k} />
                      </span>
                    ) : (
                      <>
                        {e.ticker && (
                          <span>
                            <Tkr t={e.ticker} held={held.has(e.ticker)} />
                          </span>
                        )}
                        {k === "NEWS" && e.url ? (
                          <a
                            className={s.hl}
                            style={{ gridColumn: e.ticker ? undefined : "4 / span 2", fontWeight: 400 }}
                            href={e.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`${e.text}${e.detail ? ` — ${e.detail}` : ""}`}
                            onClick={(ev) => ev.stopPropagation()}
                          >
                            {e.text}
                            {e.detail && (
                              <span className="dim" style={{ marginLeft: 8, fontSize: 10.5 }}>
                                {e.detail}
                              </span>
                            )}
                          </a>
                        ) : (
                          <span
                            className={s.ell}
                            style={{
                              gridColumn: e.ticker ? undefined : "4 / span 2",
                              fontSize: k === "LLM" || k === "ORD" ? 11 : 12,
                              fontFamily: k === "LLM" || k === "ORD" ? "var(--font-plex-mono), monospace" : undefined,
                              letterSpacing: k === "LLM" || k === "ORD" ? "-0.01em" : undefined,
                            }}
                            title={e.text}
                          >
                            {renderText(e, k)}
                            {!isOpen && e.detail && k !== "NEWS" && (
                              <span style={{ color: "var(--ink-3)", fontFamily: "var(--font-plex-cond), sans-serif", fontSize: 11.5, marginLeft: 10, letterSpacing: 0 }}>
                                {plain(e.detail)}
                              </span>
                            )}
                          </span>
                        )}
                      </>
                    )}
                    <span
                      className={s.mono}
                      style={{ fontSize: 10, color: "var(--ink-3)", textAlign: "right" }}
                      title={sentText ? `Headline sentiment ${sentText} (VADER −1…+1) — a text score, not a price move` : undefined}
                    >
                      {sentText}
                    </span>
                    <span className={`${s.chev}${isOpen ? ` ${s.chevOpen}` : ""}`} aria-hidden="true">
                      {expandable ? "›" : ""}
                    </span>
                  </div>
                  {isOpen && grp && (
                    <div className={s.detail} style={{ paddingLeft: DETAIL_PAD, whiteSpace: "normal" }} data-cut>
                      <div className={s.detailMeta}>
                        <span style={{ color: tag.fg }}>
                          {tag.title.toUpperCase()} · {grp.length} {k === "13F" ? "POSITION CHANGES" : "FILINGS"}
                        </span>
                        {e.at && <span>{when(e.at)}</span>}
                      </div>
                      {grp.map((x, j) => {
                        const pz = parseFiling(x);
                        return (
                          <div key={j} style={{ display: "grid", gridTemplateColumns: "38px 56px 96px 1fr", alignItems: "center", height: 18 }}>
                            <span className={`${s.side} ${pz?.side === "BUY" ? "up" : "down"}`}>{pz?.verb ?? ""}</span>
                            <span>{x.ticker ? <Tkr t={x.ticker} held={held.has(x.ticker)} /> : null}</span>
                            <span className="num" style={{ fontSize: 10.5, color: pz?.amt ? "var(--ink-2)" : "var(--ink-4)" }}>
                              {pz ? filingAmt(pz, k) : ""}
                            </span>
                            <span className="num dim" style={{ fontSize: 10.5 }}>
                              {pz?.traded ? `traded ${pz.traded}` : x.detail ?? ""}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {isOpen && !grp && e.detail && (
                    <div className={s.detail} style={{ paddingLeft: DETAIL_PAD }} data-cut>
                      <div className={s.detailMeta}>
                        <span style={{ color: tag.fg }}>{tag.title.toUpperCase()}</span>
                        {e.at && <span>{when(e.at)}</span>}
                        {e.ticker && <span style={{ color: "var(--ink-2)" }}>{e.ticker}</span>}
                      </div>
                      <MiniMd text={e.detail} />
                    </div>
                  )}
                </Fragment>
              );
            })}
            </>
          )}
        </ScrollArea>
      </div>
    </Panel>
  );
}
