"use client";

/**
 * BLTR — order blotter (/trades). Line 1: time (ET) · side · ticker · qty ·
 * price · notional · realized P/L · status · source (LLM / MAN / ALP fill /
 * STOP). Line 2: the thesis at full panel width; click to read all of it.
 * System-generated notes (reconstructed exits) render as dim SYS notes.
 */
import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TradeRow } from "@/lib/api";
import { fmtChg, fmtPx, fmtSignedUSD, tone } from "@/lib/format";
import { Empty, Panel, Seg, Skeleton, useNow } from "./ui";
import { ScrollArea, Tkr, etHM, etKey, fmtK, mmdd } from "./feedKit";
import s from "./feeds.module.css";

type Filter = "ALL" | "BUY" | "SELL";

type Src = { code: string; fg: string; title: string };

function sourceOf(t: TradeRow): Src {
  if (t.source === "alpaca_fill") {
    const ot = (t.order_type ?? "").toLowerCase();
    return {
      code: ot.includes("trail") ? "TRAIL" : ot.includes("stop") ? "STOP" : "ALP",
      fg: "var(--ink-2)",
      title: `Alpaca fill${t.order_type ? ` · ${t.order_type}` : ""} — broker-side order, no thesis`,
    };
  }
  // Blue is reserved for "held"; LLM uses the bot-layer cyan, manual tickets neutral ink.
  if ((t.action ?? "").startsWith("manual")) return { code: "MAN", fg: "var(--ink)", title: "Manual ticket (TICKET panel / API)" };
  const kind = (t.score_breakdown as { kind?: string } | null)?.kind;
  if (kind === "bootstrap_inferred_exit")
    return { code: "STOP", fg: "var(--ink-2)", title: "Exit inferred from the 10% trailing stop (reconstructed — no broker record)" };
  return { code: "LLM", fg: "var(--cyan)", title: "Placed by an LLM routine (place_buy / place_sell)" };
}

/**
 * Order status as a state, not a direction: filled is the quiet default (no
 * mark at all); dry runs are bot-layer cyan; anything still working is a
 * watch state (warn); rejected / cancelled / failed is an action state (alert).
 */
function statusOf(st: string, dry: boolean): { text: string; fg: string; quiet: boolean } {
  const v = st.toLowerCase();
  if (dry || v.includes("dry")) return { text: "DRY", fg: "var(--cyan)", quiet: false };
  if (v === "filled") return { text: "FILL", fg: "var(--ink-2)", quiet: true };
  if (v.includes("partial")) return { text: "PART", fg: "var(--warn)", quiet: false };
  if (v.includes("reject")) return { text: "REJ", fg: "var(--alert)", quiet: false };
  if (v.includes("cancel")) return { text: "CXL", fg: "var(--alert)", quiet: false };
  if (v.includes("expire")) return { text: "EXP", fg: "var(--alert)", quiet: false };
  if (/(fail|error)/.test(v)) return { text: "FAIL", fg: "var(--alert)", quiet: false };
  return { text: v.slice(0, 4).toUpperCase() || "—", fg: "var(--warn)", quiet: false };
}

/** Thesis without its leading label: "Catalyst: GE reports…" → "GE reports…". */
function lead(reason: string | null): string {
  if (!reason) return "";
  return reason.replace(/^(catalyst|thesis|reason)\s*:\s*/i, "").replace(/\s+/g, " ");
}

/** Notes written by tooling rather than the model or a human. */
const isSysNote = (reason: string | null) => !!reason && /^reconstructed exit|^\(?dev bootstrap/i.test(reason.trim());

/** One clean line for a system-generated exit — no internal file names inline. */
function autoExitSummary(t: TradeRow): string {
  const sb = (t.score_breakdown ?? {}) as { trail?: number; peak?: number };
  if (sb.peak && sb.trail) {
    const dd = t.price / sb.peak - 1;
    return `${fmtChg(dd, 1)} off the $${fmtPx(sb.peak)} peak · ${Math.round(sb.trail * 100)}% trailing stop`;
  }
  return "System-generated exit · open for the full record";
}

/**
 * Clamp text to one line at a *word* boundary with "…" (CSS ellipsis cuts
 * mid-word). Measures with a shared canvas in the list's own font.
 */
let measureCtx: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, font: string): number {
  if (measureCtx === undefined) measureCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!measureCtx) return 0;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}
function clampWords(text: string, avail: number, font: string): string {
  if (!font || avail <= 0 || textWidth(text, font) <= avail) return text;
  const words = text.split(" ");
  const cut = (k: number) => `${words.slice(0, k).join(" ").replace(/[,;:\-–—(]+$/, "")}…`;
  let lo = 1;
  let hi = words.length - 1;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (textWidth(cut(mid), font) <= avail) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return cut(best);
}

/** Width + font of the list element (callback ref → no ref reads in render). */
function useListMetrics() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [m, setM] = useState({ width: 0, font: "" });
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) =>
      setM({ width: e.contentRect.width, font: `400 11.5px ${getComputedStyle(el).fontFamily}` }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, m.width, m.font] as const;
}

/** One line per order. Fixed columns + 6px gaps + 8px row padding each side; thesis takes the rest. */
const COL_W = [68, 38, 42, 56, 58, 50, 56, 46] as const;
const COLS = `${COL_W.map((w) => `${w}px`).join(" ")} minmax(0,1fr)`;
const THESIS_INSET = COL_W.reduce((a, b) => a + b, 0) + COL_W.length * 6 + 16;
const SYS_TAG_W = 78;
const CLAMP_SLACK = 8; // keep the word-boundary cut safely inside the CSS ellipsis fallback

/** Shares, full precision, trailing zeros trimmed (tooltips / expanded view). */
const fmtQtyPlain = (q: number) => q.toLocaleString("en-US", { maximumFractionDigits: 4 });

/**
 * Shares aligned on the decimal point: the fraction is padded with U+2007
 * FIGURE SPACE (same advance as a tabular digit) to the widest fraction in
 * the loaded set, so 9.5626 / 20.74 / 2.1 / 6 all line up — no fake zeros.
 */
const FIGSP = "\u2007";
function qtyFracWidth(qs: number[]): number {
  let w = 0;
  for (const q of qs) {
    const f = fmtQtyPlain(q).split(".")[1];
    if (f && f.length > w) w = f.length;
  }
  return w;
}
function fmtQtyAligned(q: number, fracW: number): string {
  const [int, frac = ""] = fmtQtyPlain(q).split(".");
  if (!fracW) return int;
  return frac ? `${int}.${frac}${FIGSP.repeat(fracW - frac.length)}` : `${int}${FIGSP.repeat(fracW + 1)}`;
}

/** Weekdays strictly after day `a` up to and including day `b` ("YYYY-MM-DD"). */
function tradingDaysBetween(a: string, b: string): number {
  const p = (k: string) => {
    const [y, m, d] = k.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  let n = 0;
  for (let t = p(a) + 86_400_000; t <= p(b); t += 86_400_000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

const STALE_TRADING_DAYS = 7;

/**
 * FIFO-match filled sells against earlier filled buys in the loaded window
 * (same method as /performance/summary). Sells with no matching buy in the
 * window are left out rather than guessed.
 */
function realizedBySell(trades: TradeRow[]): Map<number, { pnl: number; pct: number; partial: boolean }> {
  const out = new Map<number, { pnl: number; pct: number; partial: boolean }>();
  const lots = new Map<string, { qty: number; px: number }[]>();
  const filled = trades
    .filter((t) => t.status.toLowerCase() === "filled" && !t.dry_run)
    .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at) || a.id - b.id);
  for (const t of filled) {
    const q = lots.get(t.ticker) ?? [];
    if (t.side === "buy") {
      q.push({ qty: t.qty, px: t.price });
      lots.set(t.ticker, q);
      continue;
    }
    let need = t.qty;
    let cost = 0;
    let got = 0;
    while (need > 1e-6 && q.length) {
      const lot = q[0];
      const take = Math.min(lot.qty, need);
      cost += take * lot.px;
      got += take;
      need -= take;
      lot.qty -= take;
      if (lot.qty <= 1e-6) q.shift();
    }
    if (got > 1e-6) {
      const pnl = got * t.price - cost;
      out.set(t.id, { pnl, pct: pnl / cost, partial: need > 1e-3 });
    }
  }
  return out;
}

export function BlotterPanel({ className = "", style, limit = 100 }: { className?: string; style?: CSSProperties; limit?: number }) {
  const [filter, setFilter] = useState<Filter>("ALL");
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading, isError } = useQuery<TradeRow[]>({
    queryKey: ["trades", limit],
    queryFn: () => api.trades(limit),
  });
  const now = useNow(60_000);
  const [setListEl, listW, listFont] = useListMetrics();

  const all = useMemo(() => data ?? [], [data]);
  const rows = useMemo(
    () => (filter === "ALL" ? all : all.filter((t) => t.side === (filter === "BUY" ? "buy" : "sell"))),
    [all, filter],
  );
  const tot = useMemo(() => {
    let b = 0;
    let sl = 0;
    for (const t of all) {
      if (t.status.toLowerCase() !== "filled") continue;
      if (t.side === "buy") b += t.notional;
      else sl += t.notional;
    }
    return { b, sl };
  }, [all]);
  const realized = useMemo(() => realizedBySell(all), [all]);
  const qtyFrac = useMemo(() => qtyFracWidth(all.map((t) => t.qty)), [all]);
  // /trades returns everything when fewer than `limit` rows come back.
  const allLoaded = all.length < limit;
  const realizedSum = useMemo(() => [...realized.values()].reduce((a, r) => a + r.pnl, 0), [realized]);

  const latest = all.reduce<string | null>((m, t) => (!m || t.submitted_at > m ? t.submitted_at : m), null);
  const lastDay = latest ? etKey(latest) : null;
  const today = now ? etKey(now) : null;
  const calDays = lastDay && today ? Math.max(0, Math.round((Date.parse(today) - Date.parse(lastDay)) / 86_400_000)) : null;
  const tDays = lastDay && today ? tradingDaysBetween(lastDay, today) : null;
  const stale = tDays != null && tDays > STALE_TRADING_DAYS;

  return (
    <Panel
      code="BLTR"
      title="Orders"
      sub={
        data ? (
          <span className="num" style={{ fontSize: 10.5 }}>
            <span title={`Filled notional: bought ${fmtK(tot.b)} · sold ${fmtK(tot.sl)}`}>{all.length} orders</span> <span className="dim">·</span>{" "}
            <span title={`FIFO realized P/L summed over all ${realized.size} matched sells in the ${all.length} loaded orders (matches /performance/summary)`}>
              <span className="dim">{allLoaded ? "all-time realized" : `realized, last ${all.length} orders`}</span>{" "}
              <span className={tone(realizedSum)}>{fmtSignedUSD(realizedSum)}</span> <span className="dim">· {realized.size} sells</span>
            </span>
          </span>
        ) : undefined
      }
      actions={
        <>
          {calDays != null && (
            <span
              className={`pill${stale ? " warn" : ""}`}
              title={`Newest order ${lastDay} · ${tDays} trading day${tDays === 1 ? "" : "s"} ago${stale ? ` — no orders in more than ${STALE_TRADING_DAYS} trading days` : ""}`}
              suppressHydrationWarning
            >
              {stale && <span className="dot" />}
              Last order {calDays === 0 ? "today" : `${calDays}d ago`}
            </span>
          )}
          <Seg
            options={["ALL", "BUY", "SELL"] as Filter[]}
            value={filter}
            onChange={(v) => {
              setFilter(v);
              setOpen(null);
            }}
            label="Side filter"
          />
        </>
      }
      flush
      className={className}
      style={style}
      testId="panel-blotter"
    >
      <div className={s.col}>
        <ScrollArea watch={`${filter}|${rows.length}|${open}`}>
          {isLoading ? (
            <Skeleton rows={10} height={14} />
          ) : isError ? (
            <Empty>
              <span className="alert">Blotter unavailable</span> — /trades did not respond.
            </Empty>
          ) : rows.length === 0 ? (
            <Empty>{filter === "ALL" ? "No orders yet — the execute routine (09:30 ET) is the only buy window." : `No ${filter.toLowerCase()} orders in the last ${all.length}.`}</Empty>
          ) : (
            <>
              <div className={s.head} style={{ gridTemplateColumns: COLS, columnGap: 6 }}>
                <span>Time ET</span>
                <span style={{ textAlign: "center" }}>Side</span>
                <span>Tkr</span>
                <span className={s.r}>Qty</span>
                <span className={s.r}>Price</span>
                <span className={s.r}>Notional</span>
                <span className={s.r} title="Realized P/L on sells — FIFO against buys in this window">
                  Rlzd
                </span>
                <span title="Who placed it: LLM routine · MAN manual ticket · STOP inferred stop exit · ALP/TRAIL broker fill. A non-filled order shows its status instead (DRY · PART · REJ · CXL · FAIL).">Src</span>
                <span>Thesis · click to expand</span>
              </div>
              <div ref={setListEl}>
              {rows.map((t) => {
                const key = `${t.source ?? "local"}-${t.id}`;
                const src = sourceOf(t);
                const st = statusOf(t.status, t.dry_run);
                const isOpen = open === key;
                const sys = isSysNote(t.reason);
                const txt = sys ? autoExitSummary(t) : lead(t.reason);
                const shown = listW ? clampWords(txt, listW - THESIS_INSET - CLAMP_SLACK - (sys ? SYS_TAG_W : 0), listFont) : txt;
                const day = etKey(t.submitted_at);
                const canOpen = !!t.reason;
                const rl = realized.get(t.id);
                const toggle = () => setOpen(isOpen ? null : key);
                return (
                  <Fragment key={key}>
                    <div
                      data-row
                      className={`${s.row}${isOpen ? ` ${s.rowOpen}` : ""}${canOpen ? ` ${s.rowBtn}` : ""}`}
                      onClick={canOpen ? toggle : undefined}
                      role={canOpen ? "button" : undefined}
                      tabIndex={canOpen ? 0 : undefined}
                      aria-expanded={canOpen ? isOpen : undefined}
                      onKeyDown={
                        canOpen
                          ? (ev) => {
                              if (ev.key === "Enter" || ev.key === " ") {
                                ev.preventDefault();
                                toggle();
                              }
                            }
                          : undefined
                      }
                      style={{ gridTemplateColumns: COLS, columnGap: 6, opacity: st.text === "DRY" ? 0.8 : undefined }}
                    >
                      <span className={s.time} title={`${day} ${etHM(t.submitted_at)} ET${t.filled_at ? ` · filled ${etHM(t.filled_at)}` : ""}`}>
                        <span style={{ color: "var(--ink-2)" }}>{mmdd(day)}</span> {etHM(t.submitted_at)}
                      </span>
                      <span style={{ textAlign: "center" }}>
                        <span className={`${s.sidePill} ${t.side === "buy" ? s.buy : s.sell}`}>{t.side === "buy" ? "BUY" : "SELL"}</span>
                      </span>
                      <span>
                        <Tkr t={t.ticker} />
                      </span>
                      <span className={s.num} style={{ whiteSpace: "pre" }} title={`${fmtQtyPlain(t.qty)} sh`}>
                        {fmtQtyAligned(t.qty, qtyFrac)}
                      </span>
                      <span className={s.num}>{fmtPx(t.price)}</span>
                      <span className={s.num}>{`$${t.notional.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}</span>
                      <span
                        className={s.num}
                        title={rl ? `${fmtSignedUSD(rl.pnl, 2)} (${fmtChg(rl.pct, 2)}) · FIFO cost basis${rl.partial ? " · partially matched" : ""}` : undefined}
                      >
                        {rl ? <span className={tone(rl.pnl)}>{fmtSignedUSD(rl.pnl)}</span> : <span style={{ color: "var(--ink-4)" }}>{t.side === "sell" ? "—" : ""}</span>}
                      </span>
                      <span className={s.mono} style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.04em", color: st.quiet ? src.fg : st.fg }} title={`${t.status} · ${src.title}`}>
                        {st.quiet ? src.code : `${src.code}·${st.text}`}
                      </span>
                      <span className={`${s.ell}${sys ? ` ${s.orderSys}` : ""}`} style={{ fontSize: 11.5, color: sys ? undefined : isOpen ? "var(--ink-3)" : "var(--ink-2)" }} title={t.reason ?? undefined}>
                        {sys && <span className={s.sysTag}>AUTO EXIT</span>}
                        {isOpen ? "▾ full text below" : shown || <span style={{ color: "var(--ink-4)" }}>no thesis recorded</span>}
                      </span>
                    </div>
                    {isOpen && t.reason && (
                      <div className={s.detail} data-cut style={{ color: sys ? "var(--ink-3)" : "var(--ink-2)" }}>
                        <div className={s.detailMeta}>
                          <span style={{ color: t.side === "buy" ? "var(--up)" : "var(--down)" }}>
                            {t.side.toUpperCase()} {fmtQtyPlain(t.qty)} {t.ticker} @ {fmtPx(t.price)}
                          </span>
                          <span>{`${day} ${etHM(t.submitted_at)} ET`}</span>
                          {t.filled_at && <span>filled {etHM(t.filled_at)}</span>}
                          {rl && (
                            <span className={tone(rl.pnl)}>
                              realized {fmtSignedUSD(rl.pnl, 2)} ({fmtChg(rl.pct, 2)})
                            </span>
                          )}
                          <span style={{ color: src.fg }}>{src.title}</span>
                          <span>#{t.id}</span>
                        </div>
                        {sys && <span className={s.sysTag}>AUTO EXIT</span>}
                        {t.reason}
                      </div>
                    )}
                  </Fragment>
                );
              })}
              </div>
            </>
          )}
        </ScrollArea>
      </div>
    </Panel>
  );
}
