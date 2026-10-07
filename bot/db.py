"""SQLite persistence layer. Shared between bot and FastAPI dashboard service."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    event,
)
from loguru import logger
from sqlalchemy.orm import DeclarativeBase, Session, relationship, sessionmaker

from bot.config import ROOT, settings


def _engine_url() -> str:
    db_path = Path(settings.db_path)
    if not db_path.is_absolute():
        db_path = ROOT / db_path
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{db_path.as_posix()}"


# Three writers share this file (bot scheduler threads, the API, manual
# trades). pysqlite's default 5 s busy timeout turned ordinary contention —
# e.g. the earnings refresh holding one long write transaction — into
# "database is locked" failures, including on the Trade insert right after
# an order was already submitted to Alpaca. Wait up to 30 s instead.
SQLITE_BUSY_TIMEOUT_S = 30

engine = create_engine(_engine_url(), future=True, echo=False,
                       connect_args={"timeout": SQLITE_BUSY_TIMEOUT_S})
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, future=True)


@event.listens_for(engine, "connect")
def _sqlite_wal(dbapi_conn, _record) -> None:
    """WAL journal: readers (API, dashboard polling) no longer block the
    bot's writers and vice versa. Persistent in the file once set; the
    -wal/-shm side files are gitignored. Local disk only (data/), which WAL
    requires. Best-effort — if the switch can't happen right now (another
    connection mid-transaction) the DB keeps working in its current mode."""
    try:
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.close()
    except Exception as exc:  # pragma: no cover — depends on concurrent access
        logger.warning("could not enable SQLite WAL mode: {}", exc)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class NewsItem(Base):
    __tablename__ = "news_items"
    id = Column(Integer, primary_key=True)
    url_hash = Column(String(64), unique=True, index=True, nullable=False)
    url = Column(Text, nullable=False)
    title = Column(Text, nullable=False)
    summary = Column(Text, default="")
    source = Column(String(64), index=True, nullable=False)
    published_at = Column(DateTime(timezone=True), index=True, nullable=False)
    fetched_at = Column(DateTime(timezone=True), default=_utcnow, nullable=False)
    tickers = Column(JSON, default=list)  # list[str]
    vader_score = Column(Float)           # -1..+1
    finbert_label = Column(String(16))    # "positive" | "neutral" | "negative"
    finbert_score = Column(Float)         # label confidence
    article_text = Column(Text)           # full extracted body, when we scraped it
    article_fetched_at = Column(DateTime(timezone=True))  # null = not yet attempted
    article_status = Column(String(16))   # "ok" | "empty" | "blocked" | "error" | null


class Signal(Base):
    """A single discrete signal for a ticker (politician trade or 13F change)."""
    __tablename__ = "signals"
    id = Column(Integer, primary_key=True)
    ticker = Column(String(16), index=True, nullable=False)
    kind = Column(String(32), nullable=False)  # politician | investor
    source = Column(String(128), nullable=False)  # e.g. "Pelosi" or "Berkshire"
    direction = Column(String(8), nullable=False)  # buy | sell
    amount = Column(Float)  # dollar size if known
    as_of = Column(DateTime(timezone=True), index=True, nullable=False)
    ingested_at = Column(DateTime(timezone=True), default=_utcnow, nullable=False)
    meta = Column(JSON, default=dict)


class Decision(Base):
    """A buy/hold/sell decision the strategy produced on a given tick."""
    __tablename__ = "decisions"
    id = Column(Integer, primary_key=True)
    at = Column(DateTime(timezone=True), default=_utcnow, index=True, nullable=False)
    ticker = Column(String(16), index=True, nullable=False)
    action = Column(String(8), nullable=False)  # buy | sell | hold | add
    composite_score = Column(Float, nullable=False)
    score_breakdown = Column(JSON, default=dict)  # per-signal contributions
    reason = Column(Text, nullable=False)          # human readable "why"
    dry_run = Column(Boolean, default=True, nullable=False)
    trade_id = Column(Integer, ForeignKey("trades.id"), nullable=True)

    trade = relationship("Trade", back_populates="decisions")


class Trade(Base):
    """An executed (or simulated) order."""
    __tablename__ = "trades"
    id = Column(Integer, primary_key=True)
    ticker = Column(String(16), index=True, nullable=False)
    side = Column(String(4), nullable=False)  # buy | sell
    qty = Column(Float, nullable=False)
    price = Column(Float, nullable=False)
    notional = Column(Float, nullable=False)
    submitted_at = Column(DateTime(timezone=True), default=_utcnow, index=True,
                          nullable=False)
    filled_at = Column(DateTime(timezone=True))
    status = Column(String(16), default="submitted")  # submitted|filled|rejected|dry_run
    alpaca_order_id = Column(String(64))
    dry_run = Column(Boolean, default=True, nullable=False)

    decisions = relationship("Decision", back_populates="trade")


class PortfolioSnapshot(Base):
    """Snapshot of account value over time (for P&L vs SPY)."""
    __tablename__ = "portfolio_snapshots"
    id = Column(Integer, primary_key=True)
    at = Column(DateTime(timezone=True), default=_utcnow, index=True, nullable=False)
    equity = Column(Float, nullable=False)
    cash = Column(Float, nullable=False)
    buying_power = Column(Float, nullable=False)
    spy_close = Column(Float)  # for side-by-side comparison


class Position(Base):
    """Latest known position state (overwritten each tick)."""
    __tablename__ = "positions"
    ticker = Column(String(16), primary_key=True)
    qty = Column(Float, nullable=False)
    avg_cost = Column(Float, nullable=False)
    market_price = Column(Float, nullable=False)
    market_value = Column(Float, nullable=False)
    unrealized_pnl = Column(Float, nullable=False)
    peak_price = Column(Float, nullable=False)  # for trailing stops
    opened_at = Column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=_utcnow, nullable=False)
    # LLM-era: Alpaca order id of the open trailing-stop protecting this
    # position. We cancel this before placing a sell so the stop doesn't
    # double-fire against a market order racing it.
    stop_order_id = Column(String(64))
    # Synthetic trailing-stop trail (fractional, e.g. 0.07 = 7%). Set by
    # set_trailing_stop when Alpaca rejects a broker-side GTC stop on a
    # fractional position; the 5-min sync_account synthetic-stop engine
    # enforces it. NULL means the engine uses LLM_TRAILING_STOP_PCT.
    trail_pct = Column(Float)


class JobRun(Base):
    """Records each scheduled job run for observability."""
    __tablename__ = "job_runs"
    id = Column(Integer, primary_key=True)
    job_name = Column(String(64), index=True, nullable=False)
    started_at = Column(DateTime(timezone=True), default=_utcnow, nullable=False)
    finished_at = Column(DateTime(timezone=True))
    status = Column(String(16), default="running")  # running|ok|failed
    message = Column(Text, default="")


class PriceHistory(Base):
    """Rolling daily bars. ``close`` drives momentum and 52w-high
    calculations; open/high/low/volume (nullable — rows written before they
    were captured have only a close) feed the dashboard's candles and
    relative-volume reads. Volume is the data feed's (IEX on the free plan),
    so compare it only against the same ticker's own history."""
    __tablename__ = "price_history"
    id = Column(Integer, primary_key=True)
    ticker = Column(String(16), index=True, nullable=False)
    trade_date = Column(DateTime(timezone=True), index=True, nullable=False)
    close = Column(Float, nullable=False)
    open = Column(Float)
    high = Column(Float)
    low = Column(Float)
    volume = Column(Float)
    __table_args__ = (
        UniqueConstraint("ticker", "trade_date", name="uq_price_ticker_date"),
    )


class MacroSeries(Base):
    """Daily macro observations from FRED (Treasury yields, credit spreads,
    dollar, oil, VIX). One row per (series_id, obs_date); written by
    ``bot.signals.macro`` and read by the dashboard's rates monitor."""
    __tablename__ = "macro_series"
    id = Column(Integer, primary_key=True)
    series_id = Column(String(32), index=True, nullable=False)
    obs_date = Column(DateTime(timezone=True), index=True, nullable=False)
    value = Column(Float)
    __table_args__ = (
        UniqueConstraint("series_id", "obs_date", name="uq_macro_series_date"),
    )


class CompanyProfile(Base):
    """Cached company fundamentals/description (yfinance-sourced).

    Populated lazily by the API's ``/company/{ticker}`` endpoint with a
    30-day TTL — this is a read-through cache, not trading state. The
    dashboard's holdings dossier is the only consumer.
    """
    __tablename__ = "company_profiles"
    ticker = Column(String(16), primary_key=True)
    name = Column(Text)
    sector = Column(String(64))
    industry = Column(String(128))
    description = Column(Text)
    website = Column(Text)
    exchange = Column(String(32))
    country = Column(String(64))
    market_cap = Column(Float)
    employees = Column(Integer)
    fetched_at = Column(DateTime(timezone=True), default=_utcnow, nullable=False)


class LLMRun(Base):
    """One record per scheduled LLM routine invocation.

    Captures tokens, cost, which tools got called, and the final summary text
    so the dashboard can reconstruct *why* a routine did what it did without
    replaying the entire conversation. Budget enforcement sums ``usd_cost``
    over ``started_at >= today 00:00 UTC``.
    """
    __tablename__ = "llm_runs"
    id = Column(Integer, primary_key=True)
    # premarket | execute | midday | close | weekly_review
    routine = Column(String(32), index=True, nullable=False)
    started_at = Column(DateTime(timezone=True), default=_utcnow, index=True, nullable=False)
    finished_at = Column(DateTime(timezone=True))
    # running | ok | failed | budget_halt
    status = Column(String(16), default="running", nullable=False)
    model = Column(String(64), nullable=False)
    input_tokens = Column(Integer, default=0, nullable=False)
    output_tokens = Column(Integer, default=0, nullable=False)
    cache_read_tokens = Column(Integer, default=0, nullable=False)
    cache_write_tokens = Column(Integer, default=0, nullable=False)
    usd_cost = Column(Float, default=0.0, nullable=False)
    web_search_calls = Column(Integer, default=0, nullable=False)
    tool_calls = Column(Integer, default=0, nullable=False)
    tool_trace = Column(JSON, default=list)   # [{name, args_summary, ok, ms}]
    summary = Column(Text, default="")        # final assistant text, truncated
    error = Column(Text)


class MarketRegime(Base):
    """Daily macro snapshot the LLM consults to size + select trades.

    One row per UTC date. Computed once a day after price_refresh.
    """
    __tablename__ = "market_regime"
    id = Column(Integer, primary_key=True)
    as_of = Column(DateTime(timezone=True), index=True, nullable=False)
    vix = Column(Float)                    # spot VIX close
    vix_5d_change = Column(Float)          # absolute change vs 5 trading days ago
    spy_trend = Column(Float)              # SPY 50d MA / 200d MA - 1.0; >0 = uptrend
    t10y2y = Column(Float)                 # FRED 10Y - 2Y treasury spread
    breadth_pct = Column(Float)            # % of EQUITY_UNIVERSE above 50d MA
    regime_label = Column(String(16))      # "risk_on" | "neutral" | "risk_off"
    meta = Column(JSON, default=dict)      # diagnostics


class EarningsCalendar(Base):
    """Upcoming earnings dates. Refreshed daily; old rows retained for history."""
    __tablename__ = "earnings_calendar"
    id = Column(Integer, primary_key=True)
    ticker = Column(String(16), index=True, nullable=False)
    report_date = Column(DateTime(timezone=True), index=True, nullable=False)
    time_of_day = Column(String(8))        # "bmo" | "amc" | "tnt" | null
    eps_estimate = Column(Float)
    fetched_at = Column(DateTime(timezone=True), default=_utcnow, nullable=False)
    __table_args__ = (
        UniqueConstraint("ticker", "report_date", name="uq_earnings_cal_ticker_date"),
    )


class EarningsHistory(Base):
    """Prior-quarter EPS surprise history per ticker."""
    __tablename__ = "earnings_history"
    id = Column(Integer, primary_key=True)
    ticker = Column(String(16), index=True, nullable=False)
    quarter = Column(String(16), nullable=False)  # "2025-Q4" etc.
    eps_actual = Column(Float)
    eps_estimate = Column(Float)
    surprise_pct = Column(Float)
    fetched_at = Column(DateTime(timezone=True), default=_utcnow, nullable=False)
    __table_args__ = (
        UniqueConstraint("ticker", "quarter", name="uq_earnings_hist_ticker_q"),
    )


def _add_column(table: str, col: str, typ: str) -> None:
    """ALTER TABLE ADD COLUMN that tolerates losing a race: run_bot.bat
    starts the bot and the API back to back and both call init_db(), so the
    other process may add the column between our inspect and our ALTER."""
    from sqlalchemy import text
    from sqlalchemy.exc import OperationalError

    try:
        with engine.begin() as conn:
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {typ}"))
    except OperationalError as exc:
        if "duplicate column name" not in str(exc).lower():
            raise


def _migrate_sqlite() -> None:
    """Tiny migration helper: add new columns to existing tables without
    re-creating them. SQLite is permissive about ALTER TABLE ADD COLUMN.

    New LLM-era tables come in via ``Base.metadata.create_all`` — this helper
    only exists for in-place additions to already-populated tables.
    """
    from sqlalchemy import inspect
    insp = inspect(engine)
    tables = set(insp.get_table_names())

    additions: dict[str, list[tuple[str, str]]] = {
        "news_items": [
            ("article_text", "TEXT"),
            ("article_fetched_at", "DATETIME"),
            ("article_status", "VARCHAR(16)"),
        ],
        "price_history": [("open", "FLOAT"), ("high", "FLOAT"), ("low", "FLOAT"), ("volume", "FLOAT")],
        "positions": [("stop_order_id", "VARCHAR(64)"), ("trail_pct", "FLOAT")],
    }
    for table, cols in additions.items():
        if table not in tables:
            continue
        existing = {c["name"] for c in insp.get_columns(table)}
        for col, typ in cols:
            if col not in existing:
                _add_column(table, col, typ)


def init_db() -> None:
    from sqlalchemy.exc import OperationalError

    # create_all checks-then-creates per table; when the bot and the API boot
    # together, the other process can create a table in between. A second
    # pass sees it and moves on.
    for attempt in range(3):
        try:
            Base.metadata.create_all(engine)
            break
        except OperationalError as exc:
            if "already exists" not in str(exc).lower() or attempt == 2:
                raise
    _migrate_sqlite()


def session_scope() -> Iterator[Session]:
    """Context-managed session."""
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
