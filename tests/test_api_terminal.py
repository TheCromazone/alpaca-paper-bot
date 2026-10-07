"""The /terminal/* read models must never 500 — on an empty database (a
fresh install, before the first price refresh) or with real data — and must
keep the shapes the dashboard depends on."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from bot.db import MarketRegime, NewsItem, PortfolioSnapshot, Position, PriceHistory, SessionLocal

ENDPOINTS = [
    "/terminal/universe",
    "/terminal/monitor",
    "/terminal/heatmap",
    "/terminal/risk",
    "/terminal/brief",
    "/terminal/wire",
    "/terminal/regime/history",
]


@pytest.fixture
def client(monkeypatch):
    import api.terminal as term
    from api.main import app

    monkeypatch.setattr(term, "_yf_news", lambda t: [])  # never hit Yahoo in tests
    return TestClient(app)


@pytest.mark.parametrize("path", ENDPOINTS)
def test_terminal_endpoints_survive_an_empty_database(client, path):
    assert client.get(path).status_code == 200


def test_security_rejects_junk_and_unknown(client):
    assert client.get("/terminal/security/%3Cscript%3E").status_code == 400
    assert client.get("/terminal/security/ZZZZZ").status_code == 404


def _seed():
    now = datetime.now(timezone.utc)
    with SessionLocal.begin() as s:
        for i in range(260):
            d = (now - timedelta(days=260 - i)).replace(hour=0, minute=0, second=0, microsecond=0)
            for t, base in (("SPY", 500.0), ("AAPL", 200.0), ("GLD", 180.0)):
                c = base * (1 + 0.001 * i)
                s.add(PriceHistory(ticker=t, trade_date=d, close=c, open=c * 0.99, high=c * 1.01, low=c * 0.98, volume=1e6 + i))
        for i in range(30):
            s.add(PortfolioSnapshot(at=now - timedelta(days=30 - i), equity=50_000 + 50 * i, cash=20_000, buying_power=80_000, spy_close=500 + i))
        s.add(Position(ticker="AAPL", qty=10, avg_cost=230.0, market_price=200.0 * 1.259, market_value=10 * 251.8,
                       unrealized_pnl=218.0, peak_price=260.0))
        s.add(MarketRegime(as_of=now, vix=15.0, vix_5d_change=-1.0, spy_trend=0.05, t10y2y=0.5, breadth_pct=55.0, regime_label="risk_on"))
        s.add(NewsItem(url_hash="h1", url="https://x/1", title="Apple beats estimates", source="test",
                       published_at=now, tickers=["AAPL"], vader_score=0.8))
        s.add(NewsItem(url_hash="h2", url="https://x/2", title="Why you should rethink retirement", source="test",
                       published_at=now, tickers=[], vader_score=0.9))


def test_terminal_endpoints_with_data(client):
    _seed()
    for path in ENDPOINTS:
        assert client.get(path).status_code == 200, path
    mon = client.get("/terminal/monitor").json()
    gld = next(r for r in mon["rows"] if r["ticker"] == "GLD")
    assert gld["group"] == "Commodities" and gld["name"] == "Gold"
    assert gld["rel_volume"] is not None
    sec = client.get("/terminal/security/AAPL").json()
    assert sec["series"][-1]["o"] is not None and sec["series"][-1]["v"] is not None
    assert sec["position"]["qty"] == 10
    risk = client.get("/terminal/risk").json()
    # Effective N is measured on the invested book: one holding → 1 name.
    assert risk["effective_n"] == 1.0
    brief = client.get("/terminal/brief").json()
    assert brief["counts"]["breach"] + brief["counts"]["act"] + brief["counts"]["watch"] + brief["counts"]["info"] == len(brief["items"])


def test_wire_only_carries_ticker_tagged_headlines(client):
    _seed()
    texts = [e["text"] for e in client.get("/terminal/wire").json() if e["type"] == "news"]
    assert "Apple beats estimates" in texts
    assert "Why you should rethink retirement" not in texts


def test_positions_stop_uses_llm_trail_not_legacy_quant_pct(client, monkeypatch):
    import api.main as main_api

    _seed()
    monkeypatch.setattr(main_api, "_alpaca", lambda: (_ for _ in ()).throw(RuntimeError("offline")))
    row = next(p for p in client.get("/positions").json() if p["ticker"] == "AAPL")
    assert row["stop_price"] == pytest.approx(260.0 * 0.90)


def test_risk_keeps_equity_history_older_than_the_price_window(client):
    # price_history keeps ~260 bars; snapshots older than that must still
    # count (weekday rule), not silently shrink the window to one year.
    now = datetime.now(timezone.utc)
    with SessionLocal.begin() as s:
        for i in range(20):  # SPY bars only for the last 20 days
            d = (now - timedelta(days=20 - i)).replace(hour=0, minute=0, second=0, microsecond=0)
            s.add(PriceHistory(ticker="SPY", trade_date=d, close=500 + i))
        for i in range(400):  # equity snapshots for 400 days
            s.add(PortfolioSnapshot(at=now - timedelta(days=400 - i), equity=50_000 + i, cash=1, buying_power=1, spy_close=500))
    risk = client.get("/terminal/risk").json()
    assert risk["observations"] > 250


def test_curve_spreads_reconcile_with_the_displayed_legs(client):
    # FRED posts T10Y2Y a day ahead of the DGS legs; the monitor must show
    # 2s10s = 10Y − 2Y on the same date, not a newer, mismatched print.
    from bot.db import MacroSeries

    d1, d2, d3 = (datetime(2026, 10, d, tzinfo=timezone.utc) for d in (5, 6, 7))
    with SessionLocal.begin() as s:
        for sid, d, v in [("DGS10", d1, 5.31), ("DGS10", d2, 5.27), ("DGS2", d1, 4.84), ("DGS2", d2, 4.79),
                          ("T10Y2Y", d1, 0.47), ("T10Y2Y", d2, 0.48), ("T10Y2Y", d3, 0.51)]:
            s.add(MacroSeries(series_id=sid, obs_date=d, value=v))
    macro = {r["series_id"]: r for r in client.get("/terminal/monitor").json()["macro"]}
    assert macro["T10Y2Y"]["as_of"] == macro["DGS10"]["as_of"] == "2026-10-06"
    assert macro["T10Y2Y"]["last"] == pytest.approx(5.27 - 4.79)
    assert macro["T10Y2Y"]["chg_1d"] == pytest.approx((5.27 - 4.79) - (5.31 - 4.84))
