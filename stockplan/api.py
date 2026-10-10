"""FastAPI app: JSON endpoints for the engine plus the static web UI."""
from __future__ import annotations

import base64
import logging
import math
from datetime import date
from pathlib import Path
from typing import List, Literal, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .config import FAVORITES
from .data import DataError, get_market_data
from .engine import (Holding, PlanRequest, Stage, WithdrawRequest, WithdrawStage, available_range, run_plan,
                     run_trinity, trinity_heatmap)

log = logging.getLogger(__name__)
WEB_DIR = Path(__file__).resolve().parent / "web"
MAX_CELLS = 15_000_000   # realizations x months sent to the browser


class HoldingIn(BaseModel):
    ticker: str = Field(min_length=1, max_length=20)
    weight: float = Field(ge=0)
    leverage: float = Field(1.0, ge=0, le=10)


class StageIn(BaseModel):
    name: str = ""
    months: int = Field(ge=1, le=1200)
    initial_deposit: float = Field(0.0, ge=0)
    monthly_deposit: float = Field(0.0, ge=0)
    holdings: List[HoldingIn] = Field(min_length=1)


class PlanIn(BaseModel):
    stages: List[StageIn] = Field(min_length=1)
    start_amount: float = Field(0.0, ge=0)
    target_amount: float = Field(1_000_000.0, ge=0)
    solve_for: Literal["final", "monthly_deposit", "start_amount"] = "final"
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

    def to_request(self) -> PlanRequest:
        stages = [Stage(months=s.months, initial_deposit=s.initial_deposit,
                        monthly_deposit=s.monthly_deposit, name=s.name,
                        holdings=[Holding(h.ticker, h.weight, h.leverage) for h in s.holdings])
                  for s in self.stages]
        return PlanRequest(stages=stages, **self.model_dump(exclude={"stages"}))


class WithdrawStageIn(BaseModel):
    name: str = ""
    months: int = Field(ge=1, le=1200)
    rate: float = Field(4.0, ge=0, le=1200)
    amount: float = Field(0.0, ge=0)
    rate_unit: Literal["pct", "money"] = "pct"
    basis: Literal["initial", "current"] = "initial"
    floor: float = Field(0.0, ge=0)
    ceiling: float = Field(0.0, ge=0)
    guard_unit: Literal["pct", "money"] = "pct"
    one_time: float = Field(0.0, ge=0)
    one_time_unit: Literal["money", "pct"] = "money"
    holdings: List[HoldingIn] = Field(min_length=1)


class TrinityIn(BaseModel):
    stages: List[WithdrawStageIn] = Field(min_length=1)
    start_amount: float = Field(1_000_000.0, ge=0)
    target_amount: float = Field(0.0, ge=0)
    solve_for: Literal["final", "rate", "start_amount"] = "final"
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


def _floats(a) -> list:
    """JSON-safe list: NaN/inf become null, values rounded to cents."""
    return [None if not math.isfinite(v) else round(float(v), 4) for v in np.asarray(a, dtype=float)]


def _matrix_b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype="<f4").tobytes()).decode("ascii")


app = FastAPI(title="Stock Plan App", version=__version__)
app.add_middleware(GZipMiddleware, minimum_size=2048)


@app.middleware("http")
async def no_stale_assets(request, call_next):
    # Make the browser revalidate the UI files on every load (cheap: ETag -> 304), so a new
    # version is picked up without a hard refresh.
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


def _bad_request(exc: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


@app.get("/api/meta")
def meta():
    md = get_market_data()
    return {
        "demo": md.is_demo,
        "version": __version__,
        "favorites": [{"group": g, "items": [{"label": l, "ticker": t} for l, t in items]}
                      for g, items in FAVORITES.items()],
    }


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
                            detail=f"יותר מדי נקודות ({R:,} תקופות × {T1:,} חודשים). בחר דגימה גסה יותר")
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
                            detail=f"יותר מדי נקודות ({R:,} תקופות × {T1:,} חודשים). בחר דגימה גסה יותר")
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

app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
