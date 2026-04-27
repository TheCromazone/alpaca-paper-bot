"""Central configuration loaded from .env."""
from __future__ import annotations

from pathlib import Path
from typing import List

from dotenv import load_dotenv
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent
# override=True so .env is the source of truth — without it, an empty var
# inherited from the launching shell (e.g. ANTHROPIC_API_KEY="" set at the
# OS level) would shadow the real value and silently break the LLM path.
load_dotenv(ROOT / ".env", override=True)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    alpaca_api_key: str = Field(..., alias="ALPACA_API_KEY")
    alpaca_api_secret: str = Field(..., alias="ALPACA_API_SECRET")
    alpaca_base_url: str = Field(
        "https://paper-api.alpaca.markets/v2", alias="ALPACA_BASE_URL"
    )
    dry_run: bool = Field(True, alias="DRY_RUN")
    db_path: str = Field("data/trading.db", alias="DB_PATH")
    log_level: str = Field("INFO", alias="LOG_LEVEL")
    sec_user_agent: str = Field(
        "alpaca-bot research contact@example.com", alias="SEC_USER_AGENT"
    )

    # ---------- LLM-era (Phase 1) ----------
    # Claude does the reasoning; web_search is a server-side tool baked into
    # the Messages API, so no separate search key is required.
    anthropic_api_key: str = Field("", alias="ANTHROPIC_API_KEY")
    llm_model: str = Field("claude-opus-4-7", alias="LLM_MODEL")
    llm_daily_usd_budget: float = Field(5.00, alias="LLM_DAILY_USD_BUDGET")
    # Feature flag — set to true only after Phase 5 cutover. Until then,
    # routine code can exist and be unit-tested without ever firing on cron.
    llm_routines_enabled: bool = Field(False, alias="LLM_ROUTINES_ENABLED")
    # Test-only: reschedule every routine to fire 30s apart at startup for
    # end-to-end smoke runs. Ignored in production (never committed as true).
    schedule_debug_fast: bool = Field(False, alias="SCHEDULE_DEBUG_FAST")


settings = Settings()


# ---------- Strategy constants ----------
# Expanded universe — 92 equities covering all 11 GICS sectors + broad-market
# ETFs, plus 8 bond ETFs for fixed-income exposure. 100 tickers total.
EQUITY_UNIVERSE: List[str] = [
    # Tech / comms (incl. semis, software, platforms)
    "AAPL", "MSFT", "NVDA", "GOOGL", "META", "AMZN", "NFLX", "AVGO", "CRM", "ADBE",
    "ORCL", "AMD", "INTC", "CSCO", "QCOM", "TXN", "IBM",
    "AMAT", "LRCX", "MU", "KLAC",                 # semiconductor-equipment + memory
    "NOW", "PANW", "CRWD", "SNOW", "UBER",        # modern software + platforms
    # Consumer (staples + discretionary + travel)
    "TSLA", "WMT", "HD", "NKE", "COST", "SBUX", "MCD", "PG", "KO", "PEP", "DIS",
    "LOW", "TGT", "BKNG",
    # Financials
    "JPM", "BAC", "WFC", "GS", "MS", "BRK.B", "V", "MA", "AXP", "BLK", "SCHW",
    "C", "PNC", "USB",
    # Healthcare
    "UNH", "JNJ", "LLY", "PFE", "MRK", "ABBV", "TMO", "ABT", "DHR",
    "BMY", "CI", "ELV",
    # Industrials (incl. defense)
    "CAT", "BA", "GE", "HON", "UPS", "UNP",
    "DE", "LMT", "RTX",
    # Energy
    "XOM", "CVX", "COP",
    "SLB",
    # Materials
    "LIN", "SHW",
    "APD",
    # Real estate (incl. data centers / towers)
    "PLD", "AMT",
    "EQIX",
    # Utilities
    "NEE", "DUK",
    "SO", "D",
    # Broad market ETFs
    "SPY", "QQQ", "DIA", "IWM", "VTI",
]

FIXED_INCOME_UNIVERSE: List[str] = [
    "AGG",  # US aggregate bond
    "BND",  # Total bond market
    "TLT",  # 20+ year treasuries
    "IEF",  # 7-10 year treasuries
    "SHY",  # 1-3 year treasuries
    "LQD",  # Investment-grade corporates
    "HYG",  # High yield corporates
    "TIP",  # TIPS
]

# Rough GICS-lite sector map for diversification guards.
SECTOR_MAP: dict[str, str] = {
    **{t: "Tech" for t in [
        "AAPL", "MSFT", "NVDA", "GOOGL", "META", "AMZN", "NFLX",
        "AVGO", "CRM", "ADBE", "ORCL", "AMD", "INTC", "CSCO",
        "QCOM", "TXN", "IBM",
        "AMAT", "LRCX", "MU", "KLAC",
        "NOW", "PANW", "CRWD", "SNOW", "UBER",
    ]},
    **{t: "Consumer" for t in [
        "TSLA", "WMT", "HD", "NKE", "COST", "SBUX", "MCD",
        "PG", "KO", "PEP", "DIS",
        "LOW", "TGT", "BKNG",
    ]},
    **{t: "Financials" for t in [
        "JPM", "BAC", "WFC", "GS", "MS", "BRK.B", "V",
        "MA", "AXP", "BLK", "SCHW",
        "C", "PNC", "USB",
    ]},
    **{t: "Healthcare" for t in [
        "UNH", "JNJ", "LLY", "PFE", "MRK", "ABBV", "TMO", "ABT", "DHR",
        "BMY", "CI", "ELV",
    ]},
    **{t: "Industrials" for t in ["CAT", "BA", "GE", "HON", "UPS", "UNP", "DE", "LMT", "RTX"]},
    **{t: "Energy" for t in ["XOM", "CVX", "COP", "SLB"]},
    **{t: "Materials" for t in ["LIN", "SHW", "APD"]},
    **{t: "RealEstate" for t in ["PLD", "AMT", "EQIX"]},
    **{t: "Utilities" for t in ["NEE", "DUK", "SO", "D"]},
    **{t: "BroadETF" for t in ["SPY", "QQQ", "DIA", "IWM", "VTI"]},
    **{t: "FixedIncome" for t in FIXED_INCOME_UNIVERSE},
}

FULL_UNIVERSE: List[str] = EQUITY_UNIVERSE + FIXED_INCOME_UNIVERSE

# Human-readable names used by the ticker extractor.
TICKER_NAMES: dict[str, List[str]] = {
    "AAPL": ["Apple"],
    "MSFT": ["Microsoft"],
    "NVDA": ["Nvidia", "NVIDIA"],
    "GOOGL": ["Alphabet", "Google"],
    "META": ["Meta", "Facebook"],
    "AMZN": ["Amazon"],
    "NFLX": ["Netflix"],
    "AVGO": ["Broadcom"],
    "CRM": ["Salesforce"],
    "ADBE": ["Adobe"],
    "ORCL": ["Oracle"],
    "AMD": ["AMD", "Advanced Micro Devices"],
    "INTC": ["Intel"],
    "CSCO": ["Cisco"],
    "QCOM": ["Qualcomm"],
    "TXN": ["Texas Instruments"],
    "IBM": ["IBM"],
    "TSLA": ["Tesla"],
    "WMT": ["Walmart"],
    "HD": ["Home Depot"],
    "NKE": ["Nike"],
    "COST": ["Costco"],
    "SBUX": ["Starbucks"],
    "MCD": ["McDonald's", "McDonalds"],
    "PG": ["Procter & Gamble", "Procter and Gamble"],
    "KO": ["Coca-Cola", "Coca Cola"],
    "PEP": ["PepsiCo", "Pepsi"],
    "DIS": ["Disney"],
    "JPM": ["JPMorgan", "JP Morgan"],
    "BAC": ["Bank of America"],
    "WFC": ["Wells Fargo"],
    "GS": ["Goldman Sachs"],
    "MS": ["Morgan Stanley"],
    "BRK.B": ["Berkshire Hathaway", "Berkshire"],
    "V": ["Visa"],
    "MA": ["Mastercard"],
    "AXP": ["American Express"],
    "BLK": ["BlackRock"],
    "SCHW": ["Charles Schwab", "Schwab"],
    "UNH": ["UnitedHealth"],
    "JNJ": ["Johnson & Johnson"],
    "LLY": ["Eli Lilly", "Lilly"],
    "PFE": ["Pfizer"],
    "MRK": ["Merck"],
    "ABBV": ["AbbVie"],
    "TMO": ["Thermo Fisher"],
    "ABT": ["Abbott"],
    "DHR": ["Danaher"],
    "CAT": ["Caterpillar"],
    "BA": ["Boeing"],
    "GE": ["General Electric"],
    "HON": ["Honeywell"],
    "UPS": ["UPS", "United Parcel"],
    "UNP": ["Union Pacific"],
    "XOM": ["ExxonMobil", "Exxon"],
    "CVX": ["Chevron"],
    "COP": ["ConocoPhillips"],
    "LIN": ["Linde"],
    "SHW": ["Sherwin-Williams"],
    "PLD": ["Prologis"],
    "AMT": ["American Tower"],
    "NEE": ["NextEra"],
    "DUK": ["Duke Energy"],
    "SPY": ["S&P 500", "SP 500", "SPY"],
    "QQQ": ["Nasdaq 100", "QQQ"],
    "DIA": ["Dow Jones", "DIA"],
    "IWM": ["Russell 2000", "IWM"],
    "VTI": ["Total Stock Market", "VTI"],
    "AGG": ["AGG"],
    "BND": ["BND"],
    "TLT": ["20 Year Treasury", "TLT"],
    "IEF": ["IEF"],
    "SHY": ["SHY"],
    "LQD": ["LQD"],
    "HYG": ["HYG"],
    "TIP": ["TIPS"],
    # Added in universe expansion
    "AMAT": ["Applied Materials"],
    "LRCX": ["Lam Research"],
    "MU": ["Micron"],
    "KLAC": ["KLA Corp", "KLA"],
    "NOW": ["ServiceNow"],
    "PANW": ["Palo Alto Networks", "Palo Alto"],
    "CRWD": ["CrowdStrike"],
    "SNOW": ["Snowflake"],
    "UBER": ["Uber"],
    "LOW": ["Lowe's", "Lowes"],
    "TGT": ["Target"],
    "BKNG": ["Booking", "Booking Holdings", "Booking.com"],
    "C": ["Citigroup", "Citi"],
    "PNC": ["PNC Financial", "PNC Bank"],
    "USB": ["U.S. Bancorp", "US Bancorp"],
    "BMY": ["Bristol-Myers", "Bristol Myers"],
    "CI": ["Cigna"],
    "ELV": ["Elevance", "Anthem"],
    "DE": ["Deere", "John Deere"],
    "LMT": ["Lockheed Martin", "Lockheed"],
    "RTX": ["RTX", "Raytheon"],
    "SLB": ["Schlumberger", "SLB"],
    "APD": ["Air Products"],
    "EQIX": ["Equinix"],
    "SO": ["Southern Company"],
    "D": ["Dominion Energy"],
}


# ---------- Portfolio / risk parameters ----------
MAX_POSITIONS = 30
MAX_POSITION_PCT = 0.05          # hard cap on any single position at entry
REBALANCE_TRIM_PCT = 0.08        # rebalance if a position grows past 8%
MAX_SECTOR_PCT = 0.25            # diversification cap per sector
FIXED_INCOME_FLOOR = 0.10        # minimum bond allocation
FIXED_INCOME_CEIL = 0.15         # target upper bound
CASH_RESERVE_PCT = 0.08          # keep ~8% cash to deploy on drawdowns
TRAILING_STOP_PCT = 0.07         # 7% trailing stop
DIP_ADD_DRAWDOWN = 0.25          # add to a winning thesis if it drops 25% from cost
DIP_ADD_BOOST = 0.50             # size of the add (as a fraction of current position)

# Composite score thresholds
OPEN_SCORE_THRESHOLD = 1.0
CLOSE_SCORE_THRESHOLD = -1.0


# ---------- LLM-era trading caps (Phase 1) ----------
# The tool layer enforces these — see bot/llm/tools.py. Keeping them here so
# memory/strategy.md's "caps you can't evade" list stays in sync with code.
LLM_MAX_POSITION_PCT = 0.05        # 5% of equity per new position at entry
LLM_MAX_POSITIONS = 15             # hard cap on concurrent holdings
LLM_TRAILING_STOP_PCT = 0.10       # 10% trailing stop attached to every buy
LLM_MIDDAY_STOP_LOSS_PCT = 0.07    # midday routine force-closes names down this much from avg cost
LLM_WASH_TRADE_LOOKBACK_DAYS = 3   # refuse opposite-side trade on same symbol within this window
LLM_TRAILING_STOP_MIN = 0.03       # set_trailing_stop refuses anything outside [MIN, MAX]
LLM_TRAILING_STOP_MAX = 0.25
LLM_MIN_THESIS_CHARS = 20          # every buy/sell requires a human-readable justification
LLM_MAX_TOOL_ITERATIONS = 20       # runner halts a routine after this many tool calls

# --- Lessons from week 1 of quant trading (2026-04-20 to 2026-04-24) ---
# - 579 trades / week on a $50k account = 20x portfolio turnover — way too
#   noisy. Cap fresh names per day so theses get time to play out.
# - Three tickers got 100% of action because of contradictory rules on AGG.
#   Bond ETFs are now opt-in via thesis only (no automatic floor).
# - 44% of orders were rejected by Alpaca's wash-trade detector. Pre-cancel
#   any open opposite-side order on the same symbol before submitting.
LLM_MAX_NEW_POSITIONS_PER_DAY = 2  # cap on fresh-ticker buys per day
LLM_MAX_TOOL_RESULT_NEWS = 8       # tool layer trims get_recent_news to this many items
LLM_MAX_TOOL_RESULT_SIGNALS = 10   # similarly for get_recent_signals

# Signal weights (see plan's composite_score formula)
WEIGHT_NEWS = 0.35
WEIGHT_POLITICIAN = 0.25
WEIGHT_INVESTOR = 0.20
WEIGHT_MOMENTUM = 0.15
WEIGHT_DIP_BONUS = 0.05

# Tracked 13F CIKs (zero-padded strings).
TRACKED_INVESTORS: dict[str, str] = {
    "Berkshire Hathaway": "0001067983",
    "Pershing Square": "0001336528",
    "Scion (Michael Burry)": "0001649339",
    "Bridgewater": "0001350694",
    "Renaissance Technologies": "0001037389",
    "ARK Investment": "0001697748",
    "Third Point": "0001040273",
    "Appaloosa": "0001656456",
    "Greenlight Capital": "0001079114",
    "Baupost Group": "0001061768",
}
