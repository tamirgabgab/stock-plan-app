"""Synthetic scenarios: paths glued from blocks of consecutive historical months (block
bootstrap), in the accumulation and the Trinity tabs."""
from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

import stockplan.data as data_mod
from stockplan.api import app
from stockplan.data import DataError, DemoMarketData
from stockplan.engine import (Holding, PlanRequest, Stage, WithdrawRequest, WithdrawStage, realization_detail,
                              run_plan, run_trinity)
from stockplan.engine.market import month_grid, prepare_market
from test_engine import DAYS, FakeData, exp_series, step_series

A = [Holding("A", 100)]
FIRST = pd.Timestamp(DAYS[0])          # the data (and so the sample) starts 1999-12-01; 60 monthly returns


def synth(stages, **kw):
    kw.setdefault("tax_rate", 0.0)
    return PlanRequest(stages=stages, mode="synthetic", **kw)


def wiggly() -> pd.Series:
    """A price whose every monthly return is different, so a return tells its month."""
    t = (DAYS - DAYS[0]).days.to_numpy()
    return pd.Series(100 * np.exp(0.004 * t / 30 + 0.05 * np.sin(t / 17.0)), index=DAYS)


def test_one_block_of_the_whole_history_is_the_history():
    # Block = all 60 months = the plan: every path is the history from the first month.
    data = FakeData({"A": wiggly()})
    stages = [Stage(months=60, monthly_deposit=100, holdings=A)]
    syn = run_plan(synth(stages, paths=3, block=60), data)
    hist = run_plan(PlanRequest(stages=stages, tax_rate=0.0, min_start=FIRST.date(), max_start=FIRST.date()), data)
    assert np.allclose(syn.final, hist.final[0], rtol=1e-12)


def test_paths_are_blocks_of_consecutive_months():
    data = FakeData({"A": wiggly()})
    req = synth([Stage(months=48, holdings=A)], paths=20, block=12, seed=7)
    market = prepare_market(req, data)
    p = market.prices[0].reshape(20, 49)
    g = p[:, 1:] / p[:, :-1]
    grid = pd.DatetimeIndex(month_grid(pd.DatetimeIndex([FIRST]), 60)[0])
    h = data.prices("A").reindex(grid).to_numpy()
    hist = h[1:] / h[:-1]
    for r in range(20):
        for k in range(4):
            block = g[r, 12 * k:12 * k + 12]
            s = int(np.argmin(np.abs(hist - block[0])))
            assert s + 12 <= len(hist) and np.allclose(block, hist[s:s + 12], rtol=1e-12)


def test_the_cpi_moves_with_the_same_months():
    # An asset that tracks the CPI exactly earns 0% real on every synthetic path, which
    # only holds if each month's CPI change comes from the same historical month.
    months = pd.date_range(DAYS[0], DAYS[-1], freq="MS")
    rng = np.random.default_rng(3)
    cpi = pd.Series(100 * np.cumprod(1 + rng.normal(0.003, 0.01, len(months))), index=months)
    price = cpi.reindex(cpi.index.union(DAYS)).ffill().reindex(DAYS)
    data = FakeData({"A": price}, cpi=cpi)
    res = run_plan(synth([Stage(months=36, monthly_deposit=100, holdings=A)], paths=50, block=6, real=True,
                         index_deposits=True), data)
    assert np.allclose(res.final, 3600, rtol=1e-9)
    assert np.allclose(res.paths[:, 0], 100)        # month 0 is today's money: no deflation


def test_seed_and_paths():
    data = FakeData({"A": wiggly()})
    stages = [Stage(months=36, monthly_deposit=100, holdings=A)]
    a = run_plan(synth(stages, paths=200, seed=1), data).final
    b = run_plan(synth(stages, paths=200, seed=1), data).final
    c = run_plan(synth(stages, paths=200, seed=2), data).final
    assert len(a) == 200 and np.array_equal(a, b) and not np.array_equal(a, c)


def test_the_sample_window():
    # Flat until 2003, then it doubles; sampling only until 2002 never sees the jump.
    data = FakeData({"A": step_series({"2003-03-15": 2.0})})
    stages = [Stage(months=24, monthly_deposit=100, holdings=A)]
    early = run_plan(synth(stages, paths=100, sample_to=date(2002, 6, 1)), data)
    assert np.allclose(early.final, 2400)
    late = run_plan(synth(stages, paths=100, sample_from=date(2001, 1, 1)), data)
    assert (late.final > 2400).any()
    with pytest.raises(DataError, match="תקופת הדגימה קצרה"):
        run_plan(synth(stages, sample_from=date(2004, 6, 1)), data)


def test_one_path_matches_the_full_run():
    data = FakeData({"A": wiggly(), "B": exp_series(0.03)})
    stages = [Stage(months=36, monthly_deposit=100, holdings=[Holding("A", 70), Holding("B", 30)])]
    req = synth(stages, paths=30, seed=5, tax_rate=25.0)
    full = run_plan(req, data)
    d = realization_detail(req, data, None, path=17)
    assert d["synthetic"] and d["basket"] is None
    assert d["summary"]["final"] == pytest.approx(full.final[17], rel=1e-9)


def test_trinity_synthetic_and_the_heatmap_stays_historical():
    data = FakeData({"A": wiggly()})
    req = WithdrawRequest(stages=[WithdrawStage(months=120, holdings=A, rate=4.0)], start_amount=1000,
                          mode="synthetic", paths=100, block=12)
    res = run_trinity(req, data)            # ten years from five years of data
    assert len(res.final) == 100
    with pytest.raises(DataError):
        run_trinity(WithdrawRequest(stages=req.stages, start_amount=1000), data)


def test_validation():
    data = FakeData({"A": wiggly()})
    with pytest.raises(ValueError, match="אורך הבלוק"):
        run_plan(synth([Stage(months=12, holdings=A)], start_amount=1, block=0), data)
    with pytest.raises(ValueError, match="מקור תרחישים"):
        run_plan(PlanRequest(stages=[Stage(months=12, holdings=A)], start_amount=1, mode="future"), data)


def test_api_synthetic(monkeypatch):
    monkeypatch.setattr(data_mod, "_provider", DemoMarketData(end="2026-01-01"))
    client = TestClient(app)
    body = {"stages": [{"months": 300, "monthly_deposit": 3000, "holdings": [{"ticker": "^GSPC", "weight": 100}]},
                       {"months": 360, "kind": "withdraw", "holdings": [{"ticker": "^GSPC", "weight": 100}]}],
            "currency": "ILS", "real": True, "target_amount": 0, "mode": "synthetic", "paths": 300, "seed": 4}
    # 55 years do not fit in the demo history, but synthetic paths do.
    assert client.post("/api/simulate", json={**body, "mode": "history"}).status_code == 400
    out = client.post("/api/simulate", json=body).json()
    assert out["n"] == 300 and out["synthetic"] and len(out["success"]) == 300
    d = client.post("/api/realization", json={"plan": body, "path": 5}).json()
    assert d["summary"]["final"] == pytest.approx(out["final"][5], rel=1e-6)
    b = client.post("/api/realization/benchmark", json={"plan": body, "path": 5, "rate": 4}).json()
    assert len(b["path"]) == 661
    tri = {"stages": [{"months": 360, "holdings": [{"ticker": "SPY", "weight": 100}]}], "currency": "USD",
           "mode": "synthetic", "paths": 200}
    assert client.post("/api/trinity/simulate", json=tri).json()["n"] == 200
    assert client.post("/api/trinity/heatmap", json={"plan": tri, "years_to": 20}).status_code == 200
    assert client.post("/api/realization", json={"plan": body}).status_code == 400


def test_a_longer_plan_extends_the_same_paths():
    # A/B comparison of plans of different lengths: path r of the short plan is the start
    # of path r of the long one.
    data = FakeData({"A": wiggly()})
    short = prepare_market(synth([Stage(months=30, holdings=A)], paths=40, block=12, seed=9), data)
    long = prepare_market(synth([Stage(months=55, holdings=A)], paths=40, block=12, seed=9), data)
    p_short = short.prices[0].reshape(40, 31)
    p_long = long.prices[0].reshape(40, 56)
    assert np.allclose(p_long[:, :31], p_short, rtol=1e-12)
