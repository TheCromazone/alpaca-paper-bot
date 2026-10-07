"use client";

/**
 * HEAT — universe heatmap. Equities form a true market-cap treemap grouped
 * by GICS sector (Yahoo profile sector; falls back to the universe sector):
 *
 *  · area = market cap. Block areas are solved so each sector's tile area
 *    (excluding its header strip) is proportional to its cap; names inside a
 *    block are squarified on cap.
 *  · names too small for a horizontal "TKR / ±x.x%" label at ≥10px share a
 *    neutral grey "N others" aggregate (cap-weighted change in small neutral
 *    text; hover lists every member). An aggregate is never the largest tile
 *    in its sector — the biggest members are promoted out until it isn't.
 *  · held names are never aggregated: they always get their own labelled,
 *    outlined tile (floored to a legible size when tiny; said on hover).
 *  · sectors too small for a header share an OTHER block, where each small
 *    sector's remainder is an aggregate spelled out by name ("Industrials",
 *    never a symbol-shaped code).
 *  · every sector header is one line: sector name + cap-weighted change.
 *
 * ETFs (AUM isn't comparable with market cap and would double-count the
 * index) sit in an equal-weight strip underneath (2 decimals). Color is
 * diverging and nonlinear ((|Δ|/scale)^0.6, ±5% 1D · ±10% 5D · ±20% 1M)
 * with the shared ±0.05% "unchanged" band used by tiles, headers and counts.
 */
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import { term, type HeatCell } from "@/lib/api";
import { fmtBig, fmtChg, fmtPx } from "@/lib/format";
import { Empty, Panel, Seg, Skeleton } from "./ui";
import { OTHER, aggFit, fitLabel, groupOf, headerText, layout, wordsOf, type Member, type Tile } from "./heatLayout";
import s from "./Heatmap.module.css";

type Period = "1D" | "5D" | "1M";
const PERIODS: readonly Period[] = ["1D", "5D", "1M"];
const FIELD: Record<Period, "chg_1d" | "chg_5d" | "chg_1m"> = { "1D": "chg_1d", "5D": "chg_5d", "1M": "chg_1m" };
/** Saturation point per horizon. */
const SCALE: Record<Period, number> = { "1D": 0.05, "5D": 0.1, "1M": 0.2 };
/** The shared breadth definition (API `unchanged_band`, ±0.05%): inside it a
 *  name is "unchanged" — for tiles, headers and counts, on every horizon, so
 *  the heatmap and the tape always agree. */
const UNCH = 0.0005;
const LEGEND: Record<Period, number[]> = {
  "1D": [-0.05, -0.025, -0.01, 0, 0.01, 0.025, 0.05],
  "5D": [-0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1],
  "1M": [-0.2, -0.1, -0.04, 0, 0.04, 0.1, 0.2],
};

/** GICS sector (Yahoo naming) → full name for tooltips. */
const SECTORS: Record<string, { code: string; name: string }> = {
  Technology: { code: "TECH", name: "Information technology" },
  "Communication Services": { code: "COMM", name: "Communication services" },
  "Consumer Cyclical": { code: "DISC", name: "Consumer discretionary" },
  "Consumer Defensive": { code: "STPL", name: "Consumer staples" },
  "Financial Services": { code: "FINL", name: "Financials" },
  Healthcare: { code: "HLTH", name: "Health care" },
  Industrials: { code: "INDU", name: "Industrials" },
  Energy: { code: "ENRG", name: "Energy" },
  Utilities: { code: "UTIL", name: "Utilities" },
  "Basic Materials": { code: "MATL", name: "Materials" },
  "Real Estate": { code: "REIT", name: "Real estate" },
  // universe-sector fallbacks (no GICS profile yet)
  Tech: { code: "TECH", name: "Technology" },
  Consumer: { code: "CONS", name: "Consumer" },
  Financials: { code: "FINL", name: "Financials" },
  Materials: { code: "MATL", name: "Materials" },
  RealEstate: { code: "REIT", name: "Real estate" },
};
const ETF_SECTORS = new Set(["BroadETF", "FixedIncome"]);
const nameOfSector = (key: string) => SECTORS[key]?.name ?? key;

/** Company names that fit a tile: drop legal suffixes, a few house styles. */
const NAME_FIX: Record<string, string> = {
  NVDA: "Nvidia", META: "Meta", GOOGL: "Alphabet", IBM: "IBM", AMD: "AMD", "BRK.B": "Berkshire", JPM: "JPMorgan",
  QCOM: "Qualcomm", TXN: "Texas Instr.", AMZN: "Amazon", PG: "Procter & Gamble", KO: "Coca-Cola", DIS: "Disney", HD: "Home Depot",
};
function shortName(c: HeatCell): string {
  if (NAME_FIX[c.ticker]) return NAME_FIX[c.ticker];
  return (c.name ?? "")
    .replace(/^The /, "")
    .replace(/,? (Inc\.?|Incorporated|Corporation|Corp\.?|Company|Co\.|Holdings|Group|plc|N\.V\.|Ltd\.?)\b.*$/i, "")
    .replace(/,$/, "")
    .trim();
}

function dir(v: number | null | undefined): "up" | "down" | "flat" {
  if (v == null || !Number.isFinite(v) || Math.abs(v) < UNCH) return "flat";
  return v > 0 ? "up" : "down";
}

/** Map tiles: 1 decimal; a rounded zero prints unsigned. */
function pct1(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const r = Math.round(v * 1000) / 10;
  if (r === 0) return "0.0%";
  return `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}%`;
}

/** Unchanged (inside the ±0.05% band): a flat grey with no hue. */
const NEUTRAL_BG = "#22272e";
/** Aggregate tiles (buckets / sector remainders): darker neutral, outlined. */
const AGG_BG = "#12161c";

/** Diverging tile color, nonlinear in |Δ|. */
function tint(v: number | null | undefined, p: Period): { bg: string; fg: string } {
  const d = dir(v);
  if (v == null || !Number.isFinite(v)) return { bg: "var(--bg-2)", fg: "var(--ink-3)" };
  if (d === "flat") return { bg: NEUTRAL_BG, fg: "var(--ink-2)" };
  const t = Math.pow(Math.min(1, Math.abs(v) / SCALE[p]), 0.6);
  const [r, g, b] = d === "up" ? [16, 164, 88] : [212, 50, 50];
  const base = [24, 30, 38];
  // The first step out of the neutral band is already clearly tinted.
  const k = 0.3 + 0.7 * t;
  const mix = (c: number, i: number) => Math.round(base[i] + (c - base[i]) * k);
  return { bg: `rgb(${mix(r, 0)},${mix(g, 1)},${mix(b, 2)})`, fg: k > 0.52 ? "#fff" : "var(--ink)" };
}

/** Cap-weighted change of a set of names. */
function capAvg(members: Member[], f: (c: HeatCell) => number | null): number | null {
  let num = 0;
  let den = 0;
  for (const m of members) {
    const v = f(m.c);
    if (v == null) continue;
    num += v * m.cap;
    den += m.cap;
  }
  return den ? num / den : null;
}

// ── component ────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (d: string | null | undefined) => {
  if (!d) return "—";
  const [, m, day] = d.slice(0, 10).split("-");
  return MONTHS[parseInt(m, 10) - 1] ? `${MONTHS[parseInt(m, 10) - 1]} ${day}` : d;
};

type TipState = { t: Tile | null; c: HeatCell | null; x: number; y: number; below: boolean };
const GROUP_TIP_MAX = 16;

export function Heatmap({ className = "", style }: { className?: string; style?: CSSProperties }) {
  const [period, setPeriod] = useState<Period>("1D");
  const { data, isLoading, isError } = useQuery({ queryKey: ["heatmap"], queryFn: term.heatmap, refetchInterval: 60_000 });
  const f = useCallback((c: HeatCell) => c[FIELD[period]], [period]);

  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    mapEl.current = el;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.floor(e.contentRect.width);
      const h = Math.floor(e.contentRect.height);
      setBox((b) => (b && b.w === w && b.h === h ? b : { w, h }));
    });
    ro.observe(el);
    roRef.current = ro;
  }, []);

  const equities = useMemo(() => (data?.cells ?? []).filter((c) => !ETF_SECTORS.has(c.sector)), [data]);
  const etfs = useMemo(() => (data?.cells ?? []).filter((c) => ETF_SECTORS.has(c.sector)), [data]);
  // Layout depends on caps only, so switching horizon never reshuffles tiles.
  const blocks = useMemo(() => (box && equities.length ? layout(equities, box.w, box.h) : []), [box, equities]);
  const grouped = useMemo(() => blocks.reduce((a, b) => a + b.tiles.filter((t) => t.kind === "agg").reduce((x, t) => x + t.members.length, 0), 0), [blocks]);

  const stats = useMemo(() => {
    // 1D uses the API's own breadth counts verbatim (same numbers as the tape).
    if (period === "1D" && data && data.unchanged != null) return { adv: data.advancers, dec: data.decliners, unch: data.unchanged };
    const vals = (data?.cells ?? []).map(f).filter((v): v is number => v != null);
    return { adv: vals.filter((v) => dir(v) === "up").length, dec: vals.filter((v) => dir(v) === "down").length, unch: vals.filter((v) => dir(v) === "flat").length };
  }, [data, f, period]);

  const [tip, setTip] = useState<TipState | null>(null);
  /** Top-anchored position that stays inside the panel body. */
  const place = (el: HTMLElement, tipH: number) => {
    const host = mapEl.current?.parentElement?.parentElement;
    if (!host) return null;
    const hr = host.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const TW = 220;
    const x = Math.max(2, Math.min(hr.width - TW - 2, r.left - hr.left + r.width / 2 - TW / 2));
    const below = r.top - hr.top < tipH + 6;
    const want = below ? r.bottom - hr.top + 3 : r.top - hr.top - 3 - tipH;
    return { x, y: Math.max(2, Math.min(hr.height - tipH - 2, want)), below: true };
  };
  const showTile = (t: Tile, el: HTMLElement) => {
    const n = Math.min(t.members.length, GROUP_TIP_MAX);
    const p = place(el, t.kind === "name" ? 96 : 52 + Math.ceil(n / 2) * 15 + (t.members.length > n ? 14 : 0));
    if (p) setTip({ t, c: t.kind === "name" ? t.members[0].c : null, ...p });
  };
  const showCell = (c: HeatCell, el: HTMLElement) => {
    const p = place(el, 96);
    if (p) setTip({ t: null, c, ...p });
  };

  return (
    <Panel
      code="HEAT"
      title="Universe heatmap"
      sub={data ? `${equities.length} stocks · ${etfs.length} ETFs · close ${dayLabel(data.as_of)}` : undefined}
      className={className}
      style={style}
      flush
      actions={
        <>
          {data && (
            <span className="num" style={{ fontSize: 10.5, display: "inline-flex", gap: 7 }} title={`Advancing / declining / unchanged (|Δ| < ${(UNCH * 100).toFixed(2)}%) over ${period}`}>
              <span className="up">▲{stats.adv}</span>
              <span className="down">▼{stats.dec}</span>
              <span className="dim">={stats.unch}</span>
            </span>
          )}
          <Seg options={PERIODS} value={period} onChange={setPeriod} label="Heatmap horizon" />
        </>
      }
      testId="heat"
    >
      {isLoading ? (
        <Skeleton rows={9} height={20} />
      ) : isError ? (
        <Empty>Heatmap unavailable — API did not respond.</Empty>
      ) : !data?.cells.length ? (
        <Empty>No universe prices yet — the daily price refresh has not run.</Empty>
      ) : (
        <div className={s.body} onMouseLeave={() => setTip(null)}>
          <div className={s.mapOuter}>
            <div ref={mapRef} className={s.map}>
              {blocks.map((b) => {
                const avg = capAvg(b.members, f);
                return (
                  <div
                    key={b.key}
                    className={s.block}
                    style={{ left: b.r.x, top: b.r.y, width: b.r.w, height: b.r.h }}
                    role="group"
                    aria-label={`${b.name}, ${b.members.length} names, $${fmtBig(b.cap)} market cap, cap-weighted ${period} ${pct1(avg)}`}
                  >
                    <div
                      className={s.bhead}
                      title={`${b.key === OTHER ? `Other sectors: ${[...new Set(b.members.map((m) => wordsOf(groupOf(m.c))[0]))].join(", ")}` : b.name} · ${b.members.length} names · $${fmtBig(b.cap)} cap · cap-weighted ${period} ${fmtChg(avg)}`}
                    >
                      <span className={s.bname}>{headerText(b)}</span>
                      <span className={`${s.bavg} ${dir(avg)}`}>{pct1(avg)}</span>
                    </div>
                    {b.tiles.map((t, i) => (
                      <HeatTile key={`${t.kind}-${t.label}-${i}`} t={t} v={t.kind === "name" ? f(t.members[0].c) : capAvg(t.members, f)} period={period} onShow={showTile} onHide={() => setTip(null)} />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>

          <div className={s.etfs} role="group" aria-label="ETFs, equal weight">
            <span className={s.etfLabel} title="ETFs, equal-weight (AUM is not comparable with market cap)">ETF</span>
            {[...etfs.filter((c) => c.sector !== "FixedIncome"), null, ...etfs.filter((c) => c.sector === "FixedIncome")].map((c) => {
              if (!c) return <span key="sep" className={s.etfSep} title="Equity ETFs | bond ETFs" aria-hidden="true" />;
              const v = f(c);
              const h = tint(v, period);
              return (
                <Link
                  key={c.ticker}
                  href={`/security/${encodeURIComponent(c.ticker)}`}
                  className={`${s.etf} ${c.held ? s.held : ""}`}
                  style={{ background: h.bg, color: h.fg }}
                  onMouseEnter={(e) => showCell(c, e.currentTarget)}
                  onFocus={(e) => showCell(c, e.currentTarget)}
                  onBlur={() => setTip(null)}
                  aria-label={`${c.ticker}${c.held ? " (held)" : ""} ${period} ${fmtChg(v)}`}
                >
                  <span className={s.ct}>{c.ticker}</span>
                  <span className={s.cp}>
                    {fmtChg(v).replace("%", "")}
                    <span className={s.pctSign}>%</span>
                  </span>
                </Link>
              );
            })}
          </div>

          {tip && <Tip tip={tip} period={period} f={f} />}

          <div className={s.legend}>
            <span className={s.scale} title={`Nonlinear scale, saturates at ±${(SCALE[period] * 100).toFixed(0)}%`}>
              {LEGEND[period].map((v) => (
                <span key={v} className={`${s.sw} ${Math.abs(v) === SCALE[period] || v === 0 ? "" : s.swMid}`} title={v === 0 ? `Unchanged: |Δ| < ${(UNCH * 100).toFixed(2)}% — flat grey, no hue` : undefined}>
                  <span className={`${s.swc} ${v === 0 ? s.swZero : ""}`} style={{ background: tint(v, period).bg }} />
                  <span>{v === 0 ? `unch ±${(UNCH * 100).toFixed(2)}` : `${v > 0 ? "+" : "−"}${Math.abs(v * 100)}`}</span>
                </span>
              ))}
              <span>%</span>
            </span>
            <span className={s.key}>
              <span className={s.keyHeld} />
              held
            </span>
            <span
              className={s.key}
              title="Tile area is market cap. Names too small for a readable label share a grey 'N others' tile (hover lists them). Held names always get their own tile, at a legible minimum size if needed."
            >
              <span className={s.keyAgg} />
              area = mkt cap · {grouped} grouped
            </span>
            <span className={`${s.key} ${s.right}`} title="Sector headers show the cap-weighted change of every name in the sector">
              sector % cap-wtd
            </span>
          </div>
        </div>
      )}
    </Panel>
  );
}

function HeatTile({ t, v, period, onShow, onHide }: { t: Tile; v: number | null; period: Period; onShow: (t: Tile, el: HTMLElement) => void; onHide: () => void }) {
  const { r } = t;
  const handlers = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => onShow(t, e.currentTarget),
    onFocus: (e: React.FocusEvent<HTMLElement>) => onShow(t, e.currentTarget),
    onBlur: onHide,
  };
  const box: CSSProperties = { left: r.x, top: r.y, width: r.w, height: r.h };
  if (t.kind === "agg") {
    // Aggregates are not securities: neutral grey, outlined, small caps label,
    // change in small neutral text. Never a held outline.
    return (
      <div
        className={`${s.cell} ${s.agg}`}
        style={{ ...box, background: AGG_BG }}
        tabIndex={0}
        {...handlers}
        aria-label={`${t.label}, ${t.members.length} names, cap-weighted ${period} ${fmtChg(v)}`}
      >
        {aggFit(r.w, r.h, t.label) === "stack" ? (
          t.label.split(" ").map((w) => (
            <span key={w} className={s.aggLab}>
              {w}
            </span>
          ))
        ) : aggFit(r.w, r.h, t.label) === "line" ? (
          <span className={s.aggLab}>{t.label}</span>
        ) : r.h >= 26 ? (
          <span className={s.aggLab}>{t.members.length}</span>
        ) : null}
        {r.h >= 13 && r.w >= 32 && <span className={s.aggChg}>{pct1(v)}</span>}
      </div>
    );
  }
  const c = t.members[0].c;
  const h = tint(v, period);
  let pctTxt = pct1(v);
  let fit = fitLabel(r.w, r.h, t.label.length, pctTxt.length);
  if (!fit && v != null && Math.abs(v) >= 0.1) {
    pctTxt = `${v > 0 ? "+" : "−"}${Math.round(Math.abs(v) * 100)}%`;
    fit = fitLabel(r.w, r.h, t.label.length, pctTxt.length);
  }
  const name = fit && r.h >= 62 && r.w >= 84 ? shortName(c) : "";
  const showName = name && name.length * 5.3 <= r.w - 10;
  return (
    <Link
      href={`/security/${encodeURIComponent(c.ticker)}`}
      className={`${s.cell} ${c.held ? s.held : ""}`}
      style={{ ...box, background: h.bg, color: h.fg }}
      {...handlers}
      aria-label={`${c.ticker}${c.held ? " (held)" : ""} ${period} ${fmtChg(v)}`}
    >
      {fit && (
        <span className={s.lab}>
          <span className={s.ct} style={{ fontSize: fit.tk }}>
            {t.label}
          </span>
          <span className={s.cp} style={{ fontSize: fit.pc }}>
            {pctTxt}
          </span>
          {showName && <span className={s.cn}>{name}</span>}
        </span>
      )}
    </Link>
  );
}

function Tip({ tip, period, f }: { tip: TipState; period: Period; f: (c: HeatCell) => number | null }) {
  const pos: CSSProperties = { left: tip.x, top: tip.y, transform: tip.below ? undefined : "translateY(-100%)" };
  // Group tiles: list every member with its change.
  if (tip.t && tip.t.kind === "agg") {
    const t = tip.t;
    const avg = capAvg(t.members, f);
    const list = [...t.members].sort((a, b) => b.cap - a.cap);
    const shown = list.slice(0, GROUP_TIP_MAX);
    const secs = [...new Set(t.members.map((m) => wordsOf(groupOf(m.c))[0]))];
    const title = t.sector === OTHER ? `${secs.join(", ")} · ${t.members.length} names` : `${wordsOf(t.sector)[0]} · ${t.members.length} smaller names`;
    return (
      <div className={s.tip} style={pos} role="tooltip">
        <div className={s.tipHead}>
          <span className={s.tipName} style={{ color: "var(--ink)" }}>{title}</span>
          <span className={`num ${dir(avg)}`} style={{ marginLeft: "auto" }}>{fmtChg(avg)}</span>
        </div>
        <div className={s.tipSub}>
          cap-wtd {period} · ${fmtBig(t.cap)} · {t.floored ? "tile at min label size" : "area = combined cap"}
        </div>
        <div className={s.tipList}>
          {shown.map((m) => {
            const v = f(m.c);
            return (
              <div key={m.c.ticker} className={s.tipRow} title={`${m.c.name ?? m.c.ticker} · $${fmtBig(m.cap)}`}>
                <span className="tkr" style={{ color: m.c.held ? "var(--blue)" : undefined }}>{m.c.ticker}</span>
                <span className={`num ${dir(v)}`}>{fmtChg(v)}</span>
              </div>
            );
          })}
        </div>
        {list.length > shown.length && <div className={s.tipSub} style={{ margin: "3px 0 0" }}>+{list.length - shown.length} more · largest first</div>}
      </div>
    );
  }
  const c = tip.c!;
  return (
    <div className={s.tip} style={pos} role="tooltip">
      <div className={s.tipHead}>
        <span className="tkr" style={{ color: c.held ? "var(--blue)" : undefined }}>{c.ticker}</span>
        <span className={s.tipName}>{c.name ?? ""}</span>
        <span className="num" style={{ marginLeft: "auto", color: "var(--ink)" }}>{fmtPx(c.last)}</span>
      </div>
      <div className={s.tipSub}>
        {ETF_SECTORS.has(c.sector) ? "ETF" : nameOfSector(groupOf(c))}
        {c.mcap ? <span className="num">{` · ${ETF_SECTORS.has(c.sector) ? "AUM" : "cap"} $${fmtBig(c.mcap)}`}</span> : null}
      </div>
      {c.held && (
        <div className={s.tipSub} style={{ color: "var(--blue)", marginTop: -3 }}>
          Held{c.weight != null ? ` · ${(c.weight * 100).toFixed(1)}% of book` : ""}
        </div>
      )}
      {tip.t?.floored && (
        <div className={s.tipSub} style={{ marginTop: -3 }}>
          {tip.t.why === "held" ? "Held — shown at a legible minimum size (area > its cap)" : "Shown at a legible minimum size (area > its cap)"}
        </div>
      )}
      <div className={s.tipGrid}>
        {PERIODS.map((p) => (
          <div key={p} style={{ display: "grid", gap: 1 }}>
            <span className={s.tipK} data-on={p === period}>{p}</span>
            <span className={`${s.tipV} ${dir(c[FIELD[p]])}`}>{fmtChg(c[FIELD[p]])}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
