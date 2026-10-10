"""Vectorized withdrawal (Trinity-style) simulator.

Same grid and the same ``Book`` as the accumulation simulator. Per month m: stage
transition (if a new stage starts), the one-time withdrawal at a stage start, the monthly
withdrawal, record the path point, then market growth to month m+1. Every withdrawal is a
pro-rata sale, so the tax on the realized gain is paid at that moment and the net cash is
the amount the user asked for (the sale is grossed up for the tax).

Withdrawals are in input units: in real mode that is today's money, and an indexed fixed
withdrawal keeps its purchasing power month by month (the original Trinity study).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from .market import Market
from .models import SOLVE_RATE, SOLVE_START, WithdrawRequest
from .portfolio import Book
from .simulate import month_growth


@dataclass
class WithdrawOutput:
    final_net: np.ndarray                        # (R,) nominal
    paths_net: Optional[np.ndarray] = None       # (R, T+1) nominal net value after the withdrawal
    withdrawals: Optional[np.ndarray] = None     # (R, T+1) nominal net withdrawal paid at month m
    shortfall_at: Optional[np.ndarray] = None    # (R,) first month not paid in full, or -1
    unpaid: Optional[np.ndarray] = None          # (R,) nominal sum of withdrawals that could not be paid
    cpi: Optional[np.ndarray] = None


def _weights(req: WithdrawRequest, market: Market) -> np.ndarray:
    W = np.zeros((len(req.stages), len(market.asset_keys)))
    for s, stage in enumerate(req.stages):
        for h in stage.holdings:
            W[s, market.asset_keys.index(h.key)] += h.weight
        total = W[s].sum()
        if total <= 0:
            raise ValueError(f"סכום המשקלים בשלב {s + 1} הוא אפס")
        W[s] /= total
    return W


def simulate_withdraw(req: WithdrawRequest, market: Market, x: Optional[np.ndarray] = None,
                      rows: Optional[np.ndarray] = None, record: bool = False) -> WithdrawOutput:
    """Run the plan for the selected realizations (``rows`` may repeat a realization, which
    is how the heat map runs many withdrawal rates in one pass).

    ``x`` overrides the solved variable per row: the annual withdrawal rate of every stage
    (percent) or the start amount.
    """
    idx = market.day_idx if rows is None else market.day_idx[rows]
    R, T = idx.shape[0], idx.shape[1] - 1
    A = len(market.asset_keys)
    W = _weights(req, market)
    real_tax = req.tax_basis == "real" and market.cpi_daily is not None
    fee = (1 - req.annual_fee / 100) ** (1 / 12)
    cpi = market.cpi_daily[idx] if market.cpi_daily is not None else None
    ones = np.ones(R)
    book = Book(R, A, req.tax_rate / 100, real_tax)

    paths = np.empty((R, T + 1)) if record else None
    paid = np.zeros((R, T + 1)) if record else None
    shortfall_at = np.full(R, -1, dtype=np.int64)
    unpaid = np.zeros(R)

    def scale(m):
        """Nominal value at month m of one input unit (see simulate.deposit_scale)."""
        if cpi is None:
            return ones
        ref = cpi[:, m] if req.index_withdrawals else cpi[:, 0]
        return ref / market.cpi_base if req.real else ref / cpi[:, 0]

    start_amount = x if (x is not None and req.solve_for == SOLVE_START) else ones * req.start_amount
    rate_override = x if (x is not None and req.solve_for == SOLVE_RATE) else None
    stage_starts = np.cumsum([0] + [s.months for s in req.stages])

    cpi0 = cpi[:, 0] if cpi is not None else None
    book.buy(start_amount * scale(0), W[0], cpi0)

    for s, stage in enumerate(req.stages):
        w = W[s]
        m0 = stage_starts[s]
        if s > 0:
            book.reallocate(w, cpi[:, m0] if cpi is not None else None, taxable=req.tax_on_switch)

        rate = rate_override if rate_override is not None else ones * stage.rate
        if stage.rate_unit == "money" and rate_override is None:
            fixed = ones * stage.amount                      # per month, input units
        else:
            fixed = rate / 1200 * start_amount               # percent per year of the start amount
        floor = ceiling = None
        if stage.basis == "current":
            if stage.floor > 0:
                floor = ones * (stage.floor / 1200 * start_amount if stage.guard_unit == "pct" else stage.floor)
            if stage.ceiling > 0:
                ceiling = ones * (stage.ceiling / 1200 * start_amount if stage.guard_unit == "pct" else stage.ceiling)

        for j in range(stage.months):
            m = m0 + j
            cpi_m = cpi[:, m] if cpi is not None else None
            sc = scale(m)
            want = np.zeros(R)
            if j == 0 and stage.one_time > 0:
                want += (stage.one_time / 100 * book.total if stage.one_time_unit == "pct"
                         else stage.one_time * sc)
            if stage.basis == "current":
                monthly = rate / 1200 * book.total
                if floor is not None:
                    monthly = np.maximum(monthly, floor * sc)
                if ceiling is not None:
                    monthly = np.minimum(monthly, ceiling * sc)
            else:
                monthly = fixed * sc
            want += monthly

            got = book.withdraw_net(want, cpi_m)
            short = (got < want - 1e-6) & (shortfall_at < 0)
            shortfall_at[short] = m
            unpaid += want - got
            if record:
                paid[:, m] = got
                paths[:, m] = book.liquidation_value(cpi_m)

            book.grow(month_growth(market, idx, m), fee)

    cpi_T = cpi[:, T] if cpi is not None else None
    final = book.liquidation_value(cpi_T)
    if record:
        paths[:, T] = final
    return WithdrawOutput(final_net=final, paths_net=paths, withdrawals=paid, shortfall_at=shortfall_at,
                          unpaid=unpaid, cpi=cpi)
