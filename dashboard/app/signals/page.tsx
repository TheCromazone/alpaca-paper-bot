"use client";

import { FlowPanel } from "@/components/term/FlowPanel";
import { PoliticianBoard } from "@/components/term/PoliticianBoard";

/** FLOW — politician PTRs and 13F changes, by trade and by discloser. */
export default function FlowPage() {
  return (
    <div className="lp">
      <FlowPanel className="span-7" style={{ height: "calc(100vh - 116px)", minHeight: 520 }} />
      <PoliticianBoard className="span-5" style={{ height: "calc(100vh - 116px)", minHeight: 520 }} />
    </div>
  );
}
