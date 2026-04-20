"use client";

import { useQuery } from "@tanstack/react-query";
import { api, TradeRow } from "@/lib/api";
import { fmtUSD, fmtTimeAgo } from "@/lib/format";

function DetailStat({
  label,
  value,
  sign,
}: {
  label: string;
  value: string;
  sign: number;
}) {
  const color =
    sign > 0 ? "var(--gain)" : sign < 0 ? "var(--loss)" : "var(--ink)";
  const glow =
    sign > 0 ? "var(--gain-glow)" : sign < 0 ? "var(--loss-glow)" : "transparent";
  return (
    <div>
      <div
        className="mono smallcaps"
        style={{ fontSize: 9, letterSpacing: "0.25em", color: "var(--ink-faint)" }}
      >
        {label}
      </div>
      <div
        className="display tabular-nums"
        style={{
          fontSize: 16,
          fontWeight: 600,
          color,
          marginTop: 3,
          textShadow: `0 0 8px ${glow}`,
        }}
      >
        {value}
      </div>
    </div>
  );
}

export function RecentTrades({ limit = 6 }: { limit?: number }) {
  const { data } = useQuery<TradeRow[]>({
    queryKey: ["trades", limit],
    queryFn: () => api.trades(limit),
  });
  const trades = data ?? [];

  if (!trades.length) {
    return (
      <p
        style={{
          color: "var(--ink-faint)",
          fontStyle: "italic",
          fontSize: 13,
          padding: "12px 0",
        }}
      >
        No trades yet — the bot runs during market hours.
      </p>
    );
  }

  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {trades.map((t, idx) => {
        const breakdown = (t.score_breakdown || {}) as Record<string, Record<string, number>>;
        const newsV =
          typeof breakdown.news?.avg_vader === "number"
            ? breakdown.news.avg_vader
            : 0;
        const polNet =
          typeof breakdown.politician?.net_usd === "number"
            ? breakdown.politician.net_usd
            : 0;
        const invNet =
          typeof breakdown.investor?.net_usd === "number"
            ? breakdown.investor.net_usd
            : 0;

        return (
          <li
            key={t.id}
            className="trade-row rule-hair rise"
            style={{
              padding: "12px 10px",
              animationDelay: `${idx * 60}ms`,
              marginLeft: -10,
              marginRight: -10,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <span className={"chip " + t.side}>{t.side.toUpperCase()}</span>
                <span
                  className="display"
                  style={{ fontSize: 22, fontWeight: 600, color: "var(--ink)" }}
                >
                  {t.ticker}
                </span>
                <span className="mono" style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                  {t.qty.toFixed(2)} @ {fmtUSD(t.price)} &middot; {fmtUSD(t.notional, { compact: true })}
                </span>
                {t.dry_run && (
                  <span
                    className="mono smallcaps"
                    style={{
                      fontSize: 9,
                      letterSpacing: "0.2em",
                      color: "var(--amber)",
                      padding: "1px 6px",
                      border: "1px solid var(--amber)",
                      borderRadius: 3,
                    }}
                  >
                    dry run
                  </span>
                )}
              </div>
              <span
                className="mono smallcaps"
                style={{
                  fontSize: 10,
                  letterSpacing: "0.2em",
                  color: "var(--ink-faint)",
                }}
              >
                {fmtTimeAgo(t.submitted_at)}
              </span>
            </div>
            {t.reason && (
              <p
                style={{
                  margin: "6px 0 0",
                  fontSize: 13,
                  color: "var(--ink-muted)",
                  lineHeight: 1.5,
                }}
              >
                {t.reason}
              </p>
            )}
            <div className="detail">
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 12,
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: "1px solid var(--rule-hair)",
                }}
              >
                <DetailStat
                  label="Composite"
                  value={t.composite_score != null ? t.composite_score.toFixed(2) : "—"}
                  sign={t.composite_score ?? 0}
                />
                <DetailStat
                  label="News sentiment"
                  value={newsV !== 0 ? (newsV >= 0 ? "+" : "−") + Math.abs(newsV).toFixed(2) : "—"}
                  sign={newsV}
                />
                <DetailStat
                  label="Insider Δ"
                  value={
                    polNet + invNet !== 0
                      ? fmtUSD(polNet + invNet, { compact: true, sign: true })
                      : "—"
                  }
                  sign={polNet + invNet}
                />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
