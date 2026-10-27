"""Deposit schedule (growth, frequency, events, spreading the start amount), periodic
rebalancing, and the goal and cost metrics, on hand-built prices with known answers."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

import stockplan.data as data_mod
from stockplan.api import app
from stockplan.data import DemoMarketData
from stockplan.engine import DepositEvent, Holding, Stage, WithdrawRequest, WithdrawStage, run_plan, run_trinity
from stockplan.engine.market import month_grid, prepare_market
from stockplan.engine.simulate import cohort_values, simulate
from test_engine import FakeData, START, exp_series, one, plan, step_series

FLAT = {"A": step_series({})}


def prices_at_months(data, ticker, T):
    grid = month_grid(pd.DatetimeIndex([pd.Timestamp(START)]), T)[0]
    return data.prices(ticker).reindex(pd.DatetimeIndex(grid)).to_numpy()


# ------------------------------------------------------------------ deposit schedule

def test_deposit_growth_steps_up_every_plan_year():
    res = one([Stage(months=36, monthly_deposit=100, holdings=[Holding("A", 100)])], FakeData(FLAT),
              deposit_growth=10)
    assert res.final[0] == pytest.approx(1200 * (1 + 1.1 + 1.21))
    assert res.deposits_total[0] == pytest.approx(1200 * 3.31)


def test_deposit_frequency_counts_from_each_stage_start():
    # Every 3 months: stage 1 (10 months) pays at 0, 3, 6, 9; stage 2 (14) at 0, 3, 6, 9, 12.
    stages = [Stage(months=10, monthly_deposit=300, holdings=[Holding("A", 100)]),
              Stage(months=14, monthly_deposit=300, holdings=[Holding("A", 100)])]
    res = one(stages, FakeData(FLAT), deposit_every=3)
    assert res.deposits_total[0] == pytest.approx(9 * 300)
    assert res.final[0] == pytest.approx(9 * 300)


def test_deposit_and_pause_events():
    events = [DepositEvent(month=6, kind="deposit", amount=5000), DepositEvent(month=12, kind="pause", months=6)]
    res = one([Stage(months=24, monthly_deposit=100, holdings=[Holding("A", 100)])], FakeData(FLAT), events=events)
    assert res.final[0] == pytest.approx(100 * 18 + 5000)


def test_withdrawal_event_is_a_grossed_up_sale():
    # A doubles before month 6. At month 12 we take 600 net with a 25% tax: f*2000 - 0.25*f*1000 = 600.
    data = FakeData({"A": step_series({"2000-06-15": 2.0})})
    res = one([Stage(months=24, holdings=[Holding("A", 100)])], data, start_amount=1000, tax_rate=25,
              events=[DepositEvent(month=12, kind="withdraw", amount=600)])
    f = 600 / 1750
    assert res.withdrawn_total[0] == pytest.approx(600)
    assert res.tax_paid[0] == pytest.approx(0.25 * f * 1000)
    assert res.final[0] == pytest.approx(2000 * (1 - f) - 0.25 * 1000 * (1 - f))
    assert res.deposits_path[0, -1] == pytest.approx(1000 - 600)      # net money put in


def test_withdrawal_event_larger_than_the_account_warns():
    res = one([Stage(months=12, holdings=[Holding("A", 100)])], FakeData(FLAT), start_amount=100,
              events=[DepositEvent(month=3, kind="withdraw", amount=500)])
    assert res.withdrawn_total[0] == pytest.approx(100) and res.final[0] == pytest.approx(0)
    assert any("המשיכות החד-פעמיות" in w for w in res.warnings)


def test_event_outside_the_plan_is_rejected():
    with pytest.raises(ValueError, match="אירוע 1"):
        one([Stage(months=12, holdings=[Holding("A", 100)])], FakeData(FLAT), start_amount=100,
            events=[DepositEvent(month=12, kind="deposit", amount=1)])


def test_spread_start_amount_matches_closed_form_and_lump_alternative():
    data = FakeData({"A": exp_series(0.10)})
    p = prices_at_months(data, "A", 24)
    g = (1 + 0.04 * 0.75) ** (1 / 12)                 # 4% on the waiting cash, after the 25% tax
    cash, expected = 12_000.0, 0.0
    for k in range(12):
        part = cash / (12 - k)
        cash = (cash - part) * g
        expected += part * p[-1] / p[k]
    res = one([Stage(months=24, holdings=[Holding("A", 100)])], data, start_amount=12_000,
              lump_spread=12, cash_rate=4, tax_rate=25)
    assert res.final_gross[0] == pytest.approx(expected, rel=1e-9)
    assert res.final_lump_gross[0] == pytest.approx(12_000 * p[-1] / p[0], rel=1e-9)
    assert res.final_lump_gross[0] > res.final_gross[0]               # a rising market favours investing at once
    assert res.deposits_total[0] == pytest.approx(12_000)            # the money left the investor at month 0
    assert res.irr_gross[0] < 10.0


# --------------------------------------------------------------------- rebalancing

TWO = {"A": step_series({"2000-06-15": 2.0, "2001-06-15": 2.0}), "B": step_series({})}
HALF = [Holding("A", 50), Holding("B", 50)]


@pytest.mark.parametrize("rule", ["annual", "band"])
def test_rebalancing_back_to_the_weights(rule):
    # A doubles at months 6 and 18. Annual: 1000/500 -> 750/750 at month 12 -> 1500 + 750.
    # Band (10 points): the drift at month 6 already triggers it, with the same end value.
    res = one([Stage(months=24, holdings=HALF)], FakeData(TWO), start_amount=1000, rebalance=rule,
              rebalance_band=10)
    assert res.final_gross[0] == pytest.approx(2250)
    held = one([Stage(months=24, holdings=HALF)], FakeData(TWO), start_amount=1000)
    assert held.final_gross[0] == pytest.approx(2500)


def test_taxable_rebalance_sells_with_tax():
    # Annual rebalance as a taxable event: sell 250 of A (half of it gain) -> tax 31.25.
    res = one([Stage(months=24, holdings=HALF)], FakeData(TWO), start_amount=1000, rebalance="annual",
              tax_on_switch=True, tax_rate=25)
    assert res.tax_paid[0] == pytest.approx(31.25)
    assert res.final_gross[0] == pytest.approx(1500 + 718.75)
    assert res.final[0] == pytest.approx(2218.75 - 0.25 * 1125)


@pytest.mark.parametrize("extra", [
    dict(rebalance="quarterly"), dict(rebalance="band", rebalance_band=3), dict(lump_spread=7, cash_rate=2),
    dict(deposit_every=3, deposit_growth=5, events=[DepositEvent(month=5, kind="withdraw", amount=300)]),
])
def test_cohorts_add_up_to_the_gross_final(extra):
    # The closed-form lot growth (stage switches, rebalances, spread lots) must agree with the
    # simulator: the yearly cohorts partition the gross final value (no withdrawals sold).
    data = FakeData({"A": exp_series(0.10), "B": step_series({"2001-03-01": 1.5, "2002-02-01": 0.8})})
    stages = [Stage(months=18, monthly_deposit=100, holdings=[Holding("A", 60), Holding("B", 40)]),
              Stage(months=18, monthly_deposit=50, holdings=[Holding("A", 30), Holding("B", 70)])]
    req = plan(stages, start_amount=500, annual_fee=1.0, **extra)
    market = prepare_market(req, data)
    out = simulate(req, market, record=True)
    cohorts = cohort_values(req, market, out, 3)
    if not req.events:
        assert cohorts.sum() == pytest.approx(out.final_gross[0], rel=1e-9)
    else:   # the withdrawal shrinks every lot alive at month 5 by the same fraction
        assert cohorts.sum() > out.final_gross[0]


def test_trinity_rebalances_too():
    stage = WithdrawStage(months=24, rate=0.0, holdings=HALF)
    req = WithdrawRequest(stages=[stage], start_amount=1000, tax_rate=0, rebalance="annual",
                          min_start=START, max_start=START)
    assert run_trinity(req, FakeData(TWO)).final[0] == pytest.approx(2250)


# ----------------------------------------------------------------- goal and costs

def test_months_to_target():
    data = FakeData({"A": exp_series(0.10)})
    res = one([Stage(months=36, holdings=[Holding("A", 100)])], data, start_amount=1000, target_amount=1099)
    assert res.target_month_gross[0] == 12
    res = one([Stage(months=36, holdings=[Holding("A", 100)])], data, start_amount=1000, target_amount=5000)
    assert res.target_month_gross[0] == -1


def test_fees_charged_and_fee_drag():
    res = one([Stage(months=12, holdings=[Holding("A", 100)])], FakeData(FLAT), start_amount=1000, annual_fee=1.2)
    assert res.fees_total[0] == pytest.approx(1000 * 0.012)
    assert res.final_nofee[0] == pytest.approx(1000)
    assert res.final_nofee[0] - res.final[0] == pytest.approx(12)


# ------------------------------------------------------------------------------- API

client = TestClient(app)


@pytest.fixture
def demo_provider(monkeypatch):
    monkeypatch.setattr(data_mod, "_provider", DemoMarketData(end="2026-01-01"))


def test_api_schedule_fields(demo_provider):
    body = {"stages": [{"months": 60, "monthly_deposit": 1000, "holdings": [{"ticker": "SPY", "weight": 60},
                                                                            {"ticker": "QQQ", "weight": 40}]}],
            "start_amount": 50_000, "target_amount": 100_000, "currency": "USD", "step": "M",
            "deposit_every": 3, "deposit_growth": 3, "lump_spread": 6, "rebalance": "annual", "annual_fee": 0.5,
            "events": [{"month": 24, "kind": "pause", "months": 6}, {"month": 30, "kind": "withdraw", "amount": 5000}]}
    out = client.post("/api/simulate", json=body).json()
    n = out["n"]
    assert len(out["final_lump"]) == n and len(out["final_nofee"]) == n
    assert all(v is None or 0 <= v <= 60 for v in out["target_month_gross"])
    assert all(f > 0 for f in out["fees_total"]) and len(out["withdrawn_total"]) == n
    bad = client.post("/api/simulate", json={**body, "events": [{"month": 60, "kind": "deposit", "amount": 1}]})
    assert bad.status_code == 400 and "אירוע 1" in bad.json()["detail"]


def test_a_year_without_deposits_has_no_cohort_return():
    res = one([Stage(months=36, monthly_deposit=100, holdings=[Holding("A", 100)])], FakeData(FLAT),
              events=[DepositEvent(month=12, kind="pause", months=12)])
    assert np.isnan(res.year_irr_gross[0, 1]) and np.isfinite(res.year_irr_gross[0, [0, 2]]).all()
