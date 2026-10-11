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
    # Gross = market value of the holdings, before the tax of selling everything at the end.
    final_gross: "object" = None          # (R,) display units
    irr_gross: "object" = None            # (R,) percent
    account_drawdown_gross: "object" = None
    paths_gross: "object" = None          # (R, months+1) display units
    # Plan-year cohorts: annual return (IRR, percent) of the deposits made in each plan year
    # (12 months), held to the end. Shape (R, years). Net applies the plan's tax rate to the
    # cohort's own gain.
    year_irr_gross: "object" = None
    year_irr_net: "object" = None


# ------------------------------------------------------------------ withdrawal (Trinity)

SOLVE_RATE = "rate"
SOLVE_AMOUNT = "amount"           # the monthly withdrawal in money, the same for every stage
TRINITY_SOLVE_MODES = (SOLVE_FINAL, SOLVE_AMOUNT, SOLVE_RATE, SOLVE_START)


@dataclass
class WithdrawStage:
    months: int
    holdings: List[Holding]
    rate: float = 4.0             # percent per year, withdrawn monthly (1/12)
    amount: float = 0.0           # monthly withdrawal in money (input units) when rate_unit == "money"
    rate_unit: str = "pct"        # "pct" or "money"
    basis: str = "initial"        # "initial": of the start amount (fixed), "current": of the balance now
    floor: float = 0.0            # guardrails for basis == "current" (0 = none)
    ceiling: float = 0.0
    guard_unit: str = "pct"       # "pct": percent per year of the start amount; "money": per month
    one_time: float = 0.0         # withdrawal at the start of the stage
    one_time_unit: str = "money"  # "money" or "pct" (of the balance at that moment)
    name: str = ""


@dataclass
class WithdrawRequest:
    stages: List[WithdrawStage]
    start_amount: float = 1_000_000.0
    target_amount: float = 0.0        # balance that must remain at the end (solve modes only)
    solve_for: str = SOLVE_FINAL      # "final", "amount", "rate" or "start_amount"
    currency: str = "USD"
    real: bool = False
    index_withdrawals: bool = True    # fixed withdrawals keep their purchasing power (Trinity study)
    tax_rate: float = 25.0
    tax_basis: str = "nominal"
    tax_on_switch: bool = False
    annual_fee: float = 0.0
    leverage_cost: float = 0.0
    min_start: Optional[date] = None
    max_start: Optional[date] = None
    step: str = "M"

    @property
    def total_months(self) -> int:
        return sum(s.months for s in self.stages)

    @property
    def needs_cpi(self) -> bool:
        return self.real or self.index_withdrawals or self.tax_basis == "real"

    @property
    def index_deposits(self) -> bool:   # lets the shared market code treat both requests alike
        return self.index_withdrawals


@dataclass
class WithdrawResult:
    start_dates: list
    end_dates: list
    months: int
    final: "object"               # (R,) final net value, display units
    withdrawn_total: "object"     # (R,) total net withdrawals, display units
    min_balance: "object"         # (R,) lowest net value along the path
    depleted_at: "object"         # (R,) first month the withdrawal could not be paid in full, or -1
    success: "object"             # (R,) bool: paid every withdrawal (final mode); a solution exists (solve modes)
    paths: "object"               # (R, months+1) net liquidation value, display units
    withdrawals_path: "object"    # (R, months+1) cumulative net withdrawals, display units
    solved: "object" = None
    warnings: List[str] = field(default_factory=list)
