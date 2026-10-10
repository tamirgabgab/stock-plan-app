from __future__ import annotations

import os

from .base import DataError, MarketData
from .demo import DemoMarketData
from .yahoo import YahooMarketData

_provider: MarketData | None = None


def get_market_data() -> MarketData:
    """Process-wide provider. ``STOCKPLAN_DEMO=1`` selects synthetic data."""
    global _provider
    if _provider is None:
        demo = os.environ.get("STOCKPLAN_DEMO", "").lower() in ("1", "true", "yes")
        _provider = DemoMarketData() if demo else YahooMarketData()
    return _provider


__all__ = ["DataError", "MarketData", "DemoMarketData", "YahooMarketData", "get_market_data"]
