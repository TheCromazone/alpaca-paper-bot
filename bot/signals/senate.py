"""Scrapes Senate Periodic Transaction Reports from the Senate eFD search.

Flow (efdsearch.senate.gov is a Django app with CSRF protection):
1. GET /search/home/ → ``csrftoken`` cookie + the agreement form's
   ``csrfmiddlewaretoken``.
2. POST /search/home/ with ``prohibition_agreement=1`` and that token
   (Referer: /search/home/) → 302 to /search/ with a ``sessionid`` cookie.
   Without the token Django answers 403 and every later request fails —
   that was the production failure mode.
3. POST /search/report/data/ (DataTables backend) with the cookie's token as
   both ``csrfmiddlewaretoken`` and ``X-CSRFToken`` (Referer: /search/).
   Rows are ``[first, last, "Last, First (Senator)", "<a href=...>", "MM/DD/YYYY"]``.
4. GET each electronic PTR (/search/view/ptr/<uuid>/) and read its
   transactions table by header name. Paper filings (/search/view/paper/)
   are scanned images and are skipped.

Every network step has a timeout and failures log + return 0; the job never
crashes on a site change.
"""
from __future__ import annotations

import html
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import requests
from loguru import logger

from bot.config import FULL_UNIVERSE, settings
from bot.db import JobRun, SessionLocal
from bot.signals.politicians import parse_amount


_BASE = "https://efdsearch.senate.gov"
_HOME = f"{_BASE}/search/home/"
_SEARCH = f"{_BASE}/search/"
_REPORT_DATA = f"{_BASE}/search/report/data/"

HTTP_TIMEOUT_S = 30
_REQUEST_GAP_S = 0.5            # polite pacing between report fetches
_PTR_REPORT_TYPE = "[11]"       # Periodic Transaction Report
_SENATOR_FILER_TYPE = "[1]"     # sitting senators (not candidates/former)
_TICKER_ALIASES = {"GOOG": "GOOGL", "BRK-B": "BRK.B", "BRK/B": "BRK.B", "BRK B": "BRK.B"}


@dataclass
class SenateTrade:
    politician: str
    ticker: str
    direction: str   # buy | sell
    amount: float
    traded_on: datetime | None     # transaction date from the report
    source_url: str
    disclosed_on: datetime | None = None   # date eFD received the report


def _amount_midpoint(label: str) -> float:
    return parse_amount(label)


def _parse_mdy(raw: str) -> datetime | None:
    m = re.search(r"(\d{1,2}/\d{1,2}/\d{4})", raw or "")
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%m/%d/%Y").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _text(cell_html: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", cell_html or ""))).strip()


def _new_session() -> requests.Session:
    sess = requests.Session()
    sess.headers["User-Agent"] = settings.sec_user_agent
    return sess


def _accept_disclaimer(sess: requests.Session) -> bool:
    """Accept the eFD prohibition agreement; True when the session is usable."""
    try:
        r = sess.get(_HOME, timeout=HTTP_TIMEOUT_S)
        if r.status_code != 200:
            logger.warning("senate eFD home returned HTTP {}", r.status_code)
            return False
        tag = re.search(r"<input[^>]*name=\"csrfmiddlewaretoken\"[^>]*>", r.text)
        token = re.search(r"value=\"([^\"]+)\"", tag.group(0)) if tag else None
        if not token:
            logger.warning("senate eFD home: no csrfmiddlewaretoken in agreement form")
            return False
        r = sess.post(
            _HOME,
            data={"prohibition_agreement": "1", "csrfmiddlewaretoken": token.group(1)},
            headers={"Referer": _HOME},
            timeout=HTTP_TIMEOUT_S,
        )
    except requests.RequestException as exc:
        logger.warning("senate disclaimer accept failed: {}", exc)
        return False
    if r.status_code != 200 or not sess.cookies.get("csrftoken"):
        logger.warning("senate disclaimer rejected: HTTP {}", r.status_code)
        return False
    return True


def _list_recent_ptrs(sess: requests.Session, days: int = 14, limit: int = 100) -> list[dict]:
    """Electronic PTRs received in the last ``days`` days, newest first."""
    start_date = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%m/%d/%Y 00:00:00")
    token = sess.cookies.get("csrftoken", "")
    out: list[dict] = []
    offset, page = 0, min(100, max(1, limit))
    while len(out) < limit:
        payload = {
            "start": str(offset),
            "length": str(page),
            "report_types": _PTR_REPORT_TYPE,
            "filer_types": _SENATOR_FILER_TYPE,
            "submitted_start_date": start_date,
            "submitted_end_date": "",
            "candidate_state": "",
            "senator_state": "",
            "office_id": "",
            "first_name": "",
            "last_name": "",
            "csrfmiddlewaretoken": token,
        }
        try:
            r = sess.post(
                _REPORT_DATA,
                data=payload,
                headers={"Referer": _SEARCH, "X-CSRFToken": token,
                         "X-Requested-With": "XMLHttpRequest"},
                timeout=HTTP_TIMEOUT_S,
            )
            if r.status_code != 200:
                logger.warning("senate /report/data HTTP {} for last {}d", r.status_code, days)
                break
            data = r.json()
        except (requests.RequestException, ValueError) as exc:
            logger.warning("senate report data fetch failed: {}", exc)
            break
        rows = data.get("data") or []
        for row in rows:
            if not isinstance(row, list) or len(row) < 4:
                continue
            link = next((re.search(r'href="([^"]+)"', c) for c in row
                         if isinstance(c, str) and "href=" in c), None)
            if not link:
                continue
            path = link.group(1)
            if "/view/ptr/" not in path:     # paper filings are scanned images
                continue
            out.append({
                "politician": f"{(row[0] or '').strip()} {(row[1] or '').strip()}".strip(),
                "url": _BASE + path if path.startswith("/") else path,
                "disclosed_on": _parse_mdy(str(row[-1] or "")),
            })
        offset += len(rows)
        if not rows or offset >= int(data.get("recordsFiltered") or 0):
            break
    return out[:limit]


def parse_ptr_html(page_html: str, politician: str, url: str,
                   disclosed_on: datetime | None = None) -> list[SenateTrade]:
    """Read the PTR transactions table by column header."""
    table = re.search(r"<table\b.*?</table>", page_html or "", flags=re.DOTALL | re.IGNORECASE)
    if not table:
        return []
    headers = [_text(h).lower() for h in re.findall(
        r"<th\b[^>]*>(.*?)</th>", table.group(0), flags=re.DOTALL | re.IGNORECASE)]

    def col(*names: str) -> int | None:
        for i, h in enumerate(headers):
            if h in names:
                return i
        return None

    i_date, i_ticker = col("transaction date"), col("ticker")
    i_atype, i_type, i_amount = col("asset type"), col("type"), col("amount")
    if None in (i_ticker, i_type, i_amount):
        logger.warning("senate PTR {}: unrecognised table header {}", url, headers)
        return []
    out: list[SenateTrade] = []
    for raw in re.findall(r"<tr\b[^>]*>(.*?)</tr>", table.group(0), flags=re.DOTALL | re.IGNORECASE):
        cells = [_text(c) for c in re.findall(r"<td\b[^>]*>(.*?)</td>", raw, flags=re.DOTALL | re.IGNORECASE)]
        if len(cells) <= max(i_ticker, i_type, i_amount):
            continue
        ticker = cells[i_ticker].upper().strip()
        ticker = _TICKER_ALIASES.get(ticker, ticker)
        if ticker not in FULL_UNIVERSE:
            continue
        asset_type = cells[i_atype].lower() if i_atype is not None and i_atype < len(cells) else ""
        if "option" in asset_type or "bond" in asset_type:
            continue   # a bought put isn't bullish; bonds aren't the equity
        kind = cells[i_type].lower()
        if kind.startswith("purchase"):
            direction = "buy"
        elif kind.startswith("sale"):
            direction = "sell"
        else:
            continue   # exchange / unknown
        out.append(SenateTrade(
            politician=politician,
            ticker=ticker,
            direction=direction,
            amount=parse_amount(cells[i_amount]),
            traded_on=_parse_mdy(cells[i_date]) if i_date is not None and i_date < len(cells) else None,
            source_url=url,
            disclosed_on=disclosed_on,
        ))
    return out


def _parse_report(sess: requests.Session, politician: str, url: str,
                  disclosed_on: datetime | None = None) -> list[SenateTrade]:
    try:
        r = sess.get(url, timeout=HTTP_TIMEOUT_S)
    except requests.RequestException as exc:
        logger.warning("senate PTR fetch {} failed: {}", url, exc)
        return []
    if r.status_code != 200 or "/search/home" in (r.url or ""):   # bounced = session lost
        logger.warning("senate PTR fetch {} -> HTTP {} ({})", url, r.status_code, r.url)
        return []
    return parse_ptr_html(r.text, politician, url, disclosed_on)


def refresh_senate(days: int = 14, limit: int = 100) -> int:
    """Pull recent Senate PTRs. Returns count of new trade rows persisted."""
    from bot.signals.politicians import _persist_signals  # reuse persistor + dedupe
    sess = _new_session()
    if not _accept_disclaimer(sess):
        return 0
    ptrs = _list_recent_ptrs(sess, days=days, limit=limit)
    logger.info("senate: {} electronic PTRs in last {}d", len(ptrs), days)
    total = 0
    for p in ptrs:
        time.sleep(_REQUEST_GAP_S)
        trades = _parse_report(sess, p["politician"], p["url"], p.get("disclosed_on"))
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
