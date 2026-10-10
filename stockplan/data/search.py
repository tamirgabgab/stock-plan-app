"""Ticker <-> name dictionary: a built-in list (works offline) plus Yahoo Finance search.

``search(q)`` returns candidates for a free-text query (name, alias or symbol);
``lookup(ticker)`` returns the name of a symbol. Online results are cached in memory.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Optional

import requests

from ..config import FAVORITES

log = logging.getLogger(__name__)

YAHOO_SEARCH = "https://query2.finance.yahoo.com/v1/finance/search"
USER_AGENT = "Mozilla/5.0 (StockPlanApp)"
TIMEOUT = 4
CACHE_TTL = 6 * 3600

# (ticker, name, aliases...). Names are what the user sees; aliases help the search.
SYMBOLS: list[tuple] = [
    ("^GSPC", "S&P 500", "sp500", "s&p", "snp", "אס אנד פי", "סנופי"),
    ("^SP500TR", "S&P 500 Total Return", "sp500tr", "s&p total return", "אס אנד פי תשואה כוללת"),
    ("^NDX", "Nasdaq 100", "nasdaq100", "נאסדק 100"),
    ("^IXIC", "Nasdaq Composite", "nasdaq", "נאסדק"),
    ("^DJI", "Dow Jones Industrial", "dow", "דאו ג'ונס"),
    ("^RUT", "Russell 2000", "russell", "ראסל"),
    ("^VIX", "VIX Volatility Index", "vix"),
    ("^TA125.TA", "TA-125", "ta125", "תל אביב 125", "ת\"א 125"),
    ("^TA35.TA", "TA-35", "ta35", "תל אביב 35", "ת\"א 35"),
    ("^STOXX50E", "Euro Stoxx 50", "stoxx"),
    ("^N225", "Nikkei 225", "nikkei", "ניקיי"),
    ("^FTSE", "FTSE 100", "ftse"),
    ("^GDAXI", "DAX", "dax", "דאקס"),
    ("SPY", "SPDR S&P 500 ETF", "sp500 etf"),
    ("VOO", "Vanguard S&P 500 ETF"),
    ("IVV", "iShares Core S&P 500 ETF"),
    ("QQQ", "Invesco Nasdaq 100 ETF", "nasdaq etf"),
    ("VTI", "Vanguard Total US Market ETF", "total market"),
    ("VT", "Vanguard Total World ETF", "world"),
    ("VXUS", "Vanguard Total International ETF"),
    ("VEA", "Vanguard Developed Markets ETF"),
    ("VWO", "Vanguard Emerging Markets ETF", "emerging", "שווקים מתעוררים"),
    ("EEM", "iShares Emerging Markets ETF"),
    ("EFA", "iShares EAFE ETF"),
    ("ACWI", "iShares MSCI World ACWI ETF", "msci world", "world"),
    ("URTH", "iShares MSCI World ETF", "msci world"),
    ("IWM", "iShares Russell 2000 ETF"),
    ("DIA", "SPDR Dow Jones ETF"),
    ("SCHD", "Schwab US Dividend Equity ETF", "dividend"),
    ("VIG", "Vanguard Dividend Appreciation ETF", "dividend"),
    ("VNQ", "Vanguard Real Estate ETF", "reit", "נדל\"ן"),
    ("XLK", "Technology Select Sector ETF"),
    ("XLF", "Financial Select Sector ETF"),
    ("XLE", "Energy Select Sector ETF"),
    ("XLV", "Health Care Select Sector ETF"),
    ("SMH", "VanEck Semiconductor ETF", "semiconductors", "שבבים"),
    ("SOXX", "iShares Semiconductor ETF", "semiconductors"),
    ("ARKK", "ARK Innovation ETF"),
    ("TQQQ", "ProShares UltraPro QQQ (3x Nasdaq 100)", "3x nasdaq"),
    ("QLD", "ProShares Ultra QQQ (2x Nasdaq 100)", "2x nasdaq"),
    ("UPRO", "ProShares UltraPro S&P 500 (3x)", "3x sp500"),
    ("SSO", "ProShares Ultra S&P 500 (2x)", "2x sp500"),
    ("BND", "Vanguard Total Bond Market ETF", "bonds", "אג\"ח"),
    ("AGG", "iShares Core US Aggregate Bond ETF", "bonds", "אג\"ח"),
    ("TLT", "iShares 20+ Year Treasury ETF", "treasury", "אג\"ח ארוך"),
    ("IEF", "iShares 7-10 Year Treasury ETF", "treasury"),
    ("SHY", "iShares 1-3 Year Treasury ETF", "treasury"),
    ("BIL", "SPDR 1-3 Month T-Bill ETF", "cash", "מזומן"),
    ("GLD", "SPDR Gold Shares", "gold", "זהב"),
    ("IAU", "iShares Gold Trust", "gold", "זהב"),
    ("SLV", "iShares Silver Trust", "silver", "כסף"),
    ("USO", "United States Oil Fund", "oil", "נפט"),
    ("BTC-USD", "Bitcoin", "ביטקוין"),
    ("ETH-USD", "Ethereum", "את'ריום"),
    ("EIS", "iShares MSCI Israel ETF", "israel", "ישראל"),
    ("AAPL", "Apple", "אפל"),
    ("MSFT", "Microsoft", "מיקרוסופט"),
    ("GOOGL", "Alphabet (Google) class A", "google", "גוגל"),
    ("GOOG", "Alphabet (Google) class C", "google", "גוגל"),
    ("AMZN", "Amazon", "אמזון"),
    ("META", "Meta Platforms (Facebook)", "facebook", "פייסבוק", "מטא"),
    ("NVDA", "Nvidia", "אנבידיה"),
    ("TSLA", "Tesla", "טסלה"),
    ("NFLX", "Netflix", "נטפליקס"),
    ("PLTR", "Palantir", "פלנטיר"),
    ("CRM", "Salesforce"),
    ("ADBE", "Adobe", "אדובי"),
    ("ORCL", "Oracle", "אורקל"),
    ("AMD", "Advanced Micro Devices", "amd"),
    ("INTC", "Intel", "אינטל"),
    ("TSM", "Taiwan Semiconductor (TSMC)", "tsmc"),
    ("AVGO", "Broadcom"),
    ("ASML", "ASML Holding"),
    ("MU", "Micron Technology"),
    ("QCOM", "Qualcomm"),
    ("AMAT", "Applied Materials"),
    ("ARM", "Arm Holdings"),
    ("ESLT", "Elbit Systems", "אלביט"),
    ("TEVA", "Teva Pharmaceutical", "טבע"),
    ("NICE", "NICE", "נייס"),
    ("CHKP", "Check Point Software", "צ'ק פוינט"),
    ("NVMI", "Nova", "נובה"),
    ("CAMT", "Camtek", "קמטק"),
    ("TSEM", "Tower Semiconductor", "טאואר"),
    ("WIX", "Wix.com", "וויקס"),
    ("MNDY", "monday.com", "מאנדיי"),
    ("CYBR", "CyberArk", "סייברארק"),
    ("ICL", "ICL Group", "כיל"),
    ("V", "Visa", "ויזה"),
    ("MA", "Mastercard", "מאסטרקארד"),
    ("JPM", "JPMorgan Chase", "ג'יי פי מורגן"),
    ("GS", "Goldman Sachs", "גולדמן זאקס"),
    ("BRK-B", "Berkshire Hathaway class B", "berkshire", "buffett", "ברקשייר"),
    ("BLK", "BlackRock", "בלאקרוק"),
    ("BAC", "Bank of America"),
    ("LLY", "Eli Lilly", "אלי לילי"),
    ("NVO", "Novo Nordisk", "נובו נורדיסק"),
    ("JNJ", "Johnson & Johnson", "j&j"),
    ("UNH", "UnitedHealth Group"),
    ("PFE", "Pfizer", "פייזר"),
    ("WMT", "Walmart", "וולמארט"),
    ("COST", "Costco", "קוסטקו"),
    ("KO", "Coca-Cola", "קוקה קולה"),
    ("PEP", "PepsiCo", "פפסי"),
    ("MCD", "McDonald's", "מקדונלדס"),
    ("PG", "Procter & Gamble"),
    ("HD", "Home Depot"),
    ("NKE", "Nike", "נייקי"),
    ("DIS", "Walt Disney", "דיסני"),
    ("XOM", "Exxon Mobil", "אקסון"),
    ("CVX", "Chevron"),
    ("BA", "Boeing", "בואינג"),
    ("UBER", "Uber", "אובר"),
    ("SHOP", "Shopify"),
    ("BABA", "Alibaba", "עליבאבא"),
]

_BY_TICKER = {t: name for t, name, *_ in SYMBOLS}
for _group in FAVORITES.values():          # keep the favourites list in sync with the dictionary
    for _label, _ticker in _group:
        _BY_TICKER.setdefault(_ticker, _label.rsplit(" (", 1)[0])

_online_cache: dict[str, tuple[float, list]] = {}
_lock = threading.Lock()


def _norm(s: str) -> str:
    return " ".join(s.lower().replace("_", " ").split())


def _local(q: str, limit: int) -> list[dict]:
    q = _norm(q)
    if not q:
        return []
    scored = []
    for entry in SYMBOLS:
        ticker, name, *aliases = entry
        t, n = ticker.lower(), _norm(name)
        words = [n] + [_norm(a) for a in aliases]
        if t == q or t.lstrip("^") == q:
            score = 0
        elif t.startswith(q) or t.lstrip("^").startswith(q):
            score = 1
        elif any(w.startswith(q) for w in words):
            score = 2
        elif any(q in w for w in words) or q in t:
            score = 3
        else:
            continue
        scored.append((score, len(t), {"ticker": ticker, "name": name, "source": "builtin"}))
    scored.sort(key=lambda s: (s[0], s[1]))
    return [s[2] for s in scored[:limit]]


def _yahoo(q: str, limit: int) -> list[dict]:
    key = _norm(q)
    now = time.time()
    with _lock:
        hit = _online_cache.get(key)
        if hit and now - hit[0] < CACHE_TTL:
            return hit[1][:limit]
    try:
        r = requests.get(YAHOO_SEARCH, params={"q": q, "quotesCount": limit, "newsCount": 0, "listsCount": 0},
                         timeout=TIMEOUT, headers={"User-Agent": USER_AGENT})
        r.raise_for_status()
        quotes = r.json().get("quotes", [])
    except Exception as exc:                     # offline, blocked or changed API: degrade to the built-in list
        log.info("yahoo search failed for %r: %s", q, exc)
        quotes = []
    out = []
    for item in quotes:
        sym = item.get("symbol")
        name = item.get("longname") or item.get("shortname")
        if not sym or not name or item.get("quoteType") in ("OPTION", "FUTURE", "CURRENCY"):
            continue
        out.append({"ticker": sym, "name": name, "source": "yahoo",
                    "exchange": item.get("exchDisp") or item.get("exchange"), "type": item.get("quoteType")})
    with _lock:
        _online_cache[key] = (now, out)
    return out[:limit]


def search(q: str, limit: int = 8, online: bool = True) -> list[dict]:
    """Candidates for a name/alias/symbol query: built-in first, then Yahoo for the rest."""
    q = (q or "").strip()
    if len(q) < 1:
        return []
    out = _local(q, limit)
    if online and len(out) < limit and len(q) >= 2:
        seen = {o["ticker"].upper() for o in out}
        for item in _yahoo(q, limit):
            if item["ticker"].upper() not in seen:
                out.append(item)
                seen.add(item["ticker"].upper())
    return out[:limit]


def lookup(ticker: str, online: bool = True) -> Optional[str]:
    """Display name of a symbol, or None when unknown."""
    t = (ticker or "").strip().upper()
    if not t:
        return None
    if t in _BY_TICKER:
        return _BY_TICKER[t]
    if online:
        for item in _yahoo(t, 8):
            if item["ticker"].upper() == t:
                return item["name"]
    return None
