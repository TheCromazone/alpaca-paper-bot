"""Offline tests for the scraped signal feeds: 13F (SEC EDGAR), Senate eFD,
House PTR PDFs and yfinance EPS history. Every network call is replaced by
canned responses shaped like the live sources (captured 2026-10-07)."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
import requests
from sqlalchemy import func, select

from bot.config import FULL_UNIVERSE
from bot.db import EarningsCalendar, EarningsHistory, SessionLocal, Signal
from bot.signals import earnings, investors, politicians, senate
from tests.conftest import utcnow


def _resp(status=200, *, text=None, content=None, payload=None, url=""):
    if payload is not None:
        text = json.dumps(payload)
    if content is None:
        content = (text or "").encode()
    if text is None:
        text = content.decode(errors="replace")

    def _json():
        if payload is None:
            raise ValueError("not json")
        return payload
    return SimpleNamespace(status_code=status, text=text, content=content, url=url, json=_json)


# ---------------------------------------------------------------------------
# 13F
# ---------------------------------------------------------------------------

NS = "http://www.sec.gov/edgar/document/thirteenf/informationtable"


def _infotable(rows: list[tuple]) -> bytes:
    """rows: (name, cusip, value_usd, shares[, put_call[, sh_type]])"""
    body = []
    for name, cusip, value, shares, *rest in rows:
        put_call = rest[0] if rest else ""
        sh_type = rest[1] if len(rest) > 1 else "SH"
        body.append(f"""<infoTable><nameOfIssuer>{name}</nameOfIssuer><titleOfClass>COM</titleOfClass>
          <cusip>{cusip}</cusip><value>{value}</value>
          <shrsOrPrnAmt><sshPrnamt>{shares}</sshPrnamt><sshPrnamtType>{sh_type}</sshPrnamtType></shrsOrPrnAmt>
          {f"<putCall>{put_call}</putCall>" if put_call else ""}
          <investmentDiscretion>SOLE</investmentDiscretion></infoTable>""")
    return (f'<?xml version="1.0"?><informationTable xmlns="{NS}">' + "".join(body)
            + "</informationTable>").encode()


@pytest.fixture
def no_sec_throttle(monkeypatch):
    monkeypatch.setattr(investors, "_SEC_MIN_INTERVAL_S", 0)


@pytest.fixture
def splits(monkeypatch):
    """Stub yfinance split lookups: every symbol has a known factor (1.0 =
    no split) unless the test overrides it in the returned dict."""
    overrides: dict = {}
    calls: list = []

    def fake_fetch(symbols, start_period, end_period):
        calls.append((start_period, end_period))
        default = overrides.get("*", 1.0)
        return {sym: overrides.get(sym, default) for sym in symbols}
    monkeypatch.setattr(investors, "_fetch_split_factors", fake_fetch)
    monkeypatch.setattr(investors, "_SPLIT_CACHE", {})
    overrides["_calls"] = calls
    return overrides


def test_every_universe_ticker_has_a_cusip():
    assert set(FULL_UNIVERSE) <= set(investors.CUSIP_TO_TICKER.values())
    assert all(len(c) == 9 for c in investors.CUSIP_TO_TICKER)


def test_infotable_url_is_the_raw_xml_not_the_rendered_view(monkeypatch, no_sec_throttle):
    # The old parser regex-scraped -index.html and took the first .xml href —
    # "xslForm13F_X02/primary_doc.xml", the SEC's HTML rendering — so it
    # parsed zero holdings. Infotable names are free-form ("56757.xml").
    seen = []

    def fake_get(url, headers=None, timeout=None):
        seen.append((url, headers, timeout))
        return _resp(payload={"directory": {"item": [
            {"name": "0001193125-26-352200-index.html"},
            {"name": "0001193125-26-352200.txt"},
            {"name": "56757.xml"},
            {"name": "primary_doc.xml"},
        ]}})
    monkeypatch.setattr(investors.requests, "get", fake_get)
    url = investors._infotable_url("0001067983", "0001193125-26-352200")
    assert url == "https://www.sec.gov/Archives/edgar/data/1067983/000119312526352200/56757.xml"
    (req_url, headers, timeout), = seen
    assert req_url.endswith("/000119312526352200/index.json")
    assert headers["User-Agent"] == investors.settings.sec_user_agent
    assert timeout


def test_parse_infotable_sums_rows_skips_options_and_principal():
    xml = _infotable([
        ("APPLE INC", "037833100", 1_000_000, 4_000),
        ("APPLE INC", "037833100", 500_000, 2_000),            # other-manager split
        ("APPLE INC", "037833100", 9_999_999, 50_000, "Call"),  # option: skip
        ("APPLE INC", "037833100", 7_777_777, 7_000, "", "PRN"),  # principal: skip
    ])
    h = investors.parse_infotable(xml, filed="2026-08-14")
    assert h == {"037833100": {"name": "APPLE INC", "shares": 6_000.0, "value": 1_500_000.0}}
    # Dollar-valued rows stay dollars whatever the filing date says.
    assert investors.parse_infotable(xml, filed="2022-11-14")["037833100"]["value"] == 1_500_000.0


@pytest.mark.parametrize("doc", [
    b"<html><head><title>SEC.gov | Request Rate Threshold Exceeded</title></head><body><p>x</p></body></html>",
    b"<edgarSubmission xmlns='http://www.sec.gov/edgar/thirteenffiler'><headerData/></edgarSubmission>",
    b"<html><body><p>unclosed",
])
def test_parse_infotable_rejects_documents_that_arent_information_tables(doc):
    # A 200-OK HTML page (SEC throttle notice, error page) parsed as an
    # *empty portfolio*: a NEW HOLDINGS supplement then merged as "nothing".
    assert investors.parse_infotable(doc, filed="2026-08-14") is None
    assert investors.parse_infotable(_infotable([]), filed="2026-08-14") == {}


def test_parse_infotable_detects_values_reported_in_thousands():
    # Duquesne's Q2-2026 13F still reports <value> in $1000s (pre-2023 rule):
    # 336,300 GOOGL shares at "120184". Read as dollars, every change looked
    # 1000x too small and fell under the $1M floor.
    xml = _infotable([
        ("Alphabet Inc", "02079K305", 120_184, 336_300),
        ("Amazon Com Inc", "023135106", 129_085, 541_600),
        ("Linde Plc", "G54950103", 19_570, 41_200),
    ])
    h = investors.parse_infotable(xml, filed="2026-08-14")
    assert h["02079K305"]["value"] == 120_184_000.0
    assert h["023135106"]["value"] == 129_085_000.0


def test_diff_values_share_changes_not_price_drift():
    older = {
        "037833100": {"name": "APPLE INC", "shares": 1_000_000, "value": 150_000_000},
        "060505104": {"name": "BANK AMER CORP", "shares": 10_000_000, "value": 400_000_000},
        "02005N100": {"name": "ALLY FINL INC", "shares": 9_000_000, "value": 300_000_000},  # not in universe
    }
    newer = {
        # Held through a rally: value +$50M, shares flat → no signal.
        "037833100": {"name": "APPLE INC", "shares": 1_000_000, "value": 200_000_000},
        # Trimmed 1M shares while the price rose: value up, but it's a sale.
        "060505104": {"name": "BANK AMER CORP", "shares": 9_000_000, "value": 405_000_000},
        # New position in class C Alphabet → GOOGL.
        "02079K107": {"name": "ALPHABET INC", "shares": 100_000, "value": 25_000_000},
    }
    trades = investors.diff_holdings(older, newer, "Berkshire Hathaway", filed="2026-08-14",
                                     source_url="u", meta={"period": "2026-06-30"},
                                     split_factors={"AAPL": 1.0, "BAC": 1.0})
    got = {t.ticker: (t.direction, round(t.amount), t.meta["change"]) for t in trades}
    assert got == {"BAC": ("sell", 45_000_000, "trim"), "GOOGL": ("buy", 25_000_000, "new")}
    assert trades[0].traded_on == datetime(2026, 8, 14, tzinfo=timezone.utc)


_KLAC = "482480100"
_BKNG = "09857L108"


def _pair(cusip, o_sh, o_px, n_sh, n_px):
    return ({cusip: {"name": "X", "shares": o_sh, "value": o_sh * o_px}},
            {cusip: {"name": "X", "shares": n_sh, "value": n_sh * n_px}})


@pytest.mark.parametrize("case,cusip,factor,o_sh,o_px,n_sh,n_px,expected", [
    # The old heuristic rounded the price ratio to guess the factor: a 10:1
    # split plus a +6% / -5% quarter read as 9:1 / 11:1, plus a doubling as
    # 5:1 ("flat holder bought ~$82M" on live KLAC), and BKNG's 25:1 as 24:1.
    ("10:1 +6%", _KLAC, 10.0, 100_000, 800.0, 1_000_000, 84.8, None),
    ("10:1 -5%", _KLAC, 10.0, 100_000, 800.0, 1_000_000, 76.0, None),
    ("10:1 doubled", _KLAC, 10.0, 100_000, 800.0, 1_000_000, 160.0, None),
    ("25:1 +3%", _BKNG, 25.0, 20_000, 5_000.0, 500_000, 206.0, None),
    # Sold 84% after a 10:1 split while the stock doubled — a sale, which the
    # heuristic (share count not near the split basis → "no split") called a buy.
    ("10:1 heavy sell", _KLAC, 10.0, 100_000, 800.0, 160_000, 160.0, ("sell", 134_400_000)),
    # Price halves, nobody traded, no split: not a 2:1 "split" either way.
    ("crash no split", _KLAC, 1.0, 100_000, 800.0, 100_000, 400.0, None),
    ("added, no split", _KLAC, 1.0, 100_000, 800.0, 110_000, 820.0, ("buy", 8_200_000)),
])
def test_diff_uses_exact_split_factors(case, cusip, factor, o_sh, o_px, n_sh, n_px, expected):
    ticker = investors.CUSIP_TO_TICKER[cusip]
    older, newer = _pair(cusip, o_sh, o_px, n_sh, n_px)
    trades = investors.diff_holdings(older, newer, "X", filed="2026-08-14", source_url="u",
                                     split_factors={ticker: factor})
    got = [(t.direction, round(t.amount)) for t in trades]
    assert got == ([] if expected is None else [expected]), case


def test_diff_drops_held_tickers_without_split_data():
    older = {**_pair(_KLAC, 100_000, 800.0, 0, 0)[0],
             "594918104": {"name": "MICROSOFT", "shares": 50_000, "value": 25_000_000}}
    newer = {**_pair(_KLAC, 0, 0, 1_000_000, 84.8)[1],
             "037833100": {"name": "APPLE", "shares": 20_000, "value": 5_000_000}}
    trades = investors.diff_holdings(older, newer, "X", filed="2026-08-14", source_url="u",
                                     split_factors={"KLAC": None})    # yfinance failed
    # KLAC held both quarters with unknown splits: dropped, not guessed.
    # Opens and full exits need no split data.
    assert {(t.ticker, t.direction) for t in trades} == {("AAPL", "buy"), ("MSFT", "sell")}


def test_diff_cusip_change_compares_shares_only_when_comparable():
    hon_old, hon_new = "438516106", "438516205"
    # Spin-off quarter: CUSIP changed and the price fell 25%; the holder did
    # nothing. Per-CUSIP values read as a $50M sale.
    older = {hon_old: {"name": "HONEYWELL", "shares": 1_000_000, "value": 200_000_000}}
    flat = {hon_new: {"name": "HONEYWELL", "shares": 1_000_000, "value": 150_000_000}}
    added = {hon_new: {"name": "HONEYWELL", "shares": 1_200_000, "value": 180_000_000}}
    kw = dict(filed="2026-08-14", source_url="u", split_factors={"HON": 1.0})
    assert investors.diff_holdings(older, flat, "X", **kw) == []
    (t,) = investors.diff_holdings(older, added, "X", **kw)
    assert (t.ticker, t.direction, round(t.amount)) == ("HON", "buy", 30_000_000)
    # A renumbered CUSIP onto a different share basis can't be compared.
    rebased = {hon_new: {"name": "HONEYWELL", "shares": 100_000, "value": 160_000_000}}
    assert investors.diff_holdings(older, rebased, "X", **kw) == []


def test_diff_share_classes_are_valued_separately():
    # Sold all class A ($70M), bought class B ($47M): a $23M net sale. Summing
    # share counts across classes (1 A ≈ 1,500 B) reported a $47M *buy*.
    a, b = "084670108", "084670702"
    kw = dict(filed="2026-08-14", source_url="u", split_factors={"BRK.A": 1.0, "BRK.B": 1.0})
    (t,) = investors.diff_holdings({a: {"name": "BRK", "shares": 100, "value": 70_000_000}},
                                   {b: {"name": "BRK", "shares": 100_000, "value": 47_000_000}}, "X", **kw)
    assert (t.ticker, t.direction, round(t.amount)) == ("BRK.B", "sell", 23_000_000)
    # Kept A, bought more B: the A side is a per-class share change (zero).
    (t,) = investors.diff_holdings(
        {a: {"name": "BRK", "shares": 100, "value": 70_000_000},
         b: {"name": "BRK", "shares": 10_000, "value": 4_500_000}},
        {a: {"name": "BRK", "shares": 100, "value": 72_000_000}}
        | {b: {"name": "BRK", "shares": 30_000, "value": 14_400_000}}, "X", **kw)
    assert (t.direction, round(t.amount)) == ("buy", 9_600_000)
    # Class C → class A Alphabet, same price basis: sell C, buy A, net per class.
    c, ga = "02079K107", "02079K305"
    (t,) = investors.diff_holdings({c: {"name": "GOOG", "shares": 100_000, "value": 30_000_000}},
                                   {ga: {"name": "GOOGL", "shares": 60_000, "value": 18_000_000}}, "X",
                                   filed="2026-08-14", source_url="u",
                                   split_factors={"GOOG": 1.0, "GOOGL": 1.0})
    assert (t.ticker, t.direction, round(t.amount)) == ("GOOGL", "sell", 12_000_000)


def test_fetch_split_factors_reads_events_inside_the_window(monkeypatch):
    import pandas as pd
    import yfinance

    days = pd.to_datetime(["2026-04-06", "2026-06-12", "2026-06-30"])
    cols = pd.MultiIndex.from_product([["Close", "Stock Splits"], ["KLAC", "BKNG", "AAPL", "ZZZ"]],
                                      names=["Price", "Ticker"])
    nan = float("nan")
    df = pd.DataFrame([
        [500, 5000, 200, nan, 0.0, 25.0, 0.0, nan],
        [90, 210, 205, nan, 10.0, 0.0, 0.0, nan],
        [95, 215, 210, nan, 0.0, 0.0, 0.0, nan],
    ], index=days, columns=cols)
    seen = {}

    def fake_download(tickers, start=None, end=None, **kw):
        seen.update(tickers=list(tickers), start=str(start), end=str(end), actions=kw.get("actions"))
        return df
    monkeypatch.setattr(yfinance, "download", fake_download)
    out = investors._fetch_split_factors(["KLAC", "BKNG", "AAPL", "ZZZ", "BRK.B"], "2026-03-31", "2026-06-30")
    # Effective after the old period-end, up to and including the new one.
    assert (seen["start"], seen["end"], seen["actions"]) == ("2026-04-01", "2026-07-01", True)
    assert "BRK-B" in seen["tickers"]
    assert out == {"KLAC": 10.0, "BKNG": 25.0, "AAPL": 1.0, "ZZZ": None, "BRK.B": None}


@pytest.mark.parametrize("ratio,expected", [
    (2.0, 2.0), (1.5, 1.5), (1.25, 1.25), (4 / 3, 4 / 3), (0.125, 0.125), (0.05, 0.05),
    # Yahoo books spin-offs as fractional "splits" (HON 0.9535 for the
    # Aerospace spin on 2026-06-29, GE 1.253 for Vernova). Share counts don't
    # change, so applying them invents trades: NOT_A_SPLIT (pair dropped) —
    # distinct from None, which means the lookup itself failed.
    (0.9535, "not"), (1.061, "not"), (1.253, "not"), (1.281, "not"),
])
def test_fetch_split_factors_rejects_spin_off_adjustments(monkeypatch, ratio, expected):
    import pandas as pd
    import yfinance

    cols = pd.MultiIndex.from_product([["Close", "Stock Splits"], ["HON"]], names=["Price", "Ticker"])
    df = pd.DataFrame([[220.0, ratio]], index=pd.to_datetime(["2026-06-29"]), columns=cols)
    monkeypatch.setattr(yfinance, "download", lambda *a, **k: df)
    got = investors._fetch_split_factors(["HON"], "2026-03-31", "2026-06-30")["HON"]
    assert got == (investors.NOT_A_SPLIT if expected == "not" else pytest.approx(expected))


class _Edgar:
    """Canned EDGAR for one filer: Q1 original, Q2 original + Q2 restatement."""

    CIK = "0001067983"

    def __init__(self, filed_q2="2026-08-14"):
        self.filed_q2 = filed_q2
        self.calls: list[str] = []
        base = "https://www.sec.gov/Archives/edgar/data/1067983/"
        self.routes = {
            "https://data.sec.gov/submissions/CIK0001067983.json": _resp(payload={
                "name": "BERKSHIRE HATHAWAY INC",
                "filings": {"recent": {
                    "form": ["13F-HR/A", "4", "13F-HR", "13F-HR"],
                    "accessionNumber": ["0000000000-26-000003", "x", "0000000000-26-000002",
                                        "0000000000-26-000001"],
                    "filingDate": ["2026-09-02", "2026-08-20", filed_q2, "2026-05-15"],
                    "reportDate": ["2026-06-30", "", "2026-06-30", "2026-03-31"],
                }},
            }),
            base + "000000000026000003/primary_doc.xml": _resp(text=(
                "<edgarSubmission xmlns='http://www.sec.gov/edgar/thirteenffiler'><formData><coverPage>"
                "<amendmentInfo><amendmentType>RESTATEMENT</amendmentType></amendmentInfo>"
                "</coverPage></formData></edgarSubmission>")),
        }
        for acc, rows in {
            "000000000026000001": [("APPLE INC", "037833100", 150_000_000, 1_000_000)],
            # Original Q2 (superseded): would read as a big AAPL buy.
            "000000000026000002": [("APPLE INC", "037833100", 600_000_000, 3_000_000)],
            # Restated Q2: sold 200k AAPL, opened MSFT.
            "000000000026000003": [("APPLE INC", "037833100", 160_000_000, 800_000),
                                   ("MICROSOFT CORP", "594918104", 50_000_000, 100_000)],
        }.items():
            self.routes[base + f"{acc}/index.json"] = _resp(payload={"directory": {"item": [
                {"name": "primary_doc.xml"}, {"name": f"info{acc[-1]}.xml"}]}})
            self.routes[base + f"{acc}/info{acc[-1]}.xml"] = _resp(content=_infotable(rows))

    def get(self, url, headers=None, timeout=None):
        assert headers and "User-Agent" in headers and timeout
        self.calls.append(url)
        return self.routes.get(url, _resp(404, text="nope"))


def test_13f_refresh_uses_restatement_and_dedupes_weekly_reruns(monkeypatch, no_sec_throttle, splits):
    edgar = _Edgar()
    monkeypatch.setattr(investors.requests, "get", edgar.get)
    monkeypatch.setattr(investors, "TRACKED_INVESTORS", {"Berkshire Hathaway": edgar.CIK})
    assert investors.refresh_all() == 2
    assert investors.refresh_all() == 0          # next Sunday re-reads the same filings
    with SessionLocal() as s:
        rows = {r.ticker: r for r in s.scalars(select(Signal).where(Signal.kind == "investor")).all()}
    assert set(rows) == {"AAPL", "MSFT"}
    aapl = rows["AAPL"]
    assert (aapl.direction, round(aapl.amount)) == ("sell", 40_000_000)   # 200k sh × $200
    assert aapl.meta["accession"] == "0000000000-26-000003"               # the restatement
    assert aapl.meta["period"] == "2026-06-30" and aapl.meta["prior_period"] == "2026-03-31"
    assert aapl.meta["weight"] == 2.0 and aapl.source == "Berkshire Hathaway"
    assert aapl.as_of.date().isoformat() == "2026-09-02"                  # public on filing
    assert not any("xslForm13F" in u for u in edgar.calls)


def test_13f_rows_carry_each_periods_book_total(monkeypatch, no_sec_throttle, splits):
    # tools._rank_13f ranks by weight × |Δ$| ÷ the fund's book for the period.
    edgar = _Edgar()
    monkeypatch.setattr(investors.requests, "get", edgar.get)
    monkeypatch.setattr(investors, "TRACKED_INVESTORS", {"Berkshire Hathaway": edgar.CIK})
    investors.refresh_all()
    with SessionLocal() as s:
        rows = s.scalars(select(Signal).where(Signal.kind == "investor")).all()
    assert rows and all(r.meta["book_total"] == 210_000_000 for r in rows)        # restated Q2
    assert all(r.meta["book_total_prior"] == 150_000_000 for r in rows)           # Q1


def test_13f_skips_filers_that_stopped_filing(monkeypatch, no_sec_throttle, splits):
    edgar = _Edgar()
    stale = (utcnow() - timedelta(days=400)).strftime("%Y-%m-%d")
    payload = edgar.routes["https://data.sec.gov/submissions/CIK0001067983.json"].json()
    payload["filings"]["recent"]["filingDate"] = [stale, stale, stale, "2025-05-15"]
    edgar.routes["https://data.sec.gov/submissions/CIK0001067983.json"] = _resp(payload=payload)
    monkeypatch.setattr(investors.requests, "get", edgar.get)
    assert investors.changes_for_cik(edgar.CIK, "Berkshire Hathaway") == []
    assert not any(u.endswith(".xml") and "info" in u for u in edgar.calls)


def _investor_row(source, ticker, cik, period, direction="buy", amount=5e6):
    return Signal(ticker=ticker, kind="investor", source=source, direction=direction, amount=amount,
                  as_of=utcnow(), meta={"cik": cik, "period": period, "investor": source})


def test_13f_recompute_replaces_period_rows_and_purges_wrong_cik(monkeypatch, no_sec_throttle, splits):
    edgar = _Edgar()
    monkeypatch.setattr(investors.requests, "get", edgar.get)
    monkeypatch.setattr(investors, "TRACKED_INVESTORS", {
        "Berkshire Hathaway": edgar.CIK,
        "Maverick Capital": "0000934639",       # EDGAR has nothing for it in this test
    })
    with SessionLocal.begin() as s:
        # Bogus row from an earlier computation of the same quarter.
        s.add(_investor_row("Berkshire Hathaway", "KLAC", edgar.CIK, "2026-06-30"))
        s.add(_investor_row("Berkshire Hathaway", "AAPL", edgar.CIK, "2026-06-30", "buy", 9e9))
        # Last quarter's change: history, kept.
        s.add(_investor_row("Berkshire Hathaway", "BAC", edgar.CIK, "2026-03-31", "sell"))
        # Stored under the wrong CIK (WEDGE) and under a since-removed alias.
        s.add(_investor_row("Maverick Capital", "AMAT", "0001015308", "2026-06-30"))
        s.add(_investor_row("Dan Loeb (Third Point)", "AMZN", "0001040273", "2026-06-30"))
    investors.refresh_all()
    with SessionLocal() as s:
        rows = s.scalars(select(Signal).where(Signal.kind == "investor")).all()
    got = sorted((r.source, r.ticker, r.meta["period"], r.direction) for r in rows)
    assert got == [
        ("Berkshire Hathaway", "AAPL", "2026-06-30", "sell"),
        ("Berkshire Hathaway", "BAC", "2026-03-31", "sell"),
        ("Berkshire Hathaway", "MSFT", "2026-06-30", "buy"),
    ]


def _berkshire_rows() -> list[tuple]:
    with SessionLocal() as s:
        rows = s.scalars(select(Signal).where(Signal.kind == "investor")).all()
    return sorted((r.ticker, r.meta.get("period"), r.direction, round(r.amount)) for r in rows)


def test_13f_split_lookup_outage_keeps_stored_rows(monkeypatch, no_sec_throttle, splits):
    edgar = _Edgar()
    monkeypatch.setattr(investors.requests, "get", edgar.get)
    monkeypatch.setattr(investors, "TRACKED_INVESTORS", {"Berkshire Hathaway": edgar.CIK})
    investors.refresh_all()                       # good week: AAPL trim + MSFT open
    good = _berkshire_rows()
    assert good == [("AAPL", "2026-06-30", "sell", 40_000_000), ("MSFT", "2026-06-30", "buy", 50_000_000)]
    # Yahoo down / rate-limited: every split lookup unknown. AAPL (held both
    # quarters) can't be recomputed — its stored row must survive, not be
    # reconciled away. MSFT (an open) needs no split data and is recomputed.
    splits["*"] = None
    investors.refresh_all()
    assert _berkshire_rows() == good
    # A definitive non-split event (spin-off booked as a split) is not an
    # outage: the pair is dropped and its stale row removed.
    splits["*"] = 1.0
    splits["AAPL"] = investors.NOT_A_SPLIT
    investors.refresh_all()
    assert _berkshire_rows() == [("MSFT", "2026-06-30", "buy", 50_000_000)]


def _edgar_with_new_holdings_amendment() -> _Edgar:
    """Q2 also has a NEW HOLDINGS amendment (Berkshire files these for
    positions it was allowed to keep confidential)."""
    edgar = _Edgar()
    base = "https://www.sec.gov/Archives/edgar/data/1067983/"
    sub = edgar.routes["https://data.sec.gov/submissions/CIK0001067983.json"].json()
    recent = sub["filings"]["recent"]
    for key, val in (("form", "13F-HR/A"), ("accessionNumber", "0000000000-26-000004"),
                     ("filingDate", "2026-09-20"), ("reportDate", "2026-06-30")):
        recent[key].insert(0, val)
    edgar.routes["https://data.sec.gov/submissions/CIK0001067983.json"] = _resp(payload=sub)
    edgar.routes[base + "000000000026000004/primary_doc.xml"] = _resp(text=(
        "<edgarSubmission xmlns='http://www.sec.gov/edgar/thirteenffiler'><formData><coverPage>"
        "<amendmentInfo><amendmentType>NEW HOLDINGS</amendmentType></amendmentInfo>"
        "</coverPage></formData></edgarSubmission>"))
    edgar.routes[base + "000000000026000004/index.json"] = _resp(payload={"directory": {"item": [
        {"name": "primary_doc.xml"}, {"name": "info4.xml"}]}})
    edgar.routes[base + "000000000026000004/info4.xml"] = _resp(content=_infotable(
        [("CHEVRON CORP", "166764100", 30_000_000, 200_000)]))
    return edgar


def test_13f_new_holdings_amendment_is_merged(monkeypatch, no_sec_throttle, splits):
    edgar = _edgar_with_new_holdings_amendment()
    monkeypatch.setattr(investors.requests, "get", edgar.get)
    monkeypatch.setattr(investors, "TRACKED_INVESTORS", {"Berkshire Hathaway": edgar.CIK})
    investors.refresh_all()
    assert [r[0] for r in _berkshire_rows()] == ["AAPL", "CVX", "MSFT"]


@pytest.mark.parametrize("broken", [
    "000000000026000004/info4.xml",          # NEW HOLDINGS table didn't download
    "000000000026000004/info4.xml html",     # ...or came back as a 200-OK HTML page
    "000000000026000004/primary_doc.xml",    # its amendment type couldn't be read
    "000000000026000003/primary_doc.xml",    # the RESTATEMENT's type couldn't be read
])
def test_13f_incomplete_filing_chain_skips_the_fund(monkeypatch, no_sec_throttle, splits, broken):
    edgar = _edgar_with_new_holdings_amendment()
    base = "https://www.sec.gov/Archives/edgar/data/1067983/"
    path, _, variant = broken.partition(" ")
    if variant == "html":
        edgar.routes[base + path] = _resp(text="<html><body><h1>Request Rate Threshold Exceeded</h1></body></html>")
    else:
        edgar.routes.pop(base + path)
    # Keep the superseded original within the 4x book guard, so falling back
    # to it would really be persisted.
    edgar.routes[base + "000000000026000002/info2.xml"] = _resp(content=_infotable(
        [("APPLE INC", "037833100", 300_000_000, 1_500_000)]))
    monkeypatch.setattr(investors.requests, "get", edgar.get)
    monkeypatch.setattr(investors, "TRACKED_INVESTORS", {"Berkshire Hathaway": edgar.CIK})
    with SessionLocal.begin() as s:
        s.add(_investor_row("Berkshire Hathaway", "KLAC", edgar.CIK, "2026-06-30"))
    investors.refresh_all()
    # Nothing saved from a partial picture; last week's rows untouched.
    assert _berkshire_rows() == [("KLAC", "2026-06-30", "buy", 5_000_000)]


def test_13f_purge_drops_legacy_and_untracked_rows(monkeypatch):
    cik = "0001067983"
    monkeypatch.setattr(investors, "TRACKED_INVESTORS", {"Berkshire Hathaway": cik})
    with SessionLocal.begin() as s:
        s.add(_investor_row("Berkshire Hathaway", "AAPL", cik, "2026-06-30"))          # valid
        # Old-pipeline rows: no cik/period, amounts ×1000-inflated.
        for name in ("Scion (Michael Burry)", "Pershing Square Tontine", "Seth Klarman (Baupost)",
                     "Berkshire Hathaway"):
            s.add(Signal(ticker="NVDA", kind="investor", source=name, direction="buy",
                         amount=5e12, as_of=utcnow(), meta={"weight": 1.0, "investor": name}))
        s.add(_investor_row("Berkshire Hathaway", "MSFT", cik, None))                  # no period
        s.add(Signal(ticker="NVDA", kind="politician", source="Nancy Pelosi", direction="buy",
                     amount=8_000, as_of=utcnow(), meta={}))                            # not 13F
    assert investors._purge_misattributed() == 5
    with SessionLocal() as s:
        left = sorted((r.kind, r.source, r.ticker) for r in s.scalars(select(Signal)).all())
    assert left == [("investor", "Berkshire Hathaway", "AAPL"), ("politician", "Nancy Pelosi", "NVDA")]


def _job_runs():
    from bot.db import JobRun

    with SessionLocal() as s:
        return s.scalars(select(JobRun).where(JobRun.job_name == "investors_refresh")
                         .order_by(JobRun.started_at)).all()


@pytest.fixture
def two_funds(monkeypatch, no_sec_throttle, splits):
    """Berkshire (healthy) + Balyasny, whose EDGAR submissions 404."""
    edgar = _Edgar()
    monkeypatch.setattr(investors.requests, "get", edgar.get)
    monkeypatch.setattr(investors, "TRACKED_INVESTORS", {
        "Berkshire Hathaway": edgar.CIK, "Balyasny Asset Mgmt": "0001218710"})
    return edgar


def test_investors_job_lists_funds_skipped_this_week(two_funds):
    out = investors.run()
    assert out["count"] == 2 and out["error"] is None
    assert list(out["skipped"]) == ["Balyasny Asset Mgmt"]
    (jr,) = _job_runs()
    assert jr.status == "ok"
    assert "Balyasny Asset Mgmt" in jr.message and "submissions unavailable" in jr.message


def _past_run(days_ago: int, skipped: dict):
    from bot.db import JobRun

    when = utcnow() - timedelta(days=days_ago)
    return JobRun(job_name="investors_refresh", started_at=when, finished_at=when, status="ok",
                  message=str({"count": 0, "error": None, "skipped": skipped}))


@pytest.mark.parametrize("history,expect_failed", [
    ([7, 14], True),       # skipped this week and the two before
    ([7], False),          # only two weeks running
    ([1, 2], False),       # manual re-runs in the same couple of days aren't weeks
])
def test_investors_job_fails_when_a_fund_is_skipped_three_weeks_running(two_funds, history, expect_failed):
    reason = {"Balyasny Asset Mgmt": "incomplete filing chain: submissions unavailable"}
    with SessionLocal.begin() as s:
        for days in history:
            s.add(_past_run(days, reason))
        s.add(_past_run(21, {}))                        # healthy before that
    out = investors.run()
    jr = _job_runs()[-1]
    if expect_failed:
        assert jr.status == "failed"
        assert "Balyasny Asset Mgmt" in out["error"] and "3 consecutive weeks" in out["error"]
    else:
        assert jr.status == "ok" and out["error"] is None
    assert out["count"] == 2                            # healthy funds still saved


def test_tracked_investors_are_one_name_per_filer():
    from bot.config import INVESTOR_WEIGHTS, TRACKED_INVESTORS

    ciks = list(TRACKED_INVESTORS.values())
    dupes = {c: [n for n, k in TRACKED_INVESTORS.items() if k == c] for c in ciks if ciks.count(c) > 1}
    assert not dupes, f"names sharing a CIK double-count its 13F changes: {dupes}"
    assert all(len(c) == 10 and c.isdigit() for c in ciks)
    assert set(INVESTOR_WEIGHTS) <= set(TRACKED_INVESTORS), "weight for an untracked name"


def test_13f_skips_pairs_whose_reporting_scope_changed(monkeypatch, no_sec_throttle, splits):
    # Pershing Square Inc. took over Pershing's 13F in Q2-2026: its Q1 filing
    # held one stock, Q2 the whole book. Diffing them would read every holding
    # as a brand-new multi-billion buy.
    edgar = _Edgar()
    base = "https://www.sec.gov/Archives/edgar/data/1067983/"
    edgar.routes[base + "000000000026000001/info1.xml"] = _resp(content=_infotable(
        [("HOWARD HUGHES HLDGS", "44267T102", 40_000_000, 500_000)]))
    monkeypatch.setattr(investors.requests, "get", edgar.get)
    assert investors.changes_for_cik(edgar.CIK, "Pershing Square") == []


def test_sec_requests_are_throttled(monkeypatch):
    sleeps = []
    monkeypatch.setattr(investors.time, "sleep", sleeps.append)
    monkeypatch.setattr(investors.requests, "get", lambda *a, **k: _resp(payload={}))
    investors._sec_get("https://data.sec.gov/a")
    investors._sec_get("https://data.sec.gov/b")
    assert sleeps and 0 < sleeps[-1] <= investors._SEC_MIN_INTERVAL_S


# ---------------------------------------------------------------------------
# Senate eFD
# ---------------------------------------------------------------------------

_HOME_HTML = """<form action="" method="POST" id="agreement_form">
<input type="checkbox" id="agree_statement" value="1" name="prohibition_agreement" />
<input type="hidden" name="csrfmiddlewaretoken" value="FORMTOKEN123"></form>"""

_PTR_HTML = """<html><table class="table table-striped"><thead><tr class="header">
<th scope="col">&#35;</th><th scope="col">Transaction Date</th><th scope="col">Owner</th>
<th scope="col">Ticker</th><th scope="col">Asset Name</th><th scope="col">Asset Type</th>
<th scope="col">Type</th><th scope="col">Amount</th><th scope="col">Comment</th></tr></thead><tbody>
<tr><td>1</td><td> 09/04/2026 </td><td>Self</td><td><a href="https://finance.yahoo.com/quote/JPM">JPM</a></td>
<td>JP Morgan Chase &amp; Co. Common Stock</td><td>Stock</td><td>Sale (Partial)</td><td>$15,001 - $50,000</td><td>--</td></tr>
<tr><td>2</td><td> 09/05/2026 </td><td>Spouse</td><td><a href="https://finance.yahoo.com/quote/V">V</a></td>
<td>Visa Inc.</td><td>Stock</td><td>Purchase</td><td>Over $50,000,000</td><td>--</td></tr>
<tr><td>3</td><td> 09/05/2026 </td><td>Self</td><td>AAPL</td><td>Apple call</td><td>Stock Option</td>
<td>Purchase</td><td>$1,001 - $15,000</td><td>--</td></tr>
<tr><td>4</td><td> 09/05/2026 </td><td>Self</td><td>--</td><td>Muni bond</td><td>Municipal Security</td>
<td>Purchase</td><td>$1,001 - $15,000</td><td>--</td></tr>
<tr><td>5</td><td> 09/05/2026 </td><td>Self</td><td>MSFT</td><td>Microsoft</td><td>Stock</td>
<td>Exchange</td><td>$1,001 - $15,000</td><td>--</td></tr>
</tbody></table></html>"""


class _EfdSession:
    """Mimics efdsearch.senate.gov's Django CSRF behaviour."""

    def __init__(self, agree_status=200):
        self.cookies: dict[str, str] = {}
        self.headers: dict[str, str] = {}
        self.agree_status = agree_status
        self.posts: list[tuple] = []

    def get(self, url, timeout=None):
        assert timeout
        if url == senate._HOME:
            self.cookies["csrftoken"] = "COOKIETOKEN"
            return _resp(text=_HOME_HTML, url=url)
        if "/view/ptr/" in url:
            if "sessionid" not in self.cookies:
                return _resp(text="agree first", url=senate._HOME)
            return _resp(text=_PTR_HTML, url=url)
        return _resp(404, text="", url=url)

    def post(self, url, data=None, headers=None, timeout=None):
        assert timeout
        self.posts.append((url, dict(data or {}), dict(headers or {})))
        if url == senate._HOME:
            if data.get("csrfmiddlewaretoken") != "FORMTOKEN123" or self.agree_status != 200:
                return _resp(403, text="CSRF verification failed", url=url)
            self.cookies["sessionid"] = "S"
            return _resp(text="search page", url=senate._SEARCH)
        if url == senate._REPORT_DATA:
            if (headers.get("X-CSRFToken") != "COOKIETOKEN" or "sessionid" not in self.cookies
                    or headers.get("Referer") != senate._SEARCH):
                return _resp(403, text="Forbidden", url=url)
            return _resp(payload={"draw": 0, "recordsTotal": 2, "recordsFiltered": 2, "result": "ok", "data": [
                ["Sheldon", "Whitehouse", "Whitehouse, Sheldon (Senator)",
                 '<a href="/search/view/ptr/6bf3b6f7/" target="_blank">Periodic Transaction Report for 10/01/2026</a>',
                 "10/01/2026"],
                ["Jane", "Doe", "Doe, Jane (Senator)",
                 '<a href="/search/view/paper/abc/" target="_blank">Paper report</a>', "09/30/2026"],
            ]}, url=url)
        return _resp(404, text="", url=url)


def test_senate_flow_carries_csrf_and_parses_ptr(monkeypatch):
    sess = _EfdSession()
    monkeypatch.setattr(senate, "_new_session", lambda: sess)
    monkeypatch.setattr(senate, "_REQUEST_GAP_S", 0)
    assert senate.refresh_senate() == 2
    assert senate.refresh_senate() == 0          # daily re-read of the same 14 days
    with SessionLocal() as s:
        rows = {r.ticker: r for r in s.scalars(select(Signal)).all()}
    assert set(rows) == {"JPM", "V"}             # option, "--" and exchange rows skipped
    jpm, v = rows["JPM"], rows["V"]
    assert (jpm.source, jpm.direction, jpm.amount) == ("Sheldon Whitehouse", "sell", 32_500)
    assert (v.direction, v.amount) == ("buy", 50_000_000)       # open-ended → floor
    assert jpm.meta["chamber"] == "senate" and jpm.meta["traded_on"] == "2026-09-04"
    assert jpm.as_of.date().isoformat() == "2026-10-01"          # date eFD received it
    (_, agree, _), (_, search, _) = sess.posts[:2]
    assert agree == {"prohibition_agreement": "1", "csrfmiddlewaretoken": "FORMTOKEN123"}
    assert search["csrfmiddlewaretoken"] == "COOKIETOKEN" and search["report_types"] == "[11]"


@pytest.mark.parametrize("failure", ["403", "network"])
def test_senate_failures_return_zero_without_raising(monkeypatch, failure):
    sess = _EfdSession(agree_status=403)
    if failure == "network":
        def boom(*a, **k):
            raise requests.ConnectionError("down")
        sess.get = boom
    monkeypatch.setattr(senate, "_new_session", lambda: sess)
    out = senate.run()
    assert out == {"count": 0, "error": None}


# ---------------------------------------------------------------------------
# House PTR PDFs
# ---------------------------------------------------------------------------

_NUL = "\x00"
# Rows exactly as pdfplumber extracts them from real PTRs (incl. the NUL
# padding in "F S:"/"D:" footnote labels).
_MERGED_OPTION_ROW = [
    f"SP Intel Corporation - Common Stock P 07/24/2026 07/24/2026 $250,001 -\n(INTC) [OP] $500,000\n"
    f"F{_NUL * 5} S{_NUL * 5}: New\nD{_NUL * 10}: Purchased 50 call options with a strike price of $50 "
    f"and an expiration date of 6/17/27.", None, None, None, None, None, None, None]
_CELLS_ROW = ["", "SP", "Intel Corporation - Common Stock\n(INTC) [ST]", "P", "07/24/2026",
              "07/24/2026", "$500,001 -\n$1,000,000", ""]
_PARTIAL_SALE_ROW = ["", "DC", "Apple Inc. - Common Stock (AAPL)\n[ST]", "S (partial)", "09/08/2026",
                     "09/15/2026", "$1,001 - $15,000", ""]
_MERGED_SALE_ROW = [f"JT Honeywell International Inc. (HON) S 08/31/2026 09/15/2026 $15,001 -\n[ST] $50,000\n"
                    f"F{_NUL * 5} S{_NUL * 5}: New", "", "", "", "", "", "", ""]


@pytest.mark.parametrize("label,expected", [
    ("$1,001 - $15,000", 8_000),
    ("$1,001 -\n$15,000", 8_000),                          # wrapped cell
    ("$250,001 -\n(INTC) [OP] $500,000", 375_000),          # split around asset text
    ("$1,000,001 - $5,000,000", 3_000_000),
    ("Over $50,000,000", 50_000_000),
    ("$50,000,001 +", 50_000_001),
    ("Spouse/DC Over $1,000,000", 1_000_000),
    ("$15,001 -", 32_500),                                  # upper bound lost
    ("--", 0.0),
    ("", 0.0),
])
def test_parse_amount(label, expected):
    assert politicians.parse_amount(label) == expected


def test_parse_house_rows_from_real_layouts():
    p = politicians.parse_house_row
    d = lambda s: datetime.strptime(s, "%m/%d/%Y").replace(tzinfo=timezone.utc)  # noqa: E731
    # [OP] rows are options: a bought put isn't a bullish "buy" (same as Senate).
    assert p(_MERGED_OPTION_ROW) is None
    assert p(["", "SP", "Apple Inc. - Common Stock (AAPL)\n[OP]", "P", "08/01/2026", "08/01/2026",
              "$15,001 - $50,000", ""]) is None
    assert p([f"SP Tesla, Inc. - Common Stock P 08/03/2026 08/03/2026 $50,001 -\n(TSLA) [OP] $100,000\n"
              f"F{_NUL * 5} S{_NUL * 5}: New\nD{_NUL * 10}: Purchased 20 put options.",
              None, None, None, None, None, None, None]) is None
    assert p(_CELLS_ROW) == {"ticker": "INTC", "direction": "buy", "amount": 750_000,
                             "traded_on": d("07/24/2026")}
    assert p(_PARTIAL_SALE_ROW)["direction"] == "sell"
    assert p(_MERGED_SALE_ROW) == {"ticker": "HON", "direction": "sell", "amount": 32_500,
                                   "traded_on": d("08/31/2026")}
    assert p(["", "", "Marathon Petroleum (MPC) [ST]", "S", "09/22/2026", "10/01/2026",
              "$1,001 - $15,000", ""]) is None                         # not in universe
    assert p(["", "", f"F{_NUL * 5} S{_NUL * 5}: New\nD{_NUL * 10}: Purchased 10,000 shares.",
              None, None, None, None, None]) is None                  # footnote-only row
    assert p(["", "", "Apple Inc. (AAPL) [ST]", "E", "09/22/2026", "10/01/2026",
              "$1,001 - $15,000", ""]) is None                         # exchange
    assert p(["ID", "Owner", "Asset", "Transaction\nType", "Date", "Notification\nDate",
              "Amount", "Cap.\nGains >\n$200?"]) is None               # header


_MSFT_ROW = ["", "", "Microsoft Corporation - Common\nStock (MSFT) [ST]", "P", "09/10/2026",
             "09/10/2026", "$1,001 - $15,000", ""]


@pytest.fixture
def house_filing(monkeypatch):
    """One Pelosi filing (filed 8/21/2026) whose PDF yields ``rows``."""
    import pdfplumber

    rows: list = []
    monkeypatch.setattr(politicians, "_fetch_house_year_index", lambda year: [{
        "prefix": "Hon.", "last": "Pelosi", "first": "Nancy", "type": "P", "state": "CA11",
        "year": "2026", "filing": "8/21/2026", "doc_id": "20035143"}])
    monkeypatch.setattr(politicians.requests, "get",
                        lambda u, headers=None, timeout=None: _resp(content=b"%PDF", url=u))

    class _Pdf:
        pages = [SimpleNamespace(extract_tables=lambda: [list(rows)])]

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False
    monkeypatch.setattr(pdfplumber, "open", lambda f: _Pdf())
    return rows


def _house_row(ticker, direction, as_of, *, legacy=True, amount=0.0):
    url = politicians._pdf_url("2026", "20035143")
    meta = {"source_url": url, "politician": "Nancy Pelosi", "chamber": "house"}
    if not legacy:
        meta.update(traded_on="2026-07-24", disclosed_on="2026-08-21")
    return Signal(ticker=ticker, kind="politician", source="Nancy Pelosi", direction=direction,
                  amount=amount, as_of=as_of, meta=meta)


def test_house_refresh_dates_signals_by_filing(house_filing):
    house_filing += [_MERGED_OPTION_ROW, _CELLS_ROW, _MSFT_ROW, _MSFT_ROW]
    assert politicians.refresh_house() == 3          # option row skipped; both MSFT buys kept
    assert politicians.refresh_house() == 0          # tomorrow's re-read
    with SessionLocal() as s:
        rows = s.scalars(select(Signal).order_by(Signal.ticker)).all()
    assert [(r.ticker, r.amount) for r in rows] == [("INTC", 750_000), ("MSFT", 8_000), ("MSFT", 8_000)]
    assert {r.as_of.date().isoformat() for r in rows} == {"2026-08-21"}
    assert rows[0].meta["traded_on"] == "2026-07-24" and rows[0].meta["disclosed_on"] == "2026-08-21"


def test_house_pdf_failing_partway_leaves_the_filing_alone(house_filing, monkeypatch):
    import pdfplumber

    def broken_page():
        raise ValueError("corrupt xref")

    class _Pdf:
        pages = [SimpleNamespace(extract_tables=lambda: [[_CELLS_ROW]]),
                 SimpleNamespace(extract_tables=broken_page)]

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False
    monkeypatch.setattr(pdfplumber, "open", lambda f: _Pdf())
    with SessionLocal.begin() as s:
        s.add(_house_row("INTC", "buy", utcnow(), legacy=False, amount=750_000))
        s.add(_house_row("MSFT", "buy", utcnow(), legacy=False, amount=8_000))   # from page 2
    assert politicians.refresh_house() == 0
    with SessionLocal() as s:
        assert sorted(r.ticker for r in s.scalars(select(Signal)).all()) == ["INTC", "MSFT"]


def test_house_reread_collapses_pre_dedupe_copies(house_filing):
    # Before the dedupe fix every daily refresh re-inserted the same trade
    # with as_of = that day's ingest time, so copies stayed "fresh" for weeks.
    house_filing += [_MERGED_OPTION_ROW, _CELLS_ROW]
    with SessionLocal.begin() as s:
        for days_ago in (6, 3, 1):
            s.add(_house_row("INTC", "buy", utcnow() - timedelta(days=days_ago)))
        # Stored from the option row the parser now skips (a put "buy").
        s.add(_house_row("INTC", "sell", utcnow() - timedelta(days=2)))
        # Another filing's row: untouched.
        s.add(Signal(ticker="AAPL", kind="politician", source="Nancy Pelosi", direction="buy",
                     amount=8_000, as_of=utcnow(), meta={"source_url": "other.pdf", "chamber": "house"}))
    assert politicians.refresh_house() == 0
    with SessionLocal() as s:
        rows = s.scalars(select(Signal).order_by(Signal.ticker)).all()
    assert [(r.ticker, r.direction, r.meta["source_url"].rsplit("/", 1)[-1]) for r in rows] == [
        ("AAPL", "buy", "other.pdf"), ("INTC", "buy", "20035143.pdf")]
    intc = rows[1]
    assert intc.amount == 750_000 and intc.as_of.date().isoformat() == "2026-08-21"
    assert intc.meta["traded_on"] == "2026-07-24"


# ---------------------------------------------------------------------------
# Earnings history (yfinance)
# ---------------------------------------------------------------------------


class _FakeTicker:
    frames: dict = {}
    requested: list = []

    def __init__(self, symbol):
        self.symbol = symbol
        _FakeTicker.requested.append(symbol)

    def get_earnings_history(self):
        frame = _FakeTicker.frames.get(self.symbol)
        if isinstance(frame, Exception):
            raise frame
        return frame


@pytest.fixture
def fake_yf(monkeypatch):
    import pandas as pd
    import yfinance

    _FakeTicker.requested = []
    _FakeTicker.frames = {
        # Off-calendar fiscal year (quarters end Oct/Jan/Apr/Jul) under Yahoo's
        # quoteSummary shape: surprisePercent is a fraction.
        "WMT": pd.DataFrame(
            {"epsActual": [0.62, 0.74, 0.66, 0.81], "epsEstimate": [0.60128, 0.727, 0.65872, 0.74126],
             "epsDifference": [0.02, 0.01, 0.001, 0.07], "surprisePercent": [0.0311, 0.0179, 0.0019, float("nan")]},
            index=pd.DatetimeIndex(["2025-10-31", "2026-01-31", "2026-04-30", "2026-07-31"], name="quarter")),
        "BRK-B": pd.DataFrame(
            {"epsActual": [6.0255], "epsEstimate": [5.13264], "epsDifference": [0.89], "surprisePercent": [0.174]},
            index=pd.DatetimeIndex(["2026-06-30"], name="quarter")),
        "SPY": pd.DataFrame(),
        "AAPL": RuntimeError("HTTP Error 401: Invalid Crumb"),
    }
    monkeypatch.setattr(yfinance, "Ticker", _FakeTicker)
    monkeypatch.setattr(earnings, "_YF_GAP_S", 0)
    return _FakeTicker


def test_yfinance_history_labels_quarters_and_keeps_fraction_units(fake_yf):
    wmt = earnings._yahoo_surprise_history("WMT")
    assert [h["quarter"] for h in wmt] == ["2025-Q3", "2025-Q4", "2026-Q1", "2026-Q2"]
    assert wmt[0]["surprise_pct"] == pytest.approx(0.0311)
    # Missing surprise is derived from actual vs estimate (same fraction unit).
    assert wmt[-1]["surprise_pct"] == pytest.approx((0.81 - 0.74126) / 0.74126)
    assert earnings._yahoo_surprise_history("BRK.B")[0]["quarter"] == "2026-Q2"
    assert "BRK-B" in fake_yf.requested                 # Yahoo's symbol for BRK.B
    assert earnings._yahoo_surprise_history("SPY") == []
    assert earnings._yahoo_surprise_history("AAPL") == []   # errors never propagate


def test_history_refresh_replaces_legacy_rows_and_is_idempotent(fake_yf):
    with SessionLocal.begin() as s:
        # Written by the old Yahoo path / dev bootstrap: period-end date label,
        # fetched just now (would otherwise count as fresh for 7 days).
        s.add(EarningsHistory(ticker="WMT", quarter="2026-07-31", surprise_pct=0.09, fetched_at=utcnow()))
    assert earnings.refresh_history_for(["WMT", "BRK.B"]) == 5
    assert earnings.refresh_history_for(["WMT", "BRK.B"]) == 0
    assert fake_yf.requested == ["WMT", "BRK-B"]         # second pass served from cache
    with SessionLocal() as s:
        quarters = s.scalars(select(EarningsHistory.quarter).where(EarningsHistory.ticker == "WMT")
                             .order_by(EarningsHistory.quarter)).all()
        total = s.scalar(select(func.count()).select_from(EarningsHistory))
    assert quarters == ["2025-Q3", "2025-Q4", "2026-Q1", "2026-Q2"] and total == 5


def _db_write_locked() -> bool:
    """True when another connection holds the SQLite write lock."""
    import sqlite3

    from bot.config import settings

    con = sqlite3.connect(settings.db_path, timeout=0)
    try:
        con.execute("BEGIN IMMEDIATE")
        con.rollback()
        return False
    except sqlite3.OperationalError:
        return True
    finally:
        con.close()


def test_calendar_refresh_fetches_before_taking_the_write_lock(monkeypatch):
    # The NASDAQ calls ran inside the write transaction: 14 slow requests
    # could hold the lock past the busy timeout of sync_account / manual trades.
    locked = []

    def fake_day(day):
        locked.append(_db_write_locked())
        return [{"ticker": ["AAPL", "MSFT", "NVDA", "JPM"][day.day % 4], "report_date": day,
                 "time_of_day": "amc", "eps_estimate": 1.0}]
    monkeypatch.setattr(earnings, "_nasdaq_calendar_for", fake_day)
    assert earnings.refresh_calendar(days_ahead=5) == 5
    assert earnings.refresh_calendar(days_ahead=5) == 0
    assert locked and not any(locked)


def test_history_refresh_fetches_before_taking_the_write_lock(fake_yf, monkeypatch):
    locked = []
    real = earnings._yahoo_surprise_history

    def spy(t):
        locked.append(_db_write_locked())
        return real(t)
    monkeypatch.setattr(earnings, "_yahoo_surprise_history", spy)
    with SessionLocal.begin() as s:
        s.add(EarningsHistory(ticker="WMT", quarter="2026-07-31", surprise_pct=0.09, fetched_at=utcnow()))
    assert earnings.refresh_history_for(["WMT", "BRK.B", "SPY"]) == 5
    assert len(locked) == 3 and not any(locked)


def test_calendar_refresh_drops_rescheduled_report_dates(monkeypatch):
    today = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    with SessionLocal.begin() as s:
        s.add(EarningsCalendar(ticker="AAPL", report_date=today + timedelta(days=3)))   # moved
        s.add(EarningsCalendar(ticker="AAPL", report_date=today - timedelta(days=60)))  # history
        s.add(EarningsCalendar(ticker="MSFT", report_date=today + timedelta(days=2)))   # not re-listed
    new_date = today + timedelta(days=5)

    def fake_day(day):
        return ([{"ticker": "AAPL", "report_date": day, "time_of_day": "amc", "eps_estimate": 1.5}]
                if day == new_date else [])
    monkeypatch.setattr(earnings, "_nasdaq_calendar_for", fake_day)
    earnings.refresh_calendar()
    with SessionLocal() as s:
        rows = sorted((r.ticker, (r.report_date.replace(tzinfo=timezone.utc) - today).days)
                      for r in s.scalars(select(EarningsCalendar)).all())
    assert rows == [("AAPL", -60), ("AAPL", 5), ("MSFT", 2)]
    assert [e["ticker"] for e in earnings.upcoming(14)] == ["MSFT", "AAPL"]
