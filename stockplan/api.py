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

from .config import FAVORITES
from .data import DataError, get_market_data
from .engine import Holding, PlanRequest, Stage, available_range, run_plan

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


def _floats(a) -> list:
    """JSON-safe list: NaN/inf become null, values rounded to cents."""
    return [None if not math.isfinite(v) else round(float(v), 4) for v in np.asarray(a, dtype=float)]


def _matrix_b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype="<f4").tobytes()).decode("ascii")


app = FastAPI(title="Stock Plan App")
app.add_middleware(GZipMiddleware, minimum_size=2048)


def _bad_request(exc: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


@app.get("/api/meta")
def meta():
    md = get_market_data()
    return {
        "demo": md.is_demo,
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
        "solved": None if res.solved is None else _floats(res.solved),
        "paths": _matrix_b64(res.paths),
        "deposits_path": _matrix_b64(res.deposits_path),
        "warnings": res.warnings,
        "demo": get_market_data().is_demo,
    }


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
