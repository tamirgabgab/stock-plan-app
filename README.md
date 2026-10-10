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
- **Nominal or real** – values in money of the start date (CPI-deflated); optional
  CPI-indexed deposits.
- **Currency** – USD or ILS. Assets are assumed to trade in USD; ILS converts every
  deposit and valuation at that day's USD/ILS rate.
- **Taxes** – capital-gains rate on nominal or real gains, tax-deferred or taxable
  stage switches, loss carry-forward (tax shield). Management fee and leverage cost.
- **Statistics** – median (bold), mean (dashed) and a p1–p2 percentile band over time;
  cross-section histogram with drag-to-select range probability; IRR, portfolio CAGR,
  max drawdown; CSV export; share-by-link; light/dark theme.

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
  web/                 # static UI: Preact + htm + Plotly (vendored, no build step)
tests/                 # pytest: engine and API
legacy/                # the previous Streamlit app (still has the Trinity tab)
```

## Development

```bash
pip install -r requirements-dev.txt
python -m pytest
```

The previous Streamlit version still runs with `streamlit run legacy/main.py`
(requirements in `legacy/requirements.txt`).

See [HANDOFF.md](HANDOFF.md) for design notes, the engine model and the roadmap.

## Author

**Tamir Gabgab** — [GitHub](https://github.com/tamirgabgab)
