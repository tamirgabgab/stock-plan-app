"""The break-even solver: the parameter value at which two scenarios are equal.

Part of the ``property`` package; see its docstring for the model."""
from __future__ import annotations

import copy
from typing import List

import numpy as np
import pandas as pd

from .inputs import PropertyRequest
from .simulate import simulate
from .checks import InputError, check_common, check_scenario
from .metrics import METRICS, metrics


# ---------------------------------------------------------------- solve for unknown

STATS = ("median", "mean", "prob")


def _param_path(d: dict, scope: str, key: str) -> list:
    """``scope`` is "common" or a scenario id; ``key`` is a dotted path (``tracks.0.rate``)."""
    parts = [int(p) if p.isdigit() else p for p in key.split(".")]
    if scope == "common":
        path = ["common", *parts]
    else:
        idx = next((i for i, s in enumerate(d["scenarios"]) if s["id"] == scope), None)
        if idx is None:
            raise ValueError(f"תרחיש לא קיים: {scope}")
        path = ["scenarios", idx, *parts]
    cur = d
    try:
        for k in path:
            cur = cur[k]
    except (KeyError, IndexError, TypeError):
        raise ValueError(f"פרמטר לא קיים: {key}") from None
    if isinstance(cur, bool) or not isinstance(cur, (int, float)):
        raise ValueError("אפשר לפתור רק פרמטר מספרי")
    return path


def _with(d: dict, path: list, value) -> dict:
    out = copy.deepcopy(d)
    cur = out
    for k in path[:-1]:
        cur = cur[k]
    cur[path[-1]] = value
    return out


def _stat(va: np.ndarray, vb: np.ndarray, stat: str) -> np.ndarray:
    """Statistic of A minus that of B over the realizations (last axis)."""
    with np.errstate(all="ignore"):
        if stat == "prob":
            return np.nanmean(np.where(np.isfinite(va) & np.isfinite(vb), va > vb, np.nan), -1) - 0.5
        f = np.nanmedian if stat == "median" else np.nanmean
        return f(va, -1) - f(vb, -1)


def _crossings(xs: np.ndarray, ys: np.ndarray) -> List[int]:
    """Indices i where ys changes sign between i and i+1 (or is zero at i)."""
    out = []
    for i in range(len(xs) - 1):
        y0, y1 = ys[i], ys[i + 1]
        if not (np.isfinite(y0) and np.isfinite(y1)):
            continue
        if y0 == 0 or y0 * y1 < 0:
            out.append(i)
    if len(ys) and np.isfinite(ys[-1]) and ys[-1] == 0:
        out.append(len(xs) - 1)
    return out


def _interp_root(x0, x1, y0, y1):
    with np.errstate(all="ignore"):
        return np.where(y1 != y0, x0 - y0 * (x1 - x0) / (y1 - y0), x0)


def solve_equal(req: PropertyRequest, a: str, b: str, metric: str, scope: str, key: str,
                lo: float, hi: float, stat: str = "median", md=None, n_grid: int = 48) -> dict:
    """The values of one parameter at which scenarios ``a`` and ``b`` are equivalent on ``metric``.

    The scan's grid points run as rows of a single simulation. Every sign change of
    ``stat(metric_a) - stat(metric_b)`` is refined by a second, finer grid inside its bracket
    (again one simulation) and linear interpolation. In history mode each realization is
    also solved on its own: per row, its first bracket is refined the same way, with every
    row carrying its own trial values.
    """
    from ..property_data import build_paths
    if metric not in METRICS:
        raise ValueError(f"מטריקה לא מוכרת: {metric}")
    if stat not in STATS:
        raise ValueError(f"סטטיסטיקה לא מוכרת: {stat}")
    if a == b:
        raise ValueError("בחר שני תרחישים שונים להשוואה")
    if not hi > lo:
        raise ValueError("הגבול העליון חייב להיות גדול מהתחתון")
    d = req.model_dump()
    path = _param_path(d, scope, key)
    ia = next((i for i, s in enumerate(d["scenarios"]) if s["id"] == a), None)
    ib = next((i for i, s in enumerate(d["scenarios"]) if s["id"] == b), None)
    if ia is None or ib is None:
        raise ValueError("תרחיש לא קיים")
    errors, _ = check_common(d)
    for i in (ia, ib):
        sc = d["scenarios"][i]
        errors += [{**e, "msg": f"{sc['name'] or 'תרחיש'}: {e['msg']}"} for e in check_scenario(sc, d["common"], d["taxes"])[0]]
    if errors:
        raise InputError(errors)
    paths = build_paths(req, md, [d["scenarios"][ia], d["scenarios"][ib]])
    touch = lambda i: scope == "common" or d["scenarios"][i]["id"] == scope
    R = paths.R

    def metric_of(dd, i, shape, rowwise=False):
        """The metric, NaN where the trial value cannot happen: the purchase does not add up,
        or (for a row of the statistic scan) the budget misses the first month in every
        realization. Rows of the per-realization grid carry their own values, so there only
        the purchase is checked, as a single run would."""
        r = simulate(dd["scenarios"][i], dd["common"], dd["taxes"], paths, shape=shape, full=False)
        v = np.asarray(metrics(r, dd["common"], paths, which=metric)[metric], dtype=float)
        ok = np.broadcast_to(r["feasible"], shape)
        if not rowwise:
            ok = ok & ~np.broadcast_to(np.all(r["first_short"], axis=-1, keepdims=True), shape)
        return np.where(ok, v, np.nan)

    fixed = {i: metric_of(d, i, (R,)) for i in (ia, ib) if not touch(i)}

    def both(xval, rowwise=False):
        x = np.asarray(xval, dtype=float)
        shape = np.broadcast_shapes(x.shape, (R,))
        dd = _with(d, path, x)
        va = metric_of(dd, ia, shape, rowwise) if touch(ia) else np.broadcast_to(fixed[ia], shape)
        vb = metric_of(dd, ib, shape, rowwise) if touch(ib) else np.broadcast_to(fixed[ib], shape)
        return va, vb

    current = d
    for k in path:
        current = current[k]
    current = float(current)
    xs = np.linspace(lo, hi, n_grid + 1)
    va, vb = both(np.append(xs, current)[:, None])           # (G+2, R)
    curve = _stat(va, vb, stat)
    current_diff, curve = float(curve[-1]), curve[:-1]
    va, vb = va[:-1], vb[:-1]

    # Statistic roots: refine every bracket at once on a finer grid.
    roots: List[float] = []
    br = _crossings(xs, curve)
    if br:
        fine = np.concatenate([np.linspace(xs[i], xs[min(i + 1, n_grid)], n_grid + 1) for i in br])
        fa, fb = both(fine[:, None])
        fcurve = _stat(fa, fb, stat).reshape(len(br), n_grid + 1)
        fxs = fine.reshape(len(br), n_grid + 1)
        for j in range(len(br)):
            sub = _crossings(fxs[j], fcurve[j])
            if sub:
                i = sub[0]
                i1 = min(i + 1, n_grid)
                roots.append(float(_interp_root(fxs[j, i], fxs[j, i1], fcurve[j, i], fcurve[j, i1])))
    out = {"roots": roots, "scan_x": xs.tolist(), "scan_y": [None if not np.isfinite(v) else float(v) for v in curve],
           "current": current, "current_diff": current_diff, "stat": stat}

    if paths.history and R > 1:
        diff = va - vb                                          # (G+1, R)
        s = np.sign(np.where(np.isfinite(diff), diff, np.nan))
        change = (s[:-1] * s[1:] <= 0) & np.isfinite(s[:-1]) & np.isfinite(s[1:])
        n_changes = change.sum(0)
        first = np.where(n_changes > 0, change.argmax(0), -1)
        has = first >= 0
        i0 = np.where(has, first, 0)
        x0, x1 = xs[i0], xs[np.minimum(i0 + 1, n_grid)]
        grid = x0[None, :] + (x1 - x0)[None, :] * np.linspace(0, 1, n_grid + 1)[:, None]   # (G+1, R)
        ga, gb = both(grid, rowwise=True)
        gd = ga - gb
        gs = np.sign(gd)
        gchange = (gs[:-1] * gs[1:] <= 0) & np.isfinite(gs[:-1]) & np.isfinite(gs[1:])
        gfirst = np.where(gchange.any(0), gchange.argmax(0), 0)
        cols = np.arange(R)
        rx = _interp_root(grid[gfirst, cols], grid[gfirst + 1, cols], gd[gfirst, cols], gd[gfirst + 1, cols])
        rx = np.where(has & gchange.any(0), rx, np.nan)
        out["per_row"] = {
            "roots": [None if not np.isfinite(v) else float(v) for v in rx],
            "start_dates": [d_.strftime("%Y-%m-%d") for d_ in paths.start_dates],
            "multiple": int((n_changes > 1).sum()),
            "none": int((~has).sum()),
            "a_better_all": int(((~has) & (np.nanmin(diff, 0) > 0)).sum()),
            "b_better_all": int(((~has) & (np.nanmax(diff, 0) < 0)).sum()),
        }
    return out


__all__ = ["PropertyRequest", "Common", "TaxTables", "MarketParams", "Track", "Cost", "Scenario",
           "InputError", "check_common", "check_scenario", "check_result", "alloc_bounds", "Bracket", "HistoryFlags", "RatePoint", "Paths", "bracket_tax", "annuity",
           "run_property", "simulate", "simulate_scenario", "solve_equal", "irr_monthly", "metrics", "display",
           "row_of", "METRICS", "STATS"]
