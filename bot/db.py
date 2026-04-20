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
)
from sqlalchemy.orm import DeclarativeBase, Session, relationship, sessionmaker

from bot.config import ROOT, settings


def _engine_url() -> str:
    db_path = Path(settings.db_path)
    if not db_path.is_absolute():
        db_path = ROOT / db_path
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{db_path.as_posix()}"


engine = create_engine(_engine_url(), future=True, echo=False)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, future=True)


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
    """Rolling daily closes used for momentum and 52w-high calculations."""
    __tablename__ = "price_history"
    id = Column(Integer, primary_key=True)
    ticker = Column(String(16), index=True, nullable=False)
    trade_date = Column(DateTime(timezone=True), index=True, nullable=False)
    close = Column(Float, nullable=False)
    __table_args__ = (
        UniqueConstraint("ticker", "trade_date", name="uq_price_ticker_date"),
    )


def init_db() -> None:
    Base.metadata.create_all(engine)


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
