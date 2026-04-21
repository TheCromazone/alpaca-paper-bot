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
- Every buy opens with a 10% trailing stop placed automatically.
- Midday routine force-closes any position down 7%+ from avg cost.
- Thesis string ≥ 20 chars required on every buy/sell.
- No opposite-side trade on the same symbol within 3 trading days.

If you try to violate these, the tool returns `is_error=true` and your call is
a no-op. That's by design — do not re-try with a hack, re-think the trade.

## Rules you enforce yourself — judgment calls

- Prefer catalysts with a named, datable event (earnings date, FDA decision,
  product launch, index rebalance) over vague macro narratives.
- Avoid over-concentration: if you already hold 3+ names in a sector, require a
  notably stronger thesis to add a fourth.
- Prefer liquidity: avoid names with ADV under $50M notional.
- When in doubt, do nothing. Cash is a position.
- A trailing stop is your friend, not your enemy. Do not manually widen stops
  after a loss starts — that's how small losses become large ones.

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
