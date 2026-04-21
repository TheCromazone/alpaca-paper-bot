"""One-off live smoke test: run the premarket routine against Anthropic API.

Forces DRY_RUN=true at the top so any accidental trade logic short-circuits,
then prints the resulting LLMRun row so we can eyeball token use, cost, and
which tools the model called.
"""
import os, sys
from pathlib import Path

# Ensure repo root is on the path when run via `python scripts/_smoke_premarket.py`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["DRY_RUN"] = "true"  # belt-and-braces; premarket has no buy/sell tools anyway

from sqlalchemy import desc, select

from bot.routines import premarket
from bot.db import LLMRun, SessionLocal


def main() -> int:
    print("=== Running premarket routine (DRY_RUN forced) ===")
    rid = premarket.run()
    print(f"LLMRun id: {rid}")
    if rid < 0:
        print("routine skipped (see log above)")
        return 1

    print()
    print("=== Run summary from DB ===")
    with SessionLocal() as s:
        row = s.scalars(
            select(LLMRun).order_by(desc(LLMRun.id)).limit(1)
        ).first()
    print(f"  routine:  {row.routine}")
    print(f"  status:   {row.status}")
    print(f"  model:    {row.model}")
    print(f"  tokens:   in={row.input_tokens}  out={row.output_tokens}  "
          f"cache_r={row.cache_read_tokens}  cache_w={row.cache_write_tokens}")
    print(f"  cost:     ${row.usd_cost:.4f}")
    print(f"  tools:    {row.tool_calls}   web_search={row.web_search_calls}")
    if row.error:
        print(f"  error:    {row.error}")
    print()
    print("=== tool_trace ===")
    for t in (row.tool_trace or []):
        args = t.get("args", {})
        ok = "ok" if t.get("ok") else "ERR"
        print(f"  [{ok}] {t.get('name')}({args})  {t.get('ms')}ms")
    print()
    print("=== final assistant summary (truncated) ===")
    print((row.summary or "").strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
