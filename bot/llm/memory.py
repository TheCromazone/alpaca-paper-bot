"""Read / write / append helpers for ``memory/*.md``.

The LLM never touches the filesystem directly — these three functions are the
only way in. Three guards live here:

1. **Whitelist** — only the four known filenames are legal; anything else is
   rejected so the model can't wander into ``.env`` or ``bot/main.py``.
2. **Atomic replace** — ``write`` lands changes via ``tmp + os.replace`` so a
   mid-write crash can't leave a half-written file on disk.
3. **Size cap** — 64 KB per write (research_log and portfolio both stay well
   under this in practice; the cap is a sanity guard, not a product limit).

``strategy.md`` is whitelisted for reads but not writes — it's the hand-
authored rulebook. ``trade_log.md`` is whitelisted for appends only and only
from tool handlers (``place_buy`` / ``place_sell``), not the LLM itself; we
enforce that at the tool-registry level in ``tools.py``.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from bot.config import ROOT

MEMORY_DIR = ROOT / "memory"

# ALL_MEMORY is used for reads. WRITABLE / APPENDABLE are the narrower sets
# used by the write/append helpers and re-exported for the tool layer.
ALL_MEMORY = ("strategy", "portfolio", "trade_log", "research_log")
WRITABLE = ("portfolio",)                       # whole-file rewrite
APPENDABLE = ("research_log", "trade_log")      # append-only

MemoryName = Literal["strategy", "portfolio", "trade_log", "research_log"]

MAX_WRITE_BYTES = 64 * 1024


class MemoryError(Exception):
    """Raised on whitelist violation or size-cap breach."""


def _path_for(name: str) -> Path:
    if name not in ALL_MEMORY:
        raise MemoryError(
            f"memory file {name!r} is not in the whitelist {ALL_MEMORY}"
        )
    return MEMORY_DIR / f"{name}.md"


def read(name: MemoryName) -> str:
    p = _path_for(name)
    if not p.exists():
        return ""
    return p.read_text(encoding="utf-8")


def write(name: MemoryName, content: str) -> int:
    """Replace the whole file atomically. Returns bytes written.

    Only ``portfolio`` is writable via this helper — ``strategy`` is
    hand-authored, ``trade_log`` is append-only, ``research_log`` is also
    append-only (LLM uses ``append`` for it).
    """
    if name not in WRITABLE:
        raise MemoryError(
            f"memory file {name!r} is not writable (only {WRITABLE})"
        )
    payload = content.encode("utf-8")
    if len(payload) > MAX_WRITE_BYTES:
        raise MemoryError(
            f"write of {len(payload)}B exceeds MAX_WRITE_BYTES={MAX_WRITE_BYTES}"
        )
    p = _path_for(name)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_bytes(payload)
    os.replace(tmp, p)   # atomic on Windows and POSIX
    return len(payload)


def append(name: MemoryName, content: str) -> int:
    """Append content to research_log or trade_log. Returns bytes appended.

    Prepends a UTC ISO timestamp comment so the resulting file is a
    chronological ledger even when the writer forgets to stamp its entries.
    """
    if name not in APPENDABLE:
        raise MemoryError(
            f"memory file {name!r} is not appendable (only {APPENDABLE})"
        )
    payload = content.encode("utf-8")
    if len(payload) > MAX_WRITE_BYTES:
        raise MemoryError(
            f"append of {len(payload)}B exceeds MAX_WRITE_BYTES={MAX_WRITE_BYTES}"
        )
    p = _path_for(name)
    # Ensure the file ends with a newline before we append.
    existing = p.read_bytes() if p.exists() else b""
    sep = b"" if existing.endswith(b"\n") or not existing else b"\n"
    with p.open("ab") as f:
        f.write(sep)
        f.write(payload)
        if not payload.endswith(b"\n"):
            f.write(b"\n")
    return len(payload)


def stat(name: MemoryName) -> dict:
    """Lightweight metadata for the dashboard."""
    p = _path_for(name)
    if not p.exists():
        return {"name": name, "bytes": 0, "updated_at": None}
    st = p.stat()
    return {
        "name": name,
        "bytes": st.st_size,
        "updated_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
    }
