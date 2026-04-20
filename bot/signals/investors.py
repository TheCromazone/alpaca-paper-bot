"""SEC EDGAR 13F tracker.

For each tracked CIK in `config.TRACKED_INVESTORS`, fetches the two most recent
13F-HR filings and diffs holdings to emit buy/sell signals. Runs quarterly.

We use EDGAR's JSON "submissions" endpoint to locate filings, then fetch the
`infotable.xml` that every 13F-HR carries.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable
from xml.etree import ElementTree as ET

import requests
from loguru import logger

from bot.config import FULL_UNIVERSE, TRACKED_INVESTORS, settings
from bot.db import JobRun, Signal, SessionLocal


EDGAR_SUBMISSIONS = "https://data.sec.gov/submissions/CIK{cik}.json"
EDGAR_ARCHIVES = "https://www.sec.gov/Archives/edgar/data/{cik_int}/{accession_nodash}/{file}"


@dataclass
class InvestorTrade:
    investor: str
    ticker: str
    direction: str  # buy | sell
    amount: float   # delta in dollars
    traded_on: datetime
    source_url: str


def _headers() -> dict:
    return {"User-Agent": settings.sec_user_agent, "Accept-Encoding": "gzip, deflate"}


def _recent_13f_filings(cik: str) -> list[dict]:
    url = EDGAR_SUBMISSIONS.format(cik=cik)
    r = requests.get(url, headers=_headers(), timeout=30)
    r.raise_for_status()
    data = r.json()
    recent = data.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    accs = recent.get("accessionNumber", [])
    dates = recent.get("filingDate", [])
    out = []
    for form, acc, date in zip(forms, accs, dates):
        if form in ("13F-HR", "13F-HR/A"):
            out.append({"accession": acc, "date": date})
    return out[:4]


def _fetch_infotable(cik: str, accession: str) -> list[dict]:
    cik_int = int(cik)
    accession_nodash = accession.replace("-", "")
    # Find the infotable xml inside the filing index
    idx_url = EDGAR_ARCHIVES.format(
        cik_int=cik_int, accession_nodash=accession_nodash, file=f"{accession}-index.html"
    )
    r = requests.get(idx_url, headers=_headers(), timeout=30)
    if r.status_code != 200:
        return []
    # Prefer infotable files with "infotable" in the name.
    import re
    candidates = re.findall(r'href="([^"]+infotable\.xml)"', r.text, flags=re.IGNORECASE)
    if not candidates:
        # Fallback: any .xml ending in 2.xml
        candidates = re.findall(r'href="([^"]+?\.xml)"', r.text, flags=re.IGNORECASE)
    if not candidates:
        return []
    xml_path = candidates[0]
    if xml_path.startswith("/"):
        xml_url = "https://www.sec.gov" + xml_path
    else:
        xml_url = EDGAR_ARCHIVES.format(
            cik_int=cik_int, accession_nodash=accession_nodash, file=xml_path.split("/")[-1]
        )
    xr = requests.get(xml_url, headers=_headers(), timeout=30)
    if xr.status_code != 200:
        return []
    holdings: list[dict] = []
    try:
        root = ET.fromstring(xr.content)
    except ET.ParseError as exc:
        logger.warning("13F XML parse failed for {}: {}", accession, exc)
        return []
    ns = {"n": root.tag.split("}")[0].lstrip("{")} if "}" in root.tag else {}
    tag = "infoTable" if not ns else f"n:infoTable"
    for node in root.findall(".//" + ("{" + ns["n"] + "}" if ns else "") + "infoTable"):
        def txt(t: str) -> str:
            el = node.find(("{" + ns["n"] + "}" if ns else "") + t)
            return (el.text or "").strip() if el is not None and el.text else ""
        name = txt("nameOfIssuer")
        cusip = txt("cusip")
        value_raw = txt("value") or "0"
        try:
            value = float(value_raw) * 1000  # 13F values are in thousands
        except ValueError:
            value = 0.0
        holdings.append({"name": name, "cusip": cusip, "value": value})
    return holdings


def _name_to_ticker(name: str) -> str:
    """Very rough name → ticker lookup using config.TICKER_NAMES."""
    from bot.config import TICKER_NAMES
    n = name.lower()
    for ticker, aliases in TICKER_NAMES.items():
        for a in aliases:
            if len(a) > 2 and a.lower() in n:
                return ticker
    return ""


def diff_filings(older: list[dict], newer: list[dict], investor: str, source_url: str) -> list[InvestorTrade]:
    def agg(rows):
        out: dict[str, float] = {}
        for r in rows:
            ticker = _name_to_ticker(r["name"])
            if ticker not in FULL_UNIVERSE:
                continue
            out[ticker] = out.get(ticker, 0.0) + r["value"]
        return out

    old = agg(older)
    new = agg(newer)
    trades: list[InvestorTrade] = []
    for ticker in set(old) | set(new):
        delta = new.get(ticker, 0) - old.get(ticker, 0)
        if abs(delta) < 1_000_000:  # ignore sub-$1M noise
            continue
        trades.append(InvestorTrade(
            investor=investor,
            ticker=ticker,
            direction="buy" if delta > 0 else "sell",
            amount=abs(delta),
            traded_on=datetime.now(timezone.utc),
            source_url=source_url,
        ))
    return trades


def refresh_all() -> int:
    total = 0
    for name, cik in TRACKED_INVESTORS.items():
        try:
            filings = _recent_13f_filings(cik)
            if len(filings) < 2:
                continue
            newer = _fetch_infotable(cik, filings[0]["accession"])
            older = _fetch_infotable(cik, filings[1]["accession"])
            url = f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=13F-HR"
            trades = diff_filings(older, newer, name, url)
            total += _persist(trades)
            logger.info("{}: {} new 13F signals", name, len(trades))
        except Exception as exc:
            logger.warning("13F refresh failed for {}: {}", name, exc)
    return total


def _persist(trades: Iterable[InvestorTrade]) -> int:
    count = 0
    with SessionLocal.begin() as s:
        for t in trades:
            s.add(Signal(
                ticker=t.ticker,
                kind="investor",
                source=t.investor,
                direction=t.direction,
                amount=t.amount,
                as_of=t.traded_on,
                meta={"source_url": t.source_url},
            ))
            count += 1
    return count


def run() -> dict:
    started = datetime.now(timezone.utc)
    with SessionLocal.begin() as s:
        jr = JobRun(job_name="investors_refresh", started_at=started, status="running")
        s.add(jr)
        s.flush()
        jr_id = jr.id
    out = {"count": 0, "error": None}
    try:
        out["count"] = refresh_all()
    except Exception as exc:
        out["error"] = str(exc)
        logger.exception("investors_refresh failed")
    with SessionLocal.begin() as s:
        jr = s.get(JobRun, jr_id)
        jr.finished_at = datetime.now(timezone.utc)
        jr.status = "ok" if out["error"] is None else "failed"
        jr.message = str(out)
    return out
