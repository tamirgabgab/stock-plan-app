"""The vectorized month-by-month simulator and the market account it uses.

Part of the ``property`` package; see its docstring for the model."""
from __future__ import annotations

from typing import Dict, List

import numpy as np
import pandas as pd

from .paths import Paths, annuity, bracket_tax, holdings_key, months_of, purchase_tax_rows, schedule_at


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
