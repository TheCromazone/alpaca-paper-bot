"use client";

import { useQuery } from "@tanstack/react-query";
import { api, PositionRow, PortfolioSummary } from "@/lib/api";
import { fmtUSD } from "@/lib/format";
import { EquityChart } from "@/components/EquityChart";
import { SectorDonut } from "@/components/SectorDonut";
import { RecentTrades } from "@/components/RecentTrades";
import { LatestHeadlines } from "@/components/LatestHeadlines";
import { SectionHead } from "@/components/SectionHead";
import { BotRibbon } from "@/components/BotRibbon";
import { Leaderboard } from "@/components/Leaderboard";
import { InsiderDesk } from "@/components/InsiderDesk";
import { ThesisPanel } from "@/components/ThesisPanel";
import { EarningsThisWeek } from "@/components/EarningsThisWeek";
import { ManualTradePanel } from "@/components/ManualTradePanel";

export default function Home() {
  const { data: summary } = useQuery<PortfolioSummary>({
    queryKey: ["summary"],
    queryFn: api.summary,
  });
  const { data: positions } = useQuery<PositionRow[]>({
    queryKey: ["positions"],
    queryFn: api.positions,
  });

  const leaders = [...(positions ?? [])]
    .sort((a, b) => b.unrealized_pct - a.unrealized_pct)
    .slice(0, 4);
  const laggards = [...(positions ?? [])]
    .sort((a, b) => a.unrealized_pct - b.unrealized_pct)
    .slice(0, 4);

  const baseEquity = summary?.equity ?? 100_000;

  return (
    <div>
      {/* Row 1: Performance Overview — masthead → bot ribbon → tall equity chart.
          Per the Cromaz design: NO lede paragraph, just the title + ribbon +
          chart. The chart breathes at 560px so it's the page's centerpiece. */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(12, 1fr)",
          gap: 28,
          marginTop: 24,
        }}
      >
        <article style={{ gridColumn: "span 12", minWidth: 0 }}>
          <SectionHead
            eyebrow="Portfolio v. S&P 500 — 30 Day"
            title="Performance Overview"
            right={
              summary ? (
                <span>
                  Cash {fmtUSD(summary.cash, { compact: true })} · Invested{" "}
                  {fmtUSD(summary.invested, { compact: true })}
                </span>
              ) : null
            }
          />
          <BotRibbon />
          <div style={{ marginTop: 8 }}>
            <EquityChart startEquity={baseEquity} />
          </div>
        </article>
      </section>

      {/* Row 2: Today's thesis from research_log.md — comes FIRST per the
          design (Thesis → Manual → Earnings), so the morning's plan is the
          first thing you scroll into after the chart. */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(12, 1fr)",
          gap: 28,
          marginTop: 44,
        }}
        className="rule-top"
      >
        <div style={{ gridColumn: "span 12", paddingTop: 24 }}>
          <ThesisPanel />
        </div>
      </section>

      {/* Row 3: Manual trade — user-driven escape hatch around the LLM */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(12, 1fr)",
          gap: 28,
          marginTop: 44,
        }}
        className="rule-top"
      >
        <div style={{ gridColumn: "span 12", paddingTop: 24 }}>
          <ManualTradePanel />
        </div>
      </section>

      {/* Row 1.7: Earnings calendar — held positions highlighted */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(12, 1fr)",
          gap: 28,
          marginTop: 44,
        }}
        className="rule-top"
      >
        <div style={{ gridColumn: "span 12", paddingTop: 24 }}>
          <EarningsThisWeek />
        </div>
      </section>

      {/* Row 2: Sector donut + gainers/draggers */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(12, 1fr)",
          gap: 28,
          marginTop: 44,
        }}
        className="rule-top"
      >
        <div
          style={{
            gridColumn: "span 12",
            paddingTop: 24,
            display: "grid",
            gridTemplateColumns: "repeat(12, 1fr)",
            gap: 28,
          }}
        >
          <aside style={{ gridColumn: "span 4", minWidth: 0 }}>
            <SectionHead eyebrow="Exposure" title="Sector weights" />
            <SectorDonut />
          </aside>

          <div style={{ gridColumn: "span 8", minWidth: 0 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28 }}>
              <div>
                <SectionHead
                  eyebrow="Gainers"
                  title="Top of the book"
                  right={<span>best 4</span>}
                />
                <Leaderboard rows={leaders} />
              </div>
              <div>
                <SectionHead
                  eyebrow="Draggers"
                  title="Under the stop"
                  right={<span>worst 4</span>}
                />
                <Leaderboard rows={laggards} />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Row 3: Trades + Headlines + Insider */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(12, 1fr)",
          gap: 28,
          marginTop: 44,
        }}
        className="rule-top"
      >
        <article style={{ gridColumn: "span 6", minWidth: 0, paddingTop: 24 }}>
          <SectionHead
            eyebrow="From the trade journal"
            title="Today's orders"
            right={
              <a href="/trades" style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>
                see all
              </a>
            }
          />
          <RecentTrades limit={15} />
          <div
            className="mono smallcaps"
            style={{
              fontSize: 9.5,
              letterSpacing: "0.22em",
              color: "var(--ink-faint)",
              marginTop: 14,
              lineHeight: 1.6,
            }}
          >
            ▸ hover any row for the full thesis &middot; composite &middot;
            insider Δ
          </div>
        </article>
        <aside style={{ gridColumn: "span 4", minWidth: 0, paddingTop: 24 }}>
          <SectionHead
            eyebrow="The Market Wire"
            title="Latest headlines"
            right={
              <a href="/news" style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>
                full feed
              </a>
            }
          />
          <LatestHeadlines limit={7} />
        </aside>
        <aside style={{ gridColumn: "span 2", minWidth: 0, paddingTop: 24 }}>
          <SectionHead eyebrow="Insider Desk" title="Flow" />
          <InsiderDesk limit={10} />
        </aside>
      </section>
    </div>
  );
}
