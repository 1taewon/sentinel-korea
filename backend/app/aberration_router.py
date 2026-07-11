"""aberration_router.py — Farrington Flexible 통계적 이상징후 탐지 API.

입력  : 질병 코드(disease), 지역 코드(region), 주간 시계열(weekly counts)
출력  : 주차별 {observed, expected, threshold, alarm, exceedance_score}

데이터: backend/data/processed/kdca_notifiable_timeseries.json
        = KDCA EIDAPIService/PeriodRegion 2016~현재 주간 전수신고 건수(실데이터).
        국가 단위 총계만 존재하며 17개 시도 단위 주간 시계열은 KDCA가 제공하지
        않는다. 따라서 region 파라미터는 현재 'national'만 지원한다(합성 지역
        데이터는 만들지 않는다).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .farrington import FarringtonParams, WeekResult, evaluate_week, run_series, summarize_alarms

router = APIRouter(prefix="/aberration", tags=["aberration"])

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
TIMESERIES_PATH = PROCESSED_DIR / "kdca_notifiable_timeseries.json"

# Diseases whose recent-week alarms are surfaced in the overview / report. Defaults
# to the respiratory-related notifiable subset (Sentinel's focus) but any disease
# present in the time-series file can be queried directly via /detect/{disease}.
_OVERVIEW_DEFAULT_LIMIT = 12


def _load_timeseries() -> dict[str, Any]:
    if not TIMESERIES_PATH.exists():
        raise HTTPException(
            status_code=503,
            detail=(
                "kdca_notifiable_timeseries.json not found. Run "
                "`python -m scripts.fetch_kdca_timeseries` to build the multi-year "
                "KDCA history required by Farrington."
            ),
        )
    return json.loads(TIMESERIES_PATH.read_text(encoding="utf-8"))


def _params_from(overrides: dict[str, Any] | None) -> FarringtonParams:
    p = FarringtonParams()
    if overrides:
        for k, v in overrides.items():
            if hasattr(p, k) and v is not None:
                setattr(p, k, v)
    return p


def _detect_series(
    counts: list[float],
    epiweeks: list[str] | None,
    params: FarringtonParams,
    n_weeks: int | None,
) -> dict[str, Any]:
    results = run_series(counts, epiweeks, params, n_weeks=n_weeks)
    return {
        "results": [r.to_dict() for r in results],
        "summary": summarize_alarms(results),
    }


def detect_disease(disease: str, n_weeks: int = 20, params: FarringtonParams | None = None) -> dict[str, Any]:
    """Run Farrington on a stored national disease series. Reused by the report."""
    data = _load_timeseries()
    diseases = data.get("diseases", {})
    entry = diseases.get(disease)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"disease not found: {disease}")
    series = entry.get("series", [])
    counts = [float(r["total"]) for r in series]
    epiweeks = [r["epiweek"] for r in series]
    params = params or FarringtonParams()
    detected = _detect_series(counts, epiweeks, params, n_weeks)
    return {
        "status": "ok",
        "disease": disease,
        "region": "national",
        "is_synthetic": bool(data.get("is_synthetic", False)),
        "source": data.get("source"),
        "category": entry.get("category"),
        "is_respiratory_related": entry.get("is_respiratory_related"),
        "series_weeks": len(series),
        "series_range": [epiweeks[0], epiweeks[-1]] if epiweeks else None,
        "params": params.__dict__,
        **detected,
    }


def build_overview(n_weeks: int = 8, respiratory_only: bool = True) -> dict[str, Any]:
    """Latest-week alarm status across diseases — feeds the report and any UI."""
    data = _load_timeseries()
    diseases = data.get("diseases", {})
    params = FarringtonParams()
    rows: list[dict[str, Any]] = []
    latest_epiweek = None
    for name, entry in diseases.items():
        if respiratory_only and not entry.get("is_respiratory_related"):
            continue
        series = entry.get("series", [])
        if len(series) < params.past_weeks_not_included + params.min_baseline:
            continue
        counts = [float(r["total"]) for r in series]
        epiweeks = [r["epiweek"] for r in series]
        results = run_series(counts, epiweeks, params, n_weeks=n_weeks)
        if not results:
            continue
        summary = summarize_alarms(results)
        latest = results[-1]
        latest_epiweek = latest.epiweek or latest_epiweek
        recent_max = max((r.observed for r in results), default=0.0)
        # A sustained multi-year epidemic left in the baseline inflates the
        # expected/threshold long after it subsides (an inherent Farrington
        # property). Flag it so the report can annotate rather than mislead.
        baseline_elevated = bool(
            latest.expected is not None
            and recent_max >= 0
            and latest.expected > 3.0 * max(recent_max, 1.0)
        )
        rows.append({
            "disease": name,
            "category": entry.get("category"),
            "is_respiratory_virus": entry.get("is_respiratory_virus"),
            "latest": latest.to_dict(),
            "alarm": latest.alarm,
            "recent_max_observed": round(float(recent_max), 1),
            "baseline_elevated": baseline_elevated,
            "recent_alarm_count": summary["alarm_count"],
            "recent_alarm_weeks": summary["alarm_weeks"],
            "max_exceedance": summary["max_exceedance"],
        })
    # Alarms first, then by exceedance magnitude.
    rows.sort(key=lambda r: (
        not r["alarm"],
        -(r["latest"].get("exceedance_score") or -9e9),
    ))
    return {
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": data.get("source"),
        "is_synthetic": bool(data.get("is_synthetic", False)),
        "method": "Farrington Flexible (Noufaily et al. 2013)",
        "region": "national",
        "latest_epiweek": latest_epiweek,
        "n_weeks": n_weeks,
        "alarm_count": sum(1 for r in rows if r["alarm"]),
        "diseases": rows,
    }


# --------------------------------------------------------------------------- API


@router.get("/diseases")
async def list_diseases() -> dict[str, Any]:
    data = _load_timeseries()
    diseases = data.get("diseases", {})
    return {
        "status": "ok",
        "source": data.get("source"),
        "is_synthetic": bool(data.get("is_synthetic", False)),
        "year_range": [data.get("year_start"), data.get("year_end")],
        "count": len(diseases),
        "diseases": [
            {
                "disease": name,
                "category": e.get("category"),
                "is_respiratory_related": e.get("is_respiratory_related"),
                "is_respiratory_virus": e.get("is_respiratory_virus"),
                "weeks": e.get("weeks"),
            }
            for name, e in diseases.items()
        ],
    }


@router.get("/detect/{disease}")
async def detect(disease: str, n_weeks: int = 20) -> dict[str, Any]:
    return detect_disease(disease, n_weeks=n_weeks)


@router.get("/overview")
async def overview(n_weeks: int = 8, respiratory_only: bool = True) -> dict[str, Any]:
    return build_overview(n_weeks=n_weeks, respiratory_only=respiratory_only)


class DetectRequest(BaseModel):
    """Generic detection on a caller-supplied series (region-agnostic).

    counts   : chronological weekly counts.
    epiweeks : optional matching labels (e.g. "2026-W12").
    region   : advisory label only; national is the only real KDCA granularity.
    params   : optional Farrington control overrides.
    n_weeks  : evaluate only the most recent N weeks (default: all evaluable).
    """

    counts: list[float]
    epiweeks: list[str] | None = None
    disease: str | None = None
    region: str | None = "national"
    n_weeks: int | None = None
    params: dict[str, Any] | None = None


@router.post("/detect")
async def detect_custom(req: DetectRequest) -> dict[str, Any]:
    if not req.counts:
        raise HTTPException(status_code=400, detail="counts must be non-empty")
    if req.epiweeks is not None and len(req.epiweeks) != len(req.counts):
        raise HTTPException(status_code=400, detail="epiweeks length must match counts")
    params = _params_from(req.params)
    detected = _detect_series(req.counts, req.epiweeks, params, req.n_weeks)
    return {
        "status": "ok",
        "disease": req.disease,
        "region": req.region or "national",
        "method": "Farrington Flexible (Noufaily et al. 2013)",
        "series_weeks": len(req.counts),
        "params": params.__dict__,
        **detected,
    }
