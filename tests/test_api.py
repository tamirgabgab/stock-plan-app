from __future__ import annotations

import base64

import numpy as np
import pytest
from fastapi.testclient import TestClient

import stockplan.data as data_mod
from stockplan.api import app
from stockplan.data import DemoMarketData


@pytest.fixture(autouse=True)
def demo_provider(monkeypatch):
    monkeypatch.setattr(data_mod, "_provider", DemoMarketData(end="2026-01-01"))


client = TestClient(app)

PLAN = {
    "stages": [{"months": 120, "monthly_deposit": 1000,
                "holdings": [{"ticker": "SPY", "weight": 70}, {"ticker": "QQQ", "weight": 30, "leverage": 2}]}],
    "start_amount": 10000,
    "currency": "ILS",
    "real": True,
    "step": "M",
}


def test_meta_lists_favorites():
    body = client.get("/api/meta").json()
    assert body["demo"] is True
    assert any(i["ticker"] == "SPY" for g in body["favorites"] for i in g["items"])


def test_range():
    body = client.post("/api/range", json=PLAN).json()
    assert body["total_months"] == 120
    assert body["min_start"] < body["max_start"]


def test_simulate_returns_paths_matrix():
    body = client.post("/api/simulate", json=PLAN).json()
    n, T1 = body["n"], body["months"] + 1
    paths = np.frombuffer(base64.b64decode(body["paths"]), dtype="<f4").reshape(n, T1)
    assert len(body["start_dates"]) == n
    assert np.allclose(paths[:, -1], body["final"], rtol=1e-5)
    gross = np.frombuffer(base64.b64decode(body["paths_gross"]), dtype="<f4").reshape(n, T1)
    assert (gross[:, -1] >= paths[:, -1] - 1e-3).all() and np.allclose(gross[:, -1], body["final_gross"], rtol=1e-5)
    years = np.frombuffer(base64.b64decode(body["year_irr_gross"]), dtype="<f4").reshape(n, body["years"])
    assert body["years"] == T1 // 12 and np.isfinite(years).all()
    assert len(body["account_drawdown"]) == n and all(v <= 0 for v in body["account_drawdown"])


def test_solve_mode():
    body = client.post("/api/simulate", json={**PLAN, "solve_for": "monthly_deposit",
                                              "target_amount": 2_000_000}).json()
    assert all(v is None or v > 0 for v in body["solved"])
    assert np.allclose([f for f in body["final"]], 2_000_000, rtol=1e-4)


def test_errors_are_400_with_hebrew_message():
    bad = {**PLAN, "stages": [{"months": 12, "holdings": [{"ticker": "SPY", "weight": 0}]}]}
    r = client.post("/api/simulate", json=bad)
    assert r.status_code == 400
    assert "משקל" in r.json()["detail"]


def test_index_page_served():
    r = client.get("/")
    assert r.status_code == 200
    assert "<html" in r.text.lower()


def test_ui_files_are_revalidated():
    r = client.get("/js/app.js")
    assert r.headers["cache-control"] == "no-cache"
    assert client.get("/api/meta").json()["version"]


def test_search_and_lookup_use_the_builtin_dictionary():
    r = client.get("/api/search", params={"q": "nasdaq"}).json()["results"]
    assert r and r[0]["ticker"] in ("^NDX", "^IXIC", "QQQ")
    assert client.get("/api/search", params={"q": "אפל"}).json()["results"][0]["ticker"] == "AAPL"
    assert client.get("/api/search", params={"q": "spy"}).json()["results"][0]["ticker"] == "SPY"
    assert client.get("/api/lookup", params={"ticker": "^gspc"}).json()["name"] == "S&P 500"
    assert client.get("/api/lookup", params={"ticker": "ZZZZ9"}).json()["name"] is None


def test_solve_trace_reaches_the_target():
    body = client.post("/api/solve_trace", json={**PLAN, "solve_for": "monthly_deposit", "target_amount": 500_000}).json()
    assert body["converged"] and body["x"] > 0
    assert body["steps"][0]["phase"] == "start"
    assert abs(body["steps"][-1]["y"] - 500_000) < 1
    assert len(body["grid_x"]) == 60
    tri = {"stages": [{"months": 240, "rate": 4, "holdings": [{"ticker": "SPY", "weight": 100}]}],
           "start_amount": 1_000_000, "solve_for": "rate", "step": "M"}
    body = client.post("/api/trinity/solve_trace", json=tri).json()
    assert body["converged"] and 0 < body["x"] < 100
    assert client.post("/api/solve_trace", json=PLAN).status_code == 400     # nothing to solve


def test_realization_detail_endpoint():
    sim = client.post("/api/simulate", json=PLAN).json()
    start = sim["start_dates"][3]
    body = client.post("/api/realization", json={"plan": PLAN, "start_date": start}).json()
    assert body["start_date"] == start
    assert body["summary"]["final"] == pytest.approx(sim["final"][3], rel=1e-4)
    assert len([t for t in body["trades"] if t["kind"] == "buy"]) == 120 * 2
    assert body["has_fx"] and len(body["basket"]["dates"]) == len(body["basket"]["fx"])
    tri = {"stages": [{"months": 240, "rate": 4, "holdings": [{"ticker": "SPY", "weight": 100}]}], "currency": "USD"}
    sim = client.post("/api/trinity/simulate", json=tri).json()
    body = client.post("/api/trinity/realization", json={"plan": tri, "start_date": sim["start_dates"][0]}).json()
    assert body["trinity"] and body["summary"]["final"] == pytest.approx(sim["final"][0], rel=1e-4)


def test_benchmark_endpoint():
    sim = client.post("/api/simulate", json=PLAN).json()
    body = client.post("/api/realization/benchmark", json={"plan": PLAN, "start_date": sim["start_dates"][0], "rate": 0}).json()
    assert len(body["path"]) == 121 and body["final"] > 0
    assert len(body["path_gross"]) == 121 and body["final_gross"] >= body["final"]
