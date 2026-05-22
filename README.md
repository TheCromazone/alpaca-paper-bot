# Alpaca Paper Trading Bot — LLM-driven fundamentals swing

An autonomous paper-trading bot for [Alpaca](https://alpaca.markets/) that
runs a **Claude/GPT tool-use loop five times a week**, reads markdown
"memory" files like a portfolio manager would, researches catalysts using
scraped news + politician trades + 13F filings + market-regime snapshots,
and places trades — every cap enforced server-side in the Python tool layer
so the model can't ever evade them. A separate Next.js dashboard renders
the live portfolio, trade journal with reasoning, signal feed, and LLM-run
ledger.

> ⚠️ **Paper only.** Pointed at `paper-api.alpaca.markets`. No real money is at risk.
>
> 🔐 Real keys live in `.env` (gitignored). Never commit `.env`, `.codex-auth/`, or `logs/`.

---

## How the bot works now

The repo also contains a retired composite-score quant strategy
(`bot/strategy.py`, called via `python -m bot.main --once`). That code is
preserved for A/B comparison but **is not scheduled**. The live strategy
is the five LLM routines below.

### Five routines per week

Each routine is one Claude/GPT tool-use loop persisted as one `LLMRun` row
in SQLite. Times are anchored to `America/New_York`, so DST is automatic.

| Routine | ET time | What it can do |
|---|---|---|
| `premarket` | Mon–Fri **07:00** | Research only — `web_search` (Anthropic path), read scraped news + signals, read upcoming earnings + market regime, append a dated section to `memory/research_log.md` with 2–3 catalyst-driven ideas. No trades. |
| `execute` | Mon–Fri **09:30** | The only buy window — reads today's pre-market ideas, calls `place_buy(symbol, notional, thesis)`. Hard caps enforced in code: 5%/position, 2 fresh tickers/day, 25-position max, 10% trailing stop attached automatically (best-effort). |
| `midday` | Mon–Fri **13:00** | The only sell window — force-closes anything ≥7% under cost, tightens stops on big winners. |
| `close` | Mon–Fri **16:00** | Log only — appends day P/L, top winner, top loser, one thing to watch tomorrow. |
| `weekly_review` | Fri **17:00** | Post-mortem — reads last 5 days, scores hit-rate, proposes (in plain text) up to 3 edits to `memory/strategy.md`. The user applies them manually. |

### The trust boundary

`bot/llm/tools.py` is the **enforcement point**, not the prompt. Every cap
lives in handler code:

- Max 5% of equity per new position at entry
- Max 25 open positions
- Max 2 fresh tickers per day
- 10% trailing stop attached to every buy (best-effort — Alpaca rejects GTC
  trailing stops on fractional positions, so a synthetic stop runs every
  5 min in `_sync_account_and_positions`)
- 7% midday force-close from average cost
- 3-day wash-trade lookback (refuse opposite-side trade on the same symbol)
- 120-char structured 5-field thesis required on every buy/sell
- Bond ETFs are opt-in only (no automatic fixed-income floor)

If a handler returns `is_error=true`, the model sees the refusal reason
and re-thinks. The model proposes; tools verify and execute.

### Memory files (in `memory/`)

Four markdown files are the bot's persistent state across restarts. Two
are read-only from the LLM's side, two are written by the routines.

| File | Written by | Purpose |
|---|---|---|
| `strategy.md` | You (manually) | The rulebook. Injected into the system prompt with a prompt-cache breakpoint on the Anthropic path. |
| `playbook.md` | You (manually) | Research playbook — 5-field idea template, bull/base/bear earnings prep, catalyst taxonomy, weekly-review rubric. |
| `catalysts.md` | You (manually) | Macro calendar — FOMC, CPI, jobs, earnings anchor weeks. |
| `portfolio.md` | Routines | Rewritten whole at the end of every trading routine. |
| `trade_log.md` | Tool layer | Append-only by the `place_buy` / `place_sell` handlers. The LLM cannot write it directly. |
| `research_log.md` | Routines | Append-only daily ledger — pre-market ideas, execute actions, midday triage, close summary. |

### LLM provider

Two backends are supported via `LLM_PROVIDER` in `.env`:

- **`codex_oauth`** (default) — uses the [`codex-auth`](https://pypi.org/project/codex-auth/)
  PyPI shim to call OpenAI's Codex endpoint with your **ChatGPT Plus/Pro
  OAuth token** (cached at `~/.codex-auth/auth.json`, auto-refreshed).
  $0 per call under the Plus subscription. Default model: `gpt-5.5`.
- **`anthropic`** — Claude Messages API with prompt caching. Per-token
  billing. Default model: `claude-opus-4-7`. Set `ANTHROPIC_API_KEY`.

Both paths go through the same runner (`bot/llm/runner.py`), the same tool
registry (`bot/llm/tools.py`), and the same memory files. Swapping is one
env-var change.

### Signal pipeline feeding the LLM

Every signal source is its own scheduled job. The LLM reads the resulting
rows via tools — it does not scrape itself.

| Source | Module | Cadence | LLM tool |
|---|---|---|---|
| News + VADER sentiment | `bot/news/`, `bot/signals/sentiment.py` | every 15 min, 24/7 | `get_recent_news` |
| House PTRs (politician trades) | `bot/signals/politicians.py` | daily 07:00 UTC | `get_recent_signals`, `get_politician_trades` |
| Senate PTRs (eFD) | `bot/signals/senate.py` | daily 07:30 UTC | same as above |
| 13F filings (30 funds) | `bot/signals/investors.py` | weekly Sun 06:00 UTC | `get_recent_signals` |
| Price history (daily closes) | `bot/main.py:_refresh_price_history` | weekday 20:30 UTC | used by regime + dashboard tape |
| Market regime (VIX, SPY trend, T10Y2Y, breadth) | `bot/signals/regime.py` | daily 21:00 UTC | `get_market_regime`; also injected into every routine's system prompt prelude |
| Earnings calendar | `bot/signals/earnings.py` | daily 22:00 UTC | `get_upcoming_earnings` |

Politician and investor signals carry per-source conviction weights
(`POLITICIAN_WEIGHTS`, `INVESTOR_WEIGHTS` in `bot/config.py`) so
Pelosi/Berkshire moves count more than backbenchers / multi-strats.

---

## Three processes

| Process | Port | What | Launched by |
|---|---|---|---|
| Bot scheduler | — | APScheduler `BlockingScheduler` (`python -m bot.main`) running the 5 LLM routines + signal jobs | `scripts\run_bot.bat` |
| FastAPI service | `127.0.0.1:8765` | Read-only API over the SQLite DB | `scripts\run_bot.bat` |
| Next.js dashboard | `http://localhost:3001` | Live UI — portfolio, trade journal with reasoning, LLM run history, cost card, regime, earnings, signals | `scripts\run_bot.bat` |

`scripts\run_bot.bat` launches all three together. `scripts\run_dashboard.bat`
just brings up API + dashboard for UI work without the trading bot.

> **Port note:** dashboard is on **3001**, not 3000. Pinned in
> `dashboard/package.json` (`next dev -p 3001`).

---

## Quick start

```powershell
# One-time setup (Python 3.14 + Node 22+)
py -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt

cd dashboard
npm install
cd ..

# Copy + fill in your keys
copy .env.example .env
notepad .env              # paste Alpaca paper-trading keys, SEC user-agent

# Initialize the DB
.venv\Scripts\python -c "from bot.db import init_db; init_db()"
```

### Sign in to GPT Codex (one-time, for the default provider)

```powershell
.venv\Scripts\python.exe scripts\_codex_oauth_bootstrap.py
```

A browser window opens to `auth.openai.com`. Sign in with the ChatGPT
Plus account you want the bot to use. Token gets cached at
`%USERPROFILE%\.codex-auth\auth.json` and is refreshed automatically. The
script ends with `✓ OAuth round-trip ok` and a one-sentence hello from
GPT-5.5 confirming the bridge works.

If you prefer the Anthropic path instead: set `LLM_PROVIDER=anthropic` and
`ANTHROPIC_API_KEY=sk-ant-...` in `.env`; skip the bootstrap.

### Boot everything

```powershell
scripts\run_bot.bat
```

Opens three hidden background processes (bot, API, dashboard). Dashboard
is at **http://localhost:3001**. Logs land in `logs/`.

### Put the bot on a Windows schedule

```powershell
scripts\register_task.bat
```

Registers `AlpacaBot` under Task Scheduler. Weekdays at 06:25 PT it
runs `run_bot.bat` — but `MultipleInstancesPolicy=IgnoreNew` means it's
a no-op if the bot is already alive. Works as a daily wake-up health
check rather than a daily restart. Stop with:

```powershell
schtasks /Delete /TN AlpacaBot /F
```

---

## Safety dials (in `.env`)

| Variable | Default | Effect |
|---|---|---|
| `DRY_RUN` | `false` in `.env`, `true` in `.env.example` | When `true`, every `place_buy` / `place_sell` returns a fake `DRY-<uuid>` order id and writes a `dry_run` Trade row. Watch a few days like this before flipping. |
| `LLM_PROVIDER` | `codex_oauth` | `codex_oauth` (free under Plus) or `anthropic` (paid per-token). |
| `LLM_DAILY_USD_BUDGET` | `12.00` | Hard cap on Anthropic spend per day. Routine halts with `status='budget_halt'` when exceeded. Ignored on the Codex path (flat-fee subscription). |
| `ALPACA_BASE_URL` | `https://paper-api.alpaca.markets/v2` | Never change this. |

---

## Project layout

```
alpaca paper trading/
├── bot/
│   ├── main.py                   # APScheduler + all the cron jobs
│   ├── alpaca_client.py          # Alpaca SDK wrapper
│   ├── config.py                 # Universe, caps, signal weights
│   ├── db.py                     # SQLAlchemy models (LLMRun, Trade, etc.)
│   ├── strategy.py               # RETIRED composite-score quant tick
│   ├── llm/
│   │   ├── runner.py             # Tool-use loop driver (provider-aware)
│   │   ├── anthropic_client.py   # Anthropic Messages API wrapper
│   │   ├── openai_client.py      # OpenAI Codex/OAuth adapter (codex-auth)
│   │   ├── prompts.py            # System + per-routine user prompts
│   │   ├── tools.py              # The trust boundary
│   │   └── memory.py             # read/write/append the memory/*.md files
│   ├── news/                     # RSS scrapers + article fetcher
│   └── signals/                  # sentiment, politicians, senate, investors,
│                                 # regime, earnings
├── api/
│   └── main.py                   # FastAPI on 127.0.0.1:8765
├── dashboard/                    # Next.js 16 + React 19
│   ├── app/                      # Pages — front page, positions, trades, etc.
│   ├── components/               # BotRibbon, ThesisPanel, LLMCostCard, ...
│   ├── e2e/                      # Playwright suite, chromium-only
│   └── playwright.config.ts
├── memory/                       # The bot's persistent state
│   ├── strategy.md               # Rulebook (manually edited)
│   ├── playbook.md               # Research playbook (manually edited)
│   ├── catalysts.md              # Macro calendar (manually edited)
│   ├── portfolio.md              # Regenerated every trading routine
│   ├── trade_log.md              # Append-only by the tool layer
│   └── research_log.md           # Append-only daily ledger
├── scripts/
│   ├── run_bot.bat               # Boots all three services
│   ├── run_dashboard.bat         # API + dashboard only (no trading)
│   ├── register_task.bat         # Windows Task Scheduler hook
│   ├── _codex_oauth_bootstrap.py # One-shot Codex OAuth sign-in
│   ├── _smoke_premarket.py       # Manually fire one premarket routine
│   ├── _perf_audit.py            # Read-only audit: LLM runs, trades, equity
│   └── _postmortem.py            # Last 8 days postmortem
├── data/                         # SQLite DB lives here
├── logs/                         # Per-process stdout/stderr (gitignored)
└── .env                          # YOUR keys — never commit
```

---

## Useful commands

```powershell
# Manually fire one routine end-to-end (DRY_RUN forced inside the script)
.venv\Scripts\python scripts\_smoke_premarket.py

# Read-only performance audit — last 14 days of LLMRuns, trades, positions
.venv\Scripts\python scripts\_perf_audit.py

# Postmortem: last 8 days of trades + decisions + equity vs SPY
.venv\Scripts\python scripts\_postmortem.py

# Run a single retired-quant tick for A/B comparison (writes Decision rows)
.venv\Scripts\python -m bot.main --once

# Dashboard E2E (Playwright, against the live stack)
cd dashboard
npm run test:e2e
npx playwright test debug-refresh --headed   # diagnostic spec
```

---

## Things to know / limits

- **Alpaca free tier** returns IEX-only market data (~3% of consolidated
  volume). Handled automatically. Exotic small-caps may have sparse bars.
- **Disclosure data is slow.** STOCK Act filings lag 30–45 days; 13F lag
  45 days. This is an information-arbitrage signal, not day-trading alpha.
- **News scraping is RSS only** — no paywalled content, no scraping around
  terms.
- **`codex-auth` is alpha.** OpenAI doesn't officially support programmatic
  use of the Plus-subscription Codex endpoint. The Anthropic path is the
  guaranteed-stable fallback if the OAuth lib breaks.
- **No backtesting** is bundled. Beating SPY is plausible but not guaranteed.

## Troubleshooting

- `ModuleNotFoundError: bot` when running a script → start it from the
  project root, or rely on the `sys.path.insert(...)` already at the top
  of scripts in `scripts/`.
- `Unsupported parameter: max_output_tokens` on Codex calls → already
  worked around in `bot/llm/openai_client.py`; if you see it elsewhere,
  drop the kwarg.
- Dashboard shows nothing → API isn't running. `curl http://127.0.0.1:8765/bot/status`.
- BotRibbon says "last tick: 4 days ago" but routines have been firing →
  fixed (see `CLAUDE.md` § *Watch out for `/bot/status`*).
- Codex OAuth fails after weeks of working → delete `~/.codex-auth/auth.json`
  and re-run `scripts\_codex_oauth_bootstrap.py`.

## License

Personal project — no license file. Don't redeploy for others without
adding one.
