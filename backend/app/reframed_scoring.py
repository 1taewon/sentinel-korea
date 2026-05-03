from __future__ import annotations

from copy import deepcopy
from typing import Iterable

SIGNAL_GROUPS = {
    "notifiable_disease": "case_surveillance",
    "influenza_like": "syndromic_surveillance",
    "wastewater_pathogen": "environmental_surveillance",
    "clinical_cxr_aware": "clinical_corroboration",
    "news_trends_ai": "open_source_intelligence",
}

DEFAULT_SCORING_CONFIG: dict = {
    "signals": {
        "notifiable_disease": {
            "label": "Notifiable Disease (KDCA API)",
            "description": "Respiratory activity from Notifiable Disease (KDCA API).",
            "source": "Notifiable Disease (KDCA API)",
            "enabled": True,
        },
        "influenza_like": {
            "label": "ILI/SARI",
            "description": "Weekly influenza-like illness and severe acute respiratory infection surveillance.",
            "source": "KDCA sentinel surveillance",
            "enabled": True,
        },
        "wastewater_pathogen": {
            "label": "Wastewater pathogen",
            "description": "Regional wastewater respiratory pathogen concentration trend.",
            "source": "KDCA wastewater surveillance",
            "enabled": True,
        },
        "clinical_cxr_aware": {
            "label": "CXR corroboration",
            "description": "Future aggregate-only hospital corroboration signal from internal AI summaries.",
            "source": "CXR_AWARE phase 3",
            "enabled": False,
        },
        "news_trends_ai": {
            "label": "News/Trends by AI",
            "description": "AI-analyzed risk signal from news articles and Google Trends data.",
            "source": "Gemini AI analysis of news + Google Trends",
            "enabled": False,
        },
    },
    "weights": {
        "notifiable_disease": 0.40,
        "influenza_like": 0.35,
        "wastewater_pathogen": 0.25,
        "clinical_cxr_aware": 0.00,
        "news_trends_ai": 0.20,
    },
    "active_threshold": 0.55,
    "level_thresholds": {
        "G3": 0.75,
        "G2": 0.55,
        "G1": 0.30,
        "G0": 0.0,
    },
    "formula": "quality_adjusted_signal = normalized_score x freshness_penalty x coverage_penalty; composite = sum(weight_i x quality_adjusted_signal_i)",
    "convergence_note": "Confidence increases when independent respiratory surveillance sources align and data quality remains healthy.",
}


def default_scoring_config() -> dict:
    return deepcopy(DEFAULT_SCORING_CONFIG)


def clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def score_to_level(score: float, thresholds: dict[str, float] | None = None) -> str:
    thresholds = thresholds or DEFAULT_SCORING_CONFIG["level_thresholds"]
    for level in sorted(thresholds, key=thresholds.get, reverse=True):
        if score >= thresholds[level]:
            return level
    return "G0"


def count_active_sources(signals: dict[str, float | None], threshold: float | None = None) -> int:
    threshold = threshold if threshold is not None else DEFAULT_SCORING_CONFIG["active_threshold"]
    return sum(1 for value in signals.values() if value is not None and value >= threshold)


def compute_quality_adjusted_signals(
    signal_details: dict[str, dict],
    weights: dict[str, float] | None = None,
) -> dict[str, float]:
    weights = weights or DEFAULT_SCORING_CONFIG["weights"]
    adjusted: dict[str, float] = {}
    for key, detail in signal_details.items():
        if weights.get(key, 0.0) <= 0:
            continue
        normalized = float(detail.get("normalized_score") or 0.0)
        coverage = clamp(float(detail.get("coverage") or 0.0))
        freshness_days = float(detail.get("freshness_days") or 0.0)
        freshness_penalty = clamp(1.0 - min(freshness_days, 7.0) / 10.0, 0.35, 1.0)
        coverage_penalty = clamp(coverage, 0.35, 1.0)
        adjusted[key] = round(clamp(normalized * freshness_penalty * coverage_penalty), 4)
    return adjusted


def compute_composite_score(
    signals: dict[str, float | None],
    weights: dict[str, float] | None = None,
) -> float:
    weights = weights or DEFAULT_SCORING_CONFIG["weights"]
    active_weights = {
        key: weight
        for key, weight in weights.items()
        if weight > 0 and signals.get(key) is not None
    }
    total_weight = sum(active_weights.values())
    if total_weight == 0:
        return 0.0
    score = sum((weight / total_weight) * float(signals[key] or 0.0) for key, weight in active_weights.items())
    return round(clamp(score), 4)


def count_independent_sources(
    signals: dict[str, float | None],
    threshold: float | None = None,
) -> int:
    threshold = threshold if threshold is not None else DEFAULT_SCORING_CONFIG["active_threshold"]
    active_groups = {
        SIGNAL_GROUPS[key]
        for key, value in signals.items()
        if value is not None and value >= threshold and key in SIGNAL_GROUPS
    }
    return len(active_groups)


def data_quality_score(signal_details: dict[str, dict]) -> float:
    quality_values = []
    for detail in signal_details.values():
        coverage = clamp(float(detail.get("coverage") or 0.0))
        freshness_days = float(detail.get("freshness_days") or 0.0)
        freshness_score = clamp(1.0 - min(freshness_days, 7.0) / 7.0, 0.0, 1.0)
        qc_flag = detail.get("qc_flag", "ok")
        qc_score = 1.0 if qc_flag == "ok" else 0.75 if qc_flag == "review" else 0.5
        quality_values.append((coverage + freshness_score + qc_score) / 3.0)
    if not quality_values:
        return 0.0
    return round(sum(quality_values) / len(quality_values), 4)


def composite_confidence(
    independent_sources: int,
    total_sources: int,
    quality_score: float = 1.0,
) -> str:
    if total_sources == 0:
        return "No Data"
    ratio = independent_sources / total_sources
    blended = (ratio * 0.7) + (quality_score * 0.3)
    if blended >= 0.75:
        return "High"
    if blended >= 0.55:
        return "Moderate"
    if blended >= 0.35:
        return "Low"
    return "Watch"


def build_explanation(
    signals: dict[str, float | None],
    signal_details: dict[str, dict] | None = None,
    threshold: float | None = None,
) -> list[str]:
    threshold = threshold if threshold is not None else DEFAULT_SCORING_CONFIG["active_threshold"]
    signal_details = signal_details or {}
    messages: list[str] = []

    if (signals.get("notifiable_disease") or 0.0) >= threshold:
        messages.append("Notifiable respiratory disease reports are running above the local baseline.")
    if (signals.get("influenza_like") or 0.0) >= threshold:
        messages.append("ILI/SARI surveillance shows elevated respiratory syndrome activity this week.")
    if (signals.get("wastewater_pathogen") or 0.0) >= threshold:
        messages.append("Wastewater pathogen concentration is elevated relative to the recent seasonal average.")
    if (signals.get("clinical_cxr_aware") or 0.0) >= threshold:
        messages.append("Aggregate hospital CXR corroboration indicates higher pneumonia burden.")

    independent_sources = count_independent_sources(signals, threshold)
    if independent_sources >= 3:
        messages.append("Three independent surveillance groups are aligned, which raises composite confidence.")
    elif independent_sources == 2:
        messages.append("Two independent surveillance groups are aligned, supporting a moderate-confidence signal.")

    degraded_sources = [
        detail.get("label", key)
        for key, detail in signal_details.items()
        if detail.get("freshness_days", 0) > 3 or float(detail.get("coverage", 1.0) or 0.0) < 0.75
    ]
    if degraded_sources:
        messages.append(
            "Confidence is tempered by data quality limits in: " + ", ".join(degraded_sources[:3]) + "."
        )

    if not messages:
        messages.append("Signals are near baseline and no independent convergence is currently detected.")
    return messages


def summarize_data_quality(signal_details: dict[str, dict]) -> dict:
    quality = data_quality_score(signal_details)
    if quality >= 0.8:
        label = "Good"
    elif quality >= 0.6:
        label = "Fair"
    else:
        label = "Limited"
    return {
        "score": quality,
        "label": label,
    }


def iter_enabled_signal_keys(config: dict) -> Iterable[str]:
    for key, signal in config.get("signals", {}).items():
        if signal.get("enabled"):
            yield key
