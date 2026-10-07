"""Tool registry + validators — the trust boundary.

The LLM *proposes* via tool calls; handlers here *verify and execute*. Every
hard cap (5% size — halved to 2.5% plus a 1-fresh-name/day limit when the
regime is risk_off, 25-position count, 10% trailing stop, 3-day wash
window, 2-day earnings blackout on buys, 120-char thesis minimum) is
enforced here in code, never in prompts. Prompt constraints are
best-effort guidance; these are guarantees. (The 7% midday cut is a
prompt instruction — no handler forces it.)

Each tool entry is:

    {
        "definition": {"name": ..., "description": ..., "input_schema": {...}},
        "handler":    callable(args_dict) -> dict,
        "routines":   frozenset of routine names allowed to see this tool,
    }

The runner assembles ``tools=`` for each routine by filtering on the
``routines`` set, so the model literally cannot call ``place_buy`` in a
research-only routine — it isn't in the toolbox.
"""
from __future__ import annotations

import math
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable

from loguru import logger
from sqlalchemy import String as SAString, and_, cast, desc, func, or_, select

from bot.alpaca_client import AlpacaClient, cancel_and_wait, remaining_qty
from bot.config import (
    LLM_MAX_NEW_POSITIONS_PER_DAY,
    LLM_MAX_POSITION_PCT,
    LLM_MAX_POSITIONS,
    LLM_MAX_TOOL_RESULT_NEWS,
    LLM_MAX_TOOL_RESULT_SIGNALS,
    LLM_MEMORY_READ_MAX_CHARS,
    LLM_MIN_THESIS_CHARS,
    LLM_TRAILING_STOP_MAX,
    LLM_TRAILING_STOP_MIN,
    LLM_TRAILING_STOP_PCT,
    LLM_WASH_TRADE_LOOKBACK_DAYS,
    settings,
)
from bot.db import (
    Decision,
    EarningsCalendar,
    NewsItem,
    Position,
    Signal,
    SessionLocal,
    Trade,
)
from bot.llm import memory
from bot.performance import (
    benchmark_since_inception,
    realized_performance,
    signal_attribution,
)
from bot.signals import earnings as earnings_mod
from bot.signals import regime as regime_mod


# ---------------------------------------------------------------------------
# Error type
# ---------------------------------------------------------------------------


class ToolError(Exception):
    """Raised by a handler to signal a refusal that should be returned to
    the model with ``is_error=True``. The message is shown to the model so
    it can re-think. Keep messages actionable: "position exceeds 5% cap" is
    better than "invalid input"."""


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _alpaca() -> AlpacaClient:
    """One-shot client per call. Alpaca SDK clients are cheap to construct."""
    return AlpacaClient()


def _require_str(args: dict, key: str, min_len: int = 1) -> str:
    v = args.get(key)
    # Length is measured on the stripped text so whitespace padding can't
    # satisfy the thesis/reason minimum.
    if not isinstance(v, str) or len(v.strip()) < min_len:
        raise ToolError(f"missing or too-short field {key!r} (need ≥{min_len} chars)")
    return v


def _require_pos_float(args: dict, key: str) -> float:
    v = args.get(key)
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ToolError(f"field {key!r} must be a positive number, got {v!r}")
    # float("nan") parses fine and every comparison against NaN is False, so
    # a NaN notional sailed past the size cap and the buying-power check.
    if not math.isfinite(f):
        raise ToolError(f"field {key!r} must be a finite number, got {v!r}")
    if f <= 0:
        raise ToolError(f"field {key!r} must be > 0, got {f}")
    return f


_SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9]{0,5}(\.[A-Z0-9]{1,3})?$")


def _normalize_symbol(raw: str) -> str:
    """Canonical ticker form used by Alpaca, the Trade table and the earnings
    calendar: stripped, upper-case, share-class separator '.' (BRK.B).

    Every per-symbol cap — wash window, earnings blackout, top-up lookup
    against held positions — compares exact strings, so ' aapl' or 'BRK-B'
    previously looked like a different, never-traded name and skipped them.
    """
    sym = raw.strip().upper().replace("/", ".").replace("-", ".")
    if not _SYMBOL_RE.match(sym):
        raise ToolError(f"invalid symbol {raw!r}; expected a ticker like 'AAPL' or 'BRK.B'")
    return sym


def _portfolio_snapshot() -> dict:
    """Live Alpaca state — equity, cash, positions. Used by tools AND by
    validators that need a fresh read (e.g. place_buy re-queries just before
    submitting so stale locals can't slip an oversized order past)."""
    c = _alpaca()
    acct = c.account()
    positions = c.positions()
    return {
        "equity": acct.equity,
        "cash": acct.cash,
        "buying_power": acct.buying_power,
        "positions": [
            {
                "ticker": p.symbol,
                "qty": p.qty,
                "avg_cost": p.avg_entry_price,
                "market_price": p.market_price,
                "market_value": p.market_value,
                "unrealized_pnl": p.unrealized_pl,
            }
            for p in positions
        ],
    }


def _buys_today() -> tuple[set[str], set[str]]:
    """``(bought_today, fresh_today)``: tickers with a buy Trade row today,
    and the subset that were NOT held at the start of the day — the fresh
    names counted against the per-day cap.

    "Held at the start of the day" = a local Position row (maintained by the
    5-min sync, deleted when a position closes) opened before today. The old
    proxy — "any Trade row on this ticker before today" — treated every
    re-entry into a previously traded-and-closed name as a top-up, so the cap
    eroded as trade history grew (each re-entry was free). Fails closed: if
    the Position table is stale, today's buys count as fresh.
    """
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    with SessionLocal() as s:
        bought_today = set(s.scalars(
            select(Trade.ticker)
            .where(Trade.side == "buy")
            .where(Trade.submitted_at >= today_start)
        ).all())
        if not bought_today:
            return set(), set()
        held_before_today = set(s.scalars(
            select(Position.ticker)
            .where(Position.ticker.in_(bought_today))
            .where(Position.opened_at < today_start)
        ).all())
    return bought_today, bought_today - held_before_today


def _new_position_buys_today() -> int:
    """Number of distinct fresh names opened today (see ``_buys_today``)."""
    return len(_buys_today()[1])


def _pending_buys(c: AlpacaClient) -> dict[str, dict[str, float]]:
    """Buy exposure that is committed but not yet visible as a position.

    The runner executes every tool call of one model turn back-to-back, so a
    second place_buy can run before the first market order has filled into
    an Alpaca position. Sizing from live positions alone then let two
    same-turn buys of one name each pass the 5% cap (10% total), and two new
    names slip past the 25-position max. Live mode counts Alpaca's open buy
    orders; dry-run also counts today's dry-run buys, which never become
    positions. Returns ``{symbol: {"qty": unfilled_qty, "notional": usd}}``.
    """
    out: dict[str, dict[str, float]] = {}

    def _add(sym: str, qty: float = 0.0, notional: float = 0.0) -> None:
        slot = out.setdefault(sym.upper(), {"qty": 0.0, "notional": 0.0})
        slot["qty"] += qty
        slot["notional"] += notional

    for o in c.open_orders():
        if (o.get("side") or "").lower() != "buy":
            continue
        if o.get("notional"):
            _add(o["symbol"], notional=float(o["notional"]))
        else:
            unfilled = float(o.get("qty") or 0) - float(o.get("filled_qty") or 0)
            _add(o["symbol"], qty=max(unfilled, 0.0))
    if settings.dry_run:
        today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        with SessionLocal() as s:
            rows = s.scalars(
                select(Trade)
                .where(Trade.side == "buy")
                .where(Trade.status == "dry_run")
                .where(Trade.submitted_at >= today_start)
            ).all()
        for t in rows:
            _add(t.ticker, notional=float(t.notional or 0))
    return out


def _cancel_open_orders_for(symbol: str, *, side: str | None = None) -> dict:
    """Cancel all open Alpaca orders on ``symbol`` (optionally filtered by
    side) and wait, bounded, for Alpaca to confirm. This is the fix for last
    week's 44% rejection rate — the quant strategy kept submitting orders
    that conflicted with already-open orders, and Alpaca rejected them as
    potential wash trades. Confirmation matters because cancels are async:
    a sell submitted while a stop is still pending_cancel is rejected for
    insufficient qty. Returns ``cancel_and_wait``'s result
    (``cancelled`` / ``filled`` / ``unresolved``).

    No-op in dry-run: cancelling is a live broker mutation, and a dry-run
    place_buy used to cancel the real trailing stop protecting a held
    position without ever placing the buy.
    """
    if settings.dry_run:
        return {"cancelled": [], "filled": [], "unresolved": []}
    c = _alpaca()
    targets = [
        o for o in c.open_orders()
        if o["symbol"].upper() == symbol.upper()
        and (not side or o["side"].lower() == side.lower())
    ]
    return cancel_and_wait(c, targets)


def _recent_opposite_trade(ticker: str, side: str) -> Trade | None:
    """Return the most recent Trade on ``ticker`` whose side is opposite
    ``side`` and which was submitted in the last ``LLM_WASH_TRADE_LOOKBACK_DAYS``
    trading days. Returns None if nothing qualifies.

    We measure in *calendar* days here — Alpaca itself enforces wash sale
    rules tighter than we need to, and the strategy.md rule is about not
    re-fighting yesterday's decision, not tax compliance.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=LLM_WASH_TRADE_LOOKBACK_DAYS)
    opposite = "sell" if side == "buy" else "buy"
    with SessionLocal() as s:
        row = s.scalars(
            select(Trade)
            .where(Trade.ticker == ticker)
            .where(Trade.side == opposite)
            .where(Trade.submitted_at >= cutoff)
            .order_by(desc(Trade.submitted_at))
            .limit(1)
        ).first()
    return row


def _append_trade_log(line: str) -> None:
    """Internal-only helper so trade_log.md stays append-only."""
    memory.append("trade_log", line)


def _position_row(s, symbol: str, pos: dict) -> Position:
    """Local Position row for ``symbol``, created from the live snapshot
    entry ``pos`` when the 5-min sync hasn't inserted it yet (a position
    opened minutes ago). Previously state written here — a synthetic trail,
    a broker stop id — was silently dropped while the tool reported success.
    """
    row = s.get(Position, symbol)
    if row is None:
        row = Position(
            ticker=symbol, qty=pos["qty"], avg_cost=pos["avg_cost"],
            market_price=pos["market_price"], market_value=pos["market_value"],
            unrealized_pnl=pos["unrealized_pnl"], peak_price=pos["market_price"],
        )
        s.add(row)
    return row


def _current_regime_label() -> str | None:
    """Latest regime label, or None when no snapshot / read failure.

    Fail-open on purpose: regime data tightens caps (risk_off → smaller,
    fewer buys); an unreadable regime table falls back to the normal caps
    rather than blocking the routine.
    """
    try:
        snap = regime_mod.latest()
    except Exception:  # pragma: no cover — DB read, exceptions unexpected
        return None
    return (snap or {}).get("regime_label")


EARNINGS_BLACKOUT_DAYS = 2


def _check_earnings_blackout(symbol: str, days: int = EARNINGS_BLACKOUT_DAYS) -> None:
    """Raise ToolError when ``symbol`` reports earnings within the next
    ``days`` calendar days per the local earnings_calendar table. Passes
    silently when the calendar has no row for the symbol — the calendar only
    covers universe tickers and is best-effort, so absence isn't proof of
    safety, just absence of a known landmine."""
    now = datetime.now(timezone.utc)
    window_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    # Whole UTC dates: today through today+days inclusive. report_date rows
    # carry whatever time-of-day the refresh job ran (historically ~22:00
    # UTC), so the old `<= now + days` bound silently let a 09:30 ET execute
    # buy a name reporting on day+2 — a ~1.4-day blackout, not 2.
    window_end = window_start + timedelta(days=days + 1)
    with SessionLocal() as s:
        row = s.scalars(
            select(EarningsCalendar)
            .where(EarningsCalendar.ticker == symbol)
            .where(EarningsCalendar.report_date >= window_start)
            .where(EarningsCalendar.report_date < window_end)
            .order_by(EarningsCalendar.report_date.asc())
            .limit(1)
        ).first()
    if row is not None:
        rd = row.report_date.date().isoformat() if row.report_date else "unknown date"
        raise ToolError(
            f"earnings blackout: {symbol} reports on {rd} — buying within "
            f"{days} days of earnings is not allowed"
        )


# ---------------------------------------------------------------------------
# Handlers — one per tool. Each returns a JSON-serialisable dict.
# ---------------------------------------------------------------------------


def _h_read_memory(args: dict) -> dict:
    name = _require_str(args, "name")
    if name not in memory.ALL_MEMORY:
        raise ToolError(f"unknown memory file {name!r}; allowed: {list(memory.ALL_MEMORY)}")
    content = memory.read(name)
    # Tail-cap large files. research_log.md is an append-only ledger that hit
    # 360 KB (~90k tokens) by 2026-07-06; returning it whole compounded to
    # 300-514k input tokens per routine because each turn re-sends the whole
    # conversation. Recent entries are at the end, so keep the tail and cut
    # at a section boundary for readability.
    if len(content) > LLM_MEMORY_READ_MAX_CHARS:
        total = len(content)
        tail = content[-LLM_MEMORY_READ_MAX_CHARS:]
        boundary = tail.find("\n## ")
        if boundary == -1:
            boundary = tail.find("\n### ")
        if boundary == -1:
            # Header-less files (trade_log is one line per order): at least
            # don't start mid-line.
            boundary = tail.find("\n")
        if boundary != -1:
            tail = tail[boundary + 1:]
        note = (
            f"[NOTE: {name}.md is {total:,} chars; showing only the most "
            f"recent {len(tail):,} chars. Older entries are on disk but not "
            "shown — do not assume history before this point is empty.]\n\n"
        )
        return {"name": name, "content": note + tail, "truncated": True,
                "total_chars": total}
    return {"name": name, "content": content}


def _h_write_memory(args: dict) -> dict:
    name = _require_str(args, "name")
    content = _require_str(args, "content")
    if name not in memory.WRITABLE:
        raise ToolError(
            f"{name!r} is not writable by the LLM; only {list(memory.WRITABLE)} "
            "accept whole-file rewrites. Use append_memory for research_log."
        )
    bytes_written = memory.write(name, content)
    return {"ok": True, "name": name, "bytes_written": bytes_written}


def _h_append_memory(args: dict) -> dict:
    name = _require_str(args, "name")
    content = _require_str(args, "content")
    # LLM may append to research_log only — trade_log is tool-handler-only.
    if name != "research_log":
        raise ToolError(
            f"append_memory only accepts 'research_log' from the LLM; "
            f"trade_log.md is maintained automatically by place_buy/place_sell."
        )
    bytes_appended = memory.append("research_log", content)
    return {"ok": True, "name": name, "bytes_appended": bytes_appended}


def _h_get_portfolio(args: dict) -> dict:
    return _portfolio_snapshot()


def _h_get_price_snapshot(args: dict) -> dict:
    syms = args.get("symbols") or []
    if not isinstance(syms, list) or not syms:
        raise ToolError("symbols must be a non-empty list of ticker strings")
    if len(syms) > 25:
        raise ToolError("max 25 symbols per call")
    syms = [str(s).upper() for s in syms]
    quotes = _alpaca().latest_quotes(syms)
    return {"prices": {s: quotes.get(s) for s in syms}}


def _h_get_recent_news(args: dict) -> dict:
    ticker = args.get("ticker")
    days = int(args.get("days", 3))
    # Cap aggressively — last week's smoke test showed each verbose news
    # dump bloated next-turn input by ~3k tokens, which compounded into a
    # rate-limit hit after 4 turns. ~8 items keeps the model focused on
    # the most recent + most relevant headlines.
    limit = max(1, min(int(args.get("limit", 8)), LLM_MAX_TOOL_RESULT_NEWS))
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    with SessionLocal() as s:
        q = (
            select(NewsItem)
            .where(NewsItem.published_at >= cutoff)
            .order_by(desc(NewsItem.published_at))
        )
        if ticker:
            # Pre-filter in SQL so a ticker query isn't limited to whatever
            # happens to sit in the most recent rows. `tickers` is a JSON
            # array serialized as text (e.g. ["PEP", "KO"]), so a quoted
            # LIKE is exact per element; the Python check below stays as
            # the authoritative filter.
            safe = re.sub(r"[^A-Z0-9.\-]", "", str(ticker).upper())
            if safe:
                q = q.where(cast(NewsItem.tickers, SAString).like(f'%"{safe}"%'))
        rows = s.scalars(q.limit(limit * 3)).all()
    out: list[dict] = []
    for r in rows:
        if ticker and (not r.tickers or ticker.upper() not in (r.tickers or [])):
            continue
        out.append({
            "title": r.title,
            "source": r.source,
            "url": r.url,
            "published_at": r.published_at.isoformat(),
            "tickers": r.tickers or [],
            "vader_score": r.vader_score,
            "finbert_label": r.finbert_label,
            "has_body": bool(r.article_text),
        })
        if len(out) >= limit:
            break
    return {"items": out}


# Default lookback per signal kind when the model doesn't pass ``days``.
# 13F rows are dated by the quarterly SEC filing (~45 days after quarter end,
# e.g. Aug 14 for Q2), so the 14-day politician window showed none of them
# for most of every quarter.
SIGNAL_DEFAULT_DAYS = {"politician": 14, "investor": 120}


SIGNAL_MAX_DAYS = 180              # matches the tool schema's "maximum"
_13F_ROWS_PER_FUND = 2
_13F_SCAN_CAP = 5000               # bound on rows ranked in Python per call


# new/exit (a position opened or closed outright) outranks an add/trim of
# similar conviction; a clearly stronger add still wins.
_13F_NEW_EXIT_BOOST = 1.5


def _13f_books(s, sources: set[str], since: datetime) -> dict[tuple, float]:
    """Approximate each fund's reported book per 13F period as the sum of
    |value_new| over its rows in the query window (falling back to
    |value_old|, then |amount|, for exit-only or legacy rows). Computed over
    ALL of the fund's rows in the window — not just those matching a ticker
    filter, which would collapse every book to the one row being ranked.
    A ``meta["book_total"]``, when the 13F job stores one, takes precedence
    in ``_rank_13f``."""
    if not sources:
        return {}
    sums: dict[tuple, list[float]] = {}
    for source, meta, amount in s.execute(
        select(Signal.source, Signal.meta, Signal.amount)
        .where(Signal.kind == "investor")
        .where(Signal.source.in_(sources))
        .where(Signal.as_of >= since)
        .limit(_13F_SCAN_CAP)
    ).all():
        m = meta or {}
        acc = sums.setdefault((source, m.get("period")), [0.0, 0.0, 0.0])
        vn = m.get("value_new")
        acc[0] += abs(float(vn if vn is not None else (amount or 0.0)))
        acc[1] += abs(float(m.get("value_old") or 0.0))
        acc[2] += abs(float(amount or 0.0))
    return {k: (new or old or amt) for k, (new, old, amt) in sums.items()}


def _rank_13f(rows: list[Signal], books: dict[tuple, float]) -> list[Signal]:
    """Order 13F rows by conviction — fund weight × |$ change| ÷ the fund's
    reported book for that period (new/exit boosted) — keeping at most
    ``_13F_ROWS_PER_FUND`` per fund.

    Raw dollars favoured size over conviction: a multi-strat's $200M
    rebalance (weight 0.8) on a ~$50B book outranked Duquesne's $40M
    initiation (1.6) that was its whole move. And a multi-strat files ~100
    rebalances a quarter, so newest-first + LIMIT let two or three funds
    fill the whole result window."""
    def score(r: Signal) -> float:
        m = r.meta or {}
        book = float(m.get("book_total") or 0.0) or books.get((r.source, m.get("period"))) \
            or abs(float(r.amount or 0.0)) or 1.0
        s = float(m.get("weight") or 1.0) * abs(float(r.amount or 0.0)) / book
        return s * _13F_NEW_EXIT_BOOST if m.get("change") in ("new", "exit") else s

    per_fund: dict[str, int] = {}
    out: list[Signal] = []
    for r in sorted(rows, key=score, reverse=True):   # stable: ties stay newest-first
        if per_fund.get(r.source, 0) >= _13F_ROWS_PER_FUND:
            continue
        per_fund[r.source] = per_fund.get(r.source, 0) + 1
        out.append(r)
    return out


def _round_robin(groups: list[list], limit: int) -> list:
    """Interleave result groups so no single kind fills the window."""
    out: list = []
    iters = [iter(g) for g in groups]
    while iters and len(out) < limit:
        for it in list(iters):
            nxt = next(it, None)
            if nxt is None:
                iters.remove(it)
            elif len(out) < limit:
                out.append(nxt)
    return out


def _h_get_recent_signals(args: dict) -> dict:
    ticker = args.get("ticker")
    kind = args.get("kind", "all")
    # Floor at 1: SQLite treats a negative LIMIT as "no limit", so limit=-1
    # dumped every signal in the window into the context.
    limit = max(1, min(int(args.get("limit", 10)), LLM_MAX_TOOL_RESULT_SIGNALS))
    now = datetime.now(timezone.utc)
    if args.get("days") is not None:
        # Explicit window applies to every kind; clamped to the schema range
        # (a huge value overflowed timedelta, a negative one matched nothing).
        days = max(1, min(int(args["days"]), SIGNAL_MAX_DAYS))
        windows = {k: days for k in SIGNAL_DEFAULT_DAYS}
    else:
        windows = dict(SIGNAL_DEFAULT_DAYS)

    def _query(*conds):
        # All filters live in SQL. The old version applied LIMIT first and the
        # ticker filter in Python afterwards, so `ticker="PEP"` returned the
        # intersection of "PEP" with the N most recent signals of ANY ticker —
        # i.e. almost always nothing, even when PEP signals existed in-window.
        # That starved every premarket ticker lookup from ~May onward.
        q = select(Signal).where(*conds)
        if ticker:
            q = q.where(func.upper(Signal.ticker) == str(ticker).upper())
        return q.order_by(desc(Signal.as_of))

    def _since(k: str):
        return Signal.as_of >= now - timedelta(days=windows[k])

    every_kind = kind not in windows          # "all" (or anything unrecognised)
    groups: list[list[Signal]] = []
    with SessionLocal() as s:
        if every_kind or kind == "politician":
            groups.append(s.scalars(
                _query(Signal.kind == "politician", _since("politician")).limit(limit)
            ).all())
        if every_kind or kind == "investor":
            candidates = s.scalars(
                _query(Signal.kind == "investor", _since("investor")).limit(_13F_SCAN_CAP)
            ).all()
            books = _13f_books(s, {r.source for r in candidates},
                               now - timedelta(days=windows["investor"]))
            groups.append(_rank_13f(candidates, books))
        if every_kind:
            # Any other kind (none today) keeps the politician window.
            groups.append(s.scalars(
                _query(Signal.kind.notin_(list(windows)), _since("politician")).limit(limit)
            ).all())
    rows = _round_robin([g for g in groups if g], limit)

    out = []
    for r in rows:
        row = {
            "ticker": r.ticker,
            "kind": r.kind,
            "source": r.source,
            "direction": r.direction,
            "amount": r.amount,
            "as_of": r.as_of.isoformat(),
        }
        if r.kind == "investor":
            meta = r.meta or {}
            row.update({
                "change": meta.get("change"),     # new | add | trim | exit
                "weight": meta.get("weight"),     # fund conviction weight
                "period": meta.get("period"),     # 13F report period (quarter end)
            })
        out.append(row)
    return {"signals": out}


def _h_list_open_orders(args: dict) -> dict:
    return {"orders": _alpaca().open_orders()}


def _h_cancel_order(args: dict) -> dict:
    oid = _require_str(args, "order_id").strip()
    if settings.dry_run:
        # Dry run never mutates the broker.
        return {"ok": True, "order_id": oid, "dry_run": True}
    ok = _alpaca().cancel_order_by_id(oid)
    if ok:
        # If that was a position's recorded broker stop, forget it so the
        # synthetic trailing-stop engine re-arms. A stale stop_order_id
        # disarms that engine, leaving the position with no stop at all.
        with SessionLocal.begin() as s:
            for row in s.scalars(select(Position).where(Position.stop_order_id == oid)).all():
                row.stop_order_id = None
    return {"ok": ok, "order_id": oid}


def _h_set_trailing_stop(args: dict) -> dict:
    symbol = _normalize_symbol(_require_str(args, "symbol"))
    trail = _require_pos_float(args, "trail_percent")
    if not (LLM_TRAILING_STOP_MIN <= trail <= LLM_TRAILING_STOP_MAX):
        raise ToolError(
            f"trail_percent {trail} outside [{LLM_TRAILING_STOP_MIN}, "
            f"{LLM_TRAILING_STOP_MAX}]"
        )
    snap = _portfolio_snapshot()
    pos = next((p for p in snap["positions"] if p["ticker"] == symbol), None)
    if pos is None:
        raise ToolError(f"no open position in {symbol}; cannot attach stop")

    if settings.dry_run:
        # Dry run touches neither the broker nor the live stop bookkeeping.
        # This used to cancel the *real* broker stop first and then record a
        # fake DRY id on the Position row — leaving the real position with
        # no stop, and the synthetic engine disarmed once DRY_RUN was lifted.
        return {
            "order_id": f"DRY-STOP-{uuid.uuid4().hex[:8]}",
            "symbol": symbol,
            "trail_percent": trail,
            "mode": "dry_run",
        }

    # Replace ALL existing sell orders on the symbol, not just the recorded
    # stop: a split or partial stop the sync didn't record still holds
    # shares, and the full-size replacement would be refused. A working
    # market sell is an exit in flight — never cancel that to attach a stop.
    c = _alpaca()
    open_sells = [
        o for o in c.open_orders()
        if o["symbol"].upper() == symbol and (o.get("side") or "").lower() == "sell"
    ]
    if any((o.get("type") or "").lower() == "market" for o in open_sells):
        raise ToolError(
            f"a sell order is working on {symbol}; not attaching a stop to a "
            "position that is being exited"
        )
    # stop_order_id cleared in the DB first so that, if the replacement below
    # fails, the synthetic engine (not a cancelled order id) owns the position.
    with SessionLocal.begin() as s:
        row = _position_row(s, symbol, pos)
        row.stop_order_id = None
    res = cancel_and_wait(c, open_sells)
    if res["filled"] or res["unresolved"]:
        live = next((p for p in _portfolio_snapshot()["positions"] if p["ticker"] == symbol), None)
        if live is None:
            raise ToolError(f"{symbol} was closed by its existing stop while replacing it")
        if res["unresolved"]:
            raise ToolError(
                f"existing sell order(s) on {symbol} did not cancel in time; the "
                "bot-side synthetic stop covers the position — retry later"
            )
        pos = live

    try:
        oid = c.submit_trailing_stop(symbol, pos["qty"], trail)
    except Exception as exc:
        if "fractional" not in str(exc).lower():
            raise
        # Alpaca refuses GTC trailing stops on fractional positions
        # ("fractional orders must be DAY orders") — this rejected every
        # midday tighten on HD for weeks. Fall back to the synthetic
        # trailing-stop engine in sync_account (bot/main.py), which
        # checks price-vs-peak every 5 minutes and force-closes at
        # market. Recording trail_pct here makes that engine honor the
        # tightened trail instead of the 10% default.
        with SessionLocal.begin() as s:
            _position_row(s, symbol, pos).trail_pct = trail
        logger.info(
            "set_trailing_stop {}: broker rejected fractional GTC stop; "
            "recorded synthetic trail {:.1%} (enforced by 5-min sync)",
            symbol, trail,
        )
        return {
            "order_id": None,
            "symbol": symbol,
            "trail_percent": trail,
            "mode": "synthetic",
            "note": (
                "position is fractional so the broker refused a GTC stop; "
                "a bot-side synthetic trailing stop at this trail is now "
                "active (checked every 5 minutes)"
            ),
        }

    with SessionLocal.begin() as s:
        row = _position_row(s, symbol, pos)
        row.stop_order_id = oid
        row.trail_pct = trail
    return {"order_id": oid, "symbol": symbol, "trail_percent": trail, "mode": "broker"}


def _h_get_market_regime(args: dict) -> dict:
    """Latest macro snapshot: VIX, SPY trend, yield-curve, breadth, label.

    The LLM uses this to size positions. risk_off → smaller orders or skip
    new buys; risk_on → comfortable opening at the 5% cap.
    """
    snap = regime_mod.latest()
    if not snap:
        return {"available": False, "note": "no regime snapshot yet — first run pending"}
    return {"available": True, **snap}


def _h_get_performance(args: dict) -> dict:
    """The bot's own scorecard, so the post-mortem reasons from numbers.

    Returns alpha vs SPY since inception plus FIFO-matched realized-trade
    stats (hit rate, profit factor, avg win/loss, best/worst). Token-conscious:
    aggregates only, plus a few recent closed lots with truncated reasons.
    Read-only — never touches Alpaca or places orders.
    """
    def _short(v: Any, n: int = 90) -> Any:
        return v[:n] + "…" if isinstance(v, str) and len(v) > n else v

    with SessionLocal() as s:
        bench = benchmark_since_inception(s)
        rp = realized_performance(s, recent_limit=5)
        attribution = signal_attribution(s)

    def _slim(lot: dict | None) -> dict | None:
        if not lot:
            return None
        return {
            "ticker": lot["ticker"],
            "pnl": lot["pnl"],
            "pnl_pct": lot["pnl_pct"],
            "exit_reason": _short(lot.get("exit_reason")),
        }

    return {
        "benchmark": bench,
        "realized": {
            "closed_lots": rp["closed_lots"],
            "hit_rate_pct": rp["hit_rate_pct"],
            "profit_factor": rp["profit_factor"],
            "realized_pnl": rp["realized_pnl"],
            "avg_win": rp["avg_win"],
            "avg_loss": rp["avg_loss"],
            "avg_win_pct": rp["avg_win_pct"],
            "avg_loss_pct": rp["avg_loss_pct"],
            "best_trade": _slim(rp["best_trade"]),
            "worst_trade": _slim(rp["worst_trade"]),
            "recent": [_slim(l) for l in rp["recent"]],
        },
        # {kind: {lots, wins, pnl, hit_rate_pct}} — co-occurrence attribution,
        # small dict (≤ a handful of kinds), safe for the token budget.
        "signal_attribution": attribution,
    }


def _h_get_upcoming_earnings(args: dict) -> dict:
    """Upcoming earnings reports for universe tickers.

    Returns ticker, report_date, time_of_day (bmo/amc), eps_estimate, and
    ``last_4_eps_surprise_pct``. The LLM should avoid opening new positions
    in names reporting within the next 5 days unless the thesis explicitly
    *is* the earnings beat.

    EarningsHistory stores the surprise as a FRACTION (0.045 = beat by
    4.5%), exposed by earnings.upcoming() as ``last_4_surprise_pcts``; a
    model reading that name took 0.045 as 0.045%. The tool converts to
    percent under an explicit key and drops the fraction field.
    """
    days = int(args.get("days", 14))
    days = max(1, min(days, 30))
    events = earnings_mod.upcoming(days=days)
    for ev in events:
        fractions = ev.pop("last_4_surprise_pcts", None)
        if fractions is not None:
            ev["last_4_eps_surprise_pct"] = [
                None if f is None else round(f * 100, 2) for f in fractions
            ]
    return {"days": days, "events": events}


def _h_get_politician_trades(args: dict) -> dict:
    """Politician trades filtered by name and/or ticker. Richer than
    ``get_recent_signals`` — returns chamber, weight, source URL, etc."""
    name = (args.get("name") or "").strip().lower()
    ticker = args.get("ticker")
    days = int(args.get("days", 60))
    days = max(1, min(days, 180))
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    with SessionLocal() as s:
        # Filters in SQL, before the LIMIT — same bug as the old
        # get_recent_signals: filtering the 50 newest rows in Python meant
        # "what did Pelosi buy" came back empty whenever her trades weren't
        # among the 50 most recent disclosures of anyone. (_persist_signals
        # stores the politician's name as `source`; the Python checks below
        # stay authoritative.)
        q = select(Signal).where(Signal.kind == "politician").where(Signal.as_of >= cutoff)
        if ticker:
            q = q.where(func.upper(Signal.ticker) == str(ticker).upper())
        if name:
            q = q.where(func.lower(Signal.source).contains(name))
        rows = s.scalars(q.order_by(desc(Signal.as_of)).limit(50)).all()
    out = []
    for r in rows:
        meta = r.meta or {}
        pol = (meta.get("politician") or r.source or "").strip()
        if name and name not in pol.lower():
            continue
        if ticker and r.ticker.upper() != ticker.upper():
            continue
        out.append({
            "ticker": r.ticker,
            "politician": pol,
            "chamber": meta.get("chamber"),
            "direction": r.direction,
            "amount": r.amount,
            "as_of": r.as_of.isoformat() if r.as_of else None,
            "source_url": meta.get("source_url"),
        })
        if len(out) >= 25:
            break
    return {"trades": out}


def _h_place_buy(args: dict) -> dict:
    symbol = _normalize_symbol(_require_str(args, "symbol"))
    notional = _require_pos_float(args, "notional_usd")
    thesis = _require_str(args, "thesis", min_len=LLM_MIN_THESIS_CHARS)

    c = _alpaca()
    if not c.market_is_open():
        raise ToolError("market is closed; buys can only be placed during regular session")

    # Earnings blackout — no new money into a name reporting within the next
    # 2 calendar days. Binary-event roulette isn't the strategy.
    _check_earnings_blackout(symbol)

    # Re-query portfolio *right now* to avoid stale-local caps.
    snap = _portfolio_snapshot()
    equity = snap["equity"]
    if equity <= 0:
        raise ToolError("Alpaca reports equity <= 0; refusing to trade")

    # Regime-aware sizing: risk_off halves the per-position cap (2.5% of
    # equity instead of 5%) and tightens the fresh-name cap to 1/day below.
    # Enforced here — not in prompts — per the trust-boundary rule.
    regime_label = _current_regime_label()
    risk_off = regime_label == "risk_off"
    max_position_pct = LLM_MAX_POSITION_PCT / 2 if risk_off else LLM_MAX_POSITION_PCT
    max_notional = equity * max_position_pct
    if notional > max_notional + 0.01:
        cap_note = " — regime is risk_off, which halves the normal 5% cap" if risk_off else ""
        raise ToolError(
            f"notional ${notional:.2f} exceeds {max_position_pct:.1%} cap "
            f"${max_notional:.2f} (equity ${equity:.2f}){cap_note}"
        )
    if snap["buying_power"] < notional:
        raise ToolError(
            f"buying power ${snap['buying_power']:.2f} < notional ${notional:.2f}"
        )

    # Price up front: sizing needs it, and so does valuing unfilled buy
    # orders in the exposure check below. Mid price; Alpaca market orders
    # fill near here.
    quotes = c.latest_quotes([symbol])
    mid = quotes.get(symbol)
    if not mid or mid <= 0:
        raise ToolError(f"no live quote for {symbol}; refusing to size order")

    held = {p["ticker"]: p for p in snap["positions"]}
    # Unfilled buy orders (see _pending_buys) count toward the position count
    # and the size cap — never toward deciding whether a name is "new": an
    # open buy order on a name we don't hold (stale, or placed outside the
    # bot) must not turn a fresh name into a cap-exempt "top-up".
    pending = _pending_buys(c)
    pend = pending.get(symbol)
    pending_qty = (pend["qty"] + pend["notional"] / mid) if pend else 0.0
    pending_notional = pending_qty * mid

    # Position count: any name not already held must fit within the max,
    # counting names that working buy orders are about to open.
    if symbol not in held and len(set(held) | set(pending) | {symbol}) > LLM_MAX_POSITIONS:
        raise ToolError(
            f"already at max positions ({LLM_MAX_POSITIONS}, counting unfilled "
            "buy orders); close one before opening a new name"
        )

    # Size cap on the whole post-trade position — live market value plus
    # unfilled buys plus this order (catches a stealth top-up and a second
    # same-turn buy of a name whose first order hasn't filled).
    held_mv = held[symbol]["market_value"] if symbol in held else 0.0
    post_mv = held_mv + pending_notional + notional
    if post_mv > max_notional + 0.01:
        pending_note = (
            f" (incl. ${pending_notional:.2f} in unfilled buy orders)"
            if pending_notional else ""
        )
        raise ToolError(
            f"adding ${notional:.2f} to {symbol} would make it "
            f"${post_mv:.2f}{pending_note}, exceeding {max_position_pct:.1%} "
            f"cap ${max_notional:.2f}"
        )

    # Daily fresh-name cap. After last week's quant strategy did 579 trades
    # in 8 days on 3 tickers, we're forcing patience: at most N truly new
    # tickers per day, regardless of conviction. Adds (top-ups) don't count.
    # risk_off tightens the cap to 1 fresh name/day. A name is fresh unless
    # it's held or was already bought (and so already counted) today.
    bought_today, fresh_today = _buys_today()
    is_new_name = symbol not in held and symbol not in bought_today
    if is_new_name:
        max_new_today = 1 if risk_off else LLM_MAX_NEW_POSITIONS_PER_DAY
        new_today = len(fresh_today)
        if new_today >= max_new_today:
            cap_note = " — regime is risk_off, which caps fresh names at 1/day" if risk_off else ""
            raise ToolError(
                f"already opened {new_today} new positions today (cap "
                f"{max_new_today}{cap_note}); save other ideas for tomorrow"
            )

    # Wash-trade window.
    recent = _recent_opposite_trade(symbol, side="buy")
    if recent is not None:
        raise ToolError(
            f"recent sell on {symbol} at {recent.submitted_at.isoformat()} "
            f"is within {LLM_WASH_TRADE_LOOKBACK_DAYS}-day wash window; skip"
        )

    # Cancel any open opposite-side order on this symbol BEFORE placing the
    # buy. Last week's quant strategy hit a 44% Alpaca rejection rate from
    # exactly this collision (e.g. an open sell limit at $99.44 made a buy
    # at $99.94 a wash-trade per Alpaca). One pre-cancel call ends it.
    # (No-op in dry-run.) Note this also cancels an existing trailing stop
    # on a top-up — the stop below is re-sized to cover the whole position.
    cancelled = _cancel_open_orders_for(symbol, side="sell")["cancelled"]
    if cancelled:
        logger.info("place_buy {}: pre-cancelled {} open sell order(s)", symbol, len(cancelled))

    # Target qty = notional / mid, rounded DOWN to 2 decimals (fractional
    # shares are fine on Alpaca paper). round() could round up and overshoot
    # a buy sized exactly at the cap.
    qty = math.floor(notional / mid * 100) / 100
    if qty <= 0:
        raise ToolError(f"computed qty {qty} for ${notional:.2f} at ${mid:.2f} — too small")

    # Trail for the (re-)attached stop: keep a trail midday already tightened
    # on a held position (set_trailing_stop records it on the Position row)
    # instead of resetting it to the 10% default on a top-up.
    trail = LLM_TRAILING_STOP_PCT
    if symbol in held:
        with SessionLocal() as s:
            row = s.get(Position, symbol)
            if row is not None and row.trail_pct:
                trail = row.trail_pct

    # --- Submit (or simulate) ---
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if settings.dry_run:
        order_id = f"DRY-{uuid.uuid4().hex[:8]}"
        stop_id = f"DRY-STOP-{uuid.uuid4().hex[:8]}"
        status = "dry_run"
    else:
        order_id = c.submit_market(symbol, qty, "buy")
        # Trailing stop is best-effort. Alpaca rejects GTC trailing stops on
        # fractional positions ("fractional orders must be DAY orders"), and
        # a stop failure must NOT roll back the parent buy — that's how
        # 2026-04-27 execute lost 4 INTC attempts in a row. The midday
        # routine's 7%-from-cost rule serves as the safety net while we
        # decide whether to track stops in our own DB.
        #
        # Sized for the whole post-trade position: on a top-up the pre-cancel
        # above just removed the stop covering the existing shares, and a
        # stop for only the new qty — recorded as the position's
        # stop_order_id, which disarms the synthetic engine — left those
        # shares with no protection at all. If the broker refuses (fractional
        # total, parent not yet filled) stop_id is None and the synthetic
        # engine covers the full position.
        # Unfilled same-symbol buys are included too: their stops were also
        # just pre-cancelled. A stop larger than what has filled yet is
        # refused by the broker (stop_id None → synthetic engine covers it).
        held_qty = held[symbol]["qty"] if symbol in held else 0.0
        stop_qty = round(held_qty + pending_qty + qty, 9)
        try:
            stop_id = c.submit_trailing_stop(symbol, stop_qty, trail)
        except Exception as exc:
            logger.warning(
                "place_buy {}: parent filled (id={}) but trailing stop failed: {}",
                symbol, order_id, exc,
            )
            stop_id = None
        status = "submitted"

    # Persist Trade + Decision + stop_order_id. The Decision row is what
    # the dashboard reads to surface "why we own this" inline on holdings —
    # without it the position shows up but the rationale is invisible.
    with SessionLocal.begin() as s:
        trade = Trade(
            ticker=symbol, side="buy", qty=qty, price=mid,
            notional=notional, status=status, alpaca_order_id=order_id,
            dry_run=settings.dry_run,
        )
        s.add(trade)
        s.flush()
        s.add(Decision(
            ticker=symbol,
            action="buy",
            composite_score=0.0,
            score_breakdown={"llm": True, "thesis_chars": len(thesis)},
            reason=thesis,
            dry_run=settings.dry_run,
            trade_id=trade.id,
        ))
        # Live only: a DRY-STOP id on a real position's row would disarm the
        # synthetic engine (and be "cancelled" at Alpaca) once DRY_RUN is
        # lifted. New names get their stop id adopted by the 5-min sync.
        pos_row = s.get(Position, symbol)
        if pos_row is not None and not settings.dry_run:
            pos_row.stop_order_id = stop_id

    _append_trade_log(
        f"- {now_iso} | BUY  {symbol:6s} qty={qty:>10.4f} @ ~${mid:>8.2f} "
        f"notional=${notional:>8.2f} stop={trail:.0%}  thesis: {thesis}"
    )
    logger.info("LLM buy {}: qty={} notional=${:.2f} dry_run={}", symbol, qty, notional, settings.dry_run)
    return {
        "order_id": order_id,
        "stop_order_id": stop_id,
        "symbol": symbol,
        "qty": qty,
        "est_price": mid,
        "status": status,
    }


def _h_place_sell(args: dict) -> dict:
    symbol = _normalize_symbol(_require_str(args, "symbol"))
    qty_raw = args.get("qty", "all")
    reason = _require_str(args, "reason", min_len=LLM_MIN_THESIS_CHARS)

    snap = _portfolio_snapshot()
    held = {p["ticker"]: p for p in snap["positions"]}
    if symbol not in held:
        raise ToolError(f"no position in {symbol}; nothing to sell")
    live_qty = held[symbol]["qty"]

    if qty_raw == "all":
        qty = live_qty
    else:
        try:
            qty = float(qty_raw)
        except (TypeError, ValueError):
            raise ToolError(f"qty must be a number or 'all', got {qty_raw!r}")
        # NaN passes both range comparisons below (they're all False).
        if not math.isfinite(qty) or qty <= 0 or qty > live_qty + 1e-6:
            raise ToolError(f"qty {qty} outside valid range (0, {live_qty}]")

    # Wash-trade window.
    recent = _recent_opposite_trade(symbol, side="sell")
    if recent is not None:
        raise ToolError(
            f"recent buy on {symbol} at {recent.submitted_at.isoformat()} "
            f"is within {LLM_WASH_TRADE_LOOKBACK_DAYS}-day wash window; skip"
        )

    c = _alpaca()

    # Cancel EVERY open order on this symbol before selling, and wait for
    # Alpaca to confirm: buys (e.g. a stale dip-add limit — same wash-trade
    # mitigation as place_buy) and all sells. Cancelling only the recorded
    # stop missed split stops (sync records just one) and partial stops (sync
    # records none), whose held shares got the sell rejected for
    # insufficient qty — so the midday cut silently failed. No-op in dry-run:
    # a dry-run sell used to cancel the real stop and leave the (unsold)
    # position unprotected.
    res = _cancel_open_orders_for(symbol)
    if res["cancelled"]:
        logger.info("place_sell {}: pre-cancelled {} open order(s)", symbol, len(res["cancelled"]))
    if not settings.dry_run:
        with SessionLocal.begin() as s:
            pos_row = s.get(Position, symbol)
            if pos_row is not None:
                pos_row.stop_order_id = None
    if res["filled"] or res["unresolved"]:
        # Something executed instead of cancelling (a stop fired) or is still
        # holding shares: size the sell from the position as it is now.
        live = next((p for p in _portfolio_snapshot()["positions"] if p["ticker"] == symbol), None)
        if live is None:
            raise ToolError(
                f"{symbol} was closed by an existing order (e.g. its stop) while "
                "cancelling it; nothing left to sell"
            )
        held_by_orders = sum(
            remaining_qty(o) for o in res["unresolved"] if (o.get("side") or "").lower() == "sell"
        )
        free = round(live["qty"] - held_by_orders, 9)
        if qty_raw == "all":
            qty = free
        if free <= 0 or qty > free + 1e-6:
            raise ToolError(
                f"{symbol}: {held_by_orders:g} shares are still held by sell order(s) "
                f"{[o['id'] for o in res['unresolved']]} that did not cancel in time; "
                f"only {max(free, 0):g} of {live['qty']:g} can be sold now"
            )

    quotes = c.latest_quotes([symbol])
    # Fall back to the position's mark when the quote feed is empty; a $0
    # price on the Trade row books a phantom -100% loss in the realized-P&L
    # stats until (and, in dry-run, unless) fill reconciliation fixes it.
    mid = quotes.get(symbol) or held[symbol].get("market_price") or 0.0
    notional = qty * mid
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")

    if settings.dry_run:
        order_id = f"DRY-{uuid.uuid4().hex[:8]}"
        status = "dry_run"
    else:
        order_id = c.submit_market(symbol, qty, "sell")
        status = "submitted"

    with SessionLocal.begin() as s:
        trade = Trade(
            ticker=symbol, side="sell", qty=qty, price=mid,
            notional=notional, status=status, alpaca_order_id=order_id,
            dry_run=settings.dry_run,
        )
        s.add(trade)
        s.flush()
        s.add(Decision(
            ticker=symbol,
            action="sell",
            composite_score=0.0,
            score_breakdown={"llm": True, "qty": qty},
            reason=reason,
            dry_run=settings.dry_run,
            trade_id=trade.id,
        ))

    _append_trade_log(
        f"- {now_iso} | SELL {symbol:6s} qty={qty:>10.4f} @ ~${mid:>8.2f} "
        f"notional=${notional:>8.2f} reason: {reason}"
    )
    logger.info("LLM sell {}: qty={} dry_run={}", symbol, qty, settings.dry_run)
    return {"order_id": order_id, "symbol": symbol, "qty": qty, "status": status}


# ---------------------------------------------------------------------------
# Tool registry
# ---------------------------------------------------------------------------

ALL_ROUTINES = ("premarket", "execute", "midday", "close", "weekly_review")


@dataclass
class ToolSpec:
    definition: dict
    handler: Callable[[dict], dict]
    routines: frozenset[str]


def _build_registry() -> dict[str, ToolSpec]:
    r = {
        "read_memory": ToolSpec(
            definition={
                "name": "read_memory",
                "description": (
                    "Read a memory file. Available files: "
                    "strategy (the rulebook — laws), "
                    "playbook (research method — how to do idea-gen / earnings-prep), "
                    "catalysts (macro calendar — FOMC, CPI, jobs, earnings anchor weeks), "
                    "portfolio (current book), "
                    "trade_log (append-only ledger), "
                    "research_log (your dated research notes)."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "enum": list(memory.ALL_MEMORY)},
                    },
                    "required": ["name"],
                },
            },
            handler=_h_read_memory,
            routines=frozenset(ALL_ROUTINES),
        ),
        "write_memory": ToolSpec(
            definition={
                "name": "write_memory",
                "description": "Replace portfolio.md with a fresh snapshot. Only 'portfolio' is writable.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "enum": list(memory.WRITABLE)},
                        "content": {"type": "string"},
                    },
                    "required": ["name", "content"],
                },
            },
            handler=_h_write_memory,
            routines=frozenset({"execute", "midday", "close"}),
        ),
        "append_memory": ToolSpec(
            definition={
                "name": "append_memory",
                "description": "Append a new section to research_log.md (timestamped automatically).",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "enum": ["research_log"]},
                        "content": {"type": "string"},
                    },
                    "required": ["name", "content"],
                },
            },
            handler=_h_append_memory,
            routines=frozenset(ALL_ROUTINES),
        ),
        "get_portfolio": ToolSpec(
            definition={
                "name": "get_portfolio",
                "description": "Fetch live account state from Alpaca: equity, cash, buying_power, all positions.",
                "input_schema": {"type": "object", "properties": {}},
            },
            handler=_h_get_portfolio,
            routines=frozenset({"execute", "midday", "close", "weekly_review"}),
        ),
        "get_price_snapshot": ToolSpec(
            definition={
                "name": "get_price_snapshot",
                "description": "Latest mid prices for up to 25 symbols.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "symbols": {"type": "array", "items": {"type": "string"}, "maxItems": 25},
                    },
                    "required": ["symbols"],
                },
            },
            handler=_h_get_price_snapshot,
            routines=frozenset({"premarket", "execute", "midday", "close"}),
        ),
        "get_recent_news": ToolSpec(
            definition={
                "name": "get_recent_news",
                "description": (
                    "Read scraped news items from our local DB (CNBC / Yahoo / "
                    "CNN Business / MarketWatch / Seeking Alpha). Optional "
                    "ticker filter. Returns title, source, URL, VADER/FinBERT "
                    "sentiment, and whether we have the article body scraped."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "ticker": {"type": "string"},
                        "days": {"type": "integer", "minimum": 1, "maximum": 30},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                    },
                },
            },
            handler=_h_get_recent_news,
            routines=frozenset({"premarket", "execute", "weekly_review"}),
        ),
        "get_recent_signals": ToolSpec(
            definition={
                "name": "get_recent_signals",
                "description": (
                    "Politician disclosures + 13F changes from the local Signal "
                    "DB, newest first (at most "
                    f"{LLM_MAX_TOOL_RESULT_SIGNALS} rows). Default lookback when "
                    f"`days` is omitted: {SIGNAL_DEFAULT_DAYS['politician']} days "
                    "for politician disclosures, "
                    f"{SIGNAL_DEFAULT_DAYS['investor']} days for 13F (kind="
                    "'investor') changes — those are dated by the quarterly SEC "
                    "filing (~45 days after quarter end), so a short window "
                    "usually holds none. Passing `days` applies that one window "
                    "to every kind (1-180). 13F rows include change "
                    "(new/add/trim/exit), the fund's conviction weight and the "
                    "report period, and are ranked by conviction — weight × "
                    "|$ change| ÷ the fund's reported book, with new/exit "
                    "outranking add/trim of similar size — at most "
                    f"{_13F_ROWS_PER_FUND} per fund; kind='all' interleaves "
                    "politician and 13F rows."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "ticker": {"type": "string"},
                        "kind": {"type": "string", "enum": ["politician", "investor", "all"]},
                        "days": {"type": "integer", "minimum": 1, "maximum": 180},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                    },
                },
            },
            handler=_h_get_recent_signals,
            routines=frozenset({"premarket", "execute", "weekly_review"}),
        ),
        "list_open_orders": ToolSpec(
            definition={
                "name": "list_open_orders",
                "description": "List open (unfilled) orders at Alpaca.",
                "input_schema": {"type": "object", "properties": {}},
            },
            handler=_h_list_open_orders,
            routines=frozenset({"execute", "midday"}),
        ),
        "cancel_order": ToolSpec(
            definition={
                "name": "cancel_order",
                "description": "Cancel an open Alpaca order by id.",
                "input_schema": {
                    "type": "object",
                    "properties": {"order_id": {"type": "string"}},
                    "required": ["order_id"],
                },
            },
            handler=_h_cancel_order,
            routines=frozenset({"execute", "midday"}),
        ),
        "set_trailing_stop": ToolSpec(
            definition={
                "name": "set_trailing_stop",
                "description": (
                    "Attach or replace the trailing stop on an existing long "
                    "position. trail_percent is fractional (0.07 = 7%). "
                    "Valid range 3–25%."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "symbol": {"type": "string"},
                        "trail_percent": {"type": "number"},
                    },
                    "required": ["symbol", "trail_percent"],
                },
            },
            handler=_h_set_trailing_stop,
            routines=frozenset({"execute", "midday"}),
        ),
        "get_market_regime": ToolSpec(
            definition={
                "name": "get_market_regime",
                "description": (
                    "Today's macro snapshot: VIX + 5d change, SPY 50d/200d MA "
                    "trend, 10Y-2Y treasury spread, breadth (% of universe "
                    "above 50d MA), regime_label ('risk_on'|'neutral'|"
                    "'risk_off'). Use risk_off as a signal to skip new buys "
                    "or size down."
                ),
                "input_schema": {"type": "object", "properties": {}},
            },
            handler=_h_get_market_regime,
            routines=frozenset({"premarket", "execute", "midday", "close", "weekly_review"}),
        ),
        "get_performance_stats": ToolSpec(
            definition={
                "name": "get_performance_stats",
                "description": (
                    "The bot's own scorecard. Returns alpha vs SPY since "
                    "inception (bot_return_pct, spy_return_pct, alpha_pct, "
                    "beating_market) plus FIFO-matched realized-trade stats "
                    "(hit_rate_pct, profit_factor, avg win/loss in $ and %, "
                    "best/worst trade, recent closed lots with exit reasons) "
                    "and per-signal-kind P&L attribution. Ground your "
                    "post-mortem in these numbers — don't estimate P&L from "
                    "memory."
                ),
                "input_schema": {"type": "object", "properties": {}},
            },
            handler=_h_get_performance,
            routines=frozenset({"premarket", "midday", "close", "weekly_review"}),
        ),
        "get_upcoming_earnings": ToolSpec(
            definition={
                "name": "get_upcoming_earnings",
                "description": (
                    "Upcoming earnings for universe tickers. Returns "
                    "ticker, report_date (UTC), time_of_day, eps_estimate, "
                    "last_4_eps_surprise_pct — EPS surprise vs consensus for "
                    "the last 4 reported quarters, most recent first, in "
                    "PERCENT (4.5 = beat by 4.5%, -1.2 = missed by 1.2%). "
                    "Avoid opening new positions in "
                    "names reporting within 5 days unless the thesis IS the "
                    "earnings beat."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "days": {"type": "integer", "minimum": 1, "maximum": 30},
                    },
                },
            },
            handler=_h_get_upcoming_earnings,
            routines=frozenset({"premarket", "execute", "midday", "weekly_review"}),
        ),
        "get_politician_trades": ToolSpec(
            definition={
                "name": "get_politician_trades",
                "description": (
                    "Politician trades filtered by name and/or ticker. "
                    "Richer than get_recent_signals: returns chamber + URL. "
                    "Useful for 'what did Pelosi buy this quarter'."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "ticker": {"type": "string"},
                        "days": {"type": "integer", "minimum": 1, "maximum": 180},
                    },
                },
            },
            handler=_h_get_politician_trades,
            routines=frozenset({"premarket", "execute", "weekly_review"}),
        ),
        "place_buy": ToolSpec(
            definition={
                "name": "place_buy",
                "description": (
                    "Open or add to a position. Enforces 5% equity cap, "
                    "25-position max, wash-trade window, and auto-attaches "
                    f"a 10% trailing stop. Thesis must be ≥{LLM_MIN_THESIS_CHARS} "
                    "chars. Extra "
                    "hard rules: in a risk_off regime the cap halves to 2.5% "
                    "and only 1 fresh name/day is allowed; buys are rejected "
                    "within 2 days of the symbol's earnings report."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "symbol": {"type": "string"},
                        "notional_usd": {"type": "number", "minimum": 1},
                        "thesis": {"type": "string", "minLength": LLM_MIN_THESIS_CHARS},
                    },
                    "required": ["symbol", "notional_usd", "thesis"],
                },
            },
            handler=_h_place_buy,
            routines=frozenset({"execute"}),
        ),
        "place_sell": ToolSpec(
            definition={
                "name": "place_sell",
                "description": (
                    "Close or trim a position. qty can be a number or the "
                    "string 'all'. Cancels the active trailing stop first. "
                    f"Reason must be ≥{LLM_MIN_THESIS_CHARS} chars."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "symbol": {"type": "string"},
                        "qty": {"oneOf": [{"type": "number"}, {"type": "string", "enum": ["all"]}]},
                        "reason": {"type": "string", "minLength": LLM_MIN_THESIS_CHARS},
                    },
                    "required": ["symbol", "reason"],
                },
            },
            handler=_h_place_sell,
            routines=frozenset({"midday"}),
        ),
    }
    # Lightweight sanity check — catch routine-name typos early.
    for name, spec in r.items():
        bad = spec.routines - set(ALL_ROUTINES)
        assert not bad, f"tool {name!r} references unknown routines {bad}"
    return r


REGISTRY: dict[str, ToolSpec] = _build_registry()


def tools_for_routine(routine: str) -> list[dict]:
    """Return the list of tool definitions the Anthropic API should see for
    this routine. ``web_search`` is added by the runner as a server tool —
    not in this registry because its handler lives on Anthropic's side."""
    if routine not in ALL_ROUTINES:
        raise KeyError(f"unknown routine: {routine}")
    return [spec.definition for spec in REGISTRY.values() if routine in spec.routines]


def handler_for(name: str) -> Callable[[dict], dict]:
    spec = REGISTRY.get(name)
    if spec is None:
        raise ToolError(f"unknown tool {name!r}")
    return spec.handler


def routine_allows(name: str, routine: str) -> bool:
    spec = REGISTRY.get(name)
    return bool(spec) and routine in spec.routines
