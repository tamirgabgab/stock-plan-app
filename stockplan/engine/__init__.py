"""Simulation engine: pure numpy/pandas, no web or UI code."""
from __future__ import annotations

import numpy as np

from ..data.base import DataError, MarketData
from .market import Market, available_range, prepare_market
from .models import (SOLVE_FINAL, SOLVE_MODES, SOLVE_MONTHLY, SOLVE_RATE, SOLVE_START,
                     TRINITY_SOLVE_MODES, Holding, PlanRequest, SimulationResult, Stage,
                     WithdrawRequest, WithdrawResult, WithdrawStage)
from .simulate import simulate
from .solve import irr_annual, solve_monotone, trace_illinois
from .withdraw import simulate_withdraw


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
        raise ValueError("סכום סופי (היעד) חייב להיות חיובי")


def _deflator(req, market: Market, cpi) -> np.ndarray:
    """(R, T+1) factor converting nominal values to today's money (CPI of the last data month)."""
    R, T1 = market.day_idx.shape
    if not req.real or cpi is None:
        return np.ones((R, T1))
    return market.cpi_base / cpi


def _max_drawdown(x: np.ndarray) -> np.ndarray:
    """(R,) worst peak-to-trough fall of each row, in percent (negative or zero)."""
    peak = np.maximum.accumulate(x, axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.nanmin(np.where(peak > 0, x / peak - 1, 0.0), axis=1) * 100


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
                out = out * market.cpi_base / cpi_all[rows, T]
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
        max_dd = _max_drawdown(unit)
        account_dd = _max_drawdown(paths)

    starts = list(market.start_dates)
    ends = list(market.calendar[market.day_idx[:, -1]])
    if (final <= 0).any():
        warnings.append(f"ב-{int((final <= 0).sum())} תקופות התיק התאפס")

    return SimulationResult(start_dates=starts, end_dates=ends, months=T, final=final,
                            deposits_total=deposits.sum(axis=1), irr=irr, cagr=cagr,
                            max_drawdown=max_dd, account_drawdown=account_dd, paths=paths,
                            deposits_path=np.cumsum(deposits, axis=1),
                            solved=solved, warnings=warnings)


# ------------------------------------------------------------------ withdrawal (Trinity)

def validate_withdraw(req: WithdrawRequest) -> None:
    if not req.stages:
        raise ValueError("יש להגדיר לפחות שלב אחד")
    if req.solve_for not in TRINITY_SOLVE_MODES:
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
        if s.rate < 0 or s.amount < 0 or s.floor < 0 or s.ceiling < 0 or s.one_time < 0:
            raise ValueError(f"בשלב {i} המשיכות לא יכולות להיות שליליות")
        if s.ceiling > 0 and s.floor > s.ceiling:
            raise ValueError(f"בשלב {i} הרצפה גדולה מהתקרה")
    if not 0 <= req.tax_rate < 100:
        raise ValueError("שיעור המס חייב להיות בין 0 ל-100")
    if req.solve_for == SOLVE_START and req.target_amount <= 0:
        raise ValueError("לפתרון הסכום ההתחלתי צריך יעד סופי חיובי")
    if req.solve_for != SOLVE_START and req.start_amount <= 0:
        raise ValueError("סכום התחלתי חייב להיות חיובי")


def run_trinity(req: WithdrawRequest, md: MarketData) -> WithdrawResult:
    validate_withdraw(req)
    market = prepare_market(req, md)
    R = len(market.start_dates)
    T = req.total_months
    warnings = []
    cpi_all = market.cpi_daily[market.day_idx] if market.cpi_daily is not None else None

    def display(final, rows):
        if req.real and cpi_all is not None:
            return final * market.cpi_base / cpi_all[rows, T]
        return final

    def score(x, rows):
        # Final value minus the withdrawals that could not be paid: strictly monotone in the
        # unknown even after the portfolio is exhausted (where the final value alone is flat).
        out = simulate_withdraw(req, market, x=x, rows=rows)
        return display(out.final_net - out.unpaid, rows)

    solved = None
    if req.solve_for == SOLVE_RATE:
        # The score falls as the rate rises: solve on the negated function.
        solved = solve_monotone(lambda x, rows: -score(x, rows), -req.target_amount, R, 4.0)
    elif req.solve_for == SOLVE_START:
        solved = solve_monotone(score, req.target_amount, R, max(req.start_amount, req.target_amount, 1.0))
    if solved is not None:
        n_bad = int(np.isnan(solved).sum())
        if n_bad:
            warnings.append(f"ב-{n_bad} תקופות אין פתרון")
        out = simulate_withdraw(req, market, x=np.where(np.isnan(solved), 0.0, solved), record=True)
    else:
        out = simulate_withdraw(req, market, record=True)

    D = _deflator(req, market, out.cpi)
    paths = out.paths_net * D
    paid = out.withdrawals * D
    final = paths[:, T]
    if solved is None:
        success = (out.shortfall_at < 0) & (final >= req.target_amount - 1e-6)
        n_fail = int((~success).sum())
        if n_fail:
            warnings.append(f"ב-{n_fail} תקופות התוכנית נכשלה (הכסף נגמר או שנשאר פחות מהיעד)")
    else:
        # The solved plan sits exactly on the success boundary; "success" means a solution exists.
        success = ~np.isnan(solved)
    return WithdrawResult(start_dates=list(market.start_dates), end_dates=list(market.calendar[market.day_idx[:, -1]]),
                          months=T, final=final, withdrawn_total=paid.sum(axis=1), min_balance=paths.min(axis=1),
                          depleted_at=out.shortfall_at, success=success, paths=paths,
                          withdrawals_path=np.cumsum(paid, axis=1), solved=solved, warnings=warnings)


def trinity_heatmap(req: WithdrawRequest, md: MarketData, rates, years) -> dict:
    """Success rate of a single-stage plan (the first stage's portfolio and settings) for
    every (withdrawal rate, horizon). Each horizon is one vectorized pass over all rates:
    the realizations are repeated once per rate.

    Returns survival (every withdrawal paid) and preservation (also ended with at least
    the start amount, in display units) as percent matrices [year][rate]; None where the
    data is too short for that horizon.
    """
    from dataclasses import replace
    validate_withdraw(replace(req, solve_for=SOLVE_FINAL))
    rates = np.asarray(rates, dtype=float)
    survival, preserve, counts = [], [], []
    base_stage = replace(req.stages[0], rate_unit="pct")
    for y in years:
        req_y = replace(req, stages=[replace(base_stage, months=int(y) * 12)], solve_for=SOLVE_RATE)
        try:
            market = prepare_market(req_y, md)
        except DataError:
            survival.append([None] * len(rates)); preserve.append([None] * len(rates)); counts.append(0)
            continue
        R = len(market.start_dates)
        T = req_y.total_months
        rows = np.repeat(np.arange(R), len(rates))
        x = np.tile(rates, R)
        out = simulate_withdraw(req_y, market, x=x, rows=rows)
        final = out.final_net
        if req.real and market.cpi_daily is not None:
            final = final * market.cpi_base / market.cpi_daily[market.day_idx][rows, T]
        ok = (out.shortfall_at < 0).reshape(R, len(rates))
        kept = ok & (final >= req.start_amount - 1e-6).reshape(R, len(rates))
        survival.append([round(float(v), 2) for v in ok.mean(axis=0) * 100])
        preserve.append([round(float(v), 2) for v in kept.mean(axis=0) * 100])
        counts.append(R)
    return {"rates": [float(r) for r in rates], "years": [int(y) for y in years],
            "survival": survival, "preservation": preserve, "counts": counts}


def solve_trace(req, md: MarketData) -> dict:
    """The solver's steps on one realization (the one whose solution is the median), plus
    the function sampled on a grid, for the math tab's live chart.

    Works for both request types. ``y`` is the display-currency final value (accumulation)
    or the score "final minus unpaid withdrawals" (Trinity); the solver itself runs on
    the negated score when solving for a withdrawal rate, since that one decreases in x.
    """
    trinity = isinstance(req, WithdrawRequest)
    if req.solve_for == SOLVE_FINAL:
        raise ValueError("במצב סכום סופי אין נעלם ואין מה לפתור")
    if trinity:
        validate_withdraw(req)
    else:
        validate(req)
    market = prepare_market(req, md)
    R, T = len(market.start_dates), req.total_months
    cpi_all = market.cpi_daily[market.day_idx] if market.cpi_daily is not None else None

    def value(x, rows):
        if trinity:
            out = simulate_withdraw(req, market, x=x, rows=rows)
            v = out.final_net - out.unpaid
        else:
            v = simulate(req, market, x=x, rows=rows).final_net
        if req.real and cpi_all is not None:
            v = v * market.cpi_base / cpi_all[rows, T]
        return v

    sign = -1.0 if (trinity and req.solve_for == SOLVE_RATE) else 1.0
    guess = 4.0 if (trinity and req.solve_for == SOLVE_RATE) else (
        max(req.start_amount, req.target_amount, 1.0) if trinity else _initial_guess(req))
    solved = solve_monotone(lambda x, rows: sign * value(x, rows), sign * req.target_amount, R, guess)
    finite = np.where(np.isfinite(solved))[0]
    if len(finite) == 0:
        raise ValueError("אין פתרון באף תקופה")
    med = float(np.median(solved[finite]))
    r = int(finite[np.argmin(np.abs(solved[finite] - med))])
    row = np.array([r])

    def f(x):
        return float(value(np.array([float(x)]), row)[0])

    trace = trace_illinois(lambda x: sign * f(x), sign * req.target_amount, guess)
    for st in trace["steps"]:
        st["y"] = sign * st["y"]
    x_star = trace["x"] if trace["x"] is not None else float(solved[r])
    x_max = max(x_star * 1.6, max((s["x"] for s in trace["steps"]), default=1.0) * 1.05, 1e-6)
    grid = np.linspace(0.0, x_max, 60)
    ys = value(grid, np.full(len(grid), r))
    return {"start_date": market.start_dates[r].strftime("%Y-%m-%d"), "x": trace["x"],
            "converged": trace["converged"], "target": req.target_amount, "steps": trace["steps"],
            "grid_x": [float(v) for v in grid], "grid_y": [None if not np.isfinite(v) else float(v) for v in ys],
            "n": R, "solved_median": med}


from .detail import realization_detail  # noqa: E402  (uses run_plan / run_trinity above)

__all__ = ["realization_detail", "Holding", "Stage", "PlanRequest", "SimulationResult", "run_plan", "available_range",
           "SOLVE_FINAL", "SOLVE_MONTHLY", "SOLVE_START", "SOLVE_RATE",
           "WithdrawStage", "WithdrawRequest", "WithdrawResult", "run_trinity", "trinity_heatmap", "solve_trace"]
