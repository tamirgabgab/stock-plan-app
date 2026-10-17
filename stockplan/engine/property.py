"""Apartment vs. capital market: a month-by-month model on fixed parameters or on history.

Every scenario starts from the same person: an equity ``E0`` at month 0 and a monthly budget
``B_m`` for months 1..T. A *market* scenario invests both. An *apartment* scenario buys the
apartment at month 0 (down payment, purchase tax and one-time costs come out of the equity),
pays the mortgage tracks and the running costs from the budget, receives the rent, and puts
whatever is left over (or takes what is missing) in a *side account* invested in the market.

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
from dataclasses import dataclass, field
from typing import Annotated, Dict, List, Literal, Optional, Union

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


class MarketScenario(BaseModel):
    kind: Literal["market"] = "market"
    id: str = ""
    name: str = ""
    market: MarketParams = Field(default_factory=MarketParams)


class ApartmentScenario(BaseModel):
    kind: Literal["apartment"] = "apartment"
    id: str = ""
    name: str = ""
    price: float = Field(gt=0)
    status: Literal["single", "additional"] = "single"
    ltv: float = Field(70.0, ge=0, le=100)
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
    side: MarketParams = Field(default_factory=MarketParams)


Scenario = Annotated[Union[MarketScenario, ApartmentScenario], Field(discriminator="kind")]


class HistoryFlags(BaseModel):
    """Which series run on history in history mode (the rest stay on the parameters)."""
    market: bool = True
    cpi: bool = True
    housing: bool = True
    rent: bool = True
    rate: bool = True


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
    mode: Literal["fixed", "history"] = "fixed"
    history: HistoryFlags = Field(default_factory=HistoryFlags)
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
    """Per-realization paths ``(R, T+1)``; None means "use the parameter" (fixed mode)."""
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

    @property
    def history(self) -> bool:
        return self.start_dates is not None


def fixed_paths(T: int) -> Paths:
    return Paths(R=1, T=T)


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
        g = self.growth[:, m] if self.growth is not None else self.r
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

    def C(m):
        return paths.cpi[:, m] if paths.cpi is not None else (1 + pi / 100) ** (m / 12)

    def rent_index(m, growth):
        return paths.rent[:, m] if paths.rent is not None else (1 + np.asarray(growth) / 100) ** (m / 12)

    def boi(m):
        base = paths.rate[:, m - 1] if paths.rate is not None else (schedule_at(c["rate_path"], (m - 1) / 12) or 0.0)
        return base + np.asarray(c["rate_shift"])

    apartment = sc["kind"] == "apartment"
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
        acc = Account(sc["market"], paths, C, S)
        acc.flow(c["equity"], 0)
        for m in range(T + 1):
            if m:
                acc.grow(m)
                b, h = budget(m), housing(m)
                acc.flow(b - h, m)
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
        if full:
            out["parts"] = {k: out.pop(k) for k in ("portfolio", "portfolio_tax", "debt")}
            out["flows"] = {"budget": out.pop("budget_f"), "housing": out.pop("housing"), "invested": out.pop("invested")}
            neg = acc.first_debt >= 0
            if np.any(neg):
                warnings.append(_rows("שכר הדירה גבוה מהתקציב החודשי, ונוצר חוב בתיק", neg, acc.first_debt))
            summary = {"start_invested": np.asarray(c["equity"]) * (1 - acc.delta), "q": acc.r * acc.fee,
                       "tax_paid": acc.tax_paid}
        out["summary"], out["warnings"] = summary, warnings
        return out

    P0 = np.asarray(sc["price"], dtype=float)
    loan = P0 * np.asarray(sc["ltv"]) / 100
    tracks = [t for t in sc["tracks"] if float(t["share"]) > 0]
    total_share = sum(float(t["share"]) for t in tracks)
    if np.any(loan > 0) and not tracks:
        raise ValueError(f"{sc['name'] or 'דירה'}: יש משכנתא ({sc['ltv']}%) אבל אין מסלולים בתמהיל")
    if tracks and abs(total_share - 100) > 0.01 and full:
        warnings.append(f"סכום החלקים בתמהיל הוא {total_share:g}%, והוא נורמל ל-100%.")
    tr = []
    for t in tracks:
        L = loan * float(t["share"]) / total_share
        tr.append({"t": t, "L": L, "n": months_of(t["years"]), "bal": np.array(bc(L)), "cur": None,
                   "first": None, "first_rate": None, "interest": np.zeros(S), "paid": np.zeros(S)})
        if t["years"] > 30 and full:
            warnings.append(f"מסלול \"{t['name'] or 'ללא שם'}\" ארוך מ-30 שנה, התקופה המקסימלית שבנק ישראל מתיר.")

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

    brackets = taxes["purchase_single"] if sc["status"] == "single" else taxes["purchase_additional"]
    ptax = bracket_tax(P0, brackets)
    costs_total = sum(x["amount"] for x in sc["costs"])
    deductible = ptax + sum(x["amount"] for x in sc["costs"] if x["deductible"])
    down = P0 - loan
    upfront = down + ptax + costs_total
    side_start = np.asarray(c["equity"]) - upfront
    acc = Account(sc["side"], paths, C, S, debt_rate=sc["debt_rate"])
    acc.flow(side_start, 0)

    a_g = (1 + np.asarray(sc["appreciation"]) / 100) ** (1 / 12)
    occupancy = 1 - np.asarray(sc["vacancy_months"]) / 12
    home_at = lambda m: P0 * (paths.home[:, m] if paths.home is not None else a_g ** m)
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
    if full:
        out["parts"] = {k: out.pop(k) for k in ("home", "mortgage", "side", "side_tax", "side_debt", "sale_costs",
                                                 "prepay", "shevach")}
        out["flows"] = {k: out.pop(k) for k in ("housing", "payment", "interest", "rent", "rent_tax", "running", "flow", "boi")}
        out["flows"]["budget"] = out.pop("budget_f")
        short_start = side_start < 0
        if np.any(short_start):
            warnings.append(_rows(f"ההון העצמי קטן מהנדרש לרכישה; ההפרש נרשם כחוב בריבית {sc['debt_rate']:g}% לשנה",
                                  np.broadcast_to(short_start, S)))
        later = (acc.first_debt > 0) & ~np.broadcast_to(short_start, S)
        if np.any(later):
            warnings.append(_rows(f"ההוצאות על הדירה גבוהות מהתקציב, וחשבון הצד נכנס לחוב בריבית {sc['debt_rate']:g}% לשנה",
                                  later, acc.first_debt))
        ltv_cap = 75 if sc["status"] == "single" else 50
        if np.any(np.asarray(sc["ltv"]) > ltv_cap + 1e-9):
            kind = "לדירה יחידה" if sc["status"] == "single" else "לדירה נוספת"
            warnings.append(f"אחוז המימון {float(np.max(sc['ltv'])):g}% גבוה מהמקסימום של בנק ישראל {kind} ({ltv_cap}%).")
        if c["income"] > 0 and np.any(pti_max > 0.40):
            warnings.append(f"ההחזר החודשי מגיע ל-{float(np.max(pti_max)) * 100:.0f}% מההכנסה. בנק ישראל מגביל "
                            "ל-50%, ובנקים בדרך כלל מאשרים עד כ-40%.")
        end_bal = out["parts"]["mortgage"][T]
        if np.any(end_bal > 1):
            warnings.append(f"בסוף התקופה נשארת יתרת משכנתא (₪{float(np.median(end_bal)):,.0f}"
                            f"{' בחציון' if end_bal.size > 1 else ''}); היא מנוכה מהשווי.")
        summary = {
            "loan": loan, "down_payment": down, "purchase_tax": ptax,
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
    """Every scenario on the request's paths (fixed: one row; history: one row per start date)."""
    from .property_data import build_paths   # data loading is only needed in history mode
    paths = build_paths(req, md)
    d = req.model_dump()
    out = []
    for sc in d["scenarios"]:
        r = simulate(sc, d["common"], d["taxes"], paths)
        r["metrics"] = metrics(r, d["common"], paths)
        r["display"] = display(r, d["common"], paths)
        r["id"], r["name"], r["kind"] = sc["id"], sc["name"], sc["kind"]
        out.append(r)
    return {"months": paths.T, "paths": paths, "scenarios": out}


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
    paths = build_paths(req, md)
    d = req.model_dump()
    path = _param_path(d, scope, key)
    ia = next((i for i, s in enumerate(d["scenarios"]) if s["id"] == a), None)
    ib = next((i for i, s in enumerate(d["scenarios"]) if s["id"] == b), None)
    if ia is None or ib is None:
        raise ValueError("תרחיש לא קיים")
    touch = lambda i: scope == "common" or d["scenarios"][i]["id"] == scope
    R = paths.R

    def metric_of(dd, i, shape):
        r = simulate(dd["scenarios"][i], dd["common"], dd["taxes"], paths, shape=shape, full=False)
        return np.asarray(metrics(r, dd["common"], paths, which=metric)[metric], dtype=float)

    fixed = {i: metric_of(d, i, (R,)) for i in (ia, ib) if not touch(i)}

    def both(xval):
        x = np.asarray(xval, dtype=float)
        shape = np.broadcast_shapes(x.shape, (R,))
        dd = _with(d, path, x)
        va = metric_of(dd, ia, shape) if touch(ia) else np.broadcast_to(fixed[ia], shape)
        vb = metric_of(dd, ib, shape) if touch(ib) else np.broadcast_to(fixed[ib], shape)
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
        ga, gb = both(grid)
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


__all__ = ["PropertyRequest", "Common", "TaxTables", "MarketParams", "Track", "Cost", "MarketScenario",
           "ApartmentScenario", "Bracket", "HistoryFlags", "RatePoint", "Paths", "bracket_tax", "annuity",
           "run_property", "simulate", "simulate_scenario", "solve_equal", "irr_monthly", "metrics", "display",
           "row_of", "METRICS", "STATS"]
