"""The yearly inflation model (engine.inflation) and its use in place of the CPI history."""
from __future__ import annotations

import math
from dataclasses import replace
from datetime import date

import numpy as np
import pandas as pd
import pytest

from stockplan.engine import Holding, InflationModel, PlanRequest, Stage, WithdrawRequest, WithdrawStage, run_plan, run_trinity
from stockplan.engine import inflation as inf
from stockplan.engine.detail import realization_detail

ZQ, WQ = np.polynomial.hermite_e.hermegauss(160)
WQ = WQ / WQ.sum()


def moments(g):
    """Mean, variance, skewness and excess kurtosis of g(Z), Z ~ N(0, 1), by quadrature."""
    x = g(ZQ)
    m = (WQ * x).sum()
    v = (WQ * (x - m) ** 2).sum()
    return m, v, (WQ * (x - m) ** 3).sum() / v ** 1.5, (WQ * (x - m) ** 4).sum() / v ** 2 - 3


# ------------------------------------------------------------------------- the families

@pytest.mark.parametrize("skew,kurt", [(0.0, 1.0), (1.0, 3.0), (-0.8, 2.0), (0.5, 0.6), (2.0, 10.0)])
def test_johnson_matches_skewness_and_kurtosis_exactly(skew, kurt):
    m, v, s, k = moments(inf.johnson_shape(skew, kurt).g)
    assert m == pytest.approx(0, abs=1e-9) and v == pytest.approx(1, rel=1e-9)
    assert s == pytest.approx(skew, abs=1e-6) and k == pytest.approx(kurt, abs=1e-5)


def test_johnson_rejects_kurtosis_below_the_lognormal_line():
    with pytest.raises(ValueError, match="ג'ונסון"):
        inf.johnson_shape(1.0, 0.5)             # the lognormal with skewness 1 already has 1.86


def test_cornish_fisher_is_standardized_and_must_stay_monotone():
    m, v, s, k = moments(inf.cornish_shape(0.3, 0.5).g)
    assert m == pytest.approx(0, abs=1e-12) and v == pytest.approx(1, rel=1e-12)
    assert s == pytest.approx(0.3, abs=0.06) and k == pytest.approx(0.5, abs=0.3)   # an approximation
    with pytest.raises(ValueError, match="קורניש"):
        inf.cornish_shape(1.0, 0.0)


def test_generalized_normal_special_cases():
    g = inf.gennorm_shape(2.0, 0.0).g                     # k = 2 is the normal itself
    z = np.linspace(-3, 3, 13)
    assert np.allclose(g(z), z, atol=2e-3)
    _, v, s, k = moments(inf.gennorm_shape(1.0, 0.0).g)   # k = 1: Laplace, excess kurtosis 3
    assert v == pytest.approx(1, abs=1e-3) and s == pytest.approx(0, abs=1e-6) and k == pytest.approx(3, abs=0.02)
    # Closed form for the symmetric law: excess kurtosis Gamma(5/k) Gamma(1/k) / Gamma(3/k)^2 - 3.
    kk = 1.5
    _, _, _, k15 = moments(inf.gennorm_shape(kk, 0.0).g)
    assert k15 == pytest.approx(math.gamma(5 / kk) * math.gamma(1 / kk) / math.gamma(3 / kk) ** 2 - 3, abs=0.02)
    _, _, s_pos, _ = moments(inf.gennorm_shape(1.5, 0.4).g)
    assert s_pos > 0.3                                     # a longer right tail


# --------------------------------------------------------------------------- the draws

def test_constant_inflation_is_the_compound_rate():
    C = inf.index_paths(InflationModel(mean=3.0, sd=0.0), np.arange(4), 30, seed=1)
    assert np.allclose(C, 1.03 ** (np.arange(31) / 12))


def test_yearly_draws_have_the_chosen_mean_spread_and_persistence():
    m = InflationModel(dist="johnson", mean=2.5, sd=1.5, skew=1.0, kurt=3.0, phi=0.6)
    r = inf.yearly_rates(m, np.arange(40_000), 30, seed=7) * 100
    assert r.mean() == pytest.approx(2.5, abs=0.02) and r.std() == pytest.approx(1.5, abs=0.02)
    s = ((r - r.mean()) ** 3).mean() / r.std() ** 3
    assert s == pytest.approx(1.0, abs=0.08)
    normal = inf.yearly_rates(replace(m, dist="normal"), np.arange(40_000), 30, seed=7)
    lag1 = np.corrcoef(normal[:, :-1].ravel(), normal[:, 1:].ravel())[0, 1]
    assert lag1 == pytest.approx(0.6, abs=0.01)


def test_draws_depend_only_on_seed_key_and_year():
    m = InflationModel(sd=2.0, phi=0.3)
    long = inf.yearly_rates(m, np.array([5, 9, 11]), 20, seed=3)
    short = inf.yearly_rates(m, np.array([11, 5]), 7, seed=3)
    assert np.array_equal(short, long[[2, 0], :7])            # order and length do not matter
    assert not np.allclose(inf.yearly_rates(m, np.array([5]), 7, seed=4), long[0, :7])


def test_validation_messages():
    with pytest.raises(ValueError, match="התמדה"):
        inf.validate(InflationModel(phi=1.0))
    with pytest.raises(ValueError, match="K"):
        inf.validate(InflationModel(dist="gennorm", power=0.2))
    inf.validate(InflationModel(source="history", phi=5.0))      # the history needs no model


# -------------------------------------------------------------------------- the engine

DAYS = pd.date_range("1979-12-01", "2012-12-31", freq="D")


class Hyper:
    """Shekel CPI rising 100% a year (like the 1980s) and an asset that exactly keeps up with
    it: its real return is zero, all its nominal gain is inflation."""
    is_demo = True

    def __init__(self):
        months = pd.date_range(DAYS[0], DAYS[-1], freq="MS")
        self.cpi_s = pd.Series(2.0 ** (np.arange(len(months)) / 12), index=months)
        level = self.cpi_s.reindex(self.cpi_s.index.union(DAYS)).ffill().reindex(DAYS)
        self.price = pd.Series(level.to_numpy() * 10, index=DAYS)

    def prices(self, ticker):
        return self.price

    def fx_usd_ils(self):
        return pd.Series(1.0, index=DAYS)

    def cpi(self, country):
        return self.cpi_s


def _plan(**kw):
    kw.setdefault("tax_rate", 0.0)
    return PlanRequest(stages=[Stage(months=120, holdings=[Holding("A", 100)])], start_amount=1000.0,
                       currency="ILS", step="M", min_start=date(1981, 1, 1), max_start=date(1981, 6, 1), **kw)


def test_model_replaces_the_cpi_and_keeps_the_real_return():
    md = Hyper()
    flat = InflationModel(mean=2.5, sd=0.0)
    nominal = run_plan(_plan(inflation=flat), md)
    assert np.allclose(nominal.final, 1000 * 1.025 ** 10)        # real 0% + model inflation
    real = run_plan(_plan(inflation=flat, real=True), md)
    assert np.allclose(real.final, 1000)
    hist = run_plan(_plan(inflation=InflationModel(source="history"), real=True), md)
    assert np.allclose(hist.final, 1000)                         # the same real result from the CPI
    # Real tax with the model: no real gain, no tax; on the nominal gain, tax only on inflation.
    taxed = run_plan(_plan(inflation=flat, tax_rate=25.0, tax_basis="real"), md)
    assert np.allclose(taxed.final, 1000 * 1.025 ** 10)
    nom_tax = run_plan(_plan(inflation=flat, tax_rate=25.0), md)
    assert np.allclose(nom_tax.final, 1000 + 0.75 * 1000 * (1.025 ** 10 - 1))


def test_random_model_and_detail_agree_and_synthetic_paths_use_it():
    md = Hyper()
    m = InflationModel(dist="gennorm", mean=3.0, sd=2.0, power=1.2, asym=0.2, phi=0.4)
    res = run_plan(_plan(inflation=m), md)
    keys = inf.date_keys(pd.DatetimeIndex(res.start_dates).values)
    C = inf.index_paths(m, keys, 120, seed=1)
    assert np.allclose(res.final, 1000 * C[:, -1])
    d = realization_detail(_plan(inflation=m), md, res.start_dates[3].date())
    assert d["summary"]["final"] == pytest.approx(res.final[3])
    syn = run_plan(_plan(inflation=m, mode="synthetic", paths=50, block=12, real=True), md)
    assert np.allclose(syn.final, 1000)                          # real 0% in every block
    syn_nom = run_plan(_plan(inflation=m, mode="synthetic", paths=50, block=12), md)
    assert np.allclose(syn_nom.final, 1000 * inf.index_paths(m, np.arange(50), 120, seed=1)[:, -1])


def test_trinity_with_the_model():
    md = Hyper()
    w = WithdrawRequest(stages=[WithdrawStage(months=120, rate=6.0, holdings=[Holding("A", 100)])],
                        start_amount=1000.0, currency="ILS", real=True, tax_rate=0.0, step="M",
                        min_start=date(1981, 1, 1), max_start=date(1981, 3, 1),
                        inflation=InflationModel(mean=2.0, sd=0.0))
    res = run_trinity(w, md)
    assert np.allclose(res.final, 1000 - 60 * 10)                # real 0%, 6% of the start a year, indexed


def test_dollar_plans_ignore_the_model():
    md = Hyper()
    a = run_plan(replace(_plan(), currency="USD", real=True), md)
    b = run_plan(replace(_plan(inflation=InflationModel(mean=9.0, sd=3.0)), currency="USD", real=True), md)
    assert np.allclose(a.final, b.final)


# ------------------------------------------------------------------------------ API

def test_preview_and_plan_api():
    from fastapi.testclient import TestClient

    import stockplan.data as data_mod
    from stockplan.api import app
    from stockplan.data import DemoMarketData

    data_mod._provider = DemoMarketData(end="2026-01-01")
    client = TestClient(app)
    body = client.post("/api/inflation/preview", json={"dist": "johnson", "mean": 2.5, "sd": 1.5, "skew": 1, "kurt": 3}).json()
    assert body["moments"]["skew"] == pytest.approx(1, abs=1e-3) and body["moments"]["kurt"] == pytest.approx(3, abs=1e-3)
    assert body["quantiles"]["p5"] < 2.5 < body["quantiles"]["p95"] and len(body["samples"]) == 5
    assert set(body["families"]) == {"normal", "johnson", "cornish", "gennorm"}
    bad = client.post("/api/inflation/preview", json={"dist": "cornish", "sd": 1, "skew": 1, "kurt": 0})
    assert bad.status_code == 400 and "קורניש" in bad.json()["detail"]
    plan = {"stages": [{"months": 120, "monthly_deposit": 1000, "holdings": [{"ticker": "SPY", "weight": 100}]}],
            "currency": "ILS", "inflation": {"dist": "gennorm", "sd": 2, "power": 1.2}}
    assert client.post("/api/simulate", json=plan).status_code == 200
    plan["inflation"] = {"dist": "johnson", "sd": 1, "skew": 1, "kurt": 0}
    r = client.post("/api/simulate", json=plan)
    assert r.status_code == 400 and "ג'ונסון" in r.json()["detail"]


def test_constant_inflation_ignores_the_hidden_shape_and_the_floor_is_reported():
    bad_shape = InflationModel(dist="cornish", skew=3.0, kurt=0.0, sd=0.0)
    inf.validate(bad_shape)                                       # the shape is unused at sd = 0
    assert inf.describe(bad_shape)["pdf"] is None
    wide = inf.describe(InflationModel(mean=2.5, sd=30.0))
    assert wide["floor_share"] == pytest.approx(0.5 * math.erfc(52.5 / 30 / math.sqrt(2)), rel=1e-3)
    assert inf.describe(InflationModel(sd=1.0))["floor_share"] == 0.0


def test_detail_keeps_the_daily_basket_and_the_real_exchange_rate():
    md = Hyper()
    req = _plan(inflation=InflationModel(sd=1.0))
    res = run_plan(req, md)
    d = realization_detail(req, md, res.start_dates[0].date())
    assert len(d["basket"]["dates"]) > 1000                        # daily, not monthly
    assert all(t["fx"] == pytest.approx(1.0) for t in d["trades"])  # the historical rate
    assert d["summary"]["final"] == pytest.approx(res.final[0])
