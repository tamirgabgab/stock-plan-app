"""A statistical model of yearly inflation, instead of the CPI history.

The Israeli CPI of the 1980s and 1990s (hundreds, then tens of percent a year) swamps any
plan that runs through it. In model mode every realization gets its own inflation path:

    pi_y = mu + sigma * g(z_y)                   the inflation of plan year y
    z_y  = phi * z_{y-1} + sqrt(1 - phi^2) * eta_y,   z_0 = eta_0,   eta_y ~ N(0, 1)

``z`` is a standard-normal AR(1) process (persistence ``phi``), so every z_y is N(0, 1) and
``g`` turns it into a standardized variable (mean 0, variance 1) of the chosen family, which
keeps the chosen mean and standard deviation exact for any ``phi`` (a Gaussian copula):

* normal:   g(z) = z
* johnson:  Johnson SU, g(z) = (sinh((z - gamma) / delta) - m) / s, with gamma and delta fitted
            to the skewness and kurtosis exactly (m and s standardize it);
* cornish:  the Cornish-Fisher expansion, a cubic in z with the skewness S and excess
            kurtosis K, rescaled to variance 1 (S and K hold approximately);
* gennorm:  an asymmetric generalized normal (exponential power) law with density
            proportional to exp(-|x / a_+-|^k), a_+ = 1 + asym for x > 0 and 1 - asym below;
            g = F^-1(Phi(z)), standardized. k = 2 is the normal, k < 2 fattens the tails.

A year's inflation is spread evenly over its months, so the price index is
``C_m = prod_{k<m} (1 + pi_{k // 12})^(1/12)`` with ``C_0 = 1``; it is floored at -50% a year.

The draws are a pure function of (seed, key, year), where the key names the realization
(the start date in history mode, the path index in synthetic mode): a longer plan only adds
years, the detail view of one realization sees the same path as the full run, and two plans
compared on the same dates share their inflation.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache
from typing import Callable, Dict

import numpy as np

DISTS = ("normal", "johnson", "cornish", "gennorm")
FLOOR = -0.5                       # lowest yearly inflation (keeps the index positive)


@dataclass
class InflationModel:
    source: str = "model"          # "model" or "history" (the CPI series)
    dist: str = "normal"
    mean: float = 2.5              # percent a year
    sd: float = 1.0                # percent a year (0 = the same inflation every year)
    skew: float = 0.0              # johnson, cornish
    kurt: float = 0.0              # excess kurtosis (normal = 0): johnson, cornish
    power: float = 2.0             # k of the generalized normal
    asym: float = 0.0              # generalized normal: -1 < asym < 1, > 0 is a longer right tail
    phi: float = 0.5               # year-to-year persistence of z

    @property
    def is_model(self) -> bool:
        return self.source == "model"


# ------------------------------------------------------------------------ the families

@dataclass
class Shape:
    """A fitted family: ``g`` maps standard-normal z to the standardized variable."""
    g: Callable[[np.ndarray], np.ndarray]
    params: Dict[str, float]


def _johnson_moments(w: float, W: float):
    """Mean, variance, skewness and kurtosis of sinh((Z - gamma) / delta), with
    w = exp(1 / delta^2) and W = gamma / delta (Johnson 1949)."""
    m1 = -math.sqrt(w) * math.sinh(W)
    mu2 = 0.5 * (w - 1) * (w * math.cosh(2 * W) + 1)
    mu3 = -0.25 * math.sqrt(w) * (w - 1) ** 2 * (w * (w + 2) * math.sinh(3 * W) + 3 * math.sinh(W))
    mu4 = 0.125 * (w - 1) ** 2 * (w ** 2 * (w ** 4 + 2 * w ** 3 + 3 * w ** 2 - 3) * math.cosh(4 * W)
                                  + 4 * w ** 2 * (w + 2) * math.cosh(2 * W) + 3 * (2 * w + 1))
    return m1, mu2, mu3 / mu2 ** 1.5, mu4 / mu2 ** 2


def _lognormal_line(w: float):
    """Skewness and (Pearson) kurtosis of the lognormal with this w: the edge of the SU region."""
    return (w + 2) * math.sqrt(w - 1), w ** 4 + 2 * w ** 3 + 3 * w ** 2 - 3


def _bisect(f, lo: float, hi: float, n: int = 200) -> float:
    flo = f(lo)
    for _ in range(n):
        mid = 0.5 * (lo + hi)
        fm = f(mid)
        if (fm > 0) == (flo > 0):
            lo, flo = mid, fm
        else:
            hi = mid
    return 0.5 * (lo + hi)


@lru_cache(maxsize=64)                 # the fit takes ~25 ms and a request asks for it several times
def johnson_shape(skew: float, kurt: float) -> Shape:
    """Johnson SU with exactly this skewness and excess kurtosis."""
    if abs(skew) < 1e-9 and abs(kurt) < 1e-9:
        return Shape(lambda z: z, {"gamma": 0.0, "delta": math.inf})
    target = kurt + 3.0
    # The smallest w whose lognormal reaches the skewness: below it no SU has that skewness.
    w_lo = 1.0 if abs(skew) < 1e-12 else _bisect(lambda w: _lognormal_line(w)[0] - abs(skew), 1.0 + 1e-12, 20.0)
    edge = _lognormal_line(w_lo)[1]
    if target <= edge + 1e-6:
        need = edge - 3
        raise ValueError(f"בהתפלגות ג'ונסון, צידוד {skew:g} דורש גבנוניות עודפת גדולה מ-{need:.2f}")

    def omega_for(w: float) -> float:      # gamma / delta giving the skewness at this w
        if abs(skew) < 1e-12:
            return 0.0
        return _bisect(lambda W: _johnson_moments(w, W)[2] - skew, -30.0, 30.0)

    def kurt_gap(w: float) -> float:
        return _johnson_moments(w, omega_for(w))[3] - target

    hi = w_lo + 1e-3
    while kurt_gap(hi) < 0 and hi < 1e6:
        hi = 1 + 2 * (hi - 1)
    w = _bisect(kurt_gap, w_lo * (1 + 1e-9) + 1e-12, hi, 120)
    W = omega_for(w)
    delta = 1 / math.sqrt(math.log(w))
    gamma = W * delta
    m1, mu2, _, _ = _johnson_moments(w, W)
    s = math.sqrt(mu2)
    return Shape(lambda z: (np.sinh((z - gamma) / delta) - m1) / s,
                 {"gamma": gamma, "delta": delta, "m": m1, "s": s})


def cornish_shape(skew: float, kurt: float) -> Shape:
    # z + S/6 (z^2 - 1) + K/24 (z^3 - 3z) - S^2/36 (2z^3 - 5z) = c1 z + c2 (z^2 - 1) + c3 z^3
    c1, c2, c3 = 1 - kurt / 8 + 5 * skew ** 2 / 36, skew / 6, kurt / 24 - skew ** 2 / 18
    # g'(z) = c1 + 2 c2 z + 3 c3 z^2 must stay positive, or the expansion folds over.
    monotone = (c3 > 0 and (2 * c2) ** 2 < 12 * c3 * c1) or (c3 == 0 and c2 == 0 and c1 > 0)
    if not monotone:
        raise ValueError("בקירוב קורניש-פישר הצירוף הזה של צידוד וגבנוניות לא נותן התפלגות תקינה. "
                         "הגדל את הגבנוניות או הקטן את הצידוד, או בחר בג'ונסון")
    # Var of c1 z + c2 (z^2 - 1) + c3 z^3 for z ~ N(0, 1): E z^2 = 1, E z^4 = 3, E z^6 = 15.
    var = c1 ** 2 + 6 * c1 * c3 + 15 * c3 ** 2 + 2 * c2 ** 2
    s = math.sqrt(var)
    return Shape(lambda z: (c1 * z + c2 * (z * z - 1) + c3 * z ** 3) / s,
                 {"c1": c1, "c2": c2, "c3": c3, "s": s})


def _gennorm_table(k: float, n: int = 40001):
    """CDF of Y with density k / Gamma(1/k) exp(-y^k) on y >= 0, tabulated (y dense near 0)."""
    y_max = 60.0 ** (1 / k)
    y = y_max * np.linspace(0, 1, n) ** 2
    f = np.exp(-y ** k)
    cdf = np.concatenate([[0.0], np.cumsum(0.5 * (f[1:] + f[:-1]) * np.diff(y))])
    return y, cdf / cdf[-1]


def _phi_cdf(z: np.ndarray) -> np.ndarray:
    return 0.5 * np.array([math.erfc(-v / math.sqrt(2)) for v in np.ravel(z)]).reshape(np.shape(z))


Z_GRID = np.linspace(-8.5, 8.5, 6801)
U_GRID = _phi_cdf(Z_GRID)
HERMITE = np.polynomial.hermite_e.hermegauss(120)          # nodes and weights for E f(Z), Z ~ N(0, 1)


@lru_cache(maxsize=64)
def gennorm_shape(k: float, asym: float) -> Shape:
    if not 0.5 <= k <= 10:
        raise ValueError("המקדם בחזקה K חייב להיות בין 0.5 ל-10")
    if not -0.95 <= asym <= 0.95:
        raise ValueError("האסימטריה חייבת להיות בין ‎-0.95 ל-0.95")
    ap, am = 1 + asym, 1 - asym
    pp, pm = ap / (ap + am), am / (ap + am)          # P(X > 0), P(X < 0)
    mom = lambda r: math.gamma((r + 1) / k) / math.gamma(1 / k)   # E Y^r
    mean = (pp * ap - pm * am) * mom(1)
    var = (pp * ap ** 2 + pm * am ** 2) * mom(2) - mean ** 2
    s = math.sqrt(var)
    y, cdf = _gennorm_table(k)
    u = U_GRID
    x = np.where(u < pm, -am * np.interp(1 - u / pm, cdf, y), ap * np.interp((u - pm) / pp, cdf, y))
    x_std = (x - mean) / s
    return Shape(lambda z: np.interp(z, Z_GRID, x_std),
                 {"k": k, "a_plus": ap, "a_minus": am, "p_plus": pp, "mean": mean, "s": s})


def shape_of(m: InflationModel) -> Shape:
    if m.dist == "normal":
        return Shape(lambda z: z, {})
    if m.dist == "johnson":
        return johnson_shape(m.skew, m.kurt)
    if m.dist == "cornish":
        return cornish_shape(m.skew, m.kurt)
    if m.dist == "gennorm":
        return gennorm_shape(m.power, m.asym)
    raise ValueError(f"התפלגות אינפלציה לא מוכרת: {m.dist}")


def validate(m: InflationModel) -> None:
    if m.source not in ("model", "history"):
        raise ValueError(f"מקור אינפלציה לא מוכר: {m.source}")
    if not m.is_model:
        return
    if not -20 <= m.mean <= 50:
        raise ValueError("תוחלת האינפלציה חייבת להיות בין ‎-20% ל-50% בשנה")
    if not 0 <= m.sd <= 30:
        raise ValueError("סטיית התקן של האינפלציה חייבת להיות בין 0 ל-30 נקודות אחוז")
    if not 0 <= m.phi < 1:
        raise ValueError("ההתמדה חייבת להיות בין 0 ל-1 (לא כולל 1)")
    if m.dist not in DISTS:
        raise ValueError(f"התפלגות אינפלציה לא מוכרת: {m.dist}")
    if m.sd > 0:                   # a constant inflation never uses the family's shape
        shape_of(m)


# ----------------------------------------------------------------------- the draws

def _splitmix(x: np.ndarray) -> np.ndarray:
    with np.errstate(over="ignore"):              # uint64 arithmetic wraps mod 2^64, as intended
        x = x + np.uint64(0x9E3779B97F4A7C15)
        x = (x ^ (x >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
        x = (x ^ (x >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
        return x ^ (x >> np.uint64(31))


def _uniform(seed: int, keys: np.ndarray, years: np.ndarray, stream: int) -> np.ndarray:
    """(R, Y) uniforms in (0, 1), a pure function of (seed, key, year, stream)."""
    with np.errstate(over="ignore"):
        h = _splitmix(np.uint64(seed & 0xFFFFFFFF) * np.uint64(0x100000001B3) + np.uint64(stream))
        h = _splitmix(h ^ keys.astype(np.int64).view(np.uint64)[:, None])
        h = _splitmix(h ^ (years.astype(np.uint64)[None, :] * np.uint64(0x9E3779B97F4A7C15)))
    return ((h >> np.uint64(11)).astype(np.float64) + 0.5) / 2.0 ** 53


def standard_normals(seed: int, keys: np.ndarray, n_years: int) -> np.ndarray:
    """(R, Y) independent N(0, 1) draws (Box-Muller on two hashed uniforms)."""
    years = np.arange(n_years)
    u1, u2 = _uniform(seed, keys, years, 1), _uniform(seed, keys, years, 2)
    return np.sqrt(-2 * np.log(u1)) * np.cos(2 * np.pi * u2)


def yearly_rates(m: InflationModel, keys, n_years: int, seed: int) -> np.ndarray:
    """(R, Y) inflation of every plan year, as a fraction (0.025 = 2.5%)."""
    keys = np.asarray(keys, dtype=np.int64)
    mu, sigma = m.mean / 100, m.sd / 100
    if sigma == 0 or n_years == 0:
        return np.full((len(keys), n_years), max(mu, FLOOR))
    eta = standard_normals(seed, keys, n_years)
    z = np.empty_like(eta)
    z[:, 0] = eta[:, 0]
    c = math.sqrt(1 - m.phi ** 2)
    for y in range(1, n_years):
        z[:, y] = m.phi * z[:, y - 1] + c * eta[:, y]
    return np.maximum(mu + sigma * shape_of(m).g(z), FLOOR)


def index_paths(m: InflationModel, keys, months: int, seed: int) -> np.ndarray:
    """(R, months+1) price index C with C[:, 0] = 1, a year's inflation spread over its months."""
    years = -(-months // 12)
    pi = yearly_rates(m, keys, years, seed)
    monthly = np.repeat((1 + pi) ** (1 / 12), 12, axis=1)[:, :months]
    out = np.ones((len(pi), months + 1))
    out[:, 1:] = np.cumprod(monthly, axis=1)
    return out


def reprice(C: np.ndarray, hist: np.ndarray) -> np.ndarray:
    """(R, T+1) factor that keeps a historical series' real change and puts the model's
    inflation on top: C_m * I_0 / I_m, where I is the CPI history on the same months."""
    return C * hist[:, :1] / hist


def date_keys(dates) -> np.ndarray:
    """The realization key of a start date: days since 1970-01-01."""
    return np.asarray(dates, dtype="datetime64[D]").astype(np.int64)


# ------------------------------------------------------------- the preview and the math tab

def describe(m: InflationModel, points: int = 241) -> dict:
    """The density of the yearly inflation, its moments (by Gauss-Hermite quadrature on g)
    and the fitted parameters, for the input panel's chart and the math tab."""
    if m.sd == 0:                  # a constant inflation: no density, and the shape is unused
        return {"dist": m.dist, "params": {}, "pdf": None,
                "moments": {"mean": m.mean, "sd": 0.0, "skew": 0.0, "kurt": 0.0},
                "quantiles": {q: m.mean for q in ("p5", "p50", "p95")}, "floor_share": 0.0}
    shape = shape_of(m)
    zq, wq = HERMITE
    wq = wq / wq.sum()
    gq = shape.g(zq)
    mean = float((wq * gq).sum())
    var = float((wq * (gq - mean) ** 2).sum())
    sk = float((wq * (gq - mean) ** 3).sum() / var ** 1.5)
    ku = float((wq * (gq - mean) ** 4).sum() / var ** 2 - 3)
    out = {
        "dist": m.dist, "params": {k: (None if not math.isfinite(v) else round(float(v), 6)) for k, v in shape.params.items()},
        "moments": {"mean": m.mean, "sd": m.sd, "skew": round(sk, 4), "kurt": round(ku, 4)},
    }
    z = np.linspace(-5.5, 5.5, 4001)
    g = shape.g(z)
    dg = np.gradient(g, z)
    x = m.mean + m.sd * g                                  # percent
    dens = np.exp(-z * z / 2) / math.sqrt(2 * math.pi) / np.maximum(m.sd * dg, 1e-12)
    lo, hi = np.interp([-3.2905, 3.2905], z, x)              # x rises with z: 0.05% and 99.95%
    grid = np.linspace(lo, hi, points)
    order = np.argsort(x)
    y = np.interp(grid, x[order], dens[order])
    out["pdf"] = {"x": [round(float(v), 4) for v in grid], "y": [round(float(v), 6) for v in y]}
    qs = np.interp([-1.6448536, 0.0, 1.6448536], z, x)
    out["quantiles"] = dict(zip(("p5", "p50", "p95"), np.round(qs, 3).tolist()))
    # Draws below the floor are clipped to it, which lifts the drawn mean a little.
    floor = FLOOR * 100
    out["floor_share"] = float(_phi_cdf(np.interp([floor], x, z))[0]) if x[0] < floor else 0.0
    return out


def sample_paths(m: InflationModel, years: int, n: int, seed: int) -> list:
    """A few yearly inflation paths (percent), to show what the persistence looks like."""
    keys = np.arange(n, dtype=np.int64) + 1_000_000
    return (yearly_rates(m, keys, years, seed) * 100).round(3).tolist()

