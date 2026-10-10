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
