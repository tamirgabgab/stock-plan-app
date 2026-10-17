from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from stockplan.api import app
from stockplan.engine.property import (Bracket, PropertyRequest, annuity, bracket_tax, irr_monthly, run_property,
                                       simulate_scenario, solve_equal)

client = TestClient(app)


def apartment(**kw):
    base = {"kind": "apartment", "id": "a", "name": "דירה", "price": 2_000_000, "ltv": 50, "rent": 0,
            "maintenance_pct": 0, "selling_cost_pct": 0, "appreciation": 0, "usage": "rent",
            "tracks": [{"name": "t", "share": 100, "years": 20, "rate": 4.8}],
            "side": {"annual_return": 0, "annual_fee": 0, "tax_rate": 0}}
    base.update(kw)
    return base


def request(scenarios, **common):
    c = {"years": 20, "equity": 1_500_000, "budget": 10_000, "index_budget": False, "inflation": 0}
    c.update(common)
    return PropertyRequest.model_validate({"common": c, "scenarios": scenarios})


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
    req = request([{"kind": "market", "id": "m", "market": {"annual_return": 6, "annual_fee": 0, "tax_rate": 0}}])
    res = run_property(req)
    s = res["scenarios"][0]
    q, T, E, M = 1.06 ** (1 / 12), 240, 1_500_000, 10_000
    assert s["net"][T] == pytest.approx(E * q ** T + M * (q ** T - 1) / (q - 1), rel=1e-10)
    assert s["metrics"]["irr"] == pytest.approx(6.0, abs=1e-6)


def test_market_tax_on_real_gain():
    req = request([{"kind": "market", "id": "m", "market": {"annual_return": 2, "annual_fee": 0, "tax_rate": 25,
                                                            "tax_basis": "real"}}], budget=0, inflation=2)
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


def test_equity_shortfall_becomes_debt_with_warning():
    req = request([apartment(debt_rate=6)], equity=900_000, budget=0)
    s = run_property(req)["scenarios"][0]
    assert s["parts"]["side_debt"][0] == pytest.approx(100_000 + s["summary"]["purchase_tax"])
    assert any("ההון העצמי קטן" in w for w in s["warnings"])


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
    common = dict(inflation=0, budget=0)
    single = request([apartment(appreciation=4, status="single")], **common)
    s = run_property(single)["scenarios"][0]
    assert s["parts"]["shevach"][-1] == 0       # below the exemption ceiling
    add = request([apartment(appreciation=4, status="additional")], **common)
    s = run_property(add)["scenarios"][0]
    home = s["parts"]["home"][-1]
    ptax = s["summary"]["purchase_tax"]
    assert s["parts"]["shevach"][-1] == pytest.approx(0.25 * (home - 2_000_000 - ptax))


def test_shevach_single_above_ceiling_is_partial():
    req = request([apartment(price=6_000_000, ltv=0, appreciation=3, status="single")], equity=7_000_000, budget=0)
    s = run_property(req)["scenarios"][0]
    home = s["parts"]["home"][-1]
    gain = home - 6_000_000 - s["summary"]["deductible"]
    ceiling = req.taxes.shevach_single_ceiling
    assert s["parts"]["shevach"][-1] == pytest.approx(0.25 * gain * (home - ceiling) / home)


def test_live_in_saves_the_housing_rent():
    m = {"kind": "market", "id": "m", "market": {"annual_return": 0, "annual_fee": 0, "tax_rate": 0}}
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
    m = {"kind": "market", "id": "m", "market": {"annual_return": 6, "annual_fee": 0, "tax_rate": 25}}
    req = request([m, apartment(rent=5000, appreciation=3)])
    out = solve_equal(req, "m", "a", "final", "m", "market.annual_return", 0, 15)
    assert len(out["roots"]) == 1
    x = out["roots"][0]
    req.scenarios[0].market.annual_return = x
    res = run_property(req)
    fm, fa = (s["metrics"]["final"] for s in res["scenarios"])
    assert fm == pytest.approx(fa, rel=1e-6)


def test_solve_track_rate_and_common_param():
    m = {"kind": "market", "id": "m", "market": {"annual_return": 3}}
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
    plan = {"common": {"years": 10, "equity": 800_000, "budget": 6000, "real": True},
            "scenarios": [{"kind": "market", "id": "m", "name": "שוק"},
                          apartment(price=2_000_000, ltv=70, rent=5000)]}
    body = client.post("/api/property/simulate", json=plan).json()
    assert body["months"] == 120 and len(body["scenarios"]) == 2
    assert len(body["scenarios"][1]["net"]) == 121
    assert body["scenarios"][1]["summary"]["tracks"][0]["first_payment"] > 0
    sol = client.post("/api/property/solve", json={"plan": plan, "a": "m", "b": "a", "metric": "final",
                                                   "scope": "a", "key": "appreciation", "lo": -5, "hi": 15}).json()
    assert len(sol["roots"]) == 1
    bad = client.post("/api/property/solve", json={"plan": plan, "a": "m", "b": "m", "metric": "final",
                                                   "scope": "a", "key": "price", "lo": 1, "hi": 2})
    assert bad.status_code == 400
