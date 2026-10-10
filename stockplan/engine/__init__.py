"""Simulation engine: pure numpy/pandas, no web or UI code."""
from __future__ import annotations

import numpy as np

from ..data.base import MarketData
from .market import Market, available_range, prepare_market
from .models import (SOLVE_FINAL, SOLVE_MODES, SOLVE_MONTHLY, SOLVE_START, Holding, PlanRequest,
                     SimulationResult, Stage)
from .simulate import simulate
from .solve import irr_annual, solve_monotone


def validate(req: PlanRequest) -> None:
    if not req.stages:
        raise ValueError("יש להגדיר לפחות שלב אחד")
    if req.solve_for not in SOLVE_MODES:
        raise ValueError(f"מצב חישוב לא מוכר: {req.solve_for}")
    if req.currency not in ("USD", "ILS"):
        raise ValueError(f"מטבע לא נתמך: {req.currency}")
    for i, s in enumerate(req.stages, 1):
        if s.months < 1:
            raise ValueError(f"בשלב {i} מספר החודשים חייב להיות לפחות 1")
        if not s.holdings:
            raise ValueError(f"בשלב {i} אין נכסים")
        if any(h.weight < 0 for h in s.holdings) or sum(h.weight for h in s.holdings) <= 0:
            raise ValueError(f"בשלב {i} המשקלים חייבים להיות חיוביים")
        if any(h.leverage < 0 for h in s.holdings):
            raise ValueError(f"בשלב {i} המינוף לא יכול להיות שלילי")
    if not 0 <= req.tax_rate < 100:
        raise ValueError("שיעור המס חייב להיות בין 0 ל-100")
    if req.solve_for != SOLVE_FINAL and req.target_amount <= 0:
        raise ValueError("יעד סופי חייב להיות חיובי")


def _deflator(req: PlanRequest, market: Market, cpi) -> np.ndarray:
    """(R, T+1) factor converting nominal values to money of each start date."""
    R, T1 = market.day_idx.shape
    if not req.real or cpi is None:
        return np.ones((R, T1))
    return cpi[:, :1] / cpi


def _initial_guess(req: PlanRequest) -> float:
    T = req.total_months
    r = 1.07 ** (1 / 12) - 1
    growth = (1 + r) ** T
    annuity = (growth - 1) / r
    if req.solve_for == SOLVE_START:
        return req.target_amount / growth
    return max(req.target_amount - req.start_amount * growth, 0.1 * req.target_amount) / annuity


def run_plan(req: PlanRequest, md: MarketData) -> SimulationResult:
    validate(req)
    market = prepare_market(req, md)
    R = len(market.start_dates)
    T = req.total_months
    warnings = []

    solved = None
    if req.solve_for != SOLVE_FINAL:
        cpi_all = market.cpi_daily[market.day_idx] if market.cpi_daily is not None else None

        def final_display(x, rows):
            out = simulate(req, market, x=x, rows=rows).final_net
            if req.real and cpi_all is not None:
                out = out * cpi_all[rows, 0] / cpi_all[rows, T]
            return out

        solved = solve_monotone(final_display, req.target_amount, R, _initial_guess(req))
        n_bad = int(np.isnan(solved).sum())
        if n_bad:
            warnings.append(f"ב-{n_bad} תקופות לא ניתן להגיע ליעד (למשל התיק התאפס)")
        x_run = np.where(np.isnan(solved), 0.0, solved)
        out = simulate(req, market, x=x_run, record=True)
    else:
        out = simulate(req, market, record=True)

    D = _deflator(req, market, out.cpi)
    paths = out.paths_net * D
    deposits = out.deposits * D
    final = paths[:, T]
    irr = irr_annual(deposits, final)

    unit = simulate(req, market, record=True, unit_growth=True).paths_net * D
    with np.errstate(divide="ignore", invalid="ignore"):
        cagr = (np.maximum(unit[:, T], 0) ** (12 / T) - 1) * 100
        peak = np.maximum.accumulate(unit, axis=1)
        max_dd = np.nanmin(np.where(peak > 0, unit / peak - 1, 0.0), axis=1) * 100

    starts = list(market.start_dates)
    ends = list(market.calendar[market.day_idx[:, -1]])
    if (final <= 0).any():
        warnings.append(f"ב-{int((final <= 0).sum())} תקופות התיק התאפס")

    return SimulationResult(start_dates=starts, end_dates=ends, months=T, final=final,
                            deposits_total=deposits.sum(axis=1), irr=irr, cagr=cagr,
                            max_drawdown=max_dd, paths=paths, deposits_path=np.cumsum(deposits, axis=1),
                            solved=solved, warnings=warnings)


__all__ = ["Holding", "Stage", "PlanRequest", "SimulationResult", "run_plan", "available_range",
           "SOLVE_FINAL", "SOLVE_MONTHLY", "SOLVE_START"]
