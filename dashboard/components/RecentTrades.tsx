"use client";

import { useState } from "react";
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

type Filter = "all" | "buy" | "sell";

export function RecentTrades({ limit = 6 }: { limit?: number }) {
  // Always pull a slightly larger window from the API than we render so that
  // toggling to "sells only" actually surfaces sells when the most recent N
  // are all buys (typical state — buys outnumber sells ~3:1 on swing).
  const fetchLimit = Math.max(limit, 30);
  const { data } = useQuery<TradeRow[]>({
    queryKey: ["trades", fetchLimit],
    queryFn: () => api.trades(fetchLimit),
    // Trades land in the DB the moment a routine fires — short interval so
    // you see new orders within seconds rather than minutes.
    refetchInterval: 10_000,
  });
  const all = data ?? [];
  const [filter, setFilter] = useState<Filter>("all");
  const buyCount = all.filter((t) => t.side === "buy").length;
  const sellCount = all.filter((t) => t.side === "sell").length;
  const filtered = filter === "all" ? all : all.filter((t) => t.side === filter);
  const trades = filtered.slice(0, limit);

  if (!trades.length) {
    return (
      <p
        style={{
          color: "var(--ink-muted)",
          fontStyle: "italic",
          fontSize: 13.5,
          lineHeight: 1.55,
          padding: "12px 0",
          maxWidth: "60ch",
        }}
      >
        No trades yet today. The execute routine fires at 09:30 ET — buy
        orders land here with their thesis, and any trailing-stop sells from
        Alpaca will appear with a <span style={{ color: "var(--mint)" }}>trailing stop</span> tag.
      </p>
    );
  }

  return (
    <>
      <FilterBar
        filter={filter}
        setFilter={setFilter}
        buyCount={buyCount}
        sellCount={sellCount}
      />
      {trades.length === 0 && filter === "sell" && (
        <p
          style={{
            color: "var(--ink-muted)",
            fontStyle: "italic",
            fontSize: 13,
            padding: "8px 0",
          }}
        >
          No sells in the last 30 days. Trailing-stop fills from Alpaca will
          land here automatically.
        </p>
      )}
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
              padding: "14px 10px",
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
                <span
                  className={"chip " + t.side}
                  style={{
                    fontSize: 11,
                    letterSpacing: "0.18em",
                    fontWeight: 700,
                    padding: "3px 9px",
                  }}
                >
                  {t.side === "buy" ? "▲ BUY" : "▼ SELL"}
                </span>
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
                {t.source === "alpaca_fill" && (
                  <span
                    className="mono smallcaps"
                    title="Filled on Alpaca outside the LLM bot — usually a trailing-stop sell."
                    style={{
                      fontSize: 9,
                      letterSpacing: "0.2em",
                      color: "var(--mint)",
                      padding: "1px 6px",
                      border: "1px solid var(--mint)",
                      borderRadius: 3,
                    }}
                  >
                    {t.order_type === "trailing_stop"
                      ? "trailing stop"
                      : "alpaca"}
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
                  margin: "8px 0 0",
                  fontSize: 13.5,
                  color: "var(--ink-muted)",
                  lineHeight: 1.55,
                  fontFamily: "var(--font-inter), Inter, sans-serif",
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
    </>
  );
}

function FilterBar({
  filter,
  setFilter,
  buyCount,
  sellCount,
}: {
  filter: Filter;
  setFilter: (f: Filter) => void;
  buyCount: number;
  sellCount: number;
}) {
  const totalCount = buyCount + sellCount;
  const Btn = ({
    val,
    label,
    count,
    accent,
  }: {
    val: Filter;
    label: string;
    count: number;
    accent: string;
  }) => {
    const active = filter === val;
    return (
      <button
        type="button"
        onClick={() => setFilter(val)}
        className="mono smallcaps"
        style={{
          fontSize: 10,
          letterSpacing: "0.18em",
          padding: "4px 10px",
          borderRadius: 3,
          border: `1px solid ${active ? accent : "var(--rule-hair)"}`,
          background: active ? `${accent}1A` : "transparent",
          color: active ? accent : "var(--ink-muted)",
          cursor: "pointer",
          fontWeight: 600,
          transition: "all 120ms ease",
          boxShadow: active ? `0 0 8px ${accent}40` : "none",
        }}
      >
        {label}
        <span
          style={{
            marginLeft: 6,
            color: active ? accent : "var(--ink-faint)",
            fontWeight: 700,
          }}
        >
          {count}
        </span>
      </button>
    );
  };
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        marginBottom: 10,
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      <Btn val="all" label="ALL" count={totalCount} accent="var(--ink)" />
      <Btn val="buy" label="▲ BUYS" count={buyCount} accent="var(--emerald)" />
      <Btn val="sell" label="▼ SELLS" count={sellCount} accent="var(--rose)" />
    </div>
  );
}
