"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ManualTradeResult, PortfolioSummary, PositionRow } from "@/lib/api";
import { fmtUSD } from "@/lib/format";
import { SectionHead } from "./SectionHead";

/**
 * Manual buy/sell — the dashboard's user-driven escape hatch around the LLM
 * routines. The form is intentionally small; the heavy lifting lives in the
 * confirmation modal that appears after "Preview". The flow is:
 *
 *   1. Pick side, type a symbol, choose qty *or* notional, optional note.
 *   2. "Preview" → modal shows symbol, side, computed notional + a 5%-of-equity
 *      sanity bar and the live position you'd be adding to / selling from.
 *   3. "Confirm" → POST /trade/manual → success toast, queries invalidated so
 *      the trade journal + positions re-render in seconds.
 *
 * Validation messages from the API (e.g. "no live quote", "buying power
 * insufficient", "no position in X") are surfaced verbatim — they're already
 * user-readable.
 */
type Side = "buy" | "sell";

type Stage = "form" | "preview" | "submitting" | "success" | "error";

export function ManualTradePanel() {
  const qc = useQueryClient();

  const { data: summary } = useQuery<PortfolioSummary>({
    queryKey: ["summary"],
    queryFn: api.summary,
  });
  const { data: positions } = useQuery<PositionRow[]>({
    queryKey: ["positions"],
    queryFn: api.positions,
  });

  const [side, setSide] = useState<Side>("buy");
  const [symbol, setSymbol] = useState("");
  const [sizingMode, setSizingMode] = useState<"notional" | "qty">("notional");
  const [notional, setNotional] = useState<string>("500");
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
  const equity = summary?.equity ?? 0;
  const fivePctCap = equity * 0.05;
  const proposedNotional =
    sizingMode === "notional"
      ? Number(notional) || 0
      : (Number(qty) || 0) * (existing?.market_price ?? 0);
  const overFivePct = side === "buy" && proposedNotional > fivePctCap && fivePctCap > 0;

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
    setNotional("500");
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

  const buyColor = "var(--lime)";
  const sellColor = "var(--rose)";

  return (
    <article style={{ minWidth: 0 }}>
      <SectionHead
        eyebrow="Manual override"
        title="Place a trade"
        right={
          <span>
            5% cap {fmtUSD(fivePctCap, { compact: true })} &middot; BP{" "}
            {fmtUSD(summary?.buying_power ?? 0, { compact: true })}
          </span>
        }
      />

      <form
        onSubmit={onPreview}
        className="panel"
        data-testid="manual-trade-panel"
        style={{
          padding: 16,
          display: "grid",
          gridTemplateColumns: "repeat(12, 1fr)",
          gap: 12,
          alignItems: "end",
        }}
      >
        {/* side toggle */}
        <div style={{ gridColumn: "span 2" }}>
          <Label>Side</Label>
          <div style={{ display: "flex", gap: 6 }}>
            <SideButton
              active={side === "buy"}
              onClick={() => setSide("buy")}
              color={buyColor}
              data-testid="side-buy"
            >
              BUY
            </SideButton>
            <SideButton
              active={side === "sell"}
              onClick={() => setSide("sell")}
              color={sellColor}
              data-testid="side-sell"
            >
              SELL
            </SideButton>
          </div>
        </div>

        {/* symbol */}
        <div style={{ gridColumn: "span 2" }}>
          <Label>Symbol</Label>
          <input
            type="text"
            placeholder="AAPL"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            data-testid="symbol-input"
            autoComplete="off"
            spellCheck={false}
            style={inputStyle}
            maxLength={16}
          />
          {existing && (
            <div className="mono" style={{ fontSize: 9, color: "var(--ink-faint)", marginTop: 2 }}>
              held: {existing.qty.toFixed(2)} @ ${existing.avg_cost.toFixed(2)}
            </div>
          )}
        </div>

        {/* sizing */}
        <div style={{ gridColumn: "span 3" }}>
          <Label>
            Size{" "}
            <button
              type="button"
              onClick={() =>
                setSizingMode(sizingMode === "notional" ? "qty" : "notional")
              }
              data-testid="sizing-toggle"
              style={{
                fontSize: 9,
                color: "var(--cyan)",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                marginLeft: 6,
                textDecoration: "underline",
              }}
            >
              switch to {sizingMode === "notional" ? "shares" : "notional"}
            </button>
          </Label>
          {sizingMode === "notional" ? (
            <div style={{ position: "relative" }}>
              <span
                style={{
                  position: "absolute",
                  left: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--ink-faint)",
                  fontSize: 13,
                }}
              >
                $
              </span>
              <input
                type="number"
                min={0}
                step={1}
                value={notional}
                onChange={(e) => setNotional(e.target.value)}
                data-testid="notional-input"
                style={{ ...inputStyle, paddingLeft: 22 }}
              />
            </div>
          ) : (
            <input
              type="number"
              min={0}
              step={0.01}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              data-testid="qty-input"
              placeholder="shares"
              style={inputStyle}
            />
          )}
          {overFivePct && (
            <div className="mono" style={{ fontSize: 9, color: "var(--amber)", marginTop: 2 }}>
              ⚠ above 5% cap of equity
            </div>
          )}
        </div>

        {/* note */}
        <div style={{ gridColumn: "span 3" }}>
          <Label>Note (optional)</Label>
          <input
            type="text"
            placeholder="why are you doing this?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="note-input"
            maxLength={200}
            style={inputStyle}
          />
        </div>

        {/* preview button */}
        <div style={{ gridColumn: "span 2", display: "flex", flexDirection: "column", gap: 6 }}>
          <button
            type="submit"
            data-testid="preview-btn"
            disabled={!symU}
            style={{
              ...inputStyle,
              cursor: symU ? "pointer" : "not-allowed",
              // BUY → emerald → mint, SELL → rose → mint. Mint on the
              // bright corner gives both sides the same Cromaz lift.
              background: symU
                ? `linear-gradient(135deg, ${
                    side === "buy" ? buyColor : sellColor
                  } 0%, var(--mint) 100%)`
                : "rgba(180,200,210,0.04)",
              color: symU ? "#04150b" : "var(--ink-faint)",
              fontWeight: 800,
              border: "1px solid transparent",
              letterSpacing: "0.18em",
              textAlign: "center",
              fontSize: 11,
              boxShadow: symU
                ? `0 0 18px ${
                    side === "buy" ? "var(--emerald-glow)" : "var(--rose-glow)"
                  }`
                : "none",
            }}
            className="mono smallcaps"
          >
            PREVIEW {side.toUpperCase()}
          </button>
          <label
            className="mono"
            style={{
              fontSize: 9,
              color: "var(--ink-faint)",
              display: "flex",
              alignItems: "center",
              gap: 4,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={allowAfterHours}
              onChange={(e) => setAllowAfterHours(e.target.checked)}
              data-testid="ah-checkbox"
              style={{ margin: 0 }}
            />
            allow after-hours
          </label>
        </div>

        {errMsg && stage === "form" && (
          <div
            className="mono"
            style={{
              gridColumn: "span 12",
              color: "var(--rose)",
              fontSize: 12,
              padding: "6px 10px",
              border: "1px solid var(--rose)",
              borderRadius: 4,
              background: "rgba(255,80,80,0.06)",
            }}
            data-testid="form-error"
          >
            {errMsg}
          </div>
        )}
      </form>

      {/* preview modal */}
      {(stage === "preview" || stage === "submitting") && (
        <Modal onClose={() => setStage("form")}>
          <h3
            className="display"
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: side === "buy" ? buyColor : sellColor,
              marginTop: 0,
            }}
          >
            Confirm {side.toUpperCase()} {symU}
          </h3>
          <KV label="Symbol" value={symU} />
          <KV label="Side" value={side.toUpperCase()} />
          <KV
            label="Size"
            value={
              sizingMode === "notional"
                ? `${fmtUSD(Number(notional))} (notional)`
                : `${qty} shares`
            }
          />
          {note && <KV label="Note" value={note} />}
          {existing && (
            <KV
              label="Current position"
              value={`${existing.qty.toFixed(2)} @ $${existing.avg_cost.toFixed(2)} · mkt $${existing.market_price.toFixed(2)}`}
            />
          )}
          {overFivePct && (
            <div
              className="mono"
              style={{
                color: "var(--amber)",
                background: "rgba(245,158,11,0.08)",
                padding: 10,
                borderLeft: "3px solid var(--amber)",
                borderRadius: 2,
                margin: "12px 0",
                fontSize: 12,
              }}
            >
              ⚠ This is above the 5% per-position cap the LLM uses ({fmtUSD(fivePctCap, { compact: true })}).
              The manual endpoint doesn't enforce it — your override.
            </div>
          )}
          <div
            className="mono"
            style={{
              color: "var(--ink-faint)",
              fontSize: 10,
              marginTop: 8,
              padding: 8,
              border: "1px dashed var(--rule-hair)",
              borderRadius: 3,
            }}
          >
            Hits Alpaca paper. DRY_RUN respected. The trade will appear in
            the journal within ~10s after submit.
          </div>
          <div
            style={{
              display: "flex",
              gap: 10,
              justifyContent: "flex-end",
              marginTop: 18,
            }}
          >
            <button
              type="button"
              onClick={() => setStage("form")}
              data-testid="cancel-btn"
              disabled={stage === "submitting"}
              className="mono smallcaps"
              style={{ ...inputStyle, fontSize: 10, cursor: "pointer", padding: "8px 16px" }}
            >
              CANCEL
            </button>
            <button
              type="button"
              onClick={onConfirm}
              data-testid="confirm-btn"
              disabled={stage === "submitting"}
              className="mono smallcaps"
              style={{
                ...inputStyle,
                fontSize: 10,
                cursor: stage === "submitting" ? "wait" : "pointer",
                padding: "8px 22px",
                width: "auto",
                background: side === "buy" ? buyColor : sellColor,
                color: "#04150b",
                fontWeight: 800,
                letterSpacing: "0.2em",
                // Heavy emerald/rose glow — the design's signature for the
                // commit moment of a manual order.
                boxShadow: `0 0 18px ${
                  side === "buy" ? "var(--emerald-glow)" : "var(--rose-glow)"
                }`,
              }}
            >
              {stage === "submitting" ? "SUBMITTING…" : `CONFIRM ${side.toUpperCase()}`}
            </button>
          </div>
        </Modal>
      )}

      {stage === "success" && result && (
        <Modal onClose={reset}>
          <h3
            className="display"
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: result.dry_run ? "var(--amber)" : "var(--lime)",
              marginTop: 0,
            }}
          >
            {result.dry_run ? "Dry run recorded" : "Order submitted"}
          </h3>
          <KV label="Symbol" value={result.symbol} />
          <KV label="Side" value={result.side.toUpperCase()} />
          <KV label="Qty" value={result.qty.toFixed(4)} />
          <KV label="Est. price" value={fmtUSD(result.est_price)} />
          <KV label="Notional" value={fmtUSD(result.notional)} />
          <KV label="Order ID" value={result.order_id} />
          <KV label="Status" value={result.status} />
          {!result.market_was_open && (
            <div
              className="mono"
              style={{ color: "var(--amber)", fontSize: 11, marginTop: 8 }}
            >
              Market was closed — paper Alpaca will queue this for the next open.
            </div>
          )}
          {result.cancelled_open_opposite > 0 && (
            <div
              className="mono"
              style={{ color: "var(--ink-muted)", fontSize: 11, marginTop: 4 }}
            >
              Auto-cancelled {result.cancelled_open_opposite} opposite-side open order(s)
              before submit (wash-trade safety).
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
            <button
              type="button"
              onClick={reset}
              data-testid="success-close"
              className="mono smallcaps"
              style={{ ...inputStyle, fontSize: 10, cursor: "pointer", padding: "8px 20px" }}
            >
              DONE
            </button>
          </div>
        </Modal>
      )}

      {stage === "error" && (
        <Modal onClose={() => setStage("form")}>
          <h3 className="display" style={{ fontSize: 22, fontWeight: 700, color: "var(--rose)", marginTop: 0 }}>
            Rejected
          </h3>
          <pre
            data-testid="error-message"
            style={{
              whiteSpace: "pre-wrap",
              fontFamily: "var(--font-jetbrains), monospace",
              fontSize: 12,
              color: "var(--ink)",
              background: "rgba(255,80,80,0.06)",
              border: "1px solid var(--rose)",
              borderRadius: 4,
              padding: 10,
              margin: 0,
            }}
          >
            {errMsg}
          </pre>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
            <button
              type="button"
              onClick={() => setStage("form")}
              className="mono smallcaps"
              style={{ ...inputStyle, fontSize: 10, cursor: "pointer", padding: "8px 20px" }}
            >
              EDIT
            </button>
          </div>
        </Modal>
      )}
    </article>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--bg-1)",
  border: "1px solid var(--rule-hair)",
  color: "var(--ink)",
  borderRadius: 4,
  padding: "8px 10px",
  fontFamily: "var(--font-jetbrains), monospace",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono smallcaps"
      style={{
        fontSize: 9,
        letterSpacing: "0.25em",
        color: "var(--ink-faint)",
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 16,
        padding: "5px 0",
        borderBottom: "1px solid var(--rule-hair)",
        fontFamily: "var(--font-jetbrains), monospace",
        fontSize: 12,
      }}
    >
      <span style={{ color: "var(--ink-faint)", letterSpacing: "0.18em", textTransform: "uppercase", fontSize: 9 }}>
        {label}
      </span>
      <span style={{ color: "var(--ink)" }}>{value}</span>
    </div>
  );
}

function SideButton({
  active,
  onClick,
  color,
  children,
  ...rest
}: {
  active: boolean;
  onClick: () => void;
  color: string;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  // When active: full color background, dark text, glow box-shadow keyed off
  // emerald-glow / rose-glow so BUY pulses green and SELL pulses red.
  const glow =
    color === "var(--emerald)" ? "var(--emerald-glow)" : "var(--rose-glow)";
  return (
    <button
      type="button"
      onClick={onClick}
      className="mono smallcaps"
      style={{
        flex: 1,
        padding: "9px 0",
        background: active ? color : "rgba(180,200,210,0.04)",
        color: active ? "#04150b" : "var(--ink-muted)",
        border: `1px solid ${active ? color : "var(--panel-br)"}`,
        borderRadius: 4,
        fontWeight: 800,
        fontSize: 10,
        letterSpacing: "0.25em",
        cursor: "pointer",
        transition: "all 200ms",
        boxShadow: active ? `0 0 14px ${glow}` : "none",
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

function Modal({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  // Escape closes the modal — added in this design pass per the reference.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        backdropFilter: "blur(6px)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        animation: "rise 220ms cubic-bezier(0.2,0.7,0.2,1) both",
      }}
      data-testid="manual-trade-modal"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel rise"
        style={{
          width: "100%",
          maxWidth: 480,
          padding: 24,
          background: "rgba(10,13,17,0.96)",
          border: "1px solid var(--panel-br-strong)",
          boxShadow:
            "0 24px 80px rgba(0,0,0,0.8), 0 0 40px var(--emerald-glow)",
        }}
      >
        {children}
      </div>
    </div>
  );
}
