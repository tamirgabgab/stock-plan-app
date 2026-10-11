"""Hosted-build behaviour: pickle cache without pyarrow, and the demo fallback."""
import pandas as pd
import pytest

import stockplan.data as data
from stockplan.data import yahoo


def test_cache_roundtrip_without_pyarrow(tmp_path, monkeypatch):
    monkeypatch.setattr(yahoo, "CACHE_EXT", ".pkl")
    cache = yahoo._DiskCache(tmp_path)
    s = pd.Series([1.0, 2.5], index=pd.to_datetime(["2020-01-01", "2020-01-02"]))
    cache.save("prices", "SPY", s)
    assert cache.path("prices", "SPY").suffix == ".pkl"
    loaded, age = cache.load("prices", "SPY")
    pd.testing.assert_series_equal(loaded, s, check_names=False)
    assert age < 1


@pytest.fixture
def fresh_provider(monkeypatch):
    monkeypatch.delenv("STOCKPLAN_DEMO", raising=False)
    monkeypatch.setattr(data, "_provider", None)
    monkeypatch.setattr(data, "_demo_reason", None)
    yield


def test_falls_back_to_demo_when_yahoo_unreachable(fresh_provider, monkeypatch):
    monkeypatch.setenv("STOCKPLAN_DEMO_FALLBACK", "1")
    monkeypatch.setattr(yahoo.YahooMarketData, "reachable", lambda self: False)
    assert data.get_market_data().is_demo
    assert data.demo_reason() == "fallback"


def test_keeps_yahoo_when_reachable(fresh_provider, monkeypatch):
    monkeypatch.setenv("STOCKPLAN_DEMO_FALLBACK", "1")
    monkeypatch.setattr(yahoo.YahooMarketData, "reachable", lambda self: True)
    assert not data.get_market_data().is_demo
    assert data.demo_reason() is None


def test_no_probe_without_fallback_flag(fresh_provider, monkeypatch):
    monkeypatch.setenv("STOCKPLAN_DEMO_FALLBACK", "0")
    monkeypatch.setattr(yahoo.YahooMarketData, "reachable",
                        lambda self: pytest.fail("must not probe"))
    assert not data.get_market_data().is_demo


def test_failed_source_is_skipped_for_a_while(tmp_path):
    md = yahoo.YahooMarketData(cache_root=tmp_path)
    calls = []

    def boom():
        calls.append(1)
        raise ConnectionError("timed out")

    for _ in range(3):
        with pytest.raises(Exception):
            md._attempt("FRED (x)", boom)
    assert len(calls) == 1                          # tried once, then skipped
    assert md.sources["FRED (x)"]["ok"] is False


def test_unknown_ticker_is_not_remembered(tmp_path):
    md = yahoo.YahooMarketData(cache_root=tmp_path)
    calls = []

    def missing():
        calls.append(1)
        raise data.DataError("no such ticker")

    for _ in range(2):
        with pytest.raises(data.DataError):
            md._attempt("Yahoo XYZ", missing, remember_data_errors=False)
    assert len(calls) == 2


def test_status_endpoint(monkeypatch):
    from fastapi.testclient import TestClient
    monkeypatch.setattr(data, "_provider", data.DemoMarketData(end="2026-01-01"))
    from stockplan.api import app
    r = TestClient(app).get("/api/status")
    assert r.status_code == 200 and "sources" in r.json()
