"""Everything about one realization (one start date), for the detail view.

The plan is re-run for that single start date with a trade journal, so every buy and sell
is listed with its price, amount and units. Alongside comes the "basket" price: the
weighted sum of the held assets' raw prices (weights as fractions, per stage), in dollars
plus the USD/ILS rate so the client can show it in shekels too.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import date

import numpy as np
import pandas as pd

from ..data.base import DataError, MarketData
from .market import prepare_market
from .models import SOLVE_FINAL, WithdrawRequest

MAX_POINTS = 5000   # basket chart samples (daily, thinned for long plans)


def _stage_weights(req, market) -> np.ndarray:
    W = np.zeros((len(req.stages), len(market.asset_keys)))
    for s, stage in enumerate(req.stages):
        for h in stage.holdings:
            W[s, market.asset_keys.index(h.key)] += h.weight
        W[s] /= W[s].sum()
    return W


def _num(v) -> float | None:
    v = float(v)
    return round(v, 6) if np.isfinite(v) else None


def realization_detail(req, md: MarketData, start: date) -> dict:
    # Imported here: the engine package imports this module.
    from . import run_plan, run_trinity
    from .simulate import simulate
    from .withdraw import simulate_withdraw

    trinity = isinstance(req, WithdrawRequest)
    one = replace(req, min_start=start, max_start=start)
    res = run_trinity(one, md) if trinity else run_plan(one, md)
    market = prepare_market(one, md)
    T = one.total_months
    idx = market.day_idx[0]
    x = None
    solved = None
    if req.solve_for != SOLVE_FINAL and res.solved is not None:
        solved = float(res.solved[0])
        x = np.array([0.0 if np.isnan(solved) else solved])

    journal: list = []
    if trinity:
        out = simulate_withdraw(one, market, x=x, journal=journal, record=True)
    else:
        out = simulate(one, market, x=x, journal=journal, record=True)

    cpi = market.cpi_daily[idx] if market.cpi_daily is not None else None
    deflate = (market.cpi_base / cpi) if (req.real and cpi is not None) else np.ones(T + 1)
    path_gross = out.paths_gross[0] * deflate
    fx = market.fx_daily
    if fx is None:                      # dollars: still offer the shekel view when the rate is available
        try:
            s = md.fx_usd_ils()
            fx = s.reindex(s.index.union(market.calendar)).ffill().reindex(market.calendar).to_numpy()
        except (DataError, Exception):  # noqa: BLE001 - the shekel view is optional
            fx = None
    to_usd = (1.0 / market.fx_daily) if market.fx_daily is not None else np.ones(len(market.calendar))

    W = _stage_weights(one, market)
    stage_starts = np.cumsum([0] + [s.months for s in one.stages])
    stage_of_month = np.searchsorted(stage_starts[1:], np.arange(T + 1), side="right").clip(0, len(one.stages) - 1)

    # A buy is followed until its asset leaves the portfolio (a later stage without it) or the end.
    def exit_month(m: int, a: int) -> int:
        for s in range(stage_of_month[m] + 1, len(one.stages)):
            if W[s, a] == 0:
                return int(stage_starts[s])
        return T

    dates = market.calendar[idx]
    trades = []
    for e in journal:
        m, a = e["m"], e["asset"]
        day = idx[m]
        price = market.prices[a, day]                         # display currency, nominal
        units = e["amount"] / price if price > 0 else 0.0
        row = {
            "m": m, "date": dates[m].strftime("%Y-%m-%d"), "stage": int(stage_of_month[m]),
            "ctx": e["ctx"], "kind": e["kind"], "asset": a,
            "price": _num(price), "price_usd": _num(price * to_usd[day]),
            "fx": _num(fx[day]) if fx is not None else None,
            "amount": _num(e["amount"] * deflate[m]), "tax": _num(e["tax"] * deflate[m]),
            "units": _num(units),
        }
        if e["kind"] == "buy":
            xm = exit_month(m, a)
            p_exit = market.prices[a, idx[xm]]
            ratio = p_exit / price if price > 0 else np.nan
            row.update({
                "exit_m": xm, "exit_date": dates[xm].strftime("%Y-%m-%d"),
                "value_exit": _num(e["amount"] * ratio * deflate[xm]),
                "return_pct": _num((ratio - 1) * 100),
                "annual_pct": _num((ratio ** (12 / (xm - m)) - 1) * 100) if xm > m and ratio > 0 else None,
            })
        trades.append(row)

    # Basket price: per day, the weights of the stage that holds that day.
    d0, d1 = int(idx[0]), int(idx[T])
    days = np.arange(d0, d1 + 1)
    stage_day = np.searchsorted(idx[stage_starts[1:-1]], days, side="right") if len(one.stages) > 1 \
        else np.zeros(len(days), dtype=int)
    usd = market.prices[:, days] * to_usd[days]               # (A, n)
    basket = (W[stage_day].T * usd).sum(axis=0)
    step = max(1, int(np.ceil(len(days) / MAX_POINTS)))
    keep = np.unique(np.r_[np.arange(0, len(days), step), len(days) - 1])
    marker_days = sorted({int(idx[t["m"]]) for t in trades if t["kind"] == "buy"})
    sale_days = sorted({int(idx[t["m"]]) for t in trades if t["kind"] == "sell"})

    def series_at(ds):
        ds = np.asarray(ds, dtype=int)
        return {"dates": [d.strftime("%Y-%m-%d") for d in market.calendar[ds]],
                "basket_usd": [_num(v) for v in basket[ds - d0]],
                "fx": [_num(v) for v in fx[ds]] if fx is not None else None}

    summary = {k: _num(np.asarray(getattr(res, k))[0]) for k in
               (("final", "withdrawn_total", "min_balance") if trinity else
                ("final", "deposits_total", "irr", "cagr", "max_drawdown", "account_drawdown"))}
    if trinity:
        summary["depleted_at"] = None if res.depleted_at[0] < 0 else int(res.depleted_at[0])
        summary["success"] = bool(res.success[0])
    summary["solved"] = None if solved is None or np.isnan(solved) else solved
    summary["final_gross"] = _num(path_gross[T])
    if not trinity:
        summary["irr_gross"] = _num(np.asarray(res.irr_gross)[0])

    return {
        "start_date": dates[0].strftime("%Y-%m-%d"), "end_date": dates[T].strftime("%Y-%m-%d"),
        "months": T, "trinity": trinity, "currency": req.currency, "real": req.real,
        "assets": [{"ticker": t, "leverage": lev} for t, lev in market.asset_keys],
        "stages": [{"name": s.name or f"שלב {i + 1}", "start_m": int(stage_starts[i]),
                    "start_date": dates[stage_starts[i]].strftime("%Y-%m-%d"),
                    "weights": [_num(w) for w in W[i]]} for i, s in enumerate(one.stages)],
        "summary": summary, "trades": trades,
        "path": [_num(v) for v in np.asarray(res.paths)[0]],
        "path_gross": [_num(v) for v in path_gross],
        # Cumulative money put in, net of withdrawal events (accumulation only).
        "flow": None if trinity else [_num(v) for v in np.asarray(res.deposits_path)[0]],
        "basket": series_at(days[keep]), "buys": series_at(marker_days), "sells": series_at(sale_days),
        "has_fx": fx is not None,
    }


BENCH = "__BENCH__"


def benchmark_path(req, md: MarketData, start: date, rate_pct: float, x: float | None = None) -> dict:
    """The same plan on one start date, with every stage's portfolio replaced by a single
    asset that earns a fixed ``rate_pct`` a year. Deposits, withdrawals, fees and tax follow
    exactly the same rules as the real account (one asset, so a stage switch sells nothing).

    In real mode the rate is real (above the CPI of the display currency); otherwise nominal.
    ``x`` is the solved variable of that realization in solve modes.
    """
    from .simulate import simulate
    from .withdraw import simulate_withdraw
    from .models import Holding

    trinity = isinstance(req, WithdrawRequest)
    one = replace(req, min_start=start, max_start=start)
    market = prepare_market(one, md)
    T = one.total_months
    days = np.arange(len(market.calendar), dtype=float)
    growth = (1 + rate_pct / 100) ** (days / 365.25)
    if req.real and market.cpi_daily is not None:
        growth = growth * market.cpi_daily / market.cpi_daily[0]
    bench_req = replace(one, stages=[replace(s, holdings=[Holding(BENCH, 100.0)]) for s in one.stages])
    bench = replace(market, asset_keys=[(BENCH, 1.0)], prices=growth[None, :])
    xv = None if (x is None or req.solve_for == SOLVE_FINAL) else np.array([float(x)])
    out = (simulate_withdraw(bench_req, bench, x=xv, record=True) if trinity
           else simulate(bench_req, bench, x=xv, record=True))
    idx = market.day_idx[0]
    cpi = market.cpi_daily[idx] if market.cpi_daily is not None else None
    deflate = (market.cpi_base / cpi) if (req.real and cpi is not None) else np.ones(T + 1)
    path = out.paths_net[0] * deflate
    gross = out.paths_gross[0] * deflate
    return {"rate": rate_pct, "path": [_num(v) for v in path], "final": _num(path[T]),
            "path_gross": [_num(v) for v in gross], "final_gross": _num(gross[T])}
