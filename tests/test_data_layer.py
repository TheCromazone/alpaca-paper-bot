"""Market-data layer behind the dashboard: full daily bars (OHLCV) for the
universe plus monitor-only instruments, FRED macro series, and company
profiles. All read-only reference data — these tests also pin that none of
it leaks into what the LLM may trade."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from sqlalchemy import select

from bot import main as bot_main
from bot.config import FULL_UNIVERSE, MONITOR_EXTRA, TICKER_NAMES
from bot.db import CompanyProfile, MacroSeries, PriceHistory, SessionLocal
from bot.signals import macro, profiles


class BarsAlpaca:
    """Answers daily_bars for any symbol; records which were requested."""

    def __init__(self) -> None:
        self.requested: list[str] = []

    def daily_bars(self, symbol: str, limit: int = 260):
        self.requested.append(symbol)
        d0 = datetime(2026, 10, 5, tzinfo=timezone.utc)
        return [
            (d0, 100.0, 102.0, 99.0, 101.0, 1_000_000.0),
            (d0 + timedelta(days=1), 101.0, 103.0, 100.5, 102.5, 1_250_000.0),
        ]


def test_price_refresh_stores_full_bars_for_universe_and_monitor_extras():
    fake = BarsAlpaca()
    bot_main._refresh_price_history(fake)
    assert set(fake.requested) >= set(FULL_UNIVERSE) | set(MONITOR_EXTRA)
    with SessionLocal() as s:
        row = s.scalars(
            select(PriceHistory).where(PriceHistory.ticker == "GLD").order_by(PriceHistory.trade_date.desc())
        ).first()
    assert row is not None
    assert (row.open, row.high, row.low, row.close, row.volume) == (101.0, 103.0, 100.5, 102.5, 1_250_000.0)


def test_price_refresh_replaces_rather_than_duplicates():
    fake = BarsAlpaca()
    bot_main._refresh_price_history(fake)
    bot_main._refresh_price_history(fake)
    with SessionLocal() as s:
        n = len(s.scalars(select(PriceHistory).where(PriceHistory.ticker == "SPY")).all())
    assert n == 2


def test_monitor_extras_are_never_tradable_or_news_tagged():
    # Monitor-only instruments must stay out of the LLM's tradable universe
    # (tools.py validates against FULL_UNIVERSE) and out of the news ticker
    # extractor's name map (else every "gold" headline gets tagged GLD).
    assert not set(MONITOR_EXTRA) & set(FULL_UNIVERSE)
    assert not set(MONITOR_EXTRA) & set(TICKER_NAMES)


def test_daily_bars_keeps_full_bar(monkeypatch):
    from bot.alpaca_client import AlpacaClient

    ts = datetime(2026, 10, 6, tzinfo=timezone.utc)
    bar = SimpleNamespace(timestamp=ts, open=10, high=11, low=9, close=10.5, volume=4200)
    client = AlpacaClient.__new__(AlpacaClient)
    client.data = SimpleNamespace(get_stock_bars=lambda req: SimpleNamespace(data={"XYZ": [bar]}))
    assert client.daily_bars("XYZ") == [(ts, 10.0, 11.0, 9.0, 10.5, 4200.0)]


def test_daily_bars_failure_returns_empty():
    from bot.alpaca_client import AlpacaClient

    def boom(req):
        raise RuntimeError("data API down")

    client = AlpacaClient.__new__(AlpacaClient)
    client.data = SimpleNamespace(get_stock_bars=boom)
    assert client.daily_bars("XYZ") == []


FRED_CSV = """observation_date,DGS10
2026-10-01,4.12
2026-10-02,.
2026-10-05,4.18
"""


def test_parse_fred_csv_handles_missing_values_and_header_spellings():
    rows = macro.parse_fred_csv(FRED_CSV)
    assert [(d.date().isoformat(), v) for d, v in rows] == [
        ("2026-10-01", 4.12), ("2026-10-02", None), ("2026-10-05", 4.18),
    ]
    assert macro.parse_fred_csv(FRED_CSV.replace("observation_date", "DATE")) == rows


def test_macro_store_upserts_by_series_and_date():
    rows = macro.parse_fred_csv(FRED_CSV)
    assert macro.store("DGS10", rows) == 3
    assert macro.store("DGS10", rows) == 0  # idempotent
    revised = [(d, (4.2 if v == 4.18 else v)) for d, v in rows]
    assert macro.store("DGS10", revised) == 1  # FRED revisions update in place
    with SessionLocal() as s:
        vals = sorted(r.value for r in s.scalars(select(MacroSeries)).all() if r.value is not None)
    assert vals == [4.12, 4.2]


def test_macro_refresh_survives_a_failing_series(monkeypatch):
    def fetch(sid, days=400):
        if sid == "DGS2":
            raise RuntimeError("FRED hiccup")
        return macro.parse_fred_csv(FRED_CSV)

    monkeypatch.setattr(macro, "fetch_series", fetch)
    res = macro.refresh_all()
    assert res["DGS2"] == -1
    assert res["DGS10"] == 3


def test_profiles_refresh_skips_fresh_rows_and_stores_market_cap(monkeypatch):
    seen: list[str] = []

    def fetch(t):
        seen.append(t)
        return {"name": f"{t} Inc", "sector": None, "industry": None, "description": None, "website": None,
                "exchange": None, "country": None, "market_cap": 1.5e12, "employees": 10}

    monkeypatch.setattr(profiles, "fetch_profile", fetch)
    assert profiles.refresh(["AAPL", "MSFT"], pause=0) == 2
    assert profiles.refresh(["AAPL", "MSFT"], pause=0) == 0  # fresh → skipped
    with SessionLocal() as s:
        p = s.get(CompanyProfile, "AAPL")
    assert p.market_cap == 1.5e12
    assert seen == ["AAPL", "MSFT"]


def test_new_jobs_are_scheduled_with_series_names():
    sched = bot_main.build_scheduler()
    ids = {j.id for j in sched.get_jobs()}
    assert {"macro", "profiles"} <= ids
    assert bot_main._JOB_RUN_NAMES["macro"] == ("macro_daily",)
    assert bot_main._JOB_RUN_NAMES["profiles"] == ("profiles_weekly",)


def test_migration_tolerates_a_concurrent_process_adding_the_column(monkeypatch):
    # Simulate losing the race: our inspect saw the column missing, but the
    # other process (bot vs API at boot) added it first.
    from sqlalchemy import inspect as sa_inspect

    from bot import db

    real_inspect = sa_inspect

    class StaleInspector:
        def __init__(self, eng):
            self._i = real_inspect(eng)

        def get_table_names(self):
            return self._i.get_table_names()

        def get_columns(self, table):
            cols = self._i.get_columns(table)
            return [c for c in cols if not (table == "price_history" and c["name"] == "low")]

    monkeypatch.setattr("sqlalchemy.inspect", StaleInspector)
    db._migrate_sqlite()  # must not raise "duplicate column name: low"


def test_init_db_retries_when_a_table_appears_mid_create(monkeypatch):
    from sqlalchemy.exc import OperationalError

    from bot import db

    calls = {"n": 0}
    real = db.Base.metadata.create_all

    def flaky(engine):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OperationalError("CREATE TABLE macro_series", {}, Exception("table macro_series already exists"))
        return real(engine)

    monkeypatch.setattr(db.Base.metadata, "create_all", flaky)
    db.init_db()
    assert calls["n"] == 2
