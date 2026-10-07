"use client";

import { KpiStrip } from "@/components/term/KpiStrip";
import { EquityGP } from "@/components/term/EquityGP";
import { PortMonitor } from "@/components/term/PortMonitor";
import { MarketMonitor } from "@/components/term/MarketMonitor";
import { Heatmap } from "@/components/term/Heatmap";
import { Brief } from "@/components/term/Brief";
import { NewsPanel } from "@/components/term/NewsPanel";
import { FlowPanel } from "@/components/term/FlowPanel";
import { EarningsPanel } from "@/components/term/EarningsPanel";
import { BotPanel } from "@/components/term/BotPanel";
import { RiskPanel } from "@/components/term/RiskPanel";
import { WirePanel } from "@/components/term/WirePanel";
import { BlotterPanel } from "@/components/term/BlotterPanel";
import { ManualTradePanel } from "@/components/ManualTradePanel";

/**
 * LP — the Launchpad. One screen that reads as a full terminal at 1440×900:
 * key figures → [equity vs SPY | portfolio monitor] → [cross-asset | universe
 * heat | intelligence brief]; below the fold the flow, the machine, risk,
 * the ticket and the live wire. Layout contract: design/TERMINAL.md.
 */
// First-viewport fit: chrome (66) + status (24) + padding (12) + KPI strip
// (92) + row gaps (12) = 206px; rows 2 and 3 split the rest ~53/47, so at
// 1440×900 the whole first screen is visible and taller monitors give the
// chart and monitors the extra room.
const FREE = "(100vh - 206px)";
const ROW2 = `max(360px, calc(${FREE} * 0.525 - 2px))`;
const ROW3 = `max(338px, calc(${FREE} * 0.475))`;

export default function Launchpad() {
  return (
    <div style={{ display: "grid", gap: "var(--gap)" }}>
      <KpiStrip />

      <div className="lp">
        {/* Even split: PORT needs ≥700px for avg cost + 30D alongside qty/value/day $. */}
        <EquityGP className="span-6" style={{ height: ROW2 }} />
        <PortMonitor className="span-6" style={{ height: ROW2 }} />
      </div>

      <div className="lp">
        <MarketMonitor className="span-4" style={{ height: ROW3 }} />
        <Heatmap className="span-5" style={{ height: ROW3 }} />
        <Brief className="span-3" style={{ height: ROW3 }} />
      </div>

      <div className="lp">
        <NewsPanel className="span-5" style={{ height: 360 }} />
        <FlowPanel className="span-4" style={{ height: 360 }} />
        <EarningsPanel className="span-3" style={{ height: 360 }} />
      </div>

      <div className="lp">
        {/* Live risk first: breaches outrank the bot's routine log. */}
        <RiskPanel className="span-5" style={{ minHeight: 420 }} />
        <BotPanel className="span-4" style={{ minHeight: 420 }} />
        <div className="span-3" style={{ minWidth: 0 }}>
          <ManualTradePanel />
        </div>
      </div>

      <div className="lp">
        <WirePanel className="span-6" style={{ height: 380 }} />
        <BlotterPanel className="span-6" style={{ height: 380 }} />
      </div>
    </div>
  );
}
