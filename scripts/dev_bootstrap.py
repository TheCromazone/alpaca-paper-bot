"""Populate data/trading.db with REAL public data for local dashboard development.

The live bot runs on the Windows box; a dev checkout (e.g. macOS) has no
trading DB, so the API/dashboard have nothing to show. This script rebuilds a
realistic one from the bot's committed state plus real public data:

  memory/trade_log.md + portfolio.md  -> trades, decisions, positions
  memory/research_log.md              -> llm_runs, plus the real Alpaca equity
                                         readings the routines logged (used to
                                         anchor the equity curve)
  yfinance daily bars (one batch)     -> price_history, equity replay, regime
  the bot's own scrapers              -> news_items (RSS + VADER), signals
                                         (House PTRs, Senate eFD, SEC 13F),
                                         market_regime (FRED), earnings (NASDAQ)
  synthetic heartbeats                -> a few recent job_runs per scheduled job
                                         so staleness indicators render

How the equity curve is rebuilt: trade_log.md is incomplete on its own — it
has no pre-LLM (quant-era) book and no stop-out exits (synthetic/Alpaca
trailing stops never write to it). So:
  1. Positions absent from portfolio.md get a *reconstructed* exit, inferred by
     replaying the bot's 10% trailing stop on real daily OHLC (or, if it never
     fires, the day after research_log last discusses the position). These
     rows are labelled "Reconstructed exit (dev bootstrap)" in their reason.
  2. Starting cash is inferred so the replay's cash on portfolio.md's as-of
     date equals portfolio.md's cash.
  3. Daily equity = replay (cash + sum(qty * real close)) + a residual that is
     linearly interpolated between the real equity readings logged in
     research_log.md, so the curve passes through every real reading. After
     the last reading the holdings are carried forward on real prices.

Safety:
  * Refuses to run unless DRY_RUN=true (a live-trading .env has DRY_RUN=false).
  * Refuses to touch a DB that already has rows unless --force (wipes it).
  * Never talks to Alpaca: importing the Alpaca SDK or bot.alpaca_client is
    blocked for the lifetime of this process, so no order can be placed.

Usage:
    .venv/bin/python scripts/dev_bootstrap.py                # empty DB only
    .venv/bin/python scripts/dev_bootstrap.py --force        # wipe + rebuild
    .venv/bin/python scripts/dev_bootstrap.py --force --skip investors,house
"""
from __future__ import annotations

import argparse
import importlib.abc
import math
import re
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time as dtime, timedelta, timezone
from pathlib import Path
from statistics import median
from typing import Callable
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


class _AlpacaImportBlocker(importlib.abc.MetaPathFinder):
    """Hard guarantee that nothing in this process can reach Alpaca."""

    _BLOCKED = ("alpaca", "bot.alpaca_client")

    def find_spec(self, name, path=None, target=None):
        if any(name == b or name.startswith(b + ".") for b in self._BLOCKED):
            raise ImportError(f"dev_bootstrap never talks to Alpaca (blocked import: {name})")
        return None


sys.meta_path.insert(0, _AlpacaImportBlocker())

import pandas as pd  # noqa: E402
import yfinance as yf  # noqa: E402
from loguru import logger  # noqa: E402
from sqlalchemy import delete, func, insert, select  # noqa: E402

from bot.config import EQUITY_UNIVERSE, FULL_UNIVERSE, MONITOR_EXTRA, settings  # noqa: E402
from bot.db import (  # noqa: E402
    Base,
    Decision,
    EarningsCalendar,
    EarningsHistory,
    JobRun,
    LLMRun,
    MarketRegime,
    PortfolioSnapshot,
    Position,
    PriceHistory,
    SessionLocal,
    Trade,
    init_db,
)
from bot.llm import memory as llm_memory  # noqa: E402

ET = ZoneInfo("America/New_York")
EPS = 1e-4

# First trading day of the account (the retired quant strategy ran from
# 2026-04-20 — see bot/config.py and memory/strategy.md). Its equity comes
# from research_log's "start equity $X" scorecard line.
INCEPTION_DAY = date(2026, 4, 20)
PRICE_LOOKBACK_DAYS = 400
REGIME_BACKFILL_DAYS = 60

# Trailing stop used to reconstruct exits the trade log never recorded
# (LLM_TRAILING_STOP_PCT). Replayed on daily OHLC it lands GS/PANW/AAPL/AMAT
# exits in the windows the research_log weekly reviews describe.
TRAIL = 0.10

# ET schedule per routine (hour, minute) — mirrors bot/main.py.
ROUTINE_ET = {
    "premarket": (7, 0), "execute": (9, 30), "midday": (13, 0),
    "close": (16, 0), "weekly_review": (17, 0),
}
# Model eras, per CLAUDE.md: Anthropic until the 2026-05-20 Codex cutover,
# gpt-5.6-terra from 2026-07-20. Cost stays 0 — we have no real token data.
MODEL_ERAS = [
    (date(2026, 7, 20), "gpt-5.6-terra"),
    (date(2026, 5, 20), "gpt-5.5"),
    (date(2000, 1, 1), "claude-opus-4-7"),
]
# Mirrors the per-routine tool registry in bot/llm/tools.py (display only).
ROUTINE_TOOLS = {
    "premarket": {"read_memory", "append_memory", "get_price_snapshot", "get_recent_news",
                  "get_recent_signals", "get_market_regime", "get_performance_stats",
                  "get_upcoming_earnings", "get_politician_trades"},
    "execute": {"read_memory", "write_memory", "append_memory", "get_portfolio",
                "get_price_snapshot", "get_recent_news", "get_recent_signals",
                "list_open_orders", "cancel_order", "set_trailing_stop", "get_market_regime",
                "get_upcoming_earnings", "get_politician_trades", "place_buy"},
    "midday": {"read_memory", "write_memory", "append_memory", "get_portfolio",
               "get_price_snapshot", "list_open_orders", "cancel_order", "set_trailing_stop",
               "get_market_regime", "get_performance_stats", "get_upcoming_earnings",
               "place_sell"},
    "close": {"read_memory", "write_memory", "append_memory", "get_portfolio",
              "get_price_snapshot", "get_market_regime", "get_performance_stats"},
    "weekly_review": {"read_memory", "append_memory", "get_portfolio", "get_recent_news",
                      "get_recent_signals", "get_market_regime", "get_performance_stats",
                      "get_upcoming_earnings", "get_politician_trades"},
}
SKIPPABLE = {"news", "house", "senate", "investors", "regime", "earnings"}

# (source, status, detail) — printed at the end so it's obvious what is real.
REPORT: list[tuple[str, str, str]] = []


def _report(source: str, status: str, detail: str) -> None:
    REPORT.append((source, status, detail))
    logger.info("[{}] {}: {}", status, source, detail)


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------

def et_to_utc(d: date, hour: int, minute: int = 0) -> datetime:
    return datetime(d.year, d.month, d.day, hour, minute, tzinfo=ET).astimezone(timezone.utc)


def close_at(d: date) -> datetime:
    return et_to_utc(d, 16, 0)


def bar_ts(d: date) -> datetime:
    """Daily-bar timestamp the way Alpaca stamps them: midnight ET, in UTC."""
    return et_to_utc(d, 0, 0)


def _utc(ts: str) -> datetime:
    dt = datetime.fromisoformat(ts)
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def _money(s: str) -> float:
    return float(s.replace(",", ""))


# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------

def _table_counts() -> dict[str, int]:
    with SessionLocal() as s:
        return {
            t.name: s.execute(select(func.count()).select_from(t)).scalar_one()
            for t in Base.metadata.sorted_tables
        }


def _wipe() -> None:
    with SessionLocal.begin() as s:
        for t in reversed(Base.metadata.sorted_tables):
            s.execute(delete(t))
    logger.warning("--force: wiped every table in {}", settings.db_path)


# ---------------------------------------------------------------------------
# Prices (yfinance, one batch)
# ---------------------------------------------------------------------------

def _yf_symbol(t: str) -> str:
    return t.replace(".", "-")   # BRK.B -> BRK-B on Yahoo


def download_bars(tickers: list[str], start: date) -> dict[str, pd.DataFrame]:
    """Daily OHLC per ticker (unadjusted for dividends, split-adjusted)."""

    def _batch(syms: list[str], threads: bool) -> dict[str, pd.DataFrame]:
        df = yf.download(
            [_yf_symbol(t) for t in syms], start=start.isoformat(),
            auto_adjust=False, progress=False, threads=threads, group_by="column",
        )
        out: dict[str, pd.DataFrame] = {}
        for t in syms:
            try:
                sub = df.xs(_yf_symbol(t), axis=1, level=1)[["Open", "High", "Low", "Close", "Volume"]]
            except (KeyError, ValueError):
                continue
            sub = sub.dropna(subset=["Close"])
            if not sub.empty:
                sub.index = [ts.date() for ts in sub.index]
                out[t] = sub
        return out

    bars = _batch(tickers, threads=True)
    missing = [t for t in tickers if t not in bars]
    if missing:  # yfinance's threaded cache occasionally trips; retry serially
        logger.info("retrying {} tickers serially: {}", len(missing), missing)
        bars.update(_batch(missing, threads=False))

    # Drop a still-forming bar for today if the session hasn't closed yet.
    now_et = datetime.now(ET)
    if now_et.time() < dtime(16, 15):
        for t, sub in bars.items():
            bars[t] = sub[[d != now_et.date() for d in sub.index]]
    return bars


def store_price_history(bars: dict[str, pd.DataFrame]) -> int:
    """Full daily bars for the universe and the monitor-only instruments,
    matching what bot.main._refresh_price_history stores in production."""

    def _num(v) -> float | None:
        return None if v is None or pd.isna(v) else round(float(v), 4)

    rows = [
        {
            "ticker": t, "trade_date": bar_ts(d), "close": round(float(r.Close), 4),
            "open": _num(r.Open), "high": _num(r.High), "low": _num(r.Low), "volume": _num(r.Volume),
        }
        for t in list(FULL_UNIVERSE) + list(MONITOR_EXTRA) if t in bars
        for d, r in bars[t].iterrows()
    ]
    with SessionLocal.begin() as s:
        s.execute(insert(PriceHistory), rows)
    return len(rows)


# ---------------------------------------------------------------------------
# Memory files: trade_log.md, portfolio.md, research_log.md
# ---------------------------------------------------------------------------

_TRADE_LINE = re.compile(
    r"^- (?P<ts>\S+)\s+\|\s+(?P<manual>MANUAL\s+)?(?P<side>BUY|SELL)\s+(?P<ticker>[A-Z.]+)\s+"
    r"qty=\s*(?P<qty>[\d.]+)\s+@\s+~\$\s*(?P<price>[\d,.]+)\s+notional=\$\s*(?P<notional>[\d,.]+)"
    r"(?:\s+stop=\S+)?\s+(?:thesis|reason|note):\s*(?P<text>.+)$",
    re.MULTILINE,
)


@dataclass
class LedgerEvent:
    ts: datetime
    ticker: str
    side: str            # buy | sell
    qty: float
    price: float
    text: str
    manual: bool = False
    inferred: dict | None = None   # set on reconstructed exits

    @property
    def notional(self) -> float:
        return self.qty * self.price


def parse_trade_log(text: str) -> list[LedgerEvent]:
    out = [
        LedgerEvent(
            ts=_utc(m["ts"]), ticker=m["ticker"], side=m["side"].lower(),
            qty=float(m["qty"]), price=_money(m["price"]), text=m["text"].strip(),
            manual=bool(m["manual"]),
        )
        for m in _TRADE_LINE.finditer(text)
    ]
    return sorted(out, key=lambda e: e.ts)


@dataclass
class PortfolioMd:
    as_of: datetime
    equity: float
    cash: float
    buying_power: float
    holdings: dict[str, tuple[float, float]]   # ticker -> (qty, avg_cost)


def parse_portfolio(text: str) -> PortfolioMd:
    summ = re.search(
        r"equity \$([\d,.]+)\s*\|\s*cash \$([\d,.]+)\s*\|\s*buying power \$([\d,.]+)", text, re.I)
    asof = re.search(r"As of (\S+)", text)
    if not summ or not asof:
        raise SystemExit("memory/portfolio.md: couldn't find the account summary / 'As of' line")
    holdings = {
        m[1]: (float(m[2]), _money(m[3]))
        for m in re.finditer(r"^\|\s*([A-Z.]+)\s*\|\s*([\d.]+)\s*\|\s*\$([\d,.]+)\s*\|", text, re.M)
    }
    return PortfolioMd(_utc(asof[1]), _money(summ[1]), _money(summ[2]), _money(summ[3]), holdings)


@dataclass
class LogSection:
    day: date
    routine: str
    lines: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n".join(self.lines).strip()


_DAY_H2 = re.compile(r"^## (?P<weekly>Weekly review )?(?P<d>\d{4}-\d{2}-\d{2})")
_ROUTINE_H3 = re.compile(r"^### (?P<r>Pre-?market|Execute|Midday|Close)\b", re.I)


def parse_research_log(text: str) -> list[LogSection]:
    """Split into one section per routine run. Non-routine ### headers
    ("Idea pipeline", "Plan for execute routine") belong to the routine above
    them; a whole "## Weekly review DATE" block is one weekly_review run."""
    sections: list[LogSection] = []
    day: date | None = None
    cur: LogSection | None = None
    in_weekly = False
    for line in text.splitlines():
        m = _DAY_H2.match(line)
        if m:
            day, in_weekly = date.fromisoformat(m["d"]), bool(m["weekly"])
            cur = LogSection(day, "weekly_review", [line]) if in_weekly else None
            if cur:
                sections.append(cur)
            continue
        m = _ROUTINE_H3.match(line)
        if m and day and not in_weekly:
            cur = LogSection(day, m["r"].lower().replace("-", ""), [line])
            sections.append(cur)
            continue
        if cur is not None:
            cur.lines.append(line)
    return [s for s in sections if s.text]


# --- real equity readings inside research_log sections ---------------------
_EQ = r"\*{0,2}\$(?P<v>\d{2},\d{3}(?:\.\d{1,2})?)"
_CLOSE_EQ = re.compile(
    r"(?:clos(?:e|ing)\s+equity|equity\s+finished\s+at)\W{0,6}(?:of\s+|was\s+|is\s+)?" + _EQ, re.I)
_ARROW_EQ = re.compile(r"[Ee]quity[^$\n]{0,30}\$[\d,.]+\**[^$\n]{0,25}?(?:→|->)\s*" + _EQ)
_DAY_PNL = re.compile(r"Day P/L[^$\n]{0,40}?(?P<sign>[+\-−]?)\$(?P<v>[\d,]+\.\d{2})")
_REF_EQ = re.compile(r"(?:execute-time|snapshot|midday)[^$\n]{0,30}?" + _EQ, re.I)
_PLAIN_EQ = re.compile(r"[Ee]quity\**:?\**\s*(?:of\s+|was\s+|is\s+)?" + _EQ)
_NOT_PLAIN = re.compile(r"start|inception|\bvs\b|versus|\bexecute\b|execute-time|midday|snapshot|week", re.I)


def _plain_equity(text: str) -> float | None:
    for m in _PLAIN_EQ.finditer(text):
        line_start = text.rfind("\n", 0, m.start()) + 1
        if not _NOT_PLAIN.search(text[max(line_start, m.start() - 30):m.start() + 7]):
            return _money(m["v"])
    return None


def equity_reading(sec: LogSection) -> float | None:
    """The account equity a routine reported (Close sections: end-of-day)."""
    text = sec.text
    if sec.routine == "close":
        for rx in (_CLOSE_EQ, _ARROW_EQ):
            m = rx.search(text)
            if m:
                return _money(m["v"])
        plain = _plain_equity(text)
        if plain is not None:
            return plain
        # "Day P/L: -$32.93 versus the execute-time equity of $54,342.72"
        pnl, ref = _DAY_PNL.search(text), _REF_EQ.search(text)
        if pnl and ref:
            sign = -1.0 if pnl["sign"] in ("-", "−") else 1.0
            return round(_money(ref["v"]) + sign * _money(pnl["v"]), 2)
        return None
    if sec.routine in ("execute", "midday"):
        return _plain_equity(text)
    return None   # premarket quotes yesterday's close; weekly mixes many figures


def equity_anchors(sections: list[LogSection], until: date) -> dict[date, float]:
    """One real equity reading per day: Close if logged, else Midday, else Execute."""
    priority = {"close": 0, "midday": 1, "execute": 2}
    readings = [
        (sec.day, priority[sec.routine], v)
        for sec in sections
        if sec.routine in priority and sec.day <= until
        and (v := equity_reading(sec)) is not None
    ]
    if not readings:
        return {}
    mid = median(v for _, _, v in readings)   # drops mis-parsed figures
    out: dict[date, float] = {}
    for d, _, v in sorted(readings, key=lambda r: (r[0], -r[1])):
        if 0.8 * mid <= v <= 1.25 * mid:
            out[d] = v                           # last write = best priority
    return out


# ---------------------------------------------------------------------------
# Ledger reconstruction: inferred exits + seeds
# ---------------------------------------------------------------------------

def _simulate_trailing_stop(
    ohlc: pd.DataFrame, entry_day: date, avg_cost: float, last_day: date,
) -> tuple[date, float, float] | None:
    """First (day, fill, peak) where the bot's 10% trailing stop would have
    fired between the day after entry and ``last_day``, else None."""
    window = ohlc[[entry_day <= d <= last_day for d in ohlc.index]]
    if window.empty:
        return None
    peak = max(avg_cost, float(window["Close"].iloc[0]))
    for d, row in window.iloc[1:].iterrows():
        stop = peak * (1 - TRAIL)
        if row["Open"] <= stop:          # gapped through the stop
            return d, float(row["Open"]), peak
        if row["Low"] <= stop:
            return d, stop, peak
        peak = max(peak, float(row["High"]))
    return None


def _last_discussed(
    sections: list[LogSection], ticker: str, start: date, end: date,
    routines: tuple[str, ...] | None = None,
) -> date | None:
    """Last research_log section in [start, end] naming the ticker."""
    rx = re.compile(rf"(?<![A-Za-z]){re.escape(ticker)}(?![A-Za-z])")
    hits = [s.day for s in sections
            if (routines is None or s.routine in routines)
            and start <= s.day <= end and rx.search(s.text)]
    return max(hits, default=None)


def reconstruct_ledger(
    events: list[LedgerEvent], pf: PortfolioMd, bars: dict[str, pd.DataFrame],
    days: list[date], sections: list[LogSection],
) -> tuple[list[LedgerEvent], dict[str, tuple[float, float]]]:
    """Return (inferred exit events, seed holdings held since inception)."""
    asof_day = pf.as_of.astimezone(ET).date()
    exits: list[LedgerEvent] = []
    seeds: dict[str, tuple[float, float]] = {}

    by_ticker: dict[str, list[LedgerEvent]] = defaultdict(list)
    for e in events:
        if e.ts <= pf.as_of:
            by_ticker[e.ticker].append(e)

    for tk in sorted(set(by_ticker) | set(pf.holdings)):
        target, md_cost = pf.holdings.get(tk, (0.0, 0.0))
        qty, period = 0.0, []                 # events in the open holding period
        for e in by_ticker.get(tk, []):
            if e.side == "buy" and qty <= EPS:
                period = []
            period.append(e)
            qty += e.qty if e.side == "buy" else -e.qty
        if target - qty > EPS:                # held before the trade log began
            seeds[tk] = (target - qty, md_cost)
            continue
        if qty - target <= EPS:
            continue                          # fully explained by the log

        # Which buys survive in portfolio.md? Find the newest suffix of buys
        # summing to the held qty; everything older was exited before it.
        buys = [e for e in period if e.side == "buy"]
        keep_from, acc = len(buys), 0.0
        if target > EPS:
            for i in range(len(buys) - 1, -1, -1):
                acc += buys[i].qty
                if abs(acc - target) <= 0.01:
                    keep_from = i
                    break
        exited = buys[:keep_from] or buys
        exit_qty = qty - target
        avg = sum(b.qty * b.price for b in exited) / sum(b.qty for b in exited)
        entry_day = exited[0].ts.astimezone(ET).date()
        if keep_from < len(buys):             # must be flat before the re-buy
            rebuy = buys[keep_from].ts.astimezone(ET).date()
            bound = max((d for d in days if d < rebuy), default=entry_day)
        else:
            bound = asof_day

        hit = _simulate_trailing_stop(bars[tk], entry_day, avg, bound) if tk in bars else None
        if hit:
            d, px, peak = hit
            gapped = px >= float(bars[tk].loc[d, "Open"]) - 1e-9
            ts = et_to_utc(d, 9, 35) if gapped else et_to_utc(d, 12, 0)
            why = (f"Exit inferred from the bot's {TRAIL:.0%} trailing stop on real daily prices: "
                   f"~${px:.2f} fell >{TRAIL:.0%} below the ${peak:.2f} peak.")
        else:
            # Midday/Close review every open position, so the session after
            # the last one naming it is a proxy for the exit (falling back to
            # the last mention anywhere in the log).
            seen = (_last_discussed(sections, tk, entry_day, bound, ("midday", "close"))
                    or _last_discussed(sections, tk, entry_day, bound))
            d = min((x for x in days if seen and x > seen), default=bound)
            d = min(d, bound)
            px = float(bars[tk]["Close"].asof(d)) if tk in bars else avg
            peak, ts = None, et_to_utc(d, 15, 55)
            why = (f"The {TRAIL:.0%} trailing stop never fires on daily bars, so the exit is "
                   f"placed at the {d.isoformat()} close (${px:.2f}), going by when "
                   f"research_log stops reviewing the position.")
        if keep_from < len(buys):
            gap = (f"memory/portfolio.md holds only the {rebuy.isoformat()} {tk} re-buy, so the "
                   f"earlier lot was closed before it")
        else:
            gap = f"{tk} is absent from memory/portfolio.md as of {asof_day.isoformat()}"
        exits.append(LedgerEvent(
            ts=ts, ticker=tk, side="sell", qty=round(exit_qty, 4), price=round(px, 2),
            text=(f"Reconstructed exit (dev bootstrap): {gap}, but trade_log.md has no matching "
                  f"SELL. {why}"),
            inferred={"kind": "bootstrap_inferred_exit", "trail": TRAIL,
                      "peak": round(peak, 2) if peak else None, "fallback": hit is None},
        ))
    return exits, seeds


def store_trades(events: list[LedgerEvent]) -> int:
    with SessionLocal.begin() as s:
        for e in sorted(events, key=lambda x: x.ts):
            trade = Trade(
                ticker=e.ticker, side=e.side, qty=e.qty, price=e.price,
                notional=round(e.notional, 2), submitted_at=e.ts,
                filled_at=e.ts + timedelta(seconds=1), status="filled",
                alpaca_order_id=None, dry_run=False,
            )
            s.add(trade)
            s.flush()
            if e.inferred:
                action, breakdown, reason = "sell", e.inferred, e.text
            elif e.manual:
                action = f"manual_{e.side}"
                breakdown = {"manual": True, "note": e.text, "source": "trade_log.md"}
                reason = f"manual: {e.text}"
            else:
                action, reason = e.side, e.text
                breakdown = ({"llm": True, "thesis_chars": len(e.text)} if e.side == "buy"
                             else {"llm": True, "qty": e.qty})
                breakdown["source"] = "trade_log.md"
            s.add(Decision(
                at=e.ts, ticker=e.ticker, action=action, composite_score=0.0,
                score_breakdown=breakdown, reason=reason, dry_run=False, trade_id=trade.id,
            ))
    return len(events)


def store_positions(
    pf: PortfolioMd, events: list[LedgerEvent], bars: dict[str, pd.DataFrame],
) -> int:
    """portfolio.md holdings, marked to the latest real close."""
    with SessionLocal.begin() as s:
        for tk, (qty, avg) in pf.holdings.items():
            if tk not in bars:
                logger.warning("no price data for held {} — skipping position", tk)
                continue
            # opened_at = first buy of the current holding period (or inception).
            opened, running = None, 0.0
            for e in sorted((e for e in events if e.ticker == tk), key=lambda x: x.ts):
                if e.side == "buy" and running <= EPS:
                    opened = e.ts
                running += e.qty if e.side == "buy" else -e.qty
            opened = opened or et_to_utc(INCEPTION_DAY, 9, 30)
            closes = bars[tk]["Close"]
            last_day, last = closes.index[-1], round(float(closes.iloc[-1]), 4)
            since = closes[[d >= opened.astimezone(ET).date() for d in closes.index]]
            s.add(Position(
                ticker=tk, qty=qty, avg_cost=avg, market_price=last,
                market_value=round(qty * last, 2), unrealized_pnl=round(qty * (last - avg), 2),
                peak_price=round(float(since.max()), 4) if not since.empty else last,
                opened_at=opened, updated_at=close_at(last_day),
            ))
    return len(pf.holdings)


# ---------------------------------------------------------------------------
# Equity curve
# ---------------------------------------------------------------------------

def build_snapshots(
    days: list[date], ledger: list[LedgerEvent], seeds: dict[str, tuple[float, float]],
    pf: PortfolioMd, closes: pd.DataFrame, anchors: dict[date, float],
) -> tuple[int, float]:
    """Replay the ledger on real closes, then pin the curve to real readings."""
    cash0 = pf.cash + sum(
        (e.notional if e.side == "buy" else -e.notional) for e in ledger if e.ts <= pf.as_of)
    evs = sorted(ledger, key=lambda e: e.ts)
    qty: dict[str, float] = defaultdict(float, {t: q for t, (q, _) in seeds.items()})
    cash, i = cash0, 0
    replay: list[tuple[float, float]] = []   # (cash, equity) per day
    for d in days:
        cutoff = close_at(d)
        while i < len(evs) and evs[i].ts <= cutoff:
            e = evs[i]
            sign = 1 if e.side == "buy" else -1
            qty[e.ticker] += sign * e.qty
            cash -= sign * e.notional
            i += 1
        mv = 0.0
        for t, q in qty.items():
            if q > EPS:
                px = closes.at[d, t] if t in closes.columns else float("nan")
                mv += q * (px if not math.isnan(px) else 0.0)
        replay.append((cash, cash + mv))

    # Residual = real reading - replay, interpolated across trading days.
    idx = {d: k for k, d in enumerate(days)}
    pts = sorted((idx[d], v - replay[idx[d]][1]) for d, v in anchors.items() if d in idx)
    asof_k = max((k for k, d in enumerate(days) if d <= pf.as_of.astimezone(ET).date()), default=0)
    resid = [0.0] * len(days)
    for k in range(len(days)):
        if not pts or k > asof_k:
            continue                       # carried-forward period: pure replay
        before = [p for p in pts if p[0] <= k]
        after = [p for p in pts if p[0] >= k]
        if before and after:
            (k0, r0), (k1, r1) = before[-1], after[0]
            resid[k] = r0 if k1 == k0 else r0 + (r1 - r0) * (k - k0) / (k1 - k0)
        else:
            resid[k] = (before or after)[-1 if before else 0][1]

    bp_ratio = pf.buying_power / pf.equity if pf.equity else 2.0
    spy = closes["SPY"]
    with SessionLocal.begin() as s:
        for k, d in enumerate(days):
            c, eq = replay[k]
            eq += resid[k]
            s.add(PortfolioSnapshot(
                at=close_at(d), equity=round(eq, 2), cash=round(c, 2),
                buying_power=round(eq * bp_ratio, 2),
                spy_close=round(float(spy.at[d]), 4) if not math.isnan(spy.at[d]) else None,
            ))
    return len(days), cash0


# ---------------------------------------------------------------------------
# LLM runs from research_log.md
# ---------------------------------------------------------------------------

_TOOL_HINTS = [   # (tool, regex over the section text)
    ("get_market_regime", r"regime|VIX|breadth"),
    ("get_upcoming_earnings", r"earnings"),
    ("get_recent_news", r"news|headline|CNBC|Reuters|MarketWatch"),
    ("get_recent_signals", r"13F|signal"),
    ("get_politician_trades", r"politician|disclos|Rep\.|Sen\."),
    ("get_performance_stats", r"get_performance|since[- ]inception|hit rate|profit factor"),
    ("get_price_snapshot", r"\bquote|price snapshot|get_price_snapshot"),
    ("list_open_orders", r"open orders?"),
    ("set_trailing_stop", r"set_trailing_stop|tighten(?:ed)? (?:the )?(?:trail|stop)"),
]
_TOOL_MS = {"read_memory": 3.0, "write_memory": 4.0, "append_memory": 4.0,
            "place_buy": 1450.0, "place_sell": 1200.0}


def _model_for(d: date) -> str:
    return next(m for start, m in MODEL_ERAS if d >= start)


def _tool_trace(sec: LogSection, trades_today: list[LedgerEvent]) -> list[dict]:
    """A small, honest-ish trace: tools the text evidences, plus the trades
    trade_log.md proves happened in this routine, plus the research_log append
    that produced the section itself."""
    allowed = ROUTINE_TOOLS[sec.routine]
    names: list[tuple[str, dict]] = [("read_memory", {"name": "research_log"})]
    if "get_portfolio" in allowed:
        names.append(("get_portfolio", {}))
    for tool, rx in _TOOL_HINTS:
        if tool in allowed and re.search(rx, sec.text, re.I):
            names.append((tool, {}))
    for e in trades_today:
        if e.side == "buy" and sec.routine == "execute":
            names.append(("place_buy", {"symbol": e.ticker, "notional": round(e.notional, 2),
                                        "thesis": e.text[:77] + "..."}))
        if e.side == "sell" and sec.routine == "midday":
            names.append(("place_sell", {"symbol": e.ticker, "qty": e.qty,
                                         "reason": e.text[:77] + "..."}))
    names.append(("append_memory", {"name": "research_log"}))
    if "write_memory" in allowed:
        names.append(("write_memory", {"name": "portfolio"}))
    return [
        {"name": n, "args": a, "ok": True, "ms": _TOOL_MS.get(n, 180.0), "reconstructed": True}
        for n, a in names
    ]


def store_llm_runs(sections: list[LogSection], events: list[LedgerEvent], days_back: int) -> int:
    if not sections:
        return 0
    newest = max(s.day for s in sections)
    cutoff = newest - timedelta(days=days_back)
    trades_by_day: dict[date, list[LedgerEvent]] = defaultdict(list)
    for e in events:
        if not e.manual and not e.inferred:
            trades_by_day[e.ts.astimezone(ET).date()].append(e)
    seen: dict[tuple[date, str], int] = defaultdict(int)
    n = 0
    with SessionLocal.begin() as s:
        for sec in sections:
            if sec.day < cutoff:
                continue
            hh, mm = ROUTINE_ET[sec.routine]
            # A second section for the same routine/day (e.g. a pre-market
            # refresh) becomes a later run a few minutes after the first.
            offset = 4 * seen[(sec.day, sec.routine)]
            seen[(sec.day, sec.routine)] += 1
            started = et_to_utc(sec.day, hh, mm) + timedelta(minutes=offset)
            trace = _tool_trace(sec, trades_by_day.get(sec.day, []))
            model = _model_for(sec.day)
            web = 0
            if model.startswith("claude") and sec.routine in ("premarket", "weekly_review"):
                web = len(set(re.findall(r"\b[a-z0-9-]+\.(?:com|org|gov|net)\b", sec.text)))
            s.add(LLMRun(
                routine=sec.routine, started_at=started,
                finished_at=started + timedelta(seconds=20 + 9 * len(trace)),
                status="ok", model=model, usd_cost=0.0, web_search_calls=web,
                tool_calls=len(trace), tool_trace=trace, summary=sec.text[:4000],
            ))
            n += 1
    return n


# ---------------------------------------------------------------------------
# Scheduled jobs (real executions + synthetic heartbeats)
# ---------------------------------------------------------------------------

def record_job(name: str, fn: Callable[[], object], message: str = "") -> tuple[bool, object]:
    """Same bookkeeping as bot/main.py:_log_job, but returns the result."""
    started = datetime.now(timezone.utc)
    status, msg, result = "ok", message, None
    try:
        result = fn()
    except Exception as exc:
        status, msg = "failed", repr(exc)
        logger.exception("{} failed", name)
    with SessionLocal.begin() as s:
        s.add(JobRun(job_name=name, started_at=started, finished_at=datetime.now(timezone.utc),
                     status=status, message=msg))
    return status == "ok", result


def _heartbeat_slots(now: datetime, kind: str, n: int, *, every_min: int = 0,
                     hhmm: tuple[int, int] = (0, 0), weekdays: set[int] | None = None) -> list[datetime]:
    slots: list[datetime] = []
    if kind == "interval":
        t = now.replace(second=0, microsecond=0)
        t -= timedelta(minutes=t.minute % every_min)
        while len(slots) < n:
            if t < now:
                slots.append(t)
            t -= timedelta(minutes=every_min)
        return slots
    d = now.date()
    while len(slots) < n:
        t = datetime(d.year, d.month, d.day, *hhmm, tzinfo=timezone.utc)
        if t < now and (weekdays is None or t.weekday() in weekdays):
            slots.append(t)
        d -= timedelta(days=1)
    return slots


def store_heartbeats() -> int:
    """A few recent job_runs per scheduled job in bot/main.py, older than the
    real runs this script just made, so the dashboard's staleness widgets have
    a cadence to show. Message makes clear they're synthetic."""
    with SessionLocal() as s:
        first_real = s.scalar(select(func.min(JobRun.started_at)))
    now = (first_real.replace(tzinfo=timezone.utc) if first_real else datetime.now(timezone.utc))
    weekdays = {0, 1, 2, 3, 4}
    plan = [
        ("sync_account", _heartbeat_slots(now, "interval", 6, every_min=5), 3),
        ("news_refresh_offhours", _heartbeat_slots(now, "interval", 3, every_min=15), 6),
        ("article_scrape_offhours", _heartbeat_slots(now, "interval", 3, every_min=15), 20),
        ("price_refresh", _heartbeat_slots(now, "daily", 3, hhmm=(20, 30), weekdays=weekdays), 40),
        ("regime_daily", _heartbeat_slots(now, "daily", 3, hhmm=(21, 0)), 2),
        ("earnings_daily", _heartbeat_slots(now, "daily", 3, hhmm=(22, 0)), 30),
        ("politicians_daily", _heartbeat_slots(now, "daily", 3, hhmm=(7, 0)), 45),
        ("senate_daily", _heartbeat_slots(now, "daily", 3, hhmm=(7, 30)), 5),
        ("investors_weekly", _heartbeat_slots(now, "daily", 2, hhmm=(6, 0), weekdays={6}), 90),
    ]
    n = 0
    with SessionLocal.begin() as s:
        for name, slots, secs in plan:
            for t in slots:
                s.add(JobRun(job_name=name, started_at=t, finished_at=t + timedelta(seconds=secs),
                             status="ok", message="dev_bootstrap synthetic heartbeat (not a real run)"))
                n += 1
        # LLM routine jobs mirror the newest reconstructed llm_runs per routine.
        for routine in ROUTINE_ET:
            runs = s.scalars(select(LLMRun).where(LLMRun.routine == routine)
                             .order_by(LLMRun.started_at.desc()).limit(3)).all()
            for r in runs:
                s.add(JobRun(job_name=f"llm_{routine}", started_at=r.started_at,
                             finished_at=r.finished_at, status="ok",
                             message="dev_bootstrap: mirrors a reconstructed llm_runs row"))
                n += 1
    return n


# ---------------------------------------------------------------------------
# Real upstream sources (the bot's own modules)
# ---------------------------------------------------------------------------

def run_news() -> None:
    from bot.news.article_scraper import scrape_pending
    from bot.news.rss_scraper import fetch_all, persist_new
    from bot.signals.sentiment import rescore_scraped_articles, score_unscored

    ok, res = record_job("news_refresh_offhours",
                         lambda: (len(persist_new(fetch_all())), score_unscored()))
    if ok and res and res[0]:
        _report("news_items", "real", f"{res[0]} RSS items persisted, {res[1]} VADER-scored")
    else:
        _report("news_items", "failed", f"RSS pipeline returned {res!r}")
    ok, res = record_job("article_scrape_offhours",
                         lambda: (scrape_pending(FULL_UNIVERSE), rescore_scraped_articles()))
    _report("article bodies", "real" if ok else "failed", f"scrape_pending -> {res!r}")


def _signal_count(chamber: str | None = None, kind: str = "politician") -> int:
    from bot.db import Signal
    with SessionLocal() as s:
        rows = s.scalars(select(Signal).where(Signal.kind == kind)).all()
    return sum(1 for r in rows if chamber is None or (r.meta or {}).get("chamber") == chamber)


def run_signals(skip: set[str]) -> None:
    from bot.signals import investors, politicians, senate

    for key, job, mod, label in (
        ("house", "politicians_daily", politicians, "House PTRs (disclosures-clerk.house.gov)"),
        ("senate", "senate_daily", senate, "Senate PTRs (efdsearch.senate.gov)"),
        ("investors", "investors_weekly", investors, "13F deltas (SEC EDGAR)"),
    ):
        if key in skip:
            _report(label, "skipped", "--skip")
            continue
        t0 = time.monotonic()
        ok, res = record_job(job, mod.run)
        kind = "investor" if key == "investors" else "politician"
        chamber = None if key == "investors" else key
        n = _signal_count(chamber, kind)
        err = (res or {}).get("error") if isinstance(res, dict) else None
        status = "real" if ok and not err and n else ("failed" if err or not ok else "empty")
        _report(label, status, f"{n} signal rows in {time.monotonic() - t0:.0f}s"
                + (f"; error: {err}" if err else "")
                + ("" if n or err else "; scraper produced no rows (see its warnings above)"))


def backfill_regime(bars: dict[str, pd.DataFrame], days: list[date]) -> int:
    """Daily MarketRegime rows for the trading days before the latest one,
    computed with regime.py's own inputs + label function. FRED observations
    dated before each day only, to mirror what the 21:00 UTC job could see."""
    from bot.signals import regime

    vix_rows = [(date.fromisoformat(d), v) for d, v in regime._fred_latest("VIXCLS", lookback_rows=150)]
    t10_rows = [(date.fromisoformat(d), v) for d, v in regime._fred_latest("T10Y2Y", lookback_rows=150)]
    vix_src = "FRED VIXCLS"
    if not vix_rows and "^VIX" in bars:   # FRED down -> same series via Yahoo
        vix_rows = [(d + timedelta(days=1), float(c)) for d, c in bars["^VIX"]["Close"].items()]
        vix_src = "Yahoo ^VIX"
    closes = pd.DataFrame({t: bars[t]["Close"] for t in EQUITY_UNIVERSE + ["SPY"] if t in bars})
    closes = closes.sort_index()

    n = 0
    with SessionLocal.begin() as s:
        for d in days[-(REGIME_BACKFILL_DAYS + 1):-1]:
            vix_hist = [r for r in vix_rows if r[0] < d]
            vix = regime._last_non_null(vix_hist)
            vix_5d = None
            if vix is not None and len(vix_hist) >= 6:
                prior = next((v for _, v in reversed(vix_hist[:-5]) if v is not None), None)
                vix_5d = round(vix - prior, 2) if prior is not None else None
            t10 = regime._last_non_null([r for r in t10_rows if r[0] < d])
            hist = closes.loc[:d]
            spy = hist["SPY"].dropna()
            spy_trend = (spy.iloc[-50:].mean() / spy.iloc[-200:].mean() - 1.0) if len(spy) >= 200 else None
            above = counted = 0
            for t in EQUITY_UNIVERSE:
                if t not in hist.columns:
                    continue
                c = hist[t].dropna()
                if len(c) < 50:
                    continue
                counted += 1
                above += c.iloc[-1] >= c.iloc[-50:].mean()
            breadth = round(100.0 * above / counted, 1) if counted else None
            s.add(MarketRegime(
                as_of=datetime(d.year, d.month, d.day, 21, 0, tzinfo=timezone.utc),
                vix=vix, vix_5d_change=vix_5d,
                spy_trend=round(spy_trend, 4) if spy_trend is not None else None,
                t10y2y=t10, breadth_pct=breadth,
                regime_label=regime._label(vix, spy_trend, t10, breadth),
                meta={"sources": {"vix": vix_src, "t10y2y": "FRED T10Y2Y"},
                      "backfill": "dev_bootstrap"},
            ))
            n += 1
    return n


def run_regime(bars: dict[str, pd.DataFrame], days: list[date]) -> None:
    from bot.signals import regime

    n = backfill_regime(bars, days)
    ok, res = record_job("regime_daily", regime.run)
    latest = regime.latest()
    status = "real" if ok and latest and latest.get("vix") is not None else "partial"
    _report("market_regime", status,
            f"{n} backfilled daily rows + live compute_today() -> {latest and latest.get('regime_label')}"
            f" (vix={latest and latest.get('vix')}, t10y2y={latest and latest.get('t10y2y')})")


def _earnings_history_yf(tickers: set[str]) -> int:
    """EPS-surprise history for ``tickers`` through the production path
    (bot/signals/earnings.py → yfinance), so the dev DB gets the same
    "YYYY-Qn" quarter labels and fraction-unit surprises as the live job —
    and any date-labelled rows from older bootstraps are replaced."""
    from bot.signals import earnings

    return earnings.refresh_history_for(sorted(tickers))


def _earnings_calendar_yf(days_ahead: int = 14) -> int:
    """Fallback when the NASDAQ calendar API is blocked."""
    now = datetime.now(timezone.utc)
    added = 0
    with SessionLocal.begin() as s:
        for t in EQUITY_UNIVERSE:
            try:
                df = yf.Ticker(_yf_symbol(t)).get_earnings_dates(limit=4)
            except Exception:
                continue
            if df is None or df.empty:
                continue
            for ts, row in df.iterrows():
                when = ts.to_pydatetime().astimezone(timezone.utc)
                if not (now <= when <= now + timedelta(days=days_ahead)):
                    continue
                est = row.get("EPS Estimate")
                # Production stores the report *day* at 00:00 UTC (the
                # calendar's idempotency key); match it.
                day = ts.to_pydatetime().astimezone(ET).date()
                s.add(EarningsCalendar(
                    ticker=t, report_date=datetime(day.year, day.month, day.day, tzinfo=timezone.utc),
                    time_of_day="bmo" if ts.to_pydatetime().astimezone(ET).hour < 12 else "amc",
                    eps_estimate=None if pd.isna(est) else float(est)))
                added += 1
    return added


def run_earnings(held: set[str]) -> None:
    from bot.signals import earnings

    ok, res = record_job("earnings_daily", earnings.run)
    res = res if isinstance(res, dict) else {}
    with SessionLocal() as s:
        cal = s.scalar(select(func.count()).select_from(EarningsCalendar))
    cal_src = "NASDAQ calendar API"
    if not cal:
        cal = _earnings_calendar_yf()
        cal_src = "yfinance get_earnings_dates (NASDAQ API returned nothing)"
    _report("earnings_calendar", "real" if cal else "empty", f"{cal} upcoming rows via {cal_src}")

    with SessionLocal() as s:
        upcoming = set(s.scalars(select(EarningsCalendar.ticker)).all())
    # earnings.run() already covered tickers reporting soon; this adds held
    # names (and calendar rows from the yfinance fallback). Fresh tickers are
    # skipped, so nothing is fetched twice.
    _earnings_history_yf(upcoming | held)
    with SessionLocal() as s:
        hist = s.scalar(select(func.count()).select_from(EarningsHistory))
    _report("earnings_history", "real" if hist else "empty",
            f"{hist} quarter rows via yfinance earnings history (bot/signals/earnings.py)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="wipe a non-empty DB and rebuild it")
    ap.add_argument("--skip", default="", help=f"comma list of sources to skip: {sorted(SKIPPABLE)}")
    ap.add_argument("--llm-days", type=int, default=90,
                    help="research_log sections to keep, counted back from the newest one")
    args = ap.parse_args()
    skip = {x.strip() for x in args.skip.split(",") if x.strip()}
    if skip - SKIPPABLE:
        ap.error(f"unknown --skip values: {sorted(skip - SKIPPABLE)}")

    logger.remove()
    logger.add(sys.stderr, level="INFO")

    if not settings.dry_run:
        logger.error("Refusing: DRY_RUN=false in .env looks like the live bot's config. "
                     "This script is for dev checkouts only (set DRY_RUN=true).")
        return 2
    init_db()
    counts = _table_counts()
    if any(counts.values()):
        if not args.force:
            populated = {k: v for k, v in counts.items() if v}
            logger.error("Refusing: {} already has rows {}. Re-run with --force to wipe and "
                         "rebuild.", settings.db_path, populated)
            return 1
        _wipe()
    t_start = time.monotonic()

    # --- memory files ---
    events = parse_trade_log(llm_memory.read("trade_log"))
    pf = parse_portfolio(llm_memory.read("portfolio"))
    log_text = llm_memory.read("research_log")
    sections = parse_research_log(log_text)
    logger.info("trade_log: {} entries | portfolio.md: {} holdings as of {} | research_log: {} sections",
                len(events), len(pf.holdings), pf.as_of.isoformat(), len(sections))

    # --- prices ---
    extra = sorted({e.ticker for e in events} - set(FULL_UNIVERSE))   # e.g. GM
    start = datetime.now(ET).date() - timedelta(days=PRICE_LOOKBACK_DAYS)
    t0 = time.monotonic()
    ok, bars = record_job(
        "price_refresh",
        lambda: download_bars(list(dict.fromkeys(FULL_UNIVERSE + list(MONITOR_EXTRA) + extra + ["^VIX"])), start),
        message="dev_bootstrap: yfinance batch download (Alpaca not contacted)",
    )
    if not ok or not bars or "SPY" not in bars:
        logger.error("price download failed — nothing else can be built without closes")
        return 3
    n_px = store_price_history(bars)
    missing = [t for t in FULL_UNIVERSE if t not in bars]
    _report("price_history", "real",
            f"{n_px} daily closes for {len(FULL_UNIVERSE) - len(missing)}/{len(FULL_UNIVERSE)} "
            f"universe tickers via yfinance in {time.monotonic() - t0:.1f}s"
            + (f"; missing {missing}" if missing else ""))

    days = [d for d in bars["SPY"].index if d >= INCEPTION_DAY]
    closes = pd.DataFrame({t: b["Close"] for t, b in bars.items()}).sort_index().ffill()
    closes = closes.reindex(days).ffill()

    # --- ledger: trades / decisions / positions ---
    exits, seeds = reconstruct_ledger(events, pf, bars, days, sections)
    ledger = events + exits
    store_trades(ledger)
    store_positions(pf, ledger, bars)
    _report("trades/decisions", "real",
            f"{len(events)} from trade_log.md + {len(exits)} reconstructed exits")
    for e in exits:
        logger.info("  reconstructed exit {} {:>8.4f} @ ${:.2f} on {}{}", e.ticker, e.qty, e.price,
                    e.ts.astimezone(ET).date(), " (fallback)" if e.inferred["fallback"] else "")
    _report("positions", "real",
            f"{len(pf.holdings)} holdings from portfolio.md marked to {days[-1]} closes"
            + (f"; held since before the trade log: {sorted(seeds)}" if seeds else ""))

    # --- equity curve ---
    anchors = equity_anchors(sections, pf.as_of.astimezone(ET).date())
    anchors[pf.as_of.astimezone(ET).date()] = pf.equity        # portfolio.md is authoritative
    m = re.search(r"start equity \**\$([\d,]+\.\d{2})", log_text)
    if m:
        anchors[INCEPTION_DAY] = _money(m[1])
    n_snap, cash0 = build_snapshots(days, ledger, seeds, pf, closes, anchors)
    _report("portfolio_snapshots", "real",
            f"{n_snap} daily closes {days[0]} -> {days[-1]}: replay on real prices (inferred "
            f"starting cash ${cash0:,.2f}) pinned to {len(anchors)} real equity readings from "
            f"research_log/portfolio.md; holdings carried forward after {pf.as_of.date()}")

    # --- LLM runs ---
    n_llm = store_llm_runs(sections, events, args.llm_days)
    _report("llm_runs", "real", f"{n_llm} runs reconstructed from research_log.md sections "
            f"(last {args.llm_days}d of the log; tool_trace/tool_calls estimated, cost 0)")

    # --- real upstream sources ---
    if "news" in skip:
        _report("news_items", "skipped", "--skip")
    else:
        run_news()
    run_signals(skip)
    if "regime" in skip:
        _report("market_regime", "skipped", "--skip")
    else:
        run_regime(bars, days)
    if "earnings" in skip:
        _report("earnings", "skipped", "--skip")
    else:
        run_earnings(set(pf.holdings))

    if "macro" in skip:
        _report("macro_series", "skipped", "--skip")
    else:
        from bot.signals import macro as macro_job
        ok_m, res_m = record_job("macro_daily", lambda: macro_job.refresh_all(), message="dev_bootstrap: FRED macro series")
        _report("macro_series", "real" if ok_m else "skipped", f"FRED series → {res_m}")
    if "profiles" in skip:
        _report("company_profiles", "skipped", "--skip")
    else:
        from bot.signals import profiles as profiles_job
        ok_p, n_p = record_job("profiles_weekly", lambda: profiles_job.refresh(pause=0.1), message="dev_bootstrap: yfinance profiles")
        _report("company_profiles", "real" if ok_p else "skipped", f"{n_p} yfinance profiles (market caps for the heatmap)")

    n_hb = store_heartbeats()
    _report("job_runs", "synthetic", f"{n_hb} heartbeat rows + the real runs above")

    # --- summary ---
    print("\n" + "=" * 78)
    print(f"dev_bootstrap finished in {time.monotonic() - t_start:.0f}s -> {settings.db_path}")
    print("-" * 78)
    for table, n in sorted(_table_counts().items()):
        print(f"  {table:<22} {n:>7}")
    print("-" * 78)
    for source, status, detail in REPORT:
        print(f"  [{status:^9}] {source}: {detail}")
    print("=" * 78)
    assert "alpaca" not in sys.modules and "bot.alpaca_client" not in sys.modules
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
