"""Vectorized withdrawal (Trinity-style) simulator.

Same grid and the same ``Book`` as the accumulation simulator. Per month m: stage
transition (if a new stage starts) or a periodic rebalance, the one-time withdrawal at a stage start, the monthly
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
from .models import SOLVE_AMOUNT, SOLVE_RATE, SOLVE_START, WithdrawRequest
from .portfolio import Book, rebalance_rows, withdrawal_want
from .simulate import month_growth


@dataclass
class WithdrawOutput:
    final_net: np.ndarray                        # (R,) nominal
    paths_net: Optional[np.ndarray] = None       # (R, T+1) nominal net value after the withdrawal
    withdrawals: Optional[np.ndarray] = None     # (R, T+1) nominal net withdrawal paid at month m
    shortfall_at: Optional[np.ndarray] = None    # (R,) first month not paid in full, or -1
    unpaid: Optional[np.ndarray] = None          # (R,) nominal sum of withdrawals that could not be paid
    cpi: Optional[np.ndarray] = None
    paths_gross: Optional[np.ndarray] = None     # (R, T+1) nominal market value of the holdings


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
                      rows: Optional[np.ndarray] = None, record: bool = False,
                      journal: Optional[list] = None) -> WithdrawOutput:
    """Run the plan for the selected realizations (``rows`` may repeat a realization, which
    is how the heat map runs many withdrawal rates in one pass).

    ``x`` overrides the solved variable per row: the annual withdrawal rate of every stage
    (percent), the monthly withdrawal of every stage (money, input units) or the start amount.
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
    book.journal = journal

    paths = np.empty((R, T + 1)) if record else None
    gross = np.empty((R, T + 1)) if record else None
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
    amount_override = x if (x is not None and req.solve_for == SOLVE_AMOUNT) else None
    stage_starts = np.cumsum([0] + [s.months for s in req.stages])

    cpi0 = cpi[:, 0] if cpi is not None else None
    book.m, book.ctx = 0, "start"
    book.buy(start_amount * scale(0), W[0], cpi0)

    for s, stage in enumerate(req.stages):
        w = W[s]
        m0 = stage_starts[s]
        if s > 0:
            book.m, book.ctx = m0, "switch"
            book.reallocate(w, cpi[:, m0] if cpi is not None else None, taxable=req.tax_on_switch)

        for j in range(stage.months):
            m = m0 + j
            cpi_m = cpi[:, m] if cpi is not None else None
            sc = scale(m)
            moved = rebalance_rows(book, req.rebalance, req.rebalance_band, w, j)
            if moved is not None:
                book.m, book.ctx = m, "rebalance"
                book.reallocate(w, cpi_m, taxable=req.tax_on_switch, rows=moved)
            want = withdrawal_want(stage, j, book.total, start_amount, sc,
                                   rate=rate_override, amount=amount_override)

            book.m, book.ctx = m, ("one_time" if j == 0 and stage.one_time > 0 else "withdraw")
            got = book.withdraw_net(want, cpi_m)
            short = (got < want - 1e-6) & (shortfall_at < 0)
            shortfall_at[short] = m
            unpaid += want - got
            if record:
                paid[:, m] = got
                paths[:, m] = book.liquidation_value(cpi_m)
                gross[:, m] = book.total

            book.grow(month_growth(market, idx, m), fee)

    cpi_T = cpi[:, T] if cpi is not None else None
    final = book.liquidation_value(cpi_T)
    if record:
        paths[:, T] = final
        gross[:, T] = book.total
    return WithdrawOutput(final_net=final, paths_net=paths, withdrawals=paid, shortfall_at=shortfall_at,
                          unpaid=unpaid, cpi=cpi, paths_gross=gross)
