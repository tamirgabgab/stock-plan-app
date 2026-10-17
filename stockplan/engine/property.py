"""Apartment vs. capital market: a deterministic month-by-month model with fixed parameters.

Every scenario starts from the same person: an equity ``E0`` at month 0 and a monthly budget
``B_m`` for months 1..T. A *market* scenario invests both. An *apartment* scenario buys the
apartment at month 0 (down payment, purchase tax and one-time costs come out of the equity),
pays the mortgage tracks and the running costs from the budget, receives the rent, and puts
whatever is left over (or takes what is missing) in a *side account* invested in the market.

The value of a scenario at month t is its **net worth on realization**: everything sold at t,
after selling costs, early-repayment fees, capital-gains tax (side account / portfolio) and
betterment tax (mas shevach), minus every outstanding liability.

Conventions (all rates are annual, in percent, as entered):

* CPI: ``C_m = (1 + pi)^(m/12)``. A monthly amount entered "today" is paid at month m as
  ``amount * growth^((m-1)/12)``, so the first payment is exactly the entered amount.
* Mortgage: monthly rate ``r/12`` (the Israeli convention), payment at the end of each month.
  A CPI-linked track's balance is indexed every month and its payment is recomputed on the
  indexed balance and the remaining term (equal to the real annuity times the CPI ratio).
* Market: monthly growth ``(1 + R)^(1/12)`` and management fee ``(1 - f)^(1/12)``; a deposit
  fee is taken off each deposit. Tax on gains only, on nominal or CPI-indexed cost basis.
"""
from __future__ import annotations

from typing import Annotated, Dict, List, Literal, Optional, Union

import numpy as np
from pydantic import BaseModel, Field, ValidationError

# ----------------------------------------------------------------------------- inputs

# Israeli purchase-tax brackets (frozen 16/01/2025 - 15/01/2028) and related ceilings.
# Users can edit them in the UI when the Tax Authority publishes new values.
PURCHASE_SINGLE = [(1_978_745, 0.0), (2_347_040, 3.5), (6_055_070, 5.0), (20_183_565, 8.0), (None, 10.0)]
PURCHASE_ADDITIONAL = [(6_055_070, 8.0), (None, 10.0)]
SHEVACH_SINGLE_CEILING = 4_848_000
RENT_EXEMPT_CEILING = 5_654


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


class MarketParams(BaseModel):
    annual_return: float = Field(7.0, ge=-50, le=100)
    deposit_fee: float = Field(0.0, ge=0, le=20)
    annual_fee: float = Field(0.2, ge=0, le=20)
    tax_rate: float = Field(25.0, ge=0, lt=100)
    tax_basis: Literal["nominal", "real"] = "real"


class Track(BaseModel):
    name: str = ""
    share: float = Field(ge=0, le=100)               # percent of the loan
    years: float = Field(gt=0, le=50)
    rate: float = Field(ge=0, le=40)
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


class PropertyRequest(BaseModel):
    common: Common = Field(default_factory=Common)
    taxes: TaxTables = Field(default_factory=TaxTables)
    scenarios: List[Scenario] = Field(min_length=1, max_length=12)


# --------------------------------------------------------------------------- helpers

def bracket_tax(amount: float, brackets: List[Bracket]) -> float:
    """Progressive tax: each slice of ``amount`` is taxed at its bracket's rate."""
    rows = sorted(brackets, key=lambda b: float("inf") if b.up_to is None else b.up_to)
    tax, prev = 0.0, 0.0
    for b in rows:
        top = float("inf") if b.up_to is None else b.up_to
        if amount > prev:
            tax += (min(amount, top) - prev) * b.rate / 100
        prev = top
    return tax


def purchase_tax_rows(amount: float, brackets: List[Bracket]) -> List[dict]:
    """The slices of ``bracket_tax`` (for the equations panel)."""
    rows = sorted(brackets, key=lambda b: float("inf") if b.up_to is None else b.up_to)
    out, prev = [], 0.0
    for b in rows:
        top = float("inf") if b.up_to is None else b.up_to
        part = max(0.0, min(amount, top) - prev)
        out.append({"from": prev, "to": None if top == float("inf") else top, "rate": b.rate,
                    "part": part, "tax": part * b.rate / 100})
        prev = top
    return out


def annuity(balance: float, rho: float, k: int) -> float:
    """Level payment that repays ``balance`` in ``k`` months at monthly rate ``rho``."""
    if k <= 0:
        return balance
    if rho == 0:
        return balance / k
    return balance * rho / (1 - (1 + rho) ** -k)


def _months(years: float) -> int:
    return max(1, int(round(years * 12)))


class Account:
    """A market account with a cost basis, a deposit fee, tax on realized gains and an overdraft.

    Positive flows first repay the overdraft, then buy (after the deposit fee). Negative flows
    sell proportionally, grossed up so the net equals the need; what cannot be covered becomes
    overdraft debt at ``debt_rate``.
    """

    def __init__(self, p: MarketParams, cpi: np.ndarray, debt_rate: float = 0.0):
        self.q = (1 + p.annual_return / 100) ** (1 / 12) * (1 - p.annual_fee / 100) ** (1 / 12)
        self.delta = p.deposit_fee / 100
        self.tau = p.tax_rate / 100
        self.real = p.tax_basis == "real"
        self.cpi = [float(v) for v in cpi]
        self.dq = (1 + debt_rate / 100) ** (1 / 12)
        self.V = 0.0      # market value
        self.K = 0.0      # cost basis (in month-0 money when the basis is CPI-indexed)
        self.D = 0.0      # overdraft debt
        self.tax_paid = 0.0
        self.went_negative: Optional[int] = None

    def basis(self, m: int) -> float:
        return self.K * self.cpi[m] if self.real else self.K

    def grow(self) -> None:
        self.V *= self.q
        self.D *= self.dq

    def flow(self, x: float, m: int) -> None:
        if x >= 0:
            pay = min(x, self.D)
            self.D -= pay
            x -= pay
            if x > 0:
                self.V += x * (1 - self.delta)
                self.K += x / self.cpi[m] if self.real else x
            return
        need = -x
        if self.V > 0:
            g = max(0.0, 1 - self.basis(m) / self.V)
            unit_net = 1 - self.tau * g
            max_net = self.V * unit_net
            sell = self.V if need >= max_net else need / unit_net
            got = sell * unit_net
            self.tax_paid += sell * self.tau * g
            self.K *= 1 - sell / self.V
            self.V -= sell
            if self.V < 1e-9:
                self.V, self.K = 0.0, 0.0
            need -= got
        if need > 1e-9:
            self.D += need
            if self.went_negative is None:
                self.went_negative = m

    def tax_due(self, m: int) -> float:
        return self.tau * max(0.0, self.V - self.basis(m))

    def net(self, m: int) -> float:
        return self.V - self.tax_due(m) - self.D


# ------------------------------------------------------------------------ simulation

def _common_series(c: Common, T: int):
    m = np.arange(T + 1, dtype=float)
    cpi = (1 + c.inflation / 100) ** (m / 12)
    prev = np.maximum(m - 1, 0) / 12     # growth exponent of a monthly flow paid at month m
    budget = c.budget * ((1 + c.inflation / 100) ** prev if c.index_budget else np.ones(T + 1))
    budget[0] = 0.0
    housing = c.housing_rent * (1 + c.housing_rent_growth / 100) ** prev
    housing[0] = 0.0
    return cpi, prev, budget, housing


def simulate_market(sc: MarketScenario, c: Common, T: int) -> dict:
    cpi, _, budget, housing = _common_series(c, T)
    acc = Account(sc.market, cpi, debt_rate=0.0)
    acc.flow(c.equity, 0)
    value, tax, debt, flow = (np.zeros(T + 1) for _ in range(4))
    for m in range(T + 1):
        if m:
            acc.grow()
            flow[m] = budget[m] - housing[m]
            acc.flow(flow[m], m)
        value[m], tax[m], debt[m] = acc.V, acc.tax_due(m), acc.D
    net = value - tax - debt
    warnings = []
    if acc.went_negative is not None:
        warnings.append(f"שכר הדירה גבוה מהתקציב החודשי: מחודש {acc.went_negative} נוצר חוב בתיק.")
    return {
        "net": net,
        "parts": {"portfolio": value, "portfolio_tax": tax, "debt": debt},
        "flows": {"budget": budget, "housing": housing, "invested": flow},
        "summary": {"start_invested": c.equity * (1 - sc.market.deposit_fee / 100),
                    "q": acc.q, "tax_paid": acc.tax_paid},
        "warnings": warnings,
        "cpi": cpi,
    }


def simulate_apartment(sc: ApartmentScenario, c: Common, taxes: TaxTables, T: int) -> dict:
    cpi, prev, budget, housing = _common_series(c, T)
    if sc.usage == "live":
        housing = np.zeros(T + 1)
    warnings: List[str] = []
    P0 = sc.price
    loan = P0 * sc.ltv / 100

    # Mortgage mix (shares normalized to 100%).
    tracks = [t for t in sc.tracks if t.share > 0]
    total_share = sum(t.share for t in tracks)
    if loan > 0 and not tracks:
        raise ValueError(f"{sc.name or 'דירה'}: יש משכנתא ({sc.ltv:g}%) אבל אין מסלולים בתמהיל")
    if tracks and abs(total_share - 100) > 0.01:
        warnings.append(f"סכום החלקים בתמהיל הוא {total_share:g}%, והוא נורמל ל-100%.")
    tr_state = []
    for t in tracks:
        L = loan * t.share / total_share
        n = _months(t.years)
        rho = t.rate / 1200
        tr_state.append({"L": float(L), "n": n, "rho": rho, "bal": L, "indexed": t.indexed, "method": t.method,
                         "first_payment": None, "interest": 0.0, "paid": 0.0, "name": t.name})
        if t.years > 30:
            warnings.append(f"מסלול \"{t.name or 'ללא שם'}\" ארוך מ-30 שנה, התקופה המקסימלית שבנק ישראל מתיר.")

    # Month 0: the purchase.
    brackets = taxes.purchase_single if sc.status == "single" else taxes.purchase_additional
    ptax = bracket_tax(P0, brackets)
    costs_total = sum(x.amount for x in sc.costs)
    deductible = ptax + sum(x.amount for x in sc.costs if x.deductible)
    down = P0 - loan
    upfront = down + ptax + costs_total
    side_start = c.equity - upfront
    acc = Account(sc.side, cpi, debt_rate=sc.debt_rate)
    acc.flow(side_start, 0)
    if side_start < 0:
        warnings.append(f"ההון העצמי קטן מהנדרש לרכישה ב-₪{-side_start:,.0f}. ההפרש נרשם כחוב בריבית {sc.debt_rate:g}% לשנה.")
    ltv_cap = 75 if sc.status == "single" else 50
    if sc.ltv > ltv_cap + 1e-9:
        kind = "לדירה יחידה" if sc.status == "single" else "לדירה נוספת"
        warnings.append(f"אחוז המימון {sc.ltv:g}% גבוה מהמקסימום של בנק ישראל {kind} ({ltv_cap}%).")

    keys = ["home", "mortgage", "side", "side_tax", "side_debt", "sale_costs", "prepay", "shevach"]
    parts = {k: np.zeros(T + 1) for k in keys}
    fkeys = ["budget", "housing", "payment", "interest", "rent", "rent_tax", "running", "flow"]
    flows = {k: np.zeros(T + 1) for k in fkeys}
    flows["budget"], flows["housing"] = budget, housing
    a_g = (1 + sc.appreciation / 100) ** (1 / 12)
    rent_g = 1 + sc.rent_growth / 100
    occupancy = 1 - sc.vacancy_months / 12
    home = P0
    pti_max = 0.0
    for m in range(T + 1):
        if m:
            home_prev = home
            home = P0 * a_g ** m
            acc.grow()
            pay = interest = 0.0
            for s in tr_state:
                if s["bal"] <= 1e-9:
                    continue
                if s["indexed"]:
                    s["bal"] *= float(cpi[m] / cpi[m - 1])
                k = s["n"] - m + 1                  # months left including this one
                if k <= 0:                         # should not happen: paid off at k == 1
                    continue
                i_m = s["bal"] * s["rho"]
                if s["method"] == "spitzer":
                    p = annuity(s["bal"], s["rho"], k)
                    principal = p - i_m
                else:
                    principal = s["bal"] / k
                    p = principal + i_m
                s["bal"] = max(0.0, s["bal"] - principal)
                if k == 1:
                    s["bal"] = 0.0
                if s["first_payment"] is None:
                    s["first_payment"] = p
                s["interest"] += i_m
                s["paid"] += p
                pay += p
                interest += i_m
            rent = 0.0
            rent_tax = 0.0
            running = home_prev * sc.maintenance_pct / 1200 + (sc.insurance + sc.other_monthly) * cpi[m - 1]
            if sc.usage == "rent":
                rent = sc.rent * rent_g ** prev[m] * occupancy
                if sc.rent_tax == "exempt":
                    X = taxes.rent_exempt_ceiling * cpi[m - 1]
                    taxable = 0.0 if rent <= X else (2 * (rent - X) if rent < 2 * X else rent)
                    rent_tax = sc.marginal_rate / 100 * taxable
                elif sc.rent_tax == "ten":
                    rent_tax = 0.10 * rent
                elif sc.rent_tax == "marginal":
                    rent_tax = sc.marginal_rate / 100 * max(0.0, rent - running - interest)
            flow = budget[m] - housing[m] - pay - running + rent - rent_tax
            acc.flow(flow, m)
            flows["payment"][m], flows["interest"][m] = pay, interest
            flows["rent"][m], flows["rent_tax"][m] = rent, rent_tax
            flows["running"][m], flows["flow"][m] = running, flow
            if c.income > 0:
                pti_max = max(pti_max, pay / (c.income * (cpi[m - 1] if c.index_budget else 1)))
        bal = sum(s["bal"] for s in tr_state)
        sale = home * sc.selling_cost_pct / 100
        g_nom = home - sale - P0 - deductible
        g_real = home - sale - (P0 + deductible) * cpi[m]
        taxable = max(0.0, g_real) if g_nom > 0 else 0.0
        if sc.status == "single":
            ceiling = taxes.shevach_single_ceiling * cpi[m]
            taxable *= max(0.0, home - ceiling) / home if home > 0 else 0.0
        parts["home"][m] = home
        parts["mortgage"][m] = bal
        parts["side"][m] = acc.V
        parts["side_tax"][m] = acc.tax_due(m)
        parts["side_debt"][m] = acc.D
        parts["sale_costs"][m] = sale
        parts["prepay"][m] = bal * sc.prepay_fee_pct / 100
        parts["shevach"][m] = taxes.shevach_rate / 100 * taxable

    p = parts
    net = (p["home"] - p["sale_costs"] - p["shevach"] - p["mortgage"] - p["prepay"]
           + p["side"] - p["side_tax"] - p["side_debt"])
    if acc.went_negative is not None and side_start >= 0:
        warnings.append(f"ההוצאות על הדירה גבוהות מהתקציב: מחודש {acc.went_negative} חשבון הצד נכנס לחוב "
                        f"בריבית {sc.debt_rate:g}% לשנה.")
    if c.income > 0 and pti_max > 0.40:
        warnings.append(f"ההחזר החודשי מגיע ל-{pti_max * 100:.0f}% מההכנסה. בנק ישראל מגביל ל-50%, "
                        "ובנקים בדרך כלל מאשרים עד כ-40%.")
    if p["mortgage"][T] > 1:
        warnings.append(f"בסוף התקופה נשארה יתרת משכנתא של ₪{p['mortgage'][T]:,.0f}; היא מנוכה מהשווי.")
    summary = {
        "loan": loan, "down_payment": down, "purchase_tax": ptax,
        "purchase_tax_rows": purchase_tax_rows(P0, brackets),
        "costs_total": costs_total, "deductible": deductible, "upfront": upfront, "side_start": side_start,
        "tracks": [{"name": s["name"], "loan": s["L"], "months": s["n"], "rate_monthly": s["rho"],
                    "indexed": s["indexed"], "method": s["method"], "first_payment": s["first_payment"] or 0.0,
                    "interest_paid": s["interest"], "total_paid": s["paid"]} for s in tr_state],
        "first_payment": float(flows["payment"][1]) if T >= 1 else 0.0,
        "first_flow": float(flows["flow"][1]) if T >= 1 else 0.0,
        "q_side": acc.q, "pti_max": pti_max, "side_tax_paid": acc.tax_paid,
    }
    return {"net": net, "parts": parts, "flows": flows, "summary": summary, "warnings": warnings, "cpi": cpi}


def simulate_scenario(sc, c: Common, taxes: TaxTables) -> dict:
    T = _months(c.years)
    if sc.kind == "market":
        return simulate_market(sc, c, T)
    return simulate_apartment(sc, c, taxes, T)


# --------------------------------------------------------------------------- metrics

METRICS = ("final", "sum", "pv_final", "pv_sum", "irr")


def irr_monthly(flows: np.ndarray) -> Optional[float]:
    """Monthly rate x with sum(flows[m] / (1+x)^m) = 0, by bisection (None if no sign change)."""
    m = np.arange(len(flows))

    def npv(x):
        return float(np.sum(flows / (1 + x) ** m))

    lo, hi = -0.5, 0.5                    # monthly: -99.98% .. +12,875% a year
    with np.errstate(all="ignore"):
        f_lo, f_hi = npv(lo), npv(hi)
    if not (np.isfinite(f_lo) and np.isfinite(f_hi)) or f_lo * f_hi > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        f_mid = npv(mid)
        if f_mid == 0 or hi - lo < 1e-12:
            return mid
        if (f_mid > 0) == (f_lo > 0):
            lo, f_lo = mid, f_mid
        else:
            hi = mid
    return (lo + hi) / 2


def metrics(net: np.ndarray, cpi: np.ndarray, c: Common, budget: np.ndarray) -> dict:
    T = len(net) - 1
    disp = net / cpi if c.real else net
    disc = (1 + c.discount_rate / 100) ** (np.arange(T + 1) / 12)
    cash = -budget.copy()
    cash[0] = -c.equity
    cash[T] += net[T]
    x = irr_monthly(cash)
    irr = None
    if x is not None:
        irr = (1 + x) ** 12 - 1
        if c.real:
            irr = (1 + irr) / (1 + c.inflation / 100) - 1
        irr *= 100
    return {
        "final": float(disp[T]),
        "sum": float(disp.sum()),
        "mean": float(disp.mean()),
        "pv_final": float(net[T] / disc[T]),
        "pv_sum": float(np.sum(net / disc)),
        "irr": irr,
        "min": float(disp.min()),
        "min_month": int(disp.argmin()),
    }


def run_property(req: PropertyRequest) -> dict:
    c = req.common
    T = _months(c.years)
    out = []
    for sc in req.scenarios:
        r = simulate_scenario(sc, c, req.taxes)
        r["metrics"] = metrics(r["net"], r["cpi"], c, r["flows"]["budget"])
        r["id"], r["name"], r["kind"] = sc.id, sc.name, sc.kind
        out.append(r)
    return {"months": T, "cpi": out[0]["cpi"], "scenarios": out}


# ---------------------------------------------------------------- solve for unknown

def _metric_of(req: PropertyRequest, sid: str, metric: str) -> float:
    sc = next((s for s in req.scenarios if s.id == sid), None)
    if sc is None:
        raise ValueError(f"תרחיש לא קיים: {sid}")
    r = simulate_scenario(sc, req.common, req.taxes)
    v = metrics(r["net"], r["cpi"], req.common, r["flows"]["budget"])[metric]
    return float("nan") if v is None else v


def _set_path(d: dict, path: List[Union[str, int]], value: float) -> None:
    cur = d
    for k in path[:-1]:
        cur = cur[k]
    old = cur[path[-1]]          # KeyError / IndexError / TypeError for a bad path
    if isinstance(old, bool) or not isinstance(old, (int, float)):
        raise ValueError("אפשר לפתור רק פרמטר מספרי")
    cur[path[-1]] = value


def _param_path(req: PropertyRequest, scope: str, key: str) -> List[Union[str, int]]:
    """``scope`` is "common" or a scenario id; ``key`` is a dotted path (``tracks.0.rate``)."""
    parts: List[Union[str, int]] = [int(p) if p.isdigit() else p for p in key.split(".")]
    if scope == "common":
        return ["common", *parts]
    idx = next((i for i, s in enumerate(req.scenarios) if s.id == scope), None)
    if idx is None:
        raise ValueError(f"תרחיש לא קיים: {scope}")
    return ["scenarios", idx, *parts]


def solve_equal(req: PropertyRequest, a: str, b: str, metric: str, scope: str, key: str,
                lo: float, hi: float, n_scan: int = 48) -> dict:
    """All x in [lo, hi] where scenario ``a`` and scenario ``b`` score the same on ``metric``.

    Scans f(x) = metric_a(x) - metric_b(x) on a grid, then refines every sign change by
    bisection. f need not be monotone (several roots are all reported).
    """
    if metric not in METRICS:
        raise ValueError(f"מטריקה לא מוכרת: {metric}")
    if a == b:
        raise ValueError("בחר שני תרחישים שונים להשוואה")
    if not hi > lo:
        raise ValueError("הגבול העליון חייב להיות גדול מהתחתון")
    base = req.model_dump()
    path = _param_path(req, scope, key)
    try:
        _set_path(base, path, lo)
    except (KeyError, IndexError, TypeError):
        raise ValueError(f"פרמטר לא קיים: {key}") from None
    touches_a = scope in ("common", a)
    touches_b = scope in ("common", b)
    fixed_a = None if touches_a else _metric_of(req, a, metric)
    fixed_b = None if touches_b else _metric_of(req, b, metric)

    def f(x: float) -> float:
        d = req.model_dump()
        _set_path(d, path, x)
        try:
            r = PropertyRequest.model_validate(d)
        except ValidationError:
            return float("nan")
        va = _metric_of(r, a, metric) if touches_a else fixed_a
        vb = _metric_of(r, b, metric) if touches_b else fixed_b
        return va - vb

    xs = np.linspace(lo, hi, n_scan + 1)
    ys = np.array([f(x) for x in xs])
    roots = []
    for i in range(n_scan):
        y0, y1 = ys[i], ys[i + 1]
        if not (np.isfinite(y0) and np.isfinite(y1)):
            continue
        if y0 == 0:
            roots.append(float(xs[i]))
            continue
        if y0 * y1 > 0:
            continue
        x0, x1 = xs[i], xs[i + 1]
        for _ in range(60):
            mid = (x0 + x1) / 2
            ym = f(mid)
            if not np.isfinite(ym):
                break
            if (ym > 0) == (y0 > 0):
                x0, y0 = mid, ym
            else:
                x1 = mid
            if x1 - x0 < 1e-9 * max(1.0, abs(mid)):
                break
        roots.append(float((x0 + x1) / 2))
    if np.isfinite(ys[-1]) and ys[-1] == 0:
        roots.append(float(xs[-1]))
    current = req.model_dump()
    cur_v = current
    for k in path:
        cur_v = cur_v[k]
    return {"roots": roots, "scan_x": xs.tolist(), "scan_y": [None if not np.isfinite(v) else float(v) for v in ys],
            "current": float(cur_v), "current_diff": f(float(cur_v))}


__all__ = ["PropertyRequest", "Common", "TaxTables", "MarketParams", "Track", "Cost", "MarketScenario",
           "ApartmentScenario", "Bracket", "bracket_tax", "annuity", "run_property", "simulate_scenario",
           "solve_equal", "irr_monthly", "METRICS"]
