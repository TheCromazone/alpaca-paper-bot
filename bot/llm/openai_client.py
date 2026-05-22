"""OpenAI Codex (ChatGPT Plus OAuth) client adapter.

Mirrors ``bot.llm.anthropic_client.AnthropicClient.create_turn`` so the runner
stays provider-agnostic. Importing ``codex_auth`` monkey-patches the OpenAI
Python SDK to use the OAuth token cached at ``~/.codex-auth/auth.json``
(refreshed automatically) instead of an API key — i.e. calls are billed to
the user's ChatGPT Plus subscription, not as API tokens.

Shape contract identical to AnthropicClient:
  in:   Anthropic-style system blocks, messages, tools  (what the runner builds)
  out:  ``Turn`` dataclass with Anthropic-shape ``content`` blocks  (what the
        runner already knows how to parse)

Cost: $0/call under the Plus subscription. ChatGPT-tier rate limits apply;
the runner's 429 backoff handles bursts the same way it did for Anthropic.

Caveats:
  - codex-auth is alpha (v0.1.x). If OpenAI changes the OAuth protocol, the
    lib breaks and so does this path. Anthropic remains as the fallback —
    flip ``LLM_PROVIDER=anthropic`` in .env.
  - No prompt-caching equivalent. The strategy.md block is sent in full on
    every routine. Doesn't matter for cost (flat sub) but does count toward
    the per-minute input-token rate limit; the runner's throttle still helps.
  - Anthropic's server-side ``web_search`` tool has no Codex equivalent
    surfaced through this OAuth path. Premarket/weekly_review will run
    without it; the model still has ``get_recent_news`` for local-DB news.
"""
from __future__ import annotations

import json
from typing import Any

import codex_auth  # noqa: F401  — side-effect: patches openai SDK at import
from openai import OpenAI

from bot.config import settings
from bot.llm.anthropic_client import Turn  # reuse dataclass — same shape


def compute_cost_usd(*_args: Any, **_kwargs: Any) -> float:
    """Codex via Plus is flat-fee — no per-call cost surfaced.

    Kept as a function for API symmetry with anthropic_client; the runner
    branches on provider before calling either. Returns 0.0 always.
    """
    return 0.0


# ---------------------------------------------------------------------------
# Shape converters: Anthropic ↔ OpenAI Responses API
# ---------------------------------------------------------------------------


def _to_openai_input(
    system_blocks: list[dict],
    messages: list[dict],
) -> tuple[str, list[dict]]:
    """Translate Anthropic system + messages to OpenAI Responses API shape.

    Returns (instructions, input_items). Instructions is a single string
    (the Responses API takes one ``instructions`` param, not a list). Input
    items are a flat list of message + function_call + function_call_output
    items in chronological order — Codex/Responses expects function_call and
    function_call_output items at the top level of ``input``, not nested
    inside a message.
    """
    instructions = "\n\n".join(
        b.get("text", "") for b in system_blocks
        if b.get("type") == "text" and b.get("text")
    )
    items: list[dict] = []
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content")
        if role == "user":
            if isinstance(content, str):
                items.append({"role": "user", "content": content})
                continue
            # User turn is a list of blocks — mostly tool_result, sometimes text
            for block in content or []:
                btype = block.get("type")
                if btype == "tool_result":
                    out_str = block.get("content")
                    if not isinstance(out_str, str):
                        out_str = json.dumps(out_str, default=str)
                    if block.get("is_error"):
                        out_str = f"[error] {out_str}"
                    items.append({
                        "type": "function_call_output",
                        "call_id": block.get("tool_use_id", ""),
                        "output": out_str,
                    })
                elif btype == "text":
                    items.append({
                        "role": "user",
                        "content": block.get("text", ""),
                    })
        elif role == "assistant":
            # Anthropic assistant content = list of {text|tool_use} blocks
            text_parts: list[str] = []
            tool_calls: list[dict] = []
            for block in content or []:
                if block.get("type") == "text":
                    text_parts.append(block.get("text", ""))
                elif block.get("type") == "tool_use":
                    tool_calls.append({
                        "type": "function_call",
                        "call_id": block.get("id", ""),
                        "name": block.get("name", ""),
                        "arguments": json.dumps(block.get("input") or {}),
                    })
            # Emit any assistant prose first, then the tool calls, preserving
            # the Responses API expectation that function_call items live at
            # the top level (not inside the message).
            if text_parts:
                items.append({
                    "role": "assistant",
                    "content": "\n".join(p for p in text_parts if p),
                })
            items.extend(tool_calls)
    return instructions, items


def _convert_tools(tools: list[dict]) -> list[dict]:
    """Anthropic tool defs → OpenAI Responses API function tool defs.

    Anthropic shape: {"name", "description", "input_schema": {...}}
    OpenAI Responses: {"type": "function", "name", "description", "parameters", "strict"}

    Anthropic server tools (e.g. web_search_20250305) are dropped — they have
    no Codex/Plus equivalent in this OAuth path.
    """
    out: list[dict] = []
    for t in tools:
        # Anthropic server tools carry a "type" field; skip them.
        if t.get("type") in {"web_search_20250305", "web_search", "computer_20250124"}:
            continue
        out.append({
            "type": "function",
            "name": t.get("name", ""),
            "description": t.get("description", "") or "",
            "parameters": t.get("input_schema") or {"type": "object", "properties": {}},
            "strict": False,
        })
    return out


def _extract_output(resp: Any) -> tuple[list[dict], bool, int]:
    """OpenAI Responses output → Anthropic-shape content blocks.

    Returns (content_blocks, has_tool_call, reasoning_tokens).
    """
    content: list[dict] = []
    has_tool_call = False
    reasoning_toks = 0
    for item in getattr(resp, "output", []) or []:
        itype = getattr(item, "type", None)
        if itype == "message":
            # item.content is a list of {output_text|text} blocks.
            for c in getattr(item, "content", []) or []:
                ctype = getattr(c, "type", None)
                if ctype in {"output_text", "text"}:
                    text = getattr(c, "text", "") or ""
                    if text:
                        content.append({"type": "text", "text": text})
        elif itype == "function_call":
            has_tool_call = True
            args_str = getattr(item, "arguments", "") or "{}"
            try:
                args = json.loads(args_str)
            except (json.JSONDecodeError, TypeError):
                args = {}
            content.append({
                "type": "tool_use",
                "id": getattr(item, "call_id", "") or "",
                "name": getattr(item, "name", "") or "",
                "input": args,
            })
        elif itype == "reasoning":
            # Reasoning blocks are not actionable for the runner. We still
            # surface their token count via output_tokens_details upstream.
            pass
    return content, has_tool_call, reasoning_toks


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class CodexClient:
    """Drop-in replacement for AnthropicClient when LLM_PROVIDER=codex_oauth.

    Stateless wrapper — callers pass full message history each turn, same as
    the Anthropic path. ``model`` defaults to ``settings.llm_model_codex``
    (e.g. ``gpt-5.5``).
    """

    def __init__(self, model: str | None = None) -> None:
        self.model = model or settings.llm_model_codex
        # codex_auth has already patched the SDK — OpenAI() reads the OAuth
        # token from ~/.codex-auth/auth.json. No api_key kwarg needed.
        self.client = OpenAI()

    def create_turn(
        self,
        *,
        system: list[dict],
        messages: list[dict],
        tools: list[dict],
        max_tokens: int = 4096,
        enable_web_search: bool = False,
        web_search_max_uses: int = 5,  # noqa: ARG002 — kept for API symmetry
    ) -> Turn:
        instructions, input_items = _to_openai_input(system, messages)
        oai_tools = _convert_tools(tools)

        # NB: enable_web_search is ignored on this path — there's no Codex
        # server-side web tool reachable via the OAuth bridge. Premarket /
        # weekly_review fall back to local-DB news + signals.
        # NB2: ``max_output_tokens`` is rejected by the Codex/Plus endpoint
        # ("Unsupported parameter") — that endpoint hands back what the model
        # naturally produces. The runner's per-routine iteration ceiling
        # (LLM_MAX_TOOL_ITERATIONS / _PREMARKET_MAX_ITERATIONS) is the only
        # cap that applies here; ``max_tokens`` is kept in the signature for
        # API symmetry with AnthropicClient but ignored.
        _ = max_tokens
        kwargs: dict[str, Any] = {
            "model": self.model,
            "instructions": instructions,
            "input": input_items,
        }
        if oai_tools:
            kwargs["tools"] = oai_tools

        resp = self.client.responses.create(**kwargs)

        usage = getattr(resp, "usage", None)
        in_tok = int(getattr(usage, "input_tokens", 0) or 0)
        out_tok = int(getattr(usage, "output_tokens", 0) or 0)
        # Fold reasoning tokens into output_tokens for accounting parity with
        # Anthropic (Anthropic has no separate reasoning counter).
        details = getattr(usage, "output_tokens_details", None)
        if details is not None:
            r_tok = int(getattr(details, "reasoning_tokens", 0) or 0)
            # Some SDK versions already include reasoning in output_tokens.
            # Only add if not already counted (best-effort heuristic: if the
            # detail value exceeds the headline output, trust the detail).
            if r_tok > 0 and r_tok > out_tok:
                out_tok = r_tok

        content, _has_tool_call, _ = _extract_output(resp)

        # stop_reason mirrors Anthropic's convention so the runner can use it
        # the same way: "tool_use" when there are pending function_calls,
        # otherwise "end_turn".
        stop_reason = "end_turn"
        for b in content:
            if b.get("type") == "tool_use":
                stop_reason = "tool_use"
                break

        return Turn(
            stop_reason=stop_reason,
            content=content,
            input_tokens=in_tok,
            output_tokens=out_tok,
            cache_read_tokens=0,
            cache_write_tokens=0,
            web_search_calls=0,
        )
