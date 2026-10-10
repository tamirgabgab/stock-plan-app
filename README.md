# 📈 Stock Plan App

**Historical back-testing of long-term investment plans, with an interactive web UI.**

Every historical start date is one *realization*: the plan is replayed from that date
and the app shows the distribution of outcomes — a fan chart over time, a histogram at
any point in time with "probability to land between A and B", the outcome by start
date, and every realization in a table. Hover any of them to see that path.

> ⚠️ For research and education only. Not investment advice.

---

## Quick start

```bash
pip install -r requirements.txt
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
  withdrawal rate or the minimum starting amount. Success-rate heat map (withdrawal
  rate × horizon, survival or capital preservation), click a cell to load it.
- **Realization detail** – open any start date (table, double-click or the pinned
  path) for its full trade journal: every buy and sell with date, price (and the USD
  quote in ILS mode), amount, units, tax, and each purchase's return to exit, total and
  annualized. Next to it, the weighted basket of raw prices (weights as fractions, per
  stage; optionally times the USD/ILS rate) with the buy dates marked in red.
- **Pleasant to use** – resizable settings panel (charts follow its width), calendar date picker plus a
  timeline range slider for the test window, a name ↔ ticker picker (built-in
  dictionary with Hebrew aliases, Yahoo search for the rest), a one-click
  "raw stock price" preset (USD, nominal, no CPI).
- **Math tab** – every computation explained in text and LaTeX (KaTeX, offline): the
  difference equation of the portfolio, deposits, tax, the closed-form solution for the
  missing parameter where one exists and the numerical solver where it does not, plus
  the same equations with the current plan's numbers plugged in, and a live chart
  of the Illinois solver's steps on the current plan.

## Data sources

| Data | Source | Notes |
|---|---|---|
| Prices | Yahoo Finance (`yfinance`) | Dividend-adjusted closes, cached as Parquet in `data_cache/`, refreshed incrementally |
| USD/ILS | Bank of Israel, Yahoo `ILS=X`, FRED monthly | First available source wins; FRED extends older history |
| US CPI | FRED `CPIAUCSL` | |
| Israel CPI | CBS API, FRED `ISRCPIALLMINMEI` | |

Put a CSV with columns `date,value` in `data_cache/manual/` (`fx_usd_ils.csv`,
`cpi_us.csv`, `cpi_il.csv`) to override any series.

## Project structure

```
run.py                 # launcher (FastAPI + browser)
stockplan/
  data/                # market data providers + disk cache (Yahoo, demo)
  engine/              # pure numpy simulation engine and solvers
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
