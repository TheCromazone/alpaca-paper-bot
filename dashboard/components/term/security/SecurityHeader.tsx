"use client";

/**
 * Security header bar — the DES strip: ticker + name + classification,
 * last price with the 1D move, the 52-week range, and a two-row grid of
 * returns / risk / technicals / fundamentals.
 */
import type { CSSProperties, ReactNode } from "react";
import type { SecurityResp } from "@/lib/api";
import { fmtBig, fmtChg, fmtNum, fmtPx, tone } from "@/lib/format";
import { RangeBar, marketSession, useNow } from "../ui";
import { exchangeName, fmtD } from "./util";
import s from "./security.module.css";

export type Profile = NonNullable<SecurityResp["profile"]>;

function ordinal(n: number) {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function Cell({ k, children, title }: { k: string; children: ReactNode; title?: string }) {
  return (
    <div className={s.statCell} title={title}>
      <span className={s.statK}>{k}</span>
      <span className={s.statV}>{children}</span>
    </div>
  );
}

function Ret({ v }: { v: number | null | undefined }) {
  return <span className={tone(v)}>{fmtChg(v)}</span>;
}

/** SMA value with an above/below marker and the distance from last. */
function Sma({ sma, last }: { sma: number | null; last: number | null | undefined }) {
  if (sma == null || last == null) return <>—</>;
  const d = last / sma - 1;
  const above = d >= 0;
  return (
    <>
      {fmtNum(sma, sma >= 100 ? 1 : 2)}
      <span className={`${s.statSub} ${above ? "up" : "down"}`}>
        {above ? "▲" : "▼"}
        {Math.abs(d * 100).toFixed(Math.abs(d) >= 0.1 ? 0 : 1)}%
      </span>
    </>
  );
}

/** One status pill: breach states outrank the plain HELD badge. */
function HeldPill({ pos }: { pos: NonNullable<SecurityResp["position"]> }) {
  const qty = `${fmtNum(pos.qty, pos.qty % 1 ? 2 : 0)} sh`;
  if (pos.midday_cut_distance != null && pos.midday_cut_distance < 0)
    return (
      <span className="pill alert" title={`Held ${qty} — below the −7%-from-cost line; the 13:00 midday routine sells these`}>
        Held · below cut
      </span>
    );
  if (pos.stop_distance != null && pos.stop_distance < 0)
    return (
      <span className="pill alert" title={`Held ${qty} — below the 10% trailing stop`}>
        Held · below stop
      </span>
    );
  return (
    <span className={`pill ${s.heldPill}`} title="Currently held in the paper portfolio">
      Held · {qty}
    </span>
  );
}

/**
 * Trailing P/E from real reported EPS only: last ÷ Σ of the four most recent
 * quarters' eps_actual (yfinance earnings history — typically adjusted EPS).
 * Null unless four consecutive quarters exist; never estimated.
 */
export function ttmEps(history: SecurityResp["earnings"]["history"]): number | null {
  const q = history.filter((h) => h.eps_actual != null).slice(0, 4);
  if (q.length < 4) return null;
  const span = (new Date(q[0].quarter).getTime() - new Date(q[3].quarter).getTime()) / 86_400_000;
  if (span > 300) return null; // gaps → not a clean trailing twelve months
  return q.reduce((a, h) => a + (h.eps_actual as number), 0);
}

export function SecurityHeader({
  data,
  profile,
  className = "",
  style,
}: {
  data: SecurityResp;
  profile: Profile | null;
  className?: string;
  style?: CSSProperties;
}) {
  const q = data.quote;
  const st = data.stats;
  const last = q?.last ?? null;
  const d1 = q?.last != null && q?.prev != null ? q.last - q.prev : null;
  const name = profile?.name ?? data.name;
  const country = profile?.country === "United States" ? "US" : profile?.country === "United Kingdom" ? "UK" : profile?.country;
  const meta = [profile?.sector ?? data.sector, profile?.industry, exchangeName(profile?.exchange), country].filter(Boolean).join(" · ");
  const held = !!data.position;
  const exited = !held && data.trades.some((t) => t.side === "sell");
  const offHi = last != null && q?.hi_52w ? last / q.hi_52w - 1 : null;
  const offLo = last != null && q?.lo_52w ? last / q.lo_52w - 1 : null;
  const rsi = st.rsi_14;
  const eps = ttmEps(data.earnings.history);
  const pe = eps != null && eps > 0 && last != null ? last / eps : null;
  const rel = q?.rel_volume ?? null;
  const now = useNow(60_000);
  const sess = marketSession(now);
  const extHrs = sess.label === "After-hrs" || sess.label === "Pre-mkt";

  return (
    <div className={`${s.hdr} ${className}`} style={style} data-testid="sec-header">
      {/* identity */}
      <div className={`${s.hdrBlock} ${s.hdrId}`}>
        <div className={s.hdrTicker}>
          <span className={s.tickerBig}>{data.ticker}</span>
          <span className={s.mktKey}>US EQUITY</span>
          {held && <HeldPill pos={data.position!} />}
          {exited && <span className="pill">Exited</span>}
          {!data.in_universe && (
            <span className="pill warn" title="Not in the bot's tradable universe">
              Off-universe
            </span>
          )}
        </div>
        <div className={s.coName} title={name}>
          {name}
        </div>
        <div className={s.coMeta} title={meta}>
          {meta || "—"}
        </div>
      </div>

      {/* price */}
      <div className={`${s.hdrBlock} ${s.hdrPx}`}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
          <span className="label" style={{ fontSize: 9 }} title="Regular-session close">
            Close {q ? fmtD(q.as_of, "dmy") : "—"}
          </span>
          {extHrs && (
            <span
              className="label"
              style={{ fontSize: 8.5, lineHeight: "12px", color: "var(--ink-3)", border: "1px solid var(--line-2)", padding: "0 3px" }}
              title="The feed has no pre-/after-market prints; the price shown is the last regular-session close."
            >
              {sess.label === "Pre-mkt" ? "no pre-mkt quote" : "no AH quote"}
            </span>
          )}
        </span>
        <span className={s.pxBig}>{fmtPx(last)}</span>
        <span className={s.pxChg}>
          <span className={`num ${tone(d1)}`}>
            {d1 == null ? "—" : `${d1 > 0 ? "+" : d1 < 0 ? "−" : ""}${fmtNum(Math.abs(d1))}`}
          </span>
          <span className={`num ${tone(q?.chg_1d)}`} style={{ fontWeight: 600 }}>
            {fmtChg(q?.chg_1d)}
          </span>
          <span className="num dim" style={{ fontSize: 10.5 }}>
            prev {fmtPx(q?.prev)}
          </span>
        </span>
      </div>

      {/* 52-week range */}
      <div className={`${s.hdrBlock} ${s.hdr52}`}>
        <span style={{ display: "flex", justifyContent: "space-between" }}>
          <span className="label" style={{ fontSize: 9 }}>52W range</span>
          <span className="num" style={{ fontSize: 10.5, color: "var(--ink-2)" }}>
            {q?.pos_52w != null ? `${ordinal(Math.round(q.pos_52w * 100))} pct` : "—"}
          </span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, margin: "3px 0 2px" }}>
          <span className="num" style={{ fontSize: 11.5, color: "var(--ink-2)" }}>{fmtPx(q?.lo_52w)}</span>
          <RangeBar pos={q?.pos_52w} width={84} title="52-week low → high" />
          <span className="num" style={{ fontSize: 11.5, color: "var(--ink-2)" }}>{fmtPx(q?.hi_52w)}</span>
        </span>
        <span className="num" style={{ fontSize: 10.5, color: "var(--ink-3)", display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>
            <span className={tone(offHi)}>{fmtChg(offHi, 1)}</span> vs hi
          </span>
          <span>
            <span className={tone(offLo)}>{fmtChg(offLo, 1)}</span> vs lo
          </span>
        </span>
      </div>

      {/* stats grid */}
      <div className={s.stats}>
        <Cell k="5D"><Ret v={q?.chg_5d} /></Cell>
        <Cell k="1M"><Ret v={q?.chg_1m} /></Cell>
        <Cell k="3M"><Ret v={q?.chg_3m} /></Cell>
        <Cell k="YTD"><Ret v={q?.chg_ytd} /></Cell>
        <Cell k="1Y"><Ret v={q?.chg_1y} /></Cell>
        <Cell k="vs SPY 3M" title="3-month return minus SPY's, in points">
          <span className={tone(st.rel_spy_3m)}>
            {st.rel_spy_3m == null ? "—" : `${st.rel_spy_3m >= 0 ? "+" : "−"}${Math.abs(st.rel_spy_3m * 100).toFixed(1)}pt`}
          </span>
        </Cell>
        <Cell k="DD from hi" title="Current drawdown from the 1-year closing high">
          <span className={tone(st.drawdown, 0.0005)}>{fmtChg(st.drawdown, 1)}</span>
        </Cell>
        <Cell k="Max DD 1Y">
          <span className={st.max_dd_1y ? "down" : "flat"}>{fmtChg(st.max_dd_1y, 1)}</span>
        </Cell>
        <Cell k="Mkt cap">{profile?.market_cap ? `$${fmtBig(profile.market_cap)}` : "—"}</Cell>
        <Cell k="P/E TTM" title={eps != null ? `Last ÷ Σ last 4 reported EPS (${fmtNum(eps)}) — reported, typically adjusted` : "Needs four reported quarters of EPS"}>
          {pe != null ? `${pe.toFixed(1)}×` : eps != null && eps <= 0 ? <span className="dim">n/m</span> : "—"}
        </Cell>

        <Cell k="Vol 20D" title="Annualized realized volatility, 20 trading days">{st.vol_20d != null ? `${(st.vol_20d * 100).toFixed(1)}%` : "—"}</Cell>
        <Cell k="Vol 60D" title="Annualized realized volatility, 60 trading days">{st.vol_60d != null ? `${(st.vol_60d * 100).toFixed(1)}%` : "—"}</Cell>
        <Cell k="Beta 1Y" title="Beta vs SPY, 1 year of daily returns">{fmtNum(st.beta_1y, 2)}</Cell>
        <Cell k="Corr 1Y" title="Correlation with SPY, 1 year of daily returns">{fmtNum(st.corr_1y, 2)}</Cell>
        <Cell k="RSI 14">
          <span className={rsi != null && (rsi >= 70 || rsi <= 30) ? "warn" : undefined}>{fmtNum(rsi, 1)}</span>
          {rsi != null && rsi >= 70 && <span className={`${s.statSub} warn`}>OB</span>}
          {rsi != null && rsi <= 30 && <span className={`${s.statSub} warn`}>OS</span>}
        </Cell>
        <Cell k="SMA 20"><Sma sma={st.sma_20} last={last} /></Cell>
        <Cell k="SMA 50"><Sma sma={st.sma_50} last={last} /></Cell>
        <Cell k="SMA 200"><Sma sma={st.sma_200} last={last} /></Cell>
        <Cell k="Rel vol" title={`Last session volume vs its prior 20-day average${q?.volume ? ` (${fmtBig(q.volume)} vs ${fmtBig(q?.avg_volume_20d)})` : ""}. IEX feed — compare within this ticker only.`}>
          {rel != null ? <span className={rel >= 1.5 ? "warn" : undefined}>{rel.toFixed(2)}×</span> : "—"}
        </Cell>
        <Cell k="EPS TTM" title="Σ last four reported quarters (earnings history)">{eps != null ? fmtNum(eps) : "—"}</Cell>
      </div>
    </div>
  );
}
