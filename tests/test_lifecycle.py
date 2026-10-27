"""Lifecycle plans: deposit stages followed by withdrawal stages in the accumulation tab."""
from __future__ import annotations

import pandas as pd
import pytest
from fastapi.testclient import TestClient

import stockplan.data as data_mod
from stockplan.api import app
from stockplan.data import DemoMarketData
from stockplan.engine import Holding, Stage, WithdrawRequest, WithdrawStage, run_plan, run_trinity
from test_engine import DAYS, FakeData, START, exp_series, one, step_series

FLAT = {"A": step_series({})}
A = [Holding("A", 100)]


def saving(months=12, deposit=1000.0, **kw):
    return Stage(months=months, monthly_deposit=deposit, holdings=A, **kw)


def retiring(months=12, **kw):
    return Stage(months=months, holdings=A, kind="withdraw", **kw)


@pytest.mark.parametrize("real", [False, True])
def test_a_withdrawal_stage_matches_the_trinity_tab(real):
    # A plan that starts with a withdrawal stage is the Trinity tab: same withdrawals, same tax.
    cpi = pd.Series(100 * 1.03 ** ((pd.date_range(DAYS[0], DAYS[-1], freq="MS") - DAYS[0]).days / 365.25),
                    index=pd.date_range(DAYS[0], DAYS[-1], freq="MS"))
    data = FakeData({"A": exp_series(0.08)}, cpi=cpi)
    rule = dict(rate=5.0, basis="initial", one_time=2000, one_time_unit="money")
    life = one([retiring(36, **rule)], data, start_amount=100_000, tax_rate=25, real=real)
    tri = run_trinity(WithdrawRequest(stages=[WithdrawStage(months=36, holdings=A, **rule)], start_amount=100_000,
                                      tax_rate=25, real=real, min_start=START, max_start=START), data)
    assert life.final[0] == pytest.approx(tri.final[0], rel=1e-9)
    assert life.withdrawn_total[0] == pytest.approx(tri.withdrawn_total[0], rel=1e-9)
    assert life.retire_value[0] == pytest.approx(100_000)          # input units: today's money in real mode


def test_percent_of_the_balance_at_retirement():
    # 12 x 1000 saved on flat prices, then 4% a year of the 12,000: 40 a month for a year.
    res = one([saving(), retiring(rate=4.0)], FakeData(FLAT))
    assert res.retire_month == 12 and res.retire_value[0] == pytest.approx(12_000)
    assert res.withdrawn_total[0] == pytest.approx(480)
    assert res.final[0] == pytest.approx(12_000 - 480)
    assert res.deposits_path[0, -1] == pytest.approx(12_000 - 480)     # money put in minus taken out
    assert bool(res.success[0]) and res.depleted_at[0] == -1


def test_the_basis_is_the_net_balance():
    # A doubles before month 6: 1000 -> 2000, 1750 after a 25% tax on the gain. 12% a year of it.
    data = FakeData({"A": step_series({"2000-06-15": 2.0})})
    res = one([Stage(months=12, holdings=A), retiring(rate=12.0)], data, start_amount=1000, tax_rate=25)
    assert res.retire_value[0] == pytest.approx(1750)
    assert res.withdrawn_total[0] == pytest.approx(12 * 17.5)


def test_running_out_is_detected():
    res = one([retiring(amount=100.0, rate_unit="money")], FakeData(FLAT), start_amount=1000)
    assert res.depleted_at[0] == 10 and not res.success[0]
    assert res.withdrawn_total[0] == pytest.approx(1000)
    assert any("הכסף נגמר" in w for w in res.warnings)


def test_solve_the_required_deposit():
    res = one([saving(deposit=0), retiring(amount=100.0, rate_unit="money")], FakeData(FLAT),
              solve_for="monthly_deposit", target_amount=0)
    assert res.solved[0] == pytest.approx(100, rel=1e-6)
    assert bool(res.success[0])


@pytest.mark.parametrize("target", [0, 2000])
def test_solve_the_largest_withdrawal(target):
    res = one([saving(), retiring(), retiring()], FakeData(FLAT), solve_for="withdrawal", target_amount=target)
    # 12,000 saved, spread over the 24 months of both withdrawal stages (the same amount in each).
    assert res.solved[0] == pytest.approx((12_000 - target) / 24, rel=1e-6)


def test_solve_the_required_start_amount():
    res = one([retiring(amount=100.0, rate_unit="money")], FakeData(FLAT), solve_for="start_amount", target_amount=0)
    assert res.solved[0] == pytest.approx(1200, rel=1e-6)


def test_withdrawal_solve_needs_a_withdrawal_stage():
    with pytest.raises(ValueError, match="שלב משיכה"):
        one([saving()], FakeData(FLAT), solve_for="withdrawal", target_amount=0)


def test_api_lifecycle(monkeypatch):
    monkeypatch.setattr(data_mod, "_provider", DemoMarketData(end="2026-01-01"))
    body = {"stages": [{"months": 120, "monthly_deposit": 2000, "holdings": [{"ticker": "SPY", "weight": 100}]},
                       {"months": 120, "kind": "withdraw", "rate": 4, "holdings": [{"ticker": "SPY", "weight": 60},
                                                                                   {"ticker": "TLT", "weight": 40}]}],
            "currency": "USD", "step": "M", "real": True}
    out = TestClient(app).post("/api/simulate", json=body).json()
    assert out["retire_month"] == 120 and len(out["success"]) == out["n"]
    assert all(v > 0 for v in out["retire_value"])
    solved = TestClient(app).post("/api/simulate", json={**body, "solve_for": "withdrawal", "target_amount": 0}).json()
    assert all(v is None or v > 0 for v in solved["solved"])


def test_irr_counts_withdrawals_as_money_back():
    # Flat prices: whatever goes in comes back, so the money-weighted return is 0%, also when
    # the account runs dry (final 0, everything already withdrawn) instead of -100%.
    res = one([saving(), retiring(rate=4.0)], FakeData(FLAT))
    assert res.irr[0] == pytest.approx(0.0, abs=1e-6)
    dry = one([retiring(amount=100.0, rate_unit="money")], FakeData(FLAT), start_amount=1000)
    assert dry.irr[0] == pytest.approx(0.0, abs=1e-6)
    # An asset growing 10% a year: every flow earns 10%, more withdrawn than deposited.
    grow = one([saving(24), retiring(24, rate=50.0)], FakeData({"A": exp_series(0.10)}))
    assert grow.withdrawn_total[0] > grow.deposits_total[0]
    assert grow.irr_gross[0] == pytest.approx(10.0, abs=0.05)
