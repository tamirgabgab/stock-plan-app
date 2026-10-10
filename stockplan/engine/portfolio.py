"""Vectorized holdings with cost basis and tax state, shared by the accumulation and the
withdrawal simulators.

State is (R, A): realizations × assets. Every method works on all realizations at once.

Tax: realized losses build a shield that offsets later gains. With a real tax basis the
cost basis is CPI-indexed; an inflationary gain is not taxed and cannot create a
deductible loss (only a nominal loss can), as in Israeli capital-gains rules.
"""
from __future__ import annotations

import numpy as np


class Book:
    def __init__(self, R: int, A: int, tax_rate: float, real_tax: bool):
        self.rate = tax_rate                 # fraction, e.g. 0.25
        self.real_tax = real_tax
        self.V = np.zeros((R, A))            # market value per asset
        self.Bn = np.zeros((R, A))           # nominal cost basis
        self.Bc = np.zeros((R, A))           # sum of (amount / CPI at purchase): indexed basis = Bc * CPI_now
        self.shield = np.zeros(R)            # accumulated realized losses
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

    def gains(self, cpi_now) -> np.ndarray:
        """(R, A) taxable gain per asset if everything were sold now."""
        if not self.real_tax:
            return self.V - self.Bn
        indexed = self.Bc * cpi_now[:, None]
        return np.where(self.V >= indexed, self.V - indexed, -np.maximum(self.Bn - self.V, 0.0))

    def tax_on(self, G: np.ndarray) -> np.ndarray:
        """Tax due on realized gains G (R,), consuming or building the loss shield."""
        taxable = np.maximum(G - self.shield, 0.0)
        self.shield = np.where(G > 0, np.maximum(self.shield - G, 0.0), self.shield - G)
        return self.rate * taxable

    def liquidation_value(self, cpi_now) -> np.ndarray:
        """(R,) value after selling everything and paying the tax (shield is not consumed)."""
        G = self.gains(cpi_now).sum(axis=1)
        return self.total - self.rate * np.maximum(G - self.shield, 0.0)

    def buy(self, amount: np.ndarray, w: np.ndarray, cpi_now) -> None:
        add = amount[:, None] * w
        self._log("buy", add[0])
        self.V += add
        self.Bn += add
        if self.real_tax:
            self.Bc += add / cpi_now[:, None]

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

    def reallocate(self, w: np.ndarray, cpi_now, taxable: bool) -> None:
        """Move the whole portfolio to weights ``w`` at a stage switch.

        Tax-free: the cost basis travels with the money (tax deferred to the end).
        Taxable: only the holdings that shrink are sold; the cash after tax buys the ones
        that grow, and a holding kept in the next stage keeps its basis.
        """
        target = self.total[:, None] * w
        if not taxable:
            delta = (target - self.V)[0]
            self._log("sell", np.maximum(-delta, 0.0))
            self._log("buy", np.maximum(delta, 0.0))
            self.V = target
            self.Bn = self.Bn.sum(axis=1)[:, None] * w
            self.Bc = self.Bc.sum(axis=1)[:, None] * w
            return
        sell = np.maximum(self.V - target, 0.0)
        frac = np.divide(sell, self.V, out=np.zeros_like(self.V), where=self.V > 0)
        gross, tax = self.sell_fraction(frac, cpi_now)
        cash = gross - tax
        deficit = np.maximum(target - self.V, 0.0)
        dsum = deficit.sum(axis=1)
        scale = np.divide(cash, dsum, out=np.zeros_like(cash), where=dsum > 0)
        add = deficit * scale[:, None]
        self._log("buy", add[0])
        self.V += add
        self.Bn += add
        if self.real_tax:
            self.Bc += add / cpi_now[:, None]

    def grow(self, growth: np.ndarray, fee: float) -> None:
        self.V *= growth * fee
