"""System + user prompt templates for the five routines.

The system prompt is split into three pieces so the largest chunk (strategy.md)
sits behind an Anthropic prompt-cache breakpoint — subsequent routines the
same day read it at cache-read pricing instead of full input-token pricing.
That alone cuts our daily LLM bill by 3-5×.
"""
from __future__ import annotations

from datetime import datetime, timezone

from bot.config import settings
from bot.llm import memory

# ---- Prelude (short, not cached) ------------------------------------------
# Things that change every call go here: today's date, dry-run flag, budget
# remaining. Keeping this small keeps the cache-miss bill small on tail calls.

PRELUDE_TEMPLATE = """You are the portfolio manager for a paper Alpaca trading account.
Today is {date_iso}. Current UTC time: {now_iso}.

DRY_RUN={dry_run}. Daily LLM budget remaining: ${budget_remaining:.2f}.

Use the tools provided to read memory, research the market, and execute trades.
Never fabricate prices or positions — always use a tool to look them up. The
tool layer enforces hard caps on order size, position count, trailing stops,
and wash-trade windows; if a tool returns is_error=true, re-think the trade
rather than retrying. When you're done with the routine's objective, stop
calling tools and emit a short plain-text summary of what you did.
"""

# ---- Strategy block (cached via cache_control: ephemeral) -----------------
# The whole of memory/strategy.md is injected here. Anthropic's prompt cache
# keyed on exact-bytes match of the cached segment, so any edit to
# strategy.md correctly busts the cache on the next routine.

STRATEGY_BLOCK_TEMPLATE = """<strategy_file path="memory/strategy.md">
{strategy_text}
</strategy_file>
"""

# ---- Per-routine user prompts (short, not cached) -------------------------

PREMARKET_PROMPT = """Routine: pre-market research. No trades are placed this routine — you are
strictly researching.

Do the following in order:
1. Call read_memory('portfolio') and read_memory('research_log') to see the
   current book and yesterday's notes.
2. Call web_search two or three times for overnight and early-morning
   catalysts (macro, earnings, sector-moving news). Vary the queries; don't
   waste searches on duplicates.
3. For each candidate ticker you're considering, call get_recent_news to see
   what our scraped feed has on it, and get_recent_signals to check for
   politician or 13F tailwinds.
4. Append a dated section to research_log.md using append_memory. Format:

    ## YYYY-MM-DD
    ### Pre-market
    - **TICKER** (~$notional): catalyst in one line. thesis in two
      sentences. cite URLs from web_search you relied on.
    - (two or three ideas total; quality > quantity)

When the section is written, stop — do not place orders.
"""

EXECUTE_PROMPT = """Routine: market-open execution. The execute window is the one place buys
happen. You have ~10 minutes to decide and act before this routine's context
goes stale.

Do the following in order:
1. Call read_memory('research_log') to read today's Pre-market section.
2. Call get_portfolio to confirm live account state. Do NOT trust stale
   portfolio.md — always get fresh numbers from the tool.
3. For each idea you still believe, call place_buy(symbol, notional_usd,
   thesis). A 10% trailing stop is attached automatically. If place_buy
   returns is_error=true, read the reason and move on — do not hack around
   the validation.
4. After all buys, call write_memory('portfolio', <markdown snapshot>) with
   the fresh book. Format:

    # Portfolio — as of YYYY-MM-DD HH:MM UTC
    Equity: $X   Cash: $Y   Buying power: $Z
    | Ticker | Qty | Avg cost | Mkt price | Mkt value | Unrealized P/L |
    |---|---|---|---|---|---|
    | ... |

5. Append a brief Execute subsection to research_log.md summarising what you
   bought and what you skipped and why.
"""

MIDDAY_PROMPT = """Routine: midday risk scan. Cut losers, tighten winners, do not open fresh
positions.

Do the following:
1. Call get_portfolio.
2. For each position down 7% or more from avg_cost, call place_sell(symbol,
   'all', reason). Use a reason string that names the stop-loss rule.
3. For each position up 15% or more from avg_cost, call set_trailing_stop
   with a tighter trail (7%) to lock in gains.
4. Append a Midday subsection to research_log.md summarising the actions.
5. Regenerate portfolio.md with the post-midday state.
"""

CLOSE_PROMPT = """Routine: market close wrap-up. No trades — this is a log-only routine.

Do the following:
1. Call get_portfolio.
2. Read this morning's portfolio snapshot from memory (read_memory('portfolio')
   gives you the state at execute-time — it'll be overwritten at the end of
   this routine).
3. Append a Close subsection to research_log.md with: day P/L (dollars and
   percent), top winner, top loser, one thing to watch going into tomorrow.
4. Regenerate portfolio.md with the closing state.
"""

WEEKLY_REVIEW_PROMPT = """Routine: Friday weekly review. Post-mortem on the week.

Do the following:
1. read_memory('research_log') and read_memory('trade_log') — look at the
   last five trading days' entries.
2. Identify patterns: which theses worked, which didn't, which routine calls
   you'd reverse in hindsight.
3. (Optional) web_search for narratives you may have missed — earnings
   surprises, sector rotations you weren't positioned for.
4. Append a `## Weekly review YYYY-MM-DD` section to research_log.md. End it
   with up to 3 proposed edits to strategy.md (in plain text — you CANNOT
   write strategy.md yourself; the user applies edits manually).
"""

ROUTINE_PROMPTS: dict[str, str] = {
    "premarket":      PREMARKET_PROMPT,
    "execute":        EXECUTE_PROMPT,
    "midday":         MIDDAY_PROMPT,
    "close":          CLOSE_PROMPT,
    "weekly_review":  WEEKLY_REVIEW_PROMPT,
}


def build_system_messages(budget_remaining_usd: float) -> list[dict]:
    """Return the list of content blocks for the system prompt.

    Returns two blocks: the prelude (uncached) and the strategy block
    (cached via ``cache_control: ephemeral``). Anthropic's Messages API
    accepts this as ``system=[{...}, {...}]``.
    """
    now = datetime.now(timezone.utc)
    prelude = PRELUDE_TEMPLATE.format(
        date_iso=now.date().isoformat(),
        now_iso=now.isoformat(timespec="seconds"),
        dry_run=str(settings.dry_run).lower(),
        budget_remaining=budget_remaining_usd,
    )
    strategy_text = memory.read("strategy")
    strategy_block = STRATEGY_BLOCK_TEMPLATE.format(strategy_text=strategy_text)
    return [
        {"type": "text", "text": prelude},
        {
            "type": "text",
            "text": strategy_block,
            "cache_control": {"type": "ephemeral"},
        },
    ]


def user_prompt_for(routine: str) -> str:
    if routine not in ROUTINE_PROMPTS:
        raise KeyError(f"unknown routine: {routine}")
    return ROUTINE_PROMPTS[routine]
