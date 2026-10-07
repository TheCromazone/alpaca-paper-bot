"""SEC EDGAR 13F tracker.

For each tracked CIK in `config.TRACKED_INVESTORS`, diffs the holdings of the
two most recent 13F-HR report periods and emits buy/sell signals. Runs weekly
(13Fs land quarterly, ≤45 days after quarter end).

Pipeline per fund:
1. ``data.sec.gov/submissions/CIK##########.json`` → 13F-HR / 13F-HR/A
   filings with their report period and filing date.
2. Per report period pick the authoritative filing: the newest RESTATEMENT
   amendment if any, else the original 13F-HR, plus any NEW HOLDINGS
   amendments filed after it (amendment type read from ``primary_doc.xml``).
3. ``Archives/.../{accession}/index.json`` → the raw information-table XML.
   Its file name is free-form (``infotable.xml``, ``56757.xml``,
   ``MLP_Filing_20260630.xml`` ...). Never the ``xslForm13F_X02/...`` copy:
   that path is the SEC's *rendered HTML* view of the same document.
4. Aggregate holdings per CUSIP (common/ETF shares only — put/call option
   rows and PRN principal amounts are skipped), map CUSIP → universe ticker,
   and value the *share* change at the newer quarter's price, so a fund that
   merely held through a rally doesn't read as a buyer. Old share counts are
   scaled by the actual split events between the two period-ends (yfinance);
   a ticker held in both quarters whose split history is unknown, or whose
   CUSIP changed onto a different share basis, is dropped for that pair.
5. Store: the (investor, period) rows are replaced by the recomputed set in
   one transaction; rows under a CIK no longer configured for the name are
   purged.

SEC fair-access: descriptive User-Agent (``settings.sec_user_agent``), ≤~7
requests/s via a module-level throttle, timeouts and one back-off retry on
429/5xx on every request.
"""
from __future__ import annotations

import ast
import io
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Iterable
from xml.etree import ElementTree as ET

import requests
from loguru import logger
from sqlalchemy import desc, select

from bot.config import FULL_UNIVERSE, INVESTOR_WEIGHTS, TRACKED_INVESTORS, settings
from bot.db import JobRun, Signal, SessionLocal


EDGAR_SUBMISSIONS = "https://data.sec.gov/submissions/CIK{cik}.json"
EDGAR_FILING_DIR = "https://www.sec.gov/Archives/edgar/data/{cik_int}/{accession_nodash}/"

HTTP_TIMEOUT_S = (10, 60)        # (connect, read) — infotables run to ~10 MB
_SEC_MIN_INTERVAL_S = 0.15       # ≤ ~7 req/s, under SEC's 10 req/s ceiling
_last_request_at = 0.0

MIN_DELTA_USD = 1_000_000        # ignore sub-$1M rebalancing noise
MAX_FILING_AGE_DAYS = 200        # newest 13F older than this → fund stopped filing
# Total reported book moving more than this factor in one quarter means the
# filing's scope changed (a new reporting entity took over the book, other
# managers folded in) rather than real trading — e.g. Pershing Square Inc.'s
# Q1-2026 13F held only HHH, its Q2 the whole $19B book. Diffing those would
# invent a "new position" for every holding, so the pair is skipped.
MAX_BOOK_CHANGE_FACTOR = 4.0
# A fund skipped (incomplete filing chain, failed lookups) in this many
# consecutive ISO weeks turns the investors_refresh JobRun "failed".
CHRONIC_SKIP_WEEKS = 3
# When a ticker's CUSIP changes between quarters (spin-off, reverse split
# reissue, share-class switch) share counts are only compared if both sides'
# split-adjusted prices are within this factor — i.e. the same share basis.
# BRK class A → class B (≈1,500×) fails it and is skipped.
COMPARABLE_PRICE_FACTOR = 2.0
# Since 2023-01-03 Form 13F reports <value> in whole dollars; before that,
# in thousands. Some filers still report thousands (Duquesne's Q2-2026 13F:
# 336,300 GOOGL shares, value 120,184), so units are inferred per filing from
# the implied share prices; the filing date only decides when no row has a
# share count.
_DOLLAR_VALUES_SINCE = "2023-01-03"
_THOUSANDS_IF_MEDIAN_PRICE_BELOW = 1.0   # $/share; listed equities trade far above $1

# 13F rows carry the issuer's CUSIP; issuer names are SEC abbreviations
# ("BANK AMER CORP", "ISHARES TR", "LILLY ELI & CO") that name matching can't
# resolve and that collide with unrelated issuers (Amdocs→AMD, Apple
# Hospitality→AAPL, Berkshire Hills→BRK.B). Exact CUSIP is the only reliable
# key. Verified 2026-10-07 against live Q2-2026 13F information tables
# (Millennium, Citadel, D.E. Shaw, Point72, RenTech, Bridgewater). Every
# FULL_UNIVERSE ticker must appear here (tests enforce it); when a ticker's
# CUSIP changes (spin-off, reverse split) add the new one alongside the old.
CUSIP_TO_TICKER: dict[str, str] = {
    "037833100": "AAPL", "594918104": "MSFT", "67066G104": "NVDA",
    "02079K305": "GOOGL", "02079K107": "GOOGL",   # class A + class C → GOOGL
    "30303M102": "META", "023135106": "AMZN", "64110L106": "NFLX",
    "11135F101": "AVGO", "79466L302": "CRM", "00724F101": "ADBE",
    "68389X105": "ORCL", "007903107": "AMD", "458140100": "INTC",
    "17275R102": "CSCO", "747525103": "QCOM", "882508104": "TXN",
    "459200101": "IBM", "038222105": "AMAT", "512807306": "LRCX",
    "595112103": "MU", "482480100": "KLAC", "81762P102": "NOW",
    "697435105": "PANW", "22788C105": "CRWD", "833445109": "SNOW",
    "90353T100": "UBER",
    "88160R101": "TSLA", "931142103": "WMT", "437076102": "HD",
    "654106103": "NKE", "22160K105": "COST", "855244109": "SBUX",
    "580135101": "MCD", "742718109": "PG", "191216100": "KO",
    "713448108": "PEP", "254687106": "DIS", "548661107": "LOW",
    "87612E106": "TGT", "09857L108": "BKNG",
    "46625H100": "JPM", "060505104": "BAC", "949746101": "WFC",
    "38141G104": "GS", "617446448": "MS",
    "084670702": "BRK.B", "084670108": "BRK.B",   # class B + class A → BRK.B
    "92826C839": "V", "57636Q104": "MA", "025816109": "AXP",
    "09290D101": "BLK", "808513105": "SCHW", "172967424": "C",
    "693475105": "PNC", "902973304": "USB",
    "91324P102": "UNH", "478160104": "JNJ", "532457108": "LLY",
    "717081103": "PFE", "58933Y105": "MRK", "00287Y109": "ABBV",
    "883556102": "TMO", "002824100": "ABT", "235851102": "DHR",
    "110122108": "BMY", "125523100": "CI", "036752103": "ELV",
    "149123101": "CAT", "097023105": "BA", "369604301": "GE",
    "438516205": "HON", "438516106": "HON",       # current + pre-2026 CUSIP
    "911312106": "UPS", "907818108": "UNP",
    "244199105": "DE", "539830109": "LMT", "75513E101": "RTX",
    "30231G102": "XOM", "166764100": "CVX", "20825C104": "COP",
    "806857108": "SLB",
    "G54950103": "LIN", "824348106": "SHW", "009158106": "APD",
    "74340W103": "PLD", "03027X100": "AMT", "29444U700": "EQIX",
    "65339F101": "NEE", "26441C204": "DUK", "842587107": "SO",
    "25746U109": "D",
    "78462F103": "SPY", "46090E103": "QQQ", "78467X109": "DIA",
    "464287655": "IWM", "922908769": "VTI",
    "464287226": "AGG", "921937835": "BND", "464287432": "TLT",
    "464287440": "IEF", "464287457": "SHY", "464287242": "LQD",
    "464288513": "HYG", "464287176": "TIP",
}

# Share classes that roll up to a universe ticker but split on their own
# schedule: their split history is looked up under their own symbol.
_CUSIP_SPLIT_SYMBOL = {"02079K107": "GOOG", "084670108": "BRK.A"}
# Split-factor value for an event that isn't a share-count split (a spin-off
# Yahoo booked as a fractional "split"): the pair is definitively not
# comparable. Distinct from None = the lookup itself failed (outage).
NOT_A_SPLIT = 0.0
# (old period-end, new period-end) → {symbol: cumulative split factor | None}.
# Cleared at the start of every refresh so a yfinance outage isn't pinned.
_SPLIT_CACHE: dict[tuple[str, str], dict[str, float | None]] = {}


@dataclass
class InvestorTrade:
    investor: str
    ticker: str
    direction: str  # buy | sell
    amount: float   # |delta| in dollars, valued at the newer quarter's price
    traded_on: datetime   # filing date of the newer 13F (when it became public)
    source_url: str
    meta: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def _headers() -> dict:
    return {"User-Agent": settings.sec_user_agent, "Accept-Encoding": "gzip, deflate"}


def _sec_get(url: str) -> requests.Response | None:
    """Throttled GET. Returns the 200 response, or None (logged) otherwise."""
    global _last_request_at
    for attempt in range(2):
        wait = _SEC_MIN_INTERVAL_S - (time.monotonic() - _last_request_at)
        if wait > 0:
            time.sleep(wait)
        _last_request_at = time.monotonic()
        try:
            r = requests.get(url, headers=_headers(), timeout=HTTP_TIMEOUT_S)
        except requests.RequestException as exc:
            logger.warning("SEC GET {} failed: {}", url, exc)
            return None
        if r.status_code == 200:
            return r
        if r.status_code in (429, 500, 502, 503, 504) and attempt == 0:
            time.sleep(2.0)
            continue
        logger.warning("SEC GET {} -> HTTP {}", url, r.status_code)
        return None
    return None


# ---------------------------------------------------------------------------
# Filing discovery
# ---------------------------------------------------------------------------


def _recent_13f_filings(cik: str) -> tuple[str, list[dict]]:
    """(EDGAR entity name, 13F-HR + 13F-HR/A filings newest-filed first)."""
    r = _sec_get(EDGAR_SUBMISSIONS.format(cik=cik))
    if r is None:
        raise _IncompleteFiling("EDGAR submissions unavailable")
    try:
        data = r.json()
    except ValueError as exc:
        raise _IncompleteFiling("EDGAR submissions unparseable") from exc
    recent = data.get("filings", {}).get("recent", {})
    out = []
    for form, acc, filed, period in zip(
        recent.get("form", []), recent.get("accessionNumber", []),
        recent.get("filingDate", []), recent.get("reportDate", []),
    ):
        if form in ("13F-HR", "13F-HR/A") and period:
            out.append({"form": form, "accession": acc, "filed": filed, "period": period})
    out.sort(key=lambda f: (f["filed"], f["accession"]), reverse=True)
    return data.get("name", ""), out


def _filing_dir(cik: str, accession: str) -> str:
    return EDGAR_FILING_DIR.format(cik_int=int(cik), accession_nodash=accession.replace("-", ""))


def _filing_index_url(cik: str, accession: str) -> str:
    return _filing_dir(cik, accession) + f"{accession}-index.htm"


class _IncompleteFiling(Exception):
    """A document in the filing chain couldn't be fetched or parsed. The fund
    is skipped for the week rather than saved from a partial picture."""


def _amendment_type(cik: str, accession: str) -> str:
    """'RESTATEMENT' | 'NEW HOLDINGS' | '' (no type given) for a 13F-HR/A.
    Raises _IncompleteFiling when the cover page can't be read: guessing
    would fall back to an original the amendment may have restated."""
    r = _sec_get(_filing_dir(cik, accession) + "primary_doc.xml")
    if r is None:
        raise _IncompleteFiling(f"amendment {accession}: cover page unavailable")
    try:
        root = ET.fromstring(r.content)
    except ET.ParseError as exc:
        raise _IncompleteFiling(f"amendment {accession}: cover page unparseable ({exc})") from exc
    for el in root.iter():
        if el.tag.rsplit("}", 1)[-1] == "amendmentType":
            return (el.text or "").strip().upper()
    return ""


def _resolve_period(cik: str, group: list[dict]) -> tuple[dict | None, list[dict]]:
    """Pick the authoritative filing for one report period.

    ``group`` is newest-filed first. Walk back until the newest complete
    report (a RESTATEMENT amendment or the original 13F-HR); NEW HOLDINGS
    amendments seen on the way were filed after it and supplement it.
    """
    supplements: list[dict] = []
    for f in group:
        if f["form"] == "13F-HR":
            return f, supplements
        kind = _amendment_type(cik, f["accession"])
        if kind == "RESTATEMENT":
            return f, supplements
        if kind == "NEW HOLDINGS":
            supplements.append(f)
        # Unknown amendment type: ignore it rather than risk diffing a
        # partial list against a full one.
    return None, []


def _infotable_url(cik: str, accession: str) -> str | None:
    """Locate the raw information-table XML via the filing's index.json."""
    base = _filing_dir(cik, accession)
    r = _sec_get(base + "index.json")
    if r is None:
        return None
    try:
        items = r.json()["directory"]["item"]
    except (ValueError, KeyError, TypeError):
        return None
    names = [
        i.get("name", "") for i in items
        if i.get("name", "").lower().endswith(".xml")
        and i.get("name", "").lower() != "primary_doc.xml"
    ]
    if not names:
        return None
    # Usually exactly one; prefer the conventional names when there are more.
    names.sort(key=lambda n: (("info" not in n.lower() and "table" not in n.lower()), n))
    return base + names[0]


# ---------------------------------------------------------------------------
# Information table parsing
# ---------------------------------------------------------------------------


def parse_infotable(xml_bytes: bytes, *, filed: str = "") -> dict[str, dict] | None:
    """Aggregate an information table to {cusip: {name, shares, value}}.

    Share positions only (sshPrnamtType SH, no putCall). The same CUSIP is
    listed once per investment-discretion / other-manager combination, so
    rows are summed. ``value`` is returned in dollars. None when the XML is
    malformed or isn't an information table at all (a truncated download or
    a 200-OK HTML error page is not an empty portfolio).
    """
    out: dict[str, dict] = {}
    prices: list[float] = []
    root_seen = False
    try:
        for event, el in ET.iterparse(io.BytesIO(xml_bytes), events=("start", "end")):
            if event == "start":
                if not root_seen:
                    root_seen = True
                    if el.tag.rsplit("}", 1)[-1] != "informationTable":
                        logger.warning("13F information table: unexpected <{}> document", el.tag)
                        return None
                continue
            if el.tag.rsplit("}", 1)[-1] != "infoTable":
                continue
            row: dict[str, str] = {}
            for child in el.iter():
                tag = child.tag.rsplit("}", 1)[-1]
                if tag in ("nameOfIssuer", "cusip", "value", "sshPrnamt", "sshPrnamtType", "putCall"):
                    row[tag] = (child.text or "").strip()
            el.clear()
            if row.get("putCall") or row.get("sshPrnamtType", "SH").upper() != "SH":
                continue
            cusip = row.get("cusip", "").upper()
            if not cusip:
                continue
            try:
                value = float(row.get("value") or 0)
                shares = float(row.get("sshPrnamt") or 0)
            except ValueError:
                continue
            if value > 0 and shares > 0:
                prices.append(value / shares)
            agg = out.setdefault(cusip, {"name": row.get("nameOfIssuer", ""), "shares": 0.0, "value": 0.0})
            agg["shares"] += shares
            agg["value"] += value
    except ET.ParseError as exc:
        logger.warning("13F information table parse failed: {}", exc)
        return None
    if not root_seen:
        return None
    if prices:
        thousands = sorted(prices)[len(prices) // 2] < _THOUSANDS_IF_MEDIAN_PRICE_BELOW
    else:
        thousands = bool(filed) and filed < _DOLLAR_VALUES_SINCE
    if thousands:
        for agg in out.values():
            agg["value"] *= 1000.0
    return out


def _fetch_holdings(cik: str, filing: dict) -> dict[str, dict] | None:
    url = _infotable_url(cik, filing["accession"])
    if url is None:
        logger.warning("13F {}: no information table in filing index", filing["accession"])
        return None
    r = _sec_get(url)
    if r is None:
        return None
    return parse_infotable(r.content, filed=filing["filed"])


def _merge(base: dict[str, dict], extra: dict[str, dict]) -> dict[str, dict]:
    out = {k: dict(v) for k, v in base.items()}
    for cusip, h in extra.items():
        agg = out.setdefault(cusip, {"name": h["name"], "shares": 0.0, "value": 0.0})
        agg["shares"] += h["shares"]
        agg["value"] += h["value"]
    return out


# ---------------------------------------------------------------------------
# Quarter-over-quarter diff
# ---------------------------------------------------------------------------


def _is_split_ratio(ratio: float) -> bool:
    """True for share-count splits (2, 25, 3:2, 5:4, 1:8 reverse ...). Yahoo
    also books spin-offs as fractional "splits" (HON 0.9535, GE 1.253) that
    leave share counts unchanged; those aren't small-denominator ratios."""
    r = ratio if ratio >= 1 else 1 / ratio
    return any(abs(r * d - round(r * d)) < 1e-3 * d for d in range(1, 11))


def _fetch_split_factors(symbols: list[str], start_period: str, end_period: str) -> dict[str, float | None]:
    """Cumulative split factor per symbol from yfinance's split events that
    took effect after ``start_period`` (the older 13F's period-end) up to and
    including ``end_period``. 10.0 = 10-for-1; 0.1 = 1-for-10 reverse; 1.0 =
    no split; NOT_A_SPLIT = an event that isn't a share-count split (a
    spin-off booked as a fractional split); None = lookup failed (no data)."""
    import yfinance as yf

    start = (date.fromisoformat(start_period) + timedelta(days=1)).isoformat()
    end = (date.fromisoformat(end_period) + timedelta(days=1)).isoformat()   # exclusive
    yf_symbols = {sym: sym.replace(".", "-") for sym in symbols}
    try:
        df = yf.download(sorted(set(yf_symbols.values())), start=start, end=end, actions=True,
                         auto_adjust=False, progress=False, threads=True)
    except Exception as exc:   # yfinance raises a zoo of HTTP/parse errors
        logger.warning("13F split lookup {}..{} failed: {}", start, end, exc)
        return {sym: None for sym in symbols}
    out: dict[str, float | None] = {}
    for sym, ysym in yf_symbols.items():
        try:
            close, events = df["Close"][ysym], df["Stock Splits"][ysym]
        except (KeyError, TypeError):
            out[sym] = None
            continue
        if close.notna().sum() == 0:
            out[sym] = None
            continue
        factor: float | None = 1.0
        for ratio in events.dropna():
            if ratio <= 0:
                continue
            if not _is_split_ratio(float(ratio)):
                factor = NOT_A_SPLIT
                break
            factor *= float(ratio)
        out[sym] = factor
    return out


def _split_factors(start_period: str, end_period: str) -> dict[str, float | None]:
    key = (start_period, end_period)
    if key not in _SPLIT_CACHE:
        symbols = sorted(set(FULL_UNIVERSE) | set(_CUSIP_SPLIT_SYMBOL.values()))
        _SPLIT_CACHE[key] = _fetch_split_factors(symbols, start_period, end_period)
    return _SPLIT_CACHE[key]


def _class_delta(ticker: str, cls: str, cusips: list[str], o: dict, n: dict,
                 split_factors: dict, unresolved: set) -> float | None:
    """Dollar change for one share class (one or more CUSIPs, more only when
    the class was renumbered), or None when it can't be computed honestly."""
    held_old = [c for c in cusips if o[c]["shares"] > 0 or o[c]["value"] > 0]
    held_new = [c for c in cusips if n[c]["shares"] > 0 or n[c]["value"] > 0]
    value_old = sum(o[c]["value"] for c in held_old)
    value_new = sum(n[c]["value"] for c in held_new)
    if not held_old or not held_new:
        return value_new - value_old          # class opened or fully exited
    factor = split_factors.get(cls)
    if factor is None:
        unresolved.add(ticker)                # lookup failed: keep what's stored
        logger.debug("13F {}: split history unavailable, skipping this quarter pair", ticker)
        return None
    if factor == NOT_A_SPLIT:
        logger.debug("13F {}: non-split corporate action, skipping this quarter pair", ticker)
        return None
    if any(o[c]["shares"] <= 0 for c in held_old) or any(n[c]["shares"] <= 0 for c in held_new):
        return None
    if held_old == held_new:
        # Same security both quarters: share change at the newer price.
        return sum((n[c]["shares"] - o[c]["shares"] * factor) * (n[c]["value"] / n[c]["shares"])
                   for c in held_new)
    # Same class under a new CUSIP (HON's renumbering): compare total shares,
    # but only on the same share basis.
    o_sh = sum(o[c]["shares"] for c in held_old) * factor
    n_sh = sum(n[c]["shares"] for c in held_new)
    old_px, new_px = value_old / o_sh, value_new / n_sh
    if not (1 / COMPARABLE_PRICE_FACTOR <= new_px / old_px <= COMPARABLE_PRICE_FACTOR):
        logger.debug("13F {}: CUSIP change onto a different share basis, skipping", ticker)
        return None
    return (n_sh - o_sh) * new_px


def _ticker_delta(ticker: str, cusips: list[str], older: dict, newer: dict,
                  split_factors: dict, unresolved: set) -> float | None:
    """Dollar change for one ticker: each share class (GOOG vs GOOGL, BRK.A
    vs BRK.B — 1 A ≈ 1,500 B) is valued on its own and the dollar changes
    summed. None if any class can't be computed."""
    empty = {"shares": 0.0, "value": 0.0}
    o = {c: older.get(c, empty) for c in cusips}
    n = {c: newer.get(c, empty) for c in cusips}
    classes: dict[str, list[str]] = {}
    for c in cusips:
        classes.setdefault(_CUSIP_SPLIT_SYMBOL.get(c, ticker), []).append(c)
    total = 0.0
    for cls, members in sorted(classes.items()):
        delta = _class_delta(ticker, cls, members, o, n, split_factors, unresolved)
        if delta is None:
            return None
        total += delta
    return total


def diff_holdings(
    older: dict[str, dict], newer: dict[str, dict], investor: str, *,
    filed: str, source_url: str, meta: dict | None = None,
    split_factors: dict[str, float | None] | None = None,
    unresolved: set[str] | None = None,
) -> list[InvestorTrade]:
    """Per-ticker dollar change between two quarters' holdings.

    delta = (new shares − old shares × split factor) × newer price. Split
    factors are actual split events between the two period-ends
    (``split_factors``, keyed by symbol); a ticker held in both quarters
    whose factor is unknown is dropped for this pair rather than guessed;
    tickers dropped because the lookup *failed* are added to ``unresolved``.
    """
    split_factors = split_factors or {}
    unresolved = unresolved if unresolved is not None else set()
    by_ticker: dict[str, list[str]] = {}
    for cusip in set(older) | set(newer):
        ticker = CUSIP_TO_TICKER.get(cusip)
        if ticker is not None and ticker in FULL_UNIVERSE:
            by_ticker.setdefault(ticker, []).append(cusip)

    traded_on = datetime.strptime(filed, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    trades: list[InvestorTrade] = []
    for ticker, cusips in sorted(by_ticker.items()):
        delta = _ticker_delta(ticker, sorted(cusips), older, newer, split_factors, unresolved)
        if delta is None or abs(delta) < MIN_DELTA_USD:
            continue
        value_old = sum(older[c]["value"] for c in cusips if c in older)
        value_new = sum(newer[c]["value"] for c in cusips if c in newer)
        if value_old <= 0:
            change = "new"
        elif value_new <= 0:
            change = "exit"
        else:
            change = "add" if delta > 0 else "trim"
        trades.append(InvestorTrade(
            investor=investor,
            ticker=ticker,
            direction="buy" if delta > 0 else "sell",
            amount=round(abs(delta), 2),
            traded_on=traded_on,
            source_url=source_url,
            meta={**(meta or {}), "change": change,
                  "value_old": round(value_old, 2), "value_new": round(value_new, 2)},
        ))
    return trades


# ---------------------------------------------------------------------------
# Job
# ---------------------------------------------------------------------------


def _latest_two_periods(cik: str, filings: list[dict]) -> list[tuple[dict, list[dict]]]:
    by_period: dict[str, list[dict]] = {}
    for f in filings:
        by_period.setdefault(f["period"], []).append(f)
    out = []
    for period in sorted(by_period, reverse=True):
        main, supplements = _resolve_period(cik, by_period[period])
        if main is not None:
            out.append((main, supplements))
        if len(out) == 2:
            break
    return out


def _holdings_for(cik: str, main: dict, supplements: list[dict]) -> dict[str, dict]:
    """The period's full holdings: the main report plus every NEW HOLDINGS
    amendment. Raises _IncompleteFiling if any of them can't be loaded —
    Berkshire, for one, discloses confidential positions only that way."""
    holdings = _fetch_holdings(cik, main)
    if holdings is None:
        raise _IncompleteFiling(f"information table {main['accession']} unavailable")
    for sup in supplements:
        extra = _fetch_holdings(cik, sup)
        if extra is None:
            raise _IncompleteFiling(f"NEW HOLDINGS amendment {sup['accession']} unavailable")
        holdings = _merge(holdings, extra)
    return holdings


def _diff_for(cik: str, investor: str, cache: dict) -> tuple[str, list[InvestorTrade], set[str]] | None:
    """(report period, changes, tickers left unresolved by a failed split
    lookup) when the latest quarter pair loaded completely; None when the
    filer has nothing usable this week (stale filer, scope change). Raises
    _IncompleteFiling when a document in the chain couldn't be loaded."""
    if cik not in cache:
        try:
            cache[cik] = _load_quarter_pair(cik)
        except _IncompleteFiling as exc:
            cache[cik] = exc
    raw = cache[cik]
    if isinstance(raw, _IncompleteFiling):
        raise raw
    if raw is None:
        return None
    older, newer, newest, previous, filer_name = raw
    meta = {
        "investor": investor,
        "filer_name": filer_name,
        "cik": cik,
        "accession": newest["accession"],
        "form": newest["form"],
        "period": newest["period"],
        "prior_period": previous["period"],
        "filed": newest["filed"],
        # Total reported value of share positions (options / principal rows
        # excluded), in dollars after units inference. tools._rank_13f
        # scales |Δ$| by the fund's book for the period.
        "book_total": round(sum(h["value"] for h in newer.values()), 2),
        "book_total_prior": round(sum(h["value"] for h in older.values()), 2),
    }
    unresolved: set[str] = set()
    trades = diff_holdings(
        older, newer, investor,
        filed=newest["filed"],
        source_url=_filing_index_url(cik, newest["accession"]),
        meta=meta,
        split_factors=_split_factors(previous["period"], newest["period"]),
        unresolved=unresolved,
    )
    return newest["period"], trades, unresolved


def changes_for_cik(cik: str, investor: str, *, cache: dict | None = None) -> list[InvestorTrade]:
    """Latest quarter-over-quarter changes for one filer ([] when unavailable)."""
    try:
        result = _diff_for(cik, investor, cache if cache is not None else {})
    except _IncompleteFiling as exc:
        logger.warning("13F CIK {}: {} — skipping", cik, exc)
        return []
    return result[1] if result else []


def _load_quarter_pair(cik: str):
    filer_name, filings = _recent_13f_filings(cik)
    if not filings:
        logger.info("13F CIK {}: no 13F-HR filings found", cik)
        return None
    periods = _latest_two_periods(cik, filings)
    if len(periods) < 2:
        return None
    (newest, new_sup), (previous, old_sup) = periods
    age = datetime.now(timezone.utc).date() - datetime.strptime(newest["filed"], "%Y-%m-%d").date()
    if age > timedelta(days=MAX_FILING_AGE_DAYS):
        logger.info("13F {} ({}): newest 13F filed {} — stale, skipping", filer_name, cik, newest["filed"])
        return None
    newer = _holdings_for(cik, newest, new_sup)
    older = _holdings_for(cik, previous, old_sup)
    if not newer:
        return None
    old_book = sum(h["value"] for h in older.values())
    new_book = sum(h["value"] for h in newer.values())
    if old_book <= 0 or not (1 / MAX_BOOK_CHANGE_FACTOR <= new_book / old_book <= MAX_BOOK_CHANGE_FACTOR):
        logger.info("13F {} ({}): book ${:,.0f} → ${:,.0f} between {} and {} — reporting scope "
                    "changed, skipping this pair", filer_name, cik, old_book, new_book,
                    previous["period"], newest["period"])
        return None
    return older, newer, newest, previous, filer_name


def refresh_all() -> int:
    return _refresh()[0]


def _refresh() -> tuple[int, dict[str, str]]:
    """Returns (new signals, {fund: why it was skipped or only partly
    refreshed this week})."""
    _SPLIT_CACHE.clear()
    purged = _purge_misattributed()
    if purged:
        logger.info("13F: deleted {} signals stored under a CIK no longer configured for their name", purged)
    total = 0
    skipped: dict[str, str] = {}
    cache: dict = {}   # per-CIK results; guards against a CIK listed under two names
    for name, cik in TRACKED_INVESTORS.items():
        try:
            result = _diff_for(cik, name, cache)
            if result is None:
                continue
            period, trades, unresolved = result
            if unresolved:
                skipped[name] = (f"split data unavailable for {', '.join(sorted(unresolved))} "
                                 "(stored rows kept)")
                logger.warning("{}: {}", name, skipped[name])
            added = _persist(name, period, trades, keep_tickers=unresolved)
            total += added
            logger.info("{}: {} 13F changes for {}, {} new signals", name, len(trades), period, added)
        except _IncompleteFiling as exc:
            skipped[name] = f"incomplete filing chain: {exc}"
            logger.warning("13F {}: {} — skipped this week", name, exc)
        except Exception as exc:
            skipped[name] = f"error: {exc}"
            logger.warning("13F refresh failed for {}: {}", name, exc)
    return total, skipped


def _iso_week(when: datetime) -> tuple[int, int]:
    iso = when.isocalendar()
    return iso[0], iso[1]


def _skipped_in(message: str | None) -> dict:
    try:
        parsed = ast.literal_eval(message or "")
    except (ValueError, SyntaxError):
        return {}
    return (parsed.get("skipped") or {}) if isinstance(parsed, dict) else {}


def _chronic_skips(skipped: dict[str, str], now: datetime) -> dict[str, int]:
    """{fund: consecutive ISO weeks skipped, counting this run} for funds
    skipped ≥ CHRONIC_SKIP_WEEKS weeks running. Several runs in one week
    (manual re-runs) count as that one week."""
    if not skipped:
        return {}
    with SessionLocal() as s:
        history = s.scalars(
            select(JobRun).where(JobRun.job_name == "investors_refresh")
            .where(JobRun.finished_at.isnot(None))
            .where(JobRun.started_at < now.replace(tzinfo=None))
            .order_by(desc(JobRun.started_at)).limit(60)
        ).all()
    chronic: dict[str, int] = {}
    for name in skipped:
        weeks = {_iso_week(now)}
        for jr in history:
            if name not in _skipped_in(jr.message):
                break
            weeks.add(_iso_week(jr.started_at))
        if len(weeks) >= CHRONIC_SKIP_WEEKS:
            chronic[name] = len(weeks)
    return chronic


def _purge_misattributed() -> int:
    """Delete investor signals that can't be trusted any more:
    * name no longer tracked (removed aliases, dead filers: "Scion (Michael
      Burry)", "Pershing Square Tontine", "Seth Klarman (Baupost)");
    * stored CIK isn't the one configured for the name (WEDGE Capital's rows
      stored as "Maverick Capital" before the CIK fix);
    * no cik/period in meta — written by the old pipeline, whose amounts
      were 1000× inflated."""
    with SessionLocal.begin() as s:
        stale = []
        for r in s.scalars(select(Signal).where(Signal.kind == "investor")).all():
            meta = r.meta or {}
            configured = TRACKED_INVESTORS.get(r.source)
            if configured is None or not meta.get("period") or meta.get("cik") != configured:
                stale.append(r)
        for row in stale:
            s.delete(row)
    return len(stale)


def _persist(investor: str, period: str, trades: Iterable[InvestorTrade],
             keep_tickers: set[str] = frozenset()) -> int:
    """Make the stored signals for (investor, report period) exactly
    ``trades``, in one transaction: unchanged rows stay as they are, changed
    ones are updated, and rows the recomputed diff no longer produces (an
    earlier, wrong computation; a restated filing) are deleted. The weekly
    job re-reads the same filings all quarter, so a rerun inserts nothing.
    Stored rows for ``keep_tickers`` (not recomputable this run because the
    split lookup failed) are left alone. Returns the number of rows inserted."""
    count = 0
    with SessionLocal.begin() as s:
        stored: dict[str, list[Signal]] = {}
        for row in s.scalars(
            select(Signal).where(Signal.kind == "investor").where(Signal.source == investor)
            .order_by(Signal.id)
        ).all():
            if (row.meta or {}).get("period") == period:
                stored.setdefault(row.ticker, []).append(row)
        for t in trades:
            meta = {
                "source_url": t.source_url,
                # Aggregator multiplies amount by `weight` from meta —
                # Berkshire's $5M move counts more than a multi-strat's.
                "weight": INVESTOR_WEIGHTS.get(t.investor, 1.0),
                "investor": t.investor,
                **t.meta,
            }
            rows = stored.pop(t.ticker, [])
            if rows:
                keep, extra = rows[0], rows[1:]
                for row in extra:
                    s.delete(row)
                if (keep.direction, keep.amount, keep.meta) != (t.direction, t.amount, meta):
                    keep.direction, keep.amount, keep.meta, keep.as_of = t.direction, t.amount, meta, t.traded_on
                continue
            s.add(Signal(
                ticker=t.ticker,
                kind="investor",
                source=t.investor,
                direction=t.direction,
                amount=t.amount,
                as_of=t.traded_on,
                meta=meta,
            ))
            count += 1
        for ticker, rows in stored.items():
            if ticker in keep_tickers:
                continue
            for row in rows:
                s.delete(row)
    return count


def run() -> dict:
    started = datetime.now(timezone.utc)
    with SessionLocal.begin() as s:
        jr = JobRun(job_name="investors_refresh", started_at=started, status="running")
        s.add(jr)
        s.flush()
        jr_id = jr.id
    out: dict = {"count": 0, "error": None, "skipped": {}}
    try:
        out["count"], out["skipped"] = _refresh()
        chronic = _chronic_skips(out["skipped"], started)
        if chronic:
            out["error"] = "13F funds skipped {} consecutive weeks: {}".format(
                CHRONIC_SKIP_WEEKS,
                "; ".join(f"{n} ({w} weeks): {out['skipped'][n]}" for n, w in sorted(chronic.items())))
            logger.error(out["error"])
    except Exception as exc:
        out["error"] = str(exc)
        logger.exception("investors_refresh failed")
    with SessionLocal.begin() as s:
        jr = s.get(JobRun, jr_id)
        jr.finished_at = datetime.now(timezone.utc)
        jr.status = "ok" if out["error"] is None else "failed"
        # Healthy funds are still saved when the run is marked failed; the
        # status flags the chronic skip for the dashboard / health check.
        jr.message = str(out)
    return out
