from __future__ import annotations

import json
import os
from copy import deepcopy
from datetime import date as date_cls
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

# .env 로드
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from .reframed_scoring import (
    build_explanation,
    composite_confidence,
    compute_composite_score,
    compute_quality_adjusted_signals,
    count_active_sources,
    count_independent_sources,
    default_scoring_config,
    iter_enabled_signal_keys,
    score_to_level,
    summarize_data_quality,
)
from .schemas import (
    AlertResponseModel,
    IngestionStatusResponseModel,
    RegionSummaryModel,
    ScoringConfigModel,
    TimelinePointModel,
)
from .auth import require_admin

app = FastAPI(title="Sentinel Korea API", version="0.3.0")

# 새 라우터 등록
from .chatbot_router import router as chatbot_router
from .report_router import router as report_router
from .upload_router import router as upload_router
from .news_router import router as news_router
from .trends_router import router as trends_router
from .risk_analysis_router import router as risk_analysis_router
from .config_router import router as config_router
app.include_router(chatbot_router)
app.include_router(report_router)
app.include_router(upload_router)
app.include_router(news_router)
app.include_router(trends_router)
app.include_router(risk_analysis_router)
app.include_router(config_router)

ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    # Vercel production + preview
    "https://sentinel-korea.vercel.app",
    "https://sentinel-korea-git-master-1taewons-projects.vercel.app",
]
# Allow all Vercel preview URLs for this project
ALLOWED_ORIGIN_REGEX = r"https://sentinel-korea.*\.vercel\.app"

# Additional origins from env (e.g. custom domain)
_extra = os.environ.get("EXTRA_CORS_ORIGINS", "")
if _extra:
    ALLOWED_ORIGINS.extend(o.strip() for o in _extra.split(",") if o.strip())

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
MOCK_DIR = DATA_DIR / "mock"
PROCESSED_DIR = DATA_DIR / "processed"
SNAPSHOT_DIR = PROCESSED_DIR / "snapshots"
ALGORITHM_VERSION = "korea-respiratory-v1"
PATHOGEN = "respiratory_composite"

REGION_METADATA = {
    "11": {"en": "Seoul", "kr": "서울특별시", "lat": 37.5665, "lng": 126.9780},
    "26": {"en": "Busan", "kr": "부산광역시", "lat": 35.1796, "lng": 129.0756},
    "27": {"en": "Daegu", "kr": "대구광역시", "lat": 35.8714, "lng": 128.6014},
    "28": {"en": "Incheon", "kr": "인천광역시", "lat": 37.4563, "lng": 126.7052},
    "29": {"en": "Gwangju", "kr": "광주광역시", "lat": 35.1595, "lng": 126.8526},
    "30": {"en": "Daejeon", "kr": "대전광역시", "lat": 36.3504, "lng": 127.3845},
    "31": {"en": "Ulsan", "kr": "울산광역시", "lat": 35.5384, "lng": 129.3114},
    "36": {"en": "Sejong", "kr": "세종특별자치시", "lat": 36.4800, "lng": 127.2890},
    "41": {"en": "Gyeonggi", "kr": "경기도", "lat": 37.2750, "lng": 127.0094},
    "42": {"en": "Gangwon", "kr": "강원특별자치도", "lat": 37.8228, "lng": 128.1555},
    "43": {"en": "Chungbuk", "kr": "충청북도", "lat": 36.6357, "lng": 127.4917},
    "44": {"en": "Chungnam", "kr": "충청남도", "lat": 36.5184, "lng": 126.8000},
    "45": {"en": "Jeonbuk", "kr": "전북특별자치도", "lat": 35.7175, "lng": 127.1530},
    "46": {"en": "Jeonnam", "kr": "전라남도", "lat": 34.8161, "lng": 126.4629},
    "47": {"en": "Gyeongbuk", "kr": "경상북도", "lat": 36.4919, "lng": 128.8889},
    "48": {"en": "Gyeongnam", "kr": "경상남도", "lat": 35.4606, "lng": 128.2132},
    "50": {"en": "Jeju", "kr": "제주특별자치도", "lat": 33.4890, "lng": 126.4983},
}

SIGNAL_METADATA = {
    "notifiable_disease": {
        "label": "Notifiable Disease (KDCA API)",
        "source_type": "notifiable_disease",
        "unit": "normalized weekly incidence",
        "baseline_mean": 0.35,
        "baseline_sd": 0.18,
        "coverage": 0.96,
        "freshness_days": 1.0,
    },
    "influenza_like": {
        "label": "ILI/SARI",
        "source_type": "ili_sari",
        "unit": "normalized sentinel index",
        "baseline_mean": 0.42,
        "baseline_sd": 0.16,
        "coverage": 0.90,
        "freshness_days": 2.0,
    },
    "wastewater_pathogen": {
        "label": "Wastewater pathogen",
        "source_type": "wastewater",
        "unit": "normalized concentration",
        "baseline_mean": 0.30,
        "baseline_sd": 0.15,
        "coverage": 0.82,
        "freshness_days": 3.0,
    },
    "clinical_cxr_aware": {
        "label": "CXR corroboration",
        "source_type": "cxr_aggregate",
        "unit": "aggregate corroboration index",
        "baseline_mean": 0.25,
        "baseline_sd": 0.12,
        "coverage": 0.0,
        "freshness_days": 7.0,
    },
    "news_trends_ai": {
        "label": "News/Trends by AI",
        "source_type": "osint_ai",
        "unit": "AI risk score",
        "baseline_mean": 0.20,
        "baseline_sd": 0.15,
        "coverage": 0.70,
        "freshness_days": 1.0,
    },
}

app.state.scoring_config = default_scoring_config()


def load_json(path: Path) -> Any:
    if path.exists():
        with open(path, "r", encoding="utf-8") as file:
            return json.load(file)
    return []


def list_snapshot_dates() -> list[str]:
    if not SNAPSHOT_DIR.exists():
        return []
    return sorted(path.stem for path in SNAPSHOT_DIR.glob("*.json"))


def resolve_snapshot_date(requested: str | None = None) -> str:
    available = list_snapshot_dates()
    if requested and requested in available:
        return requested
    if available:
        return available[-1]
    return "2026-03-15"


def load_snapshot(requested: str | None = None) -> list[dict[str, Any]]:
    snapshot_date = resolve_snapshot_date(requested)
    snapshot_path = SNAPSHOT_DIR / f"{snapshot_date}.json"
    if snapshot_path.exists():
        return load_json(snapshot_path)
    return load_json(MOCK_DIR / "mock_korea_alerts.json")


def load_global_signals() -> list[dict[str, Any]]:
    """Load every outbreak source — WHO DON + agency feeds + HealthMap + Gemini + news.

    Must stay in sync with `news_router.GLOBAL_SOURCE_FILES`. Falls back to
    mock dataset only if every source file is empty.
    """
    source_files = [
        "global_who_don.json",
        "global_cdc.json",
        "global_ecdc.json",
        "global_healthmap.json",
        "global_gemini_outbreak.json",
        "global_google_outbreak.json",
        "global_news.json",
        "global_kdca_outbreaks.json",
    ]
    results: list[dict] = []
    seen: set[str] = set()
    for fname in source_files:
        p = PROCESSED_DIR / fname
        if not p.exists():
            continue
        for item in load_json(p):
            iid = item.get("id")
            if iid and iid in seen:
                continue
            if iid:
                seen.add(iid)
            results.append(item)
    if not results:
        results = load_json(MOCK_DIR / "mock_global_signals.json")
    return results


def load_korea_news() -> list[dict[str, Any]]:
    p = PROCESSED_DIR / "korea_news.json"
    return load_json(p) if p.exists() else []


def load_trends(geo: str = "korea") -> dict[str, Any]:
    fname = "google_trends_kr.json" if geo == "korea" else "google_trends_global.json"
    p = PROCESSED_DIR / fname
    return load_json(p) if p.exists() else {}


def compute_epiweek(snapshot_date: str) -> str:
    dt = date_cls.fromisoformat(snapshot_date)
    iso_year, iso_week, _ = dt.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


def merge_scoring_config(base: dict, incoming: dict) -> dict:
    merged = deepcopy(base)
    for key, value in incoming.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key].update(value)
        else:
            merged[key] = value
    return merged


def build_signal_detail(
    signal_key: str,
    normalized_score: float | None,
    snapshot_date: str,
) -> dict[str, Any]:
    metadata = SIGNAL_METADATA[signal_key]
    baseline_mean = metadata["baseline_mean"]
    baseline_sd = metadata["baseline_sd"]
    value = None if normalized_score is None else round(float(normalized_score), 4)
    z_score = 0.0 if value is None else round((value - baseline_mean) / baseline_sd, 4)
    qc_flag = "missing" if value is None else "review" if metadata["coverage"] < 0.85 else "ok"
    return {
        "source_type": metadata["source_type"],
        "label": metadata["label"],
        "raw_value": value,
        "unit": metadata["unit"],
        "updated_at": snapshot_date,
        "coverage": metadata["coverage"],
        "freshness_days": metadata["freshness_days"],
        "qc_flag": qc_flag,
        "baseline_mean": baseline_mean,
        "baseline_sd": baseline_sd,
        "z_score": z_score,
        "normalized_score": value or 0.0,
        "algorithm_version": ALGORITHM_VERSION,
    }


def enrich_alert(raw_alert: dict[str, Any], config: dict | None = None) -> dict[str, Any]:
    config = config or app.state.scoring_config
    region_code = str(raw_alert.get("region_id") or raw_alert.get("region_code") or "")
    region = REGION_METADATA.get(region_code, {})
    snapshot_date = raw_alert.get("date") or resolve_snapshot_date()
    signal_details = {
        key: build_signal_detail(key, raw_alert.get("signals", {}).get(key), snapshot_date)
        for key in SIGNAL_METADATA
    }
    # Map news_trends_risk AI data into news_trends_ai signal if available
    ntr = raw_alert.get("news_trends_risk")
    if ntr and isinstance(ntr, dict) and ntr.get("score") is not None:
        ntr_score = float(ntr["score"])
        signal_details["news_trends_ai"] = build_signal_detail("news_trends_ai", ntr_score, snapshot_date)
    adjusted_signals = compute_quality_adjusted_signals(signal_details, config.get("weights"))
    score = compute_composite_score(adjusted_signals, config.get("weights"))
    level = score_to_level(score, config.get("level_thresholds"))
    enabled_keys = list(iter_enabled_signal_keys(config))
    enabled_signal_values = {key: adjusted_signals.get(key) for key in enabled_keys}
    active_sources = count_active_sources(enabled_signal_values, config.get("active_threshold"))
    independent_sources = count_independent_sources(enabled_signal_values, config.get("active_threshold"))
    data_quality = summarize_data_quality({key: signal_details[key] for key in enabled_keys})
    confidence = composite_confidence(independent_sources, max(len(enabled_keys), 1), data_quality["score"])
    explanation = build_explanation(enabled_signal_values, {key: signal_details[key] for key in enabled_keys}, config.get("active_threshold"))

    return {
        "region_code": region_code,
        "region_id": region_code,
        "region_name_en": region.get("en", raw_alert.get("region_name_en", "")),
        "region_name_kr": region.get("kr", raw_alert.get("region_name_kr", "")),
        "lat": region.get("lat", raw_alert.get("lat", 0.0)),
        "lng": region.get("lng", raw_alert.get("lng", 0.0)),
        "epiweek": compute_epiweek(snapshot_date),
        "pathogen": PATHOGEN,
        "score": score,
        "level": level,
        "active_sources": active_sources,
        "independent_sources": independent_sources,
        "confidence": confidence,
        "alert_explanation": explanation,
        "snapshot_date": snapshot_date,
        "algorithm_version": ALGORITHM_VERSION,
        "data_quality": data_quality,
        "signals": {key: signal_details[key]["normalized_score"] if signal_details[key]["raw_value"] is not None else None for key in SIGNAL_METADATA},
        "signal_details": signal_details,
        "source_type": "korea_respiratory_mvp",
        "date": snapshot_date,
        "explanation": explanation,
        "national_respiratory": {
            "level": level,
            "score": raw_alert.get("signals", {}).get("influenza_like", score),
            "details": {
                "influenza_rate": round((raw_alert.get("signals", {}).get("influenza_like") or 0.0) * 100, 1),
                "ari_cases": int(round((raw_alert.get("signals", {}).get("notifiable_disease") or 0.0) * 1000)),
                "sari_cases": int(round((raw_alert.get("signals", {}).get("influenza_like") or 0.0) * 500)),
            },
        },
        "regional_wastewater": {
            "covid19": {
                "level": score_to_level(raw_alert.get("signals", {}).get("wastewater_pathogen") or 0.0, config.get("level_thresholds")),
                "score": raw_alert.get("signals", {}).get("wastewater_pathogen") or 0.0,
            },
            "influenza": {
                "level": score_to_level((raw_alert.get("signals", {}).get("wastewater_pathogen") or 0.0) * 0.9, config.get("level_thresholds")),
                "score": round((raw_alert.get("signals", {}).get("wastewater_pathogen") or 0.0) * 0.9, 4),
            },
        },
    }


def load_enriched_snapshot(requested: str | None = None, config: dict | None = None) -> list[dict[str, Any]]:
    return [enrich_alert(alert, config=config) for alert in load_snapshot(requested)]


def find_region_match(region: str, alerts: list[dict[str, Any]]) -> dict[str, Any] | None:
    region_normalized = region.strip().lower()
    for alert in alerts:
        candidates = {
            alert["region_code"].lower(),
            alert["region_name_en"].lower(),
            alert["region_name_kr"].lower(),
        }
        if region_normalized in candidates:
            return alert
    return None


@app.get("/")
async def root() -> dict[str, str]:
    return {"message": "Sentinel Korea API is running"}


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/scoring/config", response_model=ScoringConfigModel)
async def get_scoring_config() -> dict[str, Any]:
    return app.state.scoring_config


@app.post("/scoring/config", response_model=ScoringConfigModel)
async def update_scoring_config(config: dict[str, Any], _: dict = Depends(require_admin)) -> dict[str, Any]:
    app.state.scoring_config = merge_scoring_config(app.state.scoring_config, config)
    return app.state.scoring_config


@app.get("/regions", response_model=list[RegionSummaryModel])
async def get_regions(date: str | None = Query(default=None)) -> list[dict[str, Any]]:
    alerts = load_enriched_snapshot(date)
    return [
        {
            "region_code": alert["region_code"],
            "region_name_en": alert["region_name_en"],
            "region_name_kr": alert["region_name_kr"],
            "score": alert["score"],
            "level": alert["level"],
            "confidence": alert["confidence"],
            "snapshot_date": alert["snapshot_date"],
        }
        for alert in alerts
    ]


@app.get("/alerts/korea", response_model=list[AlertResponseModel])
async def alerts_korea(date: str | None = Query(default=None)) -> list[dict[str, Any]]:
    return load_enriched_snapshot(date)


@app.get("/alerts/combined")
async def alerts_combined(date: str | None = Query(default=None)) -> dict[str, Any]:
    korea = load_enriched_snapshot(date)
    snapshot_date = resolve_snapshot_date(date)
    global_signals = load_global_signals()
    return {
        "korea": korea,
        "global": global_signals,
        "meta": {
            "generated_at": snapshot_date,
            "snapshot_date": snapshot_date,
            "algorithm_version": ALGORITHM_VERSION,
            "korea_regions": len(korea),
            "global_signals": len(global_signals),
        },
    }


@app.post("/alerts/korea/rescore", response_model=list[AlertResponseModel])
async def rescore_korea(
    config: dict[str, Any],
    date: str | None = Query(default=None),
    _: dict = Depends(require_admin),
) -> list[dict[str, Any]]:
    effective_config = merge_scoring_config(app.state.scoring_config, config)
    return load_enriched_snapshot(date, config=effective_config)


@app.get("/ingestion/status", response_model=IngestionStatusResponseModel)
async def get_ingestion_status() -> dict[str, Any]:
    latest_snapshot = resolve_snapshot_date()
    return {
        "latest_snapshot": latest_snapshot,
        "available_snapshots": list_snapshot_dates(),
        "sources": [
            {
                "source": "Notifiable Disease (KDCA API)",
                "status": "active",
                "latest_snapshot": latest_snapshot,
                "cadence": "weekly",
                "notes": "EIDAPI PeriodRegion supplies weekly all-notifiable national rows with domestic/imported values; Sentinel parses respiratory-related and respiratory-virus subsets, then validates totals with PeriodBasic.",
            },
            {
                "source": "KDCA ILI/SARI",
                "status": "active",
                "latest_snapshot": latest_snapshot,
                "cadence": "weekly",
                "notes": "Sentinel respiratory syndrome surveillance drives the syndromic signal.",
            },
            {
                "source": "KDCA wastewater",
                "status": "active",
                "latest_snapshot": latest_snapshot,
                "cadence": "weekly",
                "notes": "Wastewater remains a corroborating environmental signal, not a standalone diagnosis.",
            },
            {
                "source": "CXR_AWARE aggregate contract",
                "status": "planned",
                "latest_snapshot": latest_snapshot,
                "cadence": "future",
                "notes": "Only aggregate hospital AI summaries are planned; no raw image ingestion is expected.",
            },
        ],
    }


@app.get("/alerts/{region}", response_model=AlertResponseModel)
async def get_alert(region: str, date: str | None = Query(default=None)) -> dict[str, Any]:
    alerts = load_enriched_snapshot(date)
    match = find_region_match(region, alerts)
    if not match:
        raise HTTPException(status_code=404, detail="Region not found")
    return match


@app.get("/timeline/{region}", response_model=list[TimelinePointModel])
async def get_timeline(region: str) -> list[dict[str, Any]]:
    timeline: list[dict[str, Any]] = []
    for snapshot_date in list_snapshot_dates():
        alert = find_region_match(region, load_enriched_snapshot(snapshot_date))
        if alert:
            timeline.append(
                {
                    "snapshot_date": alert["snapshot_date"],
                    "epiweek": alert["epiweek"],
                    "score": alert["score"],
                    "level": alert["level"],
                    "confidence": alert["confidence"],
                }
            )
    if not timeline:
        raise HTTPException(status_code=404, detail="Region not found")
    return timeline


# Note: /config/keywords routes live in config_router.py — the previous
# duplicate definitions here used a different (incompatible) JSON shape and
# were unreachable because config_router is included first.
