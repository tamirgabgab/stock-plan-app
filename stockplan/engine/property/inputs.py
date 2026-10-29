"""Inputs of the apartment-vs-market model: tax tables, scenarios, the common settings.

Part of the ``property`` package; see its docstring for the model."""
from __future__ import annotations

from typing import Dict, List, Literal, Optional

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field


# ----------------------------------------------------------------------------- inputs

# Israeli purchase-tax brackets (frozen 16/01/2025 - 15/01/2028) and related ceilings.
# Users can edit them in the UI when the Tax Authority publishes new values.
PURCHASE_SINGLE = [(1_978_745, 0.0), (2_347_040, 3.5), (6_055_070, 5.0), (20_183_565, 8.0), (None, 10.0)]
PURCHASE_ADDITIONAL = [(6_055_070, 8.0), (None, 10.0)]
SHEVACH_SINGLE_CEILING = 4_848_000
RENT_EXEMPT_CEILING = 5_654
DEFAULT_HOLDINGS = [{"ticker": "^SP500TR", "weight": 100.0, "leverage": 1.0}]


class Bracket(BaseModel):
    up_to: Optional[float] = Field(None, ge=0)       # None = no upper limit
    rate: float = Field(ge=0, le=100)


def _brackets(rows):
    return [Bracket(up_to=u, rate=r) for u, r in rows]


class TaxTables(BaseModel):
    purchase_single: List[Bracket] = Field(default_factory=lambda: _brackets(PURCHASE_SINGLE), min_length=1)
    purchase_additional: List[Bracket] = Field(default_factory=lambda: _brackets(PURCHASE_ADDITIONAL), min_length=1)
    shevach_rate: float = Field(25.0, ge=0, le=100)
    shevach_single_ceiling: float = Field(SHEVACH_SINGLE_CEILING, ge=0)
    rent_exempt_ceiling: float = Field(RENT_EXEMPT_CEILING, ge=0)


class HoldingP(BaseModel):
    ticker: str = Field(min_length=1, max_length=20)
    weight: float = Field(ge=0)
    leverage: float = Field(1.0, ge=0, le=10)


class MarketParams(BaseModel):
    annual_return: float = Field(7.0, ge=-50, le=100)
    deposit_fee: float = Field(0.0, ge=0, le=20)
    annual_fee: float = Field(0.2, ge=0, le=20)
    tax_rate: float = Field(25.0, ge=0, lt=100)
    tax_basis: Literal["nominal", "real"] = "real"
    holdings: List[HoldingP] = Field(default_factory=lambda: [HoldingP(**h) for h in DEFAULT_HOLDINGS])
    volatility: float = Field(16.0, ge=0, le=100)    # synthetic mode: annual std of the log return


class RatePoint(BaseModel):
    year: float = Field(ge=0, le=60)                 # from this year (since the start) on
    rate: float = Field(ge=-5, le=50)


class Track(BaseModel):
    name: str = ""
    share: float = Field(ge=0, le=100)               # percent of the loan
    years: float = Field(gt=0, le=50)
    kind: Literal["fixed", "prime", "variable", "schedule"] = "fixed"
    rate: float = Field(0.0, ge=0, le=40)            # fixed rate (also the fallback of an empty schedule)
    margin: float = Field(0.0, ge=-10, le=20)        # prime: over prime; variable: over the BoI rate
    reset_years: float = Field(5.0, gt=0, le=30)     # variable: the rate is reset every N years
    schedule: List[RatePoint] = Field(default_factory=list)
    indexed: bool = False
    method: Literal["spitzer", "equal"] = "spitzer"


class Cost(BaseModel):
    name: str = ""
    amount: float = Field(0.0, ge=0)
    deductible: bool = True                          # recognised expense for mas shevach


class Scenario(BaseModel):
    """One way to split the person's money between an apartment and the market.

    ``alloc`` percent of the equity goes to the apartment: it pays the purchase tax and the
    one-time costs, and the rest is the equity in the apartment (the down payment). The rest
    of the price is the mortgage. The other ``100 - alloc`` percent starts the market account,
    which also receives the monthly surplus. With ``alloc = 0`` there is no apartment and the
    apartment fields are ignored.
    """
    id: str = ""
    name: str = ""
    alloc: float = Field(100.0, ge=0, le=100)        # percent of the equity put into the apartment
    price: float = Field(2_000_000.0, gt=0)
    status: Literal["single", "additional"] = "single"
    tracks: List[Track] = Field(default_factory=list)
    costs: List[Cost] = Field(default_factory=list)
    usage: Literal["rent", "live"] = "rent"
    rent: float = Field(0.0, ge=0)
    rent_growth: float = Field(2.5, ge=-50, le=100)
    vacancy_months: float = Field(0.0, ge=0, le=12)
    rent_tax: Literal["exempt", "ten", "marginal", "none"] = "exempt"
    marginal_rate: float = Field(31.0, ge=0, le=100)
    appreciation: float = Field(3.0, ge=-50, le=100)
    maintenance_pct: float = Field(0.5, ge=0, le=20)
    insurance: float = Field(0.0, ge=0)
    other_monthly: float = Field(0.0, ge=0)
    selling_cost_pct: float = Field(2.36, ge=0, le=50)
    prepay_fee_pct: float = Field(0.0, ge=0, le=50)
    debt_rate: float = Field(6.0, ge=0, le=100)
    market: MarketParams = Field(default_factory=MarketParams)


class HistoryFlags(BaseModel):
    """Which series run on history in history mode (the rest stay on the parameters)."""
    market: bool = True
    cpi: bool = True
    housing: bool = True
    rent: bool = True
    rate: bool = True


SYN_SERIES = ("market", "cpi", "housing", "rent", "rate")
DEFAULT_CORR = {"market|cpi": 0.0, "market|housing": 0.1, "market|rent": 0.0, "market|rate": -0.1,
                "cpi|housing": 0.3, "cpi|rent": 0.5, "cpi|rate": 0.4, "housing|rent": 0.5,
                "housing|rate": -0.2, "rent|rate": 0.1}


class SyntheticParams(BaseModel):
    """Synthetic mode: ``n`` paths of correlated monthly draws, the same for every scenario.

    Each return series has a geometric mean (the parameter it replaces: the portfolio's return,
    inflation, appreciation, rent growth) and an annual volatility ``s``: its monthly log change
    is ``ln(1 + mean) / 12 + s * z / sqrt(12)`` with ``z ~ N(0, 1)``, so the median path grows
    exactly at the mean. The Bank of Israel rate is the rate schedule plus a random walk of
    ``rate_vol`` percentage points a year (floored at 0). ``corr`` holds the correlations of the
    monthly draws, by pair ("cpi|rent").
    """
    n: int = Field(1000, ge=10, le=5000)
    seed: int = Field(1, ge=0, le=2**31 - 1)
    series: HistoryFlags = Field(default_factory=lambda: HistoryFlags())
    cpi_vol: float = Field(1.5, ge=0, le=50)
    housing_vol: float = Field(6.0, ge=0, le=100)
    rent_vol: float = Field(3.0, ge=0, le=100)
    rate_vol: float = Field(1.0, ge=0, le=20)
    corr: Dict[str, float] = Field(default_factory=lambda: dict(DEFAULT_CORR))


class Common(BaseModel):
    years: float = Field(25.0, ge=1 / 12, le=60)
    equity: float = Field(0.0, ge=0)
    budget: float = Field(0.0, ge=0)
    index_budget: bool = True
    inflation: float = Field(2.5, ge=-20, le=100)
    housing_rent: float = Field(0.0, ge=0)          # rent the person pays when not living in an own apartment
    housing_rent_growth: float = Field(2.5, ge=-50, le=100)
    discount_rate: float = Field(4.0, ge=-50, le=100)
    income: float = Field(0.0, ge=0)                 # monthly net income, only for the payment-to-income warning
    real: bool = False
    mode: Literal["fixed", "history", "synthetic"] = "fixed"
    history: HistoryFlags = Field(default_factory=HistoryFlags)
    synthetic: SyntheticParams = Field(default_factory=SyntheticParams)
    leverage_cost: float = Field(0.0, ge=0, le=30)
    rate_path: List[RatePoint] = Field(default_factory=lambda: [RatePoint(year=0, rate=4.5)])
    prime_spread: float = Field(1.5, ge=-10, le=20)
    rate_shift: float = Field(0.0, ge=-20, le=20)    # added to every floating rate (BoI path and schedules)


class PropertyRequest(BaseModel):
    common: Common = Field(default_factory=Common)
    taxes: TaxTables = Field(default_factory=TaxTables)
    scenarios: List[Scenario] = Field(min_length=1, max_length=12)
    detail_start: Optional[str] = None               # history mode: the start date to detail
