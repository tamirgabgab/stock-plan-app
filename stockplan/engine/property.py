"""Apartment and capital market: a month-by-month model on fixed parameters or on history.

Every scenario starts from the same person: an equity ``E0`` at month 0 and a monthly budget
``B_m`` for months 1..T, and splits the equity: ``alloc`` percent goes to an apartment and the
rest to a market account. With ``alloc = 0`` the scenario is market only: the account gets the
whole equity and the budget. Otherwise the apartment is bought at month 0 (purchase tax and
one-time costs come out of the apartment's share, the rest of that share is the down payment
and the rest of the price is the mortgage); the mortgage tracks and the running costs are paid
from the budget, the rent comes in, and whatever is left over (or missing) goes to the market
account (the *side account*).

``check_common`` and ``check_scenario`` reject inputs that cannot happen (the apartment's share
does not cover the purchase tax and costs, or is more than the apartment costs, a mortgage mix
that does not add up to 100%, a budget that does not cover the first month...) and warn about
unlikely ones.

The value of a scenario at month t is its **net worth on realization**: everything sold at t,
after selling costs, early-repayment fees, capital-gains tax (side account / portfolio) and
betterment tax (mas shevach), minus every outstanding liability.

Two modes share one simulator:

* **fixed**: one row; CPI, appreciation, rent growth, market returns and the Bank of Israel
  rate path come from the parameters.
* **history**: one row per start date (a realization). Each series switched to history
  (market prices, CPI, the housing price index, the rent index, the Bank of Israel rate) is a
  ``(R, T+1)`` path from ``property_data.build_paths``; the others stay on the parameters.

The simulator is vectorized: every state variable is an array, and any parameter may be an
array too. That is what makes the break-even solver cheap: all the points of a scan run as
rows of one simulation, and each realization can carry its own trial value.

Conventions (all rates are annual, in percent, as entered):

* CPI ``C_m`` is relative to the start (``C_0 = 1``); in fixed mode ``C_m = (1 + pi)^(m/12)``.
  A monthly amount entered "today" is paid at month m as ``amount * index_{m-1}``, so the
  first payment is exactly the entered amount.
* Money inputs are in the money of the start date. In history mode that means "today's money
  carried back": the real view divides by ``C_t`` (today's money again), the nominal view
  multiplies by ``CPI(start) / CPI(last)`` (the shekels of that time).
* Mortgage: monthly rate ``r/12`` (the Israeli convention), payment at the end of each month,
  recomputed on the balance and the remaining term whenever the rate changes. A CPI-linked
  track's balance is indexed every month.
* Market: monthly growth ``(1 + R)^(1/12)`` (or the portfolio's historical monthly return,
  rebalanced monthly to its weights) and management fee ``(1 - f)^(1/12)``; a deposit fee is
  taken off each deposit. Tax on gains only, on nominal or CPI-indexed cost basis.
"""
from __future__ import annotations

import copy
import math
from dataclasses import dataclass, field
from typing import Dict, List, Literal, Optional, Tuple

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


# --------------------------------------------------------------------------- helpers

def _g(obj, key):
    return obj[key] if isinstance(obj, dict) else getattr(obj, key)


def _sorted_brackets(brackets):
    return sorted(brackets, key=lambda b: float("inf") if _g(b, "up_to") is None else _g(b, "up_to"))


def bracket_tax(amount, brackets):
    """Progressive tax: each slice of ``amount`` is taxed at its bracket's rate (vectorized)."""
    tax, prev = 0.0, 0.0
    for b in _sorted_brackets(brackets):
        top = float("inf") if _g(b, "up_to") is None else _g(b, "up_to")
        tax = tax + np.maximum(0.0, np.minimum(amount, top) - prev) * _g(b, "rate") / 100
        prev = top
    return tax


def purchase_tax_rows(amount: float, brackets) -> List[dict]:
    """The slices of ``bracket_tax`` (for the equations panel)."""
    out, prev = [], 0.0
    for b in _sorted_brackets(brackets):
        top = float("inf") if _g(b, "up_to") is None else _g(b, "up_to")
        part = max(0.0, min(amount, top) - prev)
        out.append({"from": prev, "to": None if top == float("inf") else top, "rate": _g(b, "rate"),
                    "part": part, "tax": part * _g(b, "rate") / 100})
        prev = top
    return out


def annuity(balance, rho, k: int):
    """Level payment that repays ``balance`` in ``k`` months at monthly rate ``rho``."""
    if k <= 0:
        return balance
    rho = np.asarray(rho, dtype=float)
    safe = np.where(rho > 0, rho, 1.0)
    return np.where(rho > 0, balance * safe / (1 - (1 + safe) ** -k), balance / k)


def months_of(years: float) -> int:
    return max(1, int(round(years * 12)))


def schedule_at(points, t_years: float):
    """Step schedule: the rate of the last point at or before ``t_years`` (None if empty)."""
    if not points:
        return None
    pts = sorted(points, key=lambda p: _g(p, "year"))
    v = _g(pts[0], "rate")
    for p in pts:
        if _g(p, "year") <= t_years + 1e-9:
            v = _g(p, "rate")
    return v


def holdings_key(holdings) -> str:
    return "|".join(f"{_g(h, 'ticker').strip().upper()}:{float(_g(h, 'weight')):g}:{float(_g(h, 'leverage')):g}"
                    for h in holdings if _g(h, "weight") > 0)


@dataclass
class Paths:
    """Per-realization paths ``(R, T+1)``; None means "use the parameter" (fixed mode).

    In synthetic mode ``syn`` holds, for each drawn series, the cumulative standardized shock
    ``S_m = sum_{k<=m} z_k / sqrt(12)`` (``S_0 = 0``); the simulator turns it into a path with
    the scenario's own mean and volatility, so those stay parameters (and solvable).
    """
    R: int
    T: int
    cpi: Optional[np.ndarray] = None          # C_t / C_0
    home: Optional[np.ndarray] = None         # housing price index / its value at the start
    rent: Optional[np.ndarray] = None         # rent index / its value at the start
    rate: Optional[np.ndarray] = None         # Bank of Israel rate, annual percent
    growth: Dict[str, np.ndarray] = field(default_factory=dict)   # holdings key -> monthly gross factor
    start_dates: Optional[pd.DatetimeIndex] = None
    scale: Optional[np.ndarray] = None        # (R,) CPI(start) / CPI(last): nominal display factor
    info: dict = field(default_factory=dict)
    syn: Dict[str, np.ndarray] = field(default_factory=dict)

    @property
    def history(self) -> bool:
        return self.start_dates is not None


def fixed_paths(T: int) -> Paths:
    return Paths(R=1, T=T)


def corr_matrix(corr: Dict[str, float]) -> np.ndarray:
    """The correlation matrix of the monthly draws, in ``SYN_SERIES`` order (missing pairs: 0)."""
    n = len(SYN_SERIES)
    M = np.eye(n)
    for i in range(n):
        for j in range(i + 1, n):
            a, b = SYN_SERIES[i], SYN_SERIES[j]
            v = corr.get(f"{a}|{b}", corr.get(f"{b}|{a}", 0.0))
            M[i, j] = M[j, i] = v
    return M


MAX_SYN_CELLS = 2_000_000          # paths x months of the synthetic draws


def synthetic_paths(c: dict, T: int) -> Paths:
    """``n`` paths of correlated standard-normal monthly draws, cumulated (see ``Paths.syn``).

    All five series are always drawn from the full correlation matrix, so switching a series
    off (it then stays on its fixed parameter) does not change the draws of the others.
    """
    sp = c["synthetic"]
    R = int(sp["n"])
    w, V = np.linalg.eigh(corr_matrix(sp["corr"]))
    L = V * np.sqrt(np.maximum(w, 0.0))                # L @ L.T = the correlation matrix
    rng = np.random.default_rng(int(sp["seed"]))
    z = rng.standard_normal((T, R, len(SYN_SERIES))) @ L.T / np.sqrt(12)
    paths = Paths(R=R, T=T)
    for k, name in enumerate(SYN_SERIES):
        if sp["series"][name]:
            S = np.zeros((R, T + 1))
            S[:, 1:] = np.cumsum(z[:, :, k], axis=0).T
            paths.syn[name] = S
    paths.info = {"n": R, "seed": int(sp["seed"]), "series": [k for k in SYN_SERIES if sp["series"][k]]}
    return paths


class Account:
    """A market account with a cost basis, a deposit fee, tax on realized gains and an overdraft.

    Positive flows first repay the overdraft, then buy (after the deposit fee). Negative flows
    sell proportionally, grossed up so the net equals the need; what cannot be covered becomes
    overdraft debt at ``debt_rate``. Every attribute is an array of the simulation's shape.
    """

    def __init__(self, p: dict, paths: Paths, C, shape, debt_rate=0.0):
        self.fee = (1 - np.asarray(p["annual_fee"]) / 100) ** (1 / 12)
        self.r = (1 + np.asarray(p["annual_return"]) / 100) ** (1 / 12)
        self.growth = paths.growth.get(holdings_key(p["holdings"])) if paths.growth else None
        self.shock = paths.syn.get("market")
        self.vol = np.asarray(p.get("volatility", 0.0), dtype=float) / 100
        self.delta = np.asarray(p["deposit_fee"]) / 100
        self.tau = np.asarray(p["tax_rate"]) / 100
        self.real = p["tax_basis"] == "real"
        self.C = C
        self.dq = (1 + np.asarray(debt_rate) / 100) ** (1 / 12)
        self.V = np.zeros(shape)       # market value
        self.K = np.zeros(shape)       # cost basis (in month-0 money when CPI-indexed)
        self.D = np.zeros(shape)       # overdraft debt
        self.tax_paid = np.zeros(shape)
        self.first_debt = np.full(shape, -1)

    def factor(self, m: int):
        if self.growth is not None:
            g = self.growth[:, m]
        elif self.shock is not None:
            g = self.r * np.exp(self.vol * (self.shock[:, m] - self.shock[:, m - 1]))
        else:
            g = self.r
        return g * self.fee

    def basis(self, m: int):
        return self.K * self.C(m) if self.real else self.K

    def grow(self, m: int) -> None:
        self.V = self.V * self.factor(m)
        self.D = self.D * self.dq

    def flow(self, x, m: int) -> None:
        x = np.broadcast_to(np.asarray(x, dtype=float), self.V.shape)
        pos = x >= 0
        pay = np.where(pos, np.minimum(x, self.D), 0.0)
        self.D = self.D - pay
        add = np.where(pos, x - pay, 0.0)
        self.V = self.V + add * (1 - self.delta)
        self.K = self.K + (add / self.C(m) if self.real else add)
        need = np.where(pos, 0.0, -x)
        if not np.any(need > 0):
            return
        has = self.V > 0
        Vs = np.where(has, self.V, 1.0)
        g = np.where(has, np.maximum(0.0, 1 - self.basis(m) / Vs), 0.0)
        unit = 1 - self.tau * g
        max_net = self.V * unit
        sell = np.where(has & (need > 0), np.where(need >= max_net, self.V, need / unit), 0.0)
        self.tax_paid = self.tax_paid + sell * self.tau * g
        self.K = self.K * np.where(has, 1 - sell / Vs, 1.0)
        self.V = self.V - sell
        tiny = self.V < 1e-9
        self.V = np.where(tiny, 0.0, self.V)
        self.K = np.where(tiny, 0.0, self.K)
        short = need - sell * unit
        short = np.where(short > 1e-9, short, 0.0)
        self.D = self.D + short
        self.first_debt = np.where((short > 0) & (self.first_debt < 0), m, self.first_debt)

    def tax_due(self, m: int):
        return self.tau * np.maximum(0.0, self.V - self.basis(m))


# ------------------------------------------------------------------------ simulation

def simulate(sc: dict, c: dict, taxes: dict, paths: Paths, shape=None, full: bool = True) -> dict:
    """One scenario on ``paths``. ``sc``, ``c`` and ``taxes`` are plain dicts (``model_dump``)
    whose numeric values may be arrays broadcastable to ``shape`` (default ``(R,)``).

    Returns time-major arrays ``(T+1, *shape)``: ``net`` (nominal, input units), ``cpi``,
    ``budget`` and, with ``full``, the ``parts`` and ``flows`` plus a ``summary`` and warnings.
    """
    T, R = paths.T, paths.R
    S = tuple(shape) if shape is not None else (R,)
    pi = np.asarray(c["inflation"], dtype=float)

    syn = paths.syn
    sp = c["synthetic"]
    # Synthetic paths: the parameter is the geometric mean, times exp(volatility * S_m).
    wiggle = lambda name, vol, m: np.exp(np.asarray(vol) / 100 * syn[name][:, m]) if name in syn else 1.0

    def C(m):
        if paths.cpi is not None:
            return paths.cpi[:, m]
        return (1 + pi / 100) ** (m / 12) * wiggle("cpi", sp["cpi_vol"], m)

    def rent_index(m, growth):
        if paths.rent is not None:
            return paths.rent[:, m]
        return (1 + np.asarray(growth) / 100) ** (m / 12) * wiggle("rent", sp["rent_vol"], m)

    def boi(m):
        if paths.rate is not None:
            base = paths.rate[:, m - 1]
        else:
            base = schedule_at(c["rate_path"], (m - 1) / 12) or 0.0
            if "rate" in syn:
                base = np.maximum(0.0, base + np.asarray(sp["rate_vol"]) * syn["rate"][:, m - 1])
        return base + np.asarray(c["rate_shift"])

    alloc = np.asarray(sc["alloc"], dtype=float)
    apartment = bool(np.any(alloc > 0))
    pays_rent = not apartment or sc["usage"] == "rent"
    bc = lambda v: np.broadcast_to(np.asarray(v, dtype=float), S)
    rec: Dict[str, list] = {}

    def put(name, v):
        rec.setdefault(name, []).append(np.array(bc(v)))

    budget = lambda m: np.asarray(c["budget"]) * (C(m - 1) if c["index_budget"] else 1.0)
    housing = lambda m: (np.asarray(c["housing_rent"]) * rent_index(m - 1, c["housing_rent_growth"])
                         if pays_rent else 0.0)
    warnings: List[str] = []
    summary: dict = {}

    if not apartment:
        acc = Account(sc["market"], paths, C, S, debt_rate=sc["debt_rate"])
        acc.flow(c["equity"], 0)
        for m in range(T + 1):
            if m:
                acc.grow(m)
                b, h = budget(m), housing(m)
                acc.flow(b - h, m)
                if m == 1:
                    out_first = bc(b - h)
                if full:
                    put("budget_f", b), put("housing", h), put("invested", b - h)
            elif full:
                put("budget_f", 0.0), put("housing", 0.0), put("invested", 0.0)
            put("net", acc.V - acc.tax_due(m) - acc.D)
            put("cpi", C(m))
            put("budget", budget(m) if m else 0.0)
            if full:
                put("portfolio", acc.V), put("portfolio_tax", acc.tax_due(m)), put("debt", acc.D)
        out = _stack(rec)
        out["feasible"] = np.ones(S, dtype=bool)
        out["first_short"] = out_first < -0.5
        if full:
            out["parts"] = {k: out.pop(k) for k in ("portfolio", "portfolio_tax", "debt")}
            out["flows"] = {"budget": out.pop("budget_f"), "housing": out.pop("housing"), "invested": out.pop("invested")}
            neg = acc.first_debt >= 0
            if np.any(neg):
                warnings.append(_rows("שכר הדירה גבוה מהתקציב החודשי, ונוצר חוב בתיק", neg, acc.first_debt))
            summary = {"start_invested": np.asarray(c["equity"]) * (1 - acc.delta), "q": acc.r * acc.fee,
                       "tax_paid": acc.tax_paid, "first_flow": out_first}
        out["summary"], out["warnings"] = summary, warnings
        return out

    P0 = np.asarray(sc["price"], dtype=float)
    brackets = taxes["purchase_single"] if sc["status"] == "single" else taxes["purchase_additional"]
    ptax = bracket_tax(P0, brackets)
    costs_total = sum(x["amount"] for x in sc["costs"])
    deductible = ptax + sum(x["amount"] for x in sc["costs"] if x["deductible"])
    to_home = alloc / 100 * np.asarray(c["equity"], dtype=float)    # the apartment's share of the equity
    down = to_home - ptax - costs_total                               # equity in the apartment
    loan = P0 - down
    upfront = to_home
    side_start = np.asarray(c["equity"]) - to_home
    tracks = [t for t in sc["tracks"] if float(t["share"]) > 0]
    total_share = sum(float(t["share"]) for t in tracks)
    # Values that cannot happen (only reachable here through the solver's trial values; the
    # entered values are checked by check_scenario) are computed anyway and marked.
    feasible = np.broadcast_to((alloc > 0) & (down >= -0.5) & (loan >= -0.5), S)
    if not tracks:
        feasible = feasible & np.broadcast_to(loan <= 0.5, S)
    tr = []
    for t in tracks:
        L = np.maximum(loan, 0.0) * float(t["share"]) / total_share
        tr.append({"t": t, "L": L, "n": months_of(t["years"]), "bal": np.array(bc(L)), "cur": None,
                   "first": None, "first_rate": None, "interest": np.zeros(S), "paid": np.zeros(S)})

    def track_rate(s, m, b):
        t = s["t"]
        if t["kind"] == "prime":
            return b + np.asarray(c["prime_spread"]) + t["margin"]
        if t["kind"] == "variable":
            if s["cur"] is None or (m - 1) % max(1, int(round(t["reset_years"] * 12))) == 0:
                s["cur"] = b + t["margin"]
            return s["cur"]
        if t["kind"] == "schedule":
            v = schedule_at(t["schedule"], (m - 1) / 12)
            return (t["rate"] if v is None else v) + np.asarray(c["rate_shift"])
        return np.asarray(t["rate"], dtype=float)

    acc = Account(sc["market"], paths, C, S, debt_rate=sc["debt_rate"])
    acc.flow(side_start, 0)

    a_g = (1 + np.asarray(sc["appreciation"]) / 100) ** (1 / 12)
    occupancy = 1 - np.asarray(sc["vacancy_months"]) / 12
    home_at = lambda m: P0 * (paths.home[:, m] if paths.home is not None
                              else a_g ** m * wiggle("housing", sp["housing_vol"], m))
    home = home_at(0)
    pti_max = np.zeros(S)
    rate_t: Dict[int, list] = {}
    for m in range(T + 1):
        if m:
            home_prev, home = home, home_at(m)
            acc.grow(m)
            b = boi(m)
            pay = np.zeros(S)
            interest = np.zeros(S)
            for j, s in enumerate(tr):
                k = s["n"] - m + 1                      # months left including this one
                rate = track_rate(s, m, b)
                if full:
                    rate_t.setdefault(j, []).append(np.array(bc(rate)))
                if k <= 0:
                    continue
                if s["t"]["indexed"]:
                    s["bal"] = s["bal"] * (C(m) / C(m - 1))
                rho = np.maximum(rate, 0.0) / 1200
                i_m = s["bal"] * rho
                if k == 1:
                    principal = s["bal"]
                    p = principal + i_m
                elif s["t"]["method"] == "spitzer":
                    p = annuity(s["bal"], rho, k)
                    principal = p - i_m
                else:
                    principal = s["bal"] / k
                    p = principal + i_m
                s["bal"] = np.maximum(0.0, s["bal"] - principal)
                if s["first"] is None:
                    s["first"], s["first_rate"] = p, rate
                s["interest"] = s["interest"] + i_m
                s["paid"] = s["paid"] + p
                pay = pay + p
                interest = interest + i_m
            running = home_prev * np.asarray(sc["maintenance_pct"]) / 1200 + (sc["insurance"] + sc["other_monthly"]) * C(m - 1)
            rent = rent_tax = 0.0
            if sc["usage"] == "rent":
                rent = np.asarray(sc["rent"]) * rent_index(m - 1, sc["rent_growth"]) * occupancy
                theta = np.asarray(sc["marginal_rate"]) / 100
                if sc["rent_tax"] == "exempt":
                    X = taxes["rent_exempt_ceiling"] * C(m - 1)
                    rent_tax = theta * np.where(rent <= X, 0.0, np.where(rent < 2 * X, 2 * (rent - X), rent))
                elif sc["rent_tax"] == "ten":
                    rent_tax = 0.10 * rent
                elif sc["rent_tax"] == "marginal":
                    rent_tax = theta * np.maximum(0.0, rent - running - interest)
            b_m, h_m = budget(m), housing(m)
            flow = b_m - h_m - pay - running + rent - rent_tax
            acc.flow(flow, m)
            if m == 1:
                first_flow = bc(flow)
            if full:
                for k_, v in (("budget_f", b_m), ("housing", h_m), ("payment", pay), ("interest", interest),
                              ("rent", rent), ("rent_tax", rent_tax), ("running", running), ("flow", flow),
                              ("boi", b)):
                    put(k_, v)
                if c["income"] > 0:
                    pti_max = np.maximum(pti_max, pay / (c["income"] * (C(m - 1) if c["index_budget"] else 1.0)))
        elif full:
            for k_ in ("budget_f", "housing", "payment", "interest", "rent", "rent_tax", "running", "flow", "boi"):
                put(k_, 0.0)
        bal = sum((s["bal"] for s in tr), np.zeros(S))
        sale = home * np.asarray(sc["selling_cost_pct"]) / 100
        g_nom = home - sale - P0 - deductible
        g_real = home - sale - (P0 + deductible) * C(m)
        taxable = np.where(g_nom > 0, np.maximum(0.0, g_real), 0.0)
        if sc["status"] == "single":
            ceiling = taxes["shevach_single_ceiling"] * C(m)
            taxable = taxable * np.maximum(0.0, home - ceiling) / home
        shevach = taxes["shevach_rate"] / 100 * taxable
        prepay = bal * np.asarray(sc["prepay_fee_pct"]) / 100
        side_tax = acc.tax_due(m)
        put("net", home - sale - shevach - bal - prepay + acc.V - side_tax - acc.D)
        put("cpi", C(m))
        put("budget", budget(m) if m else 0.0)
        if full:
            for k_, v in (("home", home), ("mortgage", bal), ("side", acc.V), ("side_tax", side_tax),
                          ("side_debt", acc.D), ("sale_costs", sale), ("prepay", prepay), ("shevach", shevach)):
                put(k_, v)

    out = _stack(rec)
    out["feasible"] = np.array(feasible)
    out["first_short"] = first_flow < -0.5
    if full:
        out["parts"] = {k: out.pop(k) for k in ("home", "mortgage", "side", "side_tax", "side_debt", "sale_costs",
                                                 "prepay", "shevach")}
        out["flows"] = {k: out.pop(k) for k in ("housing", "payment", "interest", "rent", "rent_tax", "running", "flow", "boi")}
        out["flows"]["budget"] = out.pop("budget_f")
        later = acc.first_debt > 0
        if np.any(later):
            warnings.append(_rows(f"ההוצאות על הדירה גבוהות מהתקציב, וחשבון הצד נכנס לחוב בריבית {sc['debt_rate']:g}% לשנה",
                                  later, acc.first_debt))
        if c["income"] > 0 and np.any(pti_max > 0.40):
            warnings.append(f"ההחזר החודשי מגיע ל-{float(np.max(pti_max)) * 100:.0f}% מההכנסה. בנק ישראל מגביל "
                            "ל-50%, ובנקים בדרך כלל מאשרים עד כ-40%.")
        end_bal = out["parts"]["mortgage"][T]
        if np.any(end_bal > 1):
            warnings.append(f"בסוף התקופה נשארת יתרת משכנתא (₪{float(np.median(end_bal)):,.0f}"
                            f"{' בחציון' if end_bal.size > 1 else ''}); היא מנוכה מהשווי.")
        summary = {
            "loan": loan, "down_payment": down, "purchase_tax": ptax, "to_home": to_home,
            "ltv": loan / P0 * 100, "equity_share": down / P0 * 100,
            "purchase_tax_rows": purchase_tax_rows(float(np.ravel(P0)[0]), brackets),
            "costs_total": costs_total, "deductible": deductible, "upfront": upfront, "side_start": side_start,
            "tracks": [{"name": s["t"]["name"], "kind": s["t"]["kind"], "loan": s["L"], "months": s["n"],
                        "first_rate": s["first_rate"] if s["first_rate"] is not None else 0.0,
                        "first_payment": s["first"] if s["first"] is not None else 0.0,
                        "indexed": s["t"]["indexed"], "method": s["t"]["method"], "interest_paid": s["interest"],
                        "total_paid": s["paid"],
                        "rates": np.stack([np.zeros(S)] + rate_t.get(j, [])) if rate_t.get(j) else None}
                       for j, s in enumerate(tr)],
            "q_side": acc.r * acc.fee, "pti_max": pti_max, "side_tax_paid": acc.tax_paid,
            "first_payment": out["flows"]["payment"][min(1, T)], "first_flow": out["flows"]["flow"][min(1, T)],
        }
    out["summary"], out["warnings"] = summary, warnings
    return out


def _stack(rec: Dict[str, list]) -> dict:
    return {k: np.stack(v) for k, v in rec.items()}


def _rows(msg: str, mask, first=None) -> str:
    """A warning that names the month (one row) or how many realizations it hits."""
    mask = np.asarray(mask)
    if mask.size == 1:
        if first is not None and int(np.ravel(first)[0]) > 0:
            return f"{msg} (מחודש {int(np.ravel(first)[0])})."
        return msg + "."
    return f"{msg}, ב-{int(mask.sum())} מתוך {mask.size} ריאליזציות."


# ---------------------------------------------------------------------------- checks

Issue = Dict[str, str]          # {"field": dotted path, "msg": Hebrew text}


class InputError(ValueError):
    """Inputs that cannot happen. ``errors`` lists them with the field each one belongs to."""

    def __init__(self, errors: List[Issue]):
        super().__init__(" ".join(e["msg"] for e in errors))
        self.errors = errors


def _ils(v) -> str:
    return f"₪{float(v):,.0f}"


def _issue(field: str, msg: str) -> Issue:
    return {"field": field, "msg": msg}


def check_common(d: dict) -> Tuple[List[Issue], List[str]]:
    """Errors and warnings of the shared inputs (``d`` is ``PropertyRequest.model_dump()``)."""
    c, taxes = d["common"], d["taxes"]
    errors: List[Issue] = []
    warnings: List[str] = []
    if c["equity"] <= 0 and c["budget"] <= 0:
        errors.append(_issue("common.equity", "אין הון עצמי ואין סכום חודשי להשקעה, כך שאין מה להשקיע."))
    for key, label in (("purchase_single", "דירה יחידה"), ("purchase_additional", "דירה נוספת")):
        rows = taxes[key]
        tops = [b["up_to"] for b in rows if b["up_to"] is not None]
        if sum(b["up_to"] is None for b in rows) != 1:
            errors.append(_issue(f"taxes.{key}", f"במדרגות מס הרכישה ל{label} צריכה להיות בדיוק מדרגה עליונה אחת בלי תקרה (\"ומעלה\")."))
        if len(set(tops)) != len(tops):
            errors.append(_issue(f"taxes.{key}", f"במדרגות מס הרכישה ל{label} יש שתי מדרגות עם אותה תקרה."))
    history_rate = c["mode"] == "history" and c["history"]["rate"]
    years = [p["year"] for p in c["rate_path"]]
    if not history_rate and len(set(years)) != len(years):
        errors.append(_issue("common.rate_path", "בלוח ריבית בנק ישראל יש שתי שורות לאותה שנה."))
    if c["mode"] == "synthetic":
        sp = c["synthetic"]
        if min(np.linalg.eigvalsh(corr_matrix(sp["corr"]))) < -1e-9:
            errors.append(_issue("common.synthetic.corr", "המתאמים לא עקביים זה עם זה (למשל א' ו-ב' בקשר חזק, ב' ו-ג' בקשר חזק, "
                                                          "אבל א' ו-ג' בקשר הפוך), ולכן אי אפשר להגריל אותם יחד. הקטן חלק מהמתאמים."))
        if sp["n"] * (months_of(c["years"]) + 1) > MAX_SYN_CELLS:
            errors.append(_issue("common.synthetic.n", f"{sp['n']:,} מסלולים על {c['years']:g} שנים הם יותר מדי נקודות. "
                                                       f"אפשר עד {MAX_SYN_CELLS // (months_of(c['years']) + 1):,} מסלולים לתקופה הזו."))
        for key, label in (("cpi_vol", "האינפלציה"), ("housing_vol", "מחירי הדירות"), ("rent_vol", "שכר הדירה")):
            if sp["series"][key.split("_")[0]] and sp[key] > 30:
                warnings.append(f"תנודתיות של {sp[key]:g}% בשנה ב{label} גבוהה מאוד.")
    if c["income"] > 0 and c["budget"] > c["income"]:
        warnings.append(f"הסכום החודשי להשקעה ({_ils(c['budget'])}) גבוה מההכנסה החודשית נטו ({_ils(c['income'])}).")
    return errors, warnings


def alloc_bounds(sc: dict, c: dict, taxes: dict) -> Tuple[float, float, float]:
    """The purchase tax plus one-time costs, and the smallest and largest feasible ``alloc``
    (percent of the equity): the apartment's share must pay the tax and the costs, and cannot
    be more than the price plus them (that is no mortgage at all)."""
    brackets = taxes["purchase_single"] if sc["status"] == "single" else taxes["purchase_additional"]
    need = float(bracket_tax(float(sc["price"]), brackets)) + sum(x["amount"] for x in sc["costs"])
    E = float(c["equity"])
    if E <= 0:
        return need, float("inf"), float("inf")
    return need, need / E * 100, (sc["price"] + need) / E * 100


def check_scenario(sc: dict, c: dict, taxes: dict) -> Tuple[List[Issue], List[str]]:
    """Errors (with the scenario field they belong to) and warnings of one scenario."""
    errors: List[Issue] = []
    warnings: List[str] = []
    hist = c["mode"] == "history"
    H = lambda k: hist and c["history"][k]
    mk = sc["market"]
    if c["mode"] == "synthetic" and c["synthetic"]["series"]["market"] and mk["volatility"] > 40:
        warnings.append(f"תנודתיות של {mk['volatility']:g}% בשנה בשוק ההון גבוהה מאוד (מדד מניות רחב: בערך 15%–20%).")
    if H("market"):
        if not any(h["weight"] > 0 and h["ticker"].strip() for h in mk["holdings"]):
            errors.append(_issue("market.holdings", "אין נכסים בתיק של שוק ההון."))
    else:
        if mk["annual_fee"] >= mk["annual_return"]:
            warnings.append(f"דמי הניהול ({mk['annual_fee']:g}%) גבוהים מהתשואה ({mk['annual_return']:g}%), "
                            "ולכן התיק מאבד מערכו כל שנה.")
        if mk["annual_return"] > 20:
            warnings.append(f"תשואה שנתית של {mk['annual_return']:g}% בשוק ההון גבוהה מאוד לאורך זמן.")
    if sc["alloc"] <= 0:
        return errors, warnings

    E = float(c["equity"])
    P = float(sc["price"])
    to_home = sc["alloc"] / 100 * E
    need, lo, hi = alloc_bounds(sc, c, taxes)
    if need > E + 0.5:
        errors.append(_issue("alloc", f"ההון העצמי ({_ils(E)}) קטן ממס הרכישה וההוצאות החד-פעמיות ({_ils(need)}). "
                                      "הם משולמים מההון ולא מהמשכנתא, ולכן אי אפשר לקנות את הדירה הזו בלי הון נוסף."))
        return errors, warnings
    if to_home < need - 0.5:
        errors.append(_issue("alloc", f"החלק לדירה ({_ils(to_home)}) לא מכסה את מס הרכישה וההוצאות החד-פעמיות "
                                      f"({_ils(need)}). המינימום הוא {math.ceil(lo * 10) / 10:g}% מההון העצמי."))
        return errors, warnings
    if to_home > P + need + 0.5:
        errors.append(_issue("alloc", f"החלק לדירה ({_ils(to_home)}) גדול מכל העלות שלה: מחיר, מס רכישה והוצאות "
                                      f"({_ils(P + need)}). המקסימום הוא {math.floor(hi * 10) / 10:g}% מההון העצמי, "
                                      "ואז אין משכנתא."))
        return errors, warnings

    down = to_home - need
    loan = P - down
    tracks = [(i, t) for i, t in enumerate(sc["tracks"]) if t["share"] > 0]
    if loan > 0.5:
        total = sum(t["share"] for _, t in tracks)
        if not tracks:
            errors.append(_issue("tracks", f"יש משכנתא של {_ils(loan)}, אבל אין מסלולים בתמהיל."))
        elif abs(total - 100) > 0.05:
            errors.append(_issue("tracks", f"סכום החלקים בתמהיל הוא {total:g}%, וצריך להיות 100%."))
        cap = 25 if sc["status"] == "single" else 50
        share = down / P * 100
        if share < cap - 1e-9:
            kind = "לדירה יחידה" if sc["status"] == "single" else "לדירה נוספת"
            warnings.append(f"ההון העצמי בדירה הוא {share:.1f}% ממחירה ({_ils(down)}), פחות מ-{cap}% שבנק ישראל דורש {kind}. "
                            f"ההלוואה ({_ils(loan)}, מימון {100 - share:.1f}%) גדולה ועלולה לגרום להחזר חודשי גבוה, "
                            "ובנק בדרך כלל לא יאשר אותה.")
        b0 = None if H("rate") else (schedule_at(c["rate_path"], 0) or 0.0) + c["rate_shift"]
        for i, t in tracks:
            name = t["name"] or f"מסלול {i + 1}"
            if t["years"] > 30:
                warnings.append(f"מסלול \"{name}\" ארוך מ-30 שנה, התקופה המקסימלית שבנק ישראל מתיר.")
            if t["kind"] == "variable" and t["reset_years"] >= t["years"]:
                warnings.append(f"מסלול \"{name}\" משתנה כל {t['reset_years']:g} שנים, לא פחות מאורכו ({t['years']:g} שנים), "
                                "ולכן הריבית שלו לא משתנה אף פעם.")
            if t["kind"] == "schedule":
                ys = [p["year"] for p in t["schedule"]]
                if len(set(ys)) != len(ys):
                    errors.append(_issue(f"tracks.{i}.schedule", f"בלוח הריבית של מסלול \"{name}\" יש שתי שורות לאותה שנה."))
            r0 = (b0 + c["prime_spread"] + t["margin"] if t["kind"] == "prime" else b0 + t["margin"]) \
                if t["kind"] in ("prime", "variable") and b0 is not None else None
            if r0 is not None and r0 < 0:
                warnings.append(f"הריבית ההתחלתית של מסלול \"{name}\" שלילית ({r0:.2f}%), והיא נחשבת כ-0.")
    if sc["usage"] == "rent":
        if sc["rent"] <= 0:
            warnings.append("הדירה מושכרת, אבל השכירות החודשית היא 0.")
        elif sc["vacancy_months"] >= 12:
            warnings.append("הדירה ריקה 12 חודשים בשנה, כך שאין הכנסה משכירות.")
        elif sc["rent"] * 12 / P > 0.10:
            warnings.append(f"תשואת שכירות ברוטו של {sc['rent'] * 12 / P * 100:.1f}% בשנה גבוהה מאוד "
                            "(בישראל בדרך כלל 2.5%–4%).")
    if not H("housing") and sc["appreciation"] > 15:
        warnings.append(f"עליית ערך של {sc['appreciation']:g}% בשנה לדירה גבוהה מאוד לאורך זמן.")
    return errors, warnings


def check_result(sc: dict, c: dict, r: dict) -> Tuple[List[Issue], List[str]]:
    """Checks that need the simulation: the first month's cash flow and the outputs."""
    errors: List[Issue] = []
    warnings: List[str] = []
    short = np.asarray(r["first_short"])
    med = lambda v: float(np.median(np.asarray(v)[1]))
    if short.all():
        f = r["flows"]
        many = " (בחציון על תאריכי ההתחלה)" if short.size > 1 else ""
        if "payment" in f:
            gap = -med(f["flow"])
            parts = f"החזר המשכנתא ({_ils(med(f['payment']))}) והוצאות הדירה ({_ils(med(f['running']))})"
            if med(f["housing"]) > 0:
                parts += f" ושכר הדירה ({_ils(med(f['housing']))})"
            rent = med(f["rent"]) - med(f["rent_tax"])
            errors.append(_issue("monthly", f"התקציב החודשי ({_ils(med(f['budget']))}) לא מכסה את החודש הראשון{many}: "
                                            f"{parts}{f', פחות השכירות נטו ({_ils(rent)})' if rent > 0 else ''}. "
                                            f"חסרים {_ils(gap)} בחודש. אפשר להגדיל את התקציב, לשים חלק גדול יותר "
                                            "מההון בדירה (משכנתא קטנה יותר) או להאריך את המסלולים."))
        else:
            errors.append(_issue("monthly", f"התקציב החודשי ({_ils(med(f['budget']))}) קטן משכר הדירה "
                                            f"({_ils(med(f['housing']))}){many}: חסרים {_ils(-med(f['invested']))} בחודש."))
    elif short.any():
        warnings.append(f"בחודש הראשון התקציב לא מכסה את ההוצאות ב-{int(short.sum())} מתוך {short.size} תאריכי "
                        f"התחלה; ההפרש נרשם כחוב בריבית {sc['debt_rate']:g}% לשנה.")
    net = np.asarray(r["net"])
    if not np.all(np.isfinite(net)):
        errors.append(_issue("", "החישוב נתן ערך לא מוגדר. בדוק שהפרמטרים בטווח סביר."))
    elif np.median(net[-1]) < 0:
        warnings.append(f"השווי נטו בסוף התקופה שלילי{' בחציון' if net.shape[-1] > 1 else ''}: ההתחייבויות גדולות מהנכסים.")
    return errors, warnings


# --------------------------------------------------------------------------- metrics

METRICS = ("final", "sum", "pv_final", "pv_sum", "irr")


def irr_monthly(flows: np.ndarray) -> Optional[float]:
    """Monthly rate x with sum(flows[m] / (1+x)^m) = 0 for one cash-flow vector."""
    x = _irr_vec(np.asarray(flows, dtype=float)[:, None])[0]
    return None if not np.isfinite(x) else float(x)


def _irr_vec(cash: np.ndarray) -> np.ndarray:
    """Monthly IRR of every column of ``cash`` (time-major), by bisection; NaN without a sign change.

    The NPV ``sum(cash[m] * v^m)`` with ``v = 1/(1+x)`` is evaluated by Horner's rule, a
    loop over the months on small arrays instead of a power of the whole matrix.
    """
    def npv(x):
        v = 1 / (1 + x)
        acc = np.zeros(cash.shape[1:])
        for m in range(cash.shape[0] - 1, -1, -1):
            acc = acc * v + cash[m]
        return acc

    lo = np.full(cash.shape[1:], -0.5)    # -99.98% .. +12,875% a year
    hi = np.full(cash.shape[1:], 0.5)
    with np.errstate(all="ignore"):
        f_lo, f_hi = npv(lo), npv(hi)
        ok = np.isfinite(f_lo) & np.isfinite(f_hi) & (f_lo * f_hi <= 0)
        for _ in range(36):
            mid = (lo + hi) / 2
            f_mid = npv(mid)
            same = (f_mid > 0) == (f_lo > 0)
            lo, f_lo = np.where(same, mid, lo), np.where(same, f_mid, f_lo)
            hi = np.where(same, hi, mid)
    return np.where(ok, (lo + hi) / 2, np.nan)


def display(res: dict, c: dict, paths: Paths) -> np.ndarray:
    """``net`` in display units: today's money (real) or the shekels of the time (nominal)."""
    if c["real"]:
        return res["net"] / res["cpi"]
    return res["net"] * paths.scale if paths.scale is not None else res["net"]


def metrics(res: dict, c: dict, paths: Paths, which=None) -> dict:
    net = res["net"]
    disp = display(res, c, paths)
    T = net.shape[0] - 1
    t = np.arange(T + 1).reshape((-1,) + (1,) * (net.ndim - 1))
    disc = (1 + np.asarray(c["discount_rate"]) / 100) ** (t / 12)
    out = {}
    if which in (None, "final"):
        out["final"] = disp[-1]
    if which in (None, "sum"):
        out["sum"] = disp.sum(0)
        out["mean"] = disp.mean(0)
    if which in (None, "pv_final"):
        out["pv_final"] = net[-1] / disc[-1]
    if which in (None, "pv_sum"):
        out["pv_sum"] = (net / disc).sum(0)
    if which is None:
        out["min"] = disp.min(0)
        out["min_month"] = disp.argmin(0)
    if which in (None, "irr"):
        cash = -res["budget"].copy()
        cash[0] = -np.broadcast_to(np.asarray(c["equity"], dtype=float), cash.shape[1:])
        cash[-1] = cash[-1] + net[-1]
        x = _irr_vec(cash)
        with np.errstate(all="ignore"):
            irr = (1 + x) ** 12 - 1
            if c["real"]:
                irr = (1 + irr) / res["cpi"][-1] ** (12 / T) - 1
        out["irr"] = irr * 100
    return out


def run_property(req: PropertyRequest, md=None) -> dict:
    """Every scenario on the request's paths (fixed: one row; history: one row per start date).

    Shared inputs that cannot happen raise ``InputError``. A scenario whose own inputs (or first
    month) cannot happen is not simulated: it goes to ``failed`` with its errors, and the
    others still run.
    """
    from .property_data import build_paths   # data loading is only needed in history mode
    d = req.model_dump()
    errors, warnings = check_common(d)
    if errors:
        raise InputError(errors)
    c, taxes = d["common"], d["taxes"]
    failed: List[dict] = []
    valid = []
    for sc in d["scenarios"]:
        errs, warns = check_scenario(sc, c, taxes)
        if errs:
            failed.append({"id": sc["id"], "name": sc["name"], "errors": errs})
        else:
            valid.append((sc, warns))
    paths = build_paths(req, md, [sc for sc, _ in valid]) if valid else None
    out = []
    for sc, warns in valid:
        r = simulate(sc, c, taxes, paths)
        errs, more = check_result(sc, c, r)
        if errs:
            failed.append({"id": sc["id"], "name": sc["name"], "errors": errs})
            continue
        r["warnings"] = warns + r["warnings"] + more
        r["metrics"] = metrics(r, c, paths)
        r["display"] = display(r, c, paths)
        r["id"], r["name"] = sc["id"], sc["name"]
        r["kind"] = "apartment" if sc["alloc"] > 0 else "market"
        out.append(r)
    order = {sc["id"]: i for i, sc in enumerate(d["scenarios"])}
    failed.sort(key=lambda f: order.get(f["id"], 0))
    return {"months": months_of(c["years"]), "paths": paths, "scenarios": out, "failed": failed,
            "warnings": warnings}


# Backwards-compatible single-scenario helper (fixed mode).
def simulate_scenario(sc, c, taxes) -> dict:
    d = lambda x: x.model_dump() if hasattr(x, "model_dump") else x
    c_, t_ = d(c), d(taxes)
    r = simulate(d(sc), c_, t_, fixed_paths(months_of(c_["years"])))
    return _first_row(r)


def _first_row(r: dict) -> dict:
    pick = lambda v: v[..., 0] if isinstance(v, np.ndarray) and v.ndim >= 1 else v
    out = {k: pick(v) for k, v in r.items() if isinstance(v, np.ndarray)}
    for k in ("parts", "flows"):
        if k in r:
            out[k] = {n: pick(v) for n, v in r[k].items()}
    out["summary"] = row_of(r.get("summary", {}), 0)
    out["warnings"] = r.get("warnings", [])
    return out


def row_of(v, r: int):
    """The value of realization ``r``: scalars stay, arrays of the simulation's shape are indexed."""
    if isinstance(v, dict):
        return {k: row_of(x, r) for k, x in v.items()}
    if isinstance(v, list):
        return [row_of(x, r) for x in v]
    if isinstance(v, np.ndarray):
        if v.ndim == 0:
            return float(v)
        if v.ndim == 1:
            return float(v[r]) if v.dtype.kind == "f" else int(v[r])
        return v[:, r].tolist()            # time-major path
    if isinstance(v, (np.floating, np.integer)):
        return v.item()
    return v


# ---------------------------------------------------------------- solve for unknown

STATS = ("median", "mean", "prob")


def _param_path(d: dict, scope: str, key: str) -> list:
    """``scope`` is "common" or a scenario id; ``key`` is a dotted path (``tracks.0.rate``)."""
    parts = [int(p) if p.isdigit() else p for p in key.split(".")]
    if scope == "common":
        path = ["common", *parts]
    else:
        idx = next((i for i, s in enumerate(d["scenarios"]) if s["id"] == scope), None)
        if idx is None:
            raise ValueError(f"תרחיש לא קיים: {scope}")
        path = ["scenarios", idx, *parts]
    cur = d
    try:
        for k in path:
            cur = cur[k]
    except (KeyError, IndexError, TypeError):
        raise ValueError(f"פרמטר לא קיים: {key}") from None
    if isinstance(cur, bool) or not isinstance(cur, (int, float)):
        raise ValueError("אפשר לפתור רק פרמטר מספרי")
    return path


def _with(d: dict, path: list, value) -> dict:
    out = copy.deepcopy(d)
    cur = out
    for k in path[:-1]:
        cur = cur[k]
    cur[path[-1]] = value
    return out


def _stat(va: np.ndarray, vb: np.ndarray, stat: str) -> np.ndarray:
    """Statistic of A minus that of B over the realizations (last axis)."""
    with np.errstate(all="ignore"):
        if stat == "prob":
            return np.nanmean(np.where(np.isfinite(va) & np.isfinite(vb), va > vb, np.nan), -1) - 0.5
        f = np.nanmedian if stat == "median" else np.nanmean
        return f(va, -1) - f(vb, -1)


def _crossings(xs: np.ndarray, ys: np.ndarray) -> List[int]:
    """Indices i where ys changes sign between i and i+1 (or is zero at i)."""
    out = []
    for i in range(len(xs) - 1):
        y0, y1 = ys[i], ys[i + 1]
        if not (np.isfinite(y0) and np.isfinite(y1)):
            continue
        if y0 == 0 or y0 * y1 < 0:
            out.append(i)
    if len(ys) and np.isfinite(ys[-1]) and ys[-1] == 0:
        out.append(len(xs) - 1)
    return out


def _interp_root(x0, x1, y0, y1):
    with np.errstate(all="ignore"):
        return np.where(y1 != y0, x0 - y0 * (x1 - x0) / (y1 - y0), x0)


def solve_equal(req: PropertyRequest, a: str, b: str, metric: str, scope: str, key: str,
                lo: float, hi: float, stat: str = "median", md=None, n_grid: int = 48) -> dict:
    """The values of one parameter at which scenarios ``a`` and ``b`` are equivalent on ``metric``.

    The scan's grid points run as rows of a single simulation. Every sign change of
    ``stat(metric_a) - stat(metric_b)`` is refined by a second, finer grid inside its bracket
    (again one simulation) and linear interpolation. In history mode each realization is
    also solved on its own: per row, its first bracket is refined the same way, with every
    row carrying its own trial values.
    """
    from .property_data import build_paths
    if metric not in METRICS:
        raise ValueError(f"מטריקה לא מוכרת: {metric}")
    if stat not in STATS:
        raise ValueError(f"סטטיסטיקה לא מוכרת: {stat}")
    if a == b:
        raise ValueError("בחר שני תרחישים שונים להשוואה")
    if not hi > lo:
        raise ValueError("הגבול העליון חייב להיות גדול מהתחתון")
    d = req.model_dump()
    path = _param_path(d, scope, key)
    ia = next((i for i, s in enumerate(d["scenarios"]) if s["id"] == a), None)
    ib = next((i for i, s in enumerate(d["scenarios"]) if s["id"] == b), None)
    if ia is None or ib is None:
        raise ValueError("תרחיש לא קיים")
    errors, _ = check_common(d)
    for i in (ia, ib):
        sc = d["scenarios"][i]
        errors += [{**e, "msg": f"{sc['name'] or 'תרחיש'}: {e['msg']}"} for e in check_scenario(sc, d["common"], d["taxes"])[0]]
    if errors:
        raise InputError(errors)
    paths = build_paths(req, md, [d["scenarios"][ia], d["scenarios"][ib]])
    touch = lambda i: scope == "common" or d["scenarios"][i]["id"] == scope
    R = paths.R

    def metric_of(dd, i, shape, rowwise=False):
        """The metric, NaN where the trial value cannot happen: the purchase does not add up,
        or (for a row of the statistic scan) the budget misses the first month in every
        realization. Rows of the per-realization grid carry their own values, so there only
        the purchase is checked, as a single run would."""
        r = simulate(dd["scenarios"][i], dd["common"], dd["taxes"], paths, shape=shape, full=False)
        v = np.asarray(metrics(r, dd["common"], paths, which=metric)[metric], dtype=float)
        ok = np.broadcast_to(r["feasible"], shape)
        if not rowwise:
            ok = ok & ~np.broadcast_to(np.all(r["first_short"], axis=-1, keepdims=True), shape)
        return np.where(ok, v, np.nan)

    fixed = {i: metric_of(d, i, (R,)) for i in (ia, ib) if not touch(i)}

    def both(xval, rowwise=False):
        x = np.asarray(xval, dtype=float)
        shape = np.broadcast_shapes(x.shape, (R,))
        dd = _with(d, path, x)
        va = metric_of(dd, ia, shape, rowwise) if touch(ia) else np.broadcast_to(fixed[ia], shape)
        vb = metric_of(dd, ib, shape, rowwise) if touch(ib) else np.broadcast_to(fixed[ib], shape)
        return va, vb

    current = d
    for k in path:
        current = current[k]
    current = float(current)
    xs = np.linspace(lo, hi, n_grid + 1)
    va, vb = both(np.append(xs, current)[:, None])           # (G+2, R)
    curve = _stat(va, vb, stat)
    current_diff, curve = float(curve[-1]), curve[:-1]
    va, vb = va[:-1], vb[:-1]

    # Statistic roots: refine every bracket at once on a finer grid.
    roots: List[float] = []
    br = _crossings(xs, curve)
    if br:
        fine = np.concatenate([np.linspace(xs[i], xs[min(i + 1, n_grid)], n_grid + 1) for i in br])
        fa, fb = both(fine[:, None])
        fcurve = _stat(fa, fb, stat).reshape(len(br), n_grid + 1)
        fxs = fine.reshape(len(br), n_grid + 1)
        for j in range(len(br)):
            sub = _crossings(fxs[j], fcurve[j])
            if sub:
                i = sub[0]
                i1 = min(i + 1, n_grid)
                roots.append(float(_interp_root(fxs[j, i], fxs[j, i1], fcurve[j, i], fcurve[j, i1])))
    out = {"roots": roots, "scan_x": xs.tolist(), "scan_y": [None if not np.isfinite(v) else float(v) for v in curve],
           "current": current, "current_diff": current_diff, "stat": stat}

    if paths.history and R > 1:
        diff = va - vb                                          # (G+1, R)
        s = np.sign(np.where(np.isfinite(diff), diff, np.nan))
        change = (s[:-1] * s[1:] <= 0) & np.isfinite(s[:-1]) & np.isfinite(s[1:])
        n_changes = change.sum(0)
        first = np.where(n_changes > 0, change.argmax(0), -1)
        has = first >= 0
        i0 = np.where(has, first, 0)
        x0, x1 = xs[i0], xs[np.minimum(i0 + 1, n_grid)]
        grid = x0[None, :] + (x1 - x0)[None, :] * np.linspace(0, 1, n_grid + 1)[:, None]   # (G+1, R)
        ga, gb = both(grid, rowwise=True)
        gd = ga - gb
        gs = np.sign(gd)
        gchange = (gs[:-1] * gs[1:] <= 0) & np.isfinite(gs[:-1]) & np.isfinite(gs[1:])
        gfirst = np.where(gchange.any(0), gchange.argmax(0), 0)
        cols = np.arange(R)
        rx = _interp_root(grid[gfirst, cols], grid[gfirst + 1, cols], gd[gfirst, cols], gd[gfirst + 1, cols])
        rx = np.where(has & gchange.any(0), rx, np.nan)
        out["per_row"] = {
            "roots": [None if not np.isfinite(v) else float(v) for v in rx],
            "start_dates": [d_.strftime("%Y-%m-%d") for d_ in paths.start_dates],
            "multiple": int((n_changes > 1).sum()),
            "none": int((~has).sum()),
            "a_better_all": int(((~has) & (np.nanmin(diff, 0) > 0)).sum()),
            "b_better_all": int(((~has) & (np.nanmax(diff, 0) < 0)).sum()),
        }
    return out


__all__ = ["PropertyRequest", "Common", "TaxTables", "MarketParams", "Track", "Cost", "Scenario",
           "InputError", "check_common", "check_scenario", "check_result", "alloc_bounds", "Bracket", "HistoryFlags", "RatePoint", "Paths", "bracket_tax", "annuity",
           "run_property", "simulate", "simulate_scenario", "solve_equal", "irr_monthly", "metrics", "display",
           "row_of", "METRICS", "STATS"]
