"use client";

import { NewsPanel } from "@/components/term/NewsPanel";
import { SentimentBoard } from "@/components/term/SentimentBoard";
import { EarningsPanel } from "@/components/term/EarningsPanel";

/** TOP — the full news wire, sentiment rolled up by ticker, and earnings on deck. */
export default function NewsPage() {
  return (
    <div className="lp">
      <NewsPanel className="span-7" style={{ height: "calc(100vh - 116px)", minHeight: 520 }} />
      <div className="span-5" style={{ display: "grid", gap: "var(--gap)", gridTemplateRows: "3fr 2fr", height: "calc(100vh - 116px)", minHeight: 520 }}>
        <SentimentBoard style={{ minHeight: 0 }} />
        <EarningsPanel style={{ minHeight: 0 }} />
      </div>
    </div>
  );
}
