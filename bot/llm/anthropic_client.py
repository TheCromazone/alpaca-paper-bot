"""Thin wrapper around Anthropic's Messages API.

Responsibilities:
- Hide the SDK version churn behind one ``create_turn`` call.
- Compute USD cost from token usage using a baked-in price table. This is
  an approximation — Anthropic publishes final pricing on invoices — but
  it's accurate enough to enforce a daily budget guardrail.
- Expose ``usage`` as a plain dict the runner can accumulate into LLMRun.

The Messages API does its own tool-use loop orchestration (we hand it tools,
it returns ``tool_use`` content blocks, we reply with ``tool_result`` blocks,
it keeps going). That loop lives in ``bot.llm.runner``; this file only makes
a single turn.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from anthropic import Anthropic

from bot.config import settings


# Per-1M-token USD pricing. Kept conservative — when Anthropic changes
# pricing, update here; the daily budget guard will tighten automatically.
# Current public pricing for Opus-class models (Apr 2026 reference):
#   input:        $15 / 1M
#   output:       $75 / 1M
#   cache write:  $18.75 / 1M  (1.25× input)
#   cache read:   $1.50 / 1M   (0.10× input)
#   web_search:   $10 / 1000 searches (built into server tool pricing)
_PRICE_PER_1M = {
    "input":       15.00,
    "output":      75.00,
    "cache_write": 18.75,
    "cache_read":   1.50,
}
_WEB_SEARCH_PER_CALL = 10.00 / 1000


def compute_cost_usd(
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int,
    cache_write_tokens: int,
    web_search_calls: int,
) -> float:
    return (
        input_tokens       * _PRICE_PER_1M["input"]       / 1_000_000
        + output_tokens    * _PRICE_PER_1M["output"]      / 1_000_000
        + cache_read_tokens  * _PRICE_PER_1M["cache_read"]  / 1_000_000
        + cache_write_tokens * _PRICE_PER_1M["cache_write"] / 1_000_000
        + web_search_calls * _WEB_SEARCH_PER_CALL
    )


@dataclass
class Turn:
    """Result of one Messages API call."""
    stop_reason: str
    content: list[dict] = field(default_factory=list)  # raw content blocks
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    web_search_calls: int = 0


class AnthropicClient:
    """Stateless wrapper — callers pass full message history each turn."""

    def __init__(self, api_key: str | None = None, model: str | None = None) -> None:
        self.model = model or settings.llm_model
        self.client = Anthropic(api_key=api_key or settings.anthropic_api_key)

    def create_turn(
        self,
        *,
        system: list[dict],
        messages: list[dict],
        tools: list[dict],
        max_tokens: int = 4096,
        enable_web_search: bool = False,
        web_search_max_uses: int = 5,
    ) -> Turn:
        """Send one message-turn and return structured results.

        ``system`` and ``messages`` follow Anthropic's Messages API shape.
        Web search is enabled by passing the server tool spec in ``tools``
        alongside our local tool definitions — the SDK handles routing.
        """
        extra_tools: list[dict] = []
        if enable_web_search:
            extra_tools.append({
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": web_search_max_uses,
            })

        resp = self.client.messages.create(
            model=self.model,
            system=system,
            messages=messages,
            tools=tools + extra_tools,
            max_tokens=max_tokens,
        )

        usage = getattr(resp, "usage", None)
        in_tok = getattr(usage, "input_tokens", 0) or 0
        out_tok = getattr(usage, "output_tokens", 0) or 0
        cr_tok = getattr(usage, "cache_read_input_tokens", 0) or 0
        cw_tok = getattr(usage, "cache_creation_input_tokens", 0) or 0

        # Count web_search server-tool invocations inside content blocks.
        ws_calls = 0
        content_list: list[dict] = []
        for block in resp.content:
            # Each block is a pydantic model; serialise to dict for persistence.
            try:
                block_dict = block.model_dump()
            except AttributeError:
                block_dict = dict(block)
            content_list.append(block_dict)
            if block_dict.get("type") == "server_tool_use" and block_dict.get("name") == "web_search":
                ws_calls += 1

        return Turn(
            stop_reason=resp.stop_reason or "end_turn",
            content=content_list,
            input_tokens=in_tok,
            output_tokens=out_tok,
            cache_read_tokens=cr_tok,
            cache_write_tokens=cw_tok,
            web_search_calls=ws_calls,
        )
