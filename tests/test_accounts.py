"""Israeli account types (קרן השתלמות, קופת גמל להשקעה), the yearly deposit ceiling, the
dividend tax of a regular account and the deposit fee, against hand-computed answers."""
from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

import stockplan.data as data_mod
from stockplan.api import app
from stockplan.data import DemoMarketData
from stockplan.engine import Holding, PlanRequest, Stage, WithdrawRequest, WithdrawStage, run_plan, run_trinity
from stockplan.engine.solve import irr_annual
from test_engine import FakeData, START, one, step_series

# Seven years and more of data: a קרן השתלמות becomes tax-free after 72 months.
LONG = pd.date_range("1999-12-01", "2010-12-31", freq="D")


def long_series(changes: dict[str, float]) -> pd.Series:
    s = pd.Series(100.0, index=LONG)
    for day, factor in sorted(changes.items()):
        s[s.index >= pd.Timestamp(day)] *= factor
    return s


def long_data(prices: dict) -> FakeData:
    return FakeData(prices, fx=pd.Series(3.5, index=LONG),
                    cpi=pd.Series(100.0, index=pd.date_range(LONG[0], LONG[-1], freq="MS")))


DOUBLES = {"A": long_series({"2000-06-15": 2.0}), "B": long_series({})}
A = [Holding("A", 100)]


# ------------------------------------------------------------------ קרן השתלמות

@pytest.mark.parametrize("months, final", [(84, 2000.0), (60, 1750.0)])
def test_hishtalmut_is_tax_free_after_six_years(months, final):
    res = one([Stage(months=months, holdings=A)], long_data(DOUBLES), start_amount=1000, tax_rate=25,
              account="hishtalmut")
    assert res.final[0] == pytest.approx(final)
    if months > 72:     # the net value jumps when the six years are up
        assert res.paths[0, 71] == pytest.approx(1750) and res.paths[0, 72] == pytest.approx(2000)


def test_deposits_above_the_ceiling_are_taxed():
    # 100 a month for a year with a 600 ceiling: six deposits are exempt, six are not. A then
    # doubles; only the gain on the taxable 600 pays 25%.
    stages = [Stage(months=12, monthly_deposit=100, holdings=A), Stage(months=72, holdings=A)]
    data = long_data({"A": long_series({"2001-06-15": 2.0})})
    res = one(stages, data, tax_rate=25, account="hishtalmut", account_ceiling=600)
    assert res.final_gross[0] == pytest.approx(2400)
    assert res.final[0] == pytest.approx(2400 - 0.25 * 600)
    # The ceiling is per plan year: 50 a month stays under it.
    res = one([Stage(months=84, monthly_deposit=50, holdings=A)], data, tax_rate=25,
              account="hishtalmut", account_ceiling=600)
    assert res.final[0] == pytest.approx(res.final_gross[0])


def test_savings_accounts_move_between_tracks_without_tax():
    stages = [Stage(months=12, holdings=A), Stage(months=12, holdings=[Holding("B", 100)])]
    reg = one(stages, long_data(DOUBLES), start_amount=1000, tax_rate=25, tax_on_switch=True)
    assert reg.tax_paid[0] == pytest.approx(250)
    gemel = one(stages, long_data(DOUBLES), start_amount=1000, tax_rate=25, tax_on_switch=True, account="gemel")
    assert gemel.tax_paid[0] == 0 and gemel.final[0] == pytest.approx(1750)   # deferred to the lump sum


# ------------------------------------------------------------------ קופת גמל להשקעה

@pytest.mark.parametrize("annuity, retire, monthly", [(True, 2000.0, 20.0), (False, 1750.0, 17.5)])
def test_gemel_annuity_withdrawals_are_tax_free(annuity, retire, monthly):
    # 1000 doubles before retirement; then 12% a year of the balance at retirement.
    stages = [Stage(months=12, holdings=A),
              Stage(months=12, holdings=A, kind="withdraw", rate=12.0, annuity=annuity)]
    res = one(stages, long_data(DOUBLES), start_amount=1000, tax_rate=25, account="gemel")
    assert res.retire_value[0] == pytest.approx(retire)
    assert res.withdrawn_total[0] == pytest.approx(12 * monthly)
    assert res.final[0] == pytest.approx(retire - 12 * monthly)


def test_trinity_accounts():
    def trinity(**kw):
        stage = WithdrawStage(months=12, rate=0.0, holdings=A, **{k: kw.pop(k) for k in ("annuity",) if k in kw})
        req = WithdrawRequest(stages=[stage], start_amount=1000, tax_rate=25, min_start=START, max_start=START, **kw)
        return run_trinity(req, long_data(DOUBLES)).final[0]
    assert trinity() == pytest.approx(1750)
    assert trinity(account="hishtalmut") == pytest.approx(2000)      # taken as older than six years
    assert trinity(account="gemel") == pytest.approx(1750)
    assert trinity(account="gemel", annuity=True) == pytest.approx(2000)


# --------------------------------------------------------------------- dividends and fees

def test_dividend_tax_closed_form():
    # Flat total-return prices with a 12% yield: 1% a month is paid out, 25% of it is taxed
    # and the rest reinvested, so the value shrinks by 0.25% a month. The price part falls
    # below the cost basis, so selling at the end adds no tax.
    flat = {"A": step_series({})}
    hold = [Holding("A", 100, dividend=12.0)]
    res = one([Stage(months=12, holdings=hold)], FakeData(flat), start_amount=1000, tax_rate=25)
    v = 1000 * 0.9975 ** np.arange(12)
    assert res.final[0] == pytest.approx(1000 * 0.9975 ** 12)
    assert res.dividend_tax[0] == pytest.approx(0.0025 * v.sum())
    assert res.tax_paid[0] == pytest.approx(res.dividend_tax[0])
    # No dividend tax in a savings account, and the Trinity tab charges it too.
    assert one([Stage(months=12, holdings=hold)], FakeData(flat), start_amount=1000, tax_rate=25,
               account="gemel").final[0] == pytest.approx(1000)
    tri = WithdrawRequest(stages=[WithdrawStage(months=12, rate=0.0, holdings=hold)], start_amount=1000,
                          tax_rate=25, min_start=START, max_start=START)
    assert run_trinity(tri, FakeData(flat)).final[0] == pytest.approx(1000 * 0.9975 ** 12)


def test_deposit_fee():
    res = one([Stage(months=12, monthly_deposit=100, holdings=A)], FakeData({"A": step_series({})}),
              deposit_fee=2.0, annual_fee=0.0)
    assert res.final[0] == pytest.approx(1176)
    assert res.fees_total[0] == pytest.approx(24) and res.deposit_fees[0] == pytest.approx(24)
    assert res.final_nofee[0] == pytest.approx(1200)
    assert res.deposits_total[0] == pytest.approx(1200)      # the investor still paid 1200


def test_exempt_cohorts_have_no_net_tax():
    stages = [Stage(months=84, monthly_deposit=100, holdings=A)]
    data = long_data({"A": long_series({"2006-06-15": 1.5})})
    res = one(stages, data, tax_rate=25, account="hishtalmut")
    assert np.allclose(res.year_irr_net, res.year_irr_gross)
    reg = one(stages, data, tax_rate=25)
    assert (reg.year_irr_net < reg.year_irr_gross).all()


def test_validation():
    with pytest.raises(ValueError, match="סוג חשבון"):
        one([Stage(months=12, holdings=A)], FakeData({"A": step_series({})}), start_amount=1, account="ira")
    with pytest.raises(ValueError, match="דיבידנד"):
        one([Stage(months=12, holdings=[Holding("A", 100, dividend=60)])], FakeData({"A": step_series({})}),
            start_amount=1)


def test_api_accounts(monkeypatch):
    monkeypatch.setattr(data_mod, "_provider", DemoMarketData(end="2026-01-01"))
    body = {"stages": [{"months": 96, "monthly_deposit": 1500,
                        "holdings": [{"ticker": "SPY", "weight": 100, "dividend": 1.3}]}],
            "currency": "ILS", "step": "M", "account": "hishtalmut", "account_ceiling": 18854, "deposit_fee": 0.5}
    client = TestClient(app)
    out = client.post("/api/simulate", json=body).json()
    assert len(out["dividend_tax"]) == out["n"] and all(v == 0 for v in out["dividend_tax"])
    assert all(v > 0 for v in out["deposit_fees"])
    reg = client.post("/api/simulate", json={**body, "account": "regular"}).json()
    assert all(v > 0 for v in reg["dividend_tax"])
    assert client.post("/api/simulate", json={**body, "account": "ira"}).status_code == 422
    tri = {"stages": [{"months": 120, "rate": 4, "annuity": True, "holdings": [{"ticker": "SPY", "weight": 100}]}],
           "currency": "USD", "account": "gemel"}
    assert client.post("/api/trinity/simulate", json=tri).status_code == 200


# --------------------------------------------------------------------------- IRR solver

def test_flat_prices_give_a_zero_cohort_return():
    # Newton lands on f = 0 exactly at its first guess; it must stay there.
    res = one([Stage(months=36, monthly_deposit=100, holdings=A)], FakeData({"A": step_series({})}))
    assert np.allclose(res.year_irr_gross, 0.0) and res.irr[0] == pytest.approx(0.0, abs=1e-9)


@pytest.mark.parametrize("monthly", [0.01, 0.4, -0.05])
def test_irr_far_from_the_first_guess(monthly):
    # One deposit compounding 240 months: Newton must not crawl from its 0.5% start.
    dep = np.zeros((1, 241))
    dep[0, 0] = 1000.0
    final = np.array([1000 * (1 + monthly) ** 240])
    assert irr_annual(dep, final)[0] == pytest.approx(((1 + monthly) ** 12 - 1) * 100, rel=1e-9)
