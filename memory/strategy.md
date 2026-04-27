# Trading strategy — LLM-driven fundamentals swing

## Objective

Beat SPY total return over rolling 3-month windows by holding 8–15 US large-cap
equities for 1–8 week horizons, chosen on fundamental catalysts (earnings,
product cycles, regulatory shifts, capital allocation) and corroborated by
recent news and disclosed positioning. Paper-only on Alpaca; every order must
respect the tool-layer caps — treat them as laws, not suggestions.

## Rules the tool layer enforces (do not try to evade)

- Max 5% of equity per new position at entry.
- Max 15 open positions.
- **Max 2 truly new tickers per day.** Top-ups to existing positions don't
  count, but a fresh name does. After hitting the cap, save other ideas for
  tomorrow's pre-market notes.
- Every buy opens with a 10% trailing stop placed automatically.
- Midday routine force-closes any position down 7%+ from avg cost.
- Thesis string ≥ 20 chars required on every buy/sell.
- No opposite-side trade on the same symbol within 3 trading days.
- Open opposite-side orders on the same symbol are auto-cancelled before
  every buy or sell (mitigates Alpaca's wash-trade rejection).

If you try to violate these, the tool returns `is_error=true` and your call is
a no-op. That's by design — do not re-try with a hack, re-think the trade.

## Rules you enforce yourself — judgment calls

- Prefer catalysts with a named, datable event (earnings date, FDA decision,
  product launch, index rebalance) over vague macro narratives.
- Avoid over-concentration: if you already hold 3+ names in a sector, require a
  notably stronger thesis to add a fourth.
- Prefer liquidity: avoid names with ADV under $50M notional.
- **Bond ETFs are opt-in only.** Do NOT buy AGG / BND / TLT / IEF / SHY / LQD
  / HYG / TIP for "diversification" or as a cash parking spot — there's no
  fixed-income floor. If you have a specific rate or duration thesis, fine;
  otherwise hold cash.
- **Avoid trading in the last 30 minutes of the session** (after 15:30 ET) —
  spreads widen, slippage costs more than any conviction edge.
- When in doubt, do nothing. Cash is a position.
- A trailing stop is your friend, not your enemy. Do not manually widen stops
  after a loss starts — that's how small losses become large ones.

## Lessons inherited from week 1 (composite-score quant strategy)

The previous strategy ran 2026-04-20 through 2026-04-24 and underperformed
SPY by 67 bps (+0.46% vs +1.13%) while doing 579 trades on a $50k account
($1M+ in churned notional). Top three failure modes — **don't repeat them**:

1. **Three tickers got 100% of action** (AGG, RTX, LMT). The strategy
   ping-ponged AGG ~80 times because two rules contradicted each other on
   the same symbol. *You* are responsible for breadth — aim for 8–15 names.
2. **44% of orders were rejected** by Alpaca as wash trades. Don't submit a
   sell while a buy is open on the same symbol (the tool layer now
   auto-cancels, but think before you call).
3. **Composite scores never crossed conviction thresholds**, so no new
   positions ever opened. Your job is to use *named catalysts* — earnings
   dates, FDA PDUFAs, product launches — to drive entry, not aggregated
   sentiment scores. When you can name the event and the date, take the
   trade. When you can't, hold cash.

## Research protocol (pre-market routine only)

1. `web_search` for macro / market catalysts from the last 24 hours — use
   specific queries ("today premarket movers", "earnings schedule [date]",
   "FDA PDUFA [month]"). Cite URLs you relied on in your thesis.
2. `get_recent_news` for deeper context on candidate tickers — these are
   scraped bodies from CNBC, Yahoo, MarketWatch, CNN Business, Seeking Alpha.
3. `get_recent_signals` to check politician / 13F tailwinds.
4. Append 2–3 actionable ideas into `research_log.md` under a new
   `## YYYY-MM-DD` header with subsection `### Pre-market`. Each idea gets:
   ticker, catalyst, thesis (≥ 2 sentences), target notional.

## Memory protocol

- `portfolio.md`: rewritten whole at the end of `execute` / `midday` / `close`.
  Format: two tables — an Account summary line and a Positions table — plus a
  one-line "as of" timestamp.
- `trade_log.md`: handled by the tool layer — you never write it directly.
- `research_log.md`: append-only. Each day has a `## YYYY-MM-DD` header with
  four subsections — `### Pre-market`, `### Execute`, `### Midday`, `### Close`.
  Fridays add a `## Weekly review YYYY-MM-DD` section at the end.
- `strategy.md` (this file): read-only from your side. The weekly-review
  routine may *propose* edits in `research_log.md`; the user applies them
  manually.
