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
import { PerformanceScorecard } from "@/components/PerformanceScorecard";
import { RoutineReel } from "@/components/RoutineReel";
import { Reveal } from "@/components/Reveal";

/**
 * Overview — staged as five acts (design/storyboard.md).
 *
 * ACT 01  The Stage    — ops HUD + equity curve + verdict rail fused into one
 *                        full-bleed instrument. The page's signature shot.
 * ACT 02  The Machine  — the Routine Reel: LLM runs as film frames.
 * ACT 03  The Playbook — thesis, manual override, earnings watch.
 * ACT 04  The Book     — sector exposure + best/worst ledgers.
 * ACT 05  The Wire     — orders, headlines, insider flow.
 *
 * Entrances vary per act (clip-up / reel / blur-in / slide-l / slide-r via
 * the Reveal wrapper) — adjacent acts never reveal the same way.
 */
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
      {/* ═══ ACT 01 — THE STAGE ═══ */}
      <Reveal fx="clip-up" style={{ marginTop: 24 }}>
        <section className="panel stage">
          {/* Gemini-generated night-trading-floor plate, screen-blended at low
              opacity so only the emerald glows read through the obsidian. */}
          <div className="stage-backdrop" aria-hidden="true" />
          <div className="stage-hud">
            <SectionHead
              scene="01"
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
          </div>
          <div className="stage-chart">
            <EquityChart startEquity={baseEquity} />
          </div>
          <div className="stage-rail">
            <PerformanceScorecard />
          </div>
        </section>
      </Reveal>

      {/* ═══ ACT 02 — THE MACHINE ═══ */}
      <Reveal fx="reel" style={{ marginTop: 52 }}>
        <SectionHead
          scene="02"
          eyebrow="LLM Ops — every routine, its cost, its tools"
          title="The Machine"
          right={<span>newest first</span>}
        />
        <RoutineReel limit={12} />
      </Reveal>

      {/* ═══ ACT 03 — THE PLAYBOOK ═══ */}
      <Reveal fx="blur-in" style={{ marginTop: 52 }}>
        <SectionHead
          scene="03"
          eyebrow="Research → Override → Watchlist"
          title="The Playbook"
        />
        <ThesisPanel />
      </Reveal>

      <Reveal fx="slide-l" style={{ marginTop: 36 }}>
        <ManualTradePanel />
      </Reveal>

      <Reveal fx="slide-r" style={{ marginTop: 36 }}>
        <EarningsThisWeek />
      </Reveal>

      {/* ═══ ACT 04 — THE BOOK ═══ */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(12, 1fr)",
          gap: 28,
          marginTop: 52,
        }}
      >
        <Reveal
          fx="slide-l"
          style={{ gridColumn: "span 4", minWidth: 0 }}
        >
          <SectionHead scene="04" eyebrow="Exposure" title="Sector weights" />
          <SectorDonut />
        </Reveal>

        <div style={{ gridColumn: "span 8", minWidth: 0 }}>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28 }}
          >
            <Reveal fx="slide-l" delay={120}>
              <SectionHead
                eyebrow="Gainers"
                title="Top of the book"
                right={<span>best 4</span>}
              />
              <Leaderboard rows={leaders} />
            </Reveal>
            <Reveal fx="slide-l" delay={240}>
              <SectionHead
                eyebrow="Draggers"
                title="Under the stop"
                right={<span>worst 4</span>}
              />
              <Leaderboard rows={laggards} />
            </Reveal>
          </div>
        </div>
      </section>

      {/* ═══ ACT 05 — THE WIRE ═══ */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(12, 1fr)",
          gap: 28,
          marginTop: 52,
        }}
      >
        <Reveal fx="blur-in" style={{ gridColumn: "span 6", minWidth: 0 }}>
          <SectionHead
            scene="05"
            eyebrow="From the trade journal"
            title="Today's orders"
            right={
              <a
                href="/trades"
                style={{ textDecoration: "underline", textUnderlineOffset: 3 }}
              >
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
        </Reveal>
        <Reveal
          fx="blur-in"
          delay={120}
          style={{ gridColumn: "span 4", minWidth: 0 }}
        >
          <SectionHead
            eyebrow="The Market Wire"
            title="Latest headlines"
            right={
              <a
                href="/news"
                style={{ textDecoration: "underline", textUnderlineOffset: 3 }}
              >
                full feed
              </a>
            }
          />
          <LatestHeadlines limit={7} />
        </Reveal>
        <Reveal
          fx="blur-in"
          delay={240}
          style={{ gridColumn: "span 2", minWidth: 0 }}
        >
          <SectionHead eyebrow="Insider Desk" title="Flow" />
          <InsiderDesk limit={10} />
        </Reveal>
      </section>
    </div>
  );
}
