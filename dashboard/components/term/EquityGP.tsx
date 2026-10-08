"use client";

/**
 * GP — the bot's equity against the S&P 500, both rebased to 0% at the start
 * of the selected window. The band between them shows lead (green) / lag
 * (red); the bot's own buys ▲ and sells ▼ are pinned to its line; non-risk-on
 * market regimes shade the background; a window drawdown study runs below.
 *
 * The stats row is deliberately window-specific and does not repeat the KPI
 * strip above it (no ITD alpha / Sharpe / beta / max drawdown there): window
 * returns, P&L, up/down capture, correlation, tracking error, information
 * ratio and the best / worst session.
 * Data: /terminal/risk `curve` (daily), /trades, /terminal/regime/history.
 */
import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, term } from "@/lib/api";
import { fmtChg, fmtNum, fmtSignedUSD, tone } from "@/lib/format";
import { Empty, Panel, Skeleton } from "./ui";
import { DataAge } from "./DataAge";
import { KeyGlyph, TimeSeriesChart, type TSAnnotation, type TSKey, type TSMarker, type TSSeries, type TSShade } from "./TimeSeriesChart";
import { etDay } from "./useHeld";
import g from "./EquityGP.module.css";

const RANGES = ["1M", "3M", "6M", "YTD", "1Y", "MAX"] as const;
type Range = (typeof RANGES)[number];
const MONTHS: Record<string, number> = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12 };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MINUS = "−";
const TD = 252;

const BOT = "var(--cyan)";
const SPX = "#b9c2cc";
const REGIME_SHADE: Record<string, { color: string; label: string; opacity: number }> = {
  neutral: { color: "var(--warn)", label: "Neutral regime", opacity: 0.18 },
  risk_off: { color: "var(--alert)", label: "Risk-off regime", opacity: 0.18 },
};
const REGIME_NAME: Record<string, string> = { risk_on: "Risk on", neutral: "Neutral", risk_off: "Risk off" };
const DEAD = new Set(["rejected", "canceled", "cancelled", "expired", "failed", "dry_run"]);

type Pt = { d: string; equity: number; bot_pct: number | null; spy_pct: number | null; dd: number | null };

/** Cutoff date for a window (the last close on/before it is the base). */
function cutoffFor(last: string, range: Range) {
  const y = +last.slice(0, 4);
  const m = +last.slice(5, 7);
  const d = +last.slice(8, 10);
  return range === "YTD" ? `${y - 1}-12-31` : new Date(Date.UTC(y, m - 1 - MONTHS[range], d)).toISOString().slice(0, 10);
}

function startIndex(curve: Pt[], range: Range) {
  if (range === "MAX" || curve.length < 2) return 0;
  const cutoff = cutoffFor(curve[curve.length - 1].d, range);
  let s = 0;
  for (let i = 0; i < curve.length; i++) {
    if (curve[i].d <= cutoff) s = i;
    else break;
  }
  return Math.min(s, curve.length - 2);
}

const shortDate = (s: string) => `${MON[+s.slice(5, 7) - 1]} ${s.slice(8, 10)} ’${s.slice(2, 4)}`;
const signed = (v: number | null, d = 2) => (v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? MINUS : ""}${Math.abs(v).toFixed(d)}`);
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const pstdev = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
};
const usdShort = (v: number) => {
  const a = Math.abs(v);
  return `$${a >= 1e4 ? `${(a / 1e3).toFixed(1)}K` : fmtNum(a, 0)}`;
};

export function EquityGP({ className = "", style }: { className?: string; style?: CSSProperties }) {
  const [range, setRange] = useState<Range>("MAX");
  const { data, isLoading, isError } = useQuery({ queryKey: ["risk"], queryFn: term.risk, refetchInterval: 60_000 });
  const summary = useQuery({ queryKey: ["summary"], queryFn: api.summary, refetchInterval: 15_000 });
  const trades = useQuery({ queryKey: ["trades", 200], queryFn: () => api.trades(200), refetchInterval: 60_000 });
  const regimes = useQuery({ queryKey: ["regime-history", 400], queryFn: () => term.regimeHistory(400), refetchInterval: 600_000, retry: false });
  const bot = useQuery({ queryKey: ["bot-status"], queryFn: api.botStatus, refetchInterval: 30_000 });

  const curve = useMemo(() => (data?.curve ?? []) as Pt[], [data]);

  // A window whose cutoff predates the history is the same as MAX → disabled.
  const sameAsMax = useMemo(() => {
    const out = new Set<Range>();
    if (curve.length < 2) return out;
    for (const r of RANGES) if (r !== "MAX" && cutoffFor(curve[curve.length - 1].d, r) < curve[0].d) out.add(r);
    return out;
  }, [curve]);
  const active: Range = sameAsMax.has(range) ? "MAX" : range;

  const view = useMemo(() => {
    if (curve.length < 2) return null;
    const s = startIndex(curve, active);
    const w = curve.slice(s);
    const b0 = w[0].bot_pct ?? 0;
    const firstSpy = w.find((p) => p.spy_pct != null)?.spy_pct ?? null;
    const bot = w.map((p) => (p.bot_pct == null ? null : (1 + p.bot_pct) / (1 + b0) - 1));
    const spy = w.map((p) => (p.spy_pct == null || firstSpy == null ? null : (1 + p.spy_pct) / (1 + firstSpy) - 1));
    // window drawdown off the running peak
    let peak = -Infinity;
    const dd = w.map((p) => {
      peak = Math.max(peak, p.equity);
      return peak > 0 ? p.equity / peak - 1 : 0;
    });
    // daily returns, paired with SPY's
    const days: { d: string; rb: number; rs: number | null }[] = [];
    for (let i = 1; i < w.length; i++) {
      if (!(w[i - 1].equity > 0)) continue;
      const a = w[i - 1].spy_pct;
      const b = w[i].spy_pct;
      days.push({ d: w[i].d, rb: w[i].equity / w[i - 1].equity - 1, rs: a != null && b != null ? (1 + b) / (1 + a) - 1 : null });
    }
    const pairs = days.filter((x): x is { d: string; rb: number; rs: number } => x.rs != null);
    let beat: number | null = null;
    let te: number | null = null;
    let ir: number | null = null;
    let upCap: number | null = null;
    let downCap: number | null = null;
    if (pairs.length >= 10) {
      beat = pairs.filter((p) => p.rb > p.rs).length / pairs.length;
      const act = pairs.map((p) => p.rb - p.rs);
      te = pstdev(act) * Math.sqrt(TD);
      ir = te ? (mean(act) * TD) / te : null;
      const up = pairs.filter((p) => p.rs > 0);
      const dn = pairs.filter((p) => p.rs < 0);
      upCap = up.length >= 3 ? mean(up.map((p) => p.rb)) / mean(up.map((p) => p.rs)) : null;
      downCap = dn.length >= 3 ? mean(dn.map((p) => p.rb)) / mean(dn.map((p) => p.rs)) : null;
    }
    const best = days.length ? days.reduce((a, b) => (b.rb > a.rb ? b : a)) : null;
    const worst = days.length ? days.reduce((a, b) => (b.rb < a.rb ? b : a)) : null;
    const lastBot = bot[bot.length - 1];
    const lastSpy = [...spy].reverse().find((v) => v != null) ?? null;
    return {
      dates: w.map((p) => p.d),
      equity: w.map((p) => p.equity),
      bot,
      spy,
      dd,
      botRet: lastBot,
      spyRet: lastSpy,
      pnl: w[w.length - 1].equity - w[0].equity,
      beat,
      te,
      ir,
      upCap,
      downCap,
      best,
      worst,
      from: w[0].d,
      to: w[w.length - 1].d,
      sessions: w.length - 1,
    };
  }, [curve, active]);

  // the bot's own fills, pinned to the session they happened in
  const markers = useMemo<TSMarker[]>(() => {
    if (!view || !trades.data) return [];
    const idx = new Map(view.dates.map((d, i) => [d, i]));
    const out: TSMarker[] = [];
    for (const t of trades.data) {
      if (t.dry_run || DEAD.has(String(t.status).toLowerCase())) continue;
      const when = t.filled_at ?? t.submitted_at;
      if (!when) continue;
      const day = etDay(when);
      if (day < view.from || day > view.to) continue;
      let i = idx.get(day);
      if (i == null) i = view.dates.findIndex((d) => d >= day); // weekend / holiday fill → next session
      if (i == null || i < 0) continue;
      out.push({ i, side: t.side, label: `${t.side === "buy" ? "BUY" : "SELL"} ${t.ticker}`, value: usdShort(t.notional), date: `${MON[+view.dates[i].slice(5, 7) - 1]} ${view.dates[i].slice(8, 10)}` });
    }
    return out;
  }, [view, trades.data]);

  // regime by session; shade only the departures from risk-on
  const regimeAt = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of regimes.data ?? []) if (r.label) m.set(r.d, r.label);
    return m;
  }, [regimes.data]);
  const { shade, regimeKeys } = useMemo(() => {
    const runs: TSShade[] = [];
    const keys: TSKey[] = [];
    if (!view || !regimeAt.size) return { shade: runs, regimeKeys: keys };
    let cur: { i0: number; label: string } | null = null;
    const flush = (end: number) => {
      if (cur && REGIME_SHADE[cur.label]) runs.push({ i0: cur.i0, i1: end, color: REGIME_SHADE[cur.label].color, opacity: REGIME_SHADE[cur.label].opacity });
      cur = null;
    };
    view.dates.forEach((d, i) => {
      const lab = regimeAt.get(d) ?? null;
      if (cur && cur.label !== lab) flush(i - 1);
      if (lab && !cur) cur = { i0: i, label: lab };
    });
    flush(view.dates.length - 1);
    const present = new Set(runs.map((r) => r.color));
    for (const v of Object.values(REGIME_SHADE)) if (present.has(v.color)) keys.push({ glyph: "box", color: v.color, label: v.label, opacity: v.opacity });
    return { shade: runs, regimeKeys: keys };
  }, [view, regimeAt]);

  const keys = useMemo<TSKey[]>(() => {
    const k: TSKey[] = [];
    k.push({ glyph: "box", color: "var(--up)", label: "bot ahead", opacity: 0.22 });
    k.push({ glyph: "box", color: "var(--down)", label: "bot behind", opacity: 0.22 });
    return [...k, ...regimeKeys];
  }, [regimeKeys]);

  // where the automation went quiet: the later of the last LLM run and the last fill
  const annotations = useMemo<TSAnnotation[]>(() => {
    if (!view || !bot.data || bot.data.active !== false) return [];
    const lastRun = bot.data.last_llm_run?.started_at ? etDay(bot.data.last_llm_run.started_at) : null;
    const lastFill = (trades.data ?? [])
      .filter((t) => !t.dry_run && !DEAD.has(String(t.status).toLowerCase()))
      .map((t) => etDay(t.filled_at ?? t.submitted_at))
      .sort()
      .pop();
    const since = [lastRun, lastFill].filter((x): x is string => !!x).sort().pop();
    if (!since || since > view.to) return [];
    const label = `${MON[+since.slice(5, 7) - 1]} ${since.slice(8, 10)}`;
    if (since < view.from) return [{ i: 0, label: `bot idle all window · since ${label}`, color: "var(--alert)" }];
    const i = view.dates.findIndex((d) => d >= since);
    return i < 0 ? [] : [{ i, label: `bot idle since ${label}`, color: "var(--alert)" }];
  }, [view, bot.data, trades.data]);

  // the current lag run, labelled where it began
  const behind = useMemo<TSAnnotation[]>(() => {
    if (!view) return [];
    const gap = view.bot.map((b, i) => (b != null && view.spy[i] != null ? b - (view.spy[i] as number) : null));
    let k = gap.length - 1;
    while (k >= 0 && gap[k] == null) k--;
    if (k < 0 || (gap[k] as number) >= 0) return [];
    let start = k;
    while (start > 0 && gap[start - 1] != null && (gap[start - 1] as number) < 0) start--;
    if (start === 0) return [];
    const d = view.dates[start];
    return [{ i: start, label: `behind SPY since ${MON[+d.slice(5, 7) - 1]} ${d.slice(8, 10)}`, color: "var(--down)", row: 1 }];
  }, [view]);

  // largest daily trade count in the window — the trade-lane scale
  const maxTrades = useMemo(() => {
    const per = new Map<string, number>();
    for (const m of markers) per.set(`${m.i}:${m.side}`, (per.get(`${m.i}:${m.side}`) ?? 0) + 1);
    return Math.max(0, ...per.values());
  }, [markers]);

  const series = useMemo<TSSeries[]>(
    () =>
      view
        ? [
            { id: "bot", label: "Cromaz bot", data: view.bot, color: BOT, width: 1.6 },
            { id: "spy", label: "S&P 500 · SPY", data: view.spy, color: SPX, width: 1.15 },
          ]
        : [],
    [view],
  );

  const legendExtra = useCallback(
    (i: number) => {
      if (!view) return [];
      const b = view.bot[i];
      const s = view.spy[i];
      const a = b != null && s != null ? (b - s) * 100 : null;
      const rg = regimeAt.get(view.dates[i]);
      return [
        { label: "Bot − SPY, pp", value: signed(a), color: a == null ? "var(--ink-3)" : a >= 0 ? "var(--up)" : "var(--down)" },
        { label: "Equity", value: `$${fmtNum(view.equity[i], 2)}` },
        ...(rg ? [{ label: "Regime", value: REGIME_NAME[rg] ?? rg, color: "var(--ink-2)" }] : []),
      ];
    },
    [view, regimeAt],
  );

  const sub = useMemo(
    () =>
      view
        ? {
            label: "Drawdown from window peak",
            kind: "area" as const,
            data: view.dd,
            color: "var(--down)",
            ratio: 0.22,
            note: `rebased ${shortDate(view.from)} → ${shortDate(view.to)} · ${view.sessions} sessions`,
          }
        : null,
    [view],
  );

  const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);

  let body: ReactNode;
  if (isLoading) body = <Skeleton rows={8} />;
  else if (isError && !data) body = <Empty>Risk service unreachable — /terminal/risk failed.</Empty>;
  else if (!view) body = <Empty>The equity curve needs at least two daily portfolio snapshots. It fills in after the first close.</Empty>;
  else
    body = (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(10, minmax(0, auto))", borderBottom: "1px solid var(--line)", flex: "none" }}>
          <Stat label="vs SPY" title="Bot return minus SPY return over the window, percentage points" lead>
            <span className={tone(view.botRet != null && view.spyRet != null ? view.botRet - view.spyRet : null)}>
              {view.botRet != null && view.spyRet != null ? `${signed((view.botRet - view.spyRet) * 100)}pp` : "—"}
            </span>
          </Stat>
          <Stat label="Bot" swatch={BOT} title="Cromaz bot return over the window">
            <span className={tone(view.botRet)}>{fmtChg(view.botRet)}</span>
          </Stat>
          <Stat label="S&P 500" swatch={SPX} title="SPY return over the window">
            <span className={tone(view.spyRet)}>{fmtChg(view.spyRet)}</span>
          </Stat>
          <Stat label="Window P&L" title="Equity change over the window">
            <span className={tone(view.pnl)}>{fmtSignedUSD(view.pnl, 0)}</span>
          </Stat>
          <Stat label="Up capture" title="Average bot return on SPY up-days ÷ SPY's average up-day return">
            {pct(view.upCap)}
          </Stat>
          <Stat label="Down capture" title="Average bot return on SPY down-days ÷ SPY's average down-day return (lower is better)">
            {pct(view.downCap)}
          </Stat>
          <Stat label="Beat SPY" title="Share of sessions in the window where the bot's daily return beat SPY's" className={g.statOpt}>
            {pct(view.beat)}
          </Stat>
          <Stat label="Tracking err" title="Annualized volatility of (bot − SPY) daily returns">
            {view.te == null ? "—" : `${(view.te * 100).toFixed(1)}%`}
          </Stat>
          <Stat label="Info ratio" title="Annualized active return ÷ tracking error" lastNarrow>
            <span className={tone(view.ir)}>{view.ir == null ? "—" : signed(view.ir)}</span>
          </Stat>
          <Stat
            label="Best / worst day"
            className={g.statOpt}
            title={view.best && view.worst ? `Best session ${shortDate(view.best.d)} · worst session ${shortDate(view.worst.d)}` : undefined}
            last
          >
            <span className={tone(view.best?.rb)}>{view.best ? fmtChg(view.best.rb, 1) : "—"}</span>
            <span style={{ color: "var(--ink-4)", margin: "0 3px" }}>/</span>
            <span className={tone(view.worst?.rb)}>{view.worst ? fmtChg(view.worst.rb, 1) : "—"}</span>
          </Stat>
        </div>
        <div style={{ flex: 1, minHeight: 0, paddingTop: 2 }}>
          <TimeSeriesChart
            dates={view.dates}
            series={series}
            band={{ a: "bot", b: "spy", opacity: 0.22 }}
            markers={markers}
            markerSeries="bot"
            shade={shade}
            shadeStyle="fill"
            annotations={[...annotations, ...behind]}
            markerLane
            valueAxis="left"
            tagPlacement="axis"
            sub={sub}
            kind="pct"
            legend="hover"
            legendExtra={legendExtra}
          />
        </div>
      </div>
    );

  return (
    <Panel
      code="GP"
      title="Equity vs S&P 500"
      sub={
        view ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
            {keys.map((k) => (
              <span key={k.label} style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--ink-2)" }}>
                <KeyGlyph k={k} />
                {k.label}
              </span>
            ))}
            {markers.length > 0 && <span className={g.keyOpt}>trade ticks: tallest = {maxTrades} trades/day</span>}
          </span>
        ) : (
          "rebased to window start"
        )
      }
      className={className}
      style={style}
      flush
      testId="panel-gp"
      actions={
        <>
          <RangeSeg value={active} onChange={setRange} disabled={sameAsMax} />
          <DataAge at={data?.as_of} snapshot={summary.data?.source === "db_fallback"} bookAt={summary.data?.as_of} />
        </>
      }
    >
      {body}
    </Panel>
  );
}

/** Range buttons in the house .seg style; windows that would equal MAX
 *  (history shorter than the window) are hidden rather than duplicated. */
function RangeSeg({ value, onChange, disabled }: { value: Range; onChange: (r: Range) => void; disabled: Set<Range> }) {
  return (
    <div className="seg-group" role="group" aria-label="Chart range">
      {RANGES.filter((r) => !disabled.has(r)).map((r) => (
        <button key={r} type="button" className="seg-btn" aria-pressed={r === value} onClick={() => onChange(r)}>
          {r}
        </button>
      ))}
    </div>
  );
}

function Stat({
  label,
  swatch,
  title,
  last,
  lead,
  lastNarrow,
  className,
  children,
}: {
  label: string;
  swatch?: string;
  title?: string;
  last?: boolean;
  lead?: boolean;
  /** Becomes the row's last cell once the optional cells drop out. */
  lastNarrow?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      title={title}
      className={[className, lastNarrow ? g.lastNarrow : ""].filter(Boolean).join(" ") || undefined}
      style={{ padding: "4px 3px 5px 8px", borderRight: last ? 0 : lead ? "1px solid var(--line-2)" : "1px solid var(--line)", minWidth: 0, overflow: "hidden", background: lead ? "var(--bg-2)" : undefined }}
    >
      <div className="label" style={{ fontSize: 9, letterSpacing: "0.04em", display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", color: "var(--ink-2)" }}>
        {swatch && <span style={{ width: 9, height: 2, background: swatch, display: "inline-block", flex: "none" }} />}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{label}</span>
      </div>
      <div className="num" style={{ fontSize: 13, fontWeight: 500, marginTop: 1, lineHeight: "17px", color: "var(--ink)" }}>
        {children}
      </div>
    </div>
  );
}
