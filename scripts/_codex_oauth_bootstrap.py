"""One-shot OAuth bootstrap for the Codex/Plus path.

Run this ONCE on the machine that will host the bot. It:

1. Imports ``codex_auth`` (monkey-patches the OpenAI SDK).
2. Calls a trivial ``responses.create`` on ``settings.llm_model_codex``.
3. On first run, opens your default browser to the ChatGPT OAuth flow —
   sign in with your ChatGPT Plus / Pro account. Token gets cached at
   ``~/.codex-auth/auth.json`` (mode 0600) and is refreshed automatically
   from then on; the bot does not need to be restarted when the token
   refreshes.
4. Prints the model's response so you know the round-trip works end-to-end
   with your subscription.

Usage:
    .venv\\Scripts\\python.exe scripts\\_codex_oauth_bootstrap.py

If the browser doesn't open, copy the URL the library prints into your
browser manually. If OAuth fails, delete ~/.codex-auth/auth.json and re-run.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Ensure repo root is on the path when run via `python scripts/_codex_oauth_bootstrap.py`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import codex_auth  # noqa: F401,E402 — side-effect: patches OpenAI SDK
from openai import OpenAI  # noqa: E402

from bot.config import settings  # noqa: E402


def main() -> int:
    model = settings.llm_model_codex
    print(f"[bootstrap] codex-auth loaded — will use model={model}")
    print("[bootstrap] On first run a browser window will open for ChatGPT OAuth.")
    print("[bootstrap] Sign in with the ChatGPT Plus account you want the bot to use.\n")

    client = OpenAI()
    try:
        resp = client.responses.create(
            model=model,
            instructions=(
                "You are a one-shot connectivity probe. Reply with exactly "
                "one short sentence so the operator knows the OAuth bridge works."
            ),
            input="Say hello and name the model you are running on.",
        )
    except Exception as exc:  # pragma: no cover — bootstrap UX only
        print(f"[bootstrap] FAILED: {exc!r}", file=sys.stderr)
        print(
            "[bootstrap] If the error mentions auth, delete ~/.codex-auth/auth.json "
            "and re-run this script.",
            file=sys.stderr,
        )
        return 1

    # Extract the text content from the Responses API output.
    parts: list[str] = []
    for item in getattr(resp, "output", []) or []:
        if getattr(item, "type", None) == "message":
            for c in getattr(item, "content", []) or []:
                if getattr(c, "type", None) in {"output_text", "text"}:
                    text = getattr(c, "text", "") or ""
                    if text:
                        parts.append(text)
    final = "\n".join(parts).strip() or "(no text in response)"

    usage = getattr(resp, "usage", None)
    in_tok = getattr(usage, "input_tokens", "?")
    out_tok = getattr(usage, "output_tokens", "?")

    print(f"[bootstrap] ✓ OAuth round-trip ok")
    print(f"[bootstrap] tokens in={in_tok} out={out_tok}")
    print(f"[bootstrap] model said:\n  {final}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
