"""Apartment and capital market: a month-by-month model on fixed parameters or on history.

Every scenario starts from the same person: an equity ``E0`` at month 0 and a monthly budget
``B_m`` for months 1..T, and splits the equity: ``alloc`` percent goes to an apartment and the
rest to a market account. With ``alloc = 0`` the scenario is market only: the account gets the
whole equity and the budget. Otherwise the apartment is bought at month 0 (purchase tax and
one-time costs come out of the apartment's share, the rest of that share is the down payment
and the rest of the price is the mortgage); the mortgage tracks and the running costs are paid
from the budget, the rent comes in, and whatever is left over (or missing) goes to the market
account (the *side account*).

``check_common`` and ``check_scenario`` reject inputs that cannot happen (the apartment's share
does not cover the purchase tax and costs, or is more than the apartment costs, a mortgage mix
that does not add up to 100%, a budget that does not cover the first month...) and warn about
unlikely ones.

The value of a scenario at month t is its **net worth on realization**: everything sold at t,
after selling costs, early-repayment fees, capital-gains tax (side account / portfolio) and
betterment tax (mas shevach), minus every outstanding liability.

Two modes share one simulator:

* **fixed**: one row; CPI, appreciation, rent growth, market returns and the Bank of Israel
  rate path come from the parameters.
* **history**: one row per start date (a realization). Each series switched to history
  (market prices, CPI, the housing price index, the rent index, the Bank of Israel rate) is a
  ``(R, T+1)`` path from ``property_data.build_paths``; the others stay on the parameters.

The simulator is vectorized: every state variable is an array, and any parameter may be an
array too. That is what makes the break-even solver cheap: all the points of a scan run as
rows of one simulation, and each realization can carry its own trial value.

Conventions (all rates are annual, in percent, as entered):

* CPI ``C_m`` is relative to the start (``C_0 = 1``); in fixed mode ``C_m = (1 + pi)^(m/12)``.
  A monthly amount entered "today" is paid at month m as ``amount * index_{m-1}``, so the
  first payment is exactly the entered amount.
* Money inputs are in the money of the start date. In history mode that means "today's money
  carried back": the real view divides by ``C_t`` (today's money again), the nominal view
  multiplies by ``CPI(start) / CPI(last)`` (the shekels of that time).
* Mortgage: monthly rate ``r/12`` (the Israeli convention), payment at the end of each month,
  recomputed on the balance and the remaining term whenever the rate changes. A CPI-linked
  track's balance is indexed every month.
* Market: monthly growth ``(1 + R)^(1/12)`` (or the portfolio's historical monthly return,
  rebalanced monthly to its weights) and management fee ``(1 - f)^(1/12)``; a deposit fee is
  taken off each deposit. Tax on gains only, on nominal or CPI-indexed cost basis.
"""
from __future__ import annotations

from .inputs import PURCHASE_SINGLE, PURCHASE_ADDITIONAL, SHEVACH_SINGLE_CEILING, RENT_EXEMPT_CEILING, DEFAULT_HOLDINGS, Bracket, _brackets, TaxTables, HoldingP, MarketParams, RatePoint, Track, Cost, Scenario, HistoryFlags, SYN_SERIES, DEFAULT_CORR, SyntheticParams, Common, PropertyRequest  # noqa: F401
from .paths import _g, _sorted_brackets, bracket_tax, purchase_tax_rows, annuity, months_of, schedule_at, holdings_key, Paths, fixed_paths, corr_matrix, MAX_SYN_CELLS, synthetic_paths  # noqa: F401
from .simulate import Account, simulate, _stack, _rows  # noqa: F401
from .checks import Issue, InputError, _ils, _issue, check_common, alloc_bounds, check_scenario, check_result  # noqa: F401
from .metrics import METRICS, irr_monthly, _irr_vec, display, metrics, run_property, simulate_scenario, _first_row, row_of  # noqa: F401
from .solve import STATS, _param_path, _with, _stat, _crossings, _interp_root, solve_equal, __all__  # noqa: F401
