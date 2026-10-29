"""Helpers (brackets, annuity, schedules) and the paths the model runs on: fixed or synthetic.

Part of the ``property`` package; see its docstring for the model."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from .inputs import SYN_SERIES


# --------------------------------------------------------------------------- helpers

def _g(obj, key):
    return obj[key] if isinstance(obj, dict) else getattr(obj, key)


def _sorted_brackets(brackets):
    return sorted(brackets, key=lambda b: float("inf") if _g(b, "up_to") is None else _g(b, "up_to"))


def bracket_tax(amount, brackets):
    """Progressive tax: each slice of ``amount`` is taxed at its bracket's rate (vectorized)."""
    tax, prev = 0.0, 0.0
    for b in _sorted_brackets(brackets):
        top = float("inf") if _g(b, "up_to") is None else _g(b, "up_to")
        tax = tax + np.maximum(0.0, np.minimum(amount, top) - prev) * _g(b, "rate") / 100
        prev = top
    return tax


def purchase_tax_rows(amount: float, brackets) -> List[dict]:
    """The slices of ``bracket_tax`` (for the equations panel)."""
    out, prev = [], 0.0
    for b in _sorted_brackets(brackets):
        top = float("inf") if _g(b, "up_to") is None else _g(b, "up_to")
        part = max(0.0, min(amount, top) - prev)
        out.append({"from": prev, "to": None if top == float("inf") else top, "rate": _g(b, "rate"),
                    "part": part, "tax": part * _g(b, "rate") / 100})
        prev = top
    return out


def annuity(balance, rho, k: int):
    """Level payment that repays ``balance`` in ``k`` months at monthly rate ``rho``."""
    if k <= 0:
        return balance
    rho = np.asarray(rho, dtype=float)
    safe = np.where(rho > 0, rho, 1.0)
    return np.where(rho > 0, balance * safe / (1 - (1 + safe) ** -k), balance / k)


def months_of(years: float) -> int:
    return max(1, int(round(years * 12)))


def schedule_at(points, t_years: float):
    """Step schedule: the rate of the last point at or before ``t_years`` (None if empty)."""
    if not points:
        return None
    pts = sorted(points, key=lambda p: _g(p, "year"))
    v = _g(pts[0], "rate")
    for p in pts:
        if _g(p, "year") <= t_years + 1e-9:
            v = _g(p, "rate")
    return v


def holdings_key(holdings) -> str:
    return "|".join(f"{_g(h, 'ticker').strip().upper()}:{float(_g(h, 'weight')):g}:{float(_g(h, 'leverage')):g}"
                    for h in holdings if _g(h, "weight") > 0)


@dataclass
class Paths:
    """Per-realization paths ``(R, T+1)``; None means "use the parameter" (fixed mode).

    In synthetic mode ``syn`` holds, for each drawn series, the cumulative standardized shock
    ``S_m = sum_{k<=m} z_k / sqrt(12)`` (``S_0 = 0``); the simulator turns it into a path with
    the scenario's own mean and volatility, so those stay parameters (and solvable).
    """
    R: int
    T: int
    cpi: Optional[np.ndarray] = None          # C_t / C_0
    home: Optional[np.ndarray] = None         # housing price index / its value at the start
    rent: Optional[np.ndarray] = None         # rent index / its value at the start
    rate: Optional[np.ndarray] = None         # Bank of Israel rate, annual percent
    growth: Dict[str, np.ndarray] = field(default_factory=dict)   # holdings key -> monthly gross factor
    start_dates: Optional[pd.DatetimeIndex] = None
    scale: Optional[np.ndarray] = None        # (R,) CPI(start) / CPI(last): nominal display factor
    info: dict = field(default_factory=dict)
    syn: Dict[str, np.ndarray] = field(default_factory=dict)

    @property
    def history(self) -> bool:
        return self.start_dates is not None


def fixed_paths(T: int) -> Paths:
    return Paths(R=1, T=T)


def corr_matrix(corr: Dict[str, float]) -> np.ndarray:
    """The correlation matrix of the monthly draws, in ``SYN_SERIES`` order (missing pairs: 0)."""
    n = len(SYN_SERIES)
    M = np.eye(n)
    for i in range(n):
        for j in range(i + 1, n):
            a, b = SYN_SERIES[i], SYN_SERIES[j]
            v = corr.get(f"{a}|{b}", corr.get(f"{b}|{a}", 0.0))
            M[i, j] = M[j, i] = v
    return M


MAX_SYN_CELLS = 2_000_000          # paths x months of the synthetic draws


def synthetic_paths(c: dict, T: int) -> Paths:
    """``n`` paths of correlated standard-normal monthly draws, cumulated (see ``Paths.syn``).

    All five series are always drawn from the full correlation matrix, so switching a series
    off (it then stays on its fixed parameter) does not change the draws of the others.
    """
    sp = c["synthetic"]
    R = int(sp["n"])
    w, V = np.linalg.eigh(corr_matrix(sp["corr"]))
    L = V * np.sqrt(np.maximum(w, 0.0))                # L @ L.T = the correlation matrix
    rng = np.random.default_rng(int(sp["seed"]))
    z = rng.standard_normal((T, R, len(SYN_SERIES))) @ L.T / np.sqrt(12)
    paths = Paths(R=R, T=T)
    for k, name in enumerate(SYN_SERIES):
        if sp["series"][name]:
            S = np.zeros((R, T + 1))
            S[:, 1:] = np.cumsum(z[:, :, k], axis=0).T
            paths.syn[name] = S
    paths.info = {"n": R, "seed": int(sp["seed"]), "series": [k for k in SYN_SERIES if sp["series"][k]]}
    return paths
