"""Turn raw price series into the arrays the simulator consumes.

Every asset is placed on one calendar-day grid (forward-filled, so weekends carry
Friday's close and there is no look-ahead), converted to the display currency, and
leveraged on trading-day returns. Each realization r is a start date; its month-m
date is ``start + m months`` (day clipped to the month length), and ``day_idx[r, m]``
is that date's position on the calendar grid.

Synthetic mode (``req.mode == "synthetic"``, see ``synthetic_market``): the realizations
are paths glued together from blocks of consecutive historical months (a block
bootstrap). Every path gets its own stretch of the "calendar", so the simulators run on
it unchanged.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from ..data.base import DataError, MarketData
from .models import PlanRequest

AssetKey = Tuple[str, float]
TRADING_DAYS = 252


@dataclass
class Market:
    calendar: pd.DatetimeIndex          # daily grid shared by all assets
    asset_keys: List[AssetKey]          # union of (ticker, leverage) over all stages
    prices: np.ndarray                  # (n_assets, n_days) price in display currency
    cpi_daily: Optional[np.ndarray]     # (n_days,) CPI of the display currency, or None
    start_dates: pd.DatetimeIndex       # one per realization
    day_idx: np.ndarray                 # (R, months+1) calendar positions
    first_dates: Dict[str, date]        # first available date per ticker
    fx_daily: Optional[np.ndarray] = None   # (n_days,) USD/ILS when the display currency is ILS
    synthetic: bool = False             # block-bootstrap paths instead of start dates
    cpi_ref: Optional[float] = None     # "today's" CPI when it is not the last calendar day

    @property
    def cpi_base(self) -> float:
        """CPI of the last data month: real values are expressed in this money ("today").
        A synthetic path starts today, so there it is the CPI at month 0 (1.0)."""
        return float(self.cpi_ref) if self.cpi_ref is not None else float(self.cpi_daily[-1])


def apply_leverage(prices: pd.Series, leverage: float, annual_cost_pct: float = 0.0) -> pd.Series:
    """Daily-rebalanced leveraged series. Borrowing cost is charged on (leverage - 1)."""
    if leverage == 1.0:
        return prices
    r = prices.pct_change().fillna(0.0).to_numpy()
    daily_cost = max(leverage - 1.0, 0.0) * annual_cost_pct / 100 / TRADING_DAYS
    growth = np.maximum(1.0 + leverage * r - daily_cost, 0.0)
    growth[0] = 1.0
    return pd.Series(prices.iloc[0] * np.cumprod(growth), index=prices.index)


def month_grid(starts: pd.DatetimeIndex, months: int) -> np.ndarray:
    """Dates ``start + m months`` for m = 0..months, as datetime64[D] of shape (R, months+1)."""
    start_d = starts.values.astype("datetime64[D]")
    start_m = start_d.astype("datetime64[M]")
    day = (start_d - start_m.astype("datetime64[D]")).astype(np.int64)  # 0-based day of month
    month = start_m[:, None] + np.arange(months + 1).astype("timedelta64[M]")
    first = month.astype("datetime64[D]")
    dim = ((month + np.timedelta64(1, "M")).astype("datetime64[D]") - first).astype(np.int64)
    return first + np.minimum(day[:, None], dim - 1).astype("timedelta64[D]")


def _start_dates(lo: pd.Timestamp, hi: pd.Timestamp, step: str) -> pd.DatetimeIndex:
    if hi < lo:
        return pd.DatetimeIndex([])
    if step == "D":
        return pd.date_range(lo, hi, freq="D")
    if step == "W":
        return pd.date_range(lo, hi, freq="7D")
    if step == "M":
        n = (hi.year - lo.year) * 12 + hi.month - lo.month
        grid = pd.DatetimeIndex(month_grid(pd.DatetimeIndex([lo]), max(n, 0))[0])
        return grid[grid <= hi]
    raise ValueError(f"unknown step {step!r}")


def load_series(req: PlanRequest, md: MarketData):
    """Download everything the request needs. Returns (raw prices per ticker, fx, cpi)."""
    tickers = sorted({h.key[0] for s in req.stages for h in s.holdings})
    raw = {t: md.prices(t) for t in tickers}
    for t, s in raw.items():
        if len(s) < 2:
            raise DataError(f"אין מספיק נתונים עבור {t}")
    fx = md.fx_usd_ils() if req.currency == "ILS" else None
    cpi = md.cpi("IL" if req.currency == "ILS" else "US") if req.needs_cpi else None
    return raw, fx, cpi


def available_range(req: PlanRequest, md: MarketData) -> dict:
    """Earliest and latest possible start dates for the plan's assets and duration."""
    raw, fx, cpi = load_series(req, md)
    lo, hi = _calendar_bounds(raw, fx, cpi)
    notes = []
    if _nominal_ils(req) and lo < ILS_NOMINAL_FROM:
        lo = ILS_NOMINAL_FROM
        notes.append(ILS_NOMINAL_NOTE)
    last_start = hi - pd.DateOffset(months=req.total_months)
    return {
        "min_start": lo.date(),
        "max_start": last_start.date(),
        "data_end": hi.date(),
        "first_dates": {t: s.index[0].date() for t, s in raw.items()},
        "notes": notes,
    }


# Israel's Economic Stabilization Plan. Before it, inflation reached hundreds of percent a
# year and the currency was replaced twice, so fixed nominal shekel amounts are meaningless.
ILS_NOMINAL_FROM = pd.Timestamp("1985-07-01")
ILS_NOMINAL_NOTE = (
    "בשקלים נומינליים אפשר להתחיל רק מיולי 1985 (תוכנית הייצוב). לפני כן האינפלציה הגיעה "
    "למאות אחוזים בשנה והמטבע הוחלף פעמיים, כך שהפקדה נומינלית קבועה בשקלים חדשים חסרת משמעות. "
    "במצב ריאלי או בדולרים כל ההיסטוריה זמינה."
)


def _nominal_ils(req: PlanRequest) -> bool:
    return req.currency == "ILS" and not req.real


def _calendar_bounds(raw, fx, cpi) -> tuple[pd.Timestamp, pd.Timestamp]:
    lo = max(s.index[0] for s in raw.values())
    hi = min(s.index[-1] for s in raw.values())
    if fx is not None:
        lo, hi = max(lo, fx.index[0]), min(hi, fx.index[-1] + pd.Timedelta(days=7))
    if cpi is not None:
        lo = max(lo, cpi.index[0])
    return lo, hi


def prepare_market(req: PlanRequest, md: MarketData) -> Market:
    if getattr(req, "mode", "history") == "synthetic":
        return synthetic_market(req, md)
    return _history_market(req, md)


def _daily(req, md: MarketData):
    """Every asset, the FX rate and the CPI on one daily calendar (display currency)."""
    raw, fx, cpi = load_series(req, md)
    lo, hi = _calendar_bounds(raw, fx, cpi)
    calendar = pd.date_range(lo, hi, freq="D")

    keys: List[AssetKey] = []
    for stage in req.stages:
        for h in stage.holdings:
            if h.key not in keys:
                keys.append(h.key)

    fx_daily = None
    if fx is not None:
        fx_daily = fx.reindex(fx.index.union(calendar)).ffill().reindex(calendar).to_numpy()

    prices = np.empty((len(keys), len(calendar)))
    for i, (ticker, lev) in enumerate(keys):
        s = apply_leverage(raw[ticker], lev, req.leverage_cost)
        s = s.reindex(s.index.union(calendar)).ffill().reindex(calendar)
        p = s.to_numpy()
        prices[i] = p * fx_daily if fx_daily is not None else p

    cpi_daily = None
    if cpi is not None:
        months = calendar.to_period("M").to_timestamp()
        uniq = months.unique()
        cpi_m = cpi.reindex(cpi.index.union(uniq)).ffill().reindex(uniq)
        cpi_daily = cpi_m.to_numpy()[uniq.get_indexer(months)]
    return raw, lo, hi, calendar, keys, prices, cpi_daily, fx_daily


def _history_market(req, md: MarketData) -> Market:
    raw, lo, hi, calendar, keys, prices, cpi_daily, fx_daily = _daily(req, md)
    T = req.total_months
    last_start = hi - pd.DateOffset(months=T)
    first_start = max(lo, ILS_NOMINAL_FROM) if _nominal_ils(req) else lo
    s_lo = max(first_start, pd.Timestamp(req.min_start)) if req.min_start else first_start
    s_hi = min(last_start, pd.Timestamp(req.max_start)) if req.max_start else last_start
    starts = _start_dates(s_lo.normalize(), s_hi.normalize(), req.step)
    if len(starts) == 0:
        raise DataError(
            f"אין תאריכי התחלה אפשריים: הנתונים מכסים {lo:%d/%m/%Y}–{hi:%d/%m/%Y}, "
            f"והתוכנית נמשכת {T} חודשים. לתוכנית ארוכה מההיסטוריה בחר 'מסלולים סינתטיים' בתקופת הבדיקה"
        )

    grid = month_grid(starts, T)
    day_idx = (grid - np.datetime64(calendar[0].date(), "D")).astype(np.int64)
    day_idx = np.clip(day_idx, 0, len(calendar) - 1).astype(np.int32)

    return Market(calendar=calendar, asset_keys=keys, prices=prices, cpi_daily=cpi_daily,
                  start_dates=starts, day_idx=day_idx,
                  first_dates={t: s.index[0].date() for t, s in raw.items()}, fx_daily=fx_daily)


# ------------------------------------------------------------------ synthetic paths

MAX_PATHS = 10_000


def sample_window(req, lo: pd.Timestamp, hi: pd.Timestamp) -> tuple[pd.Timestamp, pd.Timestamp]:
    """The stretch of history the synthetic paths are drawn from: all of it, or the
    user's ``sample_from``/``sample_to``, and never nominal shekels before July 1985."""
    first = max(lo, ILS_NOMINAL_FROM) if _nominal_ils(req) else lo
    s_lo = max(first, pd.Timestamp(req.sample_from)) if req.sample_from else first
    s_hi = min(hi, pd.Timestamp(req.sample_to)) if req.sample_to else hi
    return s_lo.normalize(), s_hi.normalize()


def synthetic_market(req, md: MarketData) -> Market:
    """Block bootstrap: ``req.paths`` paths of ``T`` months, each made of blocks of
    ``req.block`` consecutive historical months starting at uniformly random months of the
    sample window (the last block is cut at T). A month moves every asset, and the CPI,
    together, so correlations, the link between inflation and returns, and the fat tails
    of the history are kept; only the order of the blocks is new.

    Path r occupies calendar positions r*(T+1) .. r*(T+1)+T, with prices and CPI starting
    at 1, so ``day_idx`` simply walks along it. The calendar repeats the months from the
    end of the data, as the paths are possible futures that start today. ``req.only_path``
    keeps a single path (the detail view) from the same draw. With the same seed, number of
    paths, block and sample window, a shorter plan's paths are the start of a longer one's.
    """
    raw, lo, hi, calendar, keys, prices, cpi_daily, _ = _daily(req, md)
    T = req.total_months
    s_lo, s_hi = sample_window(req, lo, hi)
    span = (s_hi.year - s_lo.year) * 12 + s_hi.month - s_lo.month
    grid = pd.DatetimeIndex(month_grid(pd.DatetimeIndex([s_lo]), max(span, 0))[0])
    grid = grid[grid <= s_hi]
    N = len(grid) - 1                        # monthly returns in the sample
    block = int(req.block)
    if N < max(block, 12):
        raise DataError(f"תקופת הדגימה קצרה מדי: {max(N, 0)} חודשים, וצריך לפחות {max(block, 12)} "
                        f"(שנה אחת, ולא פחות מאורך הבלוק)")
    pos = calendar.get_indexer(grid)
    now, nxt = prices[:, pos[:-1]], prices[:, pos[1:]]
    G = np.divide(nxt, now, out=np.zeros_like(now), where=now > 0)          # (A, N)

    R = int(req.paths)
    rng = np.random.default_rng(int(req.seed))
    K = -(-T // block)
    # Drawn block by block (all paths' k-th block, then the next), so a longer plan only
    # appends blocks: two plans of different lengths share their paths (A/B comparison).
    starts = rng.integers(0, N - block + 1, size=(K, R)).T
    src = (starts[:, :, None] + np.arange(block)).reshape(R, K * block)[:, :T]   # (R, T)
    if req.only_path is not None:
        src = src[[int(req.only_path)]]
        R = 1

    def paths_of(g):                         # (..., N) monthly growth -> (..., R, T+1) from 1
        out = np.ones(g.shape[:-1] + (R, T + 1))
        out[..., 1:] = np.cumprod(g[..., src], axis=-1)
        return out

    A = len(keys)
    syn_prices = paths_of(G).reshape(A, R * (T + 1))
    syn_cpi = None
    if cpi_daily is not None:
        c = cpi_daily[pos]
        syn_cpi = paths_of(c[1:] / c[:-1]).reshape(R * (T + 1))
    today = pd.Timestamp(hi).to_period("M").to_timestamp()
    months = pd.DatetimeIndex(month_grid(pd.DatetimeIndex([today]), T)[0])
    return Market(calendar=pd.DatetimeIndex(np.tile(months.values, R)), asset_keys=keys, prices=syn_prices,
                  cpi_daily=syn_cpi, start_dates=pd.DatetimeIndex([today] * R),
                  day_idx=np.arange(R * (T + 1), dtype=np.int64).reshape(R, T + 1),
                  first_dates={t: s.index[0].date() for t, s in raw.items()}, fx_daily=None,
                  synthetic=True, cpi_ref=1.0 if syn_cpi is not None else None)
