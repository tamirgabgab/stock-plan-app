"""Vectorized holdings with cost basis and tax state, shared by the accumulation and the
withdrawal simulators.

State is (R, A): realizations × assets. Every method works on all realizations at once.

Tax: realized losses build a shield that offsets later gains. With a real tax basis the
cost basis is CPI-indexed; an inflationary gain is not taxed and cannot create a
deductible loss (only a nominal loss can), as in Israeli capital-gains rules.

Israeli savings accounts (קרן השתלמות, קופת גמל להשקעה) keep part of the money tax-exempt:
a "split" book tracks the exempt part (value and cost basis, ``Ve``/``Bne``/``Bce``) inside
the totals. Every trade touches both parts pro rata. The exempt part's gain is taxed only
while ``exempt`` is False (the simulator sets it: before six years in a קרן השתלמות, a lump
sum from a קופת גמל); the rest (deposits above the yearly ceiling) is always taxed.
"""
from __future__ import annotations

import numpy as np

from .models import REBALANCE_PERIODS


class Book:
    def __init__(self, R: int, A: int, tax_rate: float, real_tax: bool):
        self.rate = tax_rate                 # fraction, e.g. 0.25
        self.real_tax = real_tax
        self.V = np.zeros((R, A))            # market value per asset
        self.Bn = np.zeros((R, A))           # nominal cost basis
        self.Bc = np.zeros((R, A))           # sum of (amount / CPI at purchase): indexed basis = Bc * CPI_now
        self.shield = np.zeros(R)            # accumulated realized losses
        self.tax_paid = np.zeros(R)          # running total of the tax paid on sales
        self.fees = np.zeros(R)              # running total of the management fees charged
        self.dividend_tax = np.zeros(R)      # the part of ``tax_paid`` paid on dividends
        # Split book (Israeli savings accounts): the tax-exempt part of the holdings.
        self.split = False
        self.exempt = False                  # the exempt part is tax-free right now
        self.Ve = np.zeros((R, A))
        self.Bne = np.zeros((R, A))
        self.Bce = np.zeros((R, A))
        # Optional trade journal for a single-realization run (row 0 only). The simulators
        # set ``m`` (month) and ``ctx`` (why the trade happens) before each operation.
        self.journal: list | None = None
        self.m = 0
        self.ctx = ""

    def _log(self, kind: str, amounts: np.ndarray, tax: float = 0.0, gains: np.ndarray | None = None) -> None:
        if self.journal is None:
            return
        pos = np.maximum(gains, 0.0) if gains is not None else None
        pos_sum = float(pos.sum()) if pos is not None else 0.0
        for a, amt in enumerate(amounts):
            if amt > 1e-9:
                share = tax * (pos[a] / pos_sum if pos_sum > 0 else amt / amounts.sum())
                self.journal.append({"m": int(self.m), "ctx": self.ctx, "kind": kind, "asset": a,
                                     "amount": float(amt), "tax": float(share)})

    @property
    def total(self) -> np.ndarray:
        return self.V.sum(axis=1)

    def _gain(self, V, Bn, Bc, cpi_now) -> np.ndarray:
        if not self.real_tax:
            return V - Bn
        indexed = Bc * cpi_now[:, None]
        return np.where(V >= indexed, V - indexed, -np.maximum(Bn - V, 0.0))

    def gains(self, cpi_now) -> np.ndarray:
        """(R, A) taxable gain per asset if everything were sold now."""
        if not self.split:
            return self._gain(self.V, self.Bn, self.Bc, cpi_now)
        taxed = self._gain(self.V - self.Ve, self.Bn - self.Bne, self.Bc - self.Bce, cpi_now)
        return taxed if self.exempt else taxed + self._gain(self.Ve, self.Bne, self.Bce, cpi_now)

    def tax_on(self, G: np.ndarray) -> np.ndarray:
        """Tax due on realized gains G (R,), consuming or building the loss shield."""
        taxable = np.maximum(G - self.shield, 0.0)
        self.shield = np.where(G > 0, np.maximum(self.shield - G, 0.0), self.shield - G)
        tax = self.rate * taxable
        self.tax_paid = self.tax_paid + tax
        return tax

    def liquidation_value(self, cpi_now) -> np.ndarray:
        """(R,) value after selling everything and paying the tax (shield is not consumed)."""
        G = self.gains(cpi_now).sum(axis=1)
        return self.total - self.rate * np.maximum(G - self.shield, 0.0)

    def buy(self, amount: np.ndarray, w: np.ndarray, cpi_now, exempt: np.ndarray | None = None) -> None:
        """Buy ``amount`` (R,) at weights ``w``; ``exempt`` (R,) of it is the tax-exempt part
        of a split book (all of it when omitted)."""
        add = amount[:, None] * w
        self._log("buy", add[0])
        self.V += add
        self.Bn += add
        if self.real_tax:
            self.Bc += add / cpi_now[:, None]
        if self.split:
            ex = add if exempt is None else exempt[:, None] * w
            self.Ve += ex
            self.Bne += ex
            if self.real_tax:
                self.Bce += ex / cpi_now[:, None]

    def sell_fraction(self, frac: np.ndarray, cpi_now) -> tuple[np.ndarray, np.ndarray]:
        """Sell ``frac`` (R, A) of each holding. Returns (gross proceeds, tax) per realization."""
        Ga = self.gains(cpi_now) * frac
        G = Ga.sum(axis=1)
        gross = (self.V * frac).sum(axis=1)
        tax = self.tax_on(G)
        self._log("sell", (self.V * frac)[0], float(tax[0]), Ga[0])
        self.V *= 1 - frac
        self.Bn *= 1 - frac
        self.Bc *= 1 - frac
        if self.split:
            self.Ve *= 1 - frac
            self.Bne *= 1 - frac
            self.Bce *= 1 - frac
        return gross, tax

    def withdraw_net(self, want: np.ndarray, cpi_now) -> np.ndarray:
        """Sell a pro-rata slice of the whole portfolio so that the cash after tax is ``want``.

        For a slice f the proceeds are f*V and the realized gain f*G, so
        f*V - tau*max(f*G - H, 0) = want has a closed form on each side of the shield.
        Returns the net cash actually obtained (less than ``want`` when the portfolio runs out).
        """
        V = self.total
        G = self.gains(cpi_now).sum(axis=1)
        H = self.shield
        with np.errstate(divide="ignore", invalid="ignore"):
            f0 = np.where(V > 0, want / V, 0.0)                       # no tax: gain within the shield
            f1 = np.where(V > 0, (want - self.rate * H) / (V - self.rate * G), 0.0)
        f = np.where(f0 * G <= H, f0, f1)
        f = np.clip(np.nan_to_num(f, nan=0.0), 0.0, 1.0)
        gross, tax = self.sell_fraction(np.repeat(f[:, None], self.V.shape[1], axis=1), cpi_now)
        return gross - tax

    def reallocate(self, w: np.ndarray, cpi_now, taxable: bool, rows: np.ndarray | None = None) -> None:
        """Move the portfolio to weights ``w`` (a stage switch or a rebalance).

        ``rows`` (bool, R) limits the move to some realizations; the others are left as they are.
        Tax-free: the cost basis travels with the money (tax deferred to the end).
        Taxable: only the holdings that shrink are sold; the cash after tax buys the ones
        that grow, and a holding that is kept keeps its basis. A split book (an Israeli
        savings account) always moves tax-free.
        """
        on = np.ones(self.V.shape[0], dtype=bool) if rows is None else rows
        log = bool(on[0])
        target = self.total[:, None] * w
        if not taxable:
            if log:
                delta = (target - self.V)[0]
                self._log("sell", np.maximum(-delta, 0.0))
                self._log("buy", np.maximum(delta, 0.0))
            m = on[:, None]
            self.V = np.where(m, target, self.V)
            self.Bn = np.where(m, self.Bn.sum(axis=1)[:, None] * w, self.Bn)
            self.Bc = np.where(m, self.Bc.sum(axis=1)[:, None] * w, self.Bc)
            if self.split:
                self.Ve = np.where(m, self.Ve.sum(axis=1)[:, None] * w, self.Ve)
                self.Bne = np.where(m, self.Bne.sum(axis=1)[:, None] * w, self.Bne)
                self.Bce = np.where(m, self.Bce.sum(axis=1)[:, None] * w, self.Bce)
            return
        assert not self.split, "a split book moves tax-free"
        sell = np.where(on[:, None], np.maximum(self.V - target, 0.0), 0.0)
        frac = np.divide(sell, self.V, out=np.zeros_like(self.V), where=self.V > 0)
        journal, self.journal = self.journal, (self.journal if log else None)
        gross, tax = self.sell_fraction(frac, cpi_now)
        cash = gross - tax
        deficit = np.where(on[:, None], np.maximum(target - self.V, 0.0), 0.0)
        dsum = deficit.sum(axis=1)
        scale = np.divide(cash, dsum, out=np.zeros_like(cash), where=dsum > 0)
        add = deficit * scale[:, None]
        self._log("buy", add[0])
        self.journal = journal
        self.V += add
        self.Bn += add
        if self.real_tax:
            self.Bc += add / cpi_now[:, None]

    def drift(self, w: np.ndarray) -> np.ndarray:
        """(R,) largest distance of a weight from ``w``, in fractions (0 for an empty book)."""
        tot = self.total
        cur = np.divide(self.V, tot[:, None], out=np.repeat(w[None, :], len(tot), axis=0), where=tot[:, None] > 0)
        return np.abs(cur - w).max(axis=1)

    def grow(self, growth: np.ndarray, fee: float) -> None:
        grown = self.V * growth
        self.V = grown * fee
        if self.split:
            self.Ve = self.Ve * growth * fee
        if fee != 1.0:
            self.fees = self.fees + grown.sum(axis=1) * (1.0 - fee)

    def pay_dividends(self, rate: np.ndarray, cpi_now) -> None:
        """Tax the dividends paid this month: ``rate`` (A,) is each asset's monthly yield.

        The prices are total-return (dividends reinvested), so a dividend d already sits in
        V. Paying it out and reinvesting what is left after the tax leaves V - tax, with
        d - tax of new cost basis. The tax uses (and builds) the loss shield like any gain.
        """
        d = self.V * rate
        D = d.sum(axis=1)
        if not (D > 0).any():
            return
        tax = self.tax_on(D)
        self.dividend_tax = self.dividend_tax + tax
        share = d * np.divide(tax, D, out=np.zeros_like(D), where=D > 0)[:, None]
        self.V -= share
        self.Bn += d - share
        if self.real_tax:
            self.Bc += (d - share) / cpi_now[:, None]


def rebalance_rows(book: Book, rule: str, band: float, w: np.ndarray, j: int) -> np.ndarray | None:
    """Which realizations rebalance at month ``j`` of a stage (None = none of them).

    Periodic rules rebalance every 1, 3 or 12 months counted from the stage start (the stage
    start itself is already a reallocation); "band" rebalances whenever a weight is more than
    ``band`` percentage points away from its target.
    """
    if rule == "none" or j == 0 or (w > 0).sum() < 2:
        return None
    if rule == "band":
        rows = book.drift(w) > band / 100
        return rows if rows.any() else None
    period = REBALANCE_PERIODS[rule]
    return np.ones(book.V.shape[0], dtype=bool) if j % period == 0 else None


SHORT_TOLERANCE = 1e-4   # a withdrawal paid within 0.01% counts as paid (solver rounding)


def paid_short(got: np.ndarray, want: np.ndarray) -> np.ndarray:
    """(R,) bool: the withdrawal ``want`` was not paid in full (more than 0.01% missing)."""
    return want - got > SHORT_TOLERANCE * want + 1e-9


def one_time_want(stage, j: int, total: np.ndarray, sc: np.ndarray) -> np.ndarray:
    """(R,) the one-time withdrawal at the start of a stage (zero in its other months)."""
    if j != 0 or stage.one_time <= 0:
        return np.zeros(len(total))
    return stage.one_time / 100 * total if stage.one_time_unit == "pct" else stage.one_time * sc


def withdrawal_want(stage, j: int, total: np.ndarray, start: np.ndarray, sc: np.ndarray,
                    rate: np.ndarray | None = None, amount: np.ndarray | None = None) -> np.ndarray:
    """(R,) net cash a withdrawal stage asks for at its month ``j``, nominal.

    Shared by the Trinity tab and the withdrawal stages of a lifecycle plan. ``start`` is
    the "initial" basis in input units (the Trinity start amount, or the balance when the
    lifecycle's withdrawals begin), ``sc`` the nominal value of one input unit now (it
    carries the CPI indexation), ``total`` the market value of the holdings now. ``rate``
    and ``amount`` override the stage's annual rate or its fixed monthly amount (solve modes).
    """
    R = len(total)
    rate_v = rate if rate is not None else np.full(R, float(stage.rate))
    basis = stage.basis
    if amount is not None:
        fixed, basis = amount, "initial"                 # solving for a fixed amount
    elif stage.rate_unit == "money" and rate is None:
        fixed = np.full(R, float(stage.amount))          # per month, input units
    else:
        fixed = rate_v / 1200 * start                    # percent per year of the start amount
    want = one_time_want(stage, j, total, sc)
    if basis == "current":
        monthly = rate_v / 1200 * total
        pct = stage.guard_unit == "pct"
        if stage.floor > 0:
            monthly = np.maximum(monthly, (stage.floor / 1200 * start if pct else stage.floor) * sc)
        if stage.ceiling > 0:
            monthly = np.minimum(monthly, (stage.ceiling / 1200 * start if pct else stage.ceiling) * sc)
    else:
        monthly = fixed * sc
    return want + monthly


# ------------------------------------------------------------ advanced withdrawal methods

WITHDRAW_METHODS = ("fixed", "gk", "vpw")
GK_PRESERVE_MONTHS = 180       # the capital-preservation cut is skipped in the last 15 years


def gk_update(W, total, last_total, infl, r0, band, step, months_left):
    """Guyton-Klinger's yearly review of the monthly withdrawal ``W`` (nominal), vectorized.

    1. Inflation: W grows with the year's inflation ``infl``, except after a year in which
       the portfolio fell (``total < last_total``) while the withdrawal rate is above the
       initial rate ``r0``: then it stays.
    2. Capital preservation: a withdrawal rate above r0 * (1 + band) cuts W by ``step``
       (not in the last 15 years). 3. Prosperity: below r0 * (1 - band) raises it by ``step``.
    Rates are yearly (12 W / total); ``band`` and ``step`` are fractions.
    """
    with np.errstate(divide="ignore", invalid="ignore"):
        rate = np.where(total > 0, 12 * W * infl / total, np.inf)
        freeze = (total < last_total) & (rate > r0)
        W = np.where(freeze, W, W * infl)
        rate = np.where(total > 0, 12 * W / total, np.inf)
    cut = (rate > r0 * (1 + band)) & (months_left > GK_PRESERVE_MONTHS)
    up = rate < r0 * (1 - band)
    return np.where(cut, W * (1 - step), np.where(up, W * (1 + step), W))


def vpw_payment(total, rate_pct: float, months_left: int):
    """(R,) VPW: the level monthly payment, paid at the start of each month, that spends
    ``total`` in ``months_left`` months at an expected annual return of ``rate_pct`` (an
    annuity due, recomputed every month). The last month takes everything that is left."""
    i = (1 + rate_pct / 100) ** (1 / 12) - 1
    n = max(int(months_left), 1)
    if abs(i) < 1e-12:
        return total / n
    return total * i / (1 - (1 + i) ** -n) / (1 + i)


class StageWithdrawals:
    """The withdrawal rule of one withdrawal stage, with the state Guyton-Klinger needs.

    ``method``: "fixed" (``withdrawal_want``), "gk" (Guyton-Klinger guardrails around the
    fixed withdrawal, reviewed every 12 months of the stage) or "vpw" (spend the balance over
    the months left in the plan; ``total`` is then the net value, after the tax of selling). ``spending_change`` (percent per year) scales the fixed and
    Guyton-Klinger withdrawals by a step every stage year (spending that falls or rises with
    age). ``months_left`` counts from the stage start to the end of the plan.
    """

    def __init__(self, stage, months_left: int):
        self.stage = stage
        self.months_left = months_left
        self.W = None

    @property
    def covers_spending(self) -> bool:
        """The rule is a spending need (other income pays part of it), not a share of the
        balance: a fixed amount, a percent of the initial basis, or Guyton-Klinger."""
        st = self.stage
        return st.method == "gk" or (st.method == "fixed" and (st.rate_unit == "money" or st.basis == "initial"))

    def want(self, j: int, total, start, sc, rate=None, amount=None):
        st = self.stage
        one = one_time_want(st, j, total, sc)
        if st.method == "vpw":
            return one + vpw_payment(np.maximum(total - one, 0.0), st.vpw_rate, self.months_left - j)
        growth = (1 + st.spending_change / 100) ** (j // 12)
        if st.method != "gk":
            return withdrawal_want(st, j, total, start, sc, rate=rate, amount=amount) * growth
        if j == 0:
            R = len(total)
            if amount is not None:
                units = amount
            elif st.rate_unit == "money" and rate is None:
                units = np.full(R, float(st.amount))
            else:
                units = (rate if rate is not None else np.full(R, float(st.rate))) / 1200 * start
            self.W = units * sc
            base = np.maximum(total - one, 0.0)
            with np.errstate(divide="ignore", invalid="ignore"):
                self.r0 = np.where(base > 0, 12 * self.W / base, 0.0)
            self.last_total, self.last_sc = total, sc
        elif j % 12 == 0:
            self.W = gk_update(self.W, total, self.last_total, sc / self.last_sc, self.r0,
                               st.gk_band / 100, st.gk_step / 100, self.months_left - j)
            self.last_total, self.last_sc = total, sc
        return one + self.W * growth


def income_months(req, T: int) -> np.ndarray:
    """(T+1,) other income per plan month in input units (pensions, from an age on).

    Paid during the withdrawal stages; it lowers what a spending rule takes from the
    portfolio (see ``StageWithdrawals.covers_spending``). Indexed like the withdrawals.
    """
    out = np.zeros(T + 1)
    if not req.incomes or req.start_age <= 0:
        return out
    age = req.start_age + np.arange(T + 1) / 12
    for inc in req.incomes:
        out += np.where(age >= inc.age - 1e-9, inc.amount, 0.0)
    return out
