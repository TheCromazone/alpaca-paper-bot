"""Signal jobs feeding the LLM, and network-client hardening."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
import requests
from sqlalchemy import func, select

from bot.db import EarningsCalendar, EarningsHistory, SessionLocal, Signal
from bot.signals import earnings, politicians
from tests.conftest import utcnow


# ---------------------------------------------------------------------------
# Earnings
# ---------------------------------------------------------------------------


def test_history_refresh_handles_naive_sqlite_datetimes(monkeypatch):
    # SQLite returns naive datetimes; comparing with an aware cutoff raised
    # TypeError and failed the whole job once any history was cached.
    with SessionLocal.begin() as s:
        s.add(EarningsHistory(ticker="AAPL", quarter="2026Q1", surprise_pct=1.0,
                              fetched_at=utcnow() - timedelta(days=30)))
        s.add(EarningsHistory(ticker="MSFT", quarter="2026Q1", surprise_pct=1.0,
                              fetched_at=utcnow()))
    fetched = []

    def fake_history(t):
        fetched.append(t)
        return [{"quarter": "2026Q2", "eps_estimate": 1.0, "eps_actual": 1.1, "surprise_pct": 10.0}]
    monkeypatch.setattr(earnings, "_yahoo_surprise_history", fake_history)
    assert earnings.refresh_history_for(["AAPL", "MSFT"]) == 1
    assert fetched == ["AAPL"]            # MSFT is fresh, AAPL stale


def test_calendar_refresh_is_idempotent_across_runs(monkeypatch):
    target = (utcnow() + timedelta(days=3)).date()

    def fake_day(day):
        if day.date() == target:
            return [{"ticker": "AAPL", "report_date": day, "time_of_day": "amc", "eps_estimate": 1.5}]
        return []
    monkeypatch.setattr(earnings, "_nasdaq_calendar_for", fake_day)
    earnings.refresh_calendar()
    earnings.refresh_calendar()
    with SessionLocal() as s:
        rows = s.scalars(select(EarningsCalendar)).all()
    assert len(rows) == 1
    assert (rows[0].report_date.hour, rows[0].report_date.minute) == (0, 0)


def test_upcoming_dedupes_legacy_rows_and_includes_today():
    today = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    with SessionLocal.begin() as s:
        # Legacy duplicates of one event, stamped with refresh run times.
        s.add(EarningsCalendar(ticker="AAPL", report_date=today + timedelta(days=2, hours=22, seconds=1)))
        s.add(EarningsCalendar(ticker="AAPL", report_date=today + timedelta(days=2, hours=22, seconds=2)))
        s.add(EarningsCalendar(ticker="MSFT", report_date=today))     # reports today
    events = earnings.upcoming(days=7)
    assert sorted(e["ticker"] for e in events) == ["AAPL", "MSFT"]


# ---------------------------------------------------------------------------
# Politician disclosures
# ---------------------------------------------------------------------------


def test_house_filings_sorted_by_real_date():
    raw = ["9/30/2026", "10/1/2026", "7/9/2026", "7/15/2026", "garbage"]
    ordered = sorted(raw, key=politicians._filing_date_key, reverse=True)
    assert ordered == ["10/1/2026", "9/30/2026", "7/15/2026", "7/9/2026", "garbage"]


def _ptr(ticker, url, politician="Nancy Pelosi"):
    return politicians.PoliticianTrade(politician=politician, ticker=ticker, direction="buy",
                                       amount=8_000, traded_on=utcnow(), source_url=url)


def test_refiled_disclosures_are_not_reinserted():
    batch = [_ptr("NVDA", "u1"), _ptr("NVDA", "u1"), _ptr("AAPL", "u1")]
    assert politicians._persist_signals(batch, kind="politician") == 3   # in-batch dupes kept
    assert politicians._persist_signals(batch, kind="politician") == 0   # next day's re-read
    assert politicians._persist_signals([_ptr("NVDA", "u2")], kind="politician") == 1  # new filing
    with SessionLocal() as s:
        assert s.scalar(select(func.count()).select_from(Signal)) == 4


# ---------------------------------------------------------------------------
# Network hardening
# ---------------------------------------------------------------------------


def test_alpaca_sdk_requests_get_a_default_timeout(monkeypatch):
    seen = []

    def fake_request(self, method, url, **kwargs):
        seen.append(kwargs.get("timeout"))
        return SimpleNamespace()
    monkeypatch.setattr(requests.Session, "request", fake_request)
    from bot.alpaca_client import HTTP_TIMEOUT_S, AlpacaClient

    c = AlpacaClient()
    c.trading._session.request("GET", "https://paper-api.alpaca.markets/v2/clock")
    c.data._session.request("GET", "https://data.alpaca.markets/v2/x", timeout=5)
    assert seen == [HTTP_TIMEOUT_S, 5]


def test_timeout_patch_warns_when_sdk_internals_change():
    from loguru import logger

    from bot.alpaca_client import _install_default_timeout

    messages: list[str] = []
    hid = logger.add(lambda m: messages.append(str(m)), level="WARNING")
    try:
        _install_default_timeout(SimpleNamespace())      # no `_session` attribute
    finally:
        logger.remove(hid)
    assert any("timeout" in m.lower() for m in messages)


def _api_error(status: int, message: str):
    from alpaca.common.exceptions import APIError

    return APIError(f'{{"code": {status}00000, "message": "{message}"}}',
                    SimpleNamespace(response=SimpleNamespace(status_code=status)))


class _FakeTrading:
    """Stand-in for alpaca-py's TradingClient order endpoints.

    ``lookups`` scripts get_order_by_client_id: each entry is an exception
    to raise or "order" to return the submitted order (status ``status``).
    When the script runs out, an unknown id is a 404 and a known one returns.
    """

    def __init__(self, submit_exc=None, known=True, lookups=(), status="accepted"):
        self.submit_exc = submit_exc
        self.known = known
        self.lookups = list(lookups)
        self.status = status
        self.requests = []
        self.lookup_calls = 0

    def submit_order(self, req):
        self.requests.append(req)
        if self.submit_exc:
            raise self.submit_exc
        return SimpleNamespace(id=f"oid-{len(self.requests)}")

    def get_order_by_client_id(self, client_id):
        self.lookup_calls += 1
        assert any(r.client_order_id == client_id for r in self.requests)
        step = self.lookups.pop(0) if self.lookups else ("order" if self.known else _api_error(404, "order not found"))
        if isinstance(step, Exception):
            raise step
        return SimpleNamespace(id="recovered-oid", client_order_id=client_id,
                               status=SimpleNamespace(value=self.status))


def _client_with(trading):
    from bot.alpaca_client import AlpacaClient

    c = AlpacaClient()
    c.trading = trading
    return c


def test_every_submit_carries_a_unique_client_order_id():
    t = _FakeTrading()
    c = _client_with(t)
    c.submit_market("AAPL", 1.5, "buy")
    c.submit_trailing_stop("AAPL", 1.5, 0.10)
    c.submit_limit("AAPL", 1.0, "buy", 100.0)
    ids = [r.client_order_id for r in t.requests]
    assert all(ids) and len(set(ids)) == 3


@pytest.mark.parametrize("exc", [requests.exceptions.ReadTimeout("read timed out"),
                                 requests.exceptions.ConnectionError("connection aborted")])
def test_submit_recovers_order_accepted_before_a_lost_response(exc):
    c = _client_with(_FakeTrading(submit_exc=exc))
    assert c.submit_market("AAPL", 2, "buy") == "recovered-oid"


def test_submit_reraises_when_order_never_reached_alpaca():
    t = _FakeTrading(submit_exc=requests.exceptions.ReadTimeout("timed out"), known=False)
    with pytest.raises(requests.exceptions.ReadTimeout):
        _client_with(t).submit_market("AAPL", 2, "buy")
    assert t.lookup_calls >= 2                  # a single 404 isn't trusted


@pytest.mark.parametrize("first", [_api_error(404, "order not found"),   # eventual consistency
                                   _api_error(503, "service unavailable")])
def test_submit_recovery_retries_lookup_before_concluding(first):
    t = _FakeTrading(submit_exc=requests.exceptions.ReadTimeout("timed out"), lookups=[first, "order"])
    assert _client_with(t).submit_market("AAPL", 2, "buy") == "recovered-oid"


def test_submit_recovery_with_lookup_down_reports_unknown_not_absent():
    t = _FakeTrading(submit_exc=requests.exceptions.ReadTimeout("timed out"),
                     lookups=[_api_error(503, "unavailable")] * 10)
    with pytest.raises(RuntimeError, match="unknown"):
        _client_with(t).submit_market("AAPL", 2, "buy")


def test_duplicate_client_order_id_error_recovers_the_original():
    # alpaca-py re-POSTs the same body on a 504; if the first attempt landed,
    # the retry fails as a duplicate client_order_id.
    t = _FakeTrading(submit_exc=_api_error(422, "client_order_id must be unique"))
    assert _client_with(t).submit_market("AAPL", 2, "buy") == "recovered-oid"


def test_recovered_but_rejected_order_raises():
    t = _FakeTrading(submit_exc=requests.exceptions.ReadTimeout("timed out"), status="rejected")
    with pytest.raises(RuntimeError, match="rejected"):
        _client_with(t).submit_market("AAPL", 2, "buy")


def test_ordinary_api_rejection_is_not_looked_up():
    t = _FakeTrading(submit_exc=_api_error(403, "insufficient buying power"))
    with pytest.raises(Exception, match="insufficient buying power"):
        _client_with(t).submit_market("AAPL", 2, "buy")
    assert t.lookup_calls == 0


def test_open_orders_exposes_notional_and_fill(monkeypatch):
    from bot.alpaca_client import AlpacaClient

    c = AlpacaClient()
    order = SimpleNamespace(id="o1", symbol="AAPL", qty=None, notional="250.5", filled_qty="0",
                            side=SimpleNamespace(value="buy"), order_type=SimpleNamespace(value="market"),
                            status=SimpleNamespace(value="new"), submitted_at=None)
    monkeypatch.setattr(c.trading, "get_orders", lambda filter: [order])
    (o,) = c.open_orders()
    assert (o["qty"], o["notional"], o["side"], o["type"]) == (0.0, 250.5, "buy", "market")


def test_rss_fetch_uses_timeout_and_honours_server_cased_headers(monkeypatch):
    from requests.structures import CaseInsensitiveDict

    from bot.news import rss_scraper

    # No XML encoding declaration: the charset lives only in the HTTP header,
    # which servers send as "Content-Type". feedparser only reads lowercase
    # keys, so passing headers through unchanged made it ignore the header:
    # every feed was flagged bozo ("no Content-type specified") and decoded
    # with the ISO-8859-1 fallback (feedparser 6.0.14 happens to repair the
    # text afterwards, so the observable symptom is the bozo/encoding).
    rss = (
        '<rss version="2.0"><channel><title>t</title>'
        '<item><title>Apple\u2019s record quarter</title><link>https://ex.com/a</link></item>'
        '</channel></rss>'
    ).encode("utf-8")
    seen = {}

    def fake_get(url, headers=None, timeout=None):
        seen["timeout"] = timeout
        return SimpleNamespace(
            status_code=200, content=rss, url=url,
            headers=CaseInsensitiveDict({"Content-Type": "text/xml; charset=utf-8"}),
        )
    monkeypatch.setattr(rss_scraper.requests, "get", fake_get)
    parsed = rss_scraper._fetch_one_feed("https://ex.com/rss", "Test")
    assert seen["timeout"] == rss_scraper.FEED_TIMEOUT_S
    assert parsed.encoding == "utf-8" and not parsed.bozo, parsed.get("bozo_exception")
    assert [e.title for e in parsed.entries] == ["Apple\u2019s record quarter"]
