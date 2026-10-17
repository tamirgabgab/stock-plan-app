from __future__ import annotations

import os

from ..config import ON_VERCEL
from .base import DataError, MarketData
from .demo import DemoMarketData
from .yahoo import YahooMarketData

_provider: MarketData | None = None
_demo_reason: str | None = None     # "requested" (--demo) or "fallback" (Yahoo unreachable)


def _flag(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    return default if v is None else v.lower() in ("1", "true", "yes")


def get_market_data() -> MarketData:
    """Process-wide provider. ``STOCKPLAN_DEMO=1`` selects synthetic data.

    With ``STOCKPLAN_DEMO_FALLBACK=1`` (the default on the hosted build) Yahoo is probed once
    and the app switches to demo data when it does not answer, e.g. from a blocked cloud IP.
    """
    global _provider, _demo_reason
    if _provider is None:
        if _flag("STOCKPLAN_DEMO"):
            _provider, _demo_reason = DemoMarketData(), "requested"
        else:
            yahoo = YahooMarketData()
            if _flag("STOCKPLAN_DEMO_FALLBACK", ON_VERCEL) and not yahoo.reachable():
                _provider, _demo_reason = DemoMarketData(), "fallback"
            else:
                _provider = yahoo
    return _provider


def demo_reason() -> str | None:
    get_market_data()
    return _demo_reason


__all__ = ["DataError", "MarketData", "DemoMarketData", "YahooMarketData", "demo_reason", "get_market_data"]
