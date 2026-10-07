"use client";

/**
 * Shared read models for the holdings-centric launchpad panels (KPI strip +
 * PORT monitor) so both hit the same TanStack cache entries.
 */
import { useQuery } from "@tanstack/react-query";
import { api, term, type PositionRow } from "@/lib/api";

export function usePositions() {
  return useQuery({ queryKey: ["positions"], queryFn: api.positions, refetchInterval: 30_000 });
}

export function heldTickers(p?: PositionRow[]) {
  return p ? [...new Set(p.map((r) => r.ticker))].sort() : [];
}

/** /terminal/monitor for the held book (sparklines, 1D change, VIX). */
export function useHeldMonitor(positions?: PositionRow[]) {
  const tickers = heldTickers(positions);
  return useQuery({
    queryKey: ["monitor", tickers.join(",")],
    queryFn: () => term.monitor(tickers),
    enabled: positions !== undefined,
    refetchInterval: 60_000,
  });
}

/** "2026-10-07" for an ISO timestamp, in the exchange's calendar (ET). */
export function etDay(iso: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
