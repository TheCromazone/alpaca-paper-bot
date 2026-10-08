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
  /** Bot/SPY total return since inception + alpha (pts). Null until ≥2 snapshots. */
  bot_return_pct?: number | null;
  spy_return_pct?: number | null;
  alpha_pct?: number | null;
  inception_at?: string | null;
  as_of: string;
  /** "alpaca_live" when the API hit Alpaca directly, "db_fallback" when it
   *  served from a stale local snapshot (Alpaca unreachable). */
  source?: "alpaca_live" | "db_fallback";
  position_count: number;
  sector_breakdown: { sector: string; market_value: number; weight: number }[];
};

export type ClosedLot = {
  ticker: string;
  qty: number;
  entry_price: number;
  exit_price: number;
  entry_at: string | null;
  exit_at: string | null;
  pnl: number;
  pnl_pct: number;
  entry_thesis: string | null;
  exit_reason: string | null;
};

export type PerformanceSummary = {
  benchmark: {
    available: boolean;
    note?: string;
    inception_at?: string;
    as_of?: string;
    start_equity?: number;
    equity?: number;
    bot_return_pct?: number;
    spy_return_pct?: number | null;
    alpha_pct?: number | null;
    beating_market?: boolean;
  };
  realized: {
    closed_lots: number;
    wins: number;
    losses: number;
    hit_rate_pct: number;
    realized_pnl: number;
    gross_profit: number;
    gross_loss: number;
    profit_factor: number | null;
    avg_win: number;
    avg_loss: number;
    best_trade: ClosedLot | null;
    worst_trade: ClosedLot | null;
    recent: ClosedLot[];
  };
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
  /** Shared "is the automation running?" answer: routines enabled AND the
   *  newest LLM routine < 84h old. Use these instead of re-deriving. */
  routines_enabled?: boolean;
  stale?: boolean;
  active?: boolean;
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

/** Cached company fundamentals for the holdings dossier (yfinance-backed). */
export type CompanyProfile = {
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  description: string | null;
  website: string | null;
  exchange: string | null;
  country: string | null;
  market_cap: number | null;
  employees: number | null;
  fetched_at: string | null;
};

export type RecapMover = {
  ticker: string;
  close: number;
  pct_1d: number;
  held: boolean;
};

export type AnalystBuzzRow = {
  id: number;
  title: string;
  url: string;
  source: string;
  published_at: string;
  tickers: string[];
  vader_score: number | null;
  sentiment_label: "positive" | "neutral" | "negative";
};

/** Daily market wrap backing the home page's Closing Bell section. */
export type MarketRecap = {
  as_of: string;
  prev_date: string;
  indexes: { ticker: string; close: number; pct_1d: number; held: boolean }[];
  vix: number | null;
  vix_5d_change: number | null;
  breadth_pct: number | null;
  regime_label: "risk_on" | "neutral" | "risk_off" | string | null;
  gainers: RecapMover[];
  losers: RecapMover[];
  portfolio_movers: RecapMover[];
  analyst_buzz: AnalystBuzzRow[];
  close_note: { summary: string; started_at: string; status: string } | null;
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
  performance: () => get<PerformanceSummary>("/performance/summary"),
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
  company: (ticker: string) =>
    get<CompanyProfile>(`/company/${encodeURIComponent(ticker)}`),
  marketRecap: () => get<MarketRecap>("/market/recap"),
  politicianTrades: (name?: string, days = 60, limit = 50) =>
    get<PoliticianTrade[]>(
      `/signals/by-politician?days=${days}&limit=${limit}` +
      (name ? `&name=${encodeURIComponent(name)}` : ""),
    ),
  manualTrade: (req: ManualTradeRequest) =>
    post<ManualTradeResult>("/trade/manual", req),
};

// ------ Terminal read models (api/terminal.py) ------

export type QuoteRow = {
  ticker: string;
  name: string;
  sector: string;
  held: boolean;
  as_of: string;
  last: number | null;
  prev: number | null;
  chg_1d: number | null;
  chg_5d: number | null;
  chg_1m: number | null;
  chg_3m: number | null;
  chg_ytd: number | null;
  chg_1y: number | null;
  hi_52w: number | null;
  lo_52w: number | null;
  pos_52w: number | null;
  vol_20d: number | null;
  /** Latest session volume, its prior 20-day average, and the ratio (IEX
   *  feed in production — compare only within the same ticker). */
  volume?: number | null;
  avg_volume_20d?: number | null;
  rel_volume?: number | null;
  /** Monitor group: Equity | Sectors | Global | Rates | Credit | FX | Commodities | Crypto. */
  group?: string;
  spark: (number | null)[];
};

/** One FRED macro series (yields/spreads in percent; deltas in percentage
 *  points → ×100 for bp; "idx" series' deltas are fractional changes). */
export type MacroRow = {
  series_id: string;
  group: "Treasury curve" | "Spreads" | "Funding" | "Dollar & oil" | "Volatility" | string;
  label: string;
  unit: "pct" | "idx";
  as_of: string;
  last: number | null;
  chg_1d: number | null;
  chg_5d: number | null;
  chg_1m: number | null;
  spark: (number | null)[];
};

export type MonitorResp = {
  rows: QuoteRow[];
  macro?: MacroRow[];
  groups?: string[];
  vix: {
    ticker: "VIX";
    name: string;
    last: number | null;
    chg_5d_abs: number | null;
    spark: (number | null)[];
    as_of: string | null;
  } | null;
};

export type HeatCell = {
  ticker: string;
  sector: string;
  last: number | null;
  chg_1d: number | null;
  chg_5d: number | null;
  chg_1m: number | null;
  held: boolean;
  weight: number | null;
  name?: string;
  /** GICS-style sector from the company profile (e.g. "Communication Services",
   *  "Consumer Cyclical"); null for ETFs or before the profile job ran. */
  gics?: string | null;
  /** Market cap (ETFs: AUM) in USD for area-weighted tiles; null if unknown. */
  mcap?: number | null;
};

export type HeatmapResp = {
  as_of: string | null;
  cells: HeatCell[];
  sectors: { sector: string; avg_1d: number | null; count: number }[];
  advancers: number;
  decliners: number;
  /** Names inside ±unchanged_band (0.0005 = ±0.05%) — the shared breadth definition. */
  unchanged?: number;
  unchanged_band?: number;
};

export type UniverseRow = {
  ticker: string;
  name: string;
  sector: string;
  held: boolean;
  kind: "equity" | "etf" | "bond_etf";
};

export type SecurityResp = {
  ticker: string;
  name: string;
  sector: string;
  in_universe: boolean;
  quote: QuoteRow | null;
  /** Daily bars; o/h/l/v are null for rows written before OHLCV capture. */
  series: { d: string; c: number; o?: number | null; h?: number | null; l?: number | null; v?: number | null }[];
  spy_series: { d: string; c: number }[];
  stats: {
    vol_20d: number | null;
    vol_60d: number | null;
    beta_1y: number | null;
    corr_1y: number | null;
    max_dd_1y: number | null;
    drawdown: number | null;
    rsi_14: number | null;
    sma_20: number | null;
    sma_50: number | null;
    sma_200: number | null;
    rel_spy_3m: number | null;
  };
  position: {
    qty: number;
    avg_cost: number;
    market_price: number;
    market_value: number;
    unrealized_pnl: number;
    unrealized_pct: number | null;
    weight: number | null;
    peak_price: number;
    trail_pct: number;
    stop_price: number;
    stop_distance: number | null;
    midday_cut_price: number;
    midday_cut_distance: number | null;
    broker_stop: boolean;
    opened_at: string | null;
    updated_at: string | null;
  } | null;
  profile: {
    name: string | null;
    sector: string | null;
    industry: string | null;
    description: string | null;
    website: string | null;
    exchange: string | null;
    country: string | null;
    market_cap: number | null;
    employees: number | null;
  } | null;
  decisions: { id: number; at: string; action: string; reason: string; dry_run: boolean; trade_id: number | null }[];
  trades: {
    id: number;
    side: "buy" | "sell";
    qty: number;
    price: number;
    notional: number;
    status: string;
    dry_run: boolean;
    submitted_at: string;
    filled_at: string | null;
  }[];
  news: { id: number; title: string; url: string; source: string; published_at: string; vader_score: number | null; tickers: string[] }[];
  signals: {
    id: number; kind: string; source: string; direction: "buy" | "sell"; amount: number | null; as_of: string; chamber: string | null;
    /** 13F only: holdings quarter-end, filing date, and the position change verb. */
    period?: string | null; filed?: string | null; change?: "new" | "add" | "trim" | "exit" | string | null;
  }[];
  earnings: {
    next: { report_date: string; time_of_day: string | null; eps_estimate: number | null } | null;
    history: { quarter: string; eps_actual: number | null; eps_estimate: number | null; surprise_pct: number | null }[];
  };
};

export type RiskGuard = {
  ticker: string;
  price: number;
  avg_cost: number;
  pnl_pct: number | null;
  stop_price: number;
  stop_distance: number | null;
  cut_price: number;
  cut_distance: number | null;
  trail_pct: number;
  broker_stop: boolean;
  earnings_at: string | null;
  earnings_in_days: number | null;
};

export type RiskResp = {
  as_of: string;
  equity: number | null;
  cash: number | null;
  cash_pct: number | null;
  observations: number;
  ann_return: number | null;
  ann_vol: number | null;
  sharpe: number | null;
  sortino: number | null;
  max_drawdown: number | null;
  drawdown: number | null;
  beta: number | null;
  corr: number | null;
  spy_ann_vol: number | null;
  best_day: number | null;
  worst_day: number | null;
  up_days_pct: number | null;
  positions: number;
  max_positions: number;
  top5_weight: number | null;
  hhi: number | null;
  effective_n: number | null;
  weights: { ticker: string; sector: string; weight: number; market_value: number }[];
  sector_load: { sector: string; weight: number; cap: number; over: boolean }[];
  guards: RiskGuard[];
  curve: { d: string; equity: number; bot_pct: number | null; spy_pct: number | null; dd: number | null }[];
};

export type BriefItem = {
  kind: "perf" | "risk" | "catalyst" | "macro" | "flow" | "bot";
  tone: "up" | "down" | "warn" | "info";
  text: string;
  ticker: string | null;
  /** 0 info · 1 watch · 2 act · 3 breach. Items arrive sorted by kind, then severity. */
  severity?: number;
  /** Risk items: the numbers behind the sentence, for tabular rendering. */
  metrics?: {
    last?: number | null;
    cut_price?: number | null;
    cut_distance?: number | null;
    stop_price?: number | null;
    stop_distance?: number | null;
    trail_pct?: number | null;
    pnl_pct?: number | null;
    action?: string;
    weight?: number | null;
    market_value?: number | null;
    pnl_usd?: number | null;
    /** $ already through the tightest breached guard (value × depth); 0 if none. */
    usd_beyond?: number | null;
  } | null;
  /** When the underlying fact was observed: ISO timestamp, or a bare date
   * ("2026-10-08") for report days. Null when unknown. */
  at?: string | null;
};

export type BriefResp = {
  as_of: string;
  headline: string;
  /** Book session return minus SPY's (fraction). */
  rel_spy_1d?: number | null;
  counts?: { breach: number; act: number; watch: number; info: number };
  /** Shared automation state (same rule as /bot/status). */
  bot?: { routines_enabled: boolean; stale: boolean; active: boolean; last_run_at: string | null };
  items: BriefItem[];
};

export type TickerNews = {
  ticker: string;
  source: string;
  items: { title: string; url: string; source: string; published_at: string | null; summary: string; vader_score?: number }[];
};

export type WireEvent = {
  at: string | null;
  type: "order" | "routine" | "job" | "politician" | "investor" | "news" | string;
  tone: "up" | "down" | "warn" | "info";
  ticker: string | null;
  text: string;
  detail: string | null;
  url?: string;
  /** News events: headline VADER score and all tagged tickers. */
  vader_score?: number | null;
  tickers?: string[];
  /** 13F events: new | add | trim | exit. PTR events: transaction date. */
  change?: string | null;
  traded_on?: string | null;
};

export const term = {
  universe: () => get<UniverseRow[]>("/terminal/universe"),
  monitor: (tickers?: string[]) =>
    get<MonitorResp>(`/terminal/monitor${tickers?.length ? `?tickers=${tickers.join(",")}` : ""}`),
  heatmap: () => get<HeatmapResp>("/terminal/heatmap"),
  security: (ticker: string, days = 730) =>
    get<SecurityResp>(`/terminal/security/${encodeURIComponent(ticker)}?days=${days}`),
  risk: () => get<RiskResp>("/terminal/risk"),
  brief: () => get<BriefResp>("/terminal/brief"),
  wire: (limit = 80) => get<WireEvent[]>(`/terminal/wire?limit=${limit}`),
  regimeHistory: (days = 400) =>
    get<{ d: string; label: string | null; vix: number | null; spy_trend: number | null; breadth_pct: number | null }[]>(
      `/terminal/regime/history?days=${days}`,
    ),
  securityNews: (ticker: string) => get<TickerNews>(`/terminal/security/${encodeURIComponent(ticker)}/news`),
};
