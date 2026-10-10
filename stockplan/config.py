"""Static configuration: favourite assets, cache location, defaults."""
from __future__ import annotations

import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = Path(os.environ.get("STOCKPLAN_CACHE_DIR", ROOT_DIR / "data_cache"))

# Price data younger than this is considered fresh and is not re-fetched.
CACHE_TTL_HOURS = float(os.environ.get("STOCKPLAN_CACHE_TTL_HOURS", "12"))

# Favourites shown in the asset picker. Any other Yahoo ticker can be typed freely.
FAVORITES: dict[str, list[tuple[str, str]]] = {
    "מדדים ותעודות סל": [
        ("S&P 500 (^GSPC)", "^GSPC"),
        ("S&P 500 Total Return (^SP500TR)", "^SP500TR"),
        ("Nasdaq 100 (^NDX)", "^NDX"),
        ("Nasdaq Composite (^IXIC)", "^IXIC"),
        ("Dow Jones (^DJI)", "^DJI"),
        ("Russell 2000 (^RUT)", "^RUT"),
        ("S&P 500 ETF (SPY)", "SPY"),
        ("Nasdaq 100 ETF (QQQ)", "QQQ"),
        ("US Total Market (VTI)", "VTI"),
        ("Nasdaq 3x (TQQQ)", "TQQQ"),
        ("World (ACWI)", "ACWI"),
        ("Emerging Markets (VWO)", "VWO"),
    ],
    "טכנולוגיה": [
        ("Apple (AAPL)", "AAPL"), ("Microsoft (MSFT)", "MSFT"), ("Google (GOOGL)", "GOOGL"),
        ("Amazon (AMZN)", "AMZN"), ("Meta (META)", "META"), ("Nvidia (NVDA)", "NVDA"),
        ("Tesla (TSLA)", "TSLA"), ("Netflix (NFLX)", "NFLX"), ("Palantir (PLTR)", "PLTR"),
        ("Salesforce (CRM)", "CRM"), ("Adobe (ADBE)", "ADBE"), ("Oracle (ORCL)", "ORCL"),
    ],
    "שבבים": [
        ("AMD (AMD)", "AMD"), ("Intel (INTC)", "INTC"), ("TSMC (TSM)", "TSM"),
        ("Broadcom (AVGO)", "AVGO"), ("ASML (ASML)", "ASML"), ("Micron (MU)", "MU"),
        ("Qualcomm (QCOM)", "QCOM"), ("Applied Materials (AMAT)", "AMAT"),
    ],
    "ישראל (נסחרות בארה\"ב)": [
        ("Elbit (ESLT)", "ESLT"), ("Teva (TEVA)", "TEVA"), ("Nice (NICE)", "NICE"),
        ("Check Point (CHKP)", "CHKP"), ("Nova (NVMI)", "NVMI"), ("Camtek (CAMT)", "CAMT"),
        ("Tower (TSEM)", "TSEM"), ("Wix (WIX)", "WIX"), ("Monday (MNDY)", "MNDY"),
        ("CyberArk (CYBR)", "CYBR"), ("ICL (ICL)", "ICL"), ("Israel ETF (EIS)", "EIS"),
    ],
    "פיננסים": [
        ("Visa (V)", "V"), ("Mastercard (MA)", "MA"), ("JPMorgan (JPM)", "JPM"),
        ("Goldman Sachs (GS)", "GS"), ("Berkshire (BRK-B)", "BRK-B"), ("BlackRock (BLK)", "BLK"),
    ],
    "בריאות וצריכה": [
        ("Eli Lilly (LLY)", "LLY"), ("Novo Nordisk (NVO)", "NVO"), ("J&J (JNJ)", "JNJ"),
        ("UnitedHealth (UNH)", "UNH"), ("Walmart (WMT)", "WMT"), ("Costco (COST)", "COST"),
        ("Coca-Cola (KO)", "KO"), ("McDonald's (MCD)", "MCD"),
    ],
    "אג\"ח, סחורות וקריפטו": [
        ("Treasury 20Y+ (TLT)", "TLT"), ("Treasury 7-10Y (IEF)", "IEF"), ("Total Bond (BND)", "BND"),
        ("Gold (GLD)", "GLD"), ("Silver (SLV)", "SLV"), ("Bitcoin (BTC-USD)", "BTC-USD"),
        ("Ethereum (ETH-USD)", "ETH-USD"),
    ],
}

SUPPORTED_CURRENCIES = ("USD", "ILS")
