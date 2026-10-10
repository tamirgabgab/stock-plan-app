"""Vectorized accumulation simulator.

All realizations (start dates) are simulated at once: the state is a matrix of shape
(R, A) — realizations × assets — and the only Python loop is over months.

Per month m the order is: stage transition (if a new stage starts), deposits, record
the path point, then market growth to month m+1. Within a stage each deposit is split
by the stage weights and held (no rebalancing). At a stage transition the portfolio is
reallocated to the new weights, either tax-free (cost basis carried over, so the tax is
deferred to the end) or as a taxable sale of the holdings that shrink.

Real mode: amounts entered by the user (deposits, target) are in today's money, i.e. the
CPI of the last data month; see ``deposit_scale``.

Tax: realized losses build a shield that offsets later gains. With ``tax_basis="real"``
the cost basis is CPI-indexed; an inflationary gain is not taxed and cannot create a
deductible loss (only a nominal loss can), as in Israeli capital-gains rules.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from .market import Market
from .models import PlanRequest, SOLVE_MONTHLY, SOLVE_START


@dataclass
class SimOutput:
    final_net: np.ndarray                     # (R,) nominal
    paths_net: Optional[np.ndarray] = None    # (R, T+1) nominal net liquidation value
    deposits: Optional[np.ndarray] = None     # (R, T+1) nominal deposit made at month m
    cpi: Optional[np.ndarray] = None          # (R, T+1) CPI at each month (if loaded)


def _stage_weights(req: PlanRequest, market: Market) -> np.ndarray:
    """(n_stages, A) normalized weights over the union of assets."""
    W = np.zeros((len(req.stages), len(market.asset_keys)))
    for s, stage in enumerate(req.stages):
        for h in stage.holdings:
            W[s, market.asset_keys.index(h.key)] += h.weight
        total = W[s].sum()
        if total <= 0:
            raise ValueError(f"סכום המשקלים בשלב {s + 1} הוא אפס")
        W[s] /= total
    return W


def simulate(req: PlanRequest, market: Market, x: Optional[np.ndarray] = None,
             rows: Optional[np.ndarray] = None, record: bool = False,
             unit_growth: bool = False) -> SimOutput:
    """Run the plan for the selected realizations.

    ``x`` overrides the solved variable per realization (start amount or the monthly
    deposit of every stage). ``unit_growth`` simulates 1 unit invested at the start with no
    deposits, fees only, no tax: used for the time-weighted return and drawdown.
    """
    idx = market.day_idx if rows is None else market.day_idx[rows]
    R, T = idx.shape[0], idx.shape[1] - 1
    A = len(market.asset_keys)
    W = _stage_weights(req, market)
    rate = 0.0 if unit_growth else req.tax_rate / 100
    real_tax = req.tax_basis == "real" and market.cpi_daily is not None
    fee = (1 - req.annual_fee / 100) ** (1 / 12)

    cpi = market.cpi_daily[idx] if market.cpi_daily is not None else None
    ones = np.ones(R)

    V = np.zeros((R, A))       # market value per asset
    Bn = np.zeros((R, A))      # nominal cost basis
    Bc = np.zeros((R, A))      # sum of (amount / CPI at purchase): indexed basis = Bc * CPI_now
    shield = np.zeros(R)       # accumulated realized losses

    paths = np.empty((R, T + 1)) if record else None
    deposits = np.zeros((R, T + 1)) if record else None

    def gains(cpi_now):
        if not real_tax:
            return V - Bn
        indexed = Bc * cpi_now[:, None]
        return np.where(V >= indexed, V - indexed, -np.maximum(Bn - V, 0.0))

    def tax_on(G):
        nonlocal shield
        taxable = np.maximum(G - shield, 0.0)
        shield = np.where(G > 0, np.maximum(shield - G, 0.0), shield - G)
        return rate * taxable

    def liquidation_value(cpi_now):
        G = gains(cpi_now).sum(axis=1)
        return V.sum(axis=1) - rate * np.maximum(G - shield, 0.0)

    def buy(amount, w, cpi_now):
        nonlocal V, Bn, Bc
        add = amount[:, None] * w
        V += add
        Bn += add
        if real_tax:
            Bc += add / cpi_now[:, None]

    def deposit_scale(m):
        """Nominal value of one input unit deposited at month m.

        In real mode the inputs are in today's money (CPI of the last data month), so a
        deposit made decades ago is scaled down by the CPI. Indexed deposits follow the
        CPI month by month; otherwise the nominal amount is fixed at the plan's start.
        """
        ref = cpi[:, m] if req.index_deposits else cpi[:, 0]
        if req.real:
            return ref / market.cpi_base
        return ref / cpi[:, 0]

    # Resolve deposits once (they may be overridden per realization by ``x``).
    stage_starts = np.cumsum([0] + [s.months for s in req.stages])
    if unit_growth:
        start_amount = ones
    elif x is not None and req.solve_for == SOLVE_START:
        start_amount = x
    else:
        start_amount = ones * req.start_amount

    for s, stage in enumerate(req.stages):
        w = W[s]
        m0 = stage_starts[s]
        cpi0 = cpi[:, m0] if cpi is not None else None

        if s > 0:
            V_tot = V.sum(axis=1)
            target = V_tot[:, None] * w
            if req.tax_on_switch and not unit_growth:
                sell = np.maximum(V - target, 0.0)
                frac = np.divide(sell, V, out=np.zeros_like(V), where=V > 0)
                G = (gains(cpi0) * frac).sum(axis=1)
                tax = tax_on(G)
                V -= sell
                Bn *= 1 - frac
                Bc *= 1 - frac
                cash = sell.sum(axis=1) - tax
                deficit = np.maximum(target - V, 0.0)
                dsum = deficit.sum(axis=1)
                scale = np.divide(cash, dsum, out=np.zeros(R), where=dsum > 0)
                add = deficit * scale[:, None]
                V += add
                Bn += add
                if real_tax:
                    Bc += add / cpi0[:, None]
            else:
                V = target
                Bn = Bn.sum(axis=1)[:, None] * w
                Bc = Bc.sum(axis=1)[:, None] * w

        if unit_growth:
            monthly = 0.0 * ones
            initial = start_amount if s == 0 else 0.0 * ones
        else:
            if x is not None and req.solve_for == SOLVE_MONTHLY:
                monthly = x
            else:
                monthly = ones * stage.monthly_deposit
            initial = ones * stage.initial_deposit + (start_amount if s == 0 else 0.0)

        for j in range(stage.months):
            m = m0 + j
            cpi_m = cpi[:, m] if cpi is not None else None
            amount = monthly + (initial if j == 0 else 0.0)
            if cpi is not None and not unit_growth:
                amount = amount * deposit_scale(m)
            buy(amount, w, cpi_m)
            if record:
                deposits[:, m] = amount
                paths[:, m] = liquidation_value(cpi_m) if not unit_growth else V.sum(axis=1)

            p_now = market.prices[:, idx[:, m]].T          # (R, A)
            p_next = market.prices[:, idx[:, m + 1]].T
            growth = np.divide(p_next, p_now, out=np.zeros_like(p_now), where=p_now > 0)
            V *= growth * fee

    cpi_T = cpi[:, T] if cpi is not None else None
    final = V.sum(axis=1) if unit_growth else liquidation_value(cpi_T)
    if record:
        paths[:, T] = final
    return SimOutput(final_net=final, paths_net=paths, deposits=deposits, cpi=cpi)
