"use client";

/**
 * Data freshness, said once — and only when it differs from the book
 * snapshot already stamped on the KPI strip. Live and fresh → quiet "data 4m".
 * Served from the local fallback snapshot (Alpaca unreachable) → a warn chip
 * "snapshot · 3h" (a watch state, never bare amber text). Older than one
 * trading day → dim "data 2d".
 */
import { fmtAge } from "@/lib/format";
import { useNow } from "./ui";

const CHIP: React.CSSProperties = { height: 16, padding: "0 5px", fontSize: 9, letterSpacing: "0.05em" };

export function DataAge({
  at,
  snapshot = false,
  bookAt,
}: {
  at: string | null | undefined;
  snapshot?: boolean;
  /** The book snapshot's time, stated once on the KPI strip: when this panel's
   *  data is the same age (±10 min), say nothing. */
  bookAt?: string | null;
  staleAfterSec?: number;
}) {
  const now = useNow(15_000);
  if (at && bookAt && Math.abs(new Date(at).getTime() - new Date(bookAt).getTime()) < 10 * 60_000) return null;
  if (!at) return <span className="pill" style={CHIP}>no data</span>;
  const ageText = now ? fmtAge(at, now) : "—";
  const stamp = new Date(at).toUTCString();
  if (snapshot)
    return (
      <span className="pill warn" style={CHIP} title={`Snapshot served from the local database (Alpaca unreachable) — as of ${stamp}`}>
        snapshot · {ageText}
      </span>
    );
  const old = now > 0 && now - new Date(at).getTime() > 36 * 3600 * 1000;
  return (
    <span className="num" title={`Newest data point: ${stamp}`} style={{ fontSize: 10, color: old ? "var(--ink-4)" : "var(--ink-3)", whiteSpace: "nowrap" }}>
      data {ageText}
    </span>
  );
}
