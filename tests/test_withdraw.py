"""Withdrawal (Trinity) engine tests on hand-built series with exactly known answers."""
from __future__ import annotations

from datetime import date

import numpy as np
import pytest

from stockplan.engine import Holding, WithdrawRequest, WithdrawStage, run_trinity, trinity_heatmap
from test_engine import FakeData, START, cpi_doubling, exp_series, step_series

A = [Holding("A", 100)]


def req(stages, **kw) -> WithdrawRequest:
    kw.setdefault("tax_rate", 0.0)
    kw.setdefault("index_withdrawals", False)
    kw.setdefault("start_amount", 1000.0)
    return WithdrawRequest(stages=stages, min_start=START, max_start=START, step="M", **kw)


def one(stages, data, **kw):
    res = run_trinity(req(stages, **kw), data)
    assert len(res.start_dates) == 1
    return res


def test_fixed_rate_on_flat_prices():
    data = FakeData({"A": step_series({})})
    res = one([WithdrawStage(months=12, holdings=A, rate=4.0)], data, start_amount=120_000)
    assert res.final[0] == pytest.approx(120_000 - 12 * 400)
    assert res.withdrawn_total[0] == pytest.approx(4800)
    assert res.success[0] and res.depleted_at[0] == -1
    assert res.paths[0, 0] == pytest.approx(120_000 - 400)      # recorded after the withdrawal


def test_depletion_is_detected_and_withdrawals_are_not_overcounted():
    # Legacy bug: the total kept counting full withdrawals after the money ran out.
    data = FakeData({"A": step_series({})})
    res = one([WithdrawStage(months=12, holdings=A, rate_unit="money", amount=300)], data, start_amount=1000)
    assert res.depleted_at[0] == 3
    assert not res.success[0]
    assert res.final[0] == pytest.approx(0)
    assert res.withdrawn_total[0] == pytest.approx(1000)


def test_withdrawal_is_grossed_up_for_tax():
    # Legacy bug: the tax rate was ignored. Price doubles after month 0; the month-1 sale
    # realizes a gain, and the tax is paid so that the net cash is exactly the 100 asked for.
    data = FakeData({"A": step_series({"2000-02-01": 2.0})})
    res = one([WithdrawStage(months=2, holdings=A, rate_unit="money", amount=100)], data,
              start_amount=1000, tax_rate=25)
    tau = 0.25
    g = 100 / (1 - tau * 900 / 1800)                    # gross sale at month 1
    V, B = 1800 - g, 900 * (1 - g / 1800)
    assert res.withdrawn_total[0] == pytest.approx(200)
    assert res.final[0] == pytest.approx(V - tau * (V - B))


def test_indexed_withdrawals_follow_the_cpi():
    data = FakeData({"A": step_series({})}, cpi=cpi_doubling())
    stage = [WithdrawStage(months=12, holdings=A, rate_unit="money", amount=100)]
    indexed = one(stage, data, start_amount=5000, index_withdrawals=True)
    fixed = one(stage, data, start_amount=5000, index_withdrawals=False)
    assert indexed.withdrawn_total[0] == pytest.approx(5 * 100 + 7 * 200)
    assert fixed.withdrawn_total[0] == pytest.approx(1200)


def test_real_mode_inputs_and_outputs_are_in_todays_money():
    data = FakeData({"A": step_series({})}, cpi=cpi_doubling())
    res = one([WithdrawStage(months=12, holdings=A, rate_unit="money", amount=100)], data,
              start_amount=4000, real=True, index_withdrawals=True)
    # Nominal: start 2000, withdrawals 5 x 50 then 7 x 100 -> 1050 left; CPI today = 200.
    assert res.withdrawn_total[0] == pytest.approx(1200)
    assert res.final[0] == pytest.approx(1050)


def test_solve_rate_and_start_amount():
    data = FakeData({"A": step_series({})})
    rate = run_trinity(req([WithdrawStage(months=12, holdings=A)], start_amount=120_000, target_amount=0,
                           solve_for="rate"), data)
    assert rate.solved[0] == pytest.approx(100.0, rel=1e-5)
    assert rate.final[0] == pytest.approx(0, abs=1e-2)
    start = run_trinity(req([WithdrawStage(months=12, holdings=A, rate_unit="money", amount=1000)],
                            target_amount=5000, solve_for="start_amount"), data)
    assert start.solved[0] == pytest.approx(17_000, rel=1e-6)


def test_percent_of_balance_with_guardrails():
    data = FakeData({"A": step_series({})})
    cur = [WithdrawStage(months=12, holdings=A, rate=12.0, basis="current")]
    plain = one(cur, data, start_amount=1200)
    assert plain.final[0] == pytest.approx(1200 * 0.99 ** 12)
    capped = one([WithdrawStage(months=12, holdings=A, rate=12.0, basis="current", ceiling=10, guard_unit="money")],
                 data, start_amount=1200)
    assert capped.final[0] == pytest.approx(1200 - 120)
    floored = one([WithdrawStage(months=12, holdings=A, rate=12.0, basis="current", floor=20, guard_unit="pct")],
                  data, start_amount=1200)
    assert floored.final[0] == pytest.approx(1200 - 12 * 20)          # 20%/yr of 1200 = 20 a month


def test_one_time_withdrawal_in_money_or_percent():
    data = FakeData({"A": step_series({})})
    pct = one([WithdrawStage(months=3, holdings=A, rate=0, one_time=10, one_time_unit="pct")], data)
    money = one([WithdrawStage(months=3, holdings=A, rate=0, one_time=250, one_time_unit="money")], data)
    assert pct.final[0] == pytest.approx(900)
    assert money.final[0] == pytest.approx(750)


def test_stage_switch_keeps_the_balance():
    data = FakeData({"A": step_series({}), "B": step_series({"2000-09-01": 2.0})})
    stages = [WithdrawStage(months=6, holdings=A, rate=12.0),
              WithdrawStage(months=6, holdings=[Holding("B", 100)], rate=12.0)]
    res = one(stages, data, start_amount=1200)
    # 6 x 12 withdrawn in A; switch to B at month 6 (price 100); B doubles at month 8.
    bal = 1200 - 6 * 12
    bal = bal - 12 - 12                      # months 6, 7 at price 100
    bal = bal * 2 - 12 - 12 - 12 - 12        # months 8..11 after the doubling
    assert res.final[0] == pytest.approx(bal)


def test_heatmap_survival_and_preservation():
    flat = FakeData({"A": step_series({})})
    r = req([WithdrawStage(months=12, holdings=A)], start_amount=12_000, solve_for="final")
    r.min_start, r.max_start = START, date(2000, 3, 1)
    hm = trinity_heatmap(r, flat, rates=[50, 100, 150], years=[1])
    assert hm["survival"][0] == [100.0, 100.0, 0.0]
    assert hm["preservation"][0] == [0.0, 0.0, 0.0]
    assert hm["counts"] == [3]
    rising = FakeData({"A": exp_series(0.07)})
    hm = trinity_heatmap(r, rising, rates=[2, 100], years=[1, 50])
    assert hm["preservation"][0] == [100.0, 0.0]
    assert hm["survival"][1] == [None, None]           # 50 years is longer than the data
