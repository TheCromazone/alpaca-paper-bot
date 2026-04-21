"""The five scheduled LLM routines.

Each module exposes a ``run()`` function — that's what the scheduler calls.
All the real work happens in ``bot.llm.runner.run_routine``; these modules
exist so ``bot.main`` can ``from bot.routines import premarket`` without
pulling in the entire LLM engine, and so we have a natural place to add
per-routine pre-checks later (e.g. a DB warmup or a cache-prime step).
"""
