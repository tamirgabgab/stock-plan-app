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
    hi = np.full(n, float(max(guess, 1.0)))
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


def newton_bracketed(F: Callable[[np.ndarray, np.ndarray], tuple[np.ndarray, np.ndarray]],
                     lo: np.ndarray, hi: np.ndarray, x0: np.ndarray, done: np.ndarray | None = None,
                     tol: float = 1e-13, max_iter: int = 80) -> np.ndarray:
    """Root of increasing functions on the brackets [lo, hi], every row at once.

    ``F(x, rows)`` returns (f, f') for those rows. Newton steps, with a bisection step
    whenever Newton would leave the bracket or is not at least halving the step (far from the
    root an exponential crawls), as in ``rtsafe``: it cannot diverge or stall. Rows marked ``done`` keep ``x0``. A row with no root inside the bracket
    ends at its edge, as plain bisection would.
    """
    lo, hi = lo.astype(float), hi.astype(float)
    x = np.clip(x0.astype(float), lo, hi)
    active = np.arange(len(x)) if done is None else np.where(~done)[0]
    dx_old = hi - lo
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        for _ in range(max_iter):
            if len(active) == 0:
                break
            xa = x[active]
            f, df = F(xa, active)
            above = f > 0
            hi[active] = np.where(above, xa, hi[active])
            lo[active] = np.where(above, lo[active], xa)
            step = xa - f / df
            bad = (~np.isfinite(step) | (step <= lo[active]) | (step >= hi[active])
                   | (np.abs(step - xa) > 0.5 * np.abs(dx_old[active])))
            xn = np.where(f == 0, xa, np.where(bad, 0.5 * (lo[active] + hi[active]), step))
            x[active] = xn
            dx_old[active] = xn - xa
            moving = (np.abs(xn - xa) > tol) & (hi[active] - lo[active] > tol)
            active = active[moving & (f != 0)]
    return x


def irr_annual(deposits: np.ndarray, final: np.ndarray) -> np.ndarray:
    """Annual money-weighted return (percent) of monthly deposits ending at ``final``.

    ``deposits`` has shape (R, T+1) with the amount put in at each month (in the same units
    as ``final``); a negative amount is money taken out (a withdrawal). With deposits first
    and withdrawals later the flows change sign once, so the root is unique. Solved by
    bracketed Newton on the monthly rate (-99.99% .. +100%), using Horner's rule so each
    evaluation (with its derivative) is T vector operations.
    """
    R, T1 = deposits.shape

    def F(i, rows):
        d = deposits[rows]
        acc = np.zeros(len(rows))
        dacc = np.zeros(len(rows))
        g = 1.0 + i
        for m in range(T1 - 1):
            acc = acc + d[:, m]
            dacc = dacc * g + acc
            acc = acc * g
        return acc + d[:, T1 - 1] - final[rows], dacc

    got_back = (deposits < 0).any(axis=1)
    put_in = np.where(deposits > 0, deposits, 0.0).sum(axis=1)
    lost = (final <= 0) & ~got_back
    i = newton_bracketed(F, np.full(R, -0.9999), np.full(R, 1.0), np.full(R, 0.005), done=lost | (put_in <= 0))
    out = ((1 + i) ** 12 - 1) * 100
    # Nothing came back (no withdrawals, nothing left): everything was lost. Nothing went in: no return.
    out[lost] = -100.0
    out[put_in <= 0] = np.nan
    return out


def trace_illinois(f: Callable[[float], float], target: float, guess: float) -> dict:
    """Scalar version of ``solve_monotone`` that records every step, for the math tab.

    Returns ``{"steps": [{"x", "y", "phase"}], "x": solution, "converged": bool}`` where
    ``phase`` is "start", "expand", "secant" or "bisect" and ``y`` is f(x) (not f - target).
    """
    tol = max(abs(target) * 1e-7, 1e-4)
    steps = []

    def ev(x, phase):
        y = f(x)
        steps.append({"x": float(x), "y": float(y), "phase": phase})
        return y - target

    lo, f_lo = 0.0, ev(0.0, "start")
    if f_lo >= 0:
        return {"steps": steps, "x": 0.0, "converged": True}
    hi = float(max(guess, 1.0))
    f_hi = ev(hi, "expand")
    n = 0
    while f_hi < 0 and n < MAX_EXPAND:
        lo, f_lo = hi, f_hi
        hi *= 4.0
        f_hi = ev(hi, "expand")
        n += 1
    if f_hi < 0:
        return {"steps": steps, "x": None, "converged": False}
    side = 0
    for _ in range(MAX_ITER):
        xm = hi - f_hi * (hi - lo) / (f_hi - f_lo)
        phase = "secant"
        if not (lo < xm < hi) or not np.isfinite(xm):
            xm, phase = 0.5 * (lo + hi), "bisect"
        fm = ev(xm, phase)
        if abs(fm) <= tol:
            return {"steps": steps, "x": float(xm), "converged": True}
        if fm > 0:
            hi, f_hi = xm, fm
            if side == 1:
                f_lo *= 0.5
            side = 1
        else:
            lo, f_lo = xm, fm
            if side == -1:
                f_hi *= 0.5
            side = -1
        if hi - lo <= 1e-9 * max(hi, 1.0):
            return {"steps": steps, "x": float(0.5 * (lo + hi)), "converged": True}
    return {"steps": steps, "x": float(0.5 * (lo + hi)), "converged": False}
