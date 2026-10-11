"""Real market data: Yahoo Finance prices, Bank of Israel / FRED FX, FRED / CBS CPI.

Everything is cached on disk, as Parquet when pyarrow is installed and as pickle otherwise
(the hosted build leaves pyarrow out to stay within the platform's size limit). Prices are refreshed incrementally: only the
last few days are downloaded and chained onto the stored total-return index, so after
the first run a refresh costs one tiny request per ticker.

A CSV placed in ``data_cache/manual/`` (``fx_usd_ils.csv``, ``cpi_us.csv``, ``cpi_il.csv``,
columns ``date,value``) overrides the online source, for offline use or corrections.
"""
from __future__ import annotations

import io
import logging
import threading
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Callable, Optional

import pandas as pd
import requests

from ..config import CACHE_DIR, CACHE_TTL_HOURS
from .base import DataError, normalize_daily, normalize_monthly

log = logging.getLogger(__name__)

HTTP_TIMEOUT = (5, 20)   # connect, read (seconds)
FAIL_TTL = 3600          # a source that failed is skipped for this long (seconds)
USER_AGENT = "Mozilla/5.0 (stock-plan-app)"

BOI_USD_ILS_URL = (
    "https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/"
    "BOI.STATISTICS/EXR/1.0/RER_USD_ILS?format=csv"
)
FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}"
CBS_CPI_URL = (
    "https://api.cbs.gov.il/index/data/price?id=120010&format=json&download=false"
    "&startPeriod=01-1951&endPeriod=12-2100&lang=en&PageSize=1000"
)


def _safe_name(ticker: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in ticker.upper())


try:
    import pyarrow  # noqa: F401
    CACHE_EXT = ".parquet"
except ImportError:
    CACHE_EXT = ".pkl"


def _read_cache(p: Path) -> pd.Series:
    return pd.read_parquet(p)["value"] if p.suffix == ".parquet" else pd.read_pickle(p)


def _write_cache(series: pd.Series, p: Path) -> None:
    if CACHE_EXT == ".parquet":
        series.rename("value").to_frame().to_parquet(p)
    else:
        series.rename("value").to_pickle(p)


class _Skipped(Exception):
    """A source is skipped because it failed a moment ago."""


class _DiskCache:
    def __init__(self, root: Path):
        self.root = root
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def lock(self, key: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(key, threading.Lock())

    def path(self, kind: str, name: str) -> Path:
        return self.root / kind / f"{name}{CACHE_EXT}"

    def load(self, kind: str, name: str) -> tuple[Optional[pd.Series], float]:
        """Return (series, age_hours). age is ``inf`` when nothing is cached."""
        p = self.path(kind, name)
        if not p.exists():
            return None, float("inf")
        try:
            s = _read_cache(p)
        except Exception:  # corrupt file: refetch
            log.warning("ignoring unreadable cache file %s", p)
            return None, float("inf")
        return s, (time.time() - p.stat().st_mtime) / 3600

    def save(self, kind: str, name: str, series: pd.Series) -> None:
        p = self.path(kind, name)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        _write_cache(series, tmp)
        tmp.replace(p)


def _manual_override(name: str) -> Optional[pd.Series]:
    p = CACHE_DIR / "manual" / f"{name}.csv"
    if not p.exists():
        return None
    df = pd.read_csv(p)
    return pd.Series(df.iloc[:, 1].astype(float).values, index=pd.to_datetime(df.iloc[:, 0]))


def _http_get(url: str) -> requests.Response:
    resp = requests.get(url, timeout=HTTP_TIMEOUT, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    return resp


def _fred_series(series_id: str) -> pd.Series:
    df = pd.read_csv(io.StringIO(_http_get(FRED_CSV_URL.format(series=series_id)).text))
    # Column names changed over time ("DATE" vs "observation_date"); use positions.
    values = pd.to_numeric(df.iloc[:, 1], errors="coerce")
    return pd.Series(values.values, index=pd.to_datetime(df.iloc[:, 0])).dropna()


_yf = None


def _yfinance():
    # Imported lazily: slow import, not needed in demo mode. Its own small cache goes next to
    # ours, which also keeps it writable on hosts where only /tmp is.
    global _yf
    if _yf is None:
        import yfinance as yf
        try:
            (CACHE_DIR / "yfinance").mkdir(parents=True, exist_ok=True)
            yf.set_tz_cache_location(str(CACHE_DIR / "yfinance"))
        except Exception as exc:  # noqa: BLE001 - yfinance works without its cache
            log.warning("yfinance cache location not set: %s", exc)
        _yf = yf
    return _yf


class YahooMarketData:
    is_demo = False

    def __init__(self, cache_root: Path = CACHE_DIR, ttl_hours: float = CACHE_TTL_HOURS):
        self.cache = _DiskCache(cache_root)
        self.ttl_hours = ttl_hours
        self._memo: dict[tuple[str, str], pd.Series] = {}
        self._failed: dict[str, float] = {}     # source -> time it last failed
        self.sources: dict[str, dict] = {}      # source -> last attempt, for /api/status

    def _attempt(self, source: str, fetch: Callable[[], pd.Series], ttl: float = FAIL_TTL,
                 remember_data_errors: bool = True) -> pd.Series:
        """Run one download, timing it. A source that failed recently is skipped at once, so a
        blocked or hanging host costs one timeout per ``ttl`` instead of one per request."""
        failed_at = self._failed.get(source)
        if failed_at is not None and time.time() - failed_at < ttl:
            raise _Skipped(f"skipped, failed {int(time.time() - failed_at)}s ago")
        t0 = time.time()
        try:
            s = fetch()
            if s is None or len(s) == 0:
                raise DataError("empty response")
        except Exception as exc:
            if remember_data_errors or not isinstance(exc, DataError):
                self._failed[source] = time.time()
            self.sources[source] = {"ok": False, "seconds": round(time.time() - t0, 2),
                                    "error": str(exc)[:300], "at": time.time()}
            raise
        self._failed.pop(source, None)
        self.sources[source] = {"ok": True, "seconds": round(time.time() - t0, 2),
                                "rows": len(s), "at": time.time()}
        return s

    # ------------------------------------------------------------------ prices
    def prices(self, ticker: str) -> pd.Series:
        ticker = ticker.strip().upper()
        if not ticker:
            raise DataError("טיקר ריק")
        key = ("prices", _safe_name(ticker))
        with self.cache.lock("prices/" + key[1]):
            cached, age = self.cache.load(*key)
            if cached is not None and age < self.ttl_hours:
                return self._memo_get(key, cached)
            try:
                # An unknown ticker (DataError) is not remembered: it fails fast anyway.
                fresh = self._attempt(f"Yahoo {ticker}", lambda: self._refresh_prices(ticker, cached),
                                      ttl=600, remember_data_errors=False)
            except DataError:
                raise
            except Exception as exc:  # network errors etc.
                if cached is not None:
                    log.warning("refresh of %s failed (%s); using cached data", ticker, exc)
                    return self._memo_get(key, cached)
                raise DataError(f"לא ניתן להוריד נתונים עבור {ticker}: {exc}") from exc
            self.cache.save(*key, fresh)
            self._memo[key] = fresh
            return fresh

    def _memo_get(self, key: tuple[str, str], series: pd.Series) -> pd.Series:
        return self._memo.setdefault(key, series)

    def _download(self, ticker: str, start: Optional[date] = None) -> pd.Series:
        yf = _yfinance()
        t = yf.Ticker(ticker)
        if start is None:
            hist = t.history(period="max", interval="1d", auto_adjust=True)
        else:
            hist = t.history(start=start.isoformat(), interval="1d", auto_adjust=True)
        if hist is None or hist.empty or "Close" not in hist:
            return pd.Series(dtype=float)
        s = normalize_daily(hist["Close"])
        # Drop today's bar: during the trading session it is an intraday quote.
        today = pd.Timestamp(date.today())
        return s[s.index < today]

    def reachable(self) -> bool:
        """True when Yahoo answers: a few days of SPY download. Used to fall back to demo data."""
        try:
            self._attempt("Yahoo probe (SPY)",
                          lambda: self._download("SPY", start=date.today() - timedelta(days=10)))
            return True
        except Exception as exc:  # noqa: BLE001 - any failure means "not reachable"
            log.warning("Yahoo Finance is not reachable: %s", exc)
            return False

    def _refresh_prices(self, ticker: str, cached: Optional[pd.Series]) -> pd.Series:
        if cached is not None and len(cached) > 10:
            recent = self._download(ticker, start=(cached.index[-1] - timedelta(days=14)).date())
            common = cached.index.intersection(recent.index)
            if len(common):
                anchor = common[-1]
                # Auto-adjusted prices are rescaled whenever a dividend is paid, so chain the
                # new window onto the stored total-return index instead of overwriting it.
                scaled = recent * (cached[anchor] / recent[anchor])
                return pd.concat([cached, scaled[scaled.index > cached.index[-1]]])
        full = self._download(ticker)
        if full.empty:
            raise DataError(f"לא נמצאו נתונים עבור הטיקר {ticker} ב-Yahoo Finance")
        return full

    # ---------------------------------------------------------------- FX & CPI
    def _cached_macro(self, name: str, fetchers: list[tuple[str, Callable[[], pd.Series]]],
                      monthly: bool) -> pd.Series:
        key = ("macro", name)
        if key in self._memo:
            return self._memo[key]
        manual = _manual_override(name)
        if manual is not None:
            s = normalize_monthly(manual) if monthly else normalize_daily(manual)
            self._memo[key] = s
            return s
        with self.cache.lock("macro/" + name):
            cached, age = self.cache.load(*key)
            if cached is not None and age < 24:
                self._memo[key] = cached
                return cached
            errors = []
            for label, fetch in fetchers:
                try:
                    s = self._attempt(f"{label} ({name})", fetch)
                    s = normalize_monthly(s) if monthly else normalize_daily(s)
                    if len(s) > 12:
                        self.cache.save(*key, s)
                        self._memo[key] = s
                        return s
                    errors.append(f"{label}: empty")
                except Exception as exc:
                    errors.append(f"{label}: {exc}")
            if cached is not None:
                log.warning("refresh of %s failed (%s); using cached data", name, errors)
                self._memo[key] = cached
                return cached
        raise DataError(
            f"לא ניתן להוריד את הסדרה {name} ({'; '.join(errors)}). "
            f"אפשר לשים קובץ data_cache/manual/{name}.csv עם העמודות date,value"
        )

    def fx_usd_ils(self) -> pd.Series:
        def boi() -> pd.Series:
            df = pd.read_csv(io.StringIO(_http_get(BOI_USD_ILS_URL).text))
            return pd.Series(pd.to_numeric(df["OBS_VALUE"], errors="coerce").values,
                             index=pd.to_datetime(df["TIME_PERIOD"]))

        def yahoo() -> pd.Series:
            return self._download("ILS=X")

        daily = self._cached_macro("fx_usd_ils_daily", [("Bank of Israel", boi), ("Yahoo", yahoo)],
                                   monthly=False)
        # Extend history backwards with FRED's monthly average when the daily source is short.
        try:
            monthly = self._cached_macro("fx_usd_ils_monthly",
                                         [("FRED", lambda: _fred_series("CCUSMA02ILM618N"))],
                                         monthly=True)
        except DataError:
            return daily
        older = monthly[monthly.index < daily.index[0]]
        return pd.concat([older, daily]) if len(older) else daily

    def cpi(self, country: str) -> pd.Series:
        if country == "US":
            return self._cached_macro("cpi_us", [("FRED", lambda: _fred_series("CPIAUCSL"))],
                                      monthly=True)
        if country == "IL":
            return self._cached_macro("cpi_il", [("CBS", _cbs_cpi),
                                                 ("FRED", lambda: _fred_series("ISRCPIALLMINMEI"))],
                                      monthly=True)
        raise ValueError(country)


def _cbs_cpi() -> pd.Series:
    """Israeli CPI (general index, code 120010) from the Central Bureau of Statistics API.

    The index is re-based every few years, so it is rebuilt by chaining the monthly
    percentage changes when they are available.
    """
    rows: list[tuple[pd.Timestamp, Optional[float], Optional[float]]] = []
    url: Optional[str] = CBS_CPI_URL
    pages = 0
    while url and pages < 50:
        payload = _http_get(url).json()
        pages += 1
        stack = [payload]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                if "year" in node and "month" in node:
                    value = node.get("value")
                    if isinstance(node.get("currBase"), dict):
                        value = node["currBase"].get("value", value)
                    rows.append((pd.Timestamp(int(node["year"]), int(node["month"]), 1),
                                 _to_float(value), _to_float(node.get("percent"))))
                else:
                    stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)
        paging = payload.get("paging", {}) if isinstance(payload, dict) else {}
        url = paging.get("next_url") or None
    if not rows:
        raise DataError("CBS returned no CPI rows")
    df = pd.DataFrame(rows, columns=["date", "value", "percent"]).drop_duplicates("date")
    df = df.sort_values("date").set_index("date")
    if df["percent"].notna().all():
        return 100 * (1 + df["percent"] / 100).cumprod()
    return df["value"].dropna()


def _to_float(x) -> Optional[float]:
    try:
        return float(x)
    except (TypeError, ValueError):
        return None
