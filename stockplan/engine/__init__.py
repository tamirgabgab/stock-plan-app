"""Simulation engine: pure numpy/pandas, no web or UI code."""
from __future__ import annotations

from dataclasses import replace

import numpy as np

from ..data.base import DataError, MarketData
from .market import Market, available_range, prepare_market
from .models import (DEPOSIT_EVERY, REBALANCE_RULES, DepositEvent, SOLVE_AMOUNT, SOLVE_WITHDRAWAL, SOLVE_FINAL, SOLVE_MODES, SOLVE_MONTHLY, SOLVE_RATE, SOLVE_START,
                     TRINITY_SOLVE_MODES, Holding, PlanRequest, SimulationResult, Stage,
                     WithdrawRequest, WithdrawResult, WithdrawStage)
from .simulate import cohort_values, simulate
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
        if s.kind not in ("deposit", "withdraw"):
            raise ValueError(f"בשלב {i} סוג השלב לא מוכר ({s.kind})")
        if s.withdraws:
            _validate_withdraw_stage(s, i)
    if not 0 <= req.tax_rate < 100:
        raise ValueError("שיעור המס חייב להיות בין 0 ל-100")
    if req.solve_for == SOLVE_WITHDRAWAL and not req.has_withdrawals:
        raise ValueError("כדי לחשב משיכה מקסימלית צריך לפחות שלב משיכה אחד")
    if req.solve_for == SOLVE_MONTHLY and all(s.withdraws for s in req.stages):
        raise ValueError("כדי לחשב הפקדה נדרשת צריך לפחות שלב הפקדה אחד")
    if req.solve_for != SOLVE_FINAL and req.target_amount < 0:
        raise ValueError("הסכום הסופי (היעד) לא יכול להיות שלילי")
    if req.solve_for != SOLVE_FINAL and req.target_amount == 0 and not req.has_withdrawals:
        raise ValueError("סכום סופי (היעד) חייב להיות חיובי")
    if req.deposit_every not in DEPOSIT_EVERY:
        raise ValueError("תדירות ההפקדה חייבת להיות כל 1, 3, 6 או 12 חודשים")
    if not -50 <= req.deposit_growth <= 100:
        raise ValueError("הצמיחה השנתית של ההפקדה חייבת להיות בין -50% ל-100%")
    T = req.total_months
    if not 0 <= req.lump_spread <= T:
        raise ValueError(f"פריסת הסכום ההתחלתי חייבת להיות בין 0 ל-{T} חודשים (משך התוכנית)")
    if not -10 <= req.cash_rate <= 50:
        raise ValueError("הריבית על המזומן חייבת להיות בין -10% ל-50%")
    _validate_rebalance(req)
    for k, e in enumerate(req.events, 1):
        if e.kind not in ("deposit", "withdraw", "pause"):
            raise ValueError(f"אירוע {k}: סוג לא מוכר ({e.kind})")
        if not 0 <= e.month < T:
            raise ValueError(f"אירוע {k}: החודש חייב להיות בתוך התוכנית (שנה 1 עד שנה {(T - 1) // 12 + 1})")
        if e.amount < 0:
            raise ValueError(f"אירוע {k}: הסכום לא יכול להיות שלילי")
        if e.kind == "pause" and e.months < 1:
            raise ValueError(f"אירוע {k}: הפסקה חייבת להיות של חודש אחד לפחות")


def _validate_withdraw_stage(s, i: int) -> None:
    """A withdrawal stage's settings (the Trinity tab's stage and the lifecycle's)."""
    if s.rate < 0 or s.amount < 0 or s.floor < 0 or s.ceiling < 0 or s.one_time < 0:
        raise ValueError(f"בשלב {i} המשיכות לא יכולות להיות שליליות")
    if s.ceiling > 0 and s.floor > s.ceiling:
        raise ValueError(f"בשלב {i} הרצפה גדולה מהתקרה")
    if s.rate_unit not in ("pct", "money") or s.basis not in ("initial", "current") \
            or s.guard_unit not in ("pct", "money") or s.one_time_unit not in ("pct", "money"):
        raise ValueError(f"בשלב {i} הגדרת המשיכה לא מוכרת")


def _validate_rebalance(req) -> None:
    if req.rebalance not in REBALANCE_RULES:
        raise ValueError(f"כלל איזון לא מוכר: {req.rebalance}")
    if req.rebalance == "band" and not 0 < req.rebalance_band <= 50:
        raise ValueError("סף האיזון חייב להיות בין 0 ל-50 נקודות אחוז")


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
        return max(req.target_amount, 1.0) / growth
    if req.solve_for == SOLVE_WITHDRAWAL:
        # 4% a year of what the deposits would grow to by the first withdrawal stage, at 7%.
        mr = max(req.retire_month, 1)
        g = (1 + r) ** mr
        monthly = np.mean([s.monthly_deposit for s in req.stages if not s.withdraws] or [0.0])
        return max(0.04 / 12 * (req.start_amount * g + monthly * (g - 1) / r), 100.0)
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

        def score(x, rows):
            # Final value minus the withdrawals that could not be paid: strictly monotone in the
            # unknown even after the account runs dry (where the final value alone is flat).
            out = simulate(req, market, x=x, rows=rows)
            v = out.final_net - out.unpaid
            if req.real and cpi_all is not None:
                v = v * market.cpi_base / cpi_all[rows, T]
            return v

        if req.solve_for == SOLVE_WITHDRAWAL:
            # The score falls as the withdrawal rises: solve on the negated function. A row
            # that misses the target even with no withdrawal at all has no solution.
            solved = solve_monotone(lambda x, rows: -score(x, rows), -req.target_amount, R, _initial_guess(req))
            zero = np.where(solved == 0)[0]
            if len(zero):
                miss = score(np.zeros(len(zero)), zero) < req.target_amount - max(abs(req.target_amount) * 1e-7, 1e-4)
                solved[zero[miss]] = np.nan
        else:
            solved = solve_monotone(score, req.target_amount, R, _initial_guess(req))
        n_bad = int(np.isnan(solved).sum())
        if n_bad:
            warnings.append(f"ב-{n_bad} תקופות לא ניתן להגיע ליעד (למשל התיק התאפס)")
        x_run = np.where(np.isnan(solved), 0.0, solved)
        out = simulate(req, market, x=x_run, record=True)
    else:
        out = simulate(req, market, record=True)

    D = _deflator(req, market, out.cpi)
    paths = out.paths_net * D
    gross = out.paths_gross * D
    deposits = out.deposits * D
    withdrawn = out.withdrawn * D
    final = paths[:, T]
    final_gross = gross[:, T]
    irr = irr_annual(deposits - withdrawn, final)
    irr_gross = irr_annual(deposits - withdrawn, final_gross)
    year_gross, year_net = _cohort_irr(req, market, out, D)
    n_unpaid = int((out.events_unpaid > 1e-6).sum())
    if n_unpaid:
        warnings.append(f"ב-{n_unpaid} תקופות לא היה מספיק כסף בתיק לכל המשיכות החד-פעמיות")

    unit = simulate(req, market, record=True, unit_growth=True).paths_net * D
    with np.errstate(divide="ignore", invalid="ignore"):
        cagr = (np.maximum(unit[:, T], 0) ** (12 / T) - 1) * 100
        max_dd = _max_drawdown(unit)
        account_dd = _max_drawdown(paths)
        account_dd_gross = _max_drawdown(gross)

    # The same deposits with no fees, and with the start amount invested at once.
    x_same = x_run if solved is not None else None
    final_nofee = final_nofee_gross = final_lump = final_lump_gross = None
    if req.annual_fee > 0:
        alt = simulate(replace(req, annual_fee=0.0), market, x=x_same)
        final_nofee, final_nofee_gross = alt.final_net * D[:, T], alt.final_gross * D[:, T]
    if req.lump_spread > 0 and (req.start_amount + req.stages[0].initial_deposit > 0 or req.solve_for == SOLVE_START):
        alt = simulate(replace(req, lump_spread=0), market, x=x_same)
        final_lump, final_lump_gross = alt.final_net * D[:, T], alt.final_gross * D[:, T]

    success = depleted_at = retire_value = None
    if req.has_withdrawals:
        depleted_at = out.shortfall_at
        retire_value = out.retire_value * D[:, req.retire_month]
        if solved is None:
            success = depleted_at < 0
            n_fail = int((~success).sum())
            if n_fail:
                warnings.append(f"ב-{n_fail} תקופות הכסף נגמר לפני סוף שלבי המשיכה")
        else:
            success = ~np.isnan(solved)

    starts = list(market.start_dates)
    ends = list(market.calendar[market.day_idx[:, -1]])
    if (final <= 0).any() and not req.has_withdrawals:
        warnings.append(f"ב-{int((final <= 0).sum())} תקופות התיק התאפס")

    return SimulationResult(start_dates=starts, end_dates=ends, months=T, final=final,
                            deposits_total=deposits.sum(axis=1), irr=irr, cagr=cagr,
                            max_drawdown=max_dd, account_drawdown=account_dd, paths=paths,
                            deposits_path=np.cumsum(deposits - withdrawn, axis=1),
                            solved=solved, warnings=warnings,
                            final_gross=final_gross, irr_gross=irr_gross, account_drawdown_gross=account_dd_gross,
                            paths_gross=gross, year_irr_gross=year_gross, year_irr_net=year_net,
                            withdrawn_total=withdrawn.sum(axis=1),
                            target_month_gross=first_reach(gross, req.target_amount),
                            target_month_net=first_reach(paths, req.target_amount),
                            fees_total=(out.fees * D).sum(axis=1), tax_paid=(out.taxes * D).sum(axis=1),
                            final_nofee=final_nofee, final_nofee_gross=final_nofee_gross,
                            final_lump=final_lump, final_lump_gross=final_lump_gross,
                            success=success, depleted_at=depleted_at, retire_value=retire_value,
                            retire_month=req.retire_month)


def first_reach(paths: np.ndarray, target: float) -> np.ndarray:
    """(R,) first month the path is at or above ``target`` (-1 = never, or no target)."""
    if target <= 0:
        return np.full(paths.shape[0], -1, dtype=np.int64)
    hit = paths >= target
    return np.where(hit.any(axis=1), hit.argmax(axis=1), -1)


def _cohort_irr(req: PlanRequest, market: Market, out, D: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(R, years) annual return of each plan year's deposits held to the end, gross and net.

    Net takes the plan's tax rate off the cohort's own gain (value minus its deposits); the
    loss shield and a real tax basis are left out, so it is the simple "tax on the profit"
    the user expects, not the book's exact tax.
    """
    T = req.total_months
    years = max(T // 12, 1)
    value = cohort_values(req, market, out, years) * D[:, T:T + 1]     # display units
    deposits = out.deposits * D
    R = deposits.shape[0]
    flows = np.zeros((R, years, 12))
    exps = np.zeros((years, 12))
    for y in range(years):
        L = min(12, T - 12 * y)
        flows[:, y, :L] = deposits[:, 12 * y:12 * y + L]
        exps[y, :L] = T - (12 * y + np.arange(L))
    cost = flows.sum(axis=2)
    v_net = value - req.tax_rate / 100 * np.maximum(value - cost, 0.0)
    return _irr_cohorts(flows, exps, cost, value), _irr_cohorts(flows, exps, cost, v_net)


def _irr_cohorts(flows: np.ndarray, exps: np.ndarray, cost: np.ndarray, value: np.ndarray) -> np.ndarray:
    """Annual IRR (percent) of 12 monthly flows (R, Y, 12) compounding ``exps`` (Y, 12) months
    to ``value`` (R, Y). Bisection on the monthly rate, every cohort at once."""
    lo = np.full(value.shape, -0.9999)
    hi = np.full(value.shape, 1.0)
    with np.errstate(over="ignore", invalid="ignore"):
        for _ in range(70):
            mid = 0.5 * (lo + hi)
            fv = (flows * (1.0 + mid)[:, :, None] ** exps[None]).sum(axis=2)
            above = fv > value
            hi = np.where(above, mid, hi)
            lo = np.where(above, lo, mid)
    i = 0.5 * (lo + hi)
    out = ((1 + i) ** 12 - 1) * 100
    out[value <= 0] = -100.0
    out[cost <= 0] = np.nan          # a year without deposits (a pause) has no return
    return out


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
        _validate_withdraw_stage(s, i)
    _validate_rebalance(req)
    if not 0 <= req.tax_rate < 100:
        raise ValueError("שיעור המס חייב להיות בין 0 ל-100")
    if req.solve_for == SOLVE_START and req.target_amount <= 0:
        raise ValueError("לפתרון הסכום ההתחלתי צריך יעד סופי חיובי")
    if req.solve_for != SOLVE_START and req.start_amount <= 0:
        raise ValueError("סכום התחלתי חייב להיות חיובי")


def _trinity_guess(req: WithdrawRequest) -> float:
    """Starting bracket for the withdrawal solvers: 4% a year, as a rate or as money a month."""
    if req.solve_for == SOLVE_AMOUNT:
        return max(req.start_amount * 0.04 / 12, 1.0)
    if req.solve_for == SOLVE_RATE:
        return 4.0
    return max(req.start_amount, req.target_amount, 1.0)


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
    if req.solve_for in (SOLVE_RATE, SOLVE_AMOUNT):
        # The score falls as the withdrawal rises: solve on the negated function.
        solved = solve_monotone(lambda x, rows: -score(x, rows), -req.target_amount, R, _trinity_guess(req))
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
        # The final balance is the unknown here, so success only means "the money lasted".
        success = out.shortfall_at < 0
        n_fail = int((~success).sum())
        if n_fail:
            warnings.append(f"ב-{n_fail} תקופות הכסף נגמר לפני הסוף")
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
            out = simulate(req, market, x=x, rows=rows)
            v = out.final_net - out.unpaid
        if req.real and cpi_all is not None:
            v = v * market.cpi_base / cpi_all[rows, T]
        return v

    sign = -1.0 if (req.solve_for == SOLVE_WITHDRAWAL or (trinity and req.solve_for in (SOLVE_RATE, SOLVE_AMOUNT))) else 1.0
    guess = _trinity_guess(req) if trinity else _initial_guess(req)
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


from .detail import benchmark_path, realization_detail  # noqa: E402  (uses run_plan / run_trinity above)

__all__ = ["DepositEvent", "SOLVE_WITHDRAWAL", "benchmark_path", "realization_detail", "Holding", "Stage", "PlanRequest", "SimulationResult", "run_plan", "available_range",
           "SOLVE_FINAL", "SOLVE_MONTHLY", "SOLVE_START", "SOLVE_RATE", "SOLVE_AMOUNT",
           "WithdrawStage", "WithdrawRequest", "WithdrawResult", "run_trinity", "trinity_heatmap", "solve_trace"]
