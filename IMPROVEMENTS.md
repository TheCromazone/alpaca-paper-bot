# Bot improvements — based on 14-day audit

> Generated 2026-05-07 from `scripts/_bot_audit.py`. All findings keyed to evidence in the live SQLite DB. Severity: 🔴 broken now · 🟠 silent failure · 🟡 quality.

---

## Top-line numbers

| | value | note |
|---|---|---|
| LLM runs (14d) | 34 | 31 ok / **3 failed** |
| LLM spend (14d) | $41.15 | $2.94/day avg, well under $12 cap |
| Cache hit ratio | **62.3%** | barely above the 60% alert threshold |
| Equity vs SPY (30d) | **+6.71% vs +3.94%** | +2.77pp alpha — but driven by INTC +35% |
| Trades (14d) | 139 (67 buy / 72 sell) | only **7 unique tickers** |
| Trade rejection rate | **36.7%** | 51 rejected, RTX (31) + AGG (20) dominate |
| Positions WITHOUT trailing stop | **13 / 14** | only INTC has a stop attached |
| Decisions with thesis ≥80 chars | **0 / 178** | every decision reason is a short programmatic string |

---

## 🔴 1. Premarket has been broken for 3 consecutive days

**Evidence**: `llm_runs` rows for May 4 / 5 / 6 at 11:00 UTC all `status='failed'` with `RateLimitError 429`. That's 3 consecutive trading days where the LLM never produced a thesis — `execute` had no plan to act on, and the day's research_log.md never got written.

**Root cause**: SDK's 8 internal retries get exhausted because turns are too fat. `bot/config.py:282` already notes "429 after 11 rapid tool-use turns — the org's tier-1 limit is 30k input tok/min." The 6s `LLM_TURN_THROTTLE_SECONDS` isn't enough when each turn carries cumulative tool results.

**Fix (in priority order)**:
1. **Bump `LLM_TURN_THROTTLE_SECONDS` from 6 → 12** in `bot/config.py`. Cheap. Buys margin.
2. **Cut tool-result payloads further**: `LLM_MAX_TOOL_RESULT_NEWS=8 → 5`, `LLM_MAX_TOOL_RESULT_SIGNALS=10 → 6`. Premarket eats most of the 30k budget on news.
3. **Add adaptive backoff in `bot/llm/runner.py`**: catch `RateLimitError`, sleep `min(60, 2^n × 6)` seconds, retry up to 3 times before declaring `status='failed'`. Right now the SDK's 8 retries hit the same wall back-to-back.
4. **Cap premarket-only iterations at 12** (vs the 20-iter ceiling). Apr-27/28 already hit 17 calls — premarket is doing too much research per session.

This is the single most important fix. Without premarket, the bot is flying blind.

---

## 🔴 2. AGG/RTX ping-pong is back — same failure mode the strategy.md *explicitly warns against*

**Evidence**: 98 AGG trades + 34 RTX trades = 95% of the last 14 days. Apr 24 alone: 59 AGG buys + 39 AGG sells, every 5 minutes. Decision reasons reveal the bug:
- `'fixed-income floor: bonds at X% below 10% target'` → triggers BUY
- `'rebalance trim: position is 10.0% of portfolio'` → triggers SELL on the *same position* the floor just bought

These two rules contradict on the same symbol every cycle. **This is exactly the failure** strategy.md inherits from the retired quant: *"ping-ponged AGG ~80 times because two rules contradicted each other on the same symbol."*

**Root cause**: `bot/strategy.py:119` (rebalance trim) and `bot/strategy.py:179` (fixed-income floor) are still being called somewhere. CLAUDE.md says `tick()` is "not scheduled" — but decisions are appearing every 5 min on Apr 24, so something is still firing them. Either:
- The legacy `tick()` cron got accidentally re-enabled
- Or another job calls these strategy.py functions

**Fix**:
1. **Comment out the fixed-income-floor rule entirely.** It contradicts strategy.md's bond-ETF-opt-in-only rule. Delete or disable `bot/strategy.py:179` block.
2. **Comment out the rebalance-trim rule.** The 5%-of-equity entry cap already prevents over-concentration; the trim rule fights the LLM's deliberate sizing.
3. **Verify `tick()` is not scheduled**: grep `bot/main.py` for `strategy_tick` cron registration; if present, remove.
4. **Add an integration test**: assert no scheduled job calls `bot.strategy.score_*` functions. Encode the retirement.

---

## 🟠 3. 13 of 14 positions have NO trailing stop

**Evidence**: positions table shows `stop_order_id IS NULL` on every position except INTC. Strategy.md guarantees: *"Every buy opens with a 10% trailing stop placed automatically."* Reality: 7% of buys have a stop.

**Root cause**: `bot/llm/tools.py:513` calls `submit_trailing_stop` best-effort and catches the exception (intentional — Alpaca rejects GTC trailing stops on fractional positions). The note in CLAUDE.md acknowledges this. But the safety net relies entirely on midday's 7%-from-cost rule, which:
- Only fires once a day at 13:00 ET
- Doesn't protect against an overnight gap
- Doesn't trail with the price (a winner that runs +20% then drops -10% from peak isn't caught — it'd need to drop 7% below cost)

**Fix**:
1. **Try DAY trailing stops for fractional, GTC for whole-share**. Alpaca accepts DAY trailing stops on fractional. Re-submit each morning's DAY stops on the `execute` routine.
2. **Or**: implement a *synthetic* server-side trailing stop tracked in `Position.peak_price` + `Position.stop_price` columns; have `sync_account_job` (every 5 min) check if `market_price < stop_price` and force-close. Decouples the safety net from Alpaca's order types entirely.
3. **Surface the gap on the dashboard**. `BotRibbon` should show "13/14 positions unprotected" in red so it's visible without running an audit.

---

## 🟠 4. Theses are programmatic strings, not LLM reasoning

**Evidence**: 178 decisions in 14d, **zero** with `reason` ≥200 chars. Examples:
- `'fixed-income floor: bonds at 10.0% below 10% target'` (53 chars)
- `'trailing stop: price 174.56 fell >7% from peak 196.03'` (53 chars)

These are auto-generated. None contain catalysts, dates, fundamentals — the kind of thesis the LLM is *supposed* to produce per strategy.md's "thesis (≥ 2 sentences)" research-protocol rule.

**Root cause**: `bot/llm/tools.py:538` writes `reason=thesis` into Decision rows — so when the LLM places a real buy via `place_buy`, the rich thesis IS captured. The flood of short reasons all come from `bot/strategy.py` (the retired quant). Once you kill the quant per #2, this fixes itself.

**Verify after fix**: run the audit again in a week. Expect ≥80% of new decisions to have ≥80-char reasons (the LLM's actual research output).

---

## 🟡 5. Cache hit ratio at the alert threshold

**Evidence**: 62.3% (anything <60% triggers the project's own alert). Cache_write/read ratio = 0.67, suggesting strategy.md gets re-cached often.

**Root cause hypothesis**: each routine creates a fresh cache breakpoint instead of reusing the same one. Or strategy.md is being modified inside the day (e.g., by an in-progress edit).

**Fix**:
1. Open `bot/llm/anthropic_client.py`, find where `cache_control: ephemeral` is attached. Confirm it's on the strategy.md system block, not on per-routine suffixes.
2. Don't let `weekly_review` write strategy.md. Strategy.md should change at most once per week, manually, *outside* trading hours.
3. Add a dashboard line: `cache_hit_ratio: 62.3% ⚠`. Threshold visibility.

---

## 🟡 6. Wash-trade rejections still 36.7%

**Evidence**: 51 rejected of 139 trades. RTX (31) + AGG (20) — the same names being ping-ponged. This is partly downstream of #2 (kill the rebalance rules and most of these rejections vanish).

**After #2**: re-measure. If still >5% on LLM-only routines, harden `_cancel_open_orders_for(symbol, side=...)` — add a 500ms sleep after cancel before submitting the new order so Alpaca's order book has time to clear.

---

## 🟡 7. Equity outperformance is INTC concentration luck

**Evidence**: +2.77pp alpha over 30d. INTC alone is +35.44% on a position opened 5 days ago. Strip INTC and the bot likely *underperforms* SPY.

**Implication**: don't trust the alpha number until the book has 8+ winning positions of comparable weight. Right now the strategy is "got one trade right, breaking even on the rest." Use this as honesty in any resume / website framing — the system is *running* well, the *strategy* hasn't been validated.

**Operational fix**: lock in the INTC gain. Tighten its trailing stop to 5% manually via the dashboard's manual-trade panel, or wait for `midday` to do it (positions up ≥15% should auto-tighten to 7%).

---

## 🟡 8. Off-hours scrapers fail occasionally

**Evidence**: 5 failures in 14d on `article_scrape_offhours` (3) + `news_refresh_offhours` (2). All at night/weekend. Probably DNS or rate-limit blips.

**Fix**: wrap each feed fetch in `bot/news/rss_scraper.py` with `tenacity.retry(stop=stop_after_attempt(3), wait=wait_exponential(min=2, max=30))`. Don't fail the whole job if 1 of 7 feeds is unreachable.

---

## Suggested execution order

| # | Severity | Fix | Effort |
|---|---|---|---|
| 1 | 🔴 | Throttle bump + adaptive backoff (premarket) | 30 min |
| 2 | 🔴 | Disable strategy.py rebalance + bond-floor rules | 15 min |
| 3 | 🟠 | DAY trailing stops + synthetic stop fallback | 2 hr |
| 4 | 🟠 | Verify thesis quality post-fix #2 | passive |
| 5 | 🟡 | Cache discipline audit | 45 min |
| 6 | 🟡 | Re-measure rejection rate post-#2 | passive |
| 7 | 🟡 | Honest framing of alpha | 0 |
| 8 | 🟡 | Resilient RSS scraping | 20 min |

Total: ~3 hours of work clears every 🔴 and 🟠. Run `scripts/_bot_audit.py` again after to verify.

---

## Quick wins you can ship today (≤30 min total)

```bash
# bot/config.py
LLM_TURN_THROTTLE_SECONDS = 12          # was 6
LLM_MAX_TOOL_RESULT_NEWS  = 5           # was 8
LLM_MAX_TOOL_RESULT_SIGNALS = 6         # was 10

# bot/main.py — confirm absence of strategy_tick cron registration
# bot/strategy.py — comment out lines 119 and 179 blocks (rebalance + bond-floor)

# Restart bot so new config loads:
#   kill python.exe processes matching *bot.main*
#   relaunch via scripts\run_bot.bat (or background launch)
```

Then watch tomorrow's `premarket` LLMRun. Expected: status=ok, 8–12 tool calls, fresh thesis ≥200 chars, no AGG/RTX trades from `bot.strategy`.
