from __future__ import annotations

from pydantic import BaseModel


class SignalConfigModel(BaseModel):
    label: str
    description: str
    source: str
    enabled: bool


class ScoringConfigModel(BaseModel):
    signals: dict[str, SignalConfigModel]
    weights: dict[str, float]
    active_threshold: float
    level_thresholds: dict[str, float]
    formula: str
    convergence_note: str


class SignalDetailModel(BaseModel):
    source_type: str
    label: str
    raw_value: float | None
    unit: str
    updated_at: str
    coverage: float
    freshness_days: float
    qc_flag: str
    baseline_mean: float
    baseline_sd: float
    z_score: float
    normalized_score: float
    algorithm_version: str


class DataQualityModel(BaseModel):
    score: float
    label: str


class AlertResponseModel(BaseModel):
    region_code: str
    region_name_en: str
    region_name_kr: str
    lat: float
    lng: float
    epiweek: str
    pathogen: str
    score: float
    level: str
    active_sources: int
    independent_sources: int
    confidence: str
    alert_explanation: list[str]
    snapshot_date: str
    algorithm_version: str
    data_quality: DataQualityModel
    signals: dict[str, float | None]
    signal_details: dict[str, SignalDetailModel]
    source_type: str = "korea_respiratory_mvp"
    date: str | None = None
    explanation: list[str] | None = None


class RegionSummaryModel(BaseModel):
    region_code: str
    region_name_en: str
    region_name_kr: str
    score: float
    level: str
    confidence: str
    snapshot_date: str


class TimelinePointModel(BaseModel):
    snapshot_date: str
    epiweek: str
    score: float
    level: str
    confidence: str


class IngestionSourceStatusModel(BaseModel):
    source: str
    status: str
    latest_snapshot: str
    cadence: str
    notes: str


class IngestionStatusResponseModel(BaseModel):
    latest_snapshot: str
    available_snapshots: list[str]
    sources: list[IngestionSourceStatusModel]
