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
import re
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable
from xml.etree import ElementTree as ET

import requests
from loguru import logger
from sqlalchemy import select

from bot.config import FULL_UNIVERSE, settings
from bot.db import JobRun, Signal, SessionLocal


HOUSE_INDEX_URL = "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.ZIP"


@dataclass
class PoliticianTrade:
    politician: str
    ticker: str
    direction: str  # buy | sell
    amount: float   # midpoint of disclosed range (floor for open-ended "Over $X")
    traded_on: datetime | None   # transaction date from the report (None if unparsed)
    source_url: str
    # Filing date — when the trade became public. Signal.as_of uses this.
    disclosed_on: datetime | None = None


# Standard STOCK Act buckets keyed by lower bound, for amounts whose upper
# bound got lost in PDF extraction ("$15,001 -" with the rest on another line).
_BUCKET_BY_LOW = {
    1_001: 15_000,
    15_001: 50_000,
    50_001: 100_000,
    100_001: 250_000,
    250_001: 500_000,
    500_001: 1_000_000,
    1_000_001: 5_000_000,
    5_000_001: 25_000_000,
    25_000_001: 50_000_000,
}
_MONEY = r"\$\s*(\d{1,3}(?:,\d{3})+|\d+)"
# "$1,001 - $15,000", tolerating text the PDF wedged between the two halves:
# "$250,001 -\n(INTC) [OP] $500,000".
_RANGE_RE = re.compile(_MONEY + r"\s*-\s*[^$]{0,80}?" + _MONEY)
_OVER_RE = re.compile(r"(?:over|more than|greater than)\s*" + _MONEY + "|" + _MONEY + r"\s*\+", re.I)
_LOW_RE = re.compile(_MONEY + r"\s*-")


def _money(raw: str) -> int:
    return int(raw.replace(",", ""))


def _midpoint(low: int, high: int) -> float:
    # Buckets start at N,001: use the round number so $1,001-$15,000 → 8,000.
    base = low - 1 if low % 1000 == 1 else low
    return (base + high) / 2


def parse_amount(text: str) -> float:
    """Dollar estimate for a disclosed amount range, from a cell or a whole
    row's text. Two figures → midpoint; open-ended ("Over $50,000,000",
    "$50,000,001 +") → the floor; a lone lower bound → its standard bucket's
    midpoint. 0.0 when nothing parses."""
    t = re.sub(r"\s+", " ", (text or "").replace("\x00", ""))
    m = _RANGE_RE.search(t)
    if m and _money(m.group(2)) > _money(m.group(1)):
        return _midpoint(_money(m.group(1)), _money(m.group(2)))
    m = _OVER_RE.search(t)
    if m:
        return float(_money(m.group(1) or m.group(2)))
    m = _LOW_RE.search(t)
    if m and _money(m.group(1)) in _BUCKET_BY_LOW:
        low = _money(m.group(1))
        return _midpoint(low, _BUCKET_BY_LOW[low])
    return 0.0


def _amount_midpoint(label: str) -> float:
    return parse_amount(label)


def _parse_mdy(raw: str) -> datetime | None:
    try:
        return datetime.strptime(raw.strip(), "%m/%d/%Y").replace(tzinfo=timezone.utc)
    except (ValueError, AttributeError):
        return None


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


def _filing_date_key(raw: str) -> datetime:
    """Sort key for the index's FilingDate ("M/D/YYYY"). Sorting the raw
    string ranked "9/30/2026" above "10/1/2026" and "7/9" above "7/15", so the
    "most recent 50 filings" were really the lexicographically largest — from
    October on, the newest House disclosures were skipped entirely."""
    raw = (raw or "").strip()
    for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    return datetime.min


def _pdf_url(year: str, doc_id: str) -> str:
    return f"https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{year}/{doc_id}.pdf"


# Transaction type then transaction date then notification date:
# "P 07/24/2026 07/24/2026", "S (partial) 09/08/2026 09/15/2026".
_TX_RE = re.compile(
    r"(?:^|\s)(S\s*\(partial\)|P|S|E)\s+(\d{1,2}/\d{1,2}/\d{4})\s+(\d{1,2}/\d{1,2}/\d{4})",
    re.IGNORECASE,
)
# Per-transaction footnote lines ("F S: New", "S O: <account>", "D: Purchased
# ... strike price of $100") — cut before parsing so their $ figures and
# words ("Purchased") can't leak into the amount or direction.
_FOOTNOTE_RE = re.compile(r"\n\s*(?:F\s*S|S\s*O|D|C|Filing Status|Subholding Of|Description|Comments?)\s*:", re.I)
_DATE_RE = re.compile(r"\b(\d{1,2}/\d{1,2}/\d{4})\b")
_TICKER_ALIASES = {"GOOG": "GOOGL"}
# Asset-type code for options ("(INTC) [OP]"). Skipped like the Senate parser
# does: a bought put would otherwise read as a bullish stock "buy", and the
# put/call detail sits in the footnote that gets cut.
_OPTION_RE = re.compile(r"\[\s*OP\s*\]", re.I)


def parse_house_row(cells: list) -> dict | None:
    """One pdfplumber table row → {ticker, direction, amount, traded_on}.

    House PTR tables come out two ways: proper cells
    (['', 'SP', 'Intel Corp (INTC) [ST]', 'P', '07/24/2026', '07/24/2026',
    '$500,001 -\n$1,000,000', '']) or the whole row merged into the first
    cell with the amount split around the asset name ('SP Intel Corporation -
    Common Stock P 07/24/2026 07/24/2026 $250,001 -\n(INTC) [OP] $500,000\nF
    S: New\nD: ...'). Both are parsed from the joined row text.
    """
    raw = "\n".join((c or "") for c in cells).replace("\x00", "")
    cut = _FOOTNOTE_RE.search(raw)
    text = re.sub(r"\s+", " ", raw[:cut.start()] if cut else raw).strip()
    if not text:
        return None
    ticker = _extract_ticker_from_row([text])
    if not ticker or _OPTION_RE.search(text):
        return None
    tx = _TX_RE.search(text)
    if tx:
        kind = tx.group(1).upper()
        direction = "buy" if kind == "P" else "sell" if kind.startswith("S") else ""
        traded_on = _parse_mdy(tx.group(2))
        amount = parse_amount(text[tx.end():]) or parse_amount(text)
    else:
        stripped = [re.sub(r"\s+", " ", (c or "").replace("\x00", "")).strip() for c in cells]
        upper = {c.upper() for c in stripped}
        low = text.lower()
        if "P" in upper or "purchase" in low:
            direction = "buy"
        elif upper & {"S", "SF", "S (PARTIAL)"} or "sale" in low or "sold" in low:
            direction = "sell"
        else:
            direction = ""
        d = _DATE_RE.search(text)
        traded_on = _parse_mdy(d.group(1)) if d else None
        amount = parse_amount(text)
    if not direction:   # exchanges, unrecognised rows
        return None
    return {"ticker": ticker, "direction": direction, "amount": amount, "traded_on": traded_on}


def _extract_trades_from_pdf(
    pdf_bytes: bytes, politician: str, source_url: str, disclosed_on: datetime | None = None,
) -> list[PoliticianTrade]:
    """Best-effort PDF parse for a House PTR (Periodic Transaction Report)."""
    import pdfplumber

    trades: list[PoliticianTrade] = []
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                for table in (page.extract_tables() or []):
                    for row in table:
                        parsed = parse_house_row(row)
                        if parsed is None:
                            continue
                        trades.append(PoliticianTrade(
                            politician=politician,
                            source_url=source_url,
                            disclosed_on=disclosed_on,
                            **parsed,
                        ))
    except Exception as exc:
        # All or nothing: a partial list would be reconciled against the
        # stored filing and delete its unparsed rows. Leave it for tomorrow.
        logger.warning("PDF parse failed for {} ({}): {} — filing left untouched", politician, source_url, exc)
        return []
    return trades


def _extract_ticker_from_row(cells: list[str]) -> str:
    text = " ".join(c or "" for c in cells)
    for m in re.finditer(r"\(([A-Z]{1,5}(?:\.[A-Z])?)\)", text):
        ticker = _TICKER_ALIASES.get(m.group(1), m.group(1))
        if ticker in FULL_UNIVERSE:
            return ticker
    return ""


def refresh_house(limit_filings: int = 50) -> int:
    """Fetches the most recent N House PTR filings and extracts trades. Returns trades persisted."""
    year = datetime.now(timezone.utc).year
    filings = _fetch_house_year_index(year)
    # Only PTRs (P or stock transaction types)
    ptrs = [f for f in filings if f["type"].upper().startswith("P")]
    ptrs.sort(key=lambda f: _filing_date_key(f["filing"]), reverse=True)
    ptrs = ptrs[:limit_filings]

    new_signals = 0
    for filing in ptrs:
        politician = f"{filing['first']} {filing['last']}".strip() or filing["doc_id"]
        doc_id, filing_year = filing["doc_id"], filing["year"]
        if not doc_id:
            continue
        url = _pdf_url(filing_year, doc_id)
        filed = _filing_date_key(filing["filing"])
        disclosed_on = filed.replace(tzinfo=timezone.utc) if filed != datetime.min else None
        try:
            r = requests.get(url, headers={"User-Agent": settings.sec_user_agent}, timeout=30)
            if r.status_code != 200:
                continue
            trades = _extract_trades_from_pdf(r.content, politician, url, disclosed_on)
        except Exception as exc:
            logger.warning("House PTR fetch failed for {}: {}", doc_id, exc)
            continue
        new_signals += _persist_signals(trades, kind="politician")
    return new_signals


def _signal_key(t) -> tuple:
    return (getattr(t, "politician", None), t.ticker, t.direction, getattr(t, "source_url", ""))


def _persist_signals(trades: Iterable, kind: str, *, chamber: str = "house") -> int:
    """Store one or more re-read filings' trades. Returns rows inserted.

    Each filing in the batch is reconciled to exactly what it parses to now,
    keyed by (politician, ticker, direction, filing URL):
    * the first N stored rows for a key are updated in place (amount, as_of =
      filing date, meta), where N is how many such trades the filing lists —
      a filing can legitimately list the same trade shape twice;
    * extra stored rows for the key are deleted. Before the dedupe fix every
      daily refresh re-inserted the same disclosure with as_of = that day,
      so copies stayed "fresh" for weeks;
    * stored rows from the same filing that it no longer yields (e.g. option
      rows, now skipped) are deleted;
    * trades with no stored row yet are inserted.
    Re-reading an unchanged filing therefore inserts nothing.
    """
    trades = list(trades)
    wanted: dict[tuple, list] = defaultdict(list)
    for t in trades:
        wanted[_signal_key(t)].append(t)
    filings = {(k[0], k[3]) for k in wanted}
    sources = {k[0] for k in wanted} - {None}
    count = 0
    with SessionLocal.begin() as s:
        stored: dict[tuple, list] = defaultdict(list)
        if sources:
            for row in s.scalars(
                select(Signal).where(Signal.kind == kind).where(Signal.source.in_(sources))
                .order_by(Signal.id)
            ).all():
                key = (row.source, row.ticker, row.direction, (row.meta or {}).get("source_url", ""))
                if (key[0], key[3]) in filings:
                    stored[key].append(row)
        for key, batch in wanted.items():
            # Prefer rows already written by this parser, then the oldest.
            rows = sorted(stored.pop(key, []), key=lambda r: ("traded_on" not in (r.meta or {}), r.id))
            for row, t in zip(rows, batch):
                row.amount, row.as_of, row.meta = _signal_fields(t, chamber)
            for row in rows[len(batch):]:
                s.delete(row)
            for t in batch[len(rows):]:
                amount, as_of, meta = _signal_fields(t, chamber)
                s.add(Signal(
                    ticker=t.ticker,
                    kind=kind,
                    source=key[0] if kind == "politician" else getattr(t, "investor", ""),
                    direction=t.direction,
                    amount=amount,
                    as_of=as_of,
                    meta=meta,
                ))
                count += 1
        for rows in stored.values():
            for row in rows:
                s.delete(row)
    return count


def _signal_fields(t, chamber: str) -> tuple[float, datetime, dict]:
    traded_on = getattr(t, "traded_on", None)
    disclosed_on = getattr(t, "disclosed_on", None)
    # as_of = when the trade became public (filing date), not when we
    # ingested it; the transaction date rides along in meta.
    as_of = disclosed_on or traded_on or datetime.now(timezone.utc)
    meta = {
        "source_url": getattr(t, "source_url", ""),
        # Aggregator reads `politician` + `chamber` to apply
        # POLITICIAN_WEIGHTS. Stored on every row so a Pelosi
        # PTR is weighted higher than a backbencher's.
        "politician": getattr(t, "politician", None),
        "chamber": chamber,
        "traded_on": traded_on.date().isoformat() if traded_on else None,
        "disclosed_on": disclosed_on.date().isoformat() if disclosed_on else None,
    }
    return float(getattr(t, "amount", 0) or 0), as_of, meta


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
