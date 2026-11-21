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


def test_installable_on_a_phone_home_screen():
    """The page links a web app manifest whose icons are served at their stated sizes."""
    import re
    import struct

    from fastapi.testclient import TestClient

    from stockplan.api import app

    client = TestClient(app)

    def png_size(path):
        body = client.get("/" + path).content
        assert body[:8] == b"\x89PNG\r\n\x1a\n"
        return struct.unpack(">II", body[16:24])

    page = client.get("/").text
    href = re.search(r'<link rel="manifest" href="([^"]+)"', page).group(1)
    assert 'rel="apple-touch-icon"' in page
    r = client.get("/" + href)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/manifest+json")
    manifest = r.json()
    assert manifest["display"] == "standalone" and manifest["start_url"]
    purposes = set()
    for icon in manifest["icons"]:
        assert "%dx%d" % png_size(icon["src"]) == icon["sizes"]
        purposes.add((icon["sizes"], icon["purpose"]))
    assert {("192x192", "any"), ("512x512", "any"), ("512x512", "maskable")} <= purposes
    apple = re.search(r'<link rel="apple-touch-icon" href="([^"]+)"', page).group(1)
    assert png_size(apple) == (180, 180)


def test_fred_gives_up_sooner_than_other_sources(monkeypatch):
    seen = {}

    def fake_get(url, timeout, headers):
        seen[url] = timeout
        raise yahoo.requests.ConnectionError("timed out")

    monkeypatch.setattr(yahoo.requests, "get", fake_get)
    with pytest.raises(yahoo.requests.ConnectionError):
        yahoo._fred_series("CPIAUCSL")
    with pytest.raises(yahoo.requests.ConnectionError):
        yahoo._http_get(yahoo.BOI_USD_ILS_URL)
    fred = seen[yahoo.FRED_CSV_URL.format(series="CPIAUCSL")]
    assert sum(fred) < sum(seen[yahoo.BOI_USD_ILS_URL]) and fred[1] <= 6


def test_concurrent_first_requests_probe_yahoo_once(fresh_provider, monkeypatch):
    """Two requests racing on a cold instance once left real data labelled as the demo fallback."""
    import threading
    import time

    monkeypatch.setenv("STOCKPLAN_DEMO_FALLBACK", "1")
    answers = iter([False, True, True, True, True, True, True, True])
    probes = []

    def reachable(self):
        probes.append(1)
        time.sleep(0.05)
        return next(answers)

    monkeypatch.setattr(yahoo.YahooMarketData, "reachable", reachable)
    threads = [threading.Thread(target=data.get_market_data) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(probes) == 1
    assert data.get_market_data().is_demo == (data.demo_reason() == "fallback")
