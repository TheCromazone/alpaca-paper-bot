"""Scrapes Senate Periodic Transaction Reports from the Senate eFD search.

Flow:
1. POST to https://efdsearch.senate.gov/search/home/ to accept the disclaimer
   and pick up a session cookie.
2. POST to /search/report/data/ with filters for type=PTR + recent date range.
   Response is JSON-ish (DataTables format) with senator name, link to report.
3. For each PTR, GET the HTML report and parse the <table> rows for
   ticker / direction / amount-range.

The eFD site is light-touch fragile (it's a public records portal), so every
parse step is wrapped in try/except. Best-effort extraction; never crashes
the daily refresh job.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import requests
from loguru import logger

from bot.config import FULL_UNIVERSE, settings
from bot.db import JobRun, SessionLocal


_BASE = "https://efdsearch.senate.gov"
_HOME = f"{_BASE}/search/home/"
_REPORT_DATA = f"{_BASE}/search/report/data/"

# Same dollar buckets as the House. The Senate uses the identical set.
_AMOUNT_RANGES = {
    "$1,001 - $15,000":         8_000,
    "$15,001 - $50,000":        32_500,
    "$50,001 - $100,000":       75_000,
    "$100,001 - $250,000":     175_000,
    "$250,001 - $500,000":     375_000,
    "$500,001 - $1,000,000":   750_000,
    "$1,000,001 - $5,000,000": 3_000_000,
    "$5,000,001 - $25,000,000": 15_000_000,
    "$25,000,001 - $50,000,000": 37_500_000,
    "$50,000,001 +":           75_000_000,
}


@dataclass
class SenateTrade:
    politician: str
    ticker: str
    direction: str   # buy | sell
    amount: float
    traded_on: datetime
    source_url: str


def _amount_midpoint(label: str) -> float:
    return _AMOUNT_RANGES.get((label or "").strip(), 0.0)


def _new_session() -> requests.Session:
    sess = requests.Session()
    sess.headers["User-Agent"] = settings.sec_user_agent
    return sess


def _accept_disclaimer(sess: requests.Session) -> bool:
    """eFD requires accepting an HTML form before any search works."""
    try:
        sess.get(_HOME, timeout=20)
        # The accept form posts the same URL with prohibition_agreement=1
        r = sess.post(
            _HOME,
            data={"prohibition_agreement": "1"},
            headers={"Referer": _HOME},
            timeout=20,
            allow_redirects=True,
        )
        return r.status_code in (200, 302)
    except requests.RequestException as exc:
        logger.warning("senate disclaimer accept failed: {}", exc)
        return False


def _list_recent_ptrs(sess: requests.Session, days: int = 14, limit: int = 50) -> list[dict]:
    """Search recent PTR filings. Returns rows as dicts."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%m/%d/%Y")
    today = datetime.now(timezone.utc).strftime("%m/%d/%Y")
    payload = {
        "report_types[]": "11",        # PTR
        "filer_types[]": ["1", "2"],   # Senator + candidate
        "submitted_start_date": cutoff,
        "submitted_end_date": today,
        "candidate_state": "",
        "senator_state": "",
        "office_id": "",
        "first_name": "",
        "last_name": "",
        "draw": "1",
        "start": "0",
        "length": str(limit),
    }
    try:
        r = sess.post(
            _REPORT_DATA,
            data=payload,
            headers={"Referer": _HOME, "X-Requested-With": "XMLHttpRequest"},
            timeout=30,
        )
        if r.status_code != 200:
            logger.warning("senate /report/data {} for last {}d", r.status_code, days)
            return []
        data = r.json()
    except (requests.RequestException, ValueError) as exc:
        logger.warning("senate report data fetch failed: {}", exc)
        return []
    rows = data.get("data") or []
    out = []
    for row in rows:
        # row is a list: [first, last, office, link_html, type, date]
        if len(row) < 6:
            continue
        link_match = re.search(r'href="([^"]+)"', row[3] or "")
        if not link_match:
            continue
        url = _BASE + link_match.group(1) if link_match.group(1).startswith("/") else link_match.group(1)
        out.append({
            "politician": f"{(row[0] or '').strip()} {(row[1] or '').strip()}".strip(),
            "url": url,
            "filed_at": (row[5] or "").strip(),
        })
    return out


_TICKER_RE = re.compile(r"\b([A-Z]{1,5}(?:\.[A-Z])?)\b")


def _parse_report(sess: requests.Session, politician: str, url: str) -> list[SenateTrade]:
    """Parse a single PTR HTML page. Best-effort extraction of trade rows."""
    try:
        r = sess.get(url, timeout=30)
        if r.status_code != 200:
            return []
    except requests.RequestException:
        return []

    html = r.text
    # PTR pages render trades in an HTML table. Pull every <tr>...</tr> and
    # look for in-scope (universe) tickers + a buy/sell keyword + an amount
    # bucket. Skip the rest. This loose approach survives template changes.
    rows = re.findall(r"<tr\b[^>]*>(.*?)</tr>", html, flags=re.DOTALL | re.IGNORECASE)
    out: list[SenateTrade] = []
    for raw in rows:
        cells = [re.sub(r"<[^>]+>", " ", c).strip() for c in re.findall(
            r"<td\b[^>]*>(.*?)</td>", raw, flags=re.DOTALL | re.IGNORECASE)]
        if not cells:
            continue
        text = " ".join(cells)
        # Find first universe ticker mentioned
        ticker = ""
        for m in _TICKER_RE.findall(text):
            if m in FULL_UNIVERSE:
                ticker = m
                break
        if not ticker:
            continue
        low = text.lower()
        if "purchase" in low or " buy" in low:
            direction = "buy"
        elif "sale" in low or "sold" in low or " sell" in low:
            direction = "sell"
        else:
            continue
        amount = 0.0
        for label in _AMOUNT_RANGES:
            if label in text:
                amount = _amount_midpoint(label)
                break
        out.append(SenateTrade(
            politician=politician,
            ticker=ticker,
            direction=direction,
            amount=amount,
            traded_on=datetime.now(timezone.utc),
            source_url=url,
        ))
    return out


def refresh_senate(days: int = 14, limit: int = 50) -> int:
    """Pull recent Senate PTRs. Returns count of trade rows persisted."""
    from bot.signals.politicians import _persist_signals  # reuse persistor
    sess = _new_session()
    if not _accept_disclaimer(sess):
        return 0
    ptrs = _list_recent_ptrs(sess, days=days, limit=limit)
    logger.info("senate: {} PTRs in last {}d", len(ptrs), days)
    total = 0
    for p in ptrs:
        trades = _parse_report(sess, p["politician"], p["url"])
        if trades:
            total += _persist_signals(trades, kind="politician", chamber="senate")
    return total


def run() -> dict:
    started = datetime.now(timezone.utc)
    with SessionLocal.begin() as s:
        jr = JobRun(job_name="senate_refresh", started_at=started, status="running")
        s.add(jr)
        s.flush()
        jr_id = jr.id
    out = {"count": 0, "error": None}
    try:
        out["count"] = refresh_senate()
    except Exception as exc:
        out["error"] = str(exc)
        logger.exception("senate_refresh failed")
    with SessionLocal.begin() as s:
        jr = s.get(JobRun, jr_id)
        jr.finished_at = datetime.now(timezone.utc)
        jr.status = "ok" if out["error"] is None else "failed"
        jr.message = str(out)
    return out
