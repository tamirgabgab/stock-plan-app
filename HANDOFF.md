# HANDOFF — Stock Plan App

_Last reviewed: 2026-10-10_

This document is a technical handoff: what the app does today, how the code is
organized, known issues found during review, and a proposed upgrade path away
from Streamlit toward a more interactive web platform.

---

## 1. What the app does

A Hebrew (RTL) Streamlit web app for **historical back-testing of long-term
investment plans**. Instead of assuming a fixed annual return, it replays a plan
over *every* historical start date in a chosen range (sampled every `N` days) and
shows the **distribution** of outcomes.

It has two tabs:

### Tab 1 — "סטטיקה של השקעות" (accumulation / savings plan)

- The user builds one or more **stages** ("plans"), executed back to back. Each
  stage has: initial deposit, monthly deposit, number of months, and a portfolio
  table (asset, weight %, leverage factor).
- Global inputs: starting balance, target balance, capital-gains tax %, and
  whether switching between stages triggers a tax event.
- **Solve-for mode** — the user picks one unknown:
  - `סכום סופי` final balance (direct simulation),
  - `הפקדה חודשית` required monthly deposit to hit the target,
  - `סכום התחלתי` required starting balance to hit the target.
  The unknown is solved per start date with `scipy.optimize.fsolve`.
- For each start date it also solves the **equivalent annual return** (the
  constant yearly rate that would produce the same final balance — an IRR).
- Output: summary metrics (avg deposits, avg return, mean, median, min/max with
  their date ranges), a histogram with mean/median lines, a range slider that
  highlights a band and reports how many samples fall in it plus the matching
  return range, and a table of every historical window.

### Tab 2 — "מחקר טריניטי" (decumulation / retirement withdrawals)

- Inspired by the Trinity Study / 4% rule.
- Each stage has: initial withdrawal %, annual withdrawal %, number of months,
  withdrawal base (`התחלתי` = % of the original amount, i.e. fixed nominal
  withdrawal; `נוכחי` = % of current balance), and a portfolio table.
- Solve-for mode: final balance, sustainable withdrawal %, or required starting
  amount.
- Output: same histogram / metrics / table layout as Tab 1.

### Data

- ~110 hard-coded tickers in `params.py` (US indices, mega-caps, semis, Israeli
  stocks/indices, crypto, bonds, commodities).
- Daily `Close` prices are pulled from Yahoo Finance via `yfinance`
  (`history(period="max")`), forward-filled to a calendar-day grid.
- Leverage is simulated by multiplying **daily** returns by the factor
  (floored at −100%), i.e. a daily-rebalanced leveraged product.

---

## 2. Code map

| File | Lines | Role |
|---|---|---|
| `main.py` | 34 | Entry point. Self-launches `streamlit run` when executed with `python main.py`; sets page config, injects CSS, renders the two tabs. |
| `params.py` | 442 | Ticker list, ~350 lines of CSS overrides for Streamlit internals, Hebrew labels, `st.column_config` table schemas, defaults. |
| `utils.py` | 569 | Simulation engine: data download, date-grid construction, leverage, the two simulators, initial guesses for the solver, return-range solver. |
| `stock_statistics.py` | 376 | UI for Tab 1 (inputs, stage editor, results). |
| `stock_trinity.py` | 377 | UI for Tab 2. Largely a copy of Tab 1 with `trin_` prefixes. |
| `.devcontainer/` | | Codespaces config; auto-runs Streamlit on port 8501. |

### Engine flow (`utils.py`)

1. `calculate_date_range()` downloads every ticker, builds a daily index,
   generates the array of start dates (`pd.date_range(..., freq=f'{res}D')`),
   and precomputes a matrix `all_dates_map[start_idx, month_offset]` of price
   indices for each monthly step. It also builds `lev_np_dict` — leveraged price
   series keyed by `"{asset}_{leverage}"`.
2. `calculate_portfolot_stats()` / `calculate_trinity_withdraw_stats()` loop over
   start dates; per date they call an inner simulator, wrapped in `fsolve` when
   solving for an unknown, and again to get the equivalent annual return.
3. `calculate_ann_gain_limits()` maps the slider band back to a return range.

All heavy functions are wrapped in `@st.cache_data`.

---

## 3. Known issues found during review

Ordered by impact. Line numbers refer to the current `main` state.

### Correctness

1. **Multi-stage accumulation uses the wrong prices.** In
   `calculate_portfolot_stats.sim_one_date` (`utils.py:58`) `month_offset` is
   never advanced after a stage, so every stage after the first is priced on
   the first stage's months. Results for any plan with 2+ stages are wrong.
   (The Trinity simulator does advance it, `utils.py:414`.)
2. **Tax shield never accumulates.** `sheild_tax` starts at 0 and is only ever
   decreased (`utils.py:59,99-103`, same in `calculate_ann_gain_limits`).
   Losses are never carried forward, so the "tax shield carry-over" feature in
   the README does not work.
3. **Deferred gains escape tax.** When a stage rolls into the next without a
   tax event, the rolled balance becomes the new cost basis
   (`start_deposit = final_money + ...`), so gains from earlier stages are never
   taxed — not even at the final sale.
4. **Trinity ignores tax.** `gain_tax` is accepted by
   `calculate_trinity_withdraw_stats` but never used.
5. **Trinity over-counts withdrawals.** `tot_withdraw += relative_withdraw`
   adds the requested amount even when the balance was too small to pay it.
6. **Trinity index mismatch on solver failure.** On a failed `fsolve` the loop
   `continue`s, so `x_opt_list` becomes shorter than `start_date_arr` and the
   min/max date ranges point to the wrong windows.
7. **Wrong unit selector key in Trinity.** `stock_trinity.py:285` reads
   `"unit_selector"` (Tab 1's key) instead of `"trin_unit_selector"`.
8. **Price index, not total return.** `^GSPC`, `^NDX`, etc. exclude dividends,
   and `Close` is used rather than adjusted close. This understates long-run
   returns by roughly 1.5–2% per year for US indices.
9. **Currency mix.** Everything is displayed in ₪, but US assets are priced in
   USD and `.TA` tickers in agorot; there is no FX conversion.
10. **Inconsistent rebalancing model.** Tab 1 is buy-and-hold per deposit
    within a stage; Tab 2 rebalances monthly (`np.dot(weights, gains)`).
11. **Leverage has no cost.** No borrowing cost / expense ratio, so leveraged
    results are optimistic.

### Robustness / UX

- `min_start_date` is undefined if the date range is invalid, so pressing
  "run" raises `NameError` (`stock_statistics.py:146-155`).
- With 2+ invalid stages (0 months) the error is shown but `st.stop()` is not
  called, so the simulation still runs.
- Zero total weight in a stage → division by zero.
- `calculate_ann_gain_limits` divides by `max_val - min_val` (zero when all
  outcomes are equal).
- `st.progress` is called inside `@st.cache_data` functions (side effects in
  cached code; Streamlit warns about it).
- `get_stock_dates_bounds` triggers `st.rerun()` whenever the bounds change,
  causing double renders.
- Every run re-downloads full price history from Yahoo; no persistent cache.
- Run time scales as `start_dates × fsolve iterations × stages`, all in Python
  loops — slow at fine resolutions.
- The devcontainer disables CORS and XSRF protection.
- ~350 lines of CSS target Streamlit's private `data-testid` selectors; these
  break on Streamlit upgrades. The CSS also contains duplicated rules.

### Maintainability

- Tabs 1 and 2 duplicate ~70% of their code (plan CRUD, editor sync,
  histogram, metrics).
- Data is passed as dicts keyed by Hebrew strings (`'הרכב התיק'`,
  `'מספר חודשים'`), mixing UI labels with domain logic.
- Engine imports `streamlit`, so it cannot be reused or unit-tested outside
  Streamlit.
- No tests, no linting, no type checks, no pinned dependency versions.
- Commit history is all "Update X.py"; no branches/PRs.

---

## 4. Upgrade proposal

### 4.1 Recommended architecture

Split the app into a **pure Python engine + API** and a **modern web frontend**.

```
┌──────────────────────────┐        ┌───────────────────────────────┐
│  Frontend (Next.js/React)│  JSON  │  Backend (FastAPI, Python)    │
│  TypeScript, Tailwind,   │◄──────►│  engine/ (pure numpy, tested) │
│  shadcn/ui, RTL Hebrew   │        │  data/   (prices, FX, CPI)    │
│  Charts: ECharts/Plotly  │        │  cache:  Parquet / Postgres   │
└──────────────────────────┘        └───────────────────────────────┘
        Vercel                          Render / Fly.io / Railway
```

Why this split:

- The numeric engine stays in Python (numpy/pandas are the right tools and the
  existing logic is reused), but becomes UI-free and testable.
- The UI moves to React, which gives real interactivity: instant recompute on
  input change, drag-and-drop, brushing on charts, URL-shareable state, proper
  RTL, dark mode, mobile layout — none of which Streamlit does well.

**Alternatives considered**

| Option | Pros | Cons |
|---|---|---|
| **FastAPI + Next.js** (recommended) | Full UI freedom, fast, scalable, deploys well | Two codebases, needs some TypeScript |
| Port engine to TypeScript, run in browser (Web Worker) + thin data proxy | Zero-latency sliders, cheap hosting | Rewriting/validating the math in TS |
| NiceGUI / Reflex (Python-only) | Single language, quick migration | Smaller ecosystems, still framework-bound UI |
| Plotly Dash | Mature, Python, good charts | Callback model gets heavy; UI still limited |

A good middle path: keep the engine in Python, and once results are returned,
do the cheap interactive parts (histogram binning, range selection,
percentiles) in the browser so sliders feel instant.

### 4.2 Engine improvements (do first — they are independent of the UI)

1. Extract `engine/` with typed dataclasses (`Stage`, `Holding`, `Plan`,
   `SimulationResult`) and English field names; no Streamlit imports.
2. Fix the correctness issues in §3 and add regression tests (pytest) with
   small synthetic price series where the answer is known analytically.
3. **Vectorize across start dates**: simulate all windows at once as a numpy
   matrix instead of a Python loop.
4. **Replace `fsolve`**: final balance is linear in starting amount and monthly
   deposit (piecewise-linear once tax is included), so those unknowns can be
   solved in closed form or with a bracketed root finder (`brentq`), which is
   faster and never "fails to converge". Same for the IRR.
5. Use **total-return data** (adjusted close / dividends) and add **FX
   conversion** to ILS (`USDILS=X`) as an option.
6. Add **inflation (CPI) adjustment** — real vs nominal results; Israeli
   capital-gains tax is on *real* gains.
7. Add **management fees** and **leverage borrowing cost**.
8. Unify the rebalancing model and make it a user option (none / monthly /
   yearly / threshold).
9. Persistent **price cache** (Parquet files or Postgres/Supabase table),
   refreshed daily, instead of downloading full history on every run.

### 4.3 New interactive features

- **Live recompute** — no "run" button; results update as inputs change
  (debounced), with a skeleton loader.
- **Timeline stage builder** — stages shown as blocks on a time axis; drag to
  reorder, resize to change duration.
- **Asset search** — any Yahoo ticker with autocomplete, not only the
  hard-coded list; weight sliders that auto-normalize to 100%; pie preview.
- **Fan chart** — balance over time with 10/25/50/75/90 percentile bands.
- **Success-rate heatmap** (Trinity) — withdrawal rate × duration → % of
  windows that did not run out of money.
- **Histogram with brushing** — drag to select a band; linked table and
  metrics update.
- **Click a historical window** to see its full path, drawdowns and the
  market events in that period.
- **Scenario comparison** — save scenarios and overlay them side by side.
- **Share via URL** and **export** (CSV / PDF report).
- **Monte Carlo / bootstrap** mode alongside pure historical replay.
- Dark mode, mobile layout, Hebrew RTL done properly (with an English toggle).

### 4.4 Suggested phased plan

| Phase | Scope | Outcome |
|---|---|---|
| 0 | Pin deps, add ruff + pytest + CI | Safety net |
| 1 | Extract engine, fix §3 bugs, tests, vectorize | Correct, fast core (still usable from Streamlit) |
| 2 | FastAPI endpoints + price cache | Backend ready |
| 3 | Next.js frontend: Tab 1 parity, then Tab 2 | New UI replaces Streamlit |
| 4 | New features (fan chart, heatmap, scenarios, sharing, inflation, FX) | Upgrade |
| 5 | Deploy (Vercel + Render/Fly), optional auth to save scenarios | Production |

---

## 5. Running the current app

```bash
pip install -r requirements.txt
python main.py          # or: streamlit run main.py
```

Opens at `http://localhost:8501`. Requires internet access to Yahoo Finance.

## 6. Open questions for the owner

- Should results be in ILS (with FX conversion) or in each asset's native
  currency?
- Nominal or inflation-adjusted (real) results by default?
- Is a Python backend acceptable to host (Render/Fly), or should everything run
  client-side + serverless?
- Any need for user accounts / saved scenarios, or is URL sharing enough?
- Should the hard-coded ticker list remain as "favorites" alongside free search?
