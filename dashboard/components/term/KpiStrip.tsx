"use client";

/**
 * KPI — the launchpad's top strip (exactly 92px tall). Three primary tiles
 * (equity, unrealized, drawdown) lead with larger values; seven secondary
 * tiles follow. Every tile has the same anatomy:
 *   label (+ status chips on the equity tile only)
 *   value
 *   one plain-language fact
 *   band — a ≥10px caption row naming the chart and its reference, over a
 *          small chart; or a second figure where a chart would say nothing.
 *
 * House rules: green/red only for the sign of a number; states that need
 * action use the alert palette (BOT OFF), watch states the warn chip
 * (snapshot age); data older than one trading day is dimmed and its age is
 * stated once, on the equity tile.
 */
import Link from "next/link";
import { useId, useMemo, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, term } from "@/lib/api";
import { fmtAge, fmtChg, fmtNum, fmtSignedUSD, tone } from "@/lib/format";
import { Flash, useNow } from "./ui";
import { etDay, useHeldMonitor, usePositions } from "./useHeld";
import s from "./KpiStrip.module.css";

const MINUS = "−";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
const toneVar = (v: number | null | undefined) => (tone(v) === "up" ? "var(--up)" : tone(v) === "down" ? "var(--down)" : "var(--ink-2)");
const usd = (v: number | null | undefined, d = 2) => (finite(v) ? `${v < 0 ? MINUS : ""}$${fmtNum(Math.abs(v), d)}` : "—");
const usdK = (v: number | null | undefined, d = 1) => {
  if (!finite(v)) return "—";
  const a = Math.abs(v);
  const sg = v < 0 ? MINUS : "";
  return a >= 1e6 ? `${sg}$${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `${sg}$${(a / 1e3).toFixed(d)}K` : `${sg}$${fmtNum(a, 0)}`;
};
const pct = (v: number | null | undefined, d = 1) => (finite(v) ? `${v < 0 ? MINUS : ""}${Math.abs(v * 100).toFixed(d)}%` : "—");
const signed = (v: number | null | undefined, d = 2) => (finite(v) ? `${v > 0 ? "+" : v < 0 ? MINUS : ""}${Math.abs(v).toFixed(d)}` : "—");
const monDay = (d: string) => `${MON[+d.slice(5, 7) - 1]} ${d.slice(8, 10)}`;
const dayNum = (d: string) => Math.round(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000);

/** Weekdays strictly after `from` up to and including `to` (both "YYYY-MM-DD"). */
function weekdaysBetween(from: string, to: string) {
  let n = 0;
  for (let t = dayNum(from) + 1; t <= dayNum(to); t++) {
    const wd = new Date(t * 86_400_000).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

// risk-on / neutral read as a neutral outlined chip; only risk-off (sizes halve) is an alert
const REGIME: Record<string, { text: string; color: string; bg: string; border: string }> = {
  risk_on: { text: "RISK ON", color: "var(--ink)", bg: "transparent", border: "var(--ink-3)" },
  neutral: { text: "NEUTRAL", color: "var(--ink)", bg: "transparent", border: "var(--ink-3)" },
  risk_off: { text: "RISK OFF", color: "var(--alert)", bg: "var(--alert-bg)", border: "rgba(199, 125, 255, 0.5)" },
};

export function KpiStrip({ className = "", style }: { className?: string; style?: CSSProperties }) {
  const now = useNow(30_000);
  const summary = useQuery({ queryKey: ["summary"], queryFn: api.summary, refetchInterval: 15_000 });
  const risk = useQuery({ queryKey: ["risk"], queryFn: term.risk, refetchInterval: 60_000 });
  const perf = useQuery({ queryKey: ["performance"], queryFn: api.performance, refetchInterval: 60_000 });
  const regime = useQuery({ queryKey: ["regime"], queryFn: api.regime, refetchInterval: 300_000, retry: false });
  const bot = useQuery({ queryKey: ["bot-status"], queryFn: api.botStatus, refetchInterval: 30_000 });
  const brief = useQuery({ queryKey: ["brief"], queryFn: term.brief, refetchInterval: 60_000 });
  const positions = usePositions();
  const monitor = useHeldMonitor(positions.data);

  const S = summary.data;
  const R = risk.data;
  const P = perf.data;
  const G = regime.data;
  const curve = useMemo(() => R?.curve ?? [], [R]);

  // ── derived series ──
  const d = useMemo(() => {
    const rets: number[] = [];
    const spyRets: (number | null)[] = [];
    const pnl: number[] = [];
    for (let i = 1; i < curve.length; i++) {
      rets.push(curve[i - 1].equity > 0 ? curve[i].equity / curve[i - 1].equity - 1 : 0);
      pnl.push(curve[i].equity - curve[i - 1].equity);
      const a = curve[i - 1].spy_pct;
      const b = curve[i].spy_pct;
      spyRets.push(a != null && b != null ? (1 + b) / (1 + a) - 1 : null);
    }
    // rolling 20-session beta to SPY
    const W = 20;
    const beta: (number | null)[] = [];
    for (let i = W; i <= rets.length; i++) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let k = i - W; k < i; k++) {
        const sx = spyRets[k];
        if (sx == null) continue;
        xs.push(sx);
        ys.push(rets[k]);
      }
      if (xs.length < 10) {
        beta.push(null);
        continue;
      }
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let cov = 0;
      let vx = 0;
      xs.forEach((x, k) => {
        cov += (x - mx) * (ys[k] - my);
        vx += (x - mx) ** 2;
      });
      beta.push(vx > 0 ? cov / vx : null);
    }
    const eq = curve.map((p) => p.equity);
    let peakI = 0;
    eq.forEach((v, i) => {
      if (v >= eq[peakI]) peakI = i;
    });
    const last = curve[curve.length - 1];
    return {
      eq,
      rets,
      pnl,
      beta,
      spyRets,
      peak: eq.length ? { v: eq[peakI], d: curve[peakI].d, daysAgo: last ? dayNum(last.d) - dayNum(curve[peakI].d) : 0 } : null,
    };
  }, [curve]);

  // daily-return histogram on a robust range: bounds at the 95th-percentile
  // move (+15%), outliers pile into the end bars, so the shape fills the tile
  const hist = useMemo(() => {
    const r = d.rets;
    if (r.length < 5) return null;
    const abs = r.map(Math.abs).sort((a, b) => a - b);
    const m = Math.max(0.002, abs[Math.floor(abs.length * 0.95)] * 1.15);
    const B = 8;
    const bins = new Array(B * 2).fill(0);
    const idx = (v: number) => Math.max(0, Math.min(B * 2 - 1, Math.floor((v / m) * B) + B));
    for (const v of r) bins[idx(v)]++;
    return { m, bins, B, last: idx(r[r.length - 1]) };
  }, [d.rets]);

  // today's P&L: live equity vs the prior session close; SPY's move the same session
  const day = useMemo(() => {
    if (!S || curve.length < 2) return null;
    const last = curve[curve.length - 1];
    const intraday = S.as_of ? etDay(S.as_of) > last.d : false;
    const base = intraday ? last : curve[curve.length - 2];
    if (!base.equity) return null;
    const pnl = S.equity - base.equity;
    const pctV = pnl / base.equity;
    const spy = intraday ? null : d.spyRets[d.spyRets.length - 1] ?? null;
    const rel = brief.data?.rel_spy_1d;
    return { pnl, pct: pctV, spy, bp: rel != null ? rel * 10_000 : spy == null ? null : (pctV - spy) * 10_000 };
  }, [S, curve, d.spyRets, brief.data]);

  const pos = useMemo(() => positions.data ?? [], [positions.data]);
  const ranked = useMemo(() => [...pos].sort((a, b) => b.unrealized_pct - a.unrealized_pct), [pos]);
  const unrl = S?.unrealized_pnl ?? null;
  const basis = S ? S.invested - S.unrealized_pnl : null;
  const winners = pos.filter((p) => p.unrealized_pnl > 0).length;
  const botItd = P?.benchmark.bot_return_pct ?? S?.bot_return_pct ?? null;
  const spyItd = P?.benchmark.spy_return_pct ?? S?.spy_return_pct ?? null;
  const alpha = P?.benchmark.alpha_pct ?? S?.alpha_pct ?? null;
  const cashPct = R?.cash_pct ?? (S && S.equity ? S.cash / S.equity : null);
  const nPos = R?.positions ?? S?.position_count ?? null;
  const maxPos = R?.max_positions ?? 25;
  const rz = P?.realized;
  const rg = G ? (REGIME[G.regime_label] ?? { text: String(G.regime_label).replace(/_/g, " ").toUpperCase(), color: "var(--ink-2)", bg: "transparent", border: "var(--line-2)" }) : null;
  const vix = monitor.data?.vix;
  const eqUp = d.eq.length > 1 ? d.eq[d.eq.length - 1] >= d.eq[0] : true;
  const snapshot = S?.source === "db_fallback";
  const lastBeta = [...d.beta].reverse().find(finite) ?? null;
  const itdPnl = d.eq.length > 1 && S ? S.equity - d.eq[0] : null;
  const inception = curve[0]?.d;

  // stale = the book's newest snapshot is older than one trading day → dim
  const stale = !!(S?.as_of && now && weekdaysBetween(etDay(S.as_of), etDay(new Date(now).toISOString())) > 1);
  const botOff = bot.data && bot.data.active === false;

  return (
    <div className={`${s.strip} ${className}`} style={style} data-testid="kpi-strip" role="region" aria-label="Key figures">
      {/* ── primary ─────────────────────────────────────────────── */}
      <Tile
        primary
        book={snapshot}
        dim={stale}
        href="/positions"
        label="Equity"
        tag={
          <>
            {snapshot && S?.as_of && (
              <span className={`pill warn ${s.chip}`} title="The five book tiles marked with the amber top rule come from the last local snapshot (Alpaca unreachable)">
                <span className={s.long}>book · </span>
                {now ? fmtAge(S.as_of, now) : "—"}
              </span>
            )}
            {botOff && (
              <span className={`pill alert ${s.chip}`} title={bot.data?.routines_enabled === false ? "LLM routines are disabled in the scheduler — see BOT (Alt+6)" : "No LLM routine has run recently — see BOT (Alt+6)"}>
                {bot.data?.routines_enabled === false ? "BOT OFF" : "BOT STALE"}
              </span>
            )}
          </>
        }
        loading={summary.isLoading}
        value={
          <Flash value={S?.equity}>
            <span>{usd(S?.equity)}</span>
          </Flash>
        }
        sub={
          <>
            <span className={s.v} style={{ color: toneVar(itdPnl) }}>
              {itdPnl == null ? "—" : fmtSignedUSD(itdPnl, 0)}
            </span>
            <span>since {inception ? monDay(inception) : "start"}</span>
          </>
        }
        band={
          <Band
            left={
              <>
                start <span className={s.cv}>{usdK(d.eq[0])}</span>
              </>
            }
            right={
              d.peak ? (
                <>
                  high <span className={s.cv}>{usdK(d.peak.v)}</span>
                </>
              ) : null
            }
          >
            <MicroLine lines={[{ data: d.eq, color: eqUp ? "var(--up)" : "var(--down)", fill: true }]} refLine={d.eq[0]} />
          </Band>
        }
      />

      <Tile
        primary
        groupEnd
        book={snapshot}
        dim={stale}
        href="/positions"
        label="P&L today"
        title={day?.spy != null ? `S&P 500 (SPY) ${fmtChg(day.spy)} the same session` : "SPY's move for this session is not in yet"}
        loading={summary.isLoading || risk.isLoading}
        value={
          <Flash value={day?.pnl}>
            <span style={{ color: toneVar(day?.pnl) }}>{day ? fmtSignedUSD(day.pnl, 2) : "—"}</span>
          </Flash>
        }
        sub={
          <>
            <span className={s.v} style={{ color: toneVar(day?.pct) }}>
              {day ? fmtChg(day.pct) : "—"}
            </span>
            <span>
              <span className={s.v} style={{ color: toneVar(day?.bp) }}>
                {day?.bp == null ? "—" : `${Math.round(day.bp) > 0 ? "+" : Math.round(day.bp) < 0 ? MINUS : ""}${Math.abs(Math.round(day.bp))}`}
              </span>{" "}
              bp vs SPY
            </span>
          </>
        }
        band={
          <Band left={<>daily P&L, last 20 sessions</>} right={<>today ▸</>}>
            <MicroBars values={d.pnl.slice(-20)} />
          </Band>
        }
      />

      <Tile
        book={snapshot}
        dim={stale}
        href="/positions"
        label="Unrealized"
        title="Unrealized P&L by position, best to worst"
        loading={summary.isLoading}
        value={
          <Flash value={unrl}>
            <span style={{ color: toneVar(unrl) }}>{fmtSignedUSD(unrl, 2)}</span>
          </Flash>
        }
        sub={
          <>
            <KV v={fmtChg(unrl != null && basis ? unrl / basis : null)} color={toneVar(unrl)} k="on cost" after />
            {pos.length > 0 && (
              <span className={s.opt}>
                <span className={s.v}>{winners}</span> up · <span className={s.v}>{pos.length - winners}</span> down
              </span>
            )}
          </>
        }
        band={
          <Band
            left={
              ranked.length ? (
                <>
                  {ranked[0].ticker} <span className={s.cv}>{fmtChg(ranked[0].unrealized_pct, 1)}</span>
                </>
              ) : (
                "by position"
              )
            }
            right={
              ranked.length > 1 ? (
                <>
                  {ranked[ranked.length - 1].ticker} <span className={s.cv}>{fmtChg(ranked[ranked.length - 1].unrealized_pct, 1)}</span>
                </>
              ) : null
            }
          >
            <MicroBars values={ranked.map((p) => p.unrealized_pct)} />
          </Band>
        }
      />

      <Tile
        book={snapshot}
        dim={stale}
        href="/risk"
        label="Drawdown"
        loading={risk.isLoading}
        value={
          <Flash value={R?.drawdown}>
            <span style={{ color: finite(R?.drawdown) && R!.drawdown! < -0.0005 ? "var(--down)" : "var(--ink)" }}>{pct(R?.drawdown, 2)}</span>
          </Flash>
        }
        sub={<KV k="Worst" v={pct(R?.max_drawdown, 2)} color={finite(R?.max_drawdown) && R!.max_drawdown! < 0 ? "var(--down)" : undefined} />}
        band={
          <Band
            left={
              d.peak ? (
                <>
                  peak <span className={s.cv}>{monDay(d.peak.d)}</span>
                </>
              ) : null
            }
            right={d.peak ? d.peak.daysAgo === 0 ? <>at the high</> : <>{d.peak.daysAgo}d ago</> : null}
          >
            <MicroUnderwater values={curve.map((p) => p.dd)} max={R?.max_drawdown ?? null} />
          </Band>
        }
      />

      {/* ── secondary ───────────────────────────────────────────── */}
      <Tile
        book={snapshot}
        bookEnd
        dim={stale}
        href="/positions"
        label="Capacity"
        title="Cash share of equity · cash free · next position size at the 5% cap · position slots used of the 25-name cap"
        loading={summary.isLoading && risk.isLoading}
        value={
          <Flash value={cashPct}>
            <span>
              {pct(cashPct)}
              <span className={s.unit}>cash</span>
            </span>
          </Flash>
        }
        sub={
          <>
            <span className={s.v}>{usdK(S?.cash)}</span>
            <span className={s.opt2}>
              <KV k="next" v={finite(S?.equity) ? `$${((S!.equity * 0.05) / 1e3).toFixed(1)}K` : "—"} />
            </span>
          </>
        }
        band={
          <Band
            left={<>position slots</>}
            right={
              <>
                <span className={s.cv}>{nPos ?? "—"}</span> of {maxPos}
              </>
            }
          >
            {nPos != null ? <MicroSlots n={nPos} max={maxPos} /> : null}
          </Band>
        }
      />

      <Tile
        href="/risk"
        label="Return ITD"
        title={`Since ${inception ? monDay(inception) : "inception"}: bot vs S&P 500 (SPY)`}
        loading={perf.isLoading && summary.isLoading}
        value={
          <Flash value={botItd}>
            <span style={{ color: toneVar(botItd) }}>{finite(botItd) ? fmtChg(botItd / 100) : "—"}</span>
          </Flash>
        }
        sub={<KV k="vs SPY" v={finite(alpha) ? `${signed(alpha)}pp` : "—"} color={toneVar(alpha)} />}
        band={
          <Band
            left={
              <>
                <span className={s.sw} style={{ background: "var(--cyan)" }} />
                bot
              </>
            }
            right={
              <>
                <span className={s.sw} style={{ background: "#8a95a3" }} />
                SPY <span className={s.cv}>{finite(spyItd) ? fmtChg(spyItd / 100, 1) : "—"}</span>
              </>
            }
          >
            <MicroLine
              lines={[
                { data: curve.map((p) => p.spy_pct), color: "#8a95a3", width: 1 },
                { data: curve.map((p) => p.bot_pct), color: "var(--cyan)" },
              ]}
              refLine={0}
            />
          </Band>
        }
      />

      <Tile
        href="/risk"
        label="Sharpe"
        tag={<span className={s.winTag}>{curve.length > 1 ? `${curve.length - 1}d · annualized` : "annualized"}</span>}
        title="Annualized, since inception. Chart: how daily returns are distributed between the bounds shown (outliers pile into the end bars); the white tick is the latest session."
        loading={risk.isLoading}
        value={
          <Flash value={R?.sharpe}>
            <span>{finite(R?.sharpe) ? fmtNum(R?.sharpe, 2) : "—"}</span>
          </Flash>
        }
        sub={
          <>
            <KV k="Sortino" v={finite(R?.sortino) ? fmtNum(R?.sortino, 2) : "—"} />
            <KV k="vol" v={pct(R?.ann_vol)} />
          </>
        }
        band={
          <Band left={<>{hist ? `${MINUS}${(hist.m * 100).toFixed(1)}%` : ""}</>} center={<>daily returns</>} right={<>{hist ? `+${(hist.m * 100).toFixed(1)}%` : ""}</>}>
            {hist && <MicroHist hist={hist} />}
          </Band>
        }
      />

      <Tile
        href="/risk"
        label="Beta"
        title="Beta to SPY since inception; the chart is the rolling 20-session beta, dashed line at 1.0"
        loading={risk.isLoading}
        value={
          <Flash value={R?.beta}>
            <span>{finite(R?.beta) ? fmtNum(R?.beta, 2) : "—"}</span>
          </Flash>
        }
        sub={<KV k="Correlation" v={finite(R?.corr) ? fmtNum(R?.corr, 2) : "—"} />}
        band={
          <Band
            left={<>rolling 20-day</>}
            right={
              <>
                now <span className={s.cv}>{finite(lastBeta) ? fmtNum(lastBeta, 2) : "—"}</span>
              </>
            }
          >
            <MicroLine lines={[{ data: d.beta, color: "var(--ink-2)" }]} refLine={1} refLabel="β 1.0" />
          </Band>
        }
      />

      <Tile
        href="/trades"
        label="Hit rate"
        title="Share of closed trades that made money"
        loading={perf.isLoading}
        value={
          <Flash value={rz?.hit_rate_pct}>
            <span>{rz ? `${rz.hit_rate_pct.toFixed(1)}%` : "—"}</span>
          </Flash>
        }
        sub={<KV k="Profit factor" v={rz?.profit_factor != null ? fmtNum(rz.profit_factor, 2) : "—"} />}
        band={
          <Band
            left={
              <>
                <span className={s.cv}>{rz?.wins ?? "—"}</span> wins
              </>
            }
            right={
              <>
                <span className={s.cv}>{rz?.losses ?? "—"}</span> losses
              </>
            }
          >
            {rz && rz.closed_lots > 0 ? (
              <MicroMeter
                parts={[
                  { f: rz.wins / rz.closed_lots, color: "var(--up)" },
                  { f: rz.losses / rz.closed_lots, color: "var(--down)" },
                ]}
              />
            ) : null}
          </Band>
        }
      />

      <Tile
        href="/risk"
        label="Regime"
        title={G ? `As of ${monDay(etDay(G.as_of ?? ""))} · VIX 5-day change ${signed(G.vix_5d_change)} · breadth ${finite(G.breadth_pct) ? `${G.breadth_pct.toFixed(0)}%` : "—"}` : undefined}
        loading={regime.isLoading}
        value={rg ? <span className={s.regimeChip} style={{ color: rg.color, background: rg.bg, borderColor: rg.border }}>{rg.text}</span> : <span>—</span>}
        sub={<KV k="VIX" v={finite(G?.vix) ? fmtNum(G?.vix, 2) : "—"} />}
        band={
          <Band left={<>VIX, last 30 days</>}>
            {vix?.spark?.length ? <MicroLine lines={[{ data: vix.spark, color: "var(--ink-2)" }]} refLine={20} refAlways refLabel="VIX 20 stress" /> : null}
          </Band>
        }
      />
    </div>
  );
}

// ── tile + band ──────────────────────────────────────────────────────────

function Tile({
  label,
  tag,
  title,
  value,
  sub,
  band,
  href,
  primary,
  groupEnd,
  book,
  bookEnd,
  dim,
  loading,
}: {
  label: string;
  tag?: ReactNode;
  title?: string;
  value: ReactNode;
  sub?: ReactNode;
  band?: ReactNode;
  href?: string;
  primary?: boolean;
  groupEnd?: boolean;
  /** Book-derived tile served from the snapshot: shares the amber top rule. */
  book?: boolean;
  bookEnd?: boolean;
  dim?: boolean;
  loading?: boolean;
}) {
  const inner = (
    <>
      <div className={s.head}>
        <span className={s.label}>{label}</span>
        {tag && <span className={s.tag}>{tag}</span>}
      </div>
      <div className={s.value}>{loading ? <span className={`skel ${s.skel}`} /> : value}</div>
      <div className={s.sub}>{loading ? null : sub}</div>
      {loading ? null : band}
    </>
  );
  const cls = `${s.tile}${primary ? ` ${s.primary}` : ""}${groupEnd ? ` ${s.groupEnd}` : ""}${book ? ` ${s.book}` : ""}${bookEnd ? ` ${s.bookEnd}` : ""}${dim ? ` ${s.dim}` : ""}`;
  return href ? (
    <Link href={href} className={cls} prefetch={false} title={title}>
      {inner}
    </Link>
  ) : (
    <div className={cls} title={title}>
      {inner}
    </div>
  );
}

/** Caption row (what the chart shows · its bounds / extremes) over the chart. */
function Band({ left, center, right, children }: { left?: ReactNode; center?: ReactNode; right?: ReactNode; children?: ReactNode }) {
  return (
    <div className={s.band}>
      <div className={s.cap}>
        <span>{left}</span>
        {center != null && <span className={s.capMid}>{center}</span>}
        {right != null && <span className={s.capR}>{right}</span>}
      </div>
      {children != null && <div className={s.chart}>{children}</div>}
    </div>
  );
}

/** "Label value" (or "value label" with `after`) — words in ink-2, numbers in ink. */
function KV({ k, v, color, after }: { k?: string; v: string; color?: string; after?: boolean }) {
  const val = (
    <span className={s.v} style={color ? { color } : undefined}>
      {v}
    </span>
  );
  return (
    <span className={s.kv}>
      {!after && k && <span>{k}</span>}
      {val}
      {after && k && <span>{k}</span>}
    </span>
  );
}

// ── micro-charts: one language ───────────────────────────────────────────
// 12px tall, stretch to the tile, hairline strokes (non-scaling), dashed
// reference line named in the caption row, lines end in a 3px dot.

const MH = 12;
const FILL = 0.2;

function MicroLine({
  lines,
  refLine,
  refAlways,
  refLabel,
}: {
  lines: { data: (number | null | undefined)[]; color: string; width?: number; fill?: boolean }[];
  refLine?: number | null;
  /** Always stretch the domain to include the reference (e.g. VIX 20). */
  refAlways?: boolean;
  /** Inline label at the right end of the reference line. */
  refLabel?: string;
}) {
  const gid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const all = lines.flatMap((l) => l.data.filter(finite));
  if (all.length < 2) return null;
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const hasRef = refLine != null && Number.isFinite(refLine);
  if (hasRef && (refAlways || (refLine >= lo - (hi - lo) * 0.6 && refLine <= hi + (hi - lo) * 0.6))) {
    lo = Math.min(lo, refLine);
    hi = Math.max(hi, refLine);
  }
  const range = hi - lo || 1;
  const n = Math.max(...lines.map((l) => l.data.length));
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * 100);
  const y = (v: number) => MH - 1.5 - ((v - lo) / range) * (MH - 3);
  const primary = lines[lines.length - 1];
  let lastI = -1;
  for (let i = primary.data.length - 1; i >= 0; i--)
    if (finite(primary.data[i])) {
      lastI = i;
      break;
    }
  const fillLine = lines.find((l) => l.fill);
  return (
    <>
      <svg width="100%" height={MH} viewBox={`0 0 100 ${MH}`} preserveAspectRatio="none" style={{ display: "block", overflow: "visible" }} aria-hidden="true">
        {fillLine && (
          <defs>
            <linearGradient id={`k${gid}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={fillLine.color} stopOpacity={FILL} />
              <stop offset="100%" stopColor={fillLine.color} stopOpacity={0} />
            </linearGradient>
          </defs>
        )}
        {hasRef && refLine >= lo && refLine <= hi && (
          <line x1={0} x2={100} y1={y(refLine)} y2={y(refLine)} stroke="var(--ink-3)" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray="2 2" />
        )}
        {lines.map((l, k) => {
          let dd = "";
          let pen = false;
          let first = -1;
          let last = -1;
          l.data.forEach((v, i) => {
            if (!finite(v)) {
              pen = false;
              return;
            }
            dd += `${pen ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`;
            pen = true;
            if (first < 0) first = i;
            last = i;
          });
          return (
            <g key={k}>
              {l.fill && first >= 0 && <path d={`${dd}L${x(last)},${MH}L${x(first)},${MH}Z`} fill={`url(#k${gid})`} />}
              <path d={dd} fill="none" stroke={l.color} strokeWidth={l.width ?? 1.25} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </g>
          );
        })}
      </svg>
      {lastI >= 0 && <EndDot left={x(lastI)} top={y(primary.data[lastI] as number)} color={primary.color} />}
      {refLabel && hasRef && refLine >= lo && refLine <= hi && (
        <span className={s.refLabel} style={{ top: Math.max(-2, Math.min(MH - 9, y(refLine) - 5)) }}>
          {refLabel}
        </span>
      )}
    </>
  );
}

function EndDot({ left, top, color }: { left: number; top: number; color: string }) {
  return <span style={{ position: "absolute", left: `calc(${left}% - 1.5px)`, top: top - 1.5, width: 3, height: 3, borderRadius: "50%", background: color }} />;
}

/** Signed bars from a zero line (cross-section or a short daily series). */
function MicroBars({ values }: { values: number[] }) {
  if (!values.length) return null;
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const range = hi - lo || 1;
  const y = (v: number) => 0.5 + ((hi - v) / range) * (MH - 1);
  const slot = 100 / values.length;
  return (
    <svg width="100%" height={MH} viewBox={`0 0 100 ${MH}`} preserveAspectRatio="none" style={{ display: "block" }} aria-hidden="true">
      {values.map((v, i) => (
        <rect
          key={i}
          x={i * slot + slot * 0.15}
          width={slot * 0.7}
          y={Math.min(y(v), y(0))}
          height={Math.max(0.8, Math.abs(y(v) - y(0)))}
          fill={v >= 0 ? "var(--up)" : "var(--down)"}
          fillOpacity={0.85}
        />
      ))}
      <line x1={0} x2={100} y1={y(0)} y2={y(0)} stroke="var(--ink-3)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Distribution of daily returns across the labelled bounds; the white tick
 *  is the latest session, the dashed line zero. */
function MicroHist({ hist }: { hist: { bins: number[]; B: number; last: number } }) {
  const { bins, B, last } = hist;
  const top = Math.max(...bins) || 1;
  const slot = 100 / bins.length;
  const lx = (last + 0.5) * slot;
  return (
    <svg width="100%" height={MH} viewBox={`0 0 100 ${MH}`} preserveAspectRatio="none" style={{ display: "block" }} aria-hidden="true">
      <line x1={0} x2={100} y1={MH - 0.5} y2={MH - 0.5} stroke="var(--line-2)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {bins.map((c, i) =>
        c ? (
          <rect
            key={i}
            x={i * slot + slot * 0.12}
            width={slot * 0.76}
            y={MH - 1 - (c / top) * (MH - 2)}
            height={(c / top) * (MH - 2)}
            fill={i >= B ? "var(--up)" : "var(--down)"}
            fillOpacity={0.85}
          />
        ) : null,
      )}
      <line x1={50} x2={50} y1={0} y2={MH} stroke="var(--ink-3)" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray="2 2" />
      <line x1={lx} x2={lx} y1={0} y2={MH} stroke="var(--ink)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Underwater curve hanging from the zero line, dashed line at the worst drawdown. */
function MicroUnderwater({ values, max }: { values: (number | null)[]; max: number | null }) {
  const v = values.map((x) => (finite(x) ? x : 0));
  if (v.length < 2) return null;
  const lo = Math.min(...v, max ?? 0, -0.0001);
  const x = (i: number) => (i / (v.length - 1)) * 100;
  const y = (dd: number) => 1 + (dd / lo) * (MH - 2.5);
  const line = v.map((dd, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(dd).toFixed(2)}`).join("");
  return (
    <>
      <svg width="100%" height={MH} viewBox={`0 0 100 ${MH}`} preserveAspectRatio="none" style={{ display: "block", overflow: "visible" }} aria-hidden="true">
        <path d={`${line}L100,1L0,1Z`} fill="var(--down)" fillOpacity={FILL} />
        <line x1={0} x2={100} y1={1} y2={1} stroke="var(--ink-4)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {finite(max) && max < 0 && (
          <line x1={0} x2={100} y1={y(max)} y2={y(max)} stroke="var(--ink-3)" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray="2 2" />
        )}
        <path d={line} fill="none" stroke="var(--down)" strokeWidth={1.25} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <EndDot left={100} top={y(v[v.length - 1])} color="var(--down)" />
    </>
  );
}

/** Proportional meter on the shared track (wins vs losses). */
function MicroMeter({ parts }: { parts: { f: number; color: string }[] }) {
  return (
    <span style={{ position: "absolute", left: 0, right: 0, top: 3, height: 6, display: "flex", gap: 1, background: "var(--bg-3)" }}>
      {parts.map((p, i) => (
        <span key={i} style={{ flex: `${Math.max(0, p.f)} 0 0`, background: p.color, opacity: 0.85 }} />
      ))}
    </span>
  );
}

/** One cell per position slot, filled for each held name. */
function MicroSlots({ n, max }: { n: number; max: number }) {
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: 3, height: 6, display: "grid", gridTemplateColumns: `repeat(${max}, 1fr)`, gap: 1 }}>
      {Array.from({ length: max }).map((_, i) => (
        <span key={i} style={{ background: i < n ? "var(--ink-2)" : "var(--bg-3)" }} />
      ))}
    </div>
  );
}
