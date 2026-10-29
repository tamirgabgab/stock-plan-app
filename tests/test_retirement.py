"""Retirement: other income by age, Guyton-Klinger guardrails, VPW, spending that changes
with time, and the sequence-of-returns risk, against hand-computed answers."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

import stockplan.data as data_mod
from stockplan.api import app
from stockplan.data import DemoMarketData
from stockplan.engine import (Holding, Income, PlanRequest, Stage, WithdrawRequest, WithdrawStage, run_plan,
                              run_trinity)
from stockplan.engine.market import prepare_market
from stockplan.engine.portfolio import gk_update, vpw_payment
from stockplan.engine.withdraw import simulate_withdraw
from test_engine import DAYS, FakeData, START, exp_series, step_series

A = [Holding("A", 100)]
FLAT = {"A": step_series({})}


def trinity(stages, data, **kw):
    kw.setdefault("tax_rate", 0.0)
    kw.setdefault("start_amount", 1000.0)
    return WithdrawRequest(stages=stages, min_start=START, max_start=START, **kw)


def paid(req, data):
    out = simulate_withdraw(req, prepare_market(req, data), record=True)
    return out.withdrawals[0]


# ------------------------------------------------------------------- other income

def test_income_from_an_age_lowers_the_withdrawals():
    # 100 a month is spent; from age 61 a pension of 40 pays part of it.
    req = trinity([WithdrawStage(months=24, holdings=A, rate_unit="money", amount=100.0)], FakeData(FLAT),
                  start_amount=12_000, start_age=60, incomes=[Income(age=61, amount=40)])
    w = paid(req, FakeData(FLAT))
    assert w[11] == pytest.approx(100) and w[12] == pytest.approx(60)
    assert run_trinity(req, FakeData(FLAT)).withdrawn_total[0] == pytest.approx(12 * 100 + 12 * 60)


def test_income_does_not_lower_a_percent_of_the_balance():
    stage = WithdrawStage(months=12, holdings=A, rate=12.0, basis="current")
    with_inc = paid(trinity([stage], FakeData(FLAT), start_age=60, incomes=[Income(age=60, amount=5)]), FakeData(FLAT))
    without = paid(trinity([stage], FakeData(FLAT)), FakeData(FLAT))
    assert np.allclose(with_inc, without)


def test_lifecycle_income_and_validation():
    stages = [Stage(months=12, monthly_deposit=1000, holdings=A),
              Stage(months=12, kind="withdraw", rate_unit="money", amount=500.0, holdings=A)]
    req = PlanRequest(stages=stages, tax_rate=0.0, min_start=START, max_start=START, start_age=64,
                      incomes=[Income(age=65, amount=200)])
    assert run_plan(req, FakeData(FLAT)).withdrawn_total[0] == pytest.approx(12 * 300)
    with pytest.raises(ValueError, match="הגיל בתחילת התוכנית"):
        run_plan(PlanRequest(stages=stages, incomes=[Income(age=65, amount=200)], min_start=START,
                             max_start=START), FakeData(FLAT))


# ------------------------------------------------------------------- Guyton-Klinger

def test_gk_rules_closed_form():
    r0 = np.full(5, 0.05)
    W = np.full(5, 100.0)                                 # 1,200 a year
    total = np.array([24_000.0, 24_000, 19_000, 35_000, 19_000])
    last = np.array([20_000.0, 30_000, 30_000, 20_000, 30_000])
    left = np.array([300, 300, 300, 300, 120])
    out = gk_update(W, total, last, 1.03, r0, 0.2, 0.1, left)
    assert out[0] == pytest.approx(103)            # rose, rate 5.15%: indexed
    assert out[1] == pytest.approx(100)            # fell with a rate above 5%: no indexation
    assert out[2] == pytest.approx(90)             # fell, no indexation; rate 6.3% > 1.2 x 5%: cut 10%
    assert out[3] == pytest.approx(103 * 1.1)      # rate 3.5% < 0.8 x 5%: raise 10%
    assert out[4] == pytest.approx(100)            # a cut is skipped in the last 15 years


def test_gk_freezes_the_inflation_step_after_a_bad_year():
    # Flat prices, CPI +5% a year: the balance falls and the rate (12.6%) is above the
    # initial 12%, so the second year's withdrawal keeps last year's nominal amount.
    idx = pd.date_range(DAYS[0], DAYS[-1], freq="MS")
    cpi = pd.Series(100 * 1.05 ** ((idx - DAYS[0]).days / 365.25), index=idx)
    data = FakeData(FLAT, cpi=cpi)
    stage = WithdrawStage(months=24, holdings=A, rate=12.0, method="gk")
    w = paid(trinity([stage], data), data)
    assert w[0] == pytest.approx(10) and w[12] == pytest.approx(10)
    fixed = paid(trinity([WithdrawStage(months=24, holdings=A, rate=12.0)], data), data)
    assert fixed[12] > 10.4


def test_gk_raises_after_a_good_year():
    data = FakeData({"A": exp_series(0.5)})
    w = paid(trinity([WithdrawStage(months=24, holdings=A, rate=6.0, method="gk")], data), data)
    assert w[11] == pytest.approx(5) and w[12] == pytest.approx(5.5)


# ---------------------------------------------------------------------------- VPW

def test_vpw_spends_everything_by_the_end():
    # Flat prices and a 0% expected return: the balance divided by the months left, so an
    # equal amount every month and nothing left at the end.
    stage = WithdrawStage(months=24, holdings=A, method="vpw", vpw_rate=0.0)
    res = run_trinity(trinity([stage], FakeData(FLAT), start_amount=2400), FakeData(FLAT))
    assert np.allclose(paid(trinity([stage], FakeData(FLAT), start_amount=2400), FakeData(FLAT))[:24], 100)
    assert res.final[0] == pytest.approx(0, abs=1e-6) and res.success[0]
    assert vpw_payment(np.array([1000.0]), 6.0, 1)[0] == pytest.approx(1000)
    i = 1.06 ** (1 / 12) - 1
    assert vpw_payment(np.array([1000.0]), 6.0, 120)[0] == pytest.approx(1000 * i / (1 - (1 + i) ** -120) / (1 + i))


def test_vpw_cannot_be_solved():
    stage = WithdrawStage(months=24, holdings=A, method="vpw")
    with pytest.raises(ValueError, match="VPW"):
        run_trinity(trinity([stage], FakeData(FLAT), solve_for="amount", target_amount=0), FakeData(FLAT))


# -------------------------------------------------------------------- spending change

def test_spending_falls_every_year():
    stage = WithdrawStage(months=24, holdings=A, rate_unit="money", amount=100.0, spending_change=-10.0)
    w = paid(trinity([stage], FakeData(FLAT), start_amount=5000), FakeData(FLAT))
    assert w[11] == pytest.approx(100) and w[12] == pytest.approx(90)


# --------------------------------------------------------------------- sequence risk

def test_sequence_return():
    # The strategy's own return in the first five years of retirement: 10% a year here.
    data = FakeData({"A": exp_series(0.10)})
    tri = run_trinity(trinity([WithdrawStage(months=48, holdings=A, rate=4.0)], data), data)
    assert tri.seq_return[0] == pytest.approx(10.0, abs=0.05)          # four years available
    life = run_plan(PlanRequest(stages=[Stage(months=12, monthly_deposit=100, holdings=A),
                                        Stage(months=36, kind="withdraw", holdings=A)],
                                tax_rate=0.0, min_start=START, max_start=START), data)
    assert life.seq_return[0] == pytest.approx(10.0, abs=0.05)
    flat = run_trinity(trinity([WithdrawStage(months=24, holdings=A)], FakeData(FLAT)), FakeData(FLAT))
    assert flat.seq_return[0] == pytest.approx(0.0, abs=1e-9)


def test_api_retirement(monkeypatch):
    monkeypatch.setattr(data_mod, "_provider", DemoMarketData(end="2026-01-01"))
    client = TestClient(app)
    body = {"stages": [{"months": 240, "holdings": [{"ticker": "SPY", "weight": 100}], "method": "gk", "rate": 5}],
            "currency": "USD", "start_age": 65, "incomes": [{"age": 67, "amount": 1500, "name": "קצבת זקנה"}]}
    out = client.post("/api/trinity/simulate", json=body).json()
    assert len(out["seq_return"]) == out["n"]
    vpw = {**body, "stages": [{**body["stages"][0], "method": "vpw"}], "solve_for": "rate"}
    assert client.post("/api/trinity/simulate", json=vpw).status_code == 400
    life = {"stages": [{"months": 120, "monthly_deposit": 2000, "holdings": [{"ticker": "SPY", "weight": 100}]},
                       {"months": 240, "kind": "withdraw", "method": "vpw", "holdings": [{"ticker": "SPY", "weight": 100}]}],
            "currency": "USD", "mode": "synthetic", "paths": 200, "start_age": 45}
    res = client.post("/api/simulate", json=life).json()
    assert all(res["success"]) and len(res["seq_return"]) == 200
