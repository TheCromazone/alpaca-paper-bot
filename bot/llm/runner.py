"""Generic routine driver.

``run_routine`` takes a routine name (``premarket`` / ``execute`` / etc.) and
runs a Claude tool-use loop until the model stops calling tools, hits the
iteration ceiling, or blows past the daily USD budget. Each run is persisted
as one ``LLMRun`` row so the dashboard can reconstruct the conversation shape
without replaying the content.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any

from loguru import logger
from sqlalchemy import func, select

from bot.config import (
    LLM_MAX_TOOL_ITERATIONS,
    LLM_TURN_THROTTLE_SECONDS,
    LLM_PREMARKET_MAX_ITERATIONS,
    LLM_RATE_LIMIT_BACKOFF_BASE,
    LLM_RATE_LIMIT_BACKOFF_MAX,
    LLM_RATE_LIMIT_RETRIES,
    settings,
)
from bot.db import LLMRun, SessionLocal
from bot.llm import prompts, tools
from bot.llm.anthropic_client import AnthropicClient
from bot.llm.anthropic_client import compute_cost_usd as _anthropic_cost

try:
    from anthropic import RateLimitError as _RateLimitError  # SDK >=0.40
except Exception:  # pragma: no cover
    _RateLimitError = None  # type: ignore

try:
    from openai import RateLimitError as _OpenAIRateLimitError  # openai >=1.x
except Exception:  # pragma: no cover
    _OpenAIRateLimitError = None  # type: ignore


_SUMMARY_CAP_CHARS = 2048


def _today_usd_spent() -> float:
    """Sum of ``usd_cost`` for finished LLMRuns whose ``started_at`` is today
    (UTC). We include ``running`` rows too so a routine can't loop and double-
    spend inside itself — the accumulator handles the within-loop case."""
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    with SessionLocal() as s:
        total = s.scalar(
            select(func.coalesce(func.sum(LLMRun.usd_cost), 0.0))
            .where(LLMRun.started_at >= today_start)
        )
    return float(total or 0.0)


def _extract_text(content: list[dict]) -> str:
    """Concatenate ``text`` blocks from an assistant turn."""
    parts: list[str] = []
    for b in content:
        if b.get("type") == "text":
            parts.append(b.get("text", ""))
    return "\n".join(parts).strip()


def _args_summary(args: dict) -> dict:
    """Produce a compact summary of tool args for LLMRun.tool_trace so we
    don't persist an entire article body or memory file. Strings over 80
    chars are truncated; lists and dicts are preserved structurally."""
    out: dict[str, Any] = {}
    for k, v in args.items():
        if isinstance(v, str):
            out[k] = v if len(v) <= 80 else v[:77] + "..."
        else:
            out[k] = v
    return out


def _compute_cost(provider: str, usage: dict) -> float:
    """Per-token USD cost for the active provider.

    Codex via Plus is flat-fee; tokens are still counted for observability
    but the dollar figure is always 0.0 so the daily-budget guard never
    fires on that path.
    """
    if provider == "codex_oauth":
        return 0.0
    return _anthropic_cost(
        usage["input"], usage["output"],
        usage["cache_read"], usage["cache_write"], usage["web_search"],
    )


def run_routine(routine: str) -> int:
    """Drive one routine end-to-end. Returns the ``LLMRun.id``.

    Safe to call from tests with ``DRY_RUN=true`` — none of the buys / sells
    reach Alpaca in that mode.
    """
    provider = (settings.llm_provider or "anthropic").lower()

    # Provider-specific preflight + model selection
    if provider == "codex_oauth":
        active_model = settings.llm_model_codex
        # codex_auth manages the OAuth token; we don't gate on a key string.
    else:
        if not settings.anthropic_api_key:
            logger.warning(
                "run_routine({}): ANTHROPIC_API_KEY not set; skipping", routine
            )
            return -1
        active_model = settings.llm_model

    # Budget guard only applies to per-token providers. Codex/Plus is flat.
    budget = settings.llm_daily_usd_budget
    if provider == "codex_oauth":
        spent_already = 0.0
        budget_remaining = float("inf")
    else:
        spent_already = _today_usd_spent()
        budget_remaining = max(0.0, budget - spent_already)
        if budget_remaining <= 0:
            logger.warning(
                "run_routine({}): daily budget ${} exhausted (${:.2f} spent); skipping",
                routine, budget, spent_already,
            )
            return -1

    # --- Create LLMRun row upfront so it captures failures too. ---
    started = datetime.now(timezone.utc)
    with SessionLocal.begin() as s:
        row = LLMRun(
            routine=routine,
            started_at=started,
            model=active_model,
            status="running",
            tool_trace=[],
        )
        s.add(row)
        s.flush()
        run_id = row.id

    # --- Build system + first user message ---
    system = prompts.build_system_messages(budget_remaining, provider=provider)
    user_prompt = prompts.user_prompt_for(routine)
    messages: list[dict] = [{"role": "user", "content": user_prompt}]

    local_tools = tools.tools_for_routine(routine)
    # Codex/Plus OAuth path has no server-side web_search tool; surface that
    # difference to the model via the prompt (handled in prompts.py) rather
    # than wiring the SDK to a no-op.
    enable_web_search = (
        provider == "anthropic" and routine in {"premarket", "weekly_review"}
    )

    if provider == "codex_oauth":
        from bot.llm.openai_client import CodexClient  # local import — keeps anthropic-only deploys lighter
        client: Any = CodexClient(model=active_model)
    else:
        client = AnthropicClient(model=active_model)

    # Accumulators persisted to the row at the end.
    usage = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "web_search": 0}
    tool_trace: list[dict] = []
    final_text = ""
    status = "ok"
    error_msg: str | None = None

    # Premarket is the heaviest routine and the one that's been hitting 429s.
    # Use a tighter iteration ceiling for it; everyone else gets the default.
    iter_cap = LLM_PREMARKET_MAX_ITERATIONS if routine == "premarket" else LLM_MAX_TOOL_ITERATIONS

    try:
        for step in range(iter_cap):
            # Throttle: slow back-to-back turns so we don't burst past the
            # org's per-minute input-token limit. Skip the first turn.
            if step > 0 and LLM_TURN_THROTTLE_SECONDS > 0:
                time.sleep(LLM_TURN_THROTTLE_SECONDS)

            # Budget guard: recompute each iteration. (Codex/Plus path
            # returns 0.0 — the guard never fires; that's intentional.)
            in_flight_cost = _compute_cost(provider, usage)
            if provider != "codex_oauth" and spent_already + in_flight_cost > budget:
                logger.warning(
                    "run_routine({}): budget halt at step {} — spent ${:.3f} "
                    "(pre=${:.3f} + step=${:.3f}) > budget ${}",
                    routine, step, spent_already + in_flight_cost,
                    spent_already, in_flight_cost, budget,
                )
                status = "budget_halt"
                break

            # Adaptive 429 backoff. The SDK retries internally (max_retries=8)
            # but exhausts its budget turn-after-turn under sustained load —
            # exactly what killed premarket on May 4/5/6. We add a wider
            # exponential sleep so the rate-limit window has time to reset.
            turn = None
            last_rl_exc: Exception | None = None
            for attempt in range(LLM_RATE_LIMIT_RETRIES + 1):
                try:
                    turn = client.create_turn(
                        system=system,
                        messages=messages,
                        tools=local_tools,
                        enable_web_search=enable_web_search,
                    )
                    break
                except Exception as exc:
                    is_rl = (
                        (_RateLimitError is not None and isinstance(exc, _RateLimitError))
                        or (_OpenAIRateLimitError is not None and isinstance(exc, _OpenAIRateLimitError))
                    )
                    if not is_rl:
                        # Some 429s come back wrapped — fall back to status-code sniff.
                        is_rl = "429" in str(exc) or "rate_limit" in str(exc).lower()
                    if not is_rl or attempt >= LLM_RATE_LIMIT_RETRIES:
                        raise
                    last_rl_exc = exc
                    sleep_s = min(
                        LLM_RATE_LIMIT_BACKOFF_MAX,
                        LLM_RATE_LIMIT_BACKOFF_BASE * (2 ** attempt),
                    )
                    logger.warning(
                        "run_routine({}): 429 at step {} attempt {}; sleeping {}s before retry",
                        routine, step, attempt, sleep_s,
                    )
                    time.sleep(sleep_s)
            if turn is None:  # pragma: no cover  — unreachable, raise covered above
                raise RuntimeError(f"create_turn returned None after retries ({last_rl_exc!r})")
            usage["input"]        += turn.input_tokens
            usage["output"]       += turn.output_tokens
            usage["cache_read"]   += turn.cache_read_tokens
            usage["cache_write"]  += turn.cache_write_tokens
            usage["web_search"]   += turn.web_search_calls

            # Append the assistant turn verbatim so the next call sees the
            # full conversation (tool_use ids, etc.).
            messages.append({"role": "assistant", "content": turn.content})

            # Collect tool_use blocks, dispatch handlers, collect tool_results.
            tool_uses = [b for b in turn.content if b.get("type") == "tool_use"]
            if not tool_uses:
                # Model is done (end_turn). Capture its final text summary.
                final_text = _extract_text(turn.content)
                break

            tool_results: list[dict] = []
            for tu in tool_uses:
                tname = tu.get("name")
                targs = tu.get("input") or {}
                t0 = time.monotonic()
                ok = True
                try:
                    if not tools.routine_allows(tname, routine):
                        # Shouldn't happen — we filtered definitions — but
                        # defence-in-depth against a model that hallucinates
                        # a tool we didn't register.
                        raise tools.ToolError(
                            f"tool {tname!r} is not available in routine {routine!r}"
                        )
                    result = tools.handler_for(tname)(targs)
                    result_str = _jsonify(result)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu.get("id"),
                        "content": result_str,
                    })
                except tools.ToolError as exc:
                    ok = False
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu.get("id"),
                        "content": f"Error: {exc}",
                        "is_error": True,
                    })
                except Exception as exc:
                    ok = False
                    logger.exception("tool {} crashed: {}", tname, exc)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu.get("id"),
                        "content": f"Internal error: {exc!r}",
                        "is_error": True,
                    })
                finally:
                    tool_trace.append({
                        "name": tname,
                        "args": _args_summary(targs),
                        "ok": ok,
                        "ms": round((time.monotonic() - t0) * 1000, 1),
                    })

            messages.append({"role": "user", "content": tool_results})

            if turn.stop_reason == "end_turn":
                # Rare: model said end_turn *and* emitted tool_use blocks.
                # We handled the tool_use, but the model already thought it
                # was done; run one more turn with results so it can wrap up.
                continue
        else:
            # Ran out of iterations without natural end_turn.
            status = "failed"
            error_msg = (
                f"hit {iter_cap}-iteration ceiling without end_turn"
            )
            logger.warning("run_routine({}): {}", routine, error_msg)
    except Exception as exc:
        logger.exception("run_routine({}) crashed: {}", routine, exc)
        status = "failed"
        error_msg = repr(exc)

    # Final cost computation (provider-aware; codex_oauth returns 0.0).
    usd_cost = _compute_cost(provider, usage)

    with SessionLocal.begin() as s:
        row = s.get(LLMRun, run_id)
        row.finished_at = datetime.now(timezone.utc)
        row.status = status
        row.input_tokens = usage["input"]
        row.output_tokens = usage["output"]
        row.cache_read_tokens = usage["cache_read"]
        row.cache_write_tokens = usage["cache_write"]
        row.web_search_calls = usage["web_search"]
        row.usd_cost = usd_cost
        row.tool_calls = len(tool_trace)
        row.tool_trace = tool_trace
        row.summary = (final_text or "")[:_SUMMARY_CAP_CHARS]
        row.error = error_msg

    logger.info(
        "routine {} done: status={} tools={} tokens_in={} tokens_out={} "
        "cache_r={} cache_w={} web={} cost=${:.4f}",
        routine, status, len(tool_trace),
        usage["input"], usage["output"],
        usage["cache_read"], usage["cache_write"], usage["web_search"],
        usd_cost,
    )
    return run_id


def _jsonify(obj: Any) -> str:
    """Serialise handler output as a short JSON string for the Messages API."""
    import json
    try:
        return json.dumps(obj, default=str)
    except TypeError:
        return str(obj)
