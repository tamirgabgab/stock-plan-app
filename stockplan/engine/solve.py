"""Solvers that work on all realizations at once.

* The missing start amount / monthly deposit: the final net value is monotone and
  piecewise-linear in it (exactly linear without tax), so a vectorized false-position
  (Illinois) method converges in a handful of simulations. No per-date ``fsolve``.
* The money-weighted annual return (IRR) and the deflation of values to real terms.
"""
from __future__ import annotations

from typing import Callable

import numpy as np

MAX_EXPAND = 40
MAX_ITER = 60


def solve_monotone(F: Callable[[np.ndarray, np.ndarray], np.ndarray], target: float, n: int,
                   guess: float) -> np.ndarray:
    """Find x >= 0 with F(x) = target for each of ``n`` independent increasing functions.

    ``F(x, rows)`` evaluates the functions for the given row subset. Rows whose target is
    already reached at x = 0 get 0; rows that never reach it get NaN.
    """
    tol = max(abs(target) * 1e-7, 1e-4)
    all_rows = np.arange(n)
    lo = np.zeros(n)
    f_lo = F(lo, all_rows) - target
    x = np.full(n, np.nan)
    x[f_lo >= 0] = 0.0

    # Expand the upper bracket until every row crosses the target.
    hi = np.full(n, max(guess, 1.0))
    f_hi = np.full(n, -np.inf)
    pending = np.where(f_lo < 0)[0]
    for _ in range(MAX_EXPAND):
        if len(pending) == 0:
            break
        f_hi[pending] = F(hi[pending], pending) - target
        still = pending[f_hi[pending] < 0]
        lo[still], f_lo[still] = hi[still], f_hi[still]
        hi[still] *= 4.0
        pending = still
    active = np.where(np.isnan(x) & (f_hi >= 0))[0]

    side = np.zeros(n, dtype=np.int8)   # Illinois bookkeeping: which end moved last
    for _ in range(MAX_ITER):
        if len(active) == 0:
            break
        a, b, fa, fb = lo[active], hi[active], f_lo[active], f_hi[active]
        xm = b - fb * (b - a) / (fb - fa)
        xm = np.where((xm <= a) | (xm >= b) | ~np.isfinite(xm), 0.5 * (a + b), xm)
        fm = F(xm, active) - target
        done = np.abs(fm) <= tol
        x[active[done]] = xm[done]
        upper = fm > 0
        # Replace the end with the same sign; halve the stale end's value (Illinois).
        hi_rows, lo_rows = active[upper], active[~upper]
        hi[hi_rows], f_hi[hi_rows] = xm[upper], fm[upper]
        lo[lo_rows], f_lo[lo_rows] = xm[~upper], fm[~upper]
        f_lo[hi_rows[side[hi_rows] == 1]] *= 0.5
        f_hi[lo_rows[side[lo_rows] == -1]] *= 0.5
        side[hi_rows], side[lo_rows] = 1, -1
        # Bracket shrunk to nothing: accept the midpoint.
        narrow = (hi[active] - lo[active]) <= 1e-9 * np.maximum(hi[active], 1.0)
        x[active[narrow & ~done]] = 0.5 * (lo[active] + hi[active])[narrow & ~done]
        active = active[~done & ~narrow]
    if len(active):
        x[active] = 0.5 * (lo[active] + hi[active])
    return x


def irr_annual(deposits: np.ndarray, final: np.ndarray) -> np.ndarray:
    """Annual money-weighted return (percent) of monthly deposits ending at ``final``.

    ``deposits`` has shape (R, T+1) with the amount put in at each month (in the same units
    as ``final``). Solved by bisection on the monthly rate, using Horner's rule so each
    evaluation is T vector operations.
    """
    R, T1 = deposits.shape
    total = deposits.sum(axis=1)
    lo = np.full(R, -0.9999)
    hi = np.full(R, 1.0)          # monthly rates: -99.99% .. +100%

    def fv(i):
        acc = np.zeros(R)
        g = 1.0 + i
        for m in range(T1 - 1):
            acc = (acc + deposits[:, m]) * g
        return acc + deposits[:, T1 - 1]

    for _ in range(70):
        mid = 0.5 * (lo + hi)
        above = fv(mid) > final
        hi = np.where(above, mid, hi)
        lo = np.where(above, lo, mid)
    i = 0.5 * (lo + hi)
    out = ((1 + i) ** 12 - 1) * 100
    out[total <= 0] = np.nan
    out[final <= 0] = -100.0
    return out
