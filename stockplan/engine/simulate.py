"""Vectorized accumulation simulator.

All realizations (start dates) are simulated at once: the state is a matrix of shape
(R, A) — realizations × assets — and the only Python loop is over months.

Per month m the order is: stage transition (if a new stage starts) or a periodic rebalance,
withdrawal events, deposits, the withdrawal of a withdrawal stage, record the path point,
then market growth to month m+1. Within
a stage each deposit is split by the stage weights and held, unless the plan rebalances back
to the weights (monthly, quarterly, annually or when a weight drifts past a band). A stage
transition or a rebalance is either tax-free (cost basis carried over, so the tax is
deferred to the end) or a taxable sale of the holdings that shrink.

The deposit schedule: the periodic deposit is paid every ``deposit_every`` months from each
stage start, rises by ``deposit_growth`` percent every plan year, and is skipped during a
pause event. One-off deposit and withdrawal events are added on top. The start amount can be
spread over ``lump_spread`` months: it leaves the investor at month 0, waits as cash earning
``cash_rate`` (taxed), and is invested in equal parts of what is left.

Withdrawal stages make a lifecycle plan: no periodic deposits, and every month the stage's
withdrawal rule (the Trinity tab's, ``portfolio.withdrawal_want``) sells a pro-rata slice net
of tax. Its "initial" basis is the net balance when the first withdrawal stage starts.

The account type (``models.ACCOUNTS``): a regular account pays tax on the dividends every
month (each holding's yield, reinvested net) and may tax the stage switches; an Israeli
savings account (קרן השתלמות, קופת גמל להשקעה) moves tax-free, pays no dividend tax, and
keeps the deposits up to the yearly ceiling (per plan year) in the tax-exempt part of a
split ``Book``. A deposit fee is a percent of every deposit, taken before it is bought.

Real mode: amounts entered by the user (deposits, events, target) are in today's money, i.e.
the CPI of the last data month; see ``deposit_scale``.

The holdings and the tax state live in ``portfolio.Book`` (shared with the withdrawal
simulator); see there for the tax model.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from .market import Market
from .portfolio import Book, paid_short, rebalance_rows, withdrawal_want
from .models import PlanRequest, SOLVE_MONTHLY, SOLVE_START, SOLVE_WITHDRAWAL, exempt_now


@dataclass
class SimOutput:
    final_net: np.ndarray                     # (R,) nominal, after the tax of selling everything
    paths_net: Optional[np.ndarray] = None    # (R, T+1) nominal net liquidation value
    deposits: Optional[np.ndarray] = None     # (R, T+1) nominal money put in at month m (the investor's flow)
    cpi: Optional[np.ndarray] = None          # (R, T+1) CPI at each month (if loaded)
    final_gross: Optional[np.ndarray] = None  # (R,) nominal market value of the holdings
    paths_gross: Optional[np.ndarray] = None  # (R, T+1) nominal market value (before the final tax)
    withdrawn: Optional[np.ndarray] = None    # (R, T+1) nominal net cash taken out (events and withdrawal stages)
    unpaid: Optional[np.ndarray] = None       # (R,) nominal withdrawals that could not be paid (all of them)
    events_unpaid: Optional[np.ndarray] = None   # (R,) the part of ``unpaid`` from withdrawal events
    shortfall_at: Optional[np.ndarray] = None    # (R,) first month a withdrawal stage was not paid in full, or -1
    retire_value: Optional[np.ndarray] = None    # (R,) nominal net value when the first withdrawal stage starts
    stage_withdrawn: Optional[np.ndarray] = None # (R, T+1) nominal net cash paid by the withdrawal stages
    buys: Optional[np.ndarray] = None         # (R, T+1) bought at month m from that month's deposits
    spread_buys: Optional[np.ndarray] = None  # (R, T+1) bought at month m from the waiting start amount
    realloc: Optional[np.ndarray] = None      # (R, T+1) bool: the portfolio was moved to the weights at m
    fees: Optional[np.ndarray] = None         # (R, T+1) nominal fees charged during the month ending at m
    taxes: Optional[np.ndarray] = None        # (R, T+1) nominal tax paid at month m
    dividend_tax: Optional[np.ndarray] = None # (R, T+1) nominal tax on dividends at month m (part of ``taxes``)
    deposit_fees: Optional[np.ndarray] = None # (R, T+1) nominal deposit fees at month m (part of ``fees``)
    exempt_share: Optional[np.ndarray] = None # (R,) part of the final value that is tax-free at the end


def _stage_weights(req, market: Market) -> np.ndarray:
    """(n_stages, A) normalized weights over the union of assets."""
    W = np.zeros((len(req.stages), len(market.asset_keys)))
    for s, stage in enumerate(req.stages):
        for h in stage.holdings:
            W[s, market.asset_keys.index(h.key)] += h.weight
        total = W[s].sum()
        if total <= 0:
            raise ValueError(f"סכום המשקלים בשלב {s + 1} הוא אפס")
        W[s] /= total
    return W


def stage_dividends(req, market: Market) -> Optional[np.ndarray]:
    """(n_stages, A) monthly dividend yield of every asset (a fraction), or None when no
    dividend is taxed: an Israeli savings account, a zero tax rate or no yields at all.
    An asset listed twice in a stage takes the weighted mean of its yields."""
    if req.account != "regular" or req.tax_rate <= 0:
        return None
    Y = np.zeros((len(req.stages), len(market.asset_keys)))
    W = np.zeros_like(Y)
    for s, stage in enumerate(req.stages):
        for h in stage.holdings:
            a = market.asset_keys.index(h.key)
            Y[s, a] += h.dividend * h.weight
            W[s, a] += h.weight
    if not (Y > 0).any():
        return None
    return np.divide(Y, W, out=np.zeros_like(Y), where=W > 0) / 1200


def stage_of_month(req: PlanRequest) -> np.ndarray:
    """(T+1,) stage index of every plan month (the end month belongs to the last stage)."""
    starts = np.cumsum([0] + [s.months for s in req.stages])
    T = int(starts[-1])
    return np.searchsorted(starts[1:], np.arange(T + 1), side="right").clip(0, len(req.stages) - 1)


def deposit_schedule(req: PlanRequest) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per plan month (T,): the multiplier of the periodic deposit (0 when none is due, the
    yearly growth otherwise), the deposit events and the withdrawal events (input units)."""
    T = req.total_months
    starts = np.cumsum([0] + [s.months for s in req.stages])
    m = np.arange(T)
    j = m - starts[stage_of_month(req)[:T]]
    every = max(int(req.deposit_every), 1)
    factor = np.where(j % every == 0, (1 + req.deposit_growth / 100) ** (m // 12), 0.0)
    ev_in, ev_out = np.zeros(T), np.zeros(T)
    for e in req.events:
        if not 0 <= e.month < T:
            continue
        if e.kind == "pause":
            factor[e.month:e.month + max(int(e.months), 0)] = 0.0
        elif e.kind == "withdraw":
            ev_out[e.month] += e.amount
        else:
            ev_in[e.month] += e.amount
    return factor, ev_in, ev_out


def simulate(req: PlanRequest, market: Market, x: Optional[np.ndarray] = None,
             rows: Optional[np.ndarray] = None, record: bool = False,
             unit_growth: bool = False, journal: Optional[list] = None) -> SimOutput:
    """Run the plan for the selected realizations.

    ``x`` overrides the solved variable per realization (start amount or the periodic
    deposit of every stage). ``unit_growth`` simulates 1 unit invested at the start with no
    deposits, fees only, no tax: used for the time-weighted return and drawdown (the
    rebalancing rule still applies, it is part of the strategy).
    ``journal`` (a list) collects the trades of row 0, for the realization detail view.
    """
    idx = market.day_idx if rows is None else market.day_idx[rows]
    R, T = idx.shape[0], idx.shape[1] - 1
    A = len(market.asset_keys)
    W = _stage_weights(req, market)
    rate = 0.0 if unit_growth else req.tax_rate / 100
    real_tax = req.tax_basis == "real" and market.cpi_daily is not None
    fee = (1 - req.annual_fee / 100) ** (1 / 12)
    regular = req.account == "regular"
    taxable_moves = req.tax_on_switch and not unit_growth and regular
    divs = None if unit_growth else stage_dividends(req, market)
    deposit_fee = 0.0 if unit_growth else req.deposit_fee / 100
    ceiling = req.account_ceiling if not regular else 0.0

    cpi = market.cpi_daily[idx] if market.cpi_daily is not None else None
    ones = np.ones(R)
    book = Book(R, A, rate, real_tax)
    book.journal = journal
    book.split = not regular and not unit_growth
    used = np.zeros(R)                # deposits this plan year, nominal (against the ceiling)

    def rec():
        return np.zeros((R, T + 1)) if record else None
    paths, gross, deposits, withdrawn, buys, spread_buys, fees, taxes, stage_paid, div_tax, dep_fees = (
        rec() for _ in range(11))
    realloc = np.zeros((R, T + 1), dtype=bool) if record else None
    unpaid, events_unpaid = np.zeros(R), np.zeros(R)
    shortfall_at = np.full(R, -1, dtype=np.int64)
    retire_value = np.zeros(R)
    retire_units = np.zeros(R)        # the withdrawal stages' "initial" basis, in input units
    retire_month = req.retire_month
    anchor = max(retire_month, 0)
    amount_override = x if (x is not None and req.solve_for == SOLVE_WITHDRAWAL) else None

    def deposit_scale(m):
        """Nominal value of one input unit deposited at month m.

        In real mode the inputs are in today's money (CPI of the last data month), so a
        deposit made decades ago is scaled down by the CPI. Indexed deposits follow the
        CPI month by month; otherwise the nominal amount is fixed at the plan's start.
        """
        if cpi is None or unit_growth:
            return ones
        ref = cpi[:, m] if req.index_deposits else cpi[:, 0]
        if req.real:
            return ref / market.cpi_base
        return ref / cpi[:, 0]

    def withdrawal_scale(m):
        """Nominal value of one input unit withdrawn at month m.

        Anchored at the start of retirement: in nominal mode an amount is money of the month
        the first withdrawal stage starts (indexed from there when the withdrawals are), in
        real mode it is today's money, and unindexed it stays at its value at retirement.
        """
        if cpi is None:
            return ones
        ref = cpi[:, m] if req.index_withdrawals else cpi[:, anchor]
        return ref / market.cpi_base if req.real else ref / cpi[:, anchor]

    def withdraw(want, cpi_m):
        """Pay ``want`` net: first from the cash waiting to be invested, then a pro-rata sale."""
        nonlocal cash
        from_cash = np.minimum(cash, want)
        cash = cash - from_cash
        return from_cash + book.withdraw_net(want - from_cash, cpi_m)

    def deposit(amount, w, cpi_m, sc):
        """Invest ``amount`` (R,) nominal, less the deposit fee. In a savings account with a
        ceiling, only the part within this plan year's room is tax-exempt. Returns what was bought."""
        nonlocal used
        net = amount * (1 - deposit_fee)
        if deposit_fee:
            book.fees = book.fees + (amount - net)
            if record:
                dep_fees[:, m] += amount - net
        exempt = None
        if book.split and ceiling > 0:
            room = np.maximum(ceiling * sc - used, 0.0)
            exempt = net * np.divide(np.minimum(amount, room), amount, out=np.zeros_like(amount), where=amount > 0)
            used = used + amount
        book.buy(net, w, cpi_m, exempt=exempt)
        return net

    # Resolve deposits once (they may be overridden per realization by ``x``).
    stage_starts = np.cumsum([0] + [s.months for s in req.stages])
    if unit_growth:
        start_amount = ones
    elif x is not None and req.solve_for == SOLVE_START:
        start_amount = x
    else:
        start_amount = ones * req.start_amount
    if unit_growth:
        factor, ev_in, ev_out = np.zeros(T), np.zeros(T), np.zeros(T)
    else:
        factor, ev_in, ev_out = deposit_schedule(req)

    # Spreading the start amount (and the first stage's initial deposit): it waits as cash.
    spread = 0 if unit_growth else min(int(req.lump_spread), T)
    cash = np.zeros(R)
    cash_growth = (1 + req.cash_rate / 100 * (1 - rate)) ** (1 / 12)

    for s, stage in enumerate(req.stages):
        w = W[s]
        m0 = stage_starts[s]

        if s > 0:
            book.m, book.ctx = m0, "switch"
            book.reallocate(w, cpi[:, m0] if cpi is not None else None, taxable=taxable_moves)
            if record:
                realloc[:, m0] = True

        if unit_growth or stage.withdraws:
            monthly = 0.0 * ones
        elif x is not None and req.solve_for == SOLVE_MONTHLY:
            monthly = x
        else:
            monthly = ones * stage.monthly_deposit
        initial = ones * stage.initial_deposit if not (unit_growth or stage.withdraws) else 0.0 * ones
        if s == 0:
            lump = initial + start_amount
            initial = 0.0 * ones if spread else lump

        annuity = stage.withdraws and stage.annuity
        for j in range(stage.months):
            m = m0 + j
            cpi_m = cpi[:, m] if cpi is not None else None
            sc = deposit_scale(m)
            book.exempt = exempt_now(req.account, m, annuity)
            if m % 12 == 0:
                used = np.zeros(R)

            moved = rebalance_rows(book, req.rebalance, req.rebalance_band, w, j)
            if moved is not None:
                book.m, book.ctx = m, "rebalance"
                book.reallocate(w, cpi_m, taxable=taxable_moves, rows=moved)
                if record:
                    realloc[:, m] |= moved

            if ev_out[m] > 0:
                book.m, book.ctx = m, "event"
                want = ev_out[m] * sc
                book.exempt = exempt_now(req.account, m, False)        # a lump sum, not an annuity
                got = withdraw(want, cpi_m)
                book.exempt = exempt_now(req.account, m, annuity)
                unpaid += want - got
                events_unpaid += want - got
                if record:
                    withdrawn[:, m] = got

            amount = (monthly * factor[m] + ev_in[m] + (initial if j == 0 else 0.0)) * sc
            book.m, book.ctx = m, "deposit"
            bought = deposit(amount, w, cpi_m, sc)
            put_in = amount
            if spread and m < spread:
                if m == 0:
                    cash = lump * sc
                    put_in = amount + cash
                part = cash / (spread - m)
                cash = cash - part
                book.ctx = "spread"
                part_bought = deposit(part, w, cpi_m, sc)
                if record:
                    spread_buys[:, m] = part_bought

            if stage.withdraws and not unit_growth:
                sw = withdrawal_scale(m)
                if m == retire_month:
                    retire_value = book.liquidation_value(cpi_m) + cash
                    retire_units = retire_value / sw
                want = withdrawal_want(stage, j, book.total + cash, retire_units, sw, amount=amount_override)
                book.m, book.ctx = m, ("one_time" if j == 0 and stage.one_time > 0 else "withdraw")
                got = withdraw(want, cpi_m)
                shortfall_at[paid_short(got, want) & (shortfall_at < 0)] = m
                unpaid += want - got
                if record:
                    withdrawn[:, m] += got
                    stage_paid[:, m] = got
            if record:
                deposits[:, m] = put_in
                buys[:, m] = bought
                taxes[:, m] = book.tax_paid
                div_tax[:, m] = book.dividend_tax
                gross[:, m] = book.total + cash
                paths[:, m] = (book.liquidation_value(cpi_m) if not unit_growth else book.total) + cash
                fees[:, m] = book.fees

            book.grow(month_growth(market, idx, m), fee)
            if divs is not None:
                book.pay_dividends(divs[s], cpi[:, m + 1] if cpi is not None else None)
            cash = cash * cash_growth

    cpi_T = cpi[:, T] if cpi is not None else None
    last = req.stages[-1]
    book.exempt = exempt_now(req.account, T, last.withdraws and last.annuity)
    final_gross = book.total + cash
    final = final_gross if unit_growth else book.liquidation_value(cpi_T) + cash
    exempt_share = np.zeros(R)
    if book.split and book.exempt:
        exempt_share = np.divide(book.Ve.sum(axis=1), final_gross, out=np.zeros(R), where=final_gross > 0)
    if record:
        paths[:, T] = final
        gross[:, T] = final_gross
        taxes[:, T] = book.tax_paid
        div_tax[:, T] = book.dividend_tax
        fees[:, T] = book.fees
        # Running totals -> per month amounts.
        taxes = np.diff(taxes, axis=1, prepend=0.0)
        div_tax = np.diff(div_tax, axis=1, prepend=0.0)
        fees = np.diff(fees, axis=1, prepend=0.0)
    return SimOutput(final_net=final, paths_net=paths, deposits=deposits, cpi=cpi,
                     final_gross=final_gross, paths_gross=gross, withdrawn=withdrawn, unpaid=unpaid,
                     events_unpaid=events_unpaid, shortfall_at=shortfall_at, retire_value=retire_value,
                     stage_withdrawn=stage_paid,
                     buys=buys, spread_buys=spread_buys, realloc=realloc, fees=fees, taxes=taxes,
                     dividend_tax=div_tax, deposit_fees=dep_fees, exempt_share=exempt_share)


def lot_growth(req: PlanRequest, market: Market, realloc: np.ndarray) -> np.ndarray:
    """(R, T) gross growth to the end of the plan of one unit bought at month m (after that
    month's trades), fees included, before tax.

    The holdings are linear in the money put in, so every lot's growth is known in closed
    form. ``H[r, a]`` is the end value of one unit of asset a held after month m; walking back
    from H = 1 at T, a month multiplies it by the asset's growth and fee, and a month whose
    start moves the portfolio to the weights (``realloc``: a stage switch or a rebalance)
    first pools all assets at the new weights. A lot bought at m holds that stage's weights.
    A taxable move would also take tax out of the lot, which is ignored here (gross).
    """
    idx = market.day_idx
    R, T = idx.shape[0], idx.shape[1] - 1
    W = _stage_weights(req, market)
    fee = (1 - req.annual_fee / 100) ** (1 / 12)
    stage = stage_of_month(req)
    H = np.ones((R, len(market.asset_keys)))
    G = np.empty((R, T))
    for m in range(T - 1, -1, -1):
        if m + 1 < T:
            pooled = (H * W[stage[m + 1]]).sum(axis=1)
            H = np.where(realloc[:, m + 1][:, None], pooled[:, None], H)
        H = month_growth(market, idx, m) * fee * H
        G[:, m] = (H * W[stage[m]]).sum(axis=1)
    return G


def cohort_values(req: PlanRequest, market: Market, out: SimOutput, years: int) -> np.ndarray:
    """(R, years) gross value at the end of the plan of the money put in during each plan
    year (12 months each; a partial last year is left out), before tax.

    The spread start amount counts in the first year, when it left the investor. Withdrawal
    events sell every lot pro rata, which leaves each lot's growth rate unchanged, so the
    cohorts are valued as if nothing was sold (their return is what matters).
    """
    T = out.buys.shape[1] - 1
    G = lot_growth(req, market, out.realloc)
    value = out.buys[:, :T] * G
    value[:, 0] += (out.spread_buys[:, :T] * G).sum(axis=1)
    return np.stack([value[:, 12 * y:12 * (y + 1)].sum(axis=1) for y in range(years)], axis=1)


def month_growth(market: Market, idx: np.ndarray, m: int) -> np.ndarray:
    """(R, A) price growth factor of every asset from month m to m+1."""
    p_now = market.prices[:, idx[:, m]].T
    p_next = market.prices[:, idx[:, m + 1]].T
    return np.divide(p_next, p_now, out=np.zeros_like(p_now), where=p_now > 0)
