"""Farrington Flexible aberration detection — pure-Python reimplementation.

Reference
---------
Noufaily A, Enki DG, Farrington P, Garthwaite P, Andrews N, Charlett A (2013).
"An improved algorithm for outbreak detection in multiple surveillance systems."
*Statistics in Medicine* 32(7):1206-1222.

The canonical implementation is ``surveillance::farringtonFlexible()`` in R. To
avoid shipping an R runtime into this deployment we reimplement the method in
Python on top of ``statsmodels`` (quasi-Poisson GLM). The behaviour is validated
against synthetic series with known ground truth in ``tests/test_farrington.py``
(clear spikes must alarm; flat and purely-seasonal series must not).

Pipeline for evaluating week ``t0``
-----------------------------------
1. Baseline selection: all weeks within ``b`` years back of ``t0``, excluding the
   most recent ``past_weeks_not_included`` weeks (so an ongoing outbreak does not
   inflate its own baseline).
2. Seasonality: a ``n_periods``-level factor. The ``w`` weeks either side of the
   anniversary of ``t0`` form the reference level (level 0); the rest of the year
   is split into ``n_periods - 1`` bands by circular distance from the anniversary.
   This is the Noufaily "10-level factor" generalisation of the original narrow
   ±w window.
3. Quasi-Poisson GLM: ``log(mu) = b0 + b1*t + seasonal factor`` with an
   overdispersion parameter ``phi`` estimated from Pearson residuals.
4. Trend: kept only if significant (p < ``trend_p_threshold``) and not
   extrapolating beyond observed history; otherwise the model is refit without it.
5. Reweighting: past outbreaks are down-weighted using Anscombe residuals with an
   outlier threshold ``reweight_threshold`` (2.58), then the GLM is refit once.
6. Threshold: a one-sided upper prediction bound via the 2/3-power (Farrington)
   delta method. ``alarm`` iff observed > threshold.
7. ``exceedance_score = (observed - expected) / (threshold - expected)`` — a value
   >= 1 is exactly an alarm.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from typing import Any, Sequence

import numpy as np

try:  # statsmodels is a hard dependency of the backend (see requirements.txt)
    import statsmodels.api as sm
    from scipy import stats as _sp_stats
except Exception as exc:  # pragma: no cover - import guard
    raise ImportError(
        "farrington.py requires statsmodels and scipy (see backend/requirements.txt)"
    ) from exc


FREQ = 52  # weeks per year


@dataclass
class FarringtonParams:
    """Tunable control parameters (defaults follow Noufaily 2013 / R flexible)."""

    b: int = 5                      # number of baseline years
    w: int = 3                      # half-width of the reference window (weeks)
    n_periods: int = 10             # seasonal factor levels (Noufaily recommends 10)
    past_weeks_not_included: int = 26
    reweight: bool = True
    reweight_threshold: float = 2.58   # Anscombe outlier cut (Noufaily); classic = 1.0
    alpha: float = 0.05             # one-sided upper tail
    trend: bool = True
    trend_p_threshold: float = 0.05
    power_transform: float = 2.0 / 3.0
    min_baseline: int = 12          # refuse to fit on fewer points than this
    limit_cases: int = 5            # limit54: suppress alarm unless...
    limit_weeks: int = 4            # ...>= limit_cases in the last limit_weeks weeks


@dataclass
class WeekResult:
    epiweek: str | None
    index: int
    observed: float
    expected: float | None
    threshold: float | None
    alarm: bool
    exceedance_score: float | None
    trend: bool = False
    note: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "epiweek": self.epiweek,
            "index": self.index,
            "observed": None if self.observed is None else round(float(self.observed), 3),
            "expected": None if self.expected is None else round(float(self.expected), 3),
            "threshold": None if self.threshold is None else round(float(self.threshold), 3),
            "alarm": bool(self.alarm),
            "exceedance_score": (
                None if self.exceedance_score is None else round(float(self.exceedance_score), 4)
            ),
            "trend": bool(self.trend),
            "note": self.note,
        }


def _seasonal_level(index: int, t0: int, w: int, n_periods: int) -> int:
    """Assign a baseline week to a seasonal factor level relative to ``t0``.

    Level 0 = the reference window (within ``w`` weeks of the anniversary of t0).
    Remaining levels 1..n_periods-1 partition the rest of the year by circular
    week-distance from the anniversary.
    """
    d = abs(index - t0) % FREQ
    circ = min(d, FREQ - d)  # 0..26
    if circ <= w or n_periods <= 1:
        return 0
    # Split (w, 26] into n_periods-1 bands.
    span = (FREQ / 2.0) - w
    band = int((circ - w - 1e-9) / (span / (n_periods - 1)))
    return 1 + min(band, n_periods - 2)


def _anscombe_residuals(y: np.ndarray, mu: np.ndarray) -> np.ndarray:
    """Anscombe residuals for the Poisson family (variance-stabilised)."""
    mu = np.clip(mu, 1e-6, None)
    return (1.5 * (np.power(y, 2.0 / 3.0) - np.power(mu, 2.0 / 3.0))) / np.power(mu, 1.0 / 6.0)


def _fit_glm(
    y: np.ndarray,
    time: np.ndarray,
    season: np.ndarray,
    weights: np.ndarray | None,
    use_trend: bool,
) -> tuple[Any, np.ndarray]:
    """Fit a Poisson GLM and return (result, design matrix columns x0-builder)."""
    cols = [np.ones_like(time, dtype=float)]
    if use_trend:
        cols.append(time.astype(float))
    # Seasonal dummies: drop the reference level (0) to avoid collinearity.
    levels = sorted(set(int(s) for s in season) - {0})
    for lv in levels:
        cols.append((season == lv).astype(float))
    X = np.column_stack(cols)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        model = sm.GLM(
            y,
            X,
            family=sm.families.Poisson(),
            freq_weights=weights if weights is not None else np.ones_like(y, dtype=float),
        )
        res = model.fit()
    return res, (X, levels, use_trend)


def _predict_current(
    res: Any,
    design_meta: tuple[np.ndarray, list[int], bool],
    y: np.ndarray,
    weights: np.ndarray,
    params: FarringtonParams,
) -> tuple[float, float, float]:
    """Return (expected mu0, threshold upper bound, phi) for the current week.

    The current week sits in the reference seasonal level (0) at centred time 0.
    """
    _X, levels, use_trend = design_meta
    # x0: intercept, [trend=0], seasonal dummies all 0 (reference level).
    x0 = [1.0]
    if use_trend:
        x0.append(0.0)
    x0.extend([0.0] * len(levels))
    x0 = np.asarray(x0, dtype=float)

    beta = np.asarray(res.params, dtype=float)
    mu = np.asarray(res.fittedvalues, dtype=float)

    # Quasi-Poisson overdispersion from weighted Pearson residuals.
    n = len(y)
    p = len(beta)
    dof = max(n - p, 1)
    pearson = np.sum(weights * (y - mu) ** 2 / np.clip(mu, 1e-6, None))
    phi = max(1.0, float(pearson / dof))

    eta0 = float(x0 @ beta)
    mu0 = float(np.exp(eta0))

    # Cov(beta) for quasi-Poisson = phi * (X'WX)^-1; statsmodels cov_params() is
    # (X'WX)^-1 at scale 1 for the Poisson family.
    cov_beta = phi * np.asarray(res.cov_params(), dtype=float)
    var_eta0 = float(x0 @ cov_beta @ x0)
    var_mu0 = mu0 ** 2 * var_eta0          # delta method through exp()
    pred_var = phi * mu0 + var_mu0          # observation dispersion + estimation

    z = float(_sp_stats.norm.ppf(1.0 - params.alpha))
    pw = params.power_transform
    # 2/3-power (Farrington) delta-method upper bound.
    mean_g = mu0 ** pw
    var_g = (pw ** 2) * (mu0 ** (2 * pw - 2)) * pred_var
    upper_g = mean_g + z * np.sqrt(max(var_g, 0.0))
    threshold = float(upper_g ** (1.0 / pw)) if upper_g > 0 else 0.0
    return mu0, threshold, phi


def _sparse_result(
    y: np.ndarray,
    observed: float,
    params: FarringtonParams,
    epiweek: str | None,
    t0: int,
    counts: np.ndarray,
) -> "WeekResult":
    """Fallback for baselines too sparse for a GLM (e.g. rare/near-zero diseases).

    Uses a plain Poisson(mean) upper quantile. For all-zero history the threshold
    is 0, so any sustained appearance (gated by limit54) surfaces as an alarm.
    """
    mu0 = float(np.mean(y)) if len(y) else 0.0
    z_alpha = 1.0 - params.alpha
    threshold = float(_sp_stats.poisson.ppf(z_alpha, mu0)) if mu0 > 0 else 0.0
    alarm = observed > threshold
    score = (observed - mu0) / (threshold - mu0) if threshold > mu0 else None
    recent = counts[max(0, t0 - params.limit_weeks + 1): t0 + 1]
    if float(np.sum(recent)) < params.limit_cases:
        alarm = False
    return WeekResult(
        epiweek=epiweek, index=t0, observed=observed, expected=mu0,
        threshold=threshold, alarm=alarm, exceedance_score=score,
        trend=False, note="sparse_baseline",
    )


def evaluate_week(
    counts: Sequence[float],
    t0: int,
    epiweeks: Sequence[str] | None = None,
    params: FarringtonParams | None = None,
) -> WeekResult:
    """Run Farrington Flexible for a single evaluation index ``t0``.

    ``counts`` is the full chronological weekly series; ``t0`` indexes the week to
    test. Only data strictly before the excluded recent window is used as baseline.
    """
    params = params or FarringtonParams()
    counts = np.asarray(counts, dtype=float)
    n_total = len(counts)
    epiweek = epiweeks[t0] if epiweeks is not None and t0 < len(epiweeks) else None
    observed = float(counts[t0])

    def _result(expected, threshold, alarm, score, trend, note):
        return WeekResult(
            epiweek=epiweek, index=t0, observed=observed, expected=expected,
            threshold=threshold, alarm=alarm, exceedance_score=score,
            trend=trend, note=note,
        )

    # Baseline: within b years back, excluding the recent window before t0.
    earliest = t0 - params.b * FREQ - params.w
    latest = t0 - params.past_weeks_not_included
    idx = [i for i in range(max(0, earliest), latest + 1)]
    if len(idx) < params.min_baseline:
        return _result(None, None, False, None, False, "insufficient_baseline")

    idx_arr = np.asarray(idx)
    y = counts[idx_arr]
    time = (idx_arr - t0).astype(float)   # centred; current week is time 0
    season = np.asarray([_seasonal_level(i, t0, params.w, params.n_periods) for i in idx])

    # Too few non-zero weeks to identify a quasi-Poisson GLM → Poisson fallback.
    if int(np.count_nonzero(y)) < 3:
        return _sparse_result(y, observed, params, epiweek, t0, counts)

    # Fit (optionally) with trend, then apply the trend-retention rule.
    use_trend = params.trend
    try:
        res, meta = _fit_glm(y, time, season, None, use_trend)
    except Exception:
        return _sparse_result(y, observed, params, epiweek, t0, counts)

    if use_trend:
        # meta = (X, levels, use_trend); trend is column index 1 when present.
        try:
            pvals = np.asarray(res.pvalues, dtype=float)
            trend_p = float(pvals[1])
        except Exception:
            trend_p = 1.0
        mu0_trend, _thr, _phi = _predict_current(res, meta, y, np.ones_like(y), params)
        # Drop trend if not significant or if it extrapolates beyond history.
        if trend_p > params.trend_p_threshold or mu0_trend > float(np.max(y)) * 1.0 + 1e-9:
            use_trend = False
            try:
                res, meta = _fit_glm(y, time, season, None, use_trend)
            except Exception:
                return _sparse_result(y, observed, params, epiweek, t0, counts)

    weights = np.ones_like(y, dtype=float)
    if params.reweight:
        mu = np.asarray(res.fittedvalues, dtype=float)
        n = len(y)
        p = len(np.asarray(res.params))
        dof = max(n - p, 1)
        pearson = np.sum((y - mu) ** 2 / np.clip(mu, 1e-6, None))
        phi = max(1.0, float(pearson / dof))
        anscombe = _anscombe_residuals(y, mu)
        s = anscombe / np.sqrt(phi)
        gamma = np.ones_like(s)
        outliers = np.abs(s) > params.reweight_threshold
        gamma[outliers] = (params.reweight_threshold / np.abs(s[outliers])) ** 2
        # Renormalise so weights average to 1 (preserve effective sample size).
        gamma *= len(gamma) / np.sum(gamma)
        weights = gamma
        try:
            res, meta = _fit_glm(y, time, season, weights, use_trend)
        except Exception:
            weights = np.ones_like(y, dtype=float)

    mu0, threshold, _phi = _predict_current(res, meta, y, weights, params)

    alarm = observed > threshold
    if threshold > mu0:
        score = (observed - mu0) / (threshold - mu0)
    else:
        score = None
    # limit54: do not alarm on very small numbers.
    recent = counts[max(0, t0 - params.limit_weeks + 1): t0 + 1]
    if float(np.sum(recent)) < params.limit_cases:
        alarm = False
    return _result(mu0, threshold, alarm, score, use_trend, None)


def run_series(
    counts: Sequence[float],
    epiweeks: Sequence[str] | None = None,
    params: FarringtonParams | None = None,
    n_weeks: int | None = None,
) -> list[WeekResult]:
    """Evaluate the most recent ``n_weeks`` weeks (default: all evaluable weeks)."""
    params = params or FarringtonParams()
    counts = list(counts)
    n_total = len(counts)
    first_evaluable = params.past_weeks_not_included + params.min_baseline
    start = 0 if n_weeks is None else max(0, n_total - n_weeks)
    start = max(start, first_evaluable)
    results = []
    for t0 in range(start, n_total):
        results.append(evaluate_week(counts, t0, epiweeks, params))
    return results


def summarize_alarms(results: Sequence[WeekResult]) -> dict[str, Any]:
    alarms = [r for r in results if r.alarm]
    return {
        "weeks_evaluated": len(results),
        "alarm_count": len(alarms),
        "alarm_weeks": [r.epiweek for r in alarms],
        "latest": results[-1].to_dict() if results else None,
        "max_exceedance": max(
            (r.exceedance_score for r in results if r.exceedance_score is not None),
            default=None,
        ),
    }
