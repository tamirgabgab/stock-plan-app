"""Realization detail: the trade journal and the basket price of one start date."""
from __future__ import annotations

import pytest

from stockplan.engine import (Holding, PlanRequest, Stage, WithdrawRequest, WithdrawStage, realization_detail)
from test_engine import START, FakeData, step_series


def test_journal_lists_every_buy_with_price_units_and_return():
    # A doubles from July 2000; B is flat. 60/40 monthly deposits of 100 for 12 months.
    data = FakeData({"A": step_series({"2000-07-01": 2.0}), "B": step_series({})})
    req = PlanRequest(stages=[Stage(months=12, holdings=[Holding("A", 60), Holding("B", 40)], monthly_deposit=100)],
                      tax_rate=0, step="M")
    d = realization_detail(req, data, START)
    buys = [t for t in d["trades"] if t["kind"] == "buy"]
    assert len(buys) == 24 and not [t for t in d["trades"] if t["kind"] == "sell"]
    first_a = next(t for t in buys if t["asset"] == 0 and t["m"] == 0)
    assert first_a["amount"] == pytest.approx(60)
    assert first_a["price"] == pytest.approx(100)
    assert first_a["units"] == pytest.approx(0.6)
    assert first_a["return_pct"] == pytest.approx(100)          # bought at 100, worth 200 at the end
    assert first_a["annual_pct"] == pytest.approx(100)          # held exactly 12 months
    late_a = next(t for t in buys if t["asset"] == 0 and t["m"] == 8)
    assert late_a["return_pct"] == pytest.approx(0)
    assert d["summary"]["final"] == pytest.approx(sum(t["value_exit"] for t in buys))
    # Basket = 0.6 * A + 0.4 * B: 100 before the jump, 160 after.
    assert d["basket"]["basket_usd"][0] == pytest.approx(100)
    assert d["basket"]["basket_usd"][-1] == pytest.approx(160)
    assert len(d["buys"]["dates"]) == 12


def test_stage_switch_sells_are_taxed_and_followed_to_exit():
    data = FakeData({"A": step_series({"2000-04-01": 2.0}), "B": step_series({})})
    req = PlanRequest(stages=[Stage(months=6, holdings=[Holding("A", 100)]), Stage(months=6, holdings=[Holding("B", 100)])],
                      start_amount=1000, tax_rate=25, tax_on_switch=True, step="M")
    d = realization_detail(req, data, START)
    sell = next(t for t in d["trades"] if t["kind"] == "sell")
    assert sell["ctx"] == "switch" and sell["amount"] == pytest.approx(2000)
    assert sell["tax"] == pytest.approx(250)                     # 25% of the 1,000 gain
    buy_a = next(t for t in d["trades"] if t["kind"] == "buy" and t["asset"] == 0)
    assert buy_a["exit_m"] == 6 and buy_a["return_pct"] == pytest.approx(100)
    buy_b = next(t for t in d["trades"] if t["kind"] == "buy" and t["asset"] == 1)
    assert buy_b["amount"] == pytest.approx(1750)


def test_withdrawals_appear_as_sales():
    data = FakeData({"A": step_series({})})
    req = WithdrawRequest(stages=[WithdrawStage(months=12, holdings=[Holding("A", 100)], rate_unit="money", amount=50)],
                          start_amount=1000, tax_rate=0, index_withdrawals=False, step="M")
    d = realization_detail(req, data, START)
    sells = [t for t in d["trades"] if t["kind"] == "sell"]
    assert len(sells) == 12 and all(t["amount"] == pytest.approx(50) for t in sells)
    assert d["summary"]["final"] == pytest.approx(400)
    assert d["trinity"] and len(d["sells"]["dates"]) == 12


def test_benchmark_at_zero_return_is_the_deposits_and_taxes_the_gain_otherwise():
    from stockplan.engine import benchmark_path
    data = FakeData({"A": step_series({"2000-03-01": 3.0})})
    req = PlanRequest(stages=[Stage(months=12, holdings=[Holding("A", 100)], monthly_deposit=100)], tax_rate=25, step="M")
    flat = benchmark_path(req, data, START, 0.0)
    assert flat["final"] == pytest.approx(1200)                 # the market's jump is ignored
    assert flat["path"][6] == pytest.approx(700)                # recorded after the month's deposit
    grown = benchmark_path(req, data, START, 10.0)
    gross = sum(100 * 1.1 ** ((date_days(12) - date_days(m)) / 365.25) for m in range(12))
    assert grown["final"] == pytest.approx(gross - 0.25 * (gross - 1200), rel=1e-9)


def date_days(m: int) -> int:
    import pandas as pd
    return (pd.Timestamp(START) + pd.DateOffset(months=m) - pd.Timestamp(START)).days


def test_benchmark_for_withdrawals_and_the_solved_amount():
    from stockplan.engine import benchmark_path, run_trinity
    data = FakeData({"A": step_series({})})
    stage = WithdrawStage(months=12, holdings=[Holding("A", 100)], rate_unit="money", amount=50)
    req = WithdrawRequest(stages=[stage], start_amount=1000, tax_rate=0, index_withdrawals=False, step="M")
    assert benchmark_path(req, data, START, 0.0)["final"] == pytest.approx(400)
    solve = WithdrawRequest(stages=[stage], start_amount=1200, target_amount=0, solve_for="amount", tax_rate=0,
                            index_withdrawals=False, min_start=START, max_start=START, step="M")
    res = run_trinity(solve, data)
    assert res.solved[0] == pytest.approx(100, rel=1e-5)
    assert benchmark_path(solve, data, START, 0.0, x=100)["final"] == pytest.approx(0, abs=1e-6)


def test_final_mode_success_ignores_the_target():
    from stockplan.engine import run_trinity
    data = FakeData({"A": step_series({})})
    req = WithdrawRequest(stages=[WithdrawStage(months=12, holdings=[Holding("A", 100)], rate=4)], start_amount=1000,
                          target_amount=5000, tax_rate=0, index_withdrawals=False, min_start=START, max_start=START, step="M")
    assert run_trinity(req, data).success[0]
