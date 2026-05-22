// Client API helpers — call the local FastAPI service on port 8765.

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8765";

async function get<T>(path: string): Promise<T> {
  // `cache: "no-store"` plus an explicit no-cache header defeats both the
  // browser's HTTP cache and any intermediate cache. The TanStack queryKey
  // (which is `path` minus any cache-bust) still dedupes in-flight requests.
  const r = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    headers: { "cache-control": "no-cache", pragma: "no-cache" },
  });
  if (!r.ok) throw new Error(`API ${path} → ${r.status}`);
  return (await r.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    // FastAPI puts the error string in `detail`; surface it verbatim.
    let detail: string;
    try {
      const j = (await r.json()) as { detail?: unknown };
      detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch {
      detail = await r.text();
    }
    throw new Error(detail || `API ${path} → ${r.status}`);
  }
  return (await r.json()) as T;
}

// ------ Types (mirror FastAPI response shapes) ------

export type PortfolioSummary = {
  equity: number;
  cash: number;
  buying_power: number;
  invested: number;
  unrealized_pnl: number;
  spy_close: number | null;
  as_of: string;
  /** "alpaca_live" when the API hit Alpaca directly, "db_fallback" when it
   *  served from a stale local snapshot (Alpaca unreachable). */
  source?: "alpaca_live" | "db_fallback";
  position_count: number;
  sector_breakdown: { sector: string; market_value: number; weight: number }[];
};

export type HistoryPoint = {
  at: string;
  equity: number;
  spy_close: number | null;
};

export type PositionRow = {
  ticker: string;
  sector: string;
  qty: number;
  avg_cost: number;
  market_price: number;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pct: number;
  peak_price: number;
  stop_price: number;
  distance_to_stop_pct: number;
  opened_at: string | null;
  updated_at: string | null;
  /** Latest BUY decision reason for this ticker (LLM thesis or manual note). */
  thesis: string | null;
  decision_at: string | null;
  decision_action: string | null;
  stop_order_id: string | null;
};

export type TradeRow = {
  id: number;
  ticker: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  notional: number;
  status: string;
  dry_run: boolean;
  submitted_at: string;
  filled_at: string | null;
  reason: string | null;
  composite_score: number | null;
  score_breakdown: Record<string, unknown> | null;
  action: string | null;
  /** "local" = LLM/manual order with a thesis, "alpaca_fill" = pulled from
   *  Alpaca's order history (trailing-stop sells, etc.) — no thesis. */
  source?: "local" | "alpaca_fill";
  /** Alpaca order type when source=alpaca_fill: "trailing_stop", "stop",
   *  "market", "limit", etc. */
  order_type?: string;
};

export type DecisionRow = {
  id: number;
  at: string;
  ticker: string;
  action: string;
  composite_score: number;
  score_breakdown: Record<string, unknown>;
  reason: string;
  dry_run: boolean;
  trade_id: number | null;
};

export type NewsRow = {
  id: number;
  title: string;
  url: string;
  summary: string;
  source: string;
  published_at: string;
  tickers: string[];
  vader_score: number | null;
  sentiment_label: "positive" | "neutral" | "negative";
  finbert_label: string | null;
};

export type SignalRow = {
  id: number;
  ticker: string;
  kind: "politician" | "investor" | string;
  source: string;
  direction: "buy" | "sell";
  amount: number | null;
  as_of: string;
  meta: Record<string, unknown>;
};

export type JobRow = {
  id: number;
  job_name: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  message: string;
};

// ------ Fetchers ------

export type TapeRow = { s: string; p: number; c: number };
export type BotStatus = {
  last_tick_at: string | null;
  last_tick_status: string | null;
  last_tick_kind: string | null;
  interval_seconds: number;
  last_llm_run: {
    id: number;
    routine: string;
    started_at: string;
    status: string;
    tool_calls: number;
    usd_cost: number;
  } | null;
  last_decision: {
    at: string;
    ticker: string;
    action: string;
    composite_score: number;
    reason: string;
  } | null;
};

// ------ LLM-era types (Phase 4) ------

export type LLMRoutine =
  | "premarket"
  | "execute"
  | "midday"
  | "close"
  | "weekly_review";

export type LLMRunRow = {
  id: number;
  routine: LLMRoutine;
  started_at: string;
  finished_at: string | null;
  status: "running" | "ok" | "failed" | "budget_halt";
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usd_cost: number;
  web_search_calls: number;
  tool_calls: number;
  tool_trace: { name: string; args: Record<string, unknown>; ok: boolean; ms: number }[];
  summary: string;
  error: string | null;
};

export type LLMCost = {
  today_usd: number;
  week_usd: number;
  budget_usd: number;
  remaining_usd: number;
  cache_hit_ratio: number | null;
};

export type MemoryDoc = {
  name: "strategy" | "portfolio" | "trade_log" | "research_log";
  content: string;
  bytes: number;
  updated_at: string | null;
};

export type RoutineScheduleEntry = {
  name: LLMRoutine;
  day_of_week: string;
  hour: number;
  minute: number;
  next_fire_utc: string;
  seconds_until: number;
};

export type RoutinesNext = {
  now_utc: string;
  routines_enabled: boolean;
  next: RoutineScheduleEntry;
  all: RoutineScheduleEntry[];
};

export type RegimeSnapshot = {
  as_of: string | null;
  vix: number | null;
  vix_5d_change: number | null;
  spy_trend: number | null;
  t10y2y: number | null;
  breadth_pct: number | null;
  regime_label: "risk_on" | "neutral" | "risk_off" | string;
};

export type EarningsEvent = {
  ticker: string;
  report_date: string;
  time_of_day: string | null;
  eps_estimate: number | null;
  last_4_surprise_pcts: (number | null)[];
};

export type PoliticianTrade = {
  id: number;
  ticker: string;
  politician: string;
  chamber: string | null;
  direction: "buy" | "sell";
  amount: number | null;
  as_of: string;
  source_url: string | null;
};

export type ManualTradeRequest = {
  symbol: string;
  side: "buy" | "sell";
  qty?: number;
  notional_usd?: number;
  note?: string;
  allow_after_hours?: boolean;
};

export type ManualTradeResult = {
  trade_id: number;
  order_id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  est_price: number;
  notional: number;
  status: string;
  dry_run: boolean;
  cancelled_open_opposite: number;
  market_was_open: boolean;
  reason: string;
};

export const api = {
  summary: () => get<PortfolioSummary>("/portfolio/summary"),
  history: (days = 30) => get<HistoryPoint[]>(`/portfolio/history?days=${days}`),
  positions: () => get<PositionRow[]>("/positions"),
  trades: (limit = 100) => get<TradeRow[]>(`/trades?limit=${limit}`),
  decisions: (limit = 100) => get<DecisionRow[]>(`/decisions?limit=${limit}`),
  news: (limit = 50, ticker?: string) =>
    get<NewsRow[]>(`/news?limit=${limit}${ticker ? `&ticker=${ticker}` : ""}`),
  signals: (limit = 100, kind?: string) =>
    get<SignalRow[]>(`/signals?limit=${limit}${kind ? `&kind=${kind}` : ""}`),
  jobs: () => get<JobRow[]>("/jobs"),
  tape: () => get<TapeRow[]>("/tape"),
  botStatus: () => get<BotStatus>("/bot/status"),
  // LLM-era
  llmRuns: (limit = 20) => get<LLMRunRow[]>(`/llm/runs?limit=${limit}`),
  llmCost: () => get<LLMCost>("/llm/cost"),
  memory: (name: MemoryDoc["name"]) => get<MemoryDoc>(`/memory/${name}`),
  routinesNext: () => get<RoutinesNext>("/routines/next"),
  regime: () => get<RegimeSnapshot>("/regime/today"),
  earnings: (days = 14) => get<EarningsEvent[]>(`/earnings/upcoming?days=${days}`),
  politicianTrades: (name?: string, days = 60, limit = 50) =>
    get<PoliticianTrade[]>(
      `/signals/by-politician?days=${days}&limit=${limit}` +
      (name ? `&name=${encodeURIComponent(name)}` : ""),
    ),
  manualTrade: (req: ManualTradeRequest) =>
    post<ManualTradeResult>("/trade/manual", req),
};
