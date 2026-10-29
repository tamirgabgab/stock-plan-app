"""Metrics of a run (final value, sums, present values, IRR) and the entry point.

Part of the ``property`` package; see its docstring for the model."""
from __future__ import annotations

import copy
from typing import List, Optional

import numpy as np
import pandas as pd

from .inputs import PropertyRequest
from .paths import Paths, fixed_paths, months_of
from .simulate import simulate
from .checks import InputError, check_common, check_result, check_scenario


# --------------------------------------------------------------------------- metrics

METRICS = ("final", "sum", "pv_final", "pv_sum", "irr")


def irr_monthly(flows: np.ndarray) -> Optional[float]:
    """Monthly rate x with sum(flows[m] / (1+x)^m) = 0 for one cash-flow vector."""
    x = _irr_vec(np.asarray(flows, dtype=float)[:, None])[0]
    return None if not np.isfinite(x) else float(x)


def _irr_vec(cash: np.ndarray) -> np.ndarray:
    """Monthly IRR of every column of ``cash`` (time-major), by bisection; NaN without a sign change.

    The NPV ``sum(cash[m] * v^m)`` with ``v = 1/(1+x)`` is evaluated by Horner's rule, a
    loop over the months on small arrays instead of a power of the whole matrix.
    """
    def npv(x):
        v = 1 / (1 + x)
        acc = np.zeros(cash.shape[1:])
        for m in range(cash.shape[0] - 1, -1, -1):
            acc = acc * v + cash[m]
        return acc

    lo = np.full(cash.shape[1:], -0.5)    # -99.98% .. +12,875% a year
    hi = np.full(cash.shape[1:], 0.5)
    with np.errstate(all="ignore"):
        f_lo, f_hi = npv(lo), npv(hi)
        ok = np.isfinite(f_lo) & np.isfinite(f_hi) & (f_lo * f_hi <= 0)
        for _ in range(36):
            mid = (lo + hi) / 2
            f_mid = npv(mid)
            same = (f_mid > 0) == (f_lo > 0)
            lo, f_lo = np.where(same, mid, lo), np.where(same, f_mid, f_lo)
            hi = np.where(same, hi, mid)
    return np.where(ok, (lo + hi) / 2, np.nan)


def display(res: dict, c: dict, paths: Paths) -> np.ndarray:
    """``net`` in display units: today's money (real) or the shekels of the time (nominal)."""
    if c["real"]:
        return res["net"] / res["cpi"]
    return res["net"] * paths.scale if paths.scale is not None else res["net"]


def metrics(res: dict, c: dict, paths: Paths, which=None) -> dict:
    net = res["net"]
    disp = display(res, c, paths)
    T = net.shape[0] - 1
    t = np.arange(T + 1).reshape((-1,) + (1,) * (net.ndim - 1))
    disc = (1 + np.asarray(c["discount_rate"]) / 100) ** (t / 12)
    out = {}
    if which in (None, "final"):
        out["final"] = disp[-1]
    if which in (None, "sum"):
        out["sum"] = disp.sum(0)
        out["mean"] = disp.mean(0)
    if which in (None, "pv_final"):
        out["pv_final"] = net[-1] / disc[-1]
    if which in (None, "pv_sum"):
        out["pv_sum"] = (net / disc).sum(0)
    if which is None:
        out["min"] = disp.min(0)
        out["min_month"] = disp.argmin(0)
    if which in (None, "irr"):
        cash = -res["budget"].copy()
        cash[0] = -np.broadcast_to(np.asarray(c["equity"], dtype=float), cash.shape[1:])
        cash[-1] = cash[-1] + net[-1]
        x = _irr_vec(cash)
        with np.errstate(all="ignore"):
            irr = (1 + x) ** 12 - 1
            if c["real"]:
                irr = (1 + irr) / res["cpi"][-1] ** (12 / T) - 1
        out["irr"] = irr * 100
    return out


def run_property(req: PropertyRequest, md=None) -> dict:
    """Every scenario on the request's paths (fixed: one row; history: one row per start date).

    Shared inputs that cannot happen raise ``InputError``. A scenario whose own inputs (or first
    month) cannot happen is not simulated: it goes to ``failed`` with its errors, and the
    others still run.
    """
    from ..property_data import build_paths   # data loading is only needed in history mode
    d = req.model_dump()
    errors, warnings = check_common(d)
    if errors:
        raise InputError(errors)
    c, taxes = d["common"], d["taxes"]
    failed: List[dict] = []
    valid = []
    for sc in d["scenarios"]:
        errs, warns = check_scenario(sc, c, taxes)
        if errs:
            failed.append({"id": sc["id"], "name": sc["name"], "errors": errs})
        else:
            valid.append((sc, warns))
    paths = build_paths(req, md, [sc for sc, _ in valid]) if valid else None
    out = []
    for sc, warns in valid:
        r = simulate(sc, c, taxes, paths)
        errs, more = check_result(sc, c, r)
        if errs:
            failed.append({"id": sc["id"], "name": sc["name"], "errors": errs})
            continue
        r["warnings"] = warns + r["warnings"] + more
        r["metrics"] = metrics(r, c, paths)
        r["display"] = display(r, c, paths)
        r["id"], r["name"] = sc["id"], sc["name"]
        r["kind"] = "apartment" if sc["alloc"] > 0 else "market"
        out.append(r)
    order = {sc["id"]: i for i, sc in enumerate(d["scenarios"])}
    failed.sort(key=lambda f: order.get(f["id"], 0))
    return {"months": months_of(c["years"]), "paths": paths, "scenarios": out, "failed": failed,
            "warnings": warnings}


# Backwards-compatible single-scenario helper (fixed mode).
def simulate_scenario(sc, c, taxes) -> dict:
    d = lambda x: x.model_dump() if hasattr(x, "model_dump") else x
    c_, t_ = d(c), d(taxes)
    r = simulate(d(sc), c_, t_, fixed_paths(months_of(c_["years"])))
    return _first_row(r)


def _first_row(r: dict) -> dict:
    pick = lambda v: v[..., 0] if isinstance(v, np.ndarray) and v.ndim >= 1 else v
    out = {k: pick(v) for k, v in r.items() if isinstance(v, np.ndarray)}
    for k in ("parts", "flows"):
        if k in r:
            out[k] = {n: pick(v) for n, v in r[k].items()}
    out["summary"] = row_of(r.get("summary", {}), 0)
    out["warnings"] = r.get("warnings", [])
    return out


def row_of(v, r: int):
    """The value of realization ``r``: scalars stay, arrays of the simulation's shape are indexed."""
    if isinstance(v, dict):
        return {k: row_of(x, r) for k, x in v.items()}
    if isinstance(v, list):
        return [row_of(x, r) for x in v]
    if isinstance(v, np.ndarray):
        if v.ndim == 0:
            return float(v)
        if v.ndim == 1:
            return float(v[r]) if v.dtype.kind == "f" else int(v[r])
        return v[:, r].tolist()            # time-major path
    if isinstance(v, (np.floating, np.integer)):
        return v.item()
    return v
