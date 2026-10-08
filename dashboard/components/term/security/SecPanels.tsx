"use client";

/**
 * The lower deck of the security screen: CN (ticker news — Yahoo per-ticker
 * feed merged with the bot's own store), FLOW (politician PTRs + 13F), EVTS
 * (next report + EPS surprise history) and DES (company description).
 * Every list is fitted to whole rows with a "▼ N more" footer (Fit.tsx).
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import type { SecurityResp, TickerNews } from "@/lib/api";
import { fmtBig, fmtChg, fmtET, fmtNum, tone } from "@/lib/format";
import { Panel, Skeleton, useNow } from "../ui";
import { FitLines, FitList } from "./Fit";
import { dayNum, daysUntil, etDate, fmtD, ymd, MONTHS } from "./util";
import type { Profile } from "./SecurityHeader";
import s from "./security.module.css";

type P = { className?: string; style?: CSSProperties };

function Note({ children }: { children: ReactNode }) {
  return <div className="panel-empty" style={{ padding: "10px 10px" }}>{children}</div>;
}

// ── CN ───────────────────────────────────────────────────────────────────

type Headline = { key: string; title: string; url: string; source: string; at: string | null; summary: string; v: number | null; tickers: string[] };

const SUFFIX = /\b(inc|incorporated|corp|corporation|company|co|ltd|limited|plc|holdings|group|the|class [a-z]|n\.?v|s\.?a)\b\.?/gi;
const GENERIC = new Set(["general", "american", "united", "first", "national", "international", "global", "home", "bank", "core"]);

/** Words a headline would use to name this company: "Visa", "Sherwin-Williams", "(NVDA)". */
function mentionMatcher(ticker: string, names: (string | null | undefined)[]): (text: string) => boolean {
  const pats = new Set<string>();
  for (const raw of names) {
    if (!raw) continue;
    const core = raw.replace(/[,&]/g, " ").replace(SUFFIX, " ").replace(/\s+/g, " ").trim();
    if (core.length >= 3) pats.add(core);
    const first = core.split(" ")[0];
    if (first && first.length >= 4 && !GENERIC.has(first.toLowerCase())) pats.add(first);
  }
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`\\b(${[...pats].map(esc).join("|")})\\b`, "i");
  const tk = new RegExp(`\\(${esc(ticker)}\\)|\\$${esc(ticker)}\\b${ticker.length >= 3 ? `|\\b${esc(ticker)}\\b` : ""}`);
  return (text) => (pats.size > 0 && rx.test(text)) || tk.test(text);
}

/** Headline sentiment: VADER compound score, signed and sign-coloured. */
function SentNum({ v }: { v: number | null }) {
  const neutral = v == null || Math.abs(v) < 0.05;
  return (
    <span
      className={`num ${neutral ? "" : v! > 0 ? "up" : "down"}`}
      style={{ fontSize: neutral ? 10 : 11, textAlign: "right", color: neutral ? "var(--ink-3)" : undefined }}
      title={
        v == null
          ? "No sentiment score"
          : `Headline sentiment (VADER compound): ${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)} on a −1 (negative) … +1 (positive) scale; |score| < 0.05 is shown as “neu” (neutral).`
      }
    >
      {v == null ? "—" : neutral ? "neu" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`}
    </span>
  );
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function SecNews({
  data,
  yahoo,
  profileName,
  loading,
  className = "",
  style,
}: P & { data: SecurityResp; yahoo: TickerNews | undefined; profileName: string | null; loading: boolean }) {
  // Yahoo's per-ticker feed is primary; the bot's own store fills in; dedupe by title.
  const seen = new Set<string>();
  const items: Headline[] = [];
  for (const n of yahoo?.items ?? []) {
    const k = norm(n.title);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    items.push({ key: `y${k}`, title: n.title, url: n.url, source: n.source, at: n.published_at, summary: n.summary, v: n.vader_score ?? null, tickers: [] });
  }
  for (const n of data.news) {
    const k = norm(n.title);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    items.push({ key: `d${n.id}`, title: n.title, url: n.url, source: n.source, at: n.published_at, summary: "", v: n.vader_score, tickers: n.tickers });
  }
  items.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  const mentions = mentionMatcher(data.ticker, [data.name, profileName]);
  const relevant = items.filter((n) => mentions(`${n.title} ${n.summary}`) || n.tickers.includes(data.ticker));
  const nOther = items.length - relevant.length;
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : relevant;
  const scored = shown.filter((n) => n.v != null);
  const avg = scored.length ? scored.reduce((a, n) => a + (n.v as number), 0) / scored.length : null;
  return (
    <Panel
      code="CN"
      title="News"
      sub={items.length ? `${relevant.length} name ${data.ticker}${showAll && nOther ? ` + ${nOther} related` : ""}` : undefined}
      actions={
        <>
          {avg != null && (
            <span className="num" style={{ fontSize: 10.5, color: "var(--ink-3)" }} title="Mean VADER sentiment of the listed headlines">
              SENT <span className={tone(avg, 0.05)}>{avg >= 0 ? "+" : "−"}{Math.abs(avg).toFixed(2)}</span>
            </span>
          )}
          {nOther > 0 && (
            <button
              type="button"
              className={s.miniBtn}
              aria-pressed={showAll}
              onClick={() => setShowAll((v) => !v)}
              title="Headlines from the ticker feed that don't name the company (market and sector stories)"
            >
              {showAll ? "Named only" : `+${nOther} related`}
            </button>
          )}
        </>
      }
      className={className}
      style={style}
      flush
      bodyStyle={{ overflow: "hidden" }}
    >
      {!shown.length ? (
        loading ? (
          <Skeleton rows={5} height={14} />
        ) : (
          <Note>
            {items.length
              ? `None of the latest ${items.length} feed headlines name ${data.ticker}${nOther ? " — related market stories are behind “+related”." : "."}`
              : `No headlines for ${data.ticker} from Yahoo’s ticker feed or the bot’s news store.`}
          </Note>
        )
      ) : (
        <FitList unit="headlines">
          {shown.map((n) => {
            const when = n.at ? fmtET(n.at) : "—";
            const others = n.tickers.filter((t) => t !== data.ticker).slice(0, 3);
            const named = relevant.includes(n);
            return (
              <a key={n.key} href={n.url} target="_blank" rel="noopener noreferrer" className={s.news} title={`${n.source}${n.summary ? ` — ${n.summary}` : ""}`}>
                <span className="num" style={{ fontSize: 10.5, color: "var(--ink-3)", lineHeight: 1.35 }}>
                  {when.slice(0, 6)}
                  <br />
                  <span style={{ color: "var(--ink-2)" }}>{when.slice(7)}</span>
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className={s.newsTitle} style={named ? undefined : { color: "var(--ink-3)" }}>
                    {n.title}
                  </span>
                  {others.length > 0 && (
                    <span style={{ display: "flex", gap: 4, marginTop: 3 }}>
                      {others.map((t) => (
                        <span key={t} className={s.chip}>
                          {t}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <SentNum v={n.v} />
              </a>
            );
          })}
        </FitList>
      )}
    </Panel>
  );
}

// ── FLOW ─────────────────────────────────────────────────────────────────

/** API adds 13F context to each signal; declared here until lib/api.ts types it. */
type Sig = SecurityResp["signals"][number] & { period?: string | null; filed?: string | null; change?: string | null };

/** Statutory PTR amount bands, keyed by the midpoint the DB stores. */
const PTR_BANDS: Record<number, string> = {
  8000: "$1,001–$15,000",
  32500: "$15,001–$50,000",
  75000: "$50,001–$100,000",
  175000: "$100,001–$250,000",
  375000: "$250,001–$500,000",
  750000: "$500,001–$1,000,000",
  3000000: "$1,000,001–$5,000,000",
  15000000: "$5,000,001–$25,000,000",
  37500000: "$25,000,001–$50,000,000",
};

/** "2026-06-30" → "Q2'26". */
const qLabel = (d: string) => {
  const [y, m] = ymd(d);
  return `Q${Math.ceil(m / 3)}'${String(y).slice(2)}`;
};

type PtrRow = { key: string; who: string; chamber: string; up: boolean; mid: number | null; day: string; n: number };
type F13Row = { key: string; who: string; verb: string; up: boolean; value: number | null; period: string | null; filed: string | null };

export function SecFlow({ data, className = "", style }: P & { data: SecurityResp }) {
  const now = useNow(60_000);
  const sig = data.signals as Sig[];
  // Politician PTRs: identical disclosures (filer, side, day, band) collapse to one row ×N.
  const ptrMap = new Map<string, PtrRow>();
  for (const g of sig.filter((x) => x.kind !== "investor")) {
    const day = etDate(g.as_of);
    const key = `${g.source}|${g.direction}|${day}|${g.amount ?? ""}`;
    const prev = ptrMap.get(key);
    if (prev) prev.n += 1;
    else
      ptrMap.set(key, {
        key,
        who: g.source,
        chamber: g.chamber === "senate" ? "SEN" : g.chamber === "house" ? "HSE" : "PTR",
        up: g.direction === "buy",
        mid: g.amount,
        day,
        n: 1,
      });
  }
  const ptr = [...ptrMap.values()].sort((a, b) => b.day.localeCompare(a.day));
  const ptrN = sig.filter((x) => x.kind !== "investor").length;
  const ptrBuys = ptr.reduce((a, r) => a + (r.up ? r.n : 0), 0);
  const ptrNet = ptr.reduce((a, r) => a + (r.up ? 1 : -1) * (r.mid ?? 0) * r.n, 0);
  // 13F: quarter-end holdings changes — top holders by reported position value.
  const f13: F13Row[] = sig
    .filter((x) => x.kind === "investor")
    .map((g) => {
      const change = (g.change ?? "").toLowerCase();
      const up = change ? change === "new" || change === "add" : g.direction === "buy";
      return {
        key: `f${g.id}`,
        who: g.source,
        verb: change ? change.toUpperCase() : up ? "ADD" : "TRIM",
        up,
        value: g.amount,
        period: g.period ?? null,
        filed: g.filed ?? null,
      };
    })
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const periods = [...new Set(f13.map((r) => r.period).filter((x): x is string => !!x))].sort();
  const latest = periods[periods.length - 1] ?? null;
  const filedDays = [...new Set(f13.map((r) => r.filed).filter((x): x is string => !!x))].sort();
  const age = latest && now ? dayNum(etDate(new Date(now).toISOString())) - dayNum(latest) : null;
  const f13Adds = f13.filter((r) => r.up).length;
  /** "~$16K mid": total of the disclosed-range midpoints (×N already folded in). */
  const k$ = (v: number) => (Math.abs(v) < 1e6 ? `$${Math.round(Math.abs(v) / 1000)}K` : `$${fmtBig(Math.abs(v))}`);
  const midLabel = (v: number | null, n: number) => (v ? `~${k$(v * n)} mid` : "—");
  return (
    <Panel code="FLOW" title="Politician & 13F" className={className} style={style} flush bodyStyle={{ overflow: "hidden" }}>
      {!sig.length ? (
        <Note>
          No congressional trades or 13F holders of {data.ticker} on record. House PTRs scrape daily, Senate eFD daily, 13F weekly.
        </Note>
      ) : (
        <div className={s.col}>
          {/* ── congressional PTRs ── */}
          <div className={s.flowSec} title={`${ptrN} disclosures: ${ptrBuys} buys, ${ptrN - ptrBuys} sells. Net of disclosed-range midpoints.`}>
            <span className="label">Congress PTR</span>
            {ptrN > 0 ? (
              <span className="num">
                <span className="up">▲{ptrBuys}</span> <span className="down">▼{ptrN - ptrBuys}</span> net{" "}
                <span className={tone(ptrNet)}>
                  ~{ptrNet >= 0 ? "+" : "−"}
                  {k$(ptrNet)}
                </span>
              </span>
            ) : (
              <span className="dim">none</span>
            )}
          </div>
          {ptr.length > 0 && (
            <div style={{ flex: "1 1 0", minHeight: 0, display: "flex" }}>
              <FitList unit="disclosures">
                {ptr.map((r) => (
                  <div key={r.key} className={s.flowLine} title={`${r.who} · ${r.chamber === "SEN" ? "Senate" : r.chamber === "HSE" ? "House" : "Congress"}${r.n > 1 ? ` · ${r.n} identical disclosures` : ""}`}>
                    <span className="num dim">{fmtD(r.day)}</span>
                    <span className={s.flowWho}>
                      {r.who}
                    </span>
                    <span className={s.chip} style={{ color: "var(--ink-3)" }}>
                      {r.chamber === "SEN" ? "S" : r.chamber === "HSE" ? "H" : "C"}
                      {r.n > 1 ? `×${r.n}` : ""}
                    </span>
                    <span className={`num ${r.up ? "up" : "down"}`} style={{ fontWeight: 600 }}>
                      {r.up ? "BUY" : "SELL"}
                    </span>
                    <span
                      className="num"
                      style={{ color: "var(--ink)", textAlign: "right" }}
                      title={`Midpoint of the disclosed range${r.mid != null && PTR_BANDS[r.mid] ? ` (${PTR_BANDS[r.mid]})` : ""}${r.n > 1 ? ` × ${r.n} disclosures` : ""}. PTRs report a range, not an exact amount; the DB stores only the midpoint.`}
                    >
                      {midLabel(r.mid, r.n)}
                    </span>
                  </div>
                ))}
              </FitList>
            </div>
          )}
          {/* ── 13F top holders (stale by construction: quarter-end, filed ≤45d later) ── */}
          <div
            className={s.flowSec}
            style={{ borderTop: "1px solid var(--line)" }}
            title="13F filings report quarter-end holdings, filed up to 45 days later — position changes, not trades."
          >
            <span className="label">13F top holders</span>
            {f13.length > 0 ? (
              <span
                className="num dim"
                title={filedDays.length ? `Filed ${fmtD(filedDays[0])}${filedDays.length > 1 ? `–${fmtD(filedDays[filedDays.length - 1])}` : ""} · ${f13Adds} new/add · ${f13.length - f13Adds} trim/exit` : undefined}
              >
                {latest ? `${qLabel(latest)} holdings` : "—"}
                {age != null ? ` · ${age}d old` : ""}
              </span>
            ) : (
              <span className="dim">none on file</span>
            )}
          </div>
          {f13.length > 0 && (
            <div style={{ flex: "1 1 0", minHeight: 0, display: "flex" }}>
              <FitList unit="holders">
                {f13.map((r) => (
                  <div key={r.key} className={`${s.flowLine} ${s.flowLine13}`} title={r.period ? `${qLabel(r.period)} holdings${r.filed ? `, filed ${fmtD(r.filed)}` : ""}` : undefined}>
                    <span className={s.flowWho} title={r.who} style={{ color: "var(--ink-2)" }}>
                      {r.who}
                    </span>
                    <span className={`num ${r.up ? "up" : "down"}`} style={{ fontWeight: 600, opacity: 0.85 }}>
                      {r.up ? "▲" : "▼"} {r.verb}
                    </span>
                    <span className="num" style={{ color: "var(--ink-2)", textAlign: "right" }} title="Reported position value at quarter-end">
                      ${fmtBig(r.value)}
                    </span>
                  </div>
                ))}
              </FitList>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

// ── EVTS ─────────────────────────────────────────────────────────────────

/** Period-end date → "2Q26" for calendar quarters, "JUL26" for off-cycle fiscal periods. */
function quarterLabel(q: string) {
  const [y, m] = ymd(q);
  const yy = String(y).slice(2);
  return m % 3 === 0 ? `${m / 3}Q${yy}` : `${MONTHS[m - 1].toUpperCase()}${yy}`;
}

export function SecEvents({ data, className = "", style }: P & { data: SecurityResp }) {
  const now = useNow(60_000);
  const { next, history } = data.earnings; // newest first
  // Surprise = actual ÷ consensus − 1 from the unrounded estimate (matches the API's figure).
  // EST shows 3 dp when it has sub-cent precision (3.142), so ACT/EST/SURPRISE reconcile by eye.
  const surp = (h: (typeof history)[number]) =>
    h.eps_actual != null && h.eps_estimate ? h.eps_actual / h.eps_estimate - 1 : h.surprise_pct;
  const surprises = history.map(surp).filter((v): v is number => v != null);
  const beats = surprises.filter((v) => v > 0).length;
  const avg = surprises.length ? surprises.reduce((a, b) => a + b, 0) / surprises.length : null;
  const maxUp = Math.max(0, ...surprises);
  const maxDn = Math.max(0, ...surprises.map((v) => -v));
  const span = maxUp + maxDn || 0.01;
  const zero = (maxDn / span) * 100; // % from the left where 0 sits
  const nextDay = next ? next.report_date.slice(0, 10) : null; // stored date, no tz shift
  const inDays = next && now ? daysUntil(next.report_date, now) : null;
  const blackout = inDays != null && inDays >= 0 && inDays <= 2;
  return (
    <Panel
      code="EVTS"
      title="Earnings"
      sub={
        <>
          {surprises.length ? `${beats}/${surprises.length} beats${avg != null ? ` · avg ${fmtChg(avg, 1)}` : ""}` : ""}
          {!next && (
            <span style={{ color: "var(--ink-3)" }} title="Next report date not yet published — the earnings calendar has no confirmed date">
              {surprises.length ? " · " : ""}next date TBA
            </span>
          )}
        </>
      }
      className={className}
      style={style}
      flush
      bodyStyle={{ overflow: "hidden" }}
    >
      <div className={s.col}>
        {next && (
          <div className={s.subHead} style={{ gap: 8, flex: "none", height: 24 }}>
            <span className="label" style={{ fontSize: 9 }}>Next</span>
            <span className="num" style={{ fontSize: 11, color: "var(--ink)" }}>{fmtD(nextDay, "dmy")}</span>
            {next.time_of_day && <span className="pill">{next.time_of_day}</span>}
            {next.eps_estimate != null && <span className="num" style={{ fontSize: 10.5, color: "var(--ink-2)" }}>est {fmtNum(next.eps_estimate)}</span>}
            {inDays != null && (
              <span className={`pill ${blackout ? "warn" : ""}`} style={{ marginLeft: "auto" }} title={blackout ? "Inside the bot's 2-day earnings blackout — no new buys" : undefined}>
                {inDays <= 0 ? "today" : `T−${inDays}d`}
                {blackout ? " · blackout" : ""}
              </span>
            )}
          </div>
        )}
        {history.length ? (
          <>
            <div className={s.evHead}>
              <span>Period</span>
              <span style={{ textAlign: "right" }}>Act</span>
              <span style={{ textAlign: "right" }}>Est</span>
              <span style={{ textAlign: "right" }}>Surprise</span>
            </div>
            <FitList unit="quarters">
              {history.map((h) => {
                const v = surp(h);
                const w = v == null ? 0 : (Math.abs(v) / span) * 100;
                return (
                  <div key={h.quarter} className={s.evRow} title={`Period ended ${fmtD(h.quarter, "dmy")}`}>
                    <span className="num" style={{ color: "var(--ink-2)" }}>{quarterLabel(h.quarter)}</span>
                    <span className="num" style={{ color: "var(--ink)", textAlign: "right" }}>{fmtNum(h.eps_actual)}</span>
                    <span
                      className="num"
                      style={{ color: "var(--ink-3)", textAlign: "right" }}
                      title={h.eps_estimate != null ? `Consensus ${h.eps_estimate} (unrounded); surprise is computed from this` : undefined}
                    >
                      {fmtNum(h.eps_estimate, h.eps_estimate != null && Math.abs(h.eps_estimate * 100 - Math.round(h.eps_estimate * 100)) > 1e-6 ? 3 : 2)}
                    </span>
                    <span className={s.evSurp}>
                      <span className={s.evTrack}>
                        {maxDn > 0 && <span className={s.evZero} style={{ left: `${zero}%` }} />}
                        {v != null && (
                          <span
                            className={s.evFill}
                            style={{ left: v >= 0 ? `${zero}%` : `${zero - w}%`, width: `${Math.max(w, 2)}%`, background: v >= 0 ? "var(--up)" : "var(--down)" }}
                          />
                        )}
                      </span>
                      <span className={`num ${tone(v)}`} style={{ width: 36, textAlign: "right", fontSize: 10.5 }}>{fmtChg(v, 1)}</span>
                    </span>
                  </div>
                );
              })}
            </FitList>
          </>
        ) : (
          <Note>No EPS history on record for {data.ticker}.</Note>
        )}
      </div>
    </Panel>
  );
}

// ── DES ──────────────────────────────────────────────────────────────────

export function SecDes({
  data,
  profile,
  loading,
  lines = 3,
  className = "",
  style,
}: P & { data: SecurityResp; profile: Profile | null; loading: boolean; lines?: number | "fit" }) {
  const host = profile?.website ? profile.website.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "") : null;
  return (
    <Panel
      code="DES"
      title="Description"
      // Industry/exchange are already in the header's meta line; headcount isn't.
      sub={profile?.employees ? <span title={`${fmtNum(profile.employees, 0)} full-time employees`}>{`${Math.round(profile.employees / 1000)}K staff`}</span> : undefined}
      actions={
        host ? (
          <a
            href={profile!.website!}
            target="_blank"
            rel="noopener noreferrer"
            className="num"
            title={profile!.website!}
            style={{ fontSize: 10.5, color: "var(--blue)", maxWidth: 128, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block" }}
          >
            {host!.length <= 16 ? host : "website"} ↗
          </a>
        ) : undefined
      }
      className={className}
      style={style}
      flush
      bodyStyle={{ overflow: "hidden" }}
    >
      <div className={typeof lines === "number" ? s.colAuto : s.col}>
        {profile?.description ? (
          <FitLines text={profile.description} lines={lines} className={s.desc} />
        ) : loading ? (
          <Skeleton rows={5} height={12} />
        ) : (
          <Note>No company profile available for {data.ticker} (yfinance returned nothing).</Note>
        )}
      </div>
    </Panel>
  );
}
