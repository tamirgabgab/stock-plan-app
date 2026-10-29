"""The web UI in a real (headless) browser, on demo data: every tab loads and computes
without a JavaScript error, the account settings and the synthetic scenarios run (with a
path's detail view), and the phone layout's "to the results" button works. Skipped when Playwright is not installed (the CI "web" job installs it).
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

    # Synthetic paths: the table lists paths, and a path's detail opens.
    click_option(page, "מסלולים סינתטיים")
    settle(page, "synthetic")
    table = page.locator("section.card", has_text="כל הריאליזציות").locator("tbody tr")
    table.first.click()
    page.wait_for_selector(".modal .journal", timeout=60_000)
    page.keyboard.press("Escape")
    click_option(page, "תאריכים היסטוריים")
    settle(page, "history again")

    for tab in ("טריניטי (משיכות)", "דירה נגד שוק ההון", "הסבר מתמטי", "צבירה"):
        page.get_by_role("button", name=tab, exact=True).click()
        settle(page, tab)
        page.wait_for_selector(".main .card, .main section, .main .math", timeout=60_000)
        if tab.startswith("טריניטי"):
            click_option(page, "מסלולים סינתטיים")
            settle(page, "Trinity synthetic")
            click_option(page, "תאריכים היסטוריים")
            settle(page, "Trinity history")
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


def test_ab_comparison(server, browser):
    # Plan B doubles the deposit: the card pairs the same start dates and B wins in all of them.
    page, errors = open_page(browser, server)
    page.evaluate("localStorage.clear()")
    page.reload()
    page.wait_for_selector("#app .topbar")
    settle(page, "accumulation")
    page.get_by_text("השוואה בין שתי תוכניות (A/B)").click()
    settle(page, "A/B on")
    click_option(page, "תוכנית B")
    deposit = page.locator(".stage-card").first.locator("input[type=number]").nth(2)
    deposit.fill("2000")
    deposit.press("Tab")
    settle(page, "plan B")
    card = page.locator("section.compare")
    card.get_by_text("תרחישים משותפים").first.wait_for()
    assert "0.0%" in card.locator(".compare-big").inner_text()
    assert not errors, "\n".join(errors)
    page.close()


def test_retirement_settings(server, browser):
    # The 55-year example on synthetic paths, with an age, a pension, then Guyton-Klinger
    # and VPW: the age axis, the sequence-risk card, and no errors.
    page, errors = open_page(browser, server)
    page.evaluate("localStorage.clear()")
    page.reload()
    page.wait_for_selector("#app .topbar")
    settle(page, "accumulation")
    page.get_by_role("button", name="תוכנית פרישה לדוגמה").click()
    click_option(page, "מסלולים סינתטיים")
    settle(page, "retirement example")
    section = page.locator("details.section", has_text="גיל והכנסות")
    age = section.locator("input[type=number]").first
    age.fill("40")
    age.press("Tab")
    section.get_by_role("button", name="+ הוסף הכנסה").click()
    settle(page, "age and pension")
    stage = page.locator(".stage-card.withdraw")
    for method in ("Guyton-Klinger", "VPW"):
        stage.get_by_role("radio", name=method).click()
        settle(page, method)
    page.locator("section.card", has_text="סיכון הסדר").wait_for()
    assert "גיל" in page.locator("section.card", has_text="שווי התיק לאורך זמן").inner_text()
    assert not errors, "\n".join(errors)
    page.close()


def test_report(server, browser):
    # The printable report opens with its charts and prints to a PDF.
    page, errors = open_page(browser, server)
    page.evaluate("localStorage.clear()")
    page.reload()
    page.wait_for_selector("#app .topbar")
    settle(page, "accumulation")
    page.get_by_role("button", name="דוח", exact=True).click()
    page.wait_for_selector(".report-root .report-plot .main-svg", timeout=30_000)
    assert "ההגדרות" in page.locator(".report").inner_text()
    page.emulate_media(media="print")
    assert len(page.pdf(format="A4")) > 10_000
    page.emulate_media(media="screen")
    page.keyboard.press("Escape")
    assert page.locator(".report-root").count() == 0
    assert not errors, "\n".join(errors)
    page.close()
