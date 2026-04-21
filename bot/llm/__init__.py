"""LLM-driven fundamentals-swing strategy.

Five scheduled routines (premarket / execute / midday / close / weekly_review)
drive a Claude tool-use loop against `memory/*.md` + Alpaca + our scraped
news DB. The tool layer in ``bot.llm.tools`` is the trust boundary — every
hard cap on orders lives there, not in prompts.
"""
