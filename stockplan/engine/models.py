"""Plain data structures for the simulation engine (no UI or web dependencies)."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import List, Optional

SOLVE_FINAL = "final"
SOLVE_MONTHLY = "monthly_deposit"
SOLVE_START = "start_amount"
SOLVE_MODES = (SOLVE_FINAL, SOLVE_MONTHLY, SOLVE_START)

STEPS = {"D": "day", "W": "week", "M": "month"}


@dataclass
class Holding:
    ticker: str
    weight: float
    leverage: float = 1.0

    @property
    def key(self) -> tuple[str, float]:
        return (self.ticker.strip().upper(), float(self.leverage))


@dataclass
class Stage:
    months: int
    holdings: List[Holding]
    initial_deposit: float = 0.0
    monthly_deposit: float = 0.0
    name: str = ""


@dataclass
class PlanRequest:
    stages: List[Stage]
    start_amount: float = 0.0
    target_amount: float = 1_000_000.0
    solve_for: str = SOLVE_FINAL
    currency: str = "USD"
    real: bool = False             # inputs and results in today's money (CPI-adjusted)
    index_deposits: bool = False   # deposits grow with the CPI
    tax_rate: float = 25.0         # percent
    tax_basis: str = "nominal"     # "nominal" or "real" (gain above inflation only)
    tax_on_switch: bool = False    # selling between stages is a taxable event
    annual_fee: float = 0.0        # percent per year, charged monthly
    leverage_cost: float = 0.0     # percent per year on the borrowed part of leveraged holdings
    min_start: Optional[date] = None
    max_start: Optional[date] = None
    step: str = "M"                # "D", "W" or "M" between consecutive start dates

    @property
    def total_months(self) -> int:
        return sum(s.months for s in self.stages)

    @property
    def needs_cpi(self) -> bool:
        return self.real or self.index_deposits or self.tax_basis == "real"


@dataclass
class SimulationResult:
    start_dates: list            # list[pd.Timestamp], one per realization
    end_dates: list
    months: int
    final: "object"              # (R,) final net value, display units
    deposits_total: "object"     # (R,) total deposits, display units
    irr: "object"                # (R,) money-weighted annual return, percent
    cagr: "object"               # (R,) time-weighted annual return of the portfolio, percent
    max_drawdown: "object"       # (R,) percent (negative): the strategy's own return path (unit growth)
    account_drawdown: "object"   # (R,) percent (negative): the net account value, deposits included
    paths: "object"              # (R, months+1) net liquidation value, display units
    deposits_path: "object"      # (R, months+1) cumulative deposits, display units
    solved: "object" = None      # (R,) solved variable, or None
    warnings: List[str] = field(default_factory=list)
