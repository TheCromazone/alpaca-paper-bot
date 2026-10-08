"use client";

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, term, ManualTradeResult, PortfolioSummary, PositionRow } from "@/lib/api";
import { fmtChg, fmtNum, fmtPx, fmtUSD, tone } from "@/lib/format";
import { RangeBar, marketSession, useNow } from "./term/ui";
import s from "./ManualTradePanel.module.css";

/**
 * TKT — manual buy/sell, the dashboard's user-driven escape hatch around the
 * LLM routines, styled as an EMSX order ticket. The flow is:
 *
 *   1. Pick side, type a symbol, choose qty *or* notional, optional note.
 *   2. "Preview" → confirmation dialog shows symbol, side, size, est. qty /
 *      notional vs the 5%-of-equity cap and the live position you'd be adding
 *      to / selling from.
 *   3. "Confirm" → POST /trade/manual → receipt, queries invalidated so the
 *      blotter + positions re-render in seconds.
 *
 * Validation messages from the API (e.g. "no live quote", "buying power
 * insufficient", "no position in X") are surfaced verbatim — they're already
 * user-readable. Every data-testid here is load-bearing for
 * e2e/manual-trade.spec.ts.
 */
type Side = "buy" | "sell";

type Stage = "form" | "preview" | "submitting" | "success" | "error";

const QUICK = [0.005, 0.01, 0.025, 0.05] as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-13T00:00:00+00:00" → "Oct 13" (date-only; no timezone shift). */
const fmtDayKey = (iso: string) => {
  const [, m, d] = iso.slice(0, 10).split("-");
  return `${MONTHS[Number(m) - 1]} ${d}`;
};
const ET_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
/** Calendar days from today (ET) to a date-only report date. */
function daysUntil(iso: string, now: number) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const [ty, tm, td] = ET_DAY.format(new Date(now)).split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
}

export function ManualTradePanel({ className = "", style }: { className?: string; style?: CSSProperties } = {}) {
  const qc = useQueryClient();

  const { data: summary } = useQuery<PortfolioSummary>({
    queryKey: ["summary"],
    queryFn: api.summary,
  });
  const { data: positions } = useQuery<PositionRow[]>({
    queryKey: ["positions"],
    queryFn: api.positions,
  });
  // Last close for any universe ticker — shared with the status-bar tape.
  const { data: heat } = useQuery({ queryKey: ["heatmap"], queryFn: term.heatmap, refetchInterval: 60_000 });

  const [side, setSide] = useState<Side>("buy");
  // The side stays visually neutral until the trader engages (picks a side
  // or types a symbol) — a lit BUY over an empty ticket read as staged.
  const [sideChosen, setSideChosen] = useState(false);
  const pickSide = (v: Side) => {
    setSide(v);
    setSideChosen(true);
  };
  const [symbol, setSymbol] = useState("");
  const [sizingMode, setSizingMode] = useState<"notional" | "qty">("notional");
  // Empty until the trader sizes it — a pre-filled "$500" next to an empty
  // symbol read as an order already staged.
  const [notional, setNotional] = useState<string>("");
  const [qty, setQty] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [allowAfterHours, setAllowAfterHours] = useState(false);
  const [stage, setStage] = useState<Stage>("form");
  const [errMsg, setErrMsg] = useState<string>("");
  const [result, setResult] = useState<ManualTradeResult | null>(null);

  const heldByTicker = useMemo(() => {
    const m = new Map<string, PositionRow>();
    (positions ?? []).forEach((p) => m.set(p.ticker.toUpperCase(), p));
    return m;
  }, [positions]);

  const symU = symbol.trim().toUpperCase();
  const existing = symU ? heldByTicker.get(symU) ?? null : null;
  const quote = symU ? heat?.cells.find((c) => c.ticker === symU) ?? null : null;

  // Security context (52w range, spark, name) — debounced so typing "AAPL"
  // doesn't fire four lookups.
  const [symDeb, setSymDeb] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setSymDeb(symU), 220);
    return () => clearTimeout(id);
  }, [symU]);
  const { data: monResp } = useQuery({
    queryKey: ["tkt-quote", symDeb],
    queryFn: () => term.monitor([symDeb]),
    enabled: /^[A-Z][A-Z0-9.\-]{0,9}$/.test(symDeb),
    staleTime: 60_000,
    refetchInterval: false,
  });
  const mon = symU && monResp?.rows[0]?.ticker === symU ? monResp.rows[0] : null;
  const { data: earnings } = useQuery({ queryKey: ["earnings", 60], queryFn: () => api.earnings(60), staleTime: 300_000, refetchInterval: 600_000 });
  const now = useNow(30_000);
  const session = marketSession(now);
  const mktOpen = session.label === "Open";
  const needsQueue = !!now && !mktOpen && !allowAfterHours;
  const sideLit = sideChosen || !!symU;
  const earn = symU ? earnings?.find((e) => e.ticker === symU) ?? null : null;
  const earnDays = earn && now ? daysUntil(earn.report_date, now) : null;
  const blackout = earnDays != null && earnDays <= 2;
  const quote1d = mon?.chg_1d ?? quote?.chg_1d ?? null;
  const fromHi = mon?.last != null && mon.hi_52w ? mon.last / mon.hi_52w - 1 : null;
  const heldList = useMemo(() => [...(positions ?? [])].sort((a, b) => b.market_value - a.market_value).slice(0, 8), [positions]);

  // Reference price for estimates only — the API sizes off its own live quote.
  const refPx = existing?.market_price ?? mon?.last ?? quote?.last ?? null;
  const equity = summary?.equity ?? 0;
  const fivePctCap = equity * 0.05;
  const proposedNotional =
    sizingMode === "notional"
      ? Number(notional) || 0
      : (Number(qty) || 0) * (refPx ?? 0);
  const overFivePct = side === "buy" && proposedNotional > fivePctCap && fivePctCap > 0;
  const estShares = sizingMode === "notional" ? (refPx ? (Number(notional) || 0) / refPx : null) : Number(qty) || 0;
  const pctEq = equity > 0 ? proposedNotional / equity : null;
  const sideColor = side === "buy" ? "var(--up)" : "var(--down)";
  // Pre-trade sector check against the 25% sector cap.
  const sector = existing?.sector ?? quote?.sector ?? null;
  const sectorNow = sector ? summary?.sector_breakdown.find((x) => x.sector === sector)?.weight ?? 0 : null;
  const sectorAfter =
    sectorNow != null && equity > 0 ? Math.max(0, sectorNow + ((side === "buy" ? 1 : -1) * proposedNotional) / equity) : null;

  const mut = useMutation({
    mutationFn: () =>
      api.manualTrade({
        symbol: symU,
        side,
        qty: sizingMode === "qty" ? Number(qty) : undefined,
        notional_usd: sizingMode === "notional" ? Number(notional) : undefined,
        note: note.trim(),
        allow_after_hours: allowAfterHours,
      }),
    onSuccess: (data) => {
      setResult(data);
      setStage("success");
      // Refresh everything affected by a new trade.
      void qc.invalidateQueries({ queryKey: ["trades"] });
      void qc.invalidateQueries({ queryKey: ["positions"] });
      void qc.invalidateQueries({ queryKey: ["summary"] });
      void qc.invalidateQueries({ queryKey: ["history", 30] });
      void qc.invalidateQueries({ queryKey: ["memory", "trade_log"] });
    },
    onError: (err: Error) => {
      setErrMsg(err.message || "submission failed");
      setStage("error");
    },
  });

  function reset() {
    setStage("form");
    setErrMsg("");
    setResult(null);
    setQty("");
    setNotional("");
    setNote("");
    setSymbol("");
  }

  function onPreview(e: React.FormEvent) {
    e.preventDefault();
    setErrMsg("");
    if (!symU) {
      setErrMsg("symbol is required");
      return;
    }
    if (sizingMode === "notional" && !(Number(notional) > 0)) {
      setErrMsg("notional must be > 0");
      return;
    }
    if (sizingMode === "qty" && !(Number(qty) > 0)) {
      setErrMsg("qty must be > 0");
      return;
    }
    if (side === "sell" && !existing) {
      setErrMsg(`no position in ${symU} — cannot sell what you don't own`);
      return;
    }
    setStage("preview");
  }

  function onConfirm() {
    setStage("submitting");
    mut.mutate();
  }

  function quickSize(p: number) {
    if (!equity) return;
    if (sizingMode === "notional") setNotional(String(Math.floor(equity * p)));
    else if (refPx) setQty((Math.floor(((equity * p) / refPx) * 10000) / 10000).toString());
  }
  const quickActive = (p: number) =>
    sizingMode === "notional" ? equity > 0 && Number(notional) === Math.floor(equity * p) : false;

  return (
    <>
      <form
        onSubmit={onPreview}
        className={`panel ${s.ticket} ${className}`}
        style={style}
        data-testid="manual-trade-panel"
        aria-label="Manual order ticket"
      >
        <header className="panel-head">
          <span className="panel-code">TKT</span>
          <h2 className="panel-title">Manual order</h2>
          <span className="panel-sub" title="The manual endpoint places market orders only, time-in-force DAY — no limit price, no GTC">
            market orders only · DAY
          </span>
        </header>

        <div className={`panel-body ${s.body}`}>
          {/* side toggle — neutral until engaged, with an explicit prompt */}
          <div className={s.sideHead}>
            <span className={s.lbl}>Side</span>
            {!sideLit && <span className={s.choose}>choose side ▾</span>}
          </div>
          <div className={s.sides} role="group" aria-label="Side">
            <button type="button" className={s.side} data-k="buy" aria-pressed={sideLit && side === "buy"} onClick={() => pickSide("buy")} data-testid="side-buy">
              BUY
            </button>
            <button type="button" className={s.side} data-k="sell" aria-pressed={sideLit && side === "sell"} onClick={() => pickSide("sell")} data-testid="side-sell">
              SELL
            </button>
          </div>

          {/* symbol + size */}
          <div className={s.row2}>
            <label className={s.field}>
              <span className={s.lbl}>Symbol</span>
              <input
                type="text"
                className={`input ${s.sym}`}
                placeholder="TICKER"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                data-testid="symbol-input"
                autoComplete="off"
                spellCheck={false}
                maxLength={16}
                // Autofill extensions stamp attrs (e.g. data-jpaf-id) on form
                // fields before React hydrates — harmless, don't warn.
                suppressHydrationWarning
              />
            </label>
            <div className={s.field}>
              <span className={s.lbl}>
                Size
                <button
                  type="button"
                  className={s.unit}
                  onClick={() => setSizingMode(sizingMode === "notional" ? "qty" : "notional")}
                  data-testid="sizing-toggle"
                  title={`Switch to ${sizingMode === "notional" ? "shares" : "notional"}`}
                >
                  <span data-on={sizingMode === "notional"}>USD</span>
                  <span data-on={sizingMode === "qty"}>SHS</span>
                </button>
              </span>
              {sizingMode === "notional" ? (
                <div className={s.affix}>
                  <span>$</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    className={`input ${s.num}`}
                    value={notional}
                    onChange={(e) => setNotional(e.target.value)}
                    data-testid="notional-input"
                    placeholder="notional"
                    aria-label="Notional in USD"
                    suppressHydrationWarning
                  />
                </div>
              ) : (
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  className={`input ${s.num}`}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  data-testid="qty-input"
                  placeholder="shares"
                  aria-label="Quantity in shares"
                  suppressHydrationWarning
                />
              )}
            </div>
          </div>

          {/* quick size: % of equity */}
          <div className={s.chips} role="group" aria-label="Quick size as % of equity">
            {QUICK.map((p) => (
              <button
                key={p}
                type="button"
                className={s.chip}
                aria-pressed={quickActive(p)}
                disabled={!equity || (sizingMode === "qty" && !refPx)}
                onClick={() => quickSize(p)}
                title={`${(p * 100).toFixed(1)}% of equity${equity ? ` = ${fmtUSD(equity * p)}` : ""}`}
              >
                {p * 100}%{p === 0.05 ? " cap" : ""}
              </button>
            ))}
          </div>

          <input
            type="text"
            className={`input ${s.note}`}
            placeholder="note — optional, logged with the order"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="note-input"
            aria-label="Note (optional)"
            maxLength={200}
            suppressHydrationWarning
          />

          {/* pre-trade context: account when empty, security + impact once a symbol is typed */}
          <div className={s.ctx}>
            {!symU ? (
              <>
                <div className={s.ctxHead}>
                  <span>Account</span>
                  <span className={s.ctxMeta}>{summary ? `${summary.position_count}/25 positions` : ""}</span>
                </div>
                <div className={s.grid2}>
                  <div className={s.kv}>
                    <span>Equity</span>
                    <span>{summary ? fmtUSD(summary.equity, { compact: true }) : "—"}</span>
                  </div>
                  <div className={s.kv}>
                    <span>Cash</span>
                    <span>
                      {summary ? fmtUSD(summary.cash, { compact: true }) : "—"}
                      {summary && summary.equity > 0 && <span className={s.dim}> {((summary.cash / summary.equity) * 100).toFixed(0)}%</span>}
                    </span>
                  </div>
                  <div
                    className={s.kv}
                    title={
                      summary && summary.equity > 0
                        ? `Alpaca margin buying power — ${(summary.buying_power / summary.equity).toFixed(1)}× equity, not cash`
                        : "Alpaca margin buying power — not cash"
                    }
                  >
                    <span>Margin BP</span>
                    <span>
                      {summary ? fmtUSD(summary.buying_power, { compact: true }) : "—"}
                      {summary && summary.equity > 0 && <span className={s.dim}> {(summary.buying_power / summary.equity).toFixed(1)}×</span>}
                    </span>
                  </div>
                  <div className={s.kv}>
                    <span>5% cap</span>
                    <span>{equity ? fmtUSD(fivePctCap, { compact: true }) : "—"}</span>
                  </div>
                </div>
                {heldList.length > 0 && (
                  <>
                    <div className={s.ctxHead} style={{ marginTop: 2 }}>
                      <span>Positions · click to load</span>
                      <span className={s.ctxMeta}>
                        {positions && positions.length > heldList.length ? `top ${heldList.length} of ${positions.length}` : ""} by value ↓
                      </span>
                    </div>
                    {/* column-major: read down the left column, then the right */}
                    <div className={s.pick} style={{ gridTemplateRows: `repeat(${Math.ceil(heldList.length / 2) + 1}, auto)` }}>
                      {[heldList.slice(0, Math.ceil(heldList.length / 2)), heldList.slice(Math.ceil(heldList.length / 2))].flatMap((col, c) => [
                        <div key={`h${c}`} className={`${s.pickRow} ${s.pickHead}`} aria-hidden="true">
                          <span>Tkr</span>
                          <span>Wt</span>
                          <span>P&amp;L</span>
                        </div>,
                        ...col.map((p) => (
                        <button
                          key={p.ticker}
                          type="button"
                          className={s.pickRow}
                          onClick={() => setSymbol(p.ticker)}
                          title={`Load ${p.ticker} · ${fmtNum(p.qty, 2)} sh @ ${fmtPx(p.avg_cost)} · last ${fmtPx(p.market_price)}`}
                        >
                          <span className={s.pickTkr}>{p.ticker}</span>
                          <span className={s.dim}>{equity > 0 ? `${((p.market_value / equity) * 100).toFixed(1)}%` : ""}</span>
                          <span className={tone(p.unrealized_pct)}>{fmtChg(p.unrealized_pct, 1)}</span>
                        </button>
                        )),
                      ])}
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <div className={s.ctxHead}>
                  <span style={{ color: "var(--ink)", letterSpacing: "0.02em" }}>
                    {symU}
                    {mon?.name && <span className={s.ctxName}> {mon.name}</span>}
                  </span>
                  {sector && <span className={s.ctxMeta}>{sector}</span>}
                </div>
                <div className={s.grid2}>
                  <div className={s.kv}>
                    <span>Last</span>
                    <span>
                      {refPx != null ? fmtPx(refPx) : "—"} {quote1d != null && <span className={tone(quote1d)}>{fmtChg(quote1d)}</span>}
                    </span>
                  </div>
                  <div className={s.kv} title={mon?.hi_52w != null ? `52w ${fmtPx(mon.lo_52w)} – ${fmtPx(mon.hi_52w)}` : undefined}>
                    <span>52w hi</span>
                    <span>
                      {mon?.pos_52w != null && <RangeBar pos={mon.pos_52w} width={34} />}{" "}
                      {fromHi != null ? <span className={tone(fromHi)}>{fmtChg(fromHi, 1)}</span> : "—"}
                    </span>
                  </div>
                  <div className={s.kv}>
                    <span>Earnings</span>
                    <span style={{ color: blackout ? "var(--warn)" : undefined }}>
                      {earn ? `${fmtDayKey(earn.report_date)}${earnDays != null ? ` · ${earnDays}d` : ""}` : mon || quote ? "none ≤60d" : "—"}
                    </span>
                  </div>
                  <div className={s.kv}>
                    <span>Position</span>
                    <span>
                      {existing ? (
                        <>
                          {fmtNum(existing.qty, existing.qty % 1 ? 2 : 0)} <span className={tone(existing.unrealized_pct)}>{fmtChg(existing.unrealized_pct, 1)}</span>
                        </>
                      ) : (
                        <span className={s.dim}>not held</span>
                      )}
                    </span>
                  </div>
                  <div className={s.kv}>
                    <span>{sizingMode === "notional" ? "Est. shares" : "Est. notional"}</span>
                    <span>
                      {sizingMode === "notional"
                        ? estShares != null && estShares > 0
                          ? `≈${fmtNum(estShares, 2)}`
                          : "—"
                        : proposedNotional > 0
                          ? `≈${fmtUSD(proposedNotional, { compact: true })}`
                          : "—"}
                    </span>
                  </div>
                  <div className={s.kv}>
                    <span>% equity</span>
                    <span style={{ color: overFivePct ? "var(--warn)" : undefined }}>{pctEq != null && proposedNotional > 0 ? `${(pctEq * 100).toFixed(2)}%` : "—"}</span>
                  </div>
                  <div className={s.kv} title="Position weight before → after this order (est.)">
                    <span>Pos. wt</span>
                    <span>
                      {equity > 0 ? (
                        <>
                          <span className={s.dim}>{(((existing?.market_value ?? 0) / equity) * 100).toFixed(1)}→</span>
                          {((Math.max(0, (existing?.market_value ?? 0) + (side === "buy" ? 1 : -1) * proposedNotional) / equity) * 100).toFixed(1)}%
                        </>
                      ) : (
                        "—"
                      )}
                    </span>
                  </div>
                  <div className={s.kv} title={`Sector${sector ? ` ${sector}` : ""} weight before → after vs the 25% sector cap (est.)`}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{sector ?? "Sector"}</span>
                    <span>
                      {sectorNow != null && sectorAfter != null ? (
                        <>
                          <span className={s.dim}>{(sectorNow * 100).toFixed(1)}→</span>
                          <span style={{ color: sectorAfter > 0.25 ? "var(--warn)" : undefined }}>{(sectorAfter * 100).toFixed(1)}%</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </span>
                  </div>
                </div>
                <div className={s.capBar} title={`This order vs the 5% cap (${fmtUSD(fivePctCap)})`}>
                  <span style={{ width: `${Math.min(1, fivePctCap > 0 ? proposedNotional / (fivePctCap * 1.25) : 0) * 100}%`, background: overFivePct ? "var(--warn)" : sideColor, opacity: 0.85 }} />
                  <i style={{ left: "80%" }} />
                </div>
                {(overFivePct || (blackout && side === "buy") || (!mon && !quote && !existing && symDeb === symU)) && (
                  <div className={s.warnLine}>
                    {overFivePct
                      ? "▲ above the 5% per-position cap"
                      : blackout && side === "buy"
                        ? `▲ earnings in ${earnDays}d — inside the bot's 2-day blackout`
                        : "outside tracked universe — priced by the API at submit"}
                  </div>
                )}
                {mon?.spark && mon.spark.filter((v) => v != null).length > 1 && <MiniChart data={mon.spark} cost={existing?.avg_cost ?? null} />}
              </>
            )}
          </div>

          {/* Not extended-hours trading: when the market is closed the API
              queues a DAY market order that fills at the next open. Kept in
              the DOM while the market is open (inert there) so the e2e spec,
              which ticks it, runs at any hour. */}
          <label
            className={s.ah}
            data-open={mktOpen || undefined}
            title="When the market is closed, the order is queued as a DAY market order and fills at the next open. No extended-hours fills."
          >
            <input
              type="checkbox"
              checked={allowAfterHours}
              onChange={(e) => setAllowAfterHours(e.target.checked)}
              data-testid="ah-checkbox"
              suppressHydrationWarning
            />
            Queue for next open
            <small style={{ color: needsQueue ? "var(--warn)" : undefined }}>
              {!now ? "" : mktOpen ? "n/a · market open, fills now" : needsQueue ? `required · market ${session.label.toLowerCase()}` : "fills at the open"}
            </small>
          </label>

          {errMsg && stage === "form" && (
            <div className={s.err} data-testid="form-error">
              {errMsg}
            </div>
          )}

          <button
            type="submit"
            data-testid="preview-btn"
            disabled={!symU}
            data-side={side}
            className={`btn ${symU ? (side === "buy" ? "buy" : "sell") : ""} ${s.preview} ${symU ? s.previewOn : s.previewOff}`}
          >
            {symU ? (
              <>
                Preview {side} {symU}
                <kbd>↵</kbd>
              </>
            ) : (
              <>
                Preview order <span className={s.previewHint}>· enter a symbol</span>
              </>
            )}
          </button>
        </div>
      </form>

      {/* preview / confirm */}
      {(stage === "preview" || stage === "submitting") && (
        <Dialog onClose={() => setStage("form")} title="Confirm order" accent={sideColor}>
          <div className={s.dlgBody}>
            <h3 className={s.dlgTitle}>
              Confirm <span style={{ color: sideColor }}>{side.toUpperCase()}</span> {symU}
            </h3>
            <div className={s.dlgGrid}>
              <span>Side</span>
              <span style={{ color: sideColor, fontWeight: 600 }}>{side.toUpperCase()}</span>
              <span>Order</span>
              <span>MARKET · DAY · {sizingMode === "notional" ? "notional" : "shares"}</span>
              <span>Size</span>
              <span>{sizingMode === "notional" ? `${fmtUSD(Number(notional))} (notional)` : `${qty} shares`}</span>
              <span>Ref. price</span>
              <span>{refPx != null ? `${fmtPx(refPx)} ${existing ? "mkt" : "last close"}` : "priced at fill"}</span>
              <span>{sizingMode === "notional" ? "Est. shares" : "Est. notional"}</span>
              <span>
                {sizingMode === "notional"
                  ? estShares
                    ? `≈${fmtNum(estShares, 2)} sh`
                    : "—"
                  : proposedNotional
                    ? `≈${fmtUSD(proposedNotional)}`
                    : "—"}
              </span>
              <span>% of equity</span>
              <span style={{ color: overFivePct ? "var(--warn)" : undefined }}>
                {pctEq != null && proposedNotional > 0 ? `${(pctEq * 100).toFixed(2)}%` : "—"}
                <span style={{ color: "var(--ink-3)" }}> of {fmtUSD(equity, { compact: true })}</span>
              </span>
              <span>Session</span>
              <span style={{ color: !now || mktOpen ? undefined : allowAfterHours ? "var(--warn)" : "var(--alert)" }}>
                {!now
                  ? "—"
                  : mktOpen
                    ? "market open · fills now"
                    : allowAfterHours
                      ? "market closed · queued, fills at the open"
                      : "market closed · will be rejected (tick Queue for next open)"}
              </span>
              {existing && (
                <>
                  <span>Current position</span>
                  <span>
                    {existing.qty.toFixed(2)} @ ${existing.avg_cost.toFixed(2)} · mkt ${existing.market_price.toFixed(2)}
                  </span>
                </>
              )}
              {note && (
                <>
                  <span>Note</span>
                  <span style={{ fontFamily: "var(--font-plex-cond), sans-serif" }}>{note}</span>
                </>
              )}
            </div>
            {overFivePct && (
              <div className={s.callout}>
                Above the 5% per-position cap the LLM uses ({fmtUSD(fivePctCap, { compact: true })}). The manual endpoint
                doesn&apos;t enforce it — this is your override.
              </div>
            )}
            <p className={s.fine}>
              Routes to Alpaca PAPER as a market order · DRY_RUN respected · opposite-side open orders on {symU} are
              auto-cancelled first · lands in BLTR within ~10s.
            </p>
          </div>
          <div className={s.dlgFoot}>
            <small>ESC cancel</small>
            <button type="button" className="btn" onClick={() => setStage("form")} data-testid="cancel-btn" disabled={stage === "submitting"}>
              Cancel
            </button>
            <button
              type="button"
              className={`btn ${side === "buy" ? "buy" : "sell"}`}
              onClick={onConfirm}
              data-testid="confirm-btn"
              disabled={stage === "submitting"}
              style={{ minWidth: 132, cursor: stage === "submitting" ? "wait" : undefined }}
            >
              {stage === "submitting" ? "Submitting…" : `Confirm ${side.toUpperCase()}`}
            </button>
          </div>
        </Dialog>
      )}

      {stage === "success" && result && (
        <Dialog onClose={reset} title="Order receipt" accent={result.dry_run ? "var(--amber)" : "var(--up)"}>
          <div className={s.dlgBody}>
            <h3 className={s.dlgTitle} style={{ color: result.dry_run ? "var(--amber)" : "var(--up)" }}>
              {result.dry_run ? "Dry run recorded" : "Order submitted"}
            </h3>
            <div className={s.dlgGrid}>
              <span>Symbol</span>
              <span style={{ fontWeight: 600 }}>{result.symbol}</span>
              <span>Side</span>
              <span style={{ color: result.side === "buy" ? "var(--up)" : "var(--down)", fontWeight: 600 }}>{result.side.toUpperCase()}</span>
              <span>Qty</span>
              <span>{+result.qty.toFixed(4)}</span>
              <span>Est. price</span>
              <span>{fmtUSD(result.est_price)}</span>
              <span>Notional</span>
              <span>{fmtUSD(result.notional)}</span>
              <span>Order ID</span>
              <span>{result.order_id}</span>
              <span>Status</span>
              <span>{result.status}</span>
            </div>
            {!result.market_was_open && <p className={s.fine} style={{ color: "var(--warn)" }}>Market closed — queued as a DAY market order; fills at the open.</p>}
            {result.cancelled_open_opposite > 0 && (
              <p className={s.fine}>
                Auto-cancelled {result.cancelled_open_opposite} opposite-side open order(s) before submit (wash-trade safety).
              </p>
            )}
          </div>
          <div className={s.dlgFoot}>
            <button type="button" className="btn primary" onClick={reset} data-testid="success-close" style={{ minWidth: 96 }}>
              Done
            </button>
          </div>
        </Dialog>
      )}

      {stage === "error" && (
        <Dialog onClose={() => setStage("form")} title="Order rejected" accent="var(--alert)">
          <div className={s.dlgBody}>
            <h3 className={s.dlgTitle} style={{ color: "var(--alert)" }}>
              Rejected
            </h3>
            <pre data-testid="error-message" className={s.errPre}>
              {errMsg}
            </pre>
          </div>
          <div className={s.dlgFoot}>
            <small>ESC back to ticket</small>
            <button type="button" className="btn" onClick={() => setStage("form")} style={{ minWidth: 96 }}>
              Edit
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

/** 1-month close line that fills the leftover ticket height; dashed = avg cost. */
function MiniChart({ data, cost }: { data: (number | null)[]; cost: number | null }) {
  const pts = data.filter((v): v is number => v != null && Number.isFinite(v));
  const all = cost != null ? [...pts, cost] : pts;
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const X = (i: number) => (i / (pts.length - 1)) * 100;
  const Y = (v: number) => 38 - ((v - lo) / span) * 36;
  const d = pts.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(2)},${Y(v).toFixed(2)}`).join("");
  const up = pts[pts.length - 1] >= pts[0];
  const c = up ? "var(--up)" : "var(--down)";
  const chg = pts[pts.length - 1] / pts[0] - 1;
  return (
    <div className={s.mini}>
      <div className={s.miniLbl}>
        <span>
          1M <span className={up ? "up" : "down"}>{fmtChg(chg, 1)}</span>
        </span>
        <span>
          {fmtPx(lo)} – {fmtPx(hi)}
          {cost != null && <span style={{ color: "var(--ink-3)" }}> · cost ┄</span>}
        </span>
      </div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <path d={`${d}L100,40L0,40Z`} fill={c} opacity={0.1} />
        {cost != null && <line x1={0} x2={100} y1={Y(cost)} y2={Y(cost)} stroke="var(--ink-3)" strokeDasharray="3 2" vectorEffect="non-scaling-stroke" strokeWidth={1} />}
        <path d={d} fill="none" stroke={c} strokeWidth={1.4} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function Dialog({ children, onClose, title, accent }: { children: ReactNode; onClose: () => void; title: string; accent: string }) {
  // Escape closes the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div onClick={onClose} className={s.overlay} data-testid="manual-trade-modal">
      <div onClick={(e) => e.stopPropagation()} className={s.dialog} style={{ borderTopColor: accent }} role="dialog" aria-modal="true" aria-label={title}>
        <div className={s.dlgHead}>
          <span className="panel-code">TKT</span>
          <span className="panel-title">{title}</span>
          <span className="panel-actions">
            <span className="cmd-kbd">ESC</span>
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}
