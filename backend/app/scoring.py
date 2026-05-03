"""
Sentinel Scoring Engine
-----------------------
Multi-source composite scoring with fully configurable parameters.

The scoring config is a single dict that describes:
  - which signals participate
  - their weights
  - the active-source threshold
  - the level boundaries

This config is exposed to the frontend so users can adjust
sensitivity in real-time (e.g. during a pandemic escalation).
"""

from __future__ import annotations

# ─── Default Scoring Configuration ───────────────────────
# This entire structure is served to the UI and can be modified there.
DEFAULT_SCORING_CONFIG: dict = {
    # Human-readable description of each signal source
    "signals": {
        "notifiable_disease": {
            "label": "Notifiable Disease (KDCA API)",
            "description": "Respiratory activity from Notifiable Disease (KDCA API).",
            "source": "KDCA API",
            "enabled": True,
        },
        "influenza_like": {
            "label": "인플루엔자 유사질환 (ILI/SARI)",
            "description": "인플루엔자 의사환자 분율 및 SARI 감시",
            "source": "KDCA 감시통계",
            "enabled": True,
        },
        "wastewater_pathogen": {
            "label": "폐하수 병원체 (Wastewater)",
            "description": "하수 내 호흡기 병원체 농도",
            "source": "KDCA 폐하수 감시",
            "enabled": True,
        },
        "clinical_cxr_aware": {
            "label": "CXR AI 감지 (CXR_AWARE)",
            "description": "병원 흉부 X선 AI 기반 폐렴 감지율",
            "source": "CXR_AWARE (Phase 3)",
            "enabled": False,  # Future slot
        },
    },
    # Weights — must sum to 1.0 for enabled signals
    # When CXR_AWARE is disabled, only the first 3 are used
    "weights": {
        "notifiable_disease": 0.40,
        "influenza_like": 0.30,
        "wastewater_pathogen": 0.30,
        "clinical_cxr_aware": 0.00,
    },
    # Weights when CXR_AWARE becomes active
    "weights_with_cxr": {
        "notifiable_disease": 0.30,
        "influenza_like": 0.25,
        "wastewater_pathogen": 0.25,
        "clinical_cxr_aware": 0.20,
    },
    # A signal is "active" if its value >= this threshold
    "active_threshold": 0.5,
    # Score → alert level mapping
    "level_thresholds": {
        "G3": 0.75,
        "G2": 0.55,
        "G1": 0.30,
        "G0": 0.0,
    },
    # Formula description (shown in UI)
    "formula": "Composite Score = Σ (weight_i × signal_i) for enabled signals",
    "convergence_note": "Multi-source convergence: when ≥2 independent sources exceed the active threshold simultaneously, confidence increases.",
}


# ─── Scoring Functions ───────────────────────────────────

def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def compute_composite_score(
    signals: dict[str, float | None],
    weights: dict[str, float] | None = None,
) -> float:
    """
    Weighted sum of signal values.
    Skips signals that are None (not yet connected).
    Auto-normalises weights to sum to 1.0 among active signals.
    """
    if weights is None:
        weights = DEFAULT_SCORING_CONFIG["weights"]

    active_weights = {}
    for key, val in signals.items():
        if val is not None and key in weights and weights[key] > 0:
            active_weights[key] = weights[key]

    total_weight = sum(active_weights.values())
    if total_weight == 0:
        return 0.0

    score = sum(
        (w / total_weight) * signals[key]
        for key, w in active_weights.items()
    )
    return round(clamp(score), 4)


def count_active_sources(
    signals: dict[str, float | None],
    threshold: float | None = None,
) -> int:
    """Count how many independent sources exceed the threshold."""
    if threshold is None:
        threshold = DEFAULT_SCORING_CONFIG["active_threshold"]
    return sum(
        1 for v in signals.values()
        if v is not None and v >= threshold
    )


def composite_confidence(active_sources: int, total_sources: int) -> str:
    """Multi-source convergence → confidence label."""
    if total_sources == 0:
        return "No Data"
    ratio = active_sources / total_sources
    if ratio >= 0.7:
        return "High Confidence"
    if ratio >= 0.5:
        return "Moderate Confidence"
    if ratio >= 0.3:
        return "Low Confidence"
    return "Watch"


def score_to_level(
    score: float,
    thresholds: dict[str, float] | None = None,
) -> str:
    """Map composite score to alert level using configurable thresholds."""
    if thresholds is None:
        thresholds = DEFAULT_SCORING_CONFIG["level_thresholds"]

    # Sort descending by threshold value
    for level in sorted(thresholds, key=thresholds.get, reverse=True):
        if score >= thresholds[level]:
            return level
    return "G0"


def build_explanation(
    signals: dict[str, float | None],
    threshold: float | None = None,
) -> list[str]:
    """Generate human-readable explanation of why this alert fired."""
    if threshold is None:
        threshold = DEFAULT_SCORING_CONFIG["active_threshold"]

    messages: list[str] = []

    if (signals.get("notifiable_disease") or 0) >= 0.6:
        messages.append("Notifiable Disease (KDCA API) activity is elevated against baseline.")
    if (signals.get("influenza_like") or 0) >= 0.6:
        messages.append("인플루엔자 유사질환 활동 상승 (ILI activity above baseline).")
    if (signals.get("wastewater_pathogen") or 0) >= threshold:
        messages.append("폐하수 병원체 농도 계절 평균 초과 (Wastewater pathogen above seasonal average).")
    if signals.get("clinical_cxr_aware") is not None and signals["clinical_cxr_aware"] >= threshold:
        messages.append("CXR AI가 폐렴 증가 감지 (Hospital CXR AI detected elevated pneumonia rate).")

    active = count_active_sources(signals, threshold)
    if active >= 3:
        messages.append(f"⚠️ {active}개 독립 소스 수렴 — 높은 복합 신뢰도 ({active} independent sources converging — high composite confidence).")
    elif active >= 2:
        messages.append(f"{active}개 독립 소스 수렴 — 보통 복합 신뢰도 ({active} sources converging — moderate composite confidence).")

    if not messages:
        messages.append("강한 개별 신호 없음, 복합 점수 기준선 근처 (No strong single signal, composite score near baseline).")
    return messages
