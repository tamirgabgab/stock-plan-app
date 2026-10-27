"""Plain data structures for the simulation engine (no UI or web dependencies)."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import List, Optional

SOLVE_FINAL = "final"
SOLVE_MONTHLY = "monthly_deposit"
SOLVE_START = "start_amount"
SOLVE_WITHDRAWAL = "withdrawal"     # the largest monthly withdrawal of the withdrawal stages
SOLVE_MODES = (SOLVE_FINAL, SOLVE_MONTHLY, SOLVE_START, SOLVE_WITHDRAWAL)

STEPS = {"D": "day", "W": "week", "M": "month"}

# Periodic rebalancing back to the stage weights: months between rebalances, or "band"
# (whenever a weight drifts more than ``rebalance_band`` percentage points).
REBALANCE_PERIODS = {"monthly": 1, "quarterly": 3, "annual": 12}
REBALANCE_RULES = ("none", "band", *REBALANCE_PERIODS)
DEPOSIT_EVERY = (1, 3, 6, 12)


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
    kind: str = "deposit"         # "deposit", or "withdraw" (a retirement stage: no deposits)
    # Withdrawal stage settings, the same as the Trinity tab's (see WithdrawStage). The
    # "initial" basis is the net balance when the plan's first withdrawal stage starts.
    rate: float = 4.0
    amount: float = 0.0
    rate_unit: str = "pct"
    basis: str = "initial"
    floor: float = 0.0
    ceiling: float = 0.0
    guard_unit: str = "pct"
    one_time: float = 0.0
    one_time_unit: str = "money"

    @property
    def withdraws(self) -> bool:
        return self.kind == "withdraw"


@dataclass
class DepositEvent:
    """A one-off change to the deposit schedule at plan month ``month`` (0-based).

    "deposit" adds ``amount``; "withdraw" takes ``amount`` out (a pro-rata sale, net of tax);
    "pause" skips the periodic deposits for ``months`` months. Amounts are in input units,
    like the deposits (today's money in real mode, indexed when the deposits are).
    """
    month: int
    kind: str = "deposit"          # "deposit", "withdraw" or "pause"
    amount: float = 0.0
    months: int = 12               # length of a pause


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
    # Deposit schedule
    deposit_every: int = 1         # months between periodic deposits (1, 3, 6 or 12)
    deposit_growth: float = 0.0    # percent per year the periodic deposit rises (a step every plan year)
    events: List[DepositEvent] = field(default_factory=list)
    lump_spread: int = 0           # invest the start amount over this many months (0 = at once)
    cash_rate: float = 0.0         # percent per year earned by the cash waiting to be invested
    rebalance: str = "none"        # see REBALANCE_RULES
    rebalance_band: float = 5.0    # percentage points, for rebalance == "band"
    index_withdrawals: bool = True # withdrawal stages keep their purchasing power (as in Trinity)

    @property
    def total_months(self) -> int:
        return sum(s.months for s in self.stages)

    @property
    def has_withdrawals(self) -> bool:
        return any(s.withdraws for s in self.stages)

    @property
    def retire_month(self) -> int:
        """Plan month the first withdrawal stage starts (-1 = none)."""
        m = 0
        for s in self.stages:
            if s.withdraws:
                return m
            m += s.months
        return -1

    @property
    def needs_cpi(self) -> bool:
        return (self.real or self.index_deposits or self.tax_basis == "real"
                or (self.index_withdrawals and self.has_withdrawals))


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
    withdrawn_total: "object" = None      # (R,) net cash taken out by withdrawal events
    # First month the account reaches the target (-1 = never), gross and net.
    target_month_gross: "object" = None
    target_month_net: "object" = None
    # Costs, display units: fees charged, tax paid along the way, and the final value of the
    # same plan with no fees (the fee drag is the difference).
    fees_total: "object" = None
    tax_paid: "object" = None
    final_nofee: "object" = None
    final_nofee_gross: "object" = None
    # The same plan with the start amount invested at once (only when it is spread).
    final_lump: "object" = None
    final_lump_gross: "object" = None
    # Withdrawal stages (lifecycle plans): success means every withdrawal was paid in full
    # (final mode) or that a solution exists (solve modes).
    success: "object" = None              # (R,) bool
    depleted_at: "object" = None          # (R,) first month a withdrawal was not paid in full, or -1
    retire_value: "object" = None         # (R,) net balance when the withdrawals start, display units
    retire_month: int = -1


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
    rebalance: str = "none"
    rebalance_band: float = 5.0

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
