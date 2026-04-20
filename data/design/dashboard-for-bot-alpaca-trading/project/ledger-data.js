// Mock data for The Ledger paper trading dashboard.
// Shapes mirror the FastAPI responses in lib/api.ts so the visual design is faithful.

(function(){
  const now = Date.now();
  const day = 86400000;

  // ---- Equity history, 30 days, with a realistic random walk ----
  function buildHistory() {
    const start = 100000;
    const points = [];
    let eq = start;
    let spy = 540;
    const spyStart = spy;
    // deterministic-ish walk so reload looks similar
    let seed = 42;
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    for (let i = 30; i >= 0; i--) {
      // two bars per day for visual density
      for (let h = 0; h < 2; h++) {
        const drift = 0.0009;
        const vol = 0.0085;
        eq *= 1 + drift + (rnd() - 0.48) * vol;
        spy *= 1 + 0.0004 + (rnd() - 0.5) * 0.006;
        points.push({
          at: new Date(now - i * day + h * (day / 2)).toISOString(),
          equity: eq,
          spy_close: spy,
        });
      }
    }
    // tail: punchy little close
    points[points.length - 1].equity *= 1.002;
    return { points, startEquity: start, startSpy: spyStart };
  }
  const hist = buildHistory();
  const lastEq = hist.points[hist.points.length - 1].equity;
  const prevEq = hist.points[hist.points.length - 2].equity;

  const positions = [
    { ticker: "NVDA", sector: "Semiconductors", qty: 24, avg_cost: 118.42, market_price: 141.08, opened_at: new Date(now - 18*day).toISOString() },
    { ticker: "MSFT", sector: "Software",       qty: 12, avg_cost: 412.55, market_price: 448.90, opened_at: new Date(now - 22*day).toISOString() },
    { ticker: "AAPL", sector: "Hardware",       qty: 30, avg_cost: 198.12, market_price: 212.44, opened_at: new Date(now - 9*day).toISOString() },
    { ticker: "META", sector: "Communications", qty: 8,  avg_cost: 524.10, market_price: 561.76, opened_at: new Date(now - 27*day).toISOString() },
    { ticker: "COST", sector: "Consumer Staples",qty: 5,  avg_cost: 872.30, market_price: 904.11, opened_at: new Date(now - 6*day).toISOString() },
    { ticker: "AMD",  sector: "Semiconductors", qty: 18, avg_cost: 158.70, market_price: 148.22, opened_at: new Date(now - 11*day).toISOString() },
    { ticker: "TSLA", sector: "Auto",           qty: 10, avg_cost: 248.44, market_price: 227.30, opened_at: new Date(now - 4*day).toISOString() },
    { ticker: "XOM",  sector: "Energy",         qty: 14, avg_cost: 115.04, market_price: 109.88, opened_at: new Date(now - 14*day).toISOString() },
    { ticker: "JPM",  sector: "Financials",     qty: 9,  avg_cost: 218.77, market_price: 225.40, opened_at: new Date(now - 20*day).toISOString() },
    { ticker: "UNH",  sector: "Healthcare",     qty: 3,  avg_cost: 532.18, market_price: 510.95, opened_at: new Date(now - 8*day).toISOString() },
  ].map(p => {
    const mv = p.qty * p.market_price;
    const cost = p.qty * p.avg_cost;
    const pnl = mv - cost;
    const pct = pnl / cost;
    return {
      ...p,
      market_value: mv,
      unrealized_pnl: pnl,
      unrealized_pct: pct,
      peak_price: p.market_price * 1.02,
      stop_price: p.avg_cost * 0.92,
      distance_to_stop_pct: (p.market_price - p.avg_cost * 0.92) / p.market_price,
      updated_at: new Date(now - (Math.random()*180000)|0).toISOString(),
    };
  });

  const invested = positions.reduce((s,p)=>s+p.market_value,0);
  const cash = 18234.71;
  const equity = invested + cash;
  const unrealized = positions.reduce((s,p)=>s+p.unrealized_pnl,0);

  // Sector weights
  const sectorMap = {};
  positions.forEach(p => {
    sectorMap[p.sector] = (sectorMap[p.sector] || 0) + p.market_value;
  });
  const sector_breakdown = Object.entries(sectorMap)
    .map(([sector, mv]) => ({ sector, market_value: mv, weight: mv / invested }))
    .sort((a,b) => b.market_value - a.market_value);

  const summary = {
    equity,
    cash,
    buying_power: cash * 2,
    invested,
    unrealized_pnl: unrealized,
    spy_close: hist.points[hist.points.length - 1].spy_close,
    as_of: new Date().toISOString(),
    position_count: positions.length,
    sector_breakdown,
  };

  // Recent trades
  const trades = [
    { id: 91, ticker: "NVDA", side: "buy",  qty: 4,  price: 140.22, reason: "Composite 2.1σ above 20d mean; Pelosi disclosure + bullish news flow.", composite_score: 2.08, submitted_at: new Date(now - 18*60000).toISOString() },
    { id: 90, ticker: "TSLA", side: "sell", qty: 3,  price: 228.40, reason: "Negative delivery coverage pushed sentiment below −0.4; stop trail tightened.", composite_score: -1.42, submitted_at: new Date(now - 52*60000).toISOString() },
    { id: 89, ticker: "COST", side: "buy",  qty: 1,  price: 903.10, reason: "13F accumulation by Scion + positive VADER on comp-sales.", composite_score: 1.34, submitted_at: new Date(now - 2*3600000).toISOString() },
    { id: 88, ticker: "XOM",  side: "sell", qty: 4,  price: 110.55, reason: "Composite rolled negative; crude futures −2.1%.", composite_score: -0.98, submitted_at: new Date(now - 3*3600000).toISOString(), dry_run: true },
    { id: 87, ticker: "META", side: "buy",  qty: 2,  price: 559.88, reason: "Earnings tailwind + positive FinBERT on ads cadence.", composite_score: 1.77, submitted_at: new Date(now - 5*3600000).toISOString() },
    { id: 86, ticker: "AAPL", side: "buy",  qty: 6,  price: 210.10, reason: "Senator disclosure; 20d breakout confirmed.", composite_score: 1.18, submitted_at: new Date(now - 22*3600000).toISOString() },
  ].map(t => ({ notional: t.qty * t.price, status: "filled", dry_run: !!t.dry_run, filled_at: null, action: t.side, score_breakdown: null, ...t }));

  // News
  const news = [
    { id: 1, title: "Nvidia eyes record data-center quarter as hyperscalers extend AI capex",
      url: "#", summary: "", source: "Reuters", published_at: new Date(now - 6*60000).toISOString(),
      tickers: ["NVDA","MSFT","GOOGL"], vader_score: 0.58, sentiment_label: "positive", finbert_label: "positive" },
    { id: 2, title: "Tesla faces softening Q2 deliveries, analysts trim margin outlook",
      url: "#", summary: "", source: "Bloomberg", published_at: new Date(now - 17*60000).toISOString(),
      tickers: ["TSLA"], vader_score: -0.42, sentiment_label: "negative", finbert_label: "negative" },
    { id: 3, title: "Costco same-store comps tick higher; membership fee boost lands",
      url: "#", summary: "", source: "WSJ", published_at: new Date(now - 43*60000).toISOString(),
      tickers: ["COST"], vader_score: 0.31, sentiment_label: "positive", finbert_label: "positive" },
    { id: 4, title: "Crude slides on surprise inventory build; Exxon drags energy tape",
      url: "#", summary: "", source: "CNBC", published_at: new Date(now - 95*60000).toISOString(),
      tickers: ["XOM","CVX"], vader_score: -0.21, sentiment_label: "negative", finbert_label: "neutral" },
    { id: 5, title: "Fed minutes hint at dovish tilt; tech tape bid into close",
      url: "#", summary: "", source: "FT", published_at: new Date(now - 2.5*3600000).toISOString(),
      tickers: ["QQQ","SPY"], vader_score: 0.12, sentiment_label: "neutral", finbert_label: "neutral" },
    { id: 6, title: "UnitedHealth faces new DOJ probe on Medicare Advantage coding",
      url: "#", summary: "", source: "NYT", published_at: new Date(now - 4.2*3600000).toISOString(),
      tickers: ["UNH"], vader_score: -0.55, sentiment_label: "negative", finbert_label: "negative" },
  ];

  // Signals (insider desk)
  const signals = [
    { id: 1, ticker: "NVDA", kind: "politician", source: "Pelosi, N.", direction: "buy",  amount: 1_000_000, as_of: new Date(now - 4*3600000).toISOString() },
    { id: 2, ticker: "COST", kind: "investor",   source: "Scion Asset",  direction: "buy",  amount: 14_200_000, as_of: new Date(now - 18*3600000).toISOString() },
    { id: 3, ticker: "TSLA", kind: "investor",   source: "Bridgewater",  direction: "sell", amount: 6_500_000,  as_of: new Date(now - 22*3600000).toISOString() },
    { id: 4, ticker: "AAPL", kind: "politician", source: "Crenshaw, D.", direction: "buy",  amount: 250_000,    as_of: new Date(now - 36*3600000).toISOString() },
  ];

  // Watchlist / tape
  const tape = [
    { s:"NVDA", p:141.08, c:0.0184 }, { s:"MSFT", p:448.90, c:0.0071 },
    { s:"AAPL", p:212.44, c:0.0112 }, { s:"META", p:561.76, c:-0.0029 },
    { s:"COST", p:904.11, c:0.0054 }, { s:"AMD",  p:148.22, c:-0.0184 },
    { s:"TSLA", p:227.30, c:-0.0237 }, { s:"XOM",  p:109.88, c:-0.0091 },
    { s:"JPM",  p:225.40, c:0.0042 }, { s:"UNH",  p:510.95, c:-0.0134 },
    { s:"GOOGL",p:174.22, c:0.0061 }, { s:"AMZN", p:201.44, c:0.0095 },
    { s:"^GSPC",p:5702.4, c:0.0022 }, { s:"^IXIC",p:18204.8,c:0.0038 },
    { s:"VIX",  p:14.22, c:-0.0410 },
  ];

  window.LEDGER_DATA = {
    summary, positions, trades, news, signals, history: hist.points, tape,
    lastEq, prevEq,
  };
})();
