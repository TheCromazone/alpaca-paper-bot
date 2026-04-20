# Alpaca Paper Trading Bot + Dashboard

An autonomous paper-trading bot for [Alpaca](https://alpaca.markets/) that fuses
financial news sentiment, congressional trade disclosures, and top-investor 13F
filings into a composite score per ticker — then trades equities and bond ETFs
on a 5-minute cadence during market hours. A separate Next.js dashboard renders
the portfolio, trade journal (with the *reasoning* behind every decision), news
feed, and signal activity.

> ⚠️ **Paper only.** Pointed at `paper-api.alpaca.markets`. Nothing here uses real money.
>
> 🔐 **Rotate your Alpaca keys** if they've been in any chat transcript. The
> bot reads `ALPACA_API_KEY` and `ALPACA_API_SECRET` from `.env` (gitignored);
> no keys are hardcoded.

## What it does

| Signal | Source | Cadence |
|---|---|---|
| News sentiment | CNBC / Reuters / Yahoo Finance / CNN Business / MarketWatch / Seeking Alpha RSS feeds → VADER scoring | Every 5 min |
| Congressional trades | House Financial Disclosure XML index + PDFs | Weekly |
| Top-investor holdings | SEC EDGAR 13F-HR filings for 10 curated funds (Berkshire, Pershing Square, Scion, ARK, etc.) | Monthly |
| Price momentum & drawdown | Alpaca historical bars (IEX feed) | Daily after close |

Each ticker gets a composite score. Entries, exits, trims, dip-adds, stop-loss
trips, and fixed-income floor maintenance are all produced on every tick and
saved to SQLite with a human-readable `reason`.

## Quick start

```bash
# One-time setup
py -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt

cd dashboard
npm install
cd ..

# Initialize the DB and smoke-test Alpaca
.venv\Scripts\python -c "from bot.db import init_db; init_db()"
.venv\Scripts\python -m bot.main --once   # one immediate tick, even if market is closed
```

### Running

There are three processes:

1. **The bot** — headless. Ticks every 5 min 9:30–16:00 ET.
   ```
   scripts\run_bot.bat
   ```
2. **The API** — FastAPI service the dashboard calls.
   ```
   scripts\run_api.bat
   ```
3. **The dashboard** — Next.js 16 dev server at `http://localhost:3000`.
   ```
   cd dashboard && npm run dev
   ```

`scripts\run_dashboard.bat` launches API + Next.js together in two new windows.

### Put the bot on a Windows schedule

```
scripts\register_task.bat
```

Registers `AlpacaBot` under Task Scheduler, weekdays 09:25 local time. The bot
itself double-checks the NYSE calendar, so market holidays and weekends are
no-ops. Stop with:

```
schtasks /Delete /TN AlpacaBot /F
```

## Safety dials (in `.env`)

| Variable | Default | Effect |
|---|---|---|
| `DRY_RUN` | `true` | Skip order submission. Decisions are still logged to the dashboard. **Leave this on until you've watched it for a few days.** |
| `ALPACA_BASE_URL` | `https://paper-api.alpaca.markets/v2` | Never change this unless you want to trade live. |

## Strategy at a glance

```
composite_score =
    0.35 * news_sentiment_z        # 7-day rolling headlines mentioning the ticker
  + 0.25 * politician_signal       # 60-day net $ volume of tracked congressional buys/sells
  + 0.20 * investor_signal         # latest 13F $ delta from tracked whales
  + 0.15 * momentum                # 20-day return minus SPY's
  + 0.05 * dip_bonus               # +1 if drawdown > 25% from 52-week high
```

- **Open** when `score > +1.0` (subject to 5% max position, 25% sector cap, 8% cash reserve).
- **Close** when `score < −1.0` or a tracked whale fully exits.
- **Stop** on a 7% trailing drawdown from peak since entry.
- **Dip-add** 50% to a holding down 25% from cost if the thesis (score) is still positive.
- **Rebalance** Friday — trim any position over 8% back to 5%.
- **Fixed-income floor** — at least 10% in AGG/BND/TLT-type ETFs.

All tunables live in [`bot/config.py`](bot/config.py).

## Project layout

```
alpaca paper trading/
├── bot/                      # Python trading bot (headless)
│   ├── main.py               # APScheduler loop
│   ├── alpaca_client.py      # Alpaca SDK wrapper (IEX feed)
│   ├── config.py             # Universe, sectors, thresholds
│   ├── db.py                 # SQLAlchemy models
│   ├── executor.py           # Orders (or dry-run logs)
│   ├── risk.py               # Position sizing + diversification caps
│   ├── strategy.py           # Composite-score decision tree
│   ├── news/                 # RSS poller + ticker extractor
│   └── signals/              # VADER/FinBERT sentiment + politician + 13F signals
├── api/                      # FastAPI read layer
│   └── main.py
├── dashboard/                # Next.js 16 + Tailwind + shadcn-free hand-built UI
│   ├── app/
│   │   ├── page.tsx          # Front page
│   │   ├── positions/
│   │   ├── trades/
│   │   ├── news/
│   │   └── signals/
│   ├── components/
│   └── lib/
├── data/                     # SQLite DB + optional FinBERT model cache
├── scripts/                  # .bat wrappers for Task Scheduler
├── requirements.txt          # Python deps (vaderSentiment, alpaca-py, etc.)
├── requirements-optional.txt # Torch + transformers for FinBERT
└── .env                      # YOUR Alpaca keys — never commit
```

## Optional: FinBERT escalation

The bot scores every headline with VADER. If you install the optional deps:

```
pip install -r requirements-optional.txt
```

…then headlines that mention a universe ticker are *also* re-scored with
[ProsusAI/FinBERT](https://huggingface.co/ProsusAI/finbert). That label appears
on the news page. It adds ~0.3 s/headline on CPU — the bot's 5-min cycle still
fits comfortably.

## Things to know / limits

- **Alpaca free tier** returns IEX-only market data (≈3 % of volume). The bot
  handles this automatically, but exotic small-caps may have sparse bars.
- **Disclosure data is slow.** STOCK Act filings legally lag 30–45 days; 13F
  filings lag 45 days. This is an information-arbitrage signal, not day-trading
  alpha.
- **News scraping is RSS only** — no paywalled article text, no circumvention
  of terms.
- **Pattern-Day-Trader rule** doesn't apply: paper accounts default to ~$100k
  equity, well above the $25k threshold.
- **No backtesting** is bundled; beating SPY is plausible but not guaranteed.

## Troubleshooting

- `ModuleNotFoundError: pytz` → `pip install pytz` (transitive dep of `alpaca-py`).
- Dashboard shows nothing → the API isn't running. Check `scripts\run_api.bat`.
- `subscription does not permit querying recent SIP data` → the bot uses the
  IEX feed already; if this appears, one of your custom data calls is missing
  `feed=DataFeed.IEX`.
- Dev server "port 3000 in use" → `netstat -ano | findstr :3000`, then `taskkill /PID <pid> /F`.

## License

Personal project — no license file. Don't redeploy for others without adding one.
