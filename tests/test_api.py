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
