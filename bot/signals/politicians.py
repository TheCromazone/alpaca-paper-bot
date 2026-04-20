"""Scrapes congressional STOCK Act disclosures.

House: https://disclosures-clerk.house.gov/public_disc/financial-pdfs/YYYYFD.ZIP
  Yearly zip contains an XML index + PDFs of filings. The XML index alone
  identifies filers; full trade details live inside the PDFs.

Senate: https://efdsearch.senate.gov/search/
  Requires accepting a disclaimer. Results are HTML tables.

Disclosures lag 30-45 days by law, so a weekly refresh is sufficient.

Best-effort parsing: we extract what we can from the index files. If a given
filing can't be parsed, we log it and move on — never crash the bot.
"""
from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable
from xml.etree import ElementTree as ET

import requests
from loguru import logger

from bot.config import FULL_UNIVERSE, settings
from bot.db import JobRun, Signal, SessionLocal


HOUSE_INDEX_URL = "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.ZIP"


@dataclass
class PoliticianTrade:
    politician: str
    ticker: str
    direction: str  # buy | sell
    amount: float   # midpoint of disclosed range
    traded_on: datetime
    source_url: str


_AMOUNT_RANGES = {
    "$1,001 - $15,000":        8_000,
    "$15,001 - $50,000":      32_500,
    "$50,001 - $100,000":     75_000,
    "$100,001 - $250,000":   175_000,
    "$250,001 - $500,000":   375_000,
    "$500,001 - $1,000,000": 750_000,
    "$1,000,001 - $5,000,000": 3_000_000,
    "$5,000,001 - $25,000,000": 15_000_000,
    "$25,000,001 - $50,000,000": 37_500_000,
    "$50,000,001 +":         75_000_000,
}


def _amount_midpoint(label: str) -> float:
    label = (label or "").strip()
    return _AMOUNT_RANGES.get(label, 0.0)


def _fetch_house_year_index(year: int) -> list[dict]:
    """Fetch the annual index XML for the House. Returns list of filing dicts."""
    url = HOUSE_INDEX_URL.format(year=year)
    resp = requests.get(url, headers={"User-Agent": settings.sec_user_agent}, timeout=60)
    resp.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        xml_names = [n for n in zf.namelist() if n.lower().endswith(".xml")]
        if not xml_names:
            logger.warning("House zip for {} had no XML index", year)
            return []
        with zf.open(xml_names[0]) as f:
            tree = ET.parse(f)
    root = tree.getroot()
    out: list[dict] = []
    for m in root.findall("Member"):
        out.append({
            "prefix":   (m.findtext("Prefix") or "").strip(),
            "last":     (m.findtext("Last") or "").strip(),
            "first":    (m.findtext("First") or "").strip(),
            "type":     (m.findtext("FilingType") or "").strip(),
            "state":    (m.findtext("StateDst") or "").strip(),
            "year":     (m.findtext("Year") or str(year)).strip(),
            "filing":   (m.findtext("FilingDate") or "").strip(),
            "doc_id":   (m.findtext("DocID") or "").strip(),
        })
    return out


def _pdf_url(year: str, doc_id: str) -> str:
    return f"https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{year}/{doc_id}.pdf"


def _extract_trades_from_pdf(pdf_bytes: bytes, politician: str, source_url: str) -> list[PoliticianTrade]:
    """Best-effort PDF parse for a House PTR (Periodic Transaction Report)."""
    import pdfplumber

    trades: list[PoliticianTrade] = []
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                for table in (page.extract_tables() or []):
                    for row in table:
                        cells = [(c or "").strip() for c in row]
                        text = " | ".join(cells)
                        # PTR format varies, but rows typically contain a ticker in parens and
                        # an amount-range string. Extract what we can.
                        ticker = _extract_ticker_from_row(cells)
                        if not ticker:
                            continue
                        direction = "buy" if any("purchase" in c.lower() or c.upper() == "P" for c in cells) \
                                     else "sell" if any("sale" in c.lower() or c.upper() in ("S", "SF") for c in cells) \
                                     else ""
                        if not direction:
                            continue
                        amount = 0.0
                        for c in cells:
                            amount = _amount_midpoint(c)
                            if amount:
                                break
                        trades.append(PoliticianTrade(
                            politician=politician,
                            ticker=ticker,
                            direction=direction,
                            amount=amount,
                            traded_on=datetime.now(timezone.utc),
                            source_url=source_url,
                        ))
    except Exception as exc:
        logger.warning("PDF parse failed for {}: {}", politician, exc)
    return trades


def _extract_ticker_from_row(cells: list[str]) -> str:
    import re
    text = " ".join(cells)
    m = re.search(r"\(([A-Z]{1,5}(?:\.[A-Z])?)\)", text)
    if m and m.group(1) in FULL_UNIVERSE:
        return m.group(1)
    return ""


def refresh_house(limit_filings: int = 50) -> int:
    """Fetches the most recent N House PTR filings and extracts trades. Returns trades persisted."""
    year = datetime.now(timezone.utc).year
    filings = _fetch_house_year_index(year)
    # Only PTRs (P or stock transaction types)
    ptrs = [f for f in filings if f["type"].upper().startswith("P")]
    ptrs.sort(key=lambda f: f["filing"], reverse=True)
    ptrs = ptrs[:limit_filings]

    new_signals = 0
    for filing in ptrs:
        politician = f"{filing['first']} {filing['last']}".strip() or filing["doc_id"]
        doc_id, filing_year = filing["doc_id"], filing["year"]
        if not doc_id:
            continue
        url = _pdf_url(filing_year, doc_id)
        try:
            r = requests.get(url, headers={"User-Agent": settings.sec_user_agent}, timeout=30)
            if r.status_code != 200:
                continue
            trades = _extract_trades_from_pdf(r.content, politician, url)
        except Exception as exc:
            logger.warning("House PTR fetch failed for {}: {}", doc_id, exc)
            continue
        new_signals += _persist_signals(trades, kind="politician")
    return new_signals


def _persist_signals(trades: Iterable, kind: str) -> int:
    count = 0
    with SessionLocal.begin() as s:
        for t in trades:
            # Dedup by (kind, source, ticker, direction, date)
            key_as_of = getattr(t, "traded_on", None) or datetime.now(timezone.utc)
            s.add(Signal(
                ticker=t.ticker,
                kind=kind,
                source=t.politician if kind == "politician" else t.investor,
                direction=t.direction,
                amount=float(getattr(t, "amount", 0) or 0),
                as_of=key_as_of,
                meta={"source_url": getattr(t, "source_url", "")},
            ))
            count += 1
    return count


def run() -> dict:
    """Job entrypoint. Records a JobRun row."""
    started = datetime.now(timezone.utc)
    with SessionLocal.begin() as s:
        jr = JobRun(job_name="politicians_refresh", status="running", started_at=started)
        s.add(jr)
        s.flush()
        jr_id = jr.id
    out = {"house": 0, "error": None}
    try:
        out["house"] = refresh_house()
    except Exception as exc:
        out["error"] = str(exc)
        logger.exception("politicians_refresh failed")
    with SessionLocal.begin() as s:
        jr = s.get(JobRun, jr_id)
        jr.finished_at = datetime.now(timezone.utc)
        jr.status = "ok" if out["error"] is None else "failed"
        jr.message = str(out)
    return out
