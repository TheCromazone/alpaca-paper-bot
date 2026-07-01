"use client";

import { useQuery } from "@tanstack/react-query";
import { api, PerformanceSummary } from "@/lib/api";
import { fmtUSD } from "@/lib/format";

/**
 * The scorecard — the one question the whole bot exists to answer: is it
 * beating the S&P 500? Headline is alpha (bot return − SPY return, in points)
 * since inception, flanked by the realized-trade record (hit rate, profit
 * factor, realized P&L). Read-only; backed by /performance/summary.
 *
 * The bot runs a let-winners-run profile, so a sub-50% hit rate paired with a
 * profit factor > 1 is the expected, healthy shape — we surface both so the
 * win rate isn't read in isolation.
 */
function Stat({
  label,
  value,
  sign,
  sub,
}: {
  label: string;
  value: string;
  sign?: number;
  sub?: string;
}) {
  const color =
    sign === undefined
      ? "var(--ink)"
      : sign > 0
      ? "var(--gain, var(--lime))"
      : sign < 0
      ? "var(--loss, var(--rose))"
      : "var(--ink)";
  return (
    <div className="stat-card" style={{ minWidth: 0 }}>
      <div
        className="mono smallcaps"
        style={{
          fontSize: 9,
          letterSpacing: "0.25em",
          color: "var(--ink-faint)",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        className="display mono tabular-nums"
        style={{ fontSize: 22, fontWeight: 600, color }}
      >
        {value}
      </div>
      {sub && (
        <div
          className="mono"
          style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 6, lineHeight: 1.5 }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

function pct(v: number | null | undefined, signed = true): string {
  if (v == null) return "—";
  return `${signed && v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function PerformanceScorecard() {
  const { data } = useQuery<PerformanceSummary>({
    queryKey: ["performance"],
    queryFn: api.performance,
    refetchInterval: 60_000,
  });

  const b = data?.benchmark;
  const r = data?.realized;
  const alpha = b?.alpha_pct ?? null;
  const beating = alpha != null && alpha > 0;

  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 16,
        }}
      >
        <Stat
          label={beating ? "Alpha vs S&P — beating" : "Alpha vs S&P 500"}
          value={alpha == null ? "—" : `${alpha > 0 ? "+" : ""}${alpha.toFixed(2)} pts`}
          sign={alpha ?? 0}
          sub={
            b?.inception_at
              ? `since ${new Date(b.inception_at).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  timeZone: "UTC",
                })}`
              : "since inception"
          }
        />
        <Stat
          label="Bot return"
          value={pct(b?.bot_return_pct)}
          sign={b?.bot_return_pct ?? 0}
        />
        <Stat
          label="S&P 500 return"
          value={pct(b?.spy_return_pct)}
          sign={b?.spy_return_pct ?? 0}
        />
        <Stat
          label="Hit rate"
          value={r ? `${r.hit_rate_pct.toFixed(1)}%` : "—"}
          sub={r ? `${r.wins}W / ${r.losses}L · ${r.closed_lots} lots` : undefined}
        />
        <Stat
          label="Profit factor"
          value={r?.profit_factor != null ? r.profit_factor.toFixed(2) : "—"}
          sign={r?.profit_factor != null ? r.profit_factor - 1 : 0}
          sub={
            r
              ? `avg win ${fmtUSD(r.avg_win, { compact: true })} · loss ${fmtUSD(
                  r.avg_loss,
                  { compact: true }
                )}`
              : undefined
          }
        />
        <Stat
          label="Realized P&L"
          value={r ? fmtUSD(r.realized_pnl, { sign: true, compact: true }) : "—"}
          sign={r?.realized_pnl ?? 0}
        />
      </div>

      {r?.best_trade && r?.worst_trade && (
        <div
          className="mono smallcaps"
          style={{
            fontSize: 9.5,
            letterSpacing: "0.18em",
            color: "var(--ink-faint)",
            marginTop: 14,
            lineHeight: 1.7,
          }}
        >
          ▲ best{" "}
          <span style={{ color: "var(--gain, var(--lime))" }}>
            {r.best_trade.ticker} {fmtUSD(r.best_trade.pnl, { sign: true, compact: true })} (
            {pct(r.best_trade.pnl_pct)})
          </span>
          {"  ·  "}
          ▼ worst{" "}
          <span style={{ color: "var(--loss, var(--rose))" }}>
            {r.worst_trade.ticker} {fmtUSD(r.worst_trade.pnl, { sign: true, compact: true })} (
            {pct(r.worst_trade.pnl_pct)})
          </span>
        </div>
      )}
    </div>
  );
}
