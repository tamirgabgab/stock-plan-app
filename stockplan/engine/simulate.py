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

The holdings and the tax state live in ``portfolio.Book`` (shared with the withdrawal
simulator); see there for the tax model.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from .market import Market
from .portfolio import Book
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
             unit_growth: bool = False, journal: Optional[list] = None) -> SimOutput:
    """Run the plan for the selected realizations.

    ``x`` overrides the solved variable per realization (start amount or the monthly
    deposit of every stage). ``unit_growth`` simulates 1 unit invested at the start with no
    deposits, fees only, no tax: used for the time-weighted return and drawdown.
    ``journal`` (a list) collects the trades of row 0, for the realization detail view.
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
    book = Book(R, A, rate, real_tax)
    book.journal = journal

    paths = np.empty((R, T + 1)) if record else None
    deposits = np.zeros((R, T + 1)) if record else None

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
            book.m, book.ctx = m0, "switch"
            book.reallocate(w, cpi0, taxable=req.tax_on_switch and not unit_growth)

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
            book.m, book.ctx = m, "deposit"
            book.buy(amount, w, cpi_m)
            if record:
                deposits[:, m] = amount
                paths[:, m] = book.liquidation_value(cpi_m) if not unit_growth else book.total

            book.grow(month_growth(market, idx, m), fee)

    cpi_T = cpi[:, T] if cpi is not None else None
    final = book.total if unit_growth else book.liquidation_value(cpi_T)
    if record:
        paths[:, T] = final
    return SimOutput(final_net=final, paths_net=paths, deposits=deposits, cpi=cpi)


def month_growth(market: Market, idx: np.ndarray, m: int) -> np.ndarray:
    """(R, A) price growth factor of every asset from month m to m+1."""
    p_now = market.prices[:, idx[:, m]].T
    p_next = market.prices[:, idx[:, m + 1]].T
    return np.divide(p_next, p_now, out=np.zeros_like(p_now), where=p_now > 0)
