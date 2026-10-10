"""Engine tests on hand-built price series whose answers are known exactly."""
from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd
import pytest

from stockplan.engine import Holding, PlanRequest, Stage, run_plan
from stockplan.engine.market import apply_leverage, month_grid
from stockplan.engine.solve import irr_annual

DAYS = pd.date_range("1999-12-01", "2004-12-31", freq="D")
START = date(2000, 1, 1)


def step_series(changes: dict[str, float], base: float = 100.0) -> pd.Series:
    """Piecewise-constant daily series: ``{"2001-01-01": 2.0}`` multiplies the level by 2 from that day."""
    s = pd.Series(base, index=DAYS, dtype=float)
    for day, factor in sorted(changes.items()):
        s[s.index >= pd.Timestamp(day)] *= factor
    return s


def exp_series(annual: float) -> pd.Series:
    t = (DAYS - DAYS[0]).days.to_numpy()
    return pd.Series(100 * (1 + annual) ** (t / 365.25), index=DAYS)


class FakeData:
    is_demo = True

    def __init__(self, prices, fx=None, cpi=None):
        self._prices = prices
        self._fx = fx if fx is not None else pd.Series(3.5, index=DAYS)
        self._cpi = cpi if cpi is not None else pd.Series(100.0, index=pd.date_range(DAYS[0], DAYS[-1], freq="MS"))

    def prices(self, ticker):
        return self._prices[ticker]

    def fx_usd_ils(self):
        return self._fx

    def cpi(self, country):
        return self._cpi


def plan(stages, **kw) -> PlanRequest:
    kw.setdefault("tax_rate", 0.0)
    return PlanRequest(stages=stages, min_start=START, max_start=START, step="M", **kw)


def one(stages, data, **kw):
    res = run_plan(plan(stages, **kw), data)
    assert len(res.start_dates) == 1
    return res


# --------------------------------------------------------------------------- basics

def test_monthly_deposits_match_closed_form():
    data = FakeData({"A": exp_series(0.07)})
    res = one([Stage(months=24, holdings=[Holding("A", 100)], monthly_deposit=1000)], data)
    grid = month_grid(pd.DatetimeIndex([pd.Timestamp(START)]), 24)[0]
    p = data.prices("A").reindex(pd.DatetimeIndex(grid)).to_numpy()
    expected = sum(1000 * p[-1] / p[m] for m in range(24))
    assert res.final[0] == pytest.approx(expected, rel=1e-9)
    assert res.deposits_total[0] == pytest.approx(24_000)
    assert res.irr[0] == pytest.approx(7.0, abs=0.05)
    assert res.cagr[0] == pytest.approx(7.0, abs=0.05)


def test_multi_stage_uses_each_stages_own_months():
    # Legacy bug: stage 2 was priced on stage 1's months. B is flat in 2000 and doubles in 2001.
    data = FakeData({"A": step_series({}), "B": step_series({"2001-06-01": 2.0})})
    stages = [Stage(months=12, holdings=[Holding("A", 100)]),
              Stage(months=12, holdings=[Holding("B", 100)])]
    res = one(stages, data, start_amount=1000)
    assert res.final[0] == pytest.approx(2000)


def test_deferred_gains_are_taxed_at_the_end():
    # Legacy bug: a tax-free stage switch reset the cost basis, so stage-1 gains escaped tax.
    data = FakeData({"A": step_series({"2000-06-01": 2.0}), "B": step_series({})})
    stages = [Stage(months=12, holdings=[Holding("A", 100)]),
              Stage(months=12, holdings=[Holding("B", 100)])]
    res = one(stages, data, start_amount=1000, tax_rate=25, tax_on_switch=False)
    assert res.final[0] == pytest.approx(2000 - 0.25 * 1000)


def test_taxable_switch_pays_tax_at_switch():
    data = FakeData({"A": step_series({"2000-06-01": 2.0}), "B": step_series({"2001-06-01": 1.5})})
    stages = [Stage(months=12, holdings=[Holding("A", 100)]),
              Stage(months=12, holdings=[Holding("B", 100)])]
    res = one(stages, data, start_amount=1000, tax_rate=25, tax_on_switch=True)
    after_switch = 2000 - 250                     # 1750 reinvested, basis 1750
    final_gross = after_switch * 1.5
    assert res.final[0] == pytest.approx(final_gross - 0.25 * (final_gross - after_switch))


def test_realized_loss_shields_later_gain():
    # Legacy bug: the shield was never filled, so losses were not carried forward.
    data = FakeData({"A": step_series({"2000-06-01": 0.5}), "B": step_series({"2001-06-01": 2.0})})
    stages = [Stage(months=12, holdings=[Holding("A", 100)]),
              Stage(months=12, holdings=[Holding("B", 100)])]
    res = one(stages, data, start_amount=1000, tax_rate=25, tax_on_switch=True)
    # Loss of 500 at the switch, gain of 500 at the end: fully offset, no tax.
    assert res.final[0] == pytest.approx(1000)


def test_continuing_holding_keeps_its_basis_on_taxable_switch():
    # Only the part that is sold is taxed; a holding kept in the next stage is not.
    data = FakeData({"A": step_series({"2000-06-01": 2.0})})
    stages = [Stage(months=12, holdings=[Holding("A", 100)]),
              Stage(months=12, holdings=[Holding("A", 100)])]
    res = one(stages, data, start_amount=1000, tax_rate=25, tax_on_switch=True)
    assert res.final[0] == pytest.approx(1750)


# ------------------------------------------------------------------ real and currency

def cpi_doubling():
    months = pd.date_range(DAYS[0], DAYS[-1], freq="MS")
    return pd.Series(np.where(months >= pd.Timestamp("2000-06-01"), 200.0, 100.0), index=months)


def test_real_tax_basis_does_not_tax_inflation():
    data = FakeData({"A": step_series({"2000-06-01": 2.0})}, cpi=cpi_doubling())
    stage = [Stage(months=12, holdings=[Holding("A", 100)])]
    nominal = one(stage, data, start_amount=1000, tax_rate=25, tax_basis="nominal")
    real = one(stage, data, start_amount=1000, tax_rate=25, tax_basis="real")
    assert nominal.final[0] == pytest.approx(1750)
    assert real.final[0] == pytest.approx(2000)


def test_real_display_deflates_by_cpi():
    data = FakeData({"A": step_series({})}, cpi=cpi_doubling())
    res = one([Stage(months=12, holdings=[Holding("A", 100)])], data, start_amount=1000, real=True)
    assert res.final[0] == pytest.approx(500)
    assert res.irr[0] == pytest.approx(-50.0, abs=0.01)


def test_indexed_deposits_grow_with_cpi():
    data = FakeData({"A": step_series({})}, cpi=cpi_doubling())
    res = one([Stage(months=12, holdings=[Holding("A", 100)], monthly_deposit=100)], data,
              index_deposits=True)
    # 5 deposits before the CPI doubles (Jan-May), 7 after.
    assert res.final[0] == pytest.approx(5 * 100 + 7 * 200)


def test_ils_conversion_uses_daily_fx():
    fx = pd.Series(np.where(DAYS >= pd.Timestamp("2000-06-01"), 4.0, 3.0), index=DAYS)
    data = FakeData({"A": step_series({})}, fx=fx)
    res = one([Stage(months=12, holdings=[Holding("A", 100)])], data, start_amount=3000, currency="ILS")
    assert res.final[0] == pytest.approx(4000)


# ------------------------------------------------------------------------- solvers

@pytest.mark.parametrize("tax", [0.0, 25.0])
def test_solve_monthly_deposit_hits_target(tax):
    data = FakeData({"A": exp_series(0.08)})
    stages = [Stage(months=36, holdings=[Holding("A", 100)], monthly_deposit=0)]
    req = PlanRequest(stages=stages, target_amount=100_000, solve_for="monthly_deposit",
                      tax_rate=tax, step="M", min_start=START, max_start=date(2001, 1, 1))
    res = run_plan(req, data)
    assert np.all(np.isfinite(res.solved))
    assert np.allclose(res.final, 100_000, rtol=1e-6)
    if tax == 0:
        grid = month_grid(pd.DatetimeIndex([pd.Timestamp(START)]), 36)[0]
        p = data.prices("A").reindex(pd.DatetimeIndex(grid)).to_numpy()
        assert res.solved[0] == pytest.approx(100_000 / sum(p[-1] / p[m] for m in range(36)), rel=1e-6)


def test_solver_matches_closed_form_with_tax():
    # Without a taxable switch the net value is linear in the deposit on each side of the
    # "gain > 0" kink, so the deposit has a closed form (see the math tab in the UI):
    #   M = (F - (1-tau) S0 G0 - tau S0) / ((1-tau) sum_m G_m + tau T),  G_m = P_T / P_m
    data = FakeData({"A": exp_series(0.08)})
    T, S0, tau, F = 36, 5000.0, 0.25, 100_000.0
    stages = [Stage(months=T, holdings=[Holding("A", 100)])]
    res = run_plan(PlanRequest(stages=stages, start_amount=S0, target_amount=F, tax_rate=100 * tau,
                               solve_for="monthly_deposit", min_start=START, max_start=START), data)
    grid = month_grid(pd.DatetimeIndex([pd.Timestamp(START)]), T)[0]
    p = data.prices("A").reindex(pd.DatetimeIndex(grid)).to_numpy()
    G = p[-1] / p[:-1]
    M = (F - (1 - tau) * S0 * G[0] - tau * S0) / ((1 - tau) * G.sum() + tau * T)
    assert res.solved[0] == pytest.approx(M, rel=1e-6)


def test_solve_start_amount_hits_target():
    data = FakeData({"A": exp_series(0.05)})
    stages = [Stage(months=24, holdings=[Holding("A", 100)], monthly_deposit=500)]
    res = run_plan(PlanRequest(stages=stages, target_amount=50_000, solve_for="start_amount",
                               tax_rate=25, min_start=START, max_start=START), data)
    assert res.final[0] == pytest.approx(50_000, rel=1e-6)


def test_target_already_reached_gives_zero():
    data = FakeData({"A": exp_series(0.05)})
    stages = [Stage(months=24, holdings=[Holding("A", 100)], monthly_deposit=5000)]
    res = run_plan(PlanRequest(stages=stages, target_amount=1000, solve_for="start_amount",
                               min_start=START, max_start=START), data)
    assert res.solved[0] == 0.0


def test_drawdown_of_strategy_and_of_account():
    # Price halves on 2000-06-01 (month 5). The strategy falls 50%; the account, which had
    # 1000 + 5 x 100 = 1500 at its peak, holds 750 + 100 = 850 right after the drop.
    data = FakeData({"A": step_series({"2000-06-01": 0.5})})
    res = one([Stage(months=12, holdings=[Holding("A", 100)], monthly_deposit=100)], data, start_amount=1000)
    assert res.max_drawdown[0] == pytest.approx(-50.0)
    assert res.account_drawdown[0] == pytest.approx((850 / 1500 - 1) * 100)


def test_irr_simple_cases():
    dep = np.zeros((2, 13))
    dep[:, 0] = 100
    assert irr_annual(dep, np.array([110.0, 100.0])) == pytest.approx([10.0, 0.0], abs=1e-6)


# --------------------------------------------------------------------------- helpers

def test_apply_leverage_daily():
    s = pd.Series([100.0, 110.0, 99.0], index=pd.date_range("2020-01-01", periods=3))
    assert apply_leverage(s, 2.0).iloc[-1] == pytest.approx(100 * 1.2 * 0.8)
    assert apply_leverage(s, 3.0, annual_cost_pct=0).iloc[-1] == pytest.approx(100 * 1.3 * 0.7)
    crash = pd.Series([100.0, 40.0, 50.0], index=s.index)
    assert apply_leverage(crash, 2.0).iloc[-1] == 0.0


def test_month_grid_clips_day_of_month():
    g = month_grid(pd.DatetimeIndex(["2001-01-31"]), 2)[0]
    assert [str(d) for d in g] == ["2001-01-31", "2001-02-28", "2001-03-31"]


def test_start_dates_and_step():
    data = FakeData({"A": exp_series(0.05)})
    stages = [Stage(months=12, holdings=[Holding("A", 100)], monthly_deposit=100)]
    req = PlanRequest(stages=stages, step="W", min_start=START, max_start=date(2000, 3, 1))
    res = run_plan(req, data)
    assert len(res.start_dates) == 9
    assert res.paths.shape == (9, 13)
    assert np.allclose(res.paths[:, -1], res.final)


def test_validation_messages():
    data = FakeData({"A": exp_series(0.05)})
    with pytest.raises(ValueError):
        run_plan(plan([Stage(months=0, holdings=[Holding("A", 100)])]), data)
    with pytest.raises(ValueError):
        run_plan(plan([Stage(months=12, holdings=[Holding("A", 0)])]), data)


def test_real_mode_inputs_are_in_todays_money():
    # CPI doubles in June 2000 and stays there, so "today" is CPI 200.
    data = FakeData({"A": step_series({})}, cpi=cpi_doubling())
    res = one([Stage(months=12, holdings=[Holding("A", 100)], monthly_deposit=100)], data,
              real=True, index_deposits=True)
    # Each deposit is 100 of today's money when made; the 5 made before the CPI doubled
    # lose half their real value afterwards.
    assert res.final[0] == pytest.approx(5 * 50 + 7 * 100)
    # Deposits are counted in today's money at the time they were made.
    assert res.deposits_total[0] == pytest.approx(12 * 100)


def test_real_mode_non_indexed_deposits_are_fixed_nominal():
    data = FakeData({"A": step_series({})}, cpi=cpi_doubling())
    res = one([Stage(months=12, holdings=[Holding("A", 100)], monthly_deposit=100)], data, real=True)
    # Nominal amount fixed at the start: 100 today = 50 nominal in Jan 2000, for all 12 deposits.
    assert res.final[0] == pytest.approx(12 * 50)


def test_nominal_shekels_start_after_stabilization_plan():
    days = pd.date_range("1980-01-01", "1990-12-31", freq="D")
    prices = pd.Series(100.0, index=days)
    cpi = pd.Series(100.0, index=pd.date_range(days[0], days[-1], freq="MS"))
    data = FakeData({"A": prices}, fx=pd.Series(1.0, index=days), cpi=cpi)
    stages = [Stage(months=12, holdings=[Holding("A", 100)], monthly_deposit=100)]
    nominal = run_plan(PlanRequest(stages=stages, currency="ILS"), data)
    assert nominal.start_dates[0] >= pd.Timestamp("1985-07-01")
    real = run_plan(PlanRequest(stages=stages, currency="ILS", real=True), data)
    assert real.start_dates[0] < pd.Timestamp("1981-01-01")
    usd = run_plan(PlanRequest(stages=stages, currency="USD"), data)
    assert usd.start_dates[0] < pd.Timestamp("1981-01-01")


def test_trace_illinois_matches_the_vectorized_solver():
    from stockplan.engine.solve import solve_monotone, trace_illinois
    f = lambda x: 3 * x - 20 + 0.1 * max(x - 5, 0)          # increasing, piecewise linear
    tr = trace_illinois(f, 50.0, 4.0)
    vec = solve_monotone(lambda x, rows: 3 * x - 20 + 0.1 * np.maximum(x - 5, 0), 50.0, 1, 4.0)
    assert tr["converged"] and tr["x"] == pytest.approx(vec[0], rel=1e-6)
    assert [s["phase"] for s in tr["steps"][:2]] == ["start", "expand"]
    assert trace_illinois(f, -100.0, 4.0)["x"] == 0.0        # target already reached at 0
