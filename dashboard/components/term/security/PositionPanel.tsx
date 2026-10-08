"use client";

/**
 * POS — our position in this name (qty, cost, P&L, weight, the bot's two
 * exit guards drawn on one price ladder). When we don't hold it, LVL shows
 * the same ladder for the technical levels instead.
 */
import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type SecurityResp } from "@/lib/api";
import { fmtChg, fmtNum, fmtPx, fmtSignedUSD, tone } from "@/lib/format";
import { BOT_STALE_MS, Bar, Panel, useNow } from "../ui";
import { etDate, fmtD } from "./util";
import s from "./security.module.css";

type Pos = NonNullable<SecurityResp["position"]>;

// ── price ladder ─────────────────────────────────────────────────────────

type Mark = { k: string; v: number; color: string; strong?: boolean; value?: boolean };

const LANE_TOP = [2, 38, 52]; // label rows: above the track, below, further below
const ASSUMED_W = 420; // px — only used to estimate label widths as % of the track

/**
 * One horizontal price axis with every level that matters marked on it.
 * Pure HTML (percent positions) so it needs no measuring. Labels are packed
 * into lanes (above, below, below-2) so neighbours never collide.
 */
export function Ladder({ marks, shade }: { marks: Mark[]; shade?: { from: number; to: number; color: string }[] }) {
  const vals = marks.map((m) => m.v);
  const lo0 = Math.min(...vals);
  const hi0 = Math.max(...vals);
  const pad = (hi0 - lo0 || hi0 * 0.02 || 1) * 0.06;
  const lo = lo0 - pad;
  const hi = hi0 + pad;
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const items = marks.map((m) => {
    const p = pct(m.v);
    const showV = m.value !== false;
    const wPx = m.k.length * 5.4 + (showV ? fmtPx(m.v).length * 6.1 + 4 : 0) + 6;
    const w = (wPx / ASSUMED_W) * 100;
    const a = p > 100 - w / 2 ? p - w : p < w / 2 ? p : p - w / 2; // left edge after edge-alignment
    return { ...m, p, w, a, showV, lane: 0 };
  });
  // strong (LAST) claims the top lane first, then the rest left → right
  const order = [...items].sort((x, y) => Number(!!y.strong) - Number(!!x.strong) || x.p - y.p);
  const taken: [number, number][][] = [[], [], []];
  for (const it of order) {
    const span: [number, number] = [it.a - 1, it.a + it.w + 1];
    const free = (l: number) => taken[l].every(([x0, x1]) => span[1] <= x0 || span[0] >= x1);
    const prefer = it.strong ? [0, 1, 2] : [1, 0, 2];
    const lane = prefer.find(free) ?? 2;
    it.lane = lane;
    taken[lane].push(span);
  }
  const height = taken[2].length ? 70 : 56;
  return (
    <div style={{ position: "relative", height, margin: "0 16px" }} aria-hidden="true">
      <div style={{ position: "absolute", left: 0, right: 0, top: 28, height: 1, background: "var(--line-2)" }} />
      {shade?.map((z, i) => {
        const a = Math.max(0, Math.min(100, pct(Math.min(z.from, z.to))));
        const b = Math.max(0, Math.min(100, pct(Math.max(z.from, z.to))));
        return <div key={i} style={{ position: "absolute", left: `${a}%`, width: `${b - a}%`, top: 25, height: 7, background: z.color }} />;
      })}
      {items.map((m) => (
        <div key={m.k}>
          <div
            style={{
              position: "absolute",
              left: `calc(${m.p}% - ${m.strong ? 1.5 : 0.5}px)`,
              top: m.strong ? 20 : 23,
              width: m.strong ? 3 : 1,
              height: m.strong ? 17 : m.lane === 2 ? 26 : 11,
              background: m.color,
              opacity: m.lane === 2 ? 0.7 : 1,
            }}
          />
          <div
            className="num"
            style={{
              position: "absolute",
              left: `${m.a}%`,
              top: LANE_TOP[m.lane],
              fontSize: 10,
              lineHeight: "16px",
              whiteSpace: "nowrap",
              color: m.strong ? "var(--ink)" : "var(--ink-2)",
              fontWeight: m.strong ? 600 : 400,
            }}
          >
            <span style={{ color: m.color, fontFamily: "var(--font-plex-cond)", fontWeight: 600, letterSpacing: "0.04em", fontSize: 9 }}>{m.k}</span>
            {m.showV && <span style={{ marginLeft: 4 }}>{fmtPx(m.v)}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── POS ──────────────────────────────────────────────────────────────────

/**
 * One exit guard. Status is about enforcement, not just distance:
 *  - BREACHED · UNFILLED  price is through the level but the position is still open
 *  - UNENFORCED · BOT STALE  synthetic level and the bot (its only enforcer) isn't running
 *  - NEAR / ARMED otherwise.
 */
function Guard({
  name,
  price,
  note,
  dist,
  enforced,
  offReason,
}: {
  name: string;
  price: number;
  note: string;
  dist: number | null;
  enforced: boolean;
  offReason: string;
}) {
  const breached = dist != null && dist < 0;
  const near = dist != null && dist >= 0 && dist < 0.03;
  // Action state → --alert; watch state → warn. "Unenforced" is said once, in the panel banner.
  const state = breached
    ? { cls: "alert", text: "Breached · unfilled", title: "Price is through this level and the position is still open — the exit has not executed." }
    : near
      ? { cls: "warn", text: "Near", title: "Within 3% of the level." }
      : enforced
        ? { cls: "", text: "Armed", title: "The bot checks this level on its scheduled routines." }
        : null;
  void offReason;
  return (
    <div className={s.guard}>
      <span className="label" style={{ color: breached ? "var(--alert)" : enforced ? "var(--ink-2)" : "var(--ink-3)" }}>{name}</span>
      <span className="num" style={{ color: "var(--ink)", textAlign: "right" }}>{fmtPx(price)}</span>
      <span className={`num ${breached ? "alert" : near ? "warn" : "flat"}`} style={{ textAlign: "right" }} title="Last price relative to the level">
        {dist == null ? "—" : `${fmtChg(dist)}`}
      </span>
      <span style={{ display: "inline-flex", justifyContent: "flex-end" }}>
        {state ? (
          <span className={`pill ${state.cls}`} title={state.title}>
            {state.text}
          </span>
        ) : null}
      </span>
      {/* The rule itself, always in full. */}
      <span className={s.guardNote}>{note}</span>
    </div>
  );
}

/**
 * Average-cost reconstruction from the bot's own fills (FIFO-free average-cost
 * method, resetting when flat). Lets the panel explain any gap to the broker's
 * average, which can include fills/fees outside the bot's trade log.
 */
function fillsBasis(trades: SecurityResp["trades"]): { qty: number; avg: number; cost: number } | null {
  const fills = trades
    .filter((t) => !t.dry_run && (t.status === "filled" || t.filled_at))
    .sort((a, b) => (a.filled_at ?? a.submitted_at).localeCompare(b.filled_at ?? b.submitted_at));
  let qty = 0;
  let cost = 0;
  for (const t of fills) {
    if (t.side === "buy") {
      qty += t.qty;
      cost += t.qty * t.price;
    } else {
      const avg = qty ? cost / qty : 0;
      qty -= t.qty;
      cost -= avg * t.qty;
      if (qty <= 1e-6) {
        qty = 0;
        cost = 0;
      }
    }
  }
  return qty > 1e-6 ? { qty, avg: cost / qty, cost } : null;
}

export function PositionPanel({
  pos,
  last,
  prev,
  trades,
  className = "",
  style,
}: {
  pos: Pos;
  last: number | null;
  /** Prior session close, for day P&L. */
  prev: number | null;
  trades: SecurityResp["trades"];
  className?: string;
  style?: CSSProperties;
}) {
  const now = useNow(60_000);
  const { data: bot } = useQuery({ queryKey: ["bot-status"], queryFn: api.botStatus, refetchInterval: 30_000 });
  const run = bot?.last_llm_run;
  // /bot/status says whether the bot is actually running its routines; fall back to the shared staleness rule.
  const fallbackStale = !!now && (!run || now - new Date(run.started_at).getTime() > BOT_STALE_MS);
  const active = bot ? (bot.active ?? !fallbackStale) : true;
  const offReason = bot?.routines_enabled === false ? "bot off" : "bot stale";
  const enforced = pos.broker_stop || active;
  const px = last ?? pos.market_price;
  const days = pos.opened_at && now ? Math.floor((now - new Date(pos.opened_at).getTime()) / 86_400_000) : null;
  const basis = pos.qty * pos.avg_cost;
  const fb = fillsBasis(trades);
  const covers = fb != null && Math.abs(fb.qty - pos.qty) < 0.005;
  const dAvg = covers ? pos.avg_cost - fb!.avg : null;
  const fromPeak = pos.peak_price ? px / pos.peak_price - 1 : null;
  const dayPnl = prev != null && last != null ? pos.qty * (last - prev) : null;
  const dayPct = prev ? (last ?? px) / prev - 1 : null;
  // R-multiple: open P&L per share ÷ the initial risk the bot accepted (avg cost → −7% cut).
  const riskPs = pos.avg_cost - pos.midday_cut_price;
  const rMult = riskPs > 0 ? (px - pos.avg_cost) / riskPs : null;
  const signColor = (v: number | null | undefined) => `var(--${tone(v) === "flat" ? "ink" : tone(v)})`;
  return (
    <Panel
      code="POS"
      title="Position"
      className={className}
      style={style}
      flush
      actions={
        <span className="pill" title={pos.broker_stop ? "A GTC trailing-stop order is live at the broker" : "No broker order — the bot's routines enforce the 10% trail"}>
          {pos.broker_stop ? "Broker stop" : "Synthetic stop"}
        </span>
      }
    >
      {!enforced && (
        <div className={s.banner} role="status">
          <span className="pill alert">Unenforced</span>
          <span>
            {offReason === "bot off" ? "Bot routines disabled" : "Bot stale"}
            {run ? ` · last run ${fmtD(etDate(run.started_at), "dmy")} (${now ? Math.floor((now - new Date(run.started_at).getTime()) / 86_400_000) : "?"}d)` : ""} — the synthetic 10% trail and −7% cut below are not being acted on.
          </span>
        </div>
      )}
      {/* Each number appears once in this panel: levels live in the guard rows, avg cost here. */}
      <div className={`${s.kv} ${s.kv4}`}>
        <div className={s.kvCell}>
          <span className="label">Quantity</span>
          <span className={s.kvV}>{fmtNum(pos.qty, pos.qty % 1 ? 2 : 0)}<span className="dim" style={{ fontSize: 10.5 }}>sh</span></span>
          <span className={s.kvSub} title="Quantity × broker average cost">basis ${fmtNum(basis, 0)}</span>
        </div>
        <div
          className={s.kvCell}
          title={
            fb == null
              ? "Broker (Alpaca) average cost. No bot fills on record to reconcile against."
              : covers
                ? `Broker (Alpaca) average cost ${fmtPx(pos.avg_cost)}. The bot's own logged fills (${fmtNum(fb.qty, 2)} sh, $${fmtNum(fb.cost, 2)}) average ${fmtPx(fb.avg)}; the ${fmtSignedUSD(dAvg, 2)}/sh gap is fills or fees the broker counts that the bot's trade log doesn't.`
                : `Broker (Alpaca) average cost. The bot's logged fills cover ${fmtNum(fb.qty, 2)} of ${fmtNum(pos.qty, 2)} sh (avg ${fmtPx(fb.avg)}) — the rest predates or bypassed the log.`
          }
        >
          <span className="label">Broker avg</span>
          <span className={s.kvV} style={{ color: "var(--blue)" }}>{fmtPx(pos.avg_cost)}</span>
          <span className={s.kvSub}>
            {fb == null ? (
              "no bot fills logged"
            ) : covers ? (
              <>
                fills {fmtPx(fb.avg)}
                {Math.abs(dAvg ?? 0) >= 0.005 && <span style={{ color: "var(--warn)" }}> {fmtSignedUSD(dAvg, 2).replace("$", "")}</span>}
              </>
            ) : (
              `fills cover ${fmtNum(fb.qty, 2)}/${fmtNum(pos.qty, 2)} sh`
            )}
          </span>
        </div>
        <div className={s.kvCell}>
          <span className="label">Mkt value</span>
          <span className={s.kvV}>${fmtNum(pos.market_value, 0)}</span>
          <span className={s.kvSub} style={{ display: "flex", alignItems: "center", gap: 5 }} title="Share of equity; bar to 10%, yellow tick = 5% entry cap">
            {pos.weight != null ? `${(pos.weight * 100).toFixed(2)}%` : "—"}
            <Bar value={pos.weight ?? 0} max={0.1} cap={0.05} width={34} height={4} color={(pos.weight ?? 0) > 0.05 ? "var(--warn)" : "var(--blue)"} />
          </span>
        </div>
        <div className={s.kvCell}>
          <span className="label">Held</span>
          <span className={s.kvV}>{days != null ? `${days}d` : "—"}</span>
          <span className={s.kvSub} title={pos.opened_at ? `Opened ${fmtD(etDate(pos.opened_at), "long")}` : undefined}>
            {pos.opened_at ? `since ${fmtD(etDate(pos.opened_at), "md")}` : "—"}
          </span>
        </div>
        <div className={s.kvCell}>
          <span className="label" title="Unrealized P&L vs broker average cost">Open P&amp;L</span>
          <span className={s.kvV} style={{ color: signColor(pos.unrealized_pnl) }}>{fmtSignedUSD(pos.unrealized_pnl, 2)}</span>
          <span className={`${s.kvSub} ${tone(pos.unrealized_pct)}`}>{fmtChg(pos.unrealized_pct)}</span>
        </div>
        <div className={s.kvCell} title="Quantity × (last close − prior close)">
          <span className="label">Day P&amp;L</span>
          <span className={s.kvV} style={{ color: signColor(dayPnl) }}>{fmtSignedUSD(dayPnl, 2)}</span>
          <span className={`${s.kvSub} ${tone(dayPct)}`}>{fmtChg(dayPct)}</span>
        </div>
        <div
          className={s.kvCell}
          title={`R-multiple = (last − avg cost) ÷ (avg cost − −7% cut). 1R = the $${fmtNum(riskPs, 2)}/sh the bot risked at entry ($${fmtNum(riskPs * pos.qty, 0)} on this position).`}
        >
          <span className="label">R multiple</span>
          <span className={s.kvV} style={{ color: signColor(rMult) }}>
            {rMult == null ? "—" : `${rMult > 0 ? "+" : rMult < 0 ? "−" : ""}${Math.abs(rMult).toFixed(2)}R`}
          </span>
          <span className={s.kvSub}>1R = ${fmtNum(riskPs * pos.qty, 0)}</span>
        </div>
        <div className={s.kvCell} title="Last close vs the highest close since entry — the 10% trail ratchets off this peak">
          <span className="label">From peak</span>
          <span className={s.kvV} style={{ color: signColor(fromPeak) }}>{fmtChg(fromPeak, 1)}</span>
          <span className={s.kvSub}>peak {fmtPx(pos.peak_price)}</span>
        </div>
      </div>
      <div style={{ padding: "4px 0 0" }}>
        {/* Positions only — the values sit in the rows above/below. */}
        <Ladder
          marks={[
            { k: "CUT", v: pos.midday_cut_price, color: px < pos.midday_cut_price ? "var(--alert)" : "#c3cbd5", value: false },
            { k: "STOP", v: pos.stop_price, color: px < pos.stop_price ? "var(--alert)" : "var(--warn)", value: false },
            { k: "AVG", v: pos.avg_cost, color: "var(--blue)", value: false },
            { k: "PEAK", v: pos.peak_price, color: "var(--ink-3)", value: false },
            { k: "LAST", v: px, color: "var(--ink)", strong: true, value: false },
          ]}
          shade={[
            { from: Math.min(pos.midday_cut_price, pos.stop_price) * 0.9, to: pos.stop_price, color: "rgba(255,210,63,0.07)" },
            { from: pos.avg_cost, to: px, color: px >= pos.avg_cost ? "rgba(32,212,123,0.16)" : "rgba(255,79,79,0.16)" },
          ]}
        />
      </div>
      <Guard
        name="Trail stop"
        price={pos.stop_price}
        note={`${(pos.trail_pct * 100).toFixed(0)}% below the peak close${pos.broker_stop ? " · broker GTC order" : " · synthetic (bot-enforced)"}`}
        dist={pos.stop_distance}
        enforced={enforced}
        offReason={offReason}
      />
      {/* The −7% cut is only ever enforced by the 13:00 midday routine — never a broker order. */}
      <Guard
        name="Midday cut"
        price={pos.midday_cut_price}
        note="−7% from avg cost · sold by the 13:00 ET midday routine"
        dist={pos.midday_cut_distance}
        enforced={active}
        offReason={offReason}
      />
    </Panel>
  );
}

// ── LVL (not held) ───────────────────────────────────────────────────────

const SHORT_K: Record<string, string> = { "52W HI": "HI", "52W LO": "LO", "SMA 20": "20D", "SMA 50": "50D", "SMA 200": "200D" };

export function LevelsPanel({ data, className = "", style }: { data: SecurityResp; className?: string; style?: CSSProperties }) {
  const q = data.quote;
  const st = data.stats;
  const last = q?.last ?? null;
  const lastSell = data.trades.find((t) => t.side === "sell");
  const rows: { k: string; v: number | null | undefined; color: string; note: string }[] = [
    { k: "52W HI", v: q?.hi_52w, color: "var(--ink-2)", note: "52-week closing high" },
    { k: "SMA 20", v: st.sma_20, color: "var(--ink-2)", note: "20-day average" },
    { k: "SMA 50", v: st.sma_50, color: "#b4a3f2", note: "50-day average" },
    { k: "SMA 200", v: st.sma_200, color: "#6f9bd1", note: "200-day average" },
    { k: "52W LO", v: q?.lo_52w, color: "var(--ink-2)", note: "52-week closing low" },
  ];
  if (lastSell) rows.push({ k: "EXIT", v: lastSell.price, color: "var(--ink-3)", note: `our last sell, ${fmtD(etDate(lastSell.filled_at ?? lastSell.submitted_at), "dmy")}` });
  const valid = rows.filter((r): r is typeof r & { v: number } => r.v != null);
  return (
    <Panel
      code="LVL"
      title="Key levels"
      sub={lastSell ? "not held · exited" : data.trades.length ? "not held" : "not held · never traded"}
      className={className}
      style={style}
      flush
    >
      {last != null && valid.length > 0 ? (
        <>
          <div style={{ padding: "6px 0 2px" }}>
            <Ladder
              marks={[
                ...valid.map((r) => ({ k: SHORT_K[r.k] ?? r.k, v: r.v, color: r.color, value: false })),
                { k: "LAST", v: last, color: "var(--ink)", strong: true },
              ]}
            />
          </div>
          <table className="tbl" style={{ borderTop: "1px solid var(--line)" }}>
            <tbody>
              {[...valid, { k: "LAST", v: last, color: "var(--ink)", note: "last close" }]
                .sort((a, b) => b.v - a.v)
                .map((r) => {
                  const d = r.k === "LAST" ? null : last / r.v - 1;
                  return (
                    <tr key={r.k} className={r.k === "LAST" ? "sel" : undefined} style={{ height: 22 }}>
                      <td className="txt" style={{ width: 70 }}>
                        <span className="label" style={{ color: r.color }}>{r.k}</span>
                      </td>
                      <td style={{ color: "var(--ink)" }}>{fmtPx(r.v)}</td>
                      <td className="txt" style={{ color: "var(--ink-3)", fontSize: 11 }}>{r.note}</td>
                      <td className={tone(d)} title="Last price relative to the level">
                        {d == null ? "" : `${d >= 0 ? "▲" : "▼"} ${fmtChg(d, 1)}`}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </>
      ) : (
        <div className="panel-empty">No price levels available.</div>
      )}
    </Panel>
  );
}
