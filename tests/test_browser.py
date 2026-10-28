"""The web UI in a real (headless) browser, on demo data: every tab loads and computes
without a JavaScript error, the account settings run, and the phone layout's "to the
results" button works. Skipped when Playwright is not installed (the CI "web" job installs it).
"""
from __future__ import annotations

import socket
import threading
import time

import pytest

sync_api = pytest.importorskip("playwright.sync_api")

import stockplan.data as data_mod  # noqa: E402
import uvicorn  # noqa: E402
from stockplan.api import app  # noqa: E402
from stockplan.data import DemoMarketData  # noqa: E402


@pytest.fixture(scope="module")
def server():
    old = data_mod._provider
    data_mod._provider = DemoMarketData(end="2026-01-01")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}/"
    srv.should_exit = True
    thread.join(timeout=5)
    data_mod._provider = old


@pytest.fixture(scope="module")
def browser():
    with sync_api.sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


def open_page(browser, url, **kw):
    page = browser.new_page(**kw)
    errors = []
    page.on("pageerror", lambda e: errors.append(f"page error: {e}"))
    page.on("console", lambda m: errors.append(f"console: {m.text}") if m.type == "error" else None)
    page.goto(url)
    page.wait_for_selector("#app .topbar")
    return page, errors


def settle(page, what):
    """Wait for the auto-run to start and finish, then fail on an error callout."""
    page.wait_for_timeout(900)                      # the auto-run waits 700 ms after a change
    page.wait_for_selector(".main .busy", state="detached", timeout=60_000)
    err = page.locator(".main .callout.error")
    assert err.count() == 0, f"{what}: {err.first.inner_text()}"


def click_option(page, label):
    page.get_by_role("radio", name=label, exact=True).first.click()


def test_every_tab_runs(server, browser):
    page, errors = open_page(browser, server)
    page.evaluate("localStorage.clear()")
    page.reload()
    page.wait_for_selector("#app .topbar")
    settle(page, "accumulation")
    page.wait_for_selector(".main .card")

    for account in ("קרן השתלמות", "גמל להשקעה", "תיק רגיל"):
        click_option(page, account)
        settle(page, account)

    for tab in ("טריניטי (משיכות)", "דירה נגד שוק ההון", "הסבר מתמטי", "צבירה"):
        page.get_by_role("button", name=tab, exact=True).click()
        settle(page, tab)
        page.wait_for_selector(".main .card, .main section, .main .math", timeout=60_000)
    assert not errors, "\n".join(errors)
    page.close()


def test_phone_button_scrolls_to_the_results(server, browser):
    page, errors = open_page(browser, server, viewport={"width": 390, "height": 844})
    settle(page, "phone")
    button = page.locator(".to-results")
    button.wait_for(state="visible")
    button.click()
    page.wait_for_function("document.querySelector('.main').getBoundingClientRect().top < 200")
    button.wait_for(state="detached")
    assert not errors, "\n".join(errors)
    page.close()
