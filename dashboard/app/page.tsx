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
      {/* Row 1: Lede — explanatory paragraph + bot ribbon + equity chart */}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 28, marginTop: 24 }}>
        <article style={{ gridColumn: "span 12", minWidth: 0 }}>
          <SectionHead
            eyebrow="Portfolio v. S&P 500 — Thirty-Day View"
            title="Where the money stands"
            right={
              summary ? (
                <span>
                  Cash {fmtUSD(summary.cash, { compact: true })} · Invested{" "}
                  {fmtUSD(summary.invested, { compact: true })}
                </span>
              ) : null
            }
          />
          <p
            style={{
              fontSize: 15,
              lineHeight: 1.55,
              color: "var(--ink)",
              maxWidth: "72ch",
              marginTop: 0,
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-fraunces), Fraunces, serif",
                fontSize: "3.2em",
                lineHeight: 0.85,
                float: "left",
                padding: "0.05em 0.1em 0 0",
                fontWeight: 600,
                background:
                  "linear-gradient(135deg, var(--cyan), var(--violet))",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              T
            </span>
            he bot runs five scheduled routines per weekday — pre-market
            research at 07:00 ET, execute at market open, a midday risk scan,
            a close wrap-up, and a Friday post-mortem. Each is a Claude Opus
            tool-use loop that reads memory files, researches catalysts with
            web search + our scraped news DB, and places trades with a 10%
            trailing stop attached automatically. The dashed red line tracks
            the S&amp;P 500 indexed to the same starting equity so relative
            performance is visible at a glance.
          </p>
          <BotRibbon />
          <div style={{ marginTop: 20 }}>
            <EquityChart startEquity={baseEquity} />
          </div>
        </article>
      </section>

      {/* Row 1.5: Today's thesis from research_log.md */}
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
          <RecentTrades limit={6} />
          <div
            className="mono smallcaps"
            style={{
              fontSize: 9,
              letterSpacing: "0.25em",
              color: "var(--ink-faint)",
              marginTop: 12,
            }}
          >
            ▸ hover any row to expand reasoning
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
