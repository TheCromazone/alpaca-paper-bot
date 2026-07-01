"""Minimal Google AI Studio (Gemini) REST client — dashboard aesthetics ONLY.

NOT part of the trading loop. Per the user's explicit instruction (Jul 2026),
Gemini credits are reserved for visual-asset generation (dashboard imagery);
all trading routines run through the configured runner backend (Codex OAuth /
Anthropic). No tool in ``bot/llm/tools.py`` may call this module. Deliberately
tiny:

* plain ``requests`` (already a dependency) — no google SDK to install;
* one function, ``generate(prompt, system)``, 30s timeout;
* every failure mode (missing key, network, HTTP != 200, malformed body)
  raises :class:`GeminiError` so callers can catch ONE type and fail soft.
  Nothing in here should ever be allowed to crash a trading routine — the
  tool handler wraps calls in try/except and degrades to "second opinion
  unavailable".

This client is advisory-only infrastructure: it never touches Alpaca, the
DB, or the memory files.
"""
from __future__ import annotations

from typing import Any

import requests
from loguru import logger

from bot.config import settings

_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
_TIMEOUT_SECONDS = 30
_MAX_OUTPUT_TOKENS = 1024
_TEMPERATURE = 0.4


class GeminiError(Exception):
    """Any Gemini failure — config, network, HTTP, or response-parse."""


def generate(prompt: str, system: str | None = None) -> str:
    """One-shot text generation. Returns the model's text or raises GeminiError.

    Token usage (``usageMetadata``) is logged at INFO for cost observability —
    Gemini Flash is cheap but not free, and the log line makes per-routine
    call volume auditable next to the LLMRun ledger.
    """
    key = settings.google_ai_api_key
    if not key:
        raise GeminiError("GOOGLE_AI_API_KEY not set")
    model = settings.gemini_model or "gemini-2.5-flash"

    payload: dict[str, Any] = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "maxOutputTokens": _MAX_OUTPUT_TOKENS,
            "temperature": _TEMPERATURE,
        },
    }
    if system:
        payload["systemInstruction"] = {"parts": [{"text": system}]}

    url = _ENDPOINT.format(model=model)
    try:
        resp = requests.post(
            url, params={"key": key}, json=payload, timeout=_TIMEOUT_SECONDS
        )
    except requests.RequestException as exc:
        raise GeminiError(f"network error: {exc}") from exc

    if resp.status_code != 200:
        # Trim the body — Google error payloads are verbose and may echo input.
        raise GeminiError(f"HTTP {resp.status_code}: {resp.text[:300]}")

    try:
        body = resp.json()
    except ValueError as exc:
        raise GeminiError(f"non-JSON response: {exc}") from exc

    usage = body.get("usageMetadata") or {}
    logger.info(
        "gemini {}: prompt_tokens={} output_tokens={} total_tokens={}",
        model,
        usage.get("promptTokenCount"),
        usage.get("candidatesTokenCount"),
        usage.get("totalTokenCount"),
    )

    try:
        parts = body["candidates"][0]["content"]["parts"]
        text = "".join(p.get("text", "") for p in parts).strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise GeminiError(f"unexpected response shape: {str(body)[:300]}") from exc

    if not text:
        finish = (body.get("candidates") or [{}])[0].get("finishReason")
        raise GeminiError(f"empty response (finishReason={finish})")
    return text
