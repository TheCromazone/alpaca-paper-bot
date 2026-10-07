"use client";

import { BlotterPanel } from "@/components/term/BlotterPanel";
import { ClosedLots } from "@/components/term/ClosedLots";
import { WirePanel } from "@/components/term/WirePanel";

/** BLTR — every order with its reasoning, realized P&L by lot, and the wire. */
export default function BlotterPage() {
  return (
    <div style={{ display: "grid", gap: "var(--gap)" }}>
      <div className="lp">
        <BlotterPanel className="span-7" style={{ height: "calc(100vh - 116px)", minHeight: 520 }} />
        <div className="span-5" style={{ display: "grid", gap: "var(--gap)", gridTemplateRows: "1fr 1fr", height: "calc(100vh - 116px)", minHeight: 520 }}>
          <ClosedLots style={{ minHeight: 0 }} />
          <WirePanel style={{ minHeight: 0 }} />
        </div>
      </div>
    </div>
  );
}
