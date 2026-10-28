"""FastAPI app: JSON endpoints for the engine plus the static web UI."""
from __future__ import annotations

import base64
import logging
import math
import time
from datetime import date
from pathlib import Path
from typing import List, Literal, Optional

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .config import FAVORITES, ON_VERCEL
from .data import DataError, demo_reason, get_market_data
from .data.search import lookup, search
from .engine import (DepositEvent, Holding, PlanRequest, Stage, WithdrawRequest, WithdrawStage, available_range,
                     benchmark_path, realization_detail, run_plan, run_trinity, solve_trace, trinity_heatmap)
from .engine.property import METRICS, STATS, InputError, PropertyRequest, row_of, run_property, solve_equal

log = logging.getLogger(__name__)
WEB_DIR = Path(__file__).resolve().parent / "web"
STARTED = time.time()
MAX_CELLS = 15_000_000   # realizations x months sent to the browser
if ON_VERCEL:            # hosted responses are capped at 4.5 MB (~11 bytes per cell)
    MAX_CELLS = 350_000


class HoldingIn(BaseModel):
    ticker: str = Field(min_length=1, max_length=20)
    weight: float = Field(ge=0)
    leverage: float = Field(1.0, ge=0, le=10)


class WithdrawRule(BaseModel):
    """How a withdrawal stage withdraws (the Trinity tab's stage and a lifecycle's)."""
    rate: float = Field(4.0, ge=0, le=1200)
    amount: float = Field(0.0, ge=0)
    rate_unit: Literal["pct", "money"] = "pct"
    basis: Literal["initial", "current"] = "initial"
    floor: float = Field(0.0, ge=0)
    ceiling: float = Field(0.0, ge=0)
    guard_unit: Literal["pct", "money"] = "pct"
    one_time: float = Field(0.0, ge=0)
    one_time_unit: Literal["money", "pct"] = "money"


class StageIn(WithdrawRule):
    name: str = ""
    months: int = Field(ge=1, le=1200)
    kind: Literal["deposit", "withdraw"] = "deposit"
    initial_deposit: float = Field(0.0, ge=0)
    monthly_deposit: float = Field(0.0, ge=0)
    holdings: List[HoldingIn] = Field(min_length=1)


class EventIn(BaseModel):
    month: int = Field(ge=0, le=1200)          # plan month, 0-based
    kind: Literal["deposit", "withdraw", "pause"] = "deposit"
    amount: float = Field(0.0, ge=0)
    months: int = Field(12, ge=1, le=1200)     # length of a pause


Rebalance = Literal["none", "monthly", "quarterly", "annual", "band"]


class PlanIn(BaseModel):
    stages: List[StageIn] = Field(min_length=1)
    start_amount: float = Field(0.0, ge=0)
    target_amount: float = Field(1_000_000.0, ge=0)
    solve_for: Literal["final", "monthly_deposit", "start_amount", "withdrawal"] = "final"
    currency: Literal["USD", "ILS"] = "USD"
    real: bool = False
    index_deposits: bool = False
    tax_rate: float = Field(25.0, ge=0, lt=100)
    tax_basis: Literal["nominal", "real"] = "nominal"
    tax_on_switch: bool = False
    annual_fee: float = Field(0.0, ge=0, le=20)
    leverage_cost: float = Field(0.0, ge=0, le=30)
    min_start: Optional[date] = None
    max_start: Optional[date] = None
    step: Literal["D", "W", "M"] = "M"
    deposit_every: Literal[1, 3, 6, 12] = 1
    deposit_growth: float = Field(0.0, ge=-50, le=100)
    events: List[EventIn] = Field(default_factory=list, max_length=100)
    lump_spread: int = Field(0, ge=0, le=1200)
    cash_rate: float = Field(0.0, ge=-10, le=50)
    rebalance: Rebalance = "none"
    rebalance_band: float = Field(5.0, gt=0, le=50)
    index_withdrawals: bool = True

    def to_request(self) -> PlanRequest:
        stages = [Stage(holdings=[Holding(h.ticker, h.weight, h.leverage) for h in s.holdings],
                        **s.model_dump(exclude={"holdings"}))
                  for s in self.stages]
        events = [DepositEvent(**e.model_dump()) for e in self.events]
        return PlanRequest(stages=stages, events=events, **self.model_dump(exclude={"stages", "events"}))


class WithdrawStageIn(WithdrawRule):
    name: str = ""
    months: int = Field(ge=1, le=1200)
    holdings: List[HoldingIn] = Field(min_length=1)


class TrinityIn(BaseModel):
    stages: List[WithdrawStageIn] = Field(min_length=1)
    start_amount: float = Field(1_000_000.0, ge=0)
    target_amount: float = Field(0.0, ge=0)
    solve_for: Literal["final", "amount", "rate", "start_amount"] = "final"
    currency: Literal["USD", "ILS"] = "USD"
    real: bool = False
    index_withdrawals: bool = True
    tax_rate: float = Field(25.0, ge=0, lt=100)
    tax_basis: Literal["nominal", "real"] = "nominal"
    tax_on_switch: bool = False
    annual_fee: float = Field(0.0, ge=0, le=20)
    leverage_cost: float = Field(0.0, ge=0, le=30)
    min_start: Optional[date] = None
    max_start: Optional[date] = None
    step: Literal["D", "W", "M"] = "M"
    rebalance: Rebalance = "none"
    rebalance_band: float = Field(5.0, gt=0, le=50)

    def to_request(self) -> WithdrawRequest:
        stages = [WithdrawStage(holdings=[Holding(h.ticker, h.weight, h.leverage) for h in s.holdings],
                                **s.model_dump(exclude={"holdings"}))
                  for s in self.stages]
        return WithdrawRequest(stages=stages, **self.model_dump(exclude={"stages"}))


class HeatmapIn(BaseModel):
    plan: TrinityIn
    rate_from: float = Field(2.0, ge=0, le=100)
    rate_to: float = Field(8.0, ge=0, le=100)
    rate_step: float = Field(0.25, gt=0, le=50)
    years_from: int = Field(10, ge=1, le=100)
    years_to: int = Field(40, ge=1, le=100)
    years_step: int = Field(5, ge=1, le=50)


class RealizationIn(BaseModel):
    plan: PlanIn
    start_date: date


class TrinityRealizationIn(BaseModel):
    plan: TrinityIn
    start_date: date


class BenchmarkIn(RealizationIn):
    rate: float = Field(0.0, ge=-50, le=100)     # fixed annual return, percent
    x: Optional[float] = None                     # the realization's solved variable (solve modes)


class TrinityBenchmarkIn(TrinityRealizationIn):
    rate: float = Field(0.0, ge=-50, le=100)
    x: Optional[float] = None


def _floats(a) -> list:
    """JSON-safe list: NaN/inf become null, values rounded to cents."""
    return [None if not math.isfinite(v) else round(float(v), 4) for v in np.asarray(a, dtype=float)]


def _opt(a) -> list | None:
    return None if a is None else _floats(a)


def _months(a) -> list:
    return [None if v < 0 else int(v) for v in np.asarray(a)]


def _matrix_b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype="<f4").tobytes()).decode("ascii")


app = FastAPI(title="Stock Plan App", version=__version__)
app.add_middleware(GZipMiddleware, minimum_size=2048)


@app.middleware("http")
async def no_stale_assets(request, call_next):
    # Make the browser revalidate the UI files on every load (cheap: ETag -> 304), so a new
    # version is picked up without a hard refresh.
    t0 = time.perf_counter()
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    else:   # visible in the browser's network tab
        response.headers["Server-Timing"] = f"app;dur={(time.perf_counter() - t0) * 1000:.0f}"
    return response


def _too_many(R: int, T1: int) -> str:
    msg = f"יותר מדי נקודות ({R:,} תקופות × {T1:,} חודשים). בחר דגימה גסה יותר"
    if ON_VERCEL:
        msg += " (בגרסה המקוונת המגבלה קטנה יותר; במחשב שלך עם python run.py אין מגבלה כזו)"
    return msg


def _bad_request(exc: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


@app.get("/api/meta")
def meta():
    md = get_market_data()
    return {
        "demo": md.is_demo,
        "demo_reason": demo_reason(),
        "version": __version__,
        "favorites": [{"group": g, "items": [{"label": l, "ticker": t} for l, t in items]}
                      for g, items in FAVORITES.items()],
    }


@app.get("/api/status")
def status():
    """Which data sources answered, and how fast. Open it in the browser to diagnose slowness."""
    md = get_market_data()
    now = time.time()
    sources = sorted(getattr(md, "sources", {}).items(), key=lambda kv: -kv[1]["at"])
    return {
        "version": __version__,
        "demo": md.is_demo,
        "demo_reason": demo_reason(),
        "hosted": ON_VERCEL,
        "instance_uptime_s": round(now - STARTED),
        "sources": [{"source": k, **{f: v for f, v in info.items() if f != "at"},
                     "ago_s": round(now - info["at"])} for k, info in sources],
    }


@app.get("/api/search")
def search_symbols(q: str = "", limit: int = 8):
    """Name/alias/symbol search: built-in dictionary, then Yahoo (skipped in demo mode)."""
    return {"results": search(q, limit=max(1, min(limit, 20)), online=not get_market_data().is_demo)}


@app.get("/api/lookup")
def lookup_symbol(ticker: str = ""):
    return {"ticker": ticker.strip().upper(), "name": lookup(ticker, online=not get_market_data().is_demo)}


def _trace(req):
    try:
        return solve_trace(req, get_market_data())
    except (DataError, ValueError) as exc:
        raise _bad_request(exc)


@app.post("/api/solve_trace")
def plan_solve_trace(plan: PlanIn):
    return _trace(plan.to_request())


@app.post("/api/trinity/solve_trace")
def trinity_solve_trace(plan: TrinityIn):
    return _trace(plan.to_request())


def _detail(req, start):
    try:
        return realization_detail(req, get_market_data(), start)
    except (DataError, ValueError) as exc:
        raise _bad_request(exc)
    except Exception as exc:
        log.exception("realization detail failed")
        raise HTTPException(status_code=500, detail=f"שגיאה פנימית: {exc}")


@app.post("/api/realization")
def plan_realization(body: RealizationIn):
    return _detail(body.plan.to_request(), body.start_date)


@app.post("/api/trinity/realization")
def trinity_realization(body: TrinityRealizationIn):
    return _detail(body.plan.to_request(), body.start_date)


def _bench(req, body):
    try:
        return benchmark_path(req, get_market_data(), body.start_date, body.rate, body.x)
    except (DataError, ValueError) as exc:
        raise _bad_request(exc)


@app.post("/api/realization/benchmark")
def plan_benchmark(body: BenchmarkIn):
    return _bench(body.plan.to_request(), body)


@app.post("/api/trinity/realization/benchmark")
def trinity_benchmark(body: TrinityBenchmarkIn):
    return _bench(body.plan.to_request(), body)


@app.post("/api/range")
def plan_range(plan: PlanIn):
    try:
        req = plan.to_request()
        rng = available_range(req, get_market_data())
    except (DataError, ValueError) as exc:
        raise _bad_request(exc)
    return {**rng, "total_months": req.total_months}


@app.post("/api/simulate")
def simulate(plan: PlanIn):
    req = plan.to_request()
    try:
        res = run_plan(req, get_market_data())
    except (DataError, ValueError) as exc:
        raise _bad_request(exc)
    except Exception as exc:  # unexpected: log with traceback, still answer in JSON
        log.exception("simulation failed")
        raise HTTPException(status_code=500, detail=f"שגיאה פנימית: {exc}")

    R, T1 = res.paths.shape
    if R * T1 > MAX_CELLS:
        raise HTTPException(status_code=400,
                            detail=_too_many(R, T1))
    return {
        "months": res.months,
        "n": R,
        "start_dates": [d.strftime("%Y-%m-%d") for d in res.start_dates],
        "end_dates": [d.strftime("%Y-%m-%d") for d in res.end_dates],
        "final": _floats(res.final),
        "deposits_total": _floats(res.deposits_total),
        "irr": _floats(res.irr),
        "cagr": _floats(res.cagr),
        "max_drawdown": _floats(res.max_drawdown),
        "account_drawdown": _floats(res.account_drawdown),
        "solved": None if res.solved is None else _floats(res.solved),
        "paths": _matrix_b64(res.paths),
        "deposits_path": _matrix_b64(res.deposits_path),
        # Gross = market value before the tax of selling everything at the end.
        "final_gross": _floats(res.final_gross),
        "irr_gross": _floats(res.irr_gross),
        "account_drawdown_gross": _floats(res.account_drawdown_gross),
        "paths_gross": _matrix_b64(res.paths_gross),
        # Plan-year cohorts: annual return of each year's deposits held to the end, (R, years).
        "years": int(res.year_irr_gross.shape[1]),
        "year_irr_gross": _matrix_b64(res.year_irr_gross),
        "year_irr_net": _matrix_b64(res.year_irr_net),
        "withdrawn_total": _floats(res.withdrawn_total),
        # First month at or above the target (null = never), gross and net.
        "target_month_gross": _months(res.target_month_gross),
        "target_month_net": _months(res.target_month_net),
        "fees_total": _floats(res.fees_total),
        "tax_paid": _floats(res.tax_paid),
        "final_nofee": _opt(res.final_nofee),
        "final_nofee_gross": _opt(res.final_nofee_gross),
        "final_lump": _opt(res.final_lump),
        "final_lump_gross": _opt(res.final_lump_gross),
        # Withdrawal stages (lifecycle plans); null when the plan has none.
        "success": None if res.success is None else [bool(v) for v in res.success],
        "depleted_at": None if res.depleted_at is None else _months(res.depleted_at),
        "retire_value": _opt(res.retire_value),
        "retire_month": res.retire_month,
        "withdraw_monthly": _opt(res.withdraw_monthly),
        "warnings": res.warnings,
        "demo": get_market_data().is_demo,
    }




# ------------------------------------------------------------------ withdrawal (Trinity)

@app.post("/api/trinity/range")
def trinity_range(plan: TrinityIn):
    try:
        req = plan.to_request()
        rng = available_range(req, get_market_data())
    except (DataError, ValueError) as exc:
        raise _bad_request(exc)
    return {**rng, "total_months": req.total_months}


@app.post("/api/trinity/simulate")
def trinity_simulate(plan: TrinityIn):
    req = plan.to_request()
    try:
        res = run_trinity(req, get_market_data())
    except (DataError, ValueError) as exc:
        raise _bad_request(exc)
    except Exception as exc:
        log.exception("withdrawal simulation failed")
        raise HTTPException(status_code=500, detail=f"שגיאה פנימית: {exc}")
    R, T1 = res.paths.shape
    if R * T1 > MAX_CELLS:
        raise HTTPException(status_code=400,
                            detail=_too_many(R, T1))
    return {
        "months": res.months,
        "n": R,
        "start_dates": [d.strftime("%Y-%m-%d") for d in res.start_dates],
        "end_dates": [d.strftime("%Y-%m-%d") for d in res.end_dates],
        "final": _floats(res.final),
        "withdrawn_total": _floats(res.withdrawn_total),
        "min_balance": _floats(res.min_balance),
        "depleted_at": [None if v < 0 else int(v) for v in res.depleted_at],
        "success": [bool(v) for v in res.success],
        "solved": None if res.solved is None else _floats(res.solved),
        "paths": _matrix_b64(res.paths),
        "withdrawals_path": _matrix_b64(res.withdrawals_path),
        "warnings": res.warnings,
        "demo": get_market_data().is_demo,
    }


@app.post("/api/trinity/heatmap")
def trinity_heat(body: HeatmapIn):
    rates = np.arange(body.rate_from, body.rate_to + 1e-9, body.rate_step)
    years = list(range(body.years_from, body.years_to + 1, body.years_step))
    if len(rates) * len(years) > 1500:
        raise HTTPException(status_code=400, detail="מפת החום גדולה מדי (עד 1,500 תאים)")
    try:
        return trinity_heatmap(body.plan.to_request(), get_market_data(), rates, years)
    except (DataError, ValueError) as exc:
        raise _bad_request(exc)
    except Exception as exc:
        log.exception("heat map failed")
        raise HTTPException(status_code=500, detail=f"שגיאה פנימית: {exc}")

# --------------------------------------------------------- apartment vs. capital market

class PropertySolveIn(BaseModel):
    plan: PropertyRequest
    a: str
    b: str
    metric: Literal[METRICS] = "final"
    stat: Literal[STATS] = "median"
    scope: str                       # "common" or a scenario id
    key: str = Field(min_length=1, max_length=80)
    lo: float
    hi: float


def _jsonable(v):
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, np.ndarray):
        return _jsonable(v.tolist())
    if isinstance(v, (float, np.floating)):
        return float(v) if math.isfinite(v) else None
    if isinstance(v, np.integer):
        return int(v)
    return v


def _input_error(exc: InputError) -> HTTPException:
    """400 with the message and the fields it belongs to (the UI marks them)."""
    return HTTPException(status_code=400, detail={"msg": str(exc), "errors": exc.errors})


def _detail_row(plan: PropertyRequest, res: dict) -> int:
    paths = res["paths"]
    if paths.R == 1:
        return 0
    if paths.history and plan.detail_start:
        hit = np.where(paths.start_dates == pd.Timestamp(plan.detail_start))[0]
        if len(hit):
            return int(hit[0])
    if not res["scenarios"]:
        return 0
    final = np.asarray(res["scenarios"][0]["metrics"]["final"], dtype=float)
    med = np.nanmedian(final)
    return int(np.nanargmin(np.abs(final - med)))


@app.post("/api/property/simulate")
def property_simulate(plan: PropertyRequest):
    """Every scenario's net worth on realization per month and its metrics, for every
    realization (one in fixed mode), plus the parts, flows and summary of one detailed row.

    Money series are in display units: today's money (real) or the shekels of the time
    (nominal). The summary stays in input units (the money of the start date).
    """
    try:
        res = run_property(plan, get_market_data())
    except InputError as exc:
        raise _input_error(exc)
    except (DataError, ValueError) as exc:
        raise _bad_request(exc)
    except Exception as exc:  # unexpected: log with traceback, still answer in JSON
        log.exception("property simulation failed")
        raise HTTPException(status_code=500, detail=f"שגיאה פנימית: {exc}")
    paths = res["paths"]
    if paths is None or not res["scenarios"]:                 # every scenario failed its checks
        return {"months": res["months"], "real": plan.common.real, "mode": plan.common.mode, "n": 0,
                "scenarios": [], "failed": res["failed"], "warnings": res["warnings"]}
    T, R = paths.T, paths.R
    if R * (T + 1) * len(res["scenarios"]) > MAX_CELLS:
        raise HTTPException(status_code=400, detail="יותר מדי נקודות. קצר את התקופה או הפחת תרחישים")
    row = _detail_row(plan, res)
    real = plan.common.real
    out = []
    for r in res["scenarios"]:
        cpi = r["cpi"][:, row]
        k = 1 / cpi if real else np.full(T + 1, paths.scale[row] if paths.scale is not None else 1.0)
        disp = r["display"]                                   # (T+1, R)
        out.append({
            "id": r["id"], "name": r["name"], "kind": r["kind"],
            "net_b64": _matrix_b64(disp.T),
            "net": _floats(disp[:, row]),
            "parts": {n: _floats(v[:, row] * k) for n, v in r["parts"].items()},
            "flows": {n: _floats(v[:, row] * (1 if n == "boi" else k)) for n, v in r["flows"].items()},
            "summary": _jsonable(row_of(r["summary"], row)),
            "metrics": {n: _floats(np.ravel(v)) for n, v in r["metrics"].items()},
            "warnings": r["warnings"],
        })
    first = res["scenarios"][0]
    return {
        "months": T, "real": real, "mode": plan.common.mode, "n": R, "detail_row": row,
        "start_dates": [d.strftime("%Y-%m-%d") for d in paths.start_dates] if paths.history else None,
        "history": paths.info or None,
        "cpi": _floats(first["cpi"][:, row]),
        "scale": float(paths.scale[row]) if paths.scale is not None else 1.0,
        "scenarios": out, "failed": res["failed"], "warnings": res["warnings"],
    }


@app.post("/api/property/calibrate")
def property_calibrate(plan: PropertyRequest):
    """Synthetic-mode parameters estimated from the historical series (and each scenario's
    portfolio): geometric means, annual volatilities and correlations of monthly changes."""
    from .engine.property_data import calibrate
    try:
        return _jsonable(calibrate(plan, get_market_data()))
    except (DataError, ValueError) as exc:
        raise _bad_request(exc)


@app.post("/api/property/solve")
def property_solve(body: PropertySolveIn):
    """The values of one parameter at which scenarios a and b are equivalent on a metric
    (for a statistic over the realizations, and per realization in history mode)."""
    try:
        return _jsonable(solve_equal(body.plan, body.a, body.b, body.metric, body.scope, body.key, body.lo,
                                     body.hi, stat=body.stat, md=get_market_data()))
    except InputError as exc:
        raise _input_error(exc)
    except (DataError, ValueError) as exc:
        raise _bad_request(exc)


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
