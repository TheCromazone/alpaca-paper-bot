// Client API helpers — call the local FastAPI service on port 8765.

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8765";

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`API ${path} → ${r.status}`);
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
  opened_at: string;
  updated_at: string | null;
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
  interval_seconds: number;
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
};
