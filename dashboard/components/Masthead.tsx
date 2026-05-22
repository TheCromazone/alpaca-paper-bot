"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, PortfolioSummary } from "@/lib/api";
import { fmtPct, fmtUSD } from "@/lib/format";
import { PnlLabel, LiveDot } from "./PnlLabel";

/**
 * Cromaz masthead.
 *
 * Left: large circular logo (rotating emerald conic-gradient halo + breathing
 * outer ring, all CSS) with the chrome-shimmered CROMAZ wordmark and the
 * "Trading Bot Investments · Invest Smart. Grow Strong." tagline.
 * Right: account equity (counts up on mount), unrealized P/L, market-open
 * indicator, refresh button, and "live · Ns ago" freshness counter.
 *
 * The refresh button calls `queryClient.invalidateQueries()` and spins as
 * long as `useIsFetching()` returns > 0 — visible proof that the dashboard
 * is fetching new data on demand.
 */

/** Count-up from zero using a persistent t0. Tolerates parent re-renders. */
function useCountUpFromZero(target: number, duration = 1600) {
  const t0 = useRef<number | null>(null);
  const [, force] = useState(0);
  if (t0.current == null)
    t0.current = typeof performance !== "undefined" ? performance.now() : 0;
  useEffect(() => {
    let raf: number;
    const loop = () => {
      force((x) => x + 1);
      const p = (performance.now() - (t0.current ?? 0)) / duration;
      if (p < 1) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [duration]);
  if (!Number.isFinite(target)) return 0;
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  const p = Math.min(1, (now - (t0.current ?? 0)) / duration);
  const eased = 1 - Math.pow(1 - p, 3);
  return target * eased;
}

/** Clock that returns null on SSR so server + client first-paint match. */
function useClock(tickMs = 1000): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return now;
}

export function Masthead() {
  const { data, dataUpdatedAt } = useQuery<PortfolioSummary>({
    queryKey: ["summary"],
    queryFn: api.summary,
    refetchInterval: 10_000,
  });

  const qc = useQueryClient();
  const inFlight = useIsFetching();
  const refreshing = inFlight > 0;
  const onRefresh = () => {
    void qc.invalidateQueries();
  };

  const equity = data?.equity ?? 0;
  const pnl = data?.unrealized_pnl ?? 0;
  const pct = equity > 0 ? pnl / (equity - pnl) : 0;

  const now = useClock(1000);
  const eqAnim = useCountUpFromZero(equity, 1600);
  const pnlAnim = useCountUpFromZero(pnl, 1600);

  const dateStr = now
    ? new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(now)
    : "—";
  const timeStr = now
    ? now.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    : "--:--:--";

  const mins = now ? now.getHours() * 60 + now.getMinutes() : 0;
  const isOpen =
    !!now &&
    now.getDay() >= 1 &&
    now.getDay() <= 5 &&
    mins >= 9 * 60 + 30 &&
    mins < 16 * 60;

  const ageSec =
    dataUpdatedAt && now
      ? Math.max(0, Math.floor((now.getTime() - dataUpdatedAt) / 1000))
      : null;

  return (
    <header className="panel" style={{ padding: "28px 30px 18px", marginBottom: 20 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 28,
          flexWrap: "wrap",
        }}
      >
        {/* Left: logo + wordmark + tagline */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 24,
            minWidth: 0,
          }}
        >
          <div className="cromaz-logo">
            <Image
              src="/cromaz-logo.png"
              alt="Cromaz logo"
              width={156}
              height={156}
              priority
              unoptimized
            />
          </div>
          <div style={{ minWidth: 0 }}>
            <div
              className="display chrome-text"
              style={{
                fontSize: "clamp(28px, 3.6vw, 48px)",
                lineHeight: 1,
                fontWeight: 700,
              }}
            >
              CROMAZ
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginTop: 6,
                flexWrap: "wrap",
              }}
            >
              <span
                className="mono smallcaps"
                style={{
                  fontSize: 10,
                  letterSpacing: "0.32em",
                  color: "var(--emerald)",
                  textShadow: "0 0 10px var(--emerald-glow)",
                }}
              >
                Trading Bot Investments
              </span>
              <span style={{ color: "var(--ink-faint)" }}>·</span>
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  color: "var(--ink-faint)",
                  fontStyle: "italic",
                }}
              >
                Invest Smart. Grow Strong.
              </span>
            </div>
          </div>
        </div>

        {/* Right: equity + P/L */}
        <div
          className="rise"
          style={{ textAlign: "right", animationDelay: "80ms" }}
        >
          <div
            className="mono smallcaps"
            style={{
              fontSize: 10,
              letterSpacing: "0.25em",
              color: "var(--ink-muted)",
            }}
          >
            Account Equity
          </div>
          <div
            className="display-num tabular-nums"
            style={{
              fontSize: "clamp(32px, 4vw, 56px)",
              lineHeight: 1,
              color: "var(--ink)",
              textShadow: "0 0 30px rgba(0, 230, 130, 0.25)",
            }}
          >
            {fmtUSD(eqAnim)}
          </div>
          <div className="mono" style={{ fontSize: 12, marginTop: 5 }}>
            Unrealized&nbsp;
            <PnlLabel value={pnl}>{fmtUSD(pnlAnim, { sign: true })}</PnlLabel>
            <span style={{ color: "var(--ink-faint)" }}>&nbsp;·&nbsp;</span>
            <PnlLabel value={pnl}>{fmtPct(pct)}</PnlLabel>
          </div>
        </div>
      </div>

      {/* Status row: market state, position summary, refresh button */}
      <div
        className="mono smallcaps rule-top"
        style={{
          fontSize: 10,
          letterSpacing: "0.25em",
          color: "var(--ink-faint)",
          marginTop: 14,
          paddingTop: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <LiveDot
            on={isOpen}
            color={isOpen ? "var(--emerald)" : "var(--ink-faint)"}
          />
          <span
            style={{
              color: isOpen ? "var(--emerald)" : "var(--ink-muted)",
              fontWeight: 700,
              textShadow: isOpen ? "0 0 10px var(--emerald-glow)" : "none",
            }}
          >
            {isOpen ? "Market Open" : "After Hours"}
          </span>
          <span>·</span>
          <span className="tabular-nums" style={{ color: "var(--ink)" }}>
            {timeStr} ET
          </span>
          <span className="hide-sm">·</span>
          <span className="hide-sm">Paper Account · {dateStr}</span>
        </span>

        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          {data && (
            <span className="hide-sm">
              {data.position_count} positions · {fmtUSD(data.cash, { compact: true })} cash · {fmtUSD(data.buying_power, { compact: true })} BP
            </span>
          )}
          <span
            title={
              dataUpdatedAt
                ? `Last fetch ${new Date(dataUpdatedAt).toLocaleTimeString()}`
                : "Waiting for first fetch"
            }
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <LiveDot
              on={!refreshing && ageSec != null && ageSec < 30}
              color={refreshing ? "var(--mint)" : "var(--emerald)"}
            />
            <span
              className="tabular-nums"
              style={{
                color: refreshing
                  ? "var(--mint)"
                  : ageSec != null && ageSec > 60
                  ? "var(--rose)"
                  : "var(--ink-muted)",
              }}
            >
              {refreshing
                ? "refreshing…"
                : ageSec != null
                ? `live · ${ageSec}s ago`
                : "—"}
            </span>
          </span>
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh dashboard"
            className="mono smallcaps"
            style={{
              fontSize: 10,
              letterSpacing: "0.25em",
              color: "var(--ink)",
              background: "rgba(10,12,16,0.7)",
              border: "1px solid var(--rule-hair)",
              borderRadius: 4,
              padding: "5px 10px",
              cursor: refreshing ? "wait" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              transition: "border-color 200ms, box-shadow 200ms",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--emerald)";
              e.currentTarget.style.boxShadow = "0 0 14px rgba(0,230,130,0.18)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--rule-hair)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                animation: refreshing ? "spin 0.9s linear infinite" : "none",
                fontSize: 12,
                lineHeight: 1,
              }}
            >
              ⟳
            </span>
            Refresh
          </button>
        </span>
      </div>
    </header>
  );
}
