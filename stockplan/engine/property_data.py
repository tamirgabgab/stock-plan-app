"""History paths for the apartment vs. capital market model.

In history mode every start date (the first of a month) is one realization. For each series
switched to history this module builds an ``(R, T+1)`` path on the month grid
``start + m months``:

* market: the monthly gross return of each portfolio (weights rebalanced monthly), from the
  daily prices converted to shekels at that day's USD/ILS rate, leverage applied daily;
* cpi: the Israeli CPI relative to the start month;
* housing / rent: the CBS housing price index and rent index relative to the start month;
* rate: the Bank of Israel rate (annual percent) of each month.

The start dates are those for which every chosen series covers the whole horizon.
"""
from __future__ import annotations

from typing import Dict, List

import numpy as np
import pandas as pd

from ..data.base import DataError
from .market import apply_leverage, month_grid
from .property import Paths, PropertyRequest, fixed_paths, holdings_key, months_of

SERIES_LABELS = {
    "market": "מחירי הנכסים ושער הדולר",
    "cpi": "מדד המחירים לצרכן",
    "housing": "מדד מחירי הדירות",
    "rent": "מדד שכר הדירה",
    "rate": "ריבית בנק ישראל",
    "fx": "שער הדולר",
}


def _portfolios(req: PropertyRequest) -> Dict[str, list]:
    out: Dict[str, list] = {}
    for sc in req.scenarios:
        params = [sc.market] if sc.kind == "market" else [sc.side]
        for p in params:
            hs = [h for h in p.holdings if h.weight > 0]
            if not hs:
                raise ValueError(f"{sc.name or 'תרחיש'}: אין נכסים בתיק")
            out[holdings_key(hs)] = hs
    return out


def _monthly_values(s: pd.Series, months: np.ndarray) -> np.ndarray:
    """Values of a monthly series at the month of each date of ``months`` (forward-filled)."""
    s = s.copy()
    s.index = pd.DatetimeIndex(s.index).to_period("M").to_timestamp()
    s = s[~s.index.duplicated(keep="last")].sort_index()
    full = pd.date_range(s.index[0], s.index[-1], freq="MS")
    s = s.reindex(full).ffill()
    flat = pd.DatetimeIndex(months.ravel().astype("datetime64[M]").astype("datetime64[ns]"))
    return s.reindex(flat).to_numpy(dtype=float).reshape(months.shape)


def build_paths(req: PropertyRequest, md) -> Paths:
    c = req.common
    T = months_of(c.years)
    if c.mode != "history":
        return fixed_paths(T)
    if md is None:
        raise DataError("אין מקור נתונים למצב ההיסטורי")
    flags = c.history
    monthly: Dict[str, pd.Series] = {}
    ranges: Dict[str, tuple] = {}
    getters = {"cpi": lambda: md.cpi("IL"), "housing": md.housing_index, "rent": md.rent_index,
               "rate": md.boi_rate}
    for name, get in getters.items():
        if getattr(flags, name):
            s = get().dropna()
            if len(s) < 2:
                raise DataError(f"אין מספיק נתונים בסדרה {SERIES_LABELS[name]}")
            monthly[name] = s
            ranges[name] = (s.index[0], s.index[-1] + pd.offsets.MonthEnd(0))
    # The nominal view needs the actual CPI even when the model runs on fixed inflation.
    cpi_all = monthly.get("cpi")
    if cpi_all is None:
        try:
            cpi_all = md.cpi("IL").dropna()
        except DataError:
            cpi_all = None

    raw: Dict[str, pd.Series] = {}
    fx = None
    ports = _portfolios(req) if flags.market else {}
    if ports:
        for hs in ports.values():
            for h in hs:
                t = h.ticker.strip().upper()
                if t not in raw:
                    raw[t] = md.prices(t).dropna()
                    ranges[t] = (raw[t].index[0], raw[t].index[-1])
        fx = md.fx_usd_ils().dropna()
        ranges["fx"] = (fx.index[0], fx.index[-1] + pd.Timedelta(days=7))

    if not ranges:
        raise DataError("במצב היסטורי צריך לבחור לפחות סדרה אחת שתרוץ על היסטוריה")
    lo = max(r[0] for r in ranges.values())
    hi = min(r[1] for r in ranges.values())
    first = lo if lo.day == 1 else (lo + pd.offsets.MonthBegin(1))
    last = (hi - pd.DateOffset(months=T)).to_period("M").to_timestamp()
    if last < first:
        detail = ", ".join(f"{SERIES_LABELS.get(k, k)}: {a:%m/%Y}–{b:%m/%Y}" for k, (a, b) in ranges.items())
        raise DataError(f"אין תאריכי התחלה אפשריים לאופק של {T // 12} שנים ו-{T % 12} חודשים. "
                        f"טווחי הנתונים: {detail}. קצר את התקופה או העבר סדרות לפרמטרים קבועים.")
    starts = pd.date_range(first.normalize(), last, freq="MS")
    grid = month_grid(starts, T)                                    # (R, T+1) datetime64[D]
    R = len(starts)
    paths = Paths(R=R, T=T, start_dates=starts)

    if "cpi" in monthly:
        v = _monthly_values(monthly["cpi"], grid)
        paths.cpi = v / v[:, :1]
    if "housing" in monthly:
        v = _monthly_values(monthly["housing"], grid)
        paths.home = v / v[:, :1]
    if "rent" in monthly:
        v = _monthly_values(monthly["rent"], grid)
        paths.rent = v / v[:, :1]
    if "rate" in monthly:
        paths.rate = _monthly_values(monthly["rate"], grid)
    if cpi_all is not None and cpi_all.index[0] <= starts[0]:
        at_start = _monthly_values(cpi_all, grid[:, :1])[:, 0]
        paths.scale = at_start / float(cpi_all.iloc[-1])

    if ports:
        cal = pd.date_range(min(s.index[0] for s in raw.values()), hi, freq="D")
        fx_d = fx.reindex(fx.index.union(cal)).ffill().reindex(cal).to_numpy()
        day_idx = np.clip((grid - np.datetime64(cal[0].date(), "D")).astype(np.int64), 0, len(cal) - 1)
        cache: Dict[tuple, np.ndarray] = {}
        for key, hs in ports.items():
            total = sum(h.weight for h in hs)
            g = np.zeros((R, T + 1))
            for h in hs:
                k = (h.ticker.strip().upper(), h.leverage)
                if k not in cache:
                    s = apply_leverage(raw[k[0]], h.leverage, c.leverage_cost)
                    p = s.reindex(s.index.union(cal)).ffill().reindex(cal).to_numpy() * fx_d
                    at = p[day_idx]
                    ratio = np.ones((R, T + 1))
                    with np.errstate(all="ignore"):
                        ratio[:, 1:] = at[:, 1:] / at[:, :-1]
                    cache[k] = np.nan_to_num(ratio, nan=1.0, posinf=1.0)
                g += h.weight / total * cache[k]
            g[:, 0] = 1.0
            paths.growth[key] = g

    paths.info = {
        "min_start": starts[0].strftime("%Y-%m-%d"), "max_start": starts[-1].strftime("%Y-%m-%d"), "n": R,
        "ranges": {SERIES_LABELS.get(k, k): [a.strftime("%Y-%m-%d"), b.strftime("%Y-%m-%d")] for k, (a, b) in ranges.items()},
        "series": [k for k in ("market", "cpi", "housing", "rent", "rate") if getattr(flags, k)],
        "nominal_scaled": paths.scale is not None,
    }
    return paths


__all__ = ["build_paths", "SERIES_LABELS"]
