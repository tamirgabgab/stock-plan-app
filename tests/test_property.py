from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from stockplan.api import app
from stockplan.engine.property import (PURCHASE_ADDITIONAL, PURCHASE_SINGLE, Bracket, InputError, PropertyRequest,
                                       alloc_bounds, annuity, bracket_tax, irr_monthly, run_property,
                                       simulate_scenario, solve_equal)

client = TestClient(app)


def apartment(**kw):
    """An apartment scenario; ``ltv`` (percent of the price) is turned into ``alloc`` by ``plan``."""
    base = {"id": "a", "name": "דירה", "price": 2_000_000, "ltv": 50, "rent": 0,
            "maintenance_pct": 0, "selling_cost_pct": 0, "appreciation": 0, "usage": "rent",
            "tracks": [{"name": "t", "share": 100, "years": 20, "rate": 4.8}],
            "market": {"annual_return": 0, "annual_fee": 0, "tax_rate": 0}}
    base.update(kw)
    return base


def market(id="m", **params):
    return {"id": id, "name": "שוק", "alloc": 0, "market": params}


def plan(scenarios, common):
    """The request body: each ``ltv`` becomes the share of the equity that buys it."""
    out = []
    for sc in scenarios:
        sc = dict(sc)
        ltv = sc.pop("ltv", None)
        if ltv is not None:
            rows = PURCHASE_SINGLE if sc.get("status", "single") == "single" else PURCHASE_ADDITIONAL
            ptax = bracket_tax(sc["price"], [Bracket(up_to=u, rate=r) for u, r in rows])
            costs = sum(x["amount"] for x in sc.get("costs", []))
            sc["alloc"] = (sc["price"] * (1 - ltv / 100) + ptax + costs) / common["equity"] * 100
        out.append(sc)
    return {"common": common, "scenarios": out}


def request(scenarios, **common):
    c = {"years": 20, "equity": 1_500_000, "budget": 10_000, "index_budget": False, "inflation": 0}
    c.update(common)
    return PropertyRequest.model_validate(plan(scenarios, c))


def test_purchase_tax_brackets():
    single = [Bracket(up_to=u, rate=r) for u, r in [(1_978_745, 0), (2_347_040, 3.5), (6_055_070, 5), (None, 8)]]
    assert bracket_tax(1_900_000, single) == 0
    assert bracket_tax(2_200_000, single) == pytest.approx((2_200_000 - 1_978_745) * 0.035)
    assert bracket_tax(3_000_000, single) == pytest.approx((2_347_040 - 1_978_745) * 0.035 + (3_000_000 - 2_347_040) * 0.05)
    req = request([apartment(status="additional", price=2_200_000)])
    r = simulate_scenario(req.scenarios[0], req.common, req.taxes)
    assert r["summary"]["purchase_tax"] == pytest.approx(0.08 * 2_200_000)


def test_spitzer_track_matches_closed_form():
    req = request([apartment()])
    r = simulate_scenario(req.scenarios[0], req.common, req.taxes)
    L, rho, n = 1_000_000, 0.048 / 12, 240
    A = annuity(L, rho, n)
    assert r["flows"]["payment"][1] == pytest.approx(A)
    for t in (1, 60, 239):
        closed = L * ((1 + rho) ** n - (1 + rho) ** t) / ((1 + rho) ** n - 1)
        assert r["parts"]["mortgage"][t] == pytest.approx(closed, rel=1e-9)
    assert r["parts"]["mortgage"][240] == pytest.approx(0, abs=1e-6)


def test_indexed_track_is_real_annuity_times_cpi():
    req = request([apartment(tracks=[{"share": 100, "years": 20, "rate": 3, "indexed": True}])], inflation=3)
    r = simulate_scenario(req.scenarios[0], req.common, req.taxes)
    real_A = annuity(1_000_000, 0.03 / 12, 240)
    cpi = r["cpi"]
    for m in (1, 100, 240):
        assert r["flows"]["payment"][m] == pytest.approx(real_A * cpi[m], rel=1e-9)


def test_equal_principal_track():
    req = request([apartment(tracks=[{"share": 100, "years": 10, "rate": 6, "method": "equal"}])])
    r = simulate_scenario(req.scenarios[0], req.common, req.taxes)
    L, n, rho = 1_000_000, 120, 0.005
    assert r["parts"]["mortgage"][30] == pytest.approx(L * (1 - 30 / n))
    assert r["flows"]["payment"][31] == pytest.approx(L / n + rho * L * (1 - 30 / n))


def test_market_closed_form_and_irr():
    req = request([market(annual_return=6, annual_fee=0, tax_rate=0)])
    res = run_property(req)
    s = res["scenarios"][0]
    q, T, E, M = 1.06 ** (1 / 12), 240, 1_500_000, 10_000
    assert s["net"][T] == pytest.approx(E * q ** T + M * (q ** T - 1) / (q - 1), rel=1e-10)
    assert s["metrics"]["irr"] == pytest.approx(6.0, abs=1e-6)


def test_market_tax_on_real_gain():
    req = request([market(annual_return=2, annual_fee=0, tax_rate=25, tax_basis="real")], budget=0, inflation=2)
    s = run_property(req)["scenarios"][0]
    assert s["parts"]["portfolio_tax"][-1] == pytest.approx(0, abs=1e-6)   # all of the gain is inflation


def test_upfront_costs_come_out_of_equity_and_net_worth_starts_lower():
    req = request([apartment(costs=[{"name": "lawyer", "amount": 10_000}], selling_cost_pct=2)], equity=1_100_000)
    s = run_property(req)["scenarios"][0]
    ptax = s["summary"]["purchase_tax"]
    assert ptax == pytest.approx((2_000_000 - 1_978_745) * 0.035)
    assert s["summary"]["upfront"] == pytest.approx(1_000_000 + ptax + 10_000)
    assert s["summary"]["side_start"] == pytest.approx(90_000 - ptax)
    # Net worth at month 0: equity minus the costs that are gone (tax, one-time and selling costs).
    assert s["net"][0] == pytest.approx(1_100_000 - ptax - 10_000 - 0.02 * 2_000_000)


def test_the_apartment_share_sets_the_mortgage():
    # 800k of equity, all of it in a 2M apartment: the mortgage is the price less what is left
    # of the 800k after the purchase tax and the costs.
    req = request([apartment(ltv=None, alloc=100, costs=[{"amount": 20_000}])], equity=800_000, budget=10_000)
    s = run_property(req)["scenarios"][0]
    ptax = s["summary"]["purchase_tax"]
    assert s["summary"]["loan"] == pytest.approx(2_000_000 - (800_000 - ptax - 20_000))
    assert s["summary"]["side_start"] == pytest.approx(0)
    assert s["summary"]["ltv"] == pytest.approx(s["summary"]["loan"] / 20_000)


def test_surplus_flows_into_side_account():
    req = request([apartment(rent=5000)], budget=10_000)
    s = run_property(req)["scenarios"][0]
    A = annuity(1_000_000, 0.004, 240)
    assert s["flows"]["flow"][1] == pytest.approx(10_000 + 5000 - A)
    assert s["parts"]["side"][1] == pytest.approx(500_000 - s["summary"]["purchase_tax"] + 10_000 + 5000 - A)


def test_rent_tax_exempt_track():
    req = request([apartment(rent=7000, rent_tax="exempt", marginal_rate=30)])
    req.taxes.rent_exempt_ceiling = 5000
    s = run_property(req)["scenarios"][0]
    assert s["flows"]["rent_tax"][1] == pytest.approx(0.30 * 2 * (7000 - 5000))
    req.scenarios[0].rent = 4000
    assert run_property(req)["scenarios"][0]["flows"]["rent_tax"][1] == 0


def test_shevach_single_exempt_additional_taxed():
    common = dict(inflation=0, budget=10_000)
    single = request([apartment(appreciation=4, status="single")], **common)
    s = run_property(single)["scenarios"][0]
    assert s["parts"]["shevach"][-1] == 0       # below the exemption ceiling
    add = request([apartment(appreciation=4, status="additional")], **common)
    s = run_property(add)["scenarios"][0]
    home = s["parts"]["home"][-1]
    ptax = s["summary"]["purchase_tax"]
    assert s["parts"]["shevach"][-1] == pytest.approx(0.25 * (home - 2_000_000 - ptax))


def test_shevach_single_above_ceiling_is_partial():
    req = request([apartment(price=6_000_000, ltv=0, appreciation=3, status="single")], equity=7_000_000, budget=1000)
    s = run_property(req)["scenarios"][0]
    home = s["parts"]["home"][-1]
    gain = home - 6_000_000 - s["summary"]["deductible"]
    ceiling = req.taxes.shevach_single_ceiling
    assert s["parts"]["shevach"][-1] == pytest.approx(0.25 * gain * (home - ceiling) / home)


def test_live_in_saves_the_housing_rent():
    m = market(annual_return=0, annual_fee=0, tax_rate=0)
    req = request([m, apartment(usage="live")], housing_rent=4000, housing_rent_growth=0)
    res = run_property(req)
    mk, ap = res["scenarios"]
    assert mk["flows"]["invested"][1] == pytest.approx(10_000 - 4000)
    assert ap["flows"]["housing"][1] == 0


def test_irr_monthly():
    flows = np.array([-100.0] + [0] * 11 + [110.0])
    x = irr_monthly(flows)
    assert (1 + x) ** 12 - 1 == pytest.approx(0.10)


def test_solve_equal_finds_break_even():
    m = market(annual_return=6, annual_fee=0, tax_rate=25)
    req = request([m, apartment(rent=5000, appreciation=3)])
    out = solve_equal(req, "m", "a", "final", "m", "market.annual_return", 0, 15)
    assert len(out["roots"]) == 1
    x = out["roots"][0]
    req.scenarios[0].market.annual_return = x
    res = run_property(req)
    fm, fa = (s["metrics"]["final"] for s in res["scenarios"])
    assert fm == pytest.approx(fa, rel=1e-6)


def test_solve_track_rate_and_common_param():
    m = market(annual_return=3)
    req = request([m, apartment(rent=5000, appreciation=3)])
    out = solve_equal(req, "m", "a", "final", "a", "tracks.0.rate", 0, 20)
    assert len(out["roots"]) == 1
    req.scenarios[1].tracks[0].rate = out["roots"][0]
    fm, fa = (s["metrics"]["final"] for s in run_property(req)["scenarios"])
    assert fm == pytest.approx(fa, rel=1e-6)
    out = solve_equal(req, "m", "a", "final", "common", "budget", 0, 50_000)
    assert out["current_diff"] == pytest.approx(0, abs=1)
    with pytest.raises(ValueError):
        solve_equal(req, "m", "a", "final", "a", "no_such_field", 0, 1)


def test_api_simulate_and_solve():
    body_in = plan([market(), apartment(price=2_000_000, ltv=70, rent=5000)],
                   {"years": 10, "equity": 800_000, "budget": 6000, "real": True})
    body = client.post("/api/property/simulate", json=body_in).json()
    assert body["months"] == 120 and len(body["scenarios"]) == 2
    assert len(body["scenarios"][1]["net"]) == 121
    assert body["scenarios"][1]["summary"]["tracks"][0]["first_payment"] > 0
    sol = client.post("/api/property/solve", json={"plan": body_in, "a": "m", "b": "a", "metric": "final",
                                                   "scope": "a", "key": "appreciation", "lo": -5, "hi": 15}).json()
    assert len(sol["roots"]) == 1
    bad = client.post("/api/property/solve", json={"plan": body_in, "a": "m", "b": "m", "metric": "final",
                                                   "scope": "a", "key": "price", "lo": 1, "hi": 2})
    assert bad.status_code == 400


# ------------------------------------------------------------ variable rates

from stockplan.data import DemoMarketData
from stockplan.engine.property import fixed_paths, metrics, months_of, simulate
from stockplan.engine.property_data import build_paths


def test_prime_track_equals_fixed_when_the_rate_is_flat():
    prime = request([apartment(tracks=[{"share": 100, "years": 20, "kind": "prime", "margin": -0.5}])],
                    rate_path=[{"year": 0, "rate": 4.5}], prime_spread=1.5)
    fixed = request([apartment(tracks=[{"share": 100, "years": 20, "rate": 5.5}])])
    a = simulate_scenario(prime.scenarios[0], prime.common, prime.taxes)
    b = simulate_scenario(fixed.scenarios[0], fixed.common, fixed.taxes)
    assert np.allclose(a["flows"]["payment"], b["flows"]["payment"])


def test_rate_change_recomputes_the_payment_on_the_remaining_term():
    req = request([apartment(tracks=[{"share": 100, "years": 20, "kind": "prime", "margin": 0}])],
                  rate_path=[{"year": 0, "rate": 3.5}, {"year": 5, "rate": 5.5}], prime_spread=1.5)
    r = simulate_scenario(req.scenarios[0], req.common, req.taxes)
    bal60 = r["parts"]["mortgage"][60]
    assert r["flows"]["payment"][60] == pytest.approx(annuity(1_000_000, 0.05 / 12, 240))
    assert r["flows"]["payment"][61] == pytest.approx(annuity(bal60, 0.07 / 12, 180))


def test_variable_track_resets_every_n_years():
    req = request([apartment(tracks=[{"share": 100, "years": 20, "kind": "variable", "margin": 1, "reset_years": 5}])],
                  rate_path=[{"year": 0, "rate": 3}, {"year": 2, "rate": 6}, {"year": 5, "rate": 2}])
    r = simulate_scenario(req.scenarios[0], req.common, req.taxes)
    rates = r["summary"]["tracks"][0]["rates"]
    assert rates[1] == pytest.approx(4) and rates[60] == pytest.approx(4)    # fixed until the reset
    assert rates[61] == pytest.approx(3)                                       # BoI 2% + 1% at year 5


def test_schedule_track_and_rate_shift():
    sched = [{"year": 0, "rate": 4}, {"year": 3, "rate": 6}]
    req = request([apartment(tracks=[{"share": 100, "years": 20, "kind": "schedule", "schedule": sched}])], rate_shift=1)
    r = simulate_scenario(req.scenarios[0], req.common, req.taxes)
    rates = r["summary"]["tracks"][0]["rates"]
    assert rates[36] == pytest.approx(5) and rates[37] == pytest.approx(7)


def test_solve_rate_shift_break_even():
    m = market(annual_return=3)
    req = request([m, apartment(rent=5000, appreciation=3,
                                tracks=[{"share": 100, "years": 20, "kind": "prime", "margin": 0}])],
                  rate_path=[{"year": 0, "rate": 3}])
    out = solve_equal(req, "m", "a", "final", "common", "rate_shift", -2, 10)
    assert len(out["roots"]) == 1
    req.common.rate_shift = out["roots"][0]
    fm, fa = (s["metrics"]["final"][0] for s in run_property(req)["scenarios"])
    assert fm == pytest.approx(fa, rel=1e-5)


def test_array_parameters_match_scalar_runs():
    req = request([apartment(rent=5000)])
    d = req.model_dump()
    T = months_of(d["common"]["years"])
    xs = np.array([1.0, 3.0, 5.0])
    sc = dict(d["scenarios"][0], appreciation=xs[:, None])
    r = simulate(sc, d["common"], d["taxes"], fixed_paths(T), shape=(3, 1), full=False)
    for i, x in enumerate(xs):
        one = simulate(dict(d["scenarios"][0], appreciation=x), d["common"], d["taxes"], fixed_paths(T))
        assert r["net"][-1][i, 0] == pytest.approx(one["net"][-1][0])


# --------------------------------------------------------------------- history

MD = DemoMarketData(end="2026-01-01")


def hist_request(years=10, **flags):
    common = {"years": years, "equity": 900_000, "budget": 8000, "mode": "history", "real": True,
              "history": {"market": True, "cpi": True, "housing": True, "rent": True, "rate": True, **flags}}
    scenarios = [market(), apartment(price=2_000_000, ltv=60, rent=5000,
                                     tracks=[{"share": 50, "years": 20, "kind": "prime", "margin": -0.5},
                                             {"share": 50, "years": 20, "rate": 4.5, "indexed": True}])]
    return PropertyRequest.model_validate(plan(scenarios, common))


def test_history_paths_cover_every_start():
    req = hist_request()
    paths = build_paths(req, MD)
    assert paths.R > 12 and paths.start_dates[0] >= pd.Timestamp("1994-01-01")
    assert np.allclose(paths.cpi[:, 0], 1) and np.allclose(paths.home[:, 0], 1)
    assert paths.rate.shape == (paths.R, 121)
    # Fewer historical series -> a longer range (the market data start in 1985).
    short = build_paths(hist_request(housing=False, rent=False, rate=False), MD)
    assert short.R > paths.R


def test_history_market_matches_the_portfolio_returns():
    req = hist_request()
    req.scenarios[0].market.annual_fee = 0
    req.scenarios[0].market.tax_rate = 0
    req.common.index_budget = False
    paths = build_paths(req, MD)
    d = req.model_dump()
    r = simulate(d["scenarios"][0], d["common"], d["taxes"], paths)
    g = next(iter(paths.growth.values()))
    v = np.full(paths.R, 900_000.0)
    for m in range(1, paths.T + 1):
        v = v * g[:, m] + 8000
    assert np.allclose(r["net"][-1], v)


def test_history_run_and_too_long_horizon():
    res = run_property(hist_request(), MD)
    s = res["scenarios"][1]
    assert s["net"].shape == (121, res["paths"].R)
    assert np.isfinite(s["metrics"]["irr"]).any()
    with pytest.raises(Exception, match="אין תאריכי התחלה"):
        build_paths(hist_request(years=40), MD)


def test_history_solve_per_row():
    req = hist_request()
    out = solve_equal(req, "m", "a", "final", "a", "appreciation", -10, 20, stat="median", md=MD)
    rows = out["per_row"]["roots"]
    assert len(rows) == build_paths(req, MD).R
    # With the housing index on history, appreciation is unused: switch it off to solve on it.
    req.common.history.housing = False
    out = solve_equal(req, "m", "a", "final", "a", "appreciation", -10, 20, stat="median", md=MD)
    assert out["roots"]
    i = next(i for i, x in enumerate(out["per_row"]["roots"]) if x is not None)
    req.scenarios[1].appreciation = out["per_row"]["roots"][i]
    res = run_property(req, MD)
    fm, fa = (sc["metrics"]["final"][i] for sc in res["scenarios"])
    assert fm == pytest.approx(fa, rel=1e-4)


def test_api_history(monkeypatch):
    import stockplan.data as data_mod
    monkeypatch.setattr(data_mod, "_provider", MD)
    body = client.post("/api/property/simulate", json=hist_request().model_dump()).json()
    assert body["mode"] == "history" and body["n"] == len(body["start_dates"]) > 1
    assert len(body["scenarios"][0]["metrics"]["final"]) == body["n"]
    pick = body["start_dates"][3]
    plan = hist_request().model_dump() | {"detail_start": pick}
    assert client.post("/api/property/simulate", json=plan).json()["detail_row"] == 3


# ------------------------------------------------------------------ input checks

def failed(res, id="a"):
    return next(f for f in res["failed"] if f["id"] == id)["errors"]


def test_market_only_ignores_the_apartment_fields():
    a = run_property(request([market(annual_return=5)]))["scenarios"][0]
    b = run_property(request([dict(market(annual_return=5), price=9_000_000, rent=50_000)]))["scenarios"][0]
    assert a["kind"] == "market" and np.allclose(a["net"], b["net"])


def test_apartment_share_below_the_purchase_costs_is_an_error():
    sc = apartment(ltv=None, alloc=1, costs=[{"amount": 50_000}])
    res = run_property(request([market(), sc]))
    errs = failed(res)
    assert errs[0]["field"] == "alloc" and "המינימום" in errs[0]["msg"]
    assert [s["id"] for s in res["scenarios"]] == ["m"]          # the other scenario still runs
    d = request([sc]).model_dump()
    need, lo, hi = alloc_bounds(d["scenarios"][0], d["common"], d["taxes"])
    assert lo == pytest.approx(need / 1_500_000 * 100)


def test_equity_smaller_than_the_purchase_costs():
    res = run_property(request([apartment(ltv=None, alloc=100, costs=[{"amount": 60_000}])], equity=50_000))
    assert "אי אפשר לקנות" in failed(res)[0]["msg"]


def test_apartment_share_above_the_price_is_an_error():
    res = run_property(request([apartment(ltv=None, alloc=100, price=1_000_000)], equity=1_500_000))
    assert "המקסימום" in failed(res)[0]["msg"]


def test_mix_must_add_up_to_100():
    sc = apartment(tracks=[{"share": 60, "years": 20, "rate": 4}, {"share": 30, "years": 20, "rate": 5}])
    errs = failed(run_property(request([sc])))
    assert errs[0]["field"] == "tracks" and "90%" in errs[0]["msg"]
    errs = failed(run_property(request([apartment(tracks=[])])))
    assert "אין מסלולים" in errs[0]["msg"]


def test_small_equity_share_warns_but_runs():
    s = run_property(request([apartment(ltv=85, rent=5000)], budget=15_000))["scenarios"][0]
    assert any("פחות מ-25%" in w and "החזר חודשי גבוה" in w for w in s["warnings"])
    s = run_property(request([apartment(ltv=60, status="additional", rent=5000)], budget=15_000))["scenarios"][0]
    assert any("פחות מ-50%" in w for w in s["warnings"])


def test_budget_that_misses_the_first_month_is_an_error():
    res = run_property(request([market(), apartment(ltv=70)], budget=3000))
    errs = failed(res)
    assert errs[0]["field"] == "monthly" and "חסרים" in errs[0]["msg"]
    res = run_property(request([market()], budget=1000, housing_rent=4000))
    assert "קטן משכר הדירה" in failed(res, "m")[0]["msg"]


def test_shared_inputs_that_cannot_happen():
    with pytest.raises(InputError) as e:
        run_property(request([market()], equity=0, budget=0))
    assert e.value.errors[0]["field"] == "common.equity"
    req = request([market()])
    req.taxes.purchase_single = [Bracket(up_to=1_000_000, rate=0), Bracket(up_to=2_000_000, rate=5)]
    with pytest.raises(InputError, match="ומעלה"):
        run_property(req)
    body = plan([market()], {"years": 10, "equity": 0, "budget": 0})
    r = client.post("/api/property/simulate", json=body)
    assert r.status_code == 400 and r.json()["detail"]["errors"][0]["field"] == "common.equity"


def test_api_reports_failed_scenarios():
    body = plan([market(), apartment(ltv=None, alloc=1, costs=[{"amount": 30_000}])],
                {"years": 10, "equity": 800_000, "budget": 8000})
    out = client.post("/api/property/simulate", json=body).json()
    assert [s["id"] for s in out["scenarios"]] == ["m"] and out["failed"][0]["errors"][0]["field"] == "alloc"
    body = plan([apartment(ltv=None, alloc=1)], {"years": 10, "equity": 800_000, "budget": 8000})
    out = client.post("/api/property/simulate", json=body).json()
    assert out["scenarios"] == [] and out["failed"]


def test_solve_on_the_share_skips_values_that_cannot_happen():
    req = request([market(annual_return=4), apartment(rent=6000, appreciation=3)], equity=1_500_000)
    out = solve_equal(req, "m", "a", "final", "a", "alloc", 0, 100)
    need, lo, hi = alloc_bounds(req.model_dump()["scenarios"][1], req.model_dump()["common"], req.model_dump()["taxes"])
    xs, ys = np.array(out["scan_x"]), out["scan_y"]
    assert all(y is None for x, y in zip(xs, ys) if x < lo - 1e-9)
    assert all(y is not None for x, y in zip(xs, ys) if lo + 1e-9 < x <= 100)
    for x in out["roots"]:
        assert lo <= x <= hi
