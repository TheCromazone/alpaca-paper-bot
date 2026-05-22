"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

/**
 * Live-by-default query defaults. Every component can override these via its
 * own `useQuery({ refetchInterval })` if it wants a different cadence.
 *
 * - `staleTime: 5s` — data goes stale fast so navigating between pages always
 *   refetches (combined with refetchOnMount: 'always').
 * - `refetchInterval: 15s` — base poll cadence. Trades, summary, portfolio
 *   are visibly live without the user pressing anything.
 * - `refetchOnWindowFocus: true` — alt-tabbing back into the dashboard
 *   triggers an immediate refresh, which is what the user expects from a
 *   "live" dashboard.
 * - `refetchOnReconnect: true` — laptop wakes up → fetch fresh.
 * - `refetchOnMount: 'always'` — page navigation always pulls fresh data.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            refetchInterval: 15_000,
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
            refetchOnMount: "always",
            retry: 1,
          },
        },
      })
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
