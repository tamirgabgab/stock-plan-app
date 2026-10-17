# 📈 Stock Plan App

**Historical back-testing of long-term investment plans, with an interactive web UI.**

Every historical start date is one *realization*: the plan is replayed from that date
and the app shows the distribution of outcomes — a fan chart over time, a histogram at
any point in time with "probability to land between A and B", the outcome by start
date, and every realization in a table. Hover any of them to see that path.

> ⚠️ For research and education only. Not investment advice.

---

## Quick start

**In the browser, nothing to install:**
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/tamirgabgab/stock-plan-app?quickstart=1)
— the link opens (or resumes) your codespace, updates it to the latest `main`, starts the
app and opens it in a new tab. Locally:

```bash
pip install -r requirements-local.txt
python run.py            # opens http://127.0.0.1:8000 in your browser
```

On Windows you can double-click `start.bat` (macOS/Linux: `./start.sh`).

No internet? `python run.py --demo` runs the UI on synthetic data (clearly marked in
the UI — it is not real market history).

---

## Features

- **Multi-stage plans** – each stage has its own duration, deposits and portfolio
  (any Yahoo ticker, weights, daily-rebalanced leverage).
- **Solve for the missing parameter** – final balance, required monthly deposit or
  required starting amount, for every start date.
- **Nominal or real** – real mode puts every input and result in today's money
  (CPI of the last data month); optional CPI-indexed deposits.
- **Currency** – USD or ILS. Assets are assumed to trade in USD; ILS converts every
  deposit and valuation at that day's USD/ILS rate.
- **Taxes** – capital-gains rate on nominal or real gains, tax-deferred or taxable
  stage switches, loss carry-forward (tax shield). Management fee and leverage cost.
- **Statistics** – median (bold), mean (dashed) and a p1–p2 percentile band over time;
  optional *representative paths* (the real realizations that ended at p1, the median
  and p2) and a percentile-rank-over-time chart for the hovered or pinned path;
  cross-section histogram with drag-to-select range probability, for the portfolio
  value, the solved variable or the max drawdown (of the strategy and of the account);
  IRR, portfolio CAGR; CSV export; share-by-link; light/dark theme.
- **Trinity (withdrawal) tab** – retirement plans with the same engine: fixed
  withdrawals (CPI-indexed by default), a fixed amount, or a percent of the current
  balance with floor/ceiling guardrails; one-time withdrawals; every withdrawal is a
  pro-rata sale with the tax grossed up. Solve for the final balance, the maximum
  fixed monthly withdrawal, the maximum withdrawal rate (of the start amount or of
  the balance) or the minimum starting amount. Success-rate heat map (withdrawal
  rate × horizon, survival or capital preservation), click a cell to load it.
- **Gross or net** – one switch shows the whole accumulation tab either as the market
  value of the holdings (gross, the default) or after the tax of selling everything (net).
- **Plan-year cohorts** – for every realization, the annual return (IRR) of each plan
  year's 12 deposits held to the end; the table shows the best and the worst year.
- **Realization detail** – click any start date in the table, or pick a date next to the
  outcome-by-start-date chart: the account value against the same plan at a fixed annual
  return p (same deposits or withdrawals, fees and tax), and the full trade journal: every
  buy and sell with date, price (and the USD quote in ILS mode), amount, the account value
  and the fixed-return comparison at that month, tax, and each purchase's return to exit,
  total and annualized. Next to it, the weighted basket of raw prices (weights as
  fractions, per stage; optionally times the USD/ILS rate) with the buy dates marked in
  red; both charts zoom with the wheel or a drag.
- **Pleasant to use** – resizable settings panel (charts follow its width), calendar date picker plus a
  timeline range slider for the test window, a name ↔ ticker picker (built-in
  dictionary with Hebrew aliases, Yahoo search for the rest), a one-click
  "raw stock price" preset (USD, nominal, no CPI).
- **Math tab** – every computation explained in text and LaTeX (KaTeX, offline): the
  difference equation of the portfolio, deposits, tax, the closed-form solution for the
  missing parameter where one exists and the numerical solver where it does not, plus
  the same equations with the current plan's numbers plugged in, and a live chart
  of the Illinois solver's steps on the current plan.
- **Apartment vs. capital market tab** – a deterministic month-by-month comparison with
  fixed parameters (no market history). One person (equity + a monthly budget, optionally
  CPI-indexed) and any number of scenarios: market portfolios (return, deposit fee,
  management fee, capital-gains tax on real or nominal gains) and apartments (price,
  single/additional apartment, LTV, a mortgage mix of tracks with term, rate, CPI-linking
  and Spitzer or equal-principal repayment, one-time costs, purchase tax by editable
  brackets, rent with growth, vacancy and the three Israeli rent-tax tracks, appreciation,
  maintenance, insurance, selling costs, mas shevach with the single-apartment exemption
  ceiling). The budget surplus or shortfall of an apartment goes to a side account in the
  market. Each line is the **net worth on realization** (assets minus liabilities after
  exit costs and taxes) over time. Metrics: final value, sum over all months, present
  value, discounted sum, IRR, crossing points. Solve any numeric parameter for the value
  at which two chosen scenarios are equivalent on a metric. The general equations and each
  scenario's equation with its numbers plugged in are shown in the tab.

## GitHub Codespaces

`.devcontainer/` sets up a codespace: dependencies are installed when it is created, and
every time it is opened `.devcontainer/start.sh` fast-forwards to the latest `main`,
restarts the app on port 8000 and the port opens in a browser tab. The link
`https://codespaces.new/tamirgabgab/stock-plan-app?quickstart=1` resumes an existing
codespace instead of creating a new one. Codespaces stop after 30 idle minutes; the
personal free quota is 120 core-hours a month (60 hours on the default 2-core machine).

## Hosting (Vercel, paused)

Automatic Vercel deployments are switched off (`"git": {"deploymentEnabled": false}` in
`vercel.json`); the setup is kept for reference and can be re-enabled there.

- `api/index.py` exposes the FastAPI app; `vercel.json` routes every path to it.
- Dependencies come from the `[project]` table in `pyproject.toml` (kept in step with
  `requirements.txt`). pyarrow is left out to fit the function size limit, so the cache
  falls back to pickle files; `requirements-local.txt` adds pyarrow for local installs.
- The cache lives in `/tmp` and is per instance, so a cold start downloads data again.
- Yahoo is probed once per instance; if it does not answer the app switches to demo data
  and the banner says so (`STOCKPLAN_DEMO_FALLBACK`, on by default when `VERCEL` is set).
- A data source that fails (timeout, blocked host) is skipped for an hour instead of being
  retried on every request. `/api/status` lists each source tried by the instance, with
  timing and errors; API responses carry a `Server-Timing` header.
- Responses are capped at 4.5 MB, so the hosted app allows fewer realizations × months
  (monthly sampling works; daily sampling over long histories needs the local app).

## Data sources

| Data | Source | Notes |
|---|---|---|
| Prices | Yahoo Finance (`yfinance`) | Dividend-adjusted closes, cached in `data_cache/` (Parquet, or pickle without pyarrow), refreshed incrementally |
| USD/ILS | Bank of Israel, Yahoo `ILS=X`, FRED monthly | First available source wins; FRED extends older history |
| US CPI | FRED `CPIAUCSL` | |
| Israel CPI | CBS API, FRED `ISRCPIALLMINMEI` | |

Put a CSV with columns `date,value` in `data_cache/manual/` (`fx_usd_ils.csv`,
`cpi_us.csv`, `cpi_il.csv`) to override any series.

## Project structure

```
run.py                 # launcher (FastAPI + browser)
api/index.py           # Vercel entry point (vercel.json routes everything here)
stockplan/
  data/                # market data providers + disk cache (Yahoo, demo)
  engine/              # pure numpy simulation engine and solvers
    property.py        # apartment vs. capital market model (fixed parameters)
  api.py               # FastAPI endpoints, serves the web UI
  web/                 # static UI: Preact + htm + Plotly + KaTeX (vendored, no build step)
tests/                 # pytest: engine and API
legacy/                # the previous Streamlit app (kept for reference)
```

## Development

```bash
pip install -r requirements-dev.txt
python -m pytest
```

The previous Streamlit version is kept in `legacy/` for reference (`streamlit run
legacy/main.py`, requirements in `legacy/requirements.txt`); it is no longer maintained.

See [HANDOFF.md](HANDOFF.md) for design notes, the engine model and the roadmap.

## Author

**Tamir Gabgab** — [GitHub](https://github.com/tamirgabgab)
