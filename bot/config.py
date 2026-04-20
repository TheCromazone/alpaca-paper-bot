"""Central configuration loaded from .env."""
from __future__ import annotations

from pathlib import Path
from typing import List

from dotenv import load_dotenv
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


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


settings = Settings()


# ---------- Strategy constants ----------
# A compact universe that still covers sectors + fixed income.
EQUITY_UNIVERSE: List[str] = [
    # Tech / comms
    "AAPL", "MSFT", "NVDA", "GOOGL", "META", "AMZN", "NFLX", "AVGO", "CRM", "ADBE",
    "ORCL", "AMD", "INTC", "CSCO", "QCOM", "TXN", "IBM",
    # Consumer
    "TSLA", "WMT", "HD", "NKE", "COST", "SBUX", "MCD", "PG", "KO", "PEP", "DIS",
    # Financials
    "JPM", "BAC", "WFC", "GS", "MS", "BRK.B", "V", "MA", "AXP", "BLK", "SCHW",
    # Healthcare
    "UNH", "JNJ", "LLY", "PFE", "MRK", "ABBV", "TMO", "ABT", "DHR",
    # Industrials / energy / materials
    "CAT", "BA", "GE", "HON", "UPS", "UNP", "XOM", "CVX", "COP",
    "LIN", "SHW",
    # Real estate / utilities
    "PLD", "AMT", "NEE", "DUK",
    # Broad market ETFs (for cash-ish exposure and hedges)
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
    **{t: "Tech" for t in ["AAPL", "MSFT", "NVDA", "GOOGL", "META", "AMZN", "NFLX",
                           "AVGO", "CRM", "ADBE", "ORCL", "AMD", "INTC", "CSCO",
                           "QCOM", "TXN", "IBM"]},
    **{t: "Consumer" for t in ["TSLA", "WMT", "HD", "NKE", "COST", "SBUX", "MCD",
                               "PG", "KO", "PEP", "DIS"]},
    **{t: "Financials" for t in ["JPM", "BAC", "WFC", "GS", "MS", "BRK.B", "V",
                                 "MA", "AXP", "BLK", "SCHW"]},
    **{t: "Healthcare" for t in ["UNH", "JNJ", "LLY", "PFE", "MRK", "ABBV", "TMO",
                                 "ABT", "DHR"]},
    **{t: "Industrials" for t in ["CAT", "BA", "GE", "HON", "UPS", "UNP"]},
    **{t: "Energy" for t in ["XOM", "CVX", "COP"]},
    **{t: "Materials" for t in ["LIN", "SHW"]},
    **{t: "RealEstate" for t in ["PLD", "AMT"]},
    **{t: "Utilities" for t in ["NEE", "DUK"]},
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
