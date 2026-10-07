"use client";

/**
 * BOT — the machine, full page: the ops console (status, schedule, activity
 * matrix, tool usage, routine log with traces) beside MEMO, a reader for the
 * bot's persistent memory files (strategy rulebook, daily research ledger,
 * portfolio snapshot, trade log).
 */
import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type MemoryDoc } from "@/lib/api";
import { fmtAge, fmtET } from "@/lib/format";
import { BotPanel, Md, parseMd } from "@/components/term/BotPanel";
import { Empty, Panel, Seg, Skeleton, useNow } from "@/components/term/ui";
import s from "@/components/term/BotPanel.module.css";

type DocName = MemoryDoc["name"];

const DOCS: { value: DocName; label: string }[] = [
  { value: "strategy", label: "Strategy" },
  { value: "research_log", label: "Research log" },
  { value: "portfolio", label: "Portfolio" },
  { value: "trade_log", label: "Trade log" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-07-20" → { wd: "Mon", md: "Jul 20", month: "July 2026" } without tz shift. */
function dateBits(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return {
    wd: WD[dt.getUTCDay()],
    md: `${MONTHS[m - 1]} ${String(d).padStart(2, "0")}`,
    month: `${MONTHS[m - 1]} ${y}`,
  };
}

const fmtKB = (b: number) => (b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);

// ── research log: one entry per `## <date>` / `## Weekly review <date>` ──

type Entry = { id: string; date: string; weekly: boolean; body: string; has: { P: boolean; E: boolean; M: boolean; C: boolean } };

function parseResearch(src: string): Entry[] {
  const map = new Map<string, Entry>();
  let cur: Entry | null = null;
  for (const line of src.replace(/\r/g, "").split("\n")) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      const date = /(\d{4}-\d{2}-\d{2})/.exec(h[1])?.[1] ?? h[1].trim();
      const weekly = /weekly/i.test(h[1]);
      const id = `${weekly ? "W" : "D"}${date}`;
      cur = map.get(id) ?? { id, date, weekly, body: "", has: { P: false, E: false, M: false, C: false } };
      map.set(id, cur);
      continue;
    }
    if (!cur) continue; // preamble
    const sub = /^###\s+(.*)$/.exec(line)?.[1]?.toLowerCase() ?? "";
    if (sub.startsWith("pre")) cur.has.P = true;
    else if (sub.startsWith("execute")) cur.has.E = true;
    else if (sub.startsWith("midday")) cur.has.M = true;
    else if (sub.startsWith("close")) cur.has.C = true;
    cur.body += `${line}\n`;
  }
  // Newest first; a Friday's weekly review sits just above that Friday.
  return [...map.values()].sort((a, b) => (a.date === b.date ? (a.weekly ? -1 : 1) : a.date < b.date ? 1 : -1));
}

function ResearchLog({ content }: { content: string }) {
  const entries = useMemo(() => parseResearch(content), [content]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? entries.filter((e) => e.body.toLowerCase().includes(t)) : entries;
  }, [entries, q]);
  const cur = shown.find((e) => e.id === sel) ?? shown[0] ?? null;
  const idx = cur ? shown.indexOf(cur) : -1;
  const blocks = useMemo(() => (cur ? parseMd(cur.body) : []), [cur]);
  if (!entries.length) return <Empty>The research ledger is empty — the first pre-market routine opens it.</Empty>;

  const monthOf = (e: Entry) => (/^\d{4}-\d{2}-\d{2}$/.test(e.date) ? dateBits(e.date).month : "");
  return (
    <div className={s.memo}>
      <div className={s.memoIndex}>
        <div className={s.memoFilter}>
          <input className="input" placeholder="grep… e.g. GOOGL" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter research log" spellCheck={false} />
        </div>
        <div className={s.memoList}>
          {shown.length === 0 && <div className="panel-empty">No entries match.</div>}
          {shown.map((e, i) => {
            const b = /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? dateBits(e.date) : null;
            const month = monthOf(e);
            const head = i === 0 || month !== monthOf(shown[i - 1]) ? month : null;
            return (
              <Fragment key={e.id}>
                {head && <div className={s.memoMonth}>{head}</div>}
                <button type="button" className={s.memoItem} aria-current={cur?.id === e.id} data-weekly={e.weekly || undefined} onClick={() => setSel(e.id)}>
                  <span>{b ? `${e.weekly ? "WKLY" : b.wd.toUpperCase()} ${b.md}` : e.date}</span>
                  {!e.weekly && (
                    <span className={s.memoPips} aria-label="sections">
                      {(["P", "E", "M", "C"] as const).map((k) => (
                        <i key={k} data-on={e.has[k]}>
                          {k}
                        </i>
                      ))}
                    </span>
                  )}
                </button>
              </Fragment>
            );
          })}
        </div>
      </div>
      <div className={s.memoDoc}>
        {cur && (
          <>
            <div className={s.memoDocHead}>
              <b>{cur.weekly ? "WEEKLY REVIEW" : /^\d{4}/.test(cur.date) ? dateBits(cur.date).wd.toUpperCase() : ""} {cur.date}</b>
              <span>· {fmtKB(cur.body.length)}</span>
              <span className={s.memoNav}>
                <button type="button" disabled={idx >= shown.length - 1} onClick={() => setSel(shown[idx + 1]?.id ?? null)} title="Older entry">
                  ‹
                </button>
                <button type="button" disabled={idx <= 0} onClick={() => setSel(shown[idx - 1]?.id ?? null)} title="Newer entry">
                  ›
                </button>
              </span>
            </div>
            <div className={s.memoScroll} key={cur.id}>
              <Md blocks={blocks} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── trade log: parse the handler-written lines into a blotter ────────────

type LogTrade = { at: string; side: "BUY" | "SELL"; tkr: string; qty: number; px: number; notional: number; stop: string | null; kind: string; text: string };

const TRADE_RE = /^- (\S+) \| (BUY|SELL)\s+(\S+)\s+qty=\s*([\d.]+) @ ~\$\s*([\d.,]+) notional=\$\s*([\d.,]+)(?: stop=(\S+))?\s+(thesis|reason): (.*)$/;

function TradeLog({ content }: { content: string }) {
  const { trades, rest } = useMemo(() => {
    const trades: LogTrade[] = [];
    const rest: string[] = [];
    for (const line of content.split("\n")) {
      const m = TRADE_RE.exec(line);
      if (m) {
        trades.push({
          at: m[1],
          side: m[2] as "BUY" | "SELL",
          tkr: m[3],
          qty: Number(m[4]),
          px: Number(m[5].replace(/,/g, "")),
          notional: Number(m[6].replace(/,/g, "")),
          stop: m[7] ?? null,
          kind: m[8],
          text: m[9],
        });
      } else rest.push(line);
    }
    return { trades: trades.reverse(), rest: rest.join("\n") };
  }, [content]);
  const [open, setOpen] = useState<number | null>(null);
  if (!trades.length) return <div className={s.memoScroll}><Md text={content} /></div>;
  return (
    <div style={{ height: "100%", overflow: "auto" }}>
      <table className={`tbl ${s.tlog}`}>
        <thead>
          <tr>
            <th>ET</th>
            <th style={{ textAlign: "left" }}>Side</th>
            <th style={{ textAlign: "left" }}>Tkr</th>
            <th>Qty</th>
            <th>~Px</th>
            <th>Notional</th>
            <th>Stop</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <Fragment key={`${t.at}-${t.tkr}-${i}`}>
              <tr className={s.main}>
                <td style={{ color: "var(--ink-3)" }}>{fmtET(t.at)}</td>
                <td style={{ textAlign: "left" }}>
                  <span className={`pill ${t.side === "BUY" ? "up" : "down"}`} style={{ height: 16 }}>
                    {t.side}
                  </span>
                </td>
                <td style={{ textAlign: "left" }}>
                  <Link href={`/security/${encodeURIComponent(t.tkr)}`} className="tkr">
                    {t.tkr}
                  </Link>
                </td>
                <td>{t.qty.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                <td>{t.px.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td>${t.notional.toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
                <td style={{ color: "var(--ink-3)" }}>{t.stop ?? "—"}</td>
              </tr>
              <tr>
                <td colSpan={7} className={s.thesis} data-open={open === i} onClick={() => setOpen(open === i ? null : i)} title={open === i ? "Collapse" : "Expand"}>
                  <div>
                    <span style={{ color: "var(--cyan)", fontFamily: "var(--font-plex-mono)", fontSize: 9.5, letterSpacing: "0.06em", marginRight: 6 }}>
                      {t.kind.toUpperCase()}
                    </span>
                    {t.text}
                  </div>
                </td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
      {rest.trim() && (
        <div className={s.memoScroll} style={{ borderTop: "1px solid var(--line)" }}>
          <Md text={rest} />
        </div>
      )}
    </div>
  );
}

// ── MEMO panel ───────────────────────────────────────────────────────────

function MemoryViewer({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  const [doc, setDoc] = useState<DocName>("research_log");
  const now = useNow(30_000);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["memory", doc],
    queryFn: () => api.memory(doc),
    refetchInterval: 120_000,
  });
  return (
    <Panel
      code="MEMO"
      title="State files"
      sub={data ? `${doc}.md · ${fmtKB(data.bytes)}${data.updated_at && now ? ` · ${fmtAge(data.updated_at, now)} ago` : ""}` : `${doc}.md`}
      className={className}
      style={style}
      bodyStyle={{ padding: 0, position: "relative" }}
      actions={<Seg options={DOCS} value={doc} onChange={setDoc} label="Memory file" />}
    >
      <div style={{ position: "absolute", inset: 0 }}>
        {isLoading ? (
          <Skeleton rows={10} height={14} />
        ) : isError || !data ? (
          <Empty>Could not load {doc}.md from /memory.</Empty>
        ) : doc === "research_log" ? (
          <ResearchLog content={data.content} />
        ) : doc === "trade_log" ? (
          <TradeLog content={data.content} />
        ) : (
          <div className={s.memoScroll} style={{ height: "100%" }}>
            {doc === "strategy" && (
              <p className={s.note} style={{ margin: "0 0 8px", fontSize: 10.5, color: "var(--ink-4)", fontFamily: "var(--font-plex-mono)" }}>
                hand-authored rulebook · the LLM cannot write this file · hard caps live in bot/llm/tools.py
              </p>
            )}
            <Md text={data.content} />
          </div>
        )}
      </div>
    </Panel>
  );
}

export default function BotPage() {
  return (
    <div className={s.pageGrid}>
      <BotPanel variant="page" />
      <MemoryViewer />
    </div>
  );
}
