"use client";

import { useQuery } from "@tanstack/react-query";
import { api, MarketRecap, RecapMover } from "@/lib/api";
import { fmtDate, fmtPct, fmtTimeAgo, fmtUSD } from "@/lib/format";
import { PnlLabel, SentimentDot } from "@/components/PnlLabel";

/**
 * The Closing Bell — CNBC-style daily market wrap. Index tape + VIX/regime,
 * session movers across the tracked universe (held names flagged), analyst
 * chatter from the news feed, and the bot's own end-of-day narrative from
 * the `close` routine.
 */
export function ClosingBell() {
  const { data, isLoading, isError } = useQuery<MarketRecap>({
    queryKey: ["marketRecap"],
    queryFn: api.marketRecap,
    refetchInterval: 300_000,
  });

  if (isLoading) {
    return (
      <div className="panel" style={{ padding: 26 }}>
        <div className="text-ink-faint italic text-[12px]">
          assembling the wrap…
        </div>
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="panel" style={{ padding: 26 }}>
        <div className="text-ink-faint italic text-[12px]">
          Not enough price history for a market wrap yet — the daily refresh
          job builds it after the close.
        </div>
      </div>
    );
  }

  const spy = data.indexes.find((i) => i.ticker === "SPY");
  const rest = data.indexes.filter((i) => i.ticker !== "SPY");
  const regimeColor =
    data.regime_label === "risk_on"
      ? "var(--gain)"
      : data.regime_label === "risk_off"
      ? "var(--loss)"
      : "var(--ink-muted)";

  return (
    <div className="panel" style={{ padding: "22px 26px 26px" }}>
      {/* ── Index tape ── */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 34,
          flexWrap: "wrap",
        }}
      >
        {spy && (
          <div>
            <div className="smallcaps mono text-[10px] tracking-[0.2em] text-ink-faint">
              S&amp;P 500 (SPY)
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <span className="display" style={{ fontSize: 34, lineHeight: 1.1 }}>
                {fmtUSD(spy.close)}
              </span>
              <PnlLabel value={spy.pct_1d} className="mono text-[16px] tabular-nums">
                {fmtPct(spy.pct_1d)}
              </PnlLabel>
            </div>
          </div>
        )}
        {rest.map((ix) => (
          <IndexChip
            key={ix.ticker}
            label={ix.ticker === "QQQ" ? "Nasdaq 100 (QQQ)" : ix.ticker}
            value={fmtUSD(ix.close)}
            delta={ix.pct_1d}
          />
        ))}
        {data.vix != null && (
          <IndexChip
            label="VIX"
            value={data.vix.toFixed(1)}
            delta={data.vix_5d_change}
            // vix_5d_change is in points, not a fraction
            deltaText={
              data.vix_5d_change != null
                ? `${data.vix_5d_change >= 0 ? "+" : "−"}${Math.abs(data.vix_5d_change).toFixed(1)} · 5d`
                : undefined
            }
            invert
          />
        )}
        {data.regime_label && (
          <div>
            <div className="smallcaps mono text-[10px] tracking-[0.2em] text-ink-faint">
              Regime
            </div>
            <div
              className="mono smallcaps text-[13px] tracking-[0.14em]"
              style={{ color: regimeColor }}
            >
              {data.regime_label.replace("_", " ")}
              {data.breadth_pct != null && (
                <span className="text-ink-faint">
                  {" "}
                  · breadth {Math.round(data.breadth_pct)}%
                </span>
              )}
            </div>
          </div>
        )}
        <div
          className="mono smallcaps text-[10px] tracking-[0.2em] text-ink-faint"
          style={{ marginLeft: "auto" }}
        >
          session of {fmtSessionDate(data.as_of)}
        </div>
      </div>

      {/* ── Movers · Analyst desk · Anchor desk ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 4fr) minmax(0, 4fr) minmax(0, 4fr)",
          gap: 28,
          marginTop: 24,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <DeskLabel>Session Movers</DeskLabel>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}
          >
            <MoverColumn title="Gainers" rows={data.gainers} />
            <MoverColumn title="Losers" rows={data.losers} />
          </div>
          {data.portfolio_movers.length > 0 && (
            <div className="mono text-[10.5px] text-ink-muted" style={{ marginTop: 12, lineHeight: 1.8 }}>
              <span className="smallcaps tracking-[0.18em] text-ink-faint">
                In the book:{" "}
              </span>
              {data.portfolio_movers.slice(0, 5).map((m, i) => (
                <span key={m.ticker}>
                  {i > 0 && " · "}
                  {m.ticker}{" "}
                  <PnlLabel value={m.pct_1d}>{fmtPct(m.pct_1d, 1)}</PnlLabel>
                </span>
              ))}
            </div>
          )}
        </div>

        <div style={{ minWidth: 0 }}>
          <DeskLabel>The Analyst Desk</DeskLabel>
          {data.analyst_buzz.length ? (
            <ul style={{ display: "grid", gap: 10 }}>
              {data.analyst_buzz.slice(0, 6).map((n) => (
                <li key={n.id} className="text-[11.5px]" style={{ lineHeight: 1.5 }}>
                  <SentimentDot label={n.sentiment_label} />
                  <a
                    href={n.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ textDecoration: "none" }}
                  >
                    {n.title}
                  </a>
                  <span className="mono text-[9.5px] text-ink-faint">
                    {" "}
                    — {n.source} · {fmtTimeAgo(n.published_at)}
                    {n.tickers.length > 0 && ` · ${n.tickers.slice(0, 3).join(" ")}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-ink-faint italic text-[12px]">
              No analyst chatter picked up in the last 48h.
            </div>
          )}
        </div>

        <div style={{ minWidth: 0 }}>
          <DeskLabel>Anchor Desk — the bot&apos;s wrap</DeskLabel>
          {data.close_note?.summary ? (
            <>
              <p
                className="text-[12px]"
                style={{ lineHeight: 1.7, whiteSpace: "pre-line" }}
              >
                {data.close_note.summary}
              </p>
              <div className="mono smallcaps text-[9.5px] tracking-[0.18em] text-ink-faint" style={{ marginTop: 10 }}>
                close routine · {fmtDate(data.close_note.started_at)} ·{" "}
                {data.close_note.status}
              </div>
            </>
          ) : (
            <div className="text-ink-faint italic text-[12px]">
              The close routine hasn&apos;t filed its wrap yet — it runs
              weekdays at 4:00 PM ET.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Daily bars are stamped 04:00 UTC (midnight ET) — format in UTC so the
 *  session doesn't display as the previous day in US timezones. */
function fmtSessionDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function DeskLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="smallcaps mono text-[10px] tracking-[0.2em] text-ink-faint rule-bot"
      style={{ paddingBottom: 6, marginBottom: 12 }}
    >
      {children}
    </div>
  );
}

function IndexChip({
  label,
  value,
  delta,
  deltaText,
  invert = false,
}: {
  label: string;
  value: string;
  delta: number | null | undefined;
  /** Preformatted delta label; defaults to percent formatting of `delta`. */
  deltaText?: string;
  /** For VIX: a rising value is bearish, color it as a loss. */
  invert?: boolean;
}) {
  return (
    <div>
      <div className="smallcaps mono text-[10px] tracking-[0.2em] text-ink-faint">
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="mono tabular-nums" style={{ fontSize: 18 }}>
          {value}
        </span>
        {delta != null && (
          <PnlLabel
            value={invert ? -delta : delta}
            className="mono text-[11px] tabular-nums"
          >
            {deltaText ?? fmtPct(delta, 1)}
          </PnlLabel>
        )}
      </div>
    </div>
  );
}

function MoverColumn({ title, rows }: { title: string; rows: RecapMover[] }) {
  return (
    <div>
      <div className="smallcaps mono text-[9px] tracking-[0.18em] text-ink-faint">
        {title}
      </div>
      <ul className="mono text-[11.5px] tabular-nums" style={{ marginTop: 6, display: "grid", gap: 4 }}>
        {rows.map((m) => (
          <li
            key={m.ticker}
            style={{ display: "flex", justifyContent: "space-between", gap: 10 }}
          >
            <span>
              {m.ticker}
              {m.held && (
                <span
                  title="in the book"
                  style={{
                    display: "inline-block",
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: "var(--emerald)",
                    marginLeft: 6,
                    verticalAlign: "middle",
                  }}
                />
              )}
            </span>
            <PnlLabel value={m.pct_1d}>{fmtPct(m.pct_1d, 1)}</PnlLabel>
          </li>
        ))}
      </ul>
    </div>
  );
}
