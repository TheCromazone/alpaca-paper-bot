"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, PortfolioSummary } from "@/lib/api";
import { fmtPct, fmtUSD } from "@/lib/format";
import { PnlLabel, LiveDot } from "./PnlLabel";

/** Count-up from zero using a persistent t0. Tolerates parent re-renders. */
function useCountUpFromZero(target: number, duration = 1400) {
  const t0 = useRef<number | null>(null);
  const [, force] = useState(0);
  if (t0.current == null) t0.current =
    typeof performance !== "undefined" ? performance.now() : 0;
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

function useClock(tickMs = 1000) {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return now;
}

export function Masthead() {
  const { data } = useQuery<PortfolioSummary>({
    queryKey: ["summary"],
    queryFn: api.summary,
  });

  const equity = data?.equity ?? 0;
  const pnl = data?.unrealized_pnl ?? 0;
  const pct = equity > 0 ? pnl / (equity - pnl) : 0;

  const now = useClock(1000);
  const eqAnim = useCountUpFromZero(equity, 1400);
  const pnlAnim = useCountUpFromZero(pnl, 1400);

  const dateStr = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // Rough ET market-open check (local clock may be anywhere; this is a friendly
  // indicator, not authoritative — the bot's scheduler is what actually gates orders).
  const mins = now.getHours() * 60 + now.getMinutes();
  const isOpen =
    now.getDay() >= 1 &&
    now.getDay() <= 5 &&
    mins >= 9 * 60 + 30 &&
    mins < 16 * 60;

  return (
    <header className="panel" style={{ padding: "22px 26px 16px", marginBottom: 20 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 24,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 20 }}>
          <div
            className="display"
            style={{
              fontSize: "clamp(44px, 6.5vw, 84px)",
              fontWeight: 700,
              fontStyle: "italic",
              lineHeight: 0.85,
              background:
                "linear-gradient(135deg, #ffffff 0%, var(--cyan) 60%, var(--violet) 100%)",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            The&nbsp;Ledger
          </div>
          <div
            className="mono smallcaps"
            style={{
              fontSize: 10,
              color: "var(--ink-muted)",
              paddingBottom: 8,
            }}
          >
            v2.0 &middot; {dateStr}
          </div>
        </div>

        <div className="rise" style={{ textAlign: "right", animationDelay: "80ms" }}>
          <div
            className="mono smallcaps"
            style={{ fontSize: 10, letterSpacing: "0.25em", color: "var(--ink-muted)" }}
          >
            Account Equity
          </div>
          <div
            className="display mono tabular-nums"
            style={{
              fontSize: "clamp(32px, 4vw, 54px)",
              lineHeight: 1,
              fontWeight: 600,
              color: "var(--ink)",
              textShadow: "0 0 30px rgba(120,180,255,0.2)",
            }}
          >
            {fmtUSD(eqAnim)}
          </div>
          <div className="mono" style={{ fontSize: 12, marginTop: 4 }}>
            Unrealized&nbsp;
            <PnlLabel value={pnl}>{fmtUSD(pnlAnim, { sign: true })}</PnlLabel>
            <span style={{ color: "var(--ink-faint)" }}>&nbsp;·&nbsp;</span>
            <PnlLabel value={pnl}>{fmtPct(pct)}</PnlLabel>
          </div>
        </div>
      </div>

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
          <LiveDot on={isOpen} color={isOpen ? "var(--loss)" : "var(--ink-faint)"} />
          <span
            style={{
              color: isOpen ? "var(--rose)" : "var(--ink-muted)",
              fontWeight: 700,
            }}
          >
            {isOpen ? "Market Open" : "After Hours"}
          </span>
          <span>&middot;</span>
          <span className="tabular-nums" style={{ color: "var(--ink)" }}>
            {timeStr} ET
          </span>
          <span>&middot;</span>
          <span>Paper Account</span>
        </span>
        {data && (
          <span>
            {data.position_count} positions &middot; {fmtUSD(data.cash, { compact: true })} cash &middot;{" "}
            {fmtUSD(data.buying_power, { compact: true })} BP
          </span>
        )}
      </div>
    </header>
  );
}
