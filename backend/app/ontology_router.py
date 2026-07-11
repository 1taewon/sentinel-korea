"""Sentinel Korea — Ontology layer for **Decision Intelligence**.

Wraps the existing scattered JSON files in `backend/data/processed/` with a
typed Object/Link schema, and exposes **decision functions** (forecast,
driver decomposition, recommendations, hotspots) on top.

Design notes
------------
- 6 object types (Region, Disease, Outbreak, WeeklyReport, DataSource, Snapshot)
- 6 link types
- Decision functions registered separately (see `ontology_functions.py`)
- Temporal queries for forecast inputs (`/ontology/objects/Region/{id}/history`)
- No ActionRun audit layer — this tab is read-only AIP, mutations go through
  the PIPELINE tab.
"""

from __future__ import annotations

import hashlib
import json
import threading
from datetime import date as _date
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from starlette.concurrency import run_in_threadpool

from .auth import require_admin

router = APIRouter()

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PROCESSED_DIR = DATA_DIR / "processed"
SNAPSHOT_DIR = PROCESSED_DIR / "snapshots"

# Public demo — pre-generated for non-admin competition reviewers.  A cached result
# is used only while it matches the current simulator schema and mobility/weather/
# aviation inputs; refreshed data therefore reaches the example automatically.
_SCENARIO_EXAMPLE_FILE = PROCESSED_DIR / "scenario_example_v16.json"
_EXAMPLE_SCHEMA_VERSION = "seir-od-access-bridge-v4"
_EXAMPLE_INPUT_FILES = (
    "aviation_passenger_by_country.json",
    "highway_connectivity_by_region.json",
    "weather_respiratory_by_region.json",
    "multimodal_mobility_by_region.json",
)
_example_lock = threading.Lock()


def _example_input_fingerprint() -> str:
    """Version the public demo by model schema plus source-data file metadata."""
    pieces = [_EXAMPLE_SCHEMA_VERSION]
    for filename in _EXAMPLE_INPUT_FILES:
        path = PROCESSED_DIR / filename
        try:
            stat = path.stat()
            pieces.append(f"{filename}:{stat.st_mtime_ns}:{stat.st_size}")
        except FileNotFoundError:
            pieces.append(f"{filename}:missing")
    return hashlib.sha256("|".join(pieces).encode("utf-8")).hexdigest()[:16]


def _is_current_example(result: Any) -> bool:
    if not isinstance(result, dict):
        return False
    if result.get("_example_fingerprint") != _example_input_fingerprint():
        return False
    regions = result.get("regions") or []
    timeline = (regions[0] if regions else {}).get("timeline") or []
    return len(timeline) == 29 and isinstance(result.get("transmission_edges"), list)


def _generate_scenario_example(use_aviation: bool = True, use_traffic: bool = True,
                               use_weather: bool = True) -> dict:
    """Run the canonical H5N1/China demo with the same model and inputs as live runs.

    Weather uses the latest cached forecast rather than an on-demand external call so
    public example clicks remain quick and deterministic between input refreshes.
    """
    from .ontology_functions import _what_if_outbreak_national
    result = _what_if_outbreak_national({
        "entry_point": "ICN", "disease": "H5N1 Avian Influenza", "country": "China",
        "severity": "high", "weeks": 4,
        "use_aviation": use_aviation, "use_traffic": use_traffic, "use_weather": use_weather,
        "weather_live": False,
    })
    result["_example_fingerprint"] = _example_input_fingerprint()
    result["_example_schema_version"] = _EXAMPLE_SCHEMA_VERSION
    return result


def _example_combo_key(a: bool, t: bool, w: bool) -> str:
    return f"a{1 if a else 0}t{1 if t else 0}w{1 if w else 0}"


def _load_example_cache() -> dict:
    if _SCENARIO_EXAMPLE_FILE.exists():
        try:
            data = json.loads(_SCENARIO_EXAMPLE_FILE.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}
    return {}


def _save_example_cache(cache: dict) -> None:
    try:
        _SCENARIO_EXAMPLE_FILE.write_text(
            json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _example_has_ai(result: dict) -> bool:
    """True if the cached scenario already carries a valid Gemini analysis."""
    g = (result or {}).get("gemini_scenario")
    return bool(g) and not g.get("error") and not g.get("parse_error")


def _warm_example_cache(force: bool = False) -> dict:
    """Pre-generate all 8 current-model demo scenarios for competition reviewers."""
    import os
    has_key = bool(os.getenv("GEMINI_API_KEY"))
    generated = 0
    for a in (False, True):
        for t in (False, True):
            for wx in (False, True):
                key = _example_combo_key(a, t, wx)
                with _example_lock:
                    cache = _load_example_cache()
                    cached = cache.get(key)
                    if (not force and _is_current_example(cached)
                            and (not has_key or _example_has_ai(cached))):
                        continue
                result = _generate_scenario_example(a, t, wx)
                if has_key and not _example_has_ai(result):
                    retry = _generate_scenario_example(a, t, wx)
                    if _example_has_ai(retry):
                        result = retry
                with _example_lock:
                    cache = _load_example_cache()
                    cache[key] = result
                    _save_example_cache(cache)
                generated += 1
    return {"generated": generated, "ai_key": has_key, "fingerprint": _example_input_fingerprint()}

REPORTS_DIR = DATA_DIR / "reports"


# ─────────────────────────────────────────────────────────────────────────────
# Schema
# ─────────────────────────────────────────────────────────────────────────────

OBJECT_TYPES: list[dict[str, Any]] = [
    {
        "id": "Region",
        "label": "Region",
        "label_kr": "지역",
        "color": "#38bdf8",
        "icon": "map",
        "description": "Korean province/metropolitan city — 17 administrative regions tracked by Sentinel.",
        "primary_key": "code",
        "properties": [
            {"name": "code", "type": "string", "primary": True},
            {"name": "name_kr", "type": "string"},
            {"name": "name_en", "type": "string"},
            {"name": "lat", "type": "number"},
            {"name": "lng", "type": "number"},
            {"name": "current_score", "type": "number"},
            {"name": "current_level", "type": "enum<G0,G1,G2,G3>"},
            {"name": "active_sources", "type": "number"},
            {"name": "confidence", "type": "string"},
        ],
    },
    {
        "id": "Disease",
        "label": "Disease forecasting",
        "label_kr": "질병",
        "color": "#c084fc",
        "icon": "virus",
        "description": "Respiratory disease/pathogen tracked by KDCA weekly surveillance. Each has its own time series and forecast.",
        "primary_key": "id",
        "properties": [
            {"name": "id", "type": "string", "primary": True},
            {"name": "name_kr", "type": "string"},
            {"name": "name_en", "type": "string"},
            {"name": "category", "type": "string"},
            {"name": "data_source_file", "type": "string"},
            {"name": "latest_value", "type": "number"},
            {"name": "latest_epiweek", "type": "string"},
            {"name": "trend", "type": "enum<rising,falling,stable>"},
            {"name": "data_points", "type": "number"},
        ],
    },
    {
        "id": "Snapshot",
        "label": "Snapshot",
        "label_kr": "주차 스냅샷",
        "color": "#fb7185",
        "icon": "camera",
        "description": "Weekly composite alert snapshot — one record per region per day, computed by the analyze pipeline.",
        "primary_key": "date",
        "properties": [
            {"name": "date", "type": "date", "primary": True},
            {"name": "epiweek", "type": "string"},
            {"name": "regions_count", "type": "number"},
            {"name": "g3_count", "type": "number"},
            {"name": "g2_count", "type": "number"},
            {"name": "g1_count", "type": "number"},
            {"name": "g0_count", "type": "number"},
        ],
    },
]


LINK_TYPES: list[dict[str, Any]] = [
    {"id": "has_alert_in", "from": "Region", "to": "Snapshot", "label": "has alert in",
     "description": "Region has a computed G-level entry inside this Snapshot."},
    {"id": "tracked_by", "from": "Disease", "to": "Snapshot", "label": "tracked by",
     "description": "Disease signal value captured in this Snapshot's scoring cycle."},
    {"id": "affects", "from": "Disease", "to": "Region", "label": "affects",
     "description": "Disease contributes to this Region's composite score via signal weight."},
]


DISEASE_REGISTRY: list[dict[str, Any]] = [
    {"id": "influenza_ili", "name_kr": "인플루엔자 (ILI)", "name_en": "Influenza (ILI rate)",
     "category": "respiratory", "file": "kdca_influenza_ili_weekly.json",
     "value_key": "ili_index", "unit": "ILI/1000"},
    {"id": "sari_pneumonia", "name_kr": "중증폐렴 (SARI)", "name_en": "SARI Pneumonia",
     "category": "respiratory", "file": "kdca_sari_pneumonia_weekly.json",
     "value_key": "sari_pneumonia_cases", "unit": "cases/wk"},
    {"id": "sari_influenza", "name_kr": "중증인플루엔자 (SARI)", "name_en": "SARI Influenza",
     "category": "respiratory", "file": "kdca_sari_influenza_weekly.json",
     "value_key": "sari_influenza_cases", "unit": "cases/wk"},
    {"id": "ari_total", "name_kr": "급성호흡기감염증 (전체)", "name_en": "ARI Total",
     "category": "respiratory", "file": "kdca_ari_weekly.json",
     "value_key": "total", "unit": "cases/wk"},
    {"id": "rsv", "name_kr": "RSV (호흡기세포융합)", "name_en": "RSV",
     "category": "respiratory", "file": "kdca_ari_weekly.json",
     "value_key": "pathogens.호흡기세포융합바이러스", "unit": "cases/wk"},
    {"id": "hmpv", "name_kr": "사람메타뉴모바이러스", "name_en": "hMPV",
     "category": "respiratory", "file": "kdca_ari_weekly.json",
     "value_key": "pathogens.사람 메타뉴모바이러스", "unit": "cases/wk"},
    {"id": "adenovirus", "name_kr": "아데노바이러스", "name_en": "Adenovirus",
     "category": "respiratory", "file": "kdca_ari_weekly.json",
     "value_key": "pathogens.아데노바이러스", "unit": "cases/wk"},
    {"id": "covid19", "name_kr": "코로나19", "name_en": "COVID-19",
     "category": "respiratory", "file": "kdca_ari_weekly.json",
     "value_key": "pathogens.코로나19 바이러스", "unit": "cases/wk"},
]


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _load_json(path: Path) -> Any:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _epiweek_for(date_str: str) -> str:
    try:
        d = _date.fromisoformat(date_str)
        y, w, _ = d.isocalendar()
        return f"{y}-W{w:02d}"
    except Exception:
        return ""




def _latest_snapshot() -> tuple[str, list[dict]] | tuple[None, None]:
    if not SNAPSHOT_DIR.exists():
        return None, None
    files = sorted(SNAPSHOT_DIR.glob("*.json"))
    if not files:
        return None, None
    latest = files[-1]
    return latest.stem, _load_json(latest) or []




# ─────────────────────────────────────────────────────────────────────────────
# Object materialization
# ─────────────────────────────────────────────────────────────────────────────

def _materialize_regions() -> list[dict]:
    snap_date, snap = _latest_snapshot()
    if not snap:
        return []
    out: list[dict] = []
    for r in snap:
        out.append({
            "id": r.get("region_id") or r.get("region_code") or r.get("region_name_en"),
            "code": r.get("region_id") or r.get("region_code"),
            "name_kr": r.get("region_name_kr") or r.get("region_name_en"),
            "name_en": r.get("region_name_en"),
            "lat": r.get("lat"),
            "lng": r.get("lng"),
            "current_score": r.get("score"),
            "current_level": r.get("level"),
            "active_sources": r.get("active_sources"),
            "confidence": r.get("confidence"),
            "_snapshot_date": snap_date,
            "_signals": r.get("signals") or {},
        })
    return out


def _get_disease_time_series(disease_def: dict) -> list[dict]:
    """Extract time series records for a disease from its KDCA JSON file."""
    file_path = PROCESSED_DIR / disease_def["file"]
    data = _load_json(file_path)
    if not data or not isinstance(data, dict):
        return []
    records = data.get("records") or []
    value_key = disease_def["value_key"]

    out: list[dict] = []
    for rec in records:
        if rec.get("pending"):
            continue
        # Handle nested pathogen keys like "pathogens.호흡기세포융합바이러스"
        if "." in value_key:
            parts = value_key.split(".", 1)
            container = rec.get(parts[0]) or {}
            val = container.get(parts[1])
        else:
            val = rec.get(value_key)
        if val is None:
            continue
        try:
            val = float(val)
        except (TypeError, ValueError):
            continue
        out.append({
            "date": rec.get("date") or "",
            "epiweek": rec.get("epiweek") or "",
            "value": val,
        })
    return out


def _materialize_diseases() -> list[dict]:
    out: list[dict] = []
    for d in DISEASE_REGISTRY:
        ts = _get_disease_time_series(d)
        latest_val = ts[-1]["value"] if ts else None
        latest_ew = ts[-1]["epiweek"] if ts else ""
        # Trend: compare last 4 avg vs prior 4 avg
        trend = "stable"
        if len(ts) >= 8:
            recent = sum(p["value"] for p in ts[-4:]) / 4
            prior = sum(p["value"] for p in ts[-8:-4]) / 4
            if recent > prior * 1.1:
                trend = "rising"
            elif recent < prior * 0.9:
                trend = "falling"
        out.append({
            "id": d["id"],
            "name_kr": d["name_kr"],
            "name_en": d["name_en"],
            "category": d["category"],
            "data_source_file": d["file"],
            "latest_value": latest_val,
            "latest_epiweek": latest_ew,
            "trend": trend,
            "data_points": len(ts),
            "unit": d.get("unit", ""),
        })
    return out


def _materialize_snapshots() -> list[dict]:
    if not SNAPSHOT_DIR.exists():
        return []
    out: list[dict] = []
    for path in sorted(SNAPSHOT_DIR.glob("*.json")):
        records = _load_json(path) or []
        if not isinstance(records, list):
            continue
        levels = {"G0": 0, "G1": 0, "G2": 0, "G3": 0}
        for r in records:
            lvl = r.get("level") or "G0"
            if lvl in levels:
                levels[lvl] += 1
        out.append({
            "id": path.stem,
            "date": path.stem,
            "epiweek": _epiweek_for(path.stem),
            "regions_count": len(records),
            "g3_count": levels["G3"],
            "g2_count": levels["G2"],
            "g1_count": levels["G1"],
            "g0_count": levels["G0"],
        })
    return list(reversed(out))


_MATERIALIZERS = {
    "Region": _materialize_regions,
    "Disease": _materialize_diseases,
    "Snapshot": _materialize_snapshots,
}


# ─────────────────────────────────────────────────────────────────────────────
# Link resolution
# ─────────────────────────────────────────────────────────────────────────────



def _links_for(type_id: str, instance: dict) -> list[dict]:
    links: list[dict] = []

    if type_id == "Region":
        snap_date = instance.get("_snapshot_date")
        if snap_date:
            links.append({"link_type": "has_alert_in", "to_type": "Snapshot",
                          "to_id": snap_date, "to_label": f"Snapshot {snap_date}"})
        # Which diseases affect this region (via signal weights)
        for d in DISEASE_REGISTRY:
            links.append({"link_type": "affects", "to_type": "Disease",
                          "to_id": d["id"], "to_label": d["name_kr"],
                          "_inverse": True})

    elif type_id == "Disease":
        # Link to latest snapshot
        snap_date, _ = _latest_snapshot()
        if snap_date:
            links.append({"link_type": "tracked_by", "to_type": "Snapshot",
                          "to_id": snap_date, "to_label": f"Snapshot {snap_date}"})

    elif type_id == "Snapshot":
        # Link to all diseases tracked
        for d in DISEASE_REGISTRY:
            links.append({"link_type": "tracked_by", "to_type": "Disease",
                          "to_id": d["id"], "to_label": d["name_kr"],
                          "_inverse": True})

    return links


# ─────────────────────────────────────────────────────────────────────────────
# Endpoints — schema, objects, temporal queries, decision functions
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/ontology/schema")
async def get_schema() -> dict[str, Any]:
    """Return the typed schema — object types + link types."""
    counts: dict[str, int] = {}
    for tid, fn in _MATERIALIZERS.items():
        try:
            counts[tid] = len(fn())
        except Exception:
            counts[tid] = 0
    return {
        "object_types": [{**t, "instance_count": counts.get(t["id"], 0)} for t in OBJECT_TYPES],
        "link_types": LINK_TYPES,
    }


@router.get("/ontology/objects/{type_id}")
async def list_objects(type_id: str, limit: int = 200) -> dict[str, Any]:
    if type_id not in _MATERIALIZERS:
        raise HTTPException(status_code=404, detail=f"Unknown object type: {type_id}")
    instances = _MATERIALIZERS[type_id]()
    return {"type_id": type_id, "total": len(instances), "instances": instances[:limit]}


@router.get("/ontology/objects/{type_id}/{instance_id:path}")
async def get_object(type_id: str, instance_id: str) -> dict[str, Any]:
    if type_id not in _MATERIALIZERS:
        raise HTTPException(status_code=404, detail=f"Unknown object type: {type_id}")
    instances = _MATERIALIZERS[type_id]()
    inst = next((i for i in instances if str(i.get("id")) == instance_id), None)
    if inst is None:
        inst = next((i for i in instances if str(i.get("code")) == instance_id), None)
    if inst is None:
        raise HTTPException(status_code=404, detail=f"Instance not found: {type_id}/{instance_id}")
    return {"type_id": type_id, "instance": inst, "links": _links_for(type_id, inst)}


# ─── Temporal queries (B-3) ──────────────────────────────────────────────────

@router.get("/ontology/objects/Region/{region_id}/history")
async def region_history(region_id: str, weeks: int = 8) -> dict[str, Any]:
    """Time-series of a Region's score/level/signals over the last N weeks.

    Reads every snapshot file and extracts the matching region's record.
    Foundation for forecast functions.
    """
    if not SNAPSHOT_DIR.exists():
        return {"region_id": region_id, "points": []}
    files = sorted(SNAPSHOT_DIR.glob("*.json"))
    # ~7 snapshots per week if daily; with weekly cadence we just take the last (weeks * 7)
    files = files[-(weeks * 7):]
    points: list[dict] = []
    for path in files:
        records = _load_json(path) or []
        if not isinstance(records, list):
            continue
        match = next((r for r in records
                      if str(r.get("region_id") or r.get("region_code") or "") == region_id
                      or r.get("region_name_en") == region_id), None)
        if match:
            points.append({
                "date": path.stem,
                "epiweek": _epiweek_for(path.stem),
                "score": match.get("score"),
                "level": match.get("level"),
                "signals": match.get("signals") or {},
                "active_sources": match.get("active_sources"),
            })
    return {"region_id": region_id, "points": points}


@router.get("/ontology/objects/Snapshot/timeline")
async def snapshot_timeline(weeks: int = 8) -> dict[str, Any]:
    """Recent snapshots with summary stats. Used for trend overlays."""
    snaps = _materialize_snapshots()
    return {"timeline": snaps[: max(1, weeks * 7)]}


# ─── Disease time-series endpoint ────────────────────────────────────────────

@router.get("/ontology/objects/Disease/{disease_id}/timeseries")
async def disease_timeseries(disease_id: str) -> dict[str, Any]:
    """Return the full weekly time series for a disease (for charting)."""
    disease_def = next((d for d in DISEASE_REGISTRY if d["id"] == disease_id), None)
    if not disease_def:
        raise HTTPException(status_code=404, detail=f"Unknown disease: {disease_id}")
    ts = _get_disease_time_series(disease_def)
    return {
        "disease_id": disease_id,
        "name_kr": disease_def["name_kr"],
        "name_en": disease_def["name_en"],
        "unit": disease_def.get("unit", ""),
        "points": ts,
    }


# ─── Decision functions (B-2) ────────────────────────────────────────────────
# Functions are registered in `ontology_functions.py` and invoked via this
# generic POST endpoint. Some functions (recommendations) call Gemini and so
# require admin auth. Pure-statistics functions (decompose, forecast) are
# read-only and need no auth.

from . import ontology_functions as fns  # noqa: E402

# Directory for cached disease forecast reports
DISEASE_FORECAST_DIR = PROCESSED_DIR / "disease_forecast_reports"


@router.get("/ontology/functions")
async def list_functions() -> dict[str, Any]:
    """List every registered Decision function with its typed signature."""
    return {"functions": fns.list_specs()}


@router.post("/ontology/functions/{name}")
async def invoke_function(
    name: str,
    body: dict | None = Body(default=None),
) -> dict[str, Any]:
    """Invoke a registered Decision function. Inputs go in `body.inputs`.

    Auth is per-function: functions that hit Gemini require admin token via
    middleware below; pure-stats functions are public to authenticated users.
    """
    spec = fns.get_spec(name)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"Unknown decision function: {name}")
    inputs = (body or {}).get("inputs") or {}
    try:
        # Offload the sync function (may block on live weather fetch / Gemini) to a
        # threadpool so it never blocks the event loop.
        from starlette.concurrency import run_in_threadpool
        result = await run_in_threadpool(spec.fn, inputs)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"{spec.name} failed: {type(e).__name__}: {e}")
    return {"name": name, "inputs": inputs, "result": result}


@router.get("/ontology/scenario-example")
async def scenario_example(a: int = 1, t: int = 1, w: int = 1) -> dict[str, Any]:
    """Public current-model H5N1 demo for non-admin competition reviewers."""
    key = _example_combo_key(bool(a), bool(t), bool(w))
    cache = _load_example_cache()
    if _is_current_example(cache.get(key)):
        return cache[key]
    with _example_lock:
        cache = _load_example_cache()
        if _is_current_example(cache.get(key)):
            return cache[key]
        result = await run_in_threadpool(_generate_scenario_example, bool(a), bool(t), bool(w))
        cache[key] = result
        _save_example_cache(cache)
        return result

@router.post("/ontology/scenario-example/refresh")
async def scenario_example_refresh(_: dict = Depends(require_admin)) -> dict[str, Any]:
    """Regenerate all 8 toggle-combination demo scenarios (admin)."""
    cache: dict = {}
    for a in (False, True):
        for t in (False, True):
            for wx in (False, True):
                cache[_example_combo_key(a, t, wx)] = await run_in_threadpool(
                    _generate_scenario_example, a, t, wx)
    _save_example_cache(cache)
    return {"status": "ok", "combos": len(cache)}


# ─────────────────────────────────────────────────────────────────────────────
# Disease Forecast Reports — batch generate + cache + retrieve
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/ontology/disease-forecast-reports")
async def list_disease_forecast_reports() -> dict[str, Any]:
    """Return all cached disease forecast reports."""
    if not DISEASE_FORECAST_DIR.exists():
        return {"reports": [], "count": 0}
    reports: list[dict] = []
    for path in sorted(DISEASE_FORECAST_DIR.glob("*.json")):
        data = _load_json(path)
        if data:
            reports.append(data)
    return {"reports": reports, "count": len(reports)}


@router.get("/ontology/disease-forecast-reports/{disease_id}")
async def get_disease_forecast_report(disease_id: str) -> dict[str, Any]:
    """Return a cached disease forecast report, or 404 if not yet generated."""
    path = DISEASE_FORECAST_DIR / f"{disease_id}.json"
    data = _load_json(path)
    if not data:
        raise HTTPException(status_code=404, detail=f"No cached report for {disease_id}")
    return data


@router.post("/ontology/disease-forecast-reports/generate-all")
async def generate_all_disease_forecast_reports() -> dict[str, Any]:
    """Generate integrated forecast reports for ALL diseases and cache to disk.

    Called by the weekly cron pipeline after Sentinel analysis completes.
    Each disease runs: EMA + SARIMAX + Lead-Lag → Gemini synthesis.
    """
    from datetime import datetime as _dt

    DISEASE_FORECAST_DIR.mkdir(parents=True, exist_ok=True)

    spec = fns.get_spec("generateDiseaseForecastReport")
    if spec is None:
        raise HTTPException(status_code=500, detail="generateDiseaseForecastReport function not registered")

    results: list[dict] = []
    generated_at = _dt.utcnow().isoformat() + "Z"

    for disease_def in DISEASE_REGISTRY:
        disease_id = disease_def["id"]
        try:
            result = spec.fn({"disease_id": disease_id})
            result["generated_at"] = generated_at
            # Cache to disk
            out_path = DISEASE_FORECAST_DIR / f"{disease_id}.json"
            out_path.write_text(
                json.dumps(result, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            results.append({
                "disease_id": disease_id,
                "name_kr": disease_def["name_kr"],
                "status": "error" if result.get("error") else "ok",
                "error": result.get("error"),
            })
        except Exception as e:
            results.append({
                "disease_id": disease_id,
                "name_kr": disease_def["name_kr"],
                "status": "error",
                "error": str(e),
            })

    ok_count = sum(1 for r in results if r["status"] == "ok")
    return {
        "status": "ok" if ok_count == len(results) else "partial" if ok_count > 0 else "error",
        "generated_at": generated_at,
        "total": len(results),
        "success": ok_count,
        "results": results,
    }
