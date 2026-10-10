"""Market data interface shared by the real (Yahoo) and demo providers."""
from __future__ import annotations

from typing import Protocol

import pandas as pd


class DataError(Exception):
    """Raised when market data cannot be obtained. The message is shown to the user."""


class MarketData(Protocol):
    is_demo: bool

    def prices(self, ticker: str) -> pd.Series:
        """Daily total-return index in USD, indexed by trading day (tz-naive, normalised)."""

    def fx_usd_ils(self) -> pd.Series:
        """Daily ILS per 1 USD, indexed by date."""

    def cpi(self, country: str) -> pd.Series:
        """Monthly consumer price index for ``"US"`` or ``"IL"``, indexed by month start."""


def normalize_daily(series: pd.Series) -> pd.Series:
    """Return a float series with a sorted, unique, tz-naive midnight DatetimeIndex."""
    s = series.dropna().astype(float)
    idx = pd.DatetimeIndex(s.index)
    if idx.tz is not None:
        idx = idx.tz_localize(None)
    s.index = idx.normalize()
    s = s[~s.index.duplicated(keep="last")].sort_index()
    return s[s > 0]


def normalize_monthly(series: pd.Series) -> pd.Series:
    """Return a monthly series indexed by month start (one value per month)."""
    s = normalize_daily(series)
    s.index = s.index.to_period("M").to_timestamp()
    return s[~s.index.duplicated(keep="last")]
