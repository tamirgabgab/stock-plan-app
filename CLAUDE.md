# CLAUDE.md

Working instructions for Claude Code sessions in this repository. Read
[HANDOFF.md](HANDOFF.md) first: it describes the code layout, every model and the roadmap
(in Hebrew).

## Special instructions from the owner

None yet. Add them here.

## Commands

```bash
pip install -r requirements-dev.txt     # tests (local installs: requirements-local.txt adds pyarrow)
python -m pytest                        # the whole suite; must pass before every push
python run.py --demo                    # the app on synthetic data, no internet needed
STOCKPLAN_DEMO=1 python -m uvicorn stockplan.api:app --port 8765   # headless server for browser checks
```

Cloud sessions usually cannot reach Yahoo, FRED, CBS or the Bank of Israel, so check the
UI on demo data (the UI shows a banner) and say so when reporting.

## Conventions

- **Version:** bump `__version__` in `stockplan/__init__.py` and the `?v=` query strings in
  `stockplan/web/index.html` with every change the user will see.
- **Docs:** every feature updates `README.md` (English) and `HANDOFF.md` (Hebrew), including
  the test count in HANDOFF section 8 and the roadmap in section 7.
- **UI:** Hebrew, right-to-left. Preact + htm, Plotly and KaTeX are vendored in
  `stockplan/web/vendor/`; there is no build step. Chart colours come from the CSS
  variables in `styles.css` (light and dark themes).
- **Engine:** numpy, no web code. The apartment tab's simulator
  (`stockplan/engine/property.py`) is vectorized: keep new code broadcast-safe (numpy ops,
  no Python `max`/`if` on values that may be arrays), because the solver passes parameters
  as arrays.
- **Tests:** new behaviour gets a pytest test, preferably against a closed form.
- **Check the UI in a browser** (headless Chromium is available in cloud sessions) before
  reporting UI work as done.
