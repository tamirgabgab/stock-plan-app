"""Synthetic market data for trying the UI offline and for tests.

Results computed on this data are NOT real market history. The UI shows a banner
whenever this provider is active.
"""
from __future__ import annotations

import zlib

import numpy as np
import pandas as pd

START = "1985-01-01"


def _rng(name: str) -> np.random.Generator:
    return np.random.default_rng(zlib.crc32(name.encode()))


class DemoMarketData:
    is_demo = True

    def __init__(self, end: str | None = None):
        end_ts = pd.Timestamp(end) if end else pd.Timestamp.today().normalize() - pd.Timedelta(days=1)
        self.days = pd.bdate_range(START, end_ts)

    def prices(self, ticker: str) -> pd.Series:
        rng = _rng(ticker.upper())
        mu = rng.uniform(0.05, 0.12) / 252
        sigma = rng.uniform(0.14, 0.35) / np.sqrt(252)
        # Assets "list" at different dates, like real tickers do.
        offset = int(rng.integers(0, 2500)) if ticker.upper() not in ("^GSPC", "SPY") else 0
        days = self.days[offset:]
        r = rng.normal(mu - sigma ** 2 / 2, sigma, len(days))
        return pd.Series(100 * np.exp(np.cumsum(r)), index=days)

    def fx_usd_ils(self) -> pd.Series:
        rng = _rng("USDILS")
        r = rng.normal(0, 0.006, len(self.days))
        level = 3.6 * np.exp(np.cumsum(r) - np.linspace(0, np.cumsum(r)[-1], len(r)))
        return pd.Series(level, index=self.days)

    def cpi(self, country: str) -> pd.Series:
        months = pd.date_range(START, self.days[-1], freq="MS")
        rng = _rng("CPI" + country)
        infl = (0.025 if country == "US" else 0.03) / 12
        r = rng.normal(infl, 0.002, len(months))
        return pd.Series(100 * np.exp(np.cumsum(r)), index=months)

    # ---- housing market (apartment vs. capital market tab)
    def _months(self, start: str) -> pd.DatetimeIndex:
        return pd.date_range(start, self.days[-1], freq="MS")

    def housing_index(self) -> pd.Series:
        months = self._months("1994-01-01")
        rng = _rng("HOUSING_IL")
        cycle = 0.004 * np.sin(np.arange(len(months)) / 40)
        r = rng.normal(0.05 / 12, 0.008, len(months)) + cycle
        return pd.Series(100 * np.exp(np.cumsum(r)), index=months)

    def rent_index(self) -> pd.Series:
        months = self._months("1990-01-01")
        rng = _rng("RENT_IL")
        r = rng.normal(0.035 / 12, 0.004, len(months))
        return pd.Series(100 * np.exp(np.cumsum(r)), index=months)

    def boi_rate(self) -> pd.Series:
        """Mean-reverting rate: from about 12% in 1994 towards 3.5%, never below 0.1%."""
        months = self._months("1994-01-01")
        rng = _rng("BOI_RATE")
        x = np.empty(len(months))
        x[0] = 12.0
        for i in range(1, len(x)):
            x[i] = x[i - 1] + 0.02 * (3.5 - x[i - 1]) + rng.normal(0, 0.25)
        return pd.Series(np.clip(x, 0.1, 18.0), index=months)
