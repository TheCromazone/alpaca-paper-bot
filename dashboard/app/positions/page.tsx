"use client";

import { KpiStrip } from "@/components/term/KpiStrip";
import { PortMonitor } from "@/components/term/PortMonitor";
import { RiskPanel } from "@/components/term/RiskPanel";
import { ThesisBoard } from "@/components/term/ThesisBoard";

/** PORT — the book: holdings monitor + guards, then why we own each name. */
export default function PortfolioPage() {
  return (
    <div style={{ display: "grid", gap: "var(--gap)" }}>
      <KpiStrip />
      <div className="lp">
        <PortMonitor className="span-8" style={{ height: "calc(100vh - 226px)", minHeight: 460 }} />
        <RiskPanel className="span-4" style={{ height: "calc(100vh - 226px)", minHeight: 460 }} />
      </div>
      <ThesisBoard />
    </div>
  );
}
