"""Sentinel Korea — Decision Intelligence functions.

Each function is a TYPED, READ-ONLY operation over the ontology. They are
the AIP layer that sits on top of the typed schema in `ontology_router.py`.

Layer separation:
  - Object/Link types (semantic)        → ontology_router.py
  - Decision functions (analytic)       → THIS FILE
  - Mutations (kinetic, refresh, etc.)  → upload_router / risk_analysis_router
                                          (NOT exposed in the ONTOLOGY tab —
                                          users go to PIPELINE tab for those)

A function's signature (inputs/output) is declarative so the same registry
serves three callers:
  1. Frontend Decision panel (typed POST body)
  2. Future AIP chat agent (LLM tool call)
  3. Future scheduled scorer (server-side cron)
"""

from __future__ import annotations

import json
import math
import os
import statistics
from dataclasses import dataclass, field
from datetime import date as _date
from pathlib import Path
from typing import Any, Callable

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PROCESSED_DIR = DATA_DIR / "processed"
SNAPSHOT_DIR = PROCESSED_DIR / "snapshots"


# ─── Function spec ──────────────────────────────────────────────────────────

@dataclass
class FunctionSpec:
    name: str
    label: str
    inputs: list[dict]                 # [{name, type, required, default, description}]
    output: str                        # textual type description
    affects_objects: list[str]         # which object types this informs
    requires_admin: bool               # true if it hits a paid API
    description: str
    fn: Callable[[dict], Any] = field(repr=False)


_REGISTRY: dict[str, FunctionSpec] = {}


def register(spec: FunctionSpec) -> None:
    _REGISTRY[spec.name] = spec


def get_spec(name: str) -> FunctionSpec | None:
    return _REGISTRY.get(name)


def list_specs() -> list[dict]:
    return [
        {
            "name": s.name,
            "label": s.label,
            "inputs": s.inputs,
            "output": s.output,
            "affects_objects": s.affects_objects,
            "requires_admin": s.requires_admin,
            "description": s.description,
        }
        for s in _REGISTRY.values()
    ]


# ─── Helpers ────────────────────────────────────────────────────────────────

def _load_json(path: Path) -> Any:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _level_for(score: float) -> str:
    if score >= 0.75:
        return "G3"
    if score >= 0.55:
        return "G2"
    if score >= 0.30:
        return "G1"
    return "G0"


def _region_history_points(region_id: str, weeks: int = 12) -> list[dict]:
    if not SNAPSHOT_DIR.exists():
        return []
    files = sorted(SNAPSHOT_DIR.glob("*.json"))
    files = files[-(weeks * 7):]
    out: list[dict] = []
    for path in files:
        records = _load_json(path) or []
        if not isinstance(records, list):
            continue
        match = next((r for r in records
                      if str(r.get("region_id") or r.get("region_code") or "") == region_id
                      or r.get("region_name_en") == region_id), None)
        if match:
            out.append({
                "date": path.stem,
                "score": match.get("score") or 0,
                "level": match.get("level") or "G0",
                "signals": match.get("signals") or {},
            })
    return out


def _latest_snapshot() -> tuple[str, list[dict]] | tuple[None, None]:
    if not SNAPSHOT_DIR.exists():
        return None, None
    files = sorted(SNAPSHOT_DIR.glob("*.json"))
    if not files:
        return None, None
    return files[-1].stem, _load_json(files[-1]) or []


def _all_outbreaks() -> list[dict]:
    files = ["global_who_don.json", "global_cdc.json", "global_ecdc.json",
             "global_healthmap.json", "global_gemini_outbreak.json",
             "global_google_outbreak.json", "global_news.json",
             "global_kdca_outbreaks.json"]
    out: list[dict] = []
    for f in files:
        data = _load_json(PROCESSED_DIR / f) or []
        if isinstance(data, list):
            out.extend(data)
    return out


def _korea_relevance(o: dict) -> float:
    sev = {"high": 0.6, "medium": 0.4, "low": 0.2}.get(o.get("severity") or "low", 0.2)
    is_resp = 0.25 if o.get("is_respiratory") else 0
    asia = 0.15 if any(k in (o.get("country") or "").lower()
                       for k in ["korea", "china", "japan", "vietnam", "taiwan",
                                 "philippines", "thailand", "hong kong"]) else 0
    return min(1.0, sev + is_resp + asia)


# ═════════════════════════════════════════════════════════════════════════════
# Function 1 — decomposeRegionScore
# ═════════════════════════════════════════════════════════════════════════════

# Heuristic weights — match the live composite scorer in spirit. These are
# what we use to APPORTION a region's score into per-signal contributions.
_SIGNAL_WEIGHTS = {
    "notifiable_disease":   0.28,
    "wastewater_pathogen":  0.24,
    "sari_pneumonia":       0.22,
    "sari_influenza":       0.12,
    "influenza_like":       0.08,
    "clinical_cxr_aware":   0.06,
}

_SIGNAL_LABELS = {
    "notifiable_disease":   "전수신고 감염병 활동도",
    "wastewater_pathogen":  "폐하수 병원체 농도",
    "sari_pneumonia":       "SARI · 폐렴",
    "sari_influenza":       "SARI · 인플루엔자",
    "influenza_like":       "ILI 의사환자분율",
    "clinical_cxr_aware":   "흉부 영상 양성률",
}


def _decompose_region_score(inputs: dict) -> dict:
    region_id = str(inputs.get("region_id") or "")
    if not region_id:
        return {"error": "region_id required"}

    snap_date, snap = _latest_snapshot()
    if not snap:
        return {"error": "no snapshots"}

    target = next((r for r in snap
                   if str(r.get("region_id") or r.get("region_code") or "") == region_id
                   or r.get("region_name_en") == region_id), None)
    if not target:
        return {"error": f"region {region_id} not found in latest snapshot"}

    signals = target.get("signals") or {}
    composite = target.get("score") or 0
    level = target.get("level") or _level_for(composite)

    # Per-signal weighted contribution
    contributions: list[dict] = []
    weight_sum = 0.0
    for k, w in _SIGNAL_WEIGHTS.items():
        v = signals.get(k)
        if v is None:
            continue
        try:
            v_num = float(v)
        except Exception:
            continue
        weight_sum += w
        contributions.append({
            "signal": k,
            "label": _SIGNAL_LABELS.get(k, k),
            "value": round(v_num, 4),
            "weight": w,
            "weighted_contribution": round(v_num * w, 4),
        })

    # Normalize so contributions sum to composite (informative breakdown,
    # not a re-scoring — just helps the operator see who's driving)
    total_weighted = sum(c["weighted_contribution"] for c in contributions) or 1
    for c in contributions:
        c["share_of_score"] = round(c["weighted_contribution"] / total_weighted, 4)

    contributions.sort(key=lambda c: c["weighted_contribution"], reverse=True)

    # Imported-risk contribution (top Outbreaks scored to korea relevance)
    top_imported = sorted(_all_outbreaks(), key=_korea_relevance, reverse=True)[:3]

    return {
        "region_id": region_id,
        "snapshot_date": snap_date,
        "composite_score": round(composite, 4),
        "level": level,
        "active_sources": target.get("active_sources"),
        "contributions": contributions,
        "top_imported_risk": [
            {
                "title": _clean_title(o.get("title") or ""),
                "country": o.get("country") or "",
                "severity": o.get("severity") or "low",
                "korea_relevance": round(_korea_relevance(o), 3),
                "url": o.get("url") or "",
                "publisher": o.get("publisher") or "",
            }
            for o in top_imported
        ],
        "narrative": _build_decomposition_narrative(level, contributions, top_imported),
    }


def _clean_title(title: str) -> str:
    """Strip trailing ellipsis / whitespace / dash from outbreak titles."""
    t = (title or "").strip()
    while t.endswith("...") or t.endswith("- ...") or t.endswith(" -") or t.endswith("…"):
        t = t.rstrip(".… -").strip()
    return t


def _build_decomposition_narrative(level: str, contributions: list[dict], imported: list[dict]) -> str:
    if not contributions:
        return "신호 데이터 부족 — KDCA 갱신 필요."
    top = contributions[0]
    second = contributions[1] if len(contributions) > 1 else None
    parts = [
        f"현재 {level} 등급의 가장 큰 기여 신호는 **{top['label']}** "
        f"({top['value']:.2f}, 점수의 {top['share_of_score']*100:.0f}%)."
    ]
    if second and second["share_of_score"] > 0.15:
        parts.append(f"보조적으로 **{second['label']}** ({second['value']:.2f})이 함께 상승 중.")
    if imported:
        top_imp = imported[0]
        country = top_imp.get('country', '')
        title = _clean_title(top_imp.get('title') or '')
        parts.append(f"해외 imported risk 1순위: {country} — {title}")
    return " ".join(parts)


register(FunctionSpec(
    name="decomposeRegionScore",
    label="Decompose region score",
    inputs=[{"name": "region_id", "type": "string", "required": True,
             "description": "Region.code (e.g. '11' for Seoul)"}],
    output="object<{contributions: list, top_imported_risk: list, narrative: string}>",
    affects_objects=["Region"],
    requires_admin=False,
    description="Break a Region's composite score into per-signal weighted contributions, "
                "plus the top 3 imported-risk outbreak candidates. Pure read; no side effects.",
    fn=_decompose_region_score,
))


# ═════════════════════════════════════════════════════════════════════════════
# Function 2 — forecastRegionScore (EMA + momentum + outbreak exogenous)
# ═════════════════════════════════════════════════════════════════════════════

def _forecast_region_score(inputs: dict) -> dict:
    region_id = str(inputs.get("region_id") or "")
    weeks = max(1, min(int(inputs.get("weeks") or 4), 12))
    if not region_id:
        return {"error": "region_id required"}

    history = _region_history_points(region_id, weeks=12)
    if not history:
        return {"error": f"no history for region {region_id}"}

    scores = [p["score"] for p in history if p.get("score") is not None]
    if not scores:
        return {"error": "history has no scores"}

    # EMA baseline (α tuned for ~3-week half-life)
    alpha = 0.4
    ema = scores[0]
    for s in scores[1:]:
        ema = alpha * s + (1 - alpha) * ema

    # Momentum: last 4 vs prior 4 windows
    if len(scores) >= 8:
        recent_avg = statistics.mean(scores[-4:])
        prior_avg = statistics.mean(scores[-8:-4])
        momentum = recent_avg - prior_avg
    elif len(scores) >= 4:
        recent_avg = statistics.mean(scores[-4:])
        prior_avg = statistics.mean(scores[: -4] or scores[:1])
        momentum = recent_avg - prior_avg
    else:
        momentum = 0

    # Outbreak-imported exogenous adjustment — small upward tilt if many
    # high-severity Korea-relevant outbreaks active
    outbreaks = _all_outbreaks()
    high_relevance = [o for o in outbreaks if _korea_relevance(o) >= 0.6]
    exo = min(0.05, len(high_relevance) * 0.005)   # cap +0.05

    # Volatility for confidence band — std dev of recent residuals from EMA
    residuals = []
    e = scores[0]
    for s in scores[1:]:
        residuals.append(s - e)
        e = alpha * s + (1 - alpha) * e
    vol = statistics.stdev(residuals) if len(residuals) > 1 else 0.1
    vol = max(0.04, min(0.20, vol))

    # Project N weeks forward — momentum decays, exo persists, band widens
    last_date = _date.fromisoformat(history[-1]["date"])
    points: list[dict] = []
    for i in range(1, weeks + 1):
        dt = last_date.fromordinal(last_date.toordinal() + i * 7)
        decayed_momentum = momentum * (0.7 ** (i - 1))
        proj = ema + decayed_momentum + exo
        proj = max(0.0, min(1.0, proj))
        band = vol * (1 + 0.25 * (i - 1))
        lo = max(0.0, proj - band)
        hi = min(1.0, proj + band)
        points.append({
            "date": dt.isoformat(),
            "weeks_ahead": i,
            "score": round(proj, 4),
            "level": _level_for(proj),
            "low": round(lo, 4),
            "high": round(hi, 4),
        })

    # Build narrative
    delta = points[-1]["score"] - (history[-1]["score"] or 0)
    direction = "상승" if delta > 0.05 else "하락" if delta < -0.05 else "유지"
    return {
        "region_id": region_id,
        "history": history,
        "forecast": points,
        "method": {
            "name": "EMA + Momentum + Outbreak Exogenous",
            "formula": "forecast[t+i] = EMA(α=0.4) + momentum × 0.7^(i-1) + outbreak_lift",
            "parameters": {
                "alpha": alpha,
                "momentum_decay": 0.7,
                "outbreak_lift_cap": 0.05,
                "confidence_band": "±(volatility × (1 + 0.25×(i-1)))",
            },
            "description_kr": "지수이동평균(EMA, α=0.4)으로 최근 값에 가중치를 두고, "
                              "최근 4주-이전 4주 평균 차이(momentum)를 0.7배씩 감쇄 적용합니다. "
                              "한국 관련 고위험 해외 outbreak가 있으면 최대 +0.05까지 상향 조정합니다. "
                              "신뢰구간은 EMA 잔차의 표준편차로 산출합니다.",
        },
        "ema_baseline": round(ema, 4),
        "momentum": round(momentum, 4),
        "outbreak_exogenous_lift": round(exo, 4),
        "volatility": round(vol, 4),
        "narrative": f"{weeks}주 후 예상 score {points[-1]['score']:.2f} ({points[-1]['level']}), "
                     f"현재 대비 {direction} (Δ {delta:+.2f}). "
                     f"momentum={momentum:+.2f}, outbreak lift=+{exo:.2f}.",
    }


register(FunctionSpec(
    name="forecastRegionScore",
    label="Forecast region score",
    inputs=[
        {"name": "region_id", "type": "string", "required": True,
         "description": "Region.code"},
        {"name": "weeks", "type": "integer", "required": False, "default": 4,
         "description": "Forecast horizon (1-12 weeks)"},
    ],
    output="object<{history, forecast: list<{date,score,level,low,high}>, narrative}>",
    affects_objects=["Region"],
    requires_admin=False,
    description="EMA + momentum + outbreak exogenous projection of a Region's composite score. "
                "Returns per-week point forecast with confidence band. No ML training — "
                "deterministic and runnable on minimal history.",
    fn=_forecast_region_score,
))


# ═════════════════════════════════════════════════════════════════════════════
# Function 3 — topRiskHotspots (forecast all regions, rank)
# ═════════════════════════════════════════════════════════════════════════════

def _top_risk_hotspots(inputs: dict) -> dict:
    weeks = max(1, min(int(inputs.get("weeks") or 4), 12))
    top_n = max(1, min(int(inputs.get("top_n") or 5), 17))

    snap_date, snap = _latest_snapshot()
    if not snap:
        return {"error": "no snapshots"}

    rows: list[dict] = []
    for r in snap:
        rid = str(r.get("region_id") or r.get("region_code") or "")
        if not rid:
            continue
        try:
            f = _forecast_region_score({"region_id": rid, "weeks": weeks})
            if "error" in f:
                continue
            # Multi-week progression: current + each forecast week
            progression = []
            for pt in f["forecast"]:
                progression.append({
                    "week": pt["weeks_ahead"],
                    "score": pt["score"],
                    "level": pt["level"],
                })
            last = f["forecast"][-1]
            rows.append({
                "region_id": rid,
                "name_kr": r.get("region_name_kr") or "",
                "name_en": r.get("region_name_en") or "",
                "current_score": r.get("score"),
                "current_level": r.get("level"),
                "projected_score": last["score"],
                "projected_level": last["level"],
                "delta": round(last["score"] - (r.get("score") or 0), 4),
                "progression": progression,
                "narrative": f["narrative"],
            })
        except Exception:
            continue

    rows.sort(key=lambda x: x["projected_score"], reverse=True)
    return {"weeks_ahead": weeks, "snapshot_date": snap_date,
            "hotspots": rows[:top_n], "total_regions": len(rows)}


register(FunctionSpec(
    name="topRiskHotspots",
    label="Top risk hotspots",
    inputs=[
        {"name": "weeks", "type": "integer", "required": False, "default": 4},
        {"name": "top_n", "type": "integer", "required": False, "default": 5},
    ],
    output="object<{hotspots: list<{region, projected_score, projected_level, delta}>}>",
    affects_objects=["Region", "Snapshot"],
    requires_admin=False,
    description="Run forecastRegionScore over every Region and rank the highest projected scores. "
                "Early warning leaderboard.",
    fn=_top_risk_hotspots,
))


# ═════════════════════════════════════════════════════════════════════════════
# Function 4 — regionRecommendations (Gemini-grounded on typed ontology state)
# ═════════════════════════════════════════════════════════════════════════════

def _region_recommendations(inputs: dict) -> dict:
    region_id = str(inputs.get("region_id") or "")
    if not region_id:
        return {"error": "region_id required"}

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return {"error": "GEMINI_API_KEY missing — recommendations need Gemini",
                "recommendations": []}

    decomposed = _decompose_region_score({"region_id": region_id})
    forecast = _forecast_region_score({"region_id": region_id, "weeks": 4})
    if "error" in decomposed:
        return {"error": decomposed["error"], "recommendations": []}

    # Build a TYPED, structured prompt grounding Gemini in ontology state
    prompt = f"""당신은 한국 호흡기 감염병 감시 시스템 Sentinel의 의사결정 보조 AI입니다.
다음은 특정 Region(시·도)의 현재 상태와 4주 예측입니다. 이 데이터에만 근거하여
의료/방역/커뮤니케이션 권고 3~5개를 우선순위별로 작성하세요.

## Region 현재 상태
- region_id: {region_id}
- snapshot_date: {decomposed.get('snapshot_date')}
- 현재 등급: {decomposed.get('level')}
- 종합 score: {decomposed.get('composite_score')}
- 활성 신호원: {decomposed.get('active_sources')}

## 신호별 기여도 (큰 순)
{json.dumps(decomposed.get('contributions', []), ensure_ascii=False, indent=2)}

## 해외 유입 위험 후보 (top 3)
{json.dumps(decomposed.get('top_imported_risk', []), ensure_ascii=False, indent=2)}

## 4주 예측
{json.dumps(forecast.get('forecast', []) if 'error' not in forecast else [], ensure_ascii=False, indent=2)}
- narrative: {forecast.get('narrative', '') if 'error' not in forecast else ''}

## 출력 규칙 (반드시 JSON 배열로만)
각 항목은 다음 키를 갖는 object:
- priority: "HIGH" | "MEDIUM" | "WATCH"
- action: 구체적 행동 (1문장, 50자 이내)
- reasoning: 위 데이터의 어느 신호/예측에 근거하는지 (1문장)
- audience: "의료" | "방역" | "커뮤니케이션" | "정책"

JSON 외 다른 텍스트(설명, 코드블록 마커 등) 금지. 배열 형태로만 시작·종료.
"""

    try:
        from google import genai
        client = genai.Client(api_key=api_key)
        model = os.getenv("RISK_ANALYSIS_MODEL") or os.getenv("GEMINI_MODEL") or "gemini-3.5-flash"
        resp = client.models.generate_content(model=model, contents=prompt)
        raw = (resp.text or "").strip()
    except Exception as e:
        return {"error": f"Gemini call failed: {type(e).__name__}: {e}",
                "recommendations": []}

    # Strip code-block markers if Gemini still adds them
    cleaned = raw
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()

    try:
        recs = json.loads(cleaned)
        if not isinstance(recs, list):
            raise ValueError("not a list")
    except Exception:
        return {"error": "Gemini returned non-JSON", "raw": raw[:600],
                "recommendations": []}

    return {
        "region_id": region_id,
        "snapshot_date": decomposed.get("snapshot_date"),
        "model": model,
        "recommendations": recs,
        "grounding": {
            "level": decomposed.get("level"),
            "score": decomposed.get("composite_score"),
            "top_signal": decomposed.get("contributions", [{}])[0].get("label", ""),
            "forecast_4w_score": forecast.get("forecast", [{}])[-1].get("score") if "error" not in forecast else None,
        },
    }


register(FunctionSpec(
    name="regionRecommendations",
    label="Region recommendations",
    inputs=[{"name": "region_id", "type": "string", "required": True,
             "description": "Region.code"}],
    output="object<{recommendations: list<{priority, action, reasoning, audience}>}>",
    affects_objects=["Region"],
    requires_admin=True,    # uses Gemini
    description="Gemini-grounded typed recommendations for a Region — read-only AIP. "
                "Prompt is built from decomposeRegionScore + forecastRegionScore output, "
                "so the LLM operates on TYPED ontology state, not free text.",
    fn=_region_recommendations,
))


# ═════════════════════════════════════════════════════════════════════════════
# Function 5 — forecastDiseaseTrend (EMA + seasonality-aware)
# ═════════════════════════════════════════════════════════════════════════════

# Disease → file mapping (mirrors ontology_router DISEASE_REGISTRY)
_DISEASE_FILES = {
    "influenza_ili": ("kdca_influenza_ili_weekly.json", "ili_index"),
    "sari_pneumonia": ("kdca_sari_pneumonia_weekly.json", "sari_pneumonia_cases"),
    "sari_influenza": ("kdca_sari_influenza_weekly.json", "sari_influenza_cases"),
    "ari_total": ("kdca_ari_weekly.json", "total"),
    "rsv": ("kdca_ari_weekly.json", "pathogens.호흡기세포융합바이러스"),
    "hmpv": ("kdca_ari_weekly.json", "pathogens.사람 메타뉴모바이러스"),
    "adenovirus": ("kdca_ari_weekly.json", "pathogens.아데노바이러스"),
    "covid19": ("kdca_ari_weekly.json", "pathogens.코로나19 바이러스"),
}


def _load_disease_series(disease_id: str) -> list[dict]:
    """Load time-series for a disease from KDCA JSON files."""
    info = _DISEASE_FILES.get(disease_id)
    if not info:
        return []
    fname, value_key = info
    data = _load_json(PROCESSED_DIR / fname)
    if not data or not isinstance(data, dict):
        return []
    records = data.get("records") or []
    out: list[dict] = []
    for rec in records:
        if rec.get("pending"):
            continue
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


def _forecast_disease_trend(inputs: dict) -> dict:
    disease_id = str(inputs.get("disease_id") or "")
    weeks = max(1, min(int(inputs.get("weeks") or 4), 12))
    if not disease_id:
        return {"error": "disease_id required"}

    series = _load_disease_series(disease_id)
    if not series:
        return {"error": f"No time-series data for disease '{disease_id}'"}

    values = [p["value"] for p in series]
    if len(values) < 3:
        return {"error": f"Insufficient data ({len(values)} points, need ≥3)"}

    # --- EMA (α = 0.35 for smoother disease curves)
    alpha = 0.35
    ema = values[0]
    for v in values[1:]:
        ema = alpha * v + (1 - alpha) * ema

    # --- Momentum: recent 4w vs prior 4w
    if len(values) >= 8:
        recent_avg = statistics.mean(values[-4:])
        prior_avg = statistics.mean(values[-8:-4])
        momentum = recent_avg - prior_avg
    elif len(values) >= 4:
        recent_avg = statistics.mean(values[-4:])
        prior_avg = statistics.mean(values[:-4] or values[:1])
        momentum = recent_avg - prior_avg
    else:
        momentum = 0

    # --- Volatility (std of residuals from EMA)
    residuals = []
    e = values[0]
    for v in values[1:]:
        residuals.append(v - e)
        e = alpha * v + (1 - alpha) * e
    vol = statistics.stdev(residuals) if len(residuals) > 1 else max(1, ema * 0.15)
    vol = max(1, vol)  # at least 1 unit
    # Evaluate this transparent benchmark on recent, unseen one-week origins.
    def _ema_one_step(train: list[float]) -> float:
        level = train[0]
        for value in train[1:]:
            level = alpha * value + (1 - alpha) * level
        if len(train) >= 8:
            drift = statistics.mean(train[-4:]) - statistics.mean(train[-8:-4])
        elif len(train) >= 4:
            drift = statistics.mean(train[-4:]) - statistics.mean(train[:-4] or train[:1])
        else:
            drift = 0.0
        return max(0.0, level + drift)

    validation_errors = [abs(_ema_one_step(values[:cut]) - values[cut])
                         for cut in range(max(8, len(values) - 6), len(values))]
    rolling_mae = round(float(statistics.mean(validation_errors)), 3) if validation_errors else None

    # --- Projection
    last_date = series[-1]["date"]
    try:
        ld = _date.fromisoformat(last_date)
    except Exception:
        ld = _date.today()

    points: list[dict] = []
    for i in range(1, weeks + 1):
        dt = ld.fromordinal(ld.toordinal() + i * 7)
        decayed_momentum = momentum * (0.7 ** (i - 1))
        proj = ema + decayed_momentum
        proj = max(0, proj)
        band = vol * (1 + 0.3 * (i - 1))
        lo = max(0, proj - band)
        hi = proj + band
        points.append({
            "date": dt.isoformat(),
            "weeks_ahead": i,
            "value": round(proj, 1),
            "low": round(lo, 1),
            "high": round(hi, 1),
        })

    # --- Peak detection
    peak_val = max(values)
    peak_idx = values.index(peak_val)
    peak_date = series[peak_idx]["date"] if peak_idx < len(series) else ""

    # --- Trend narrative
    delta = points[-1]["value"] - values[-1]
    pct = (delta / max(1, values[-1])) * 100
    direction = "상승" if pct > 10 else "하락" if pct < -10 else "유지"

    return {
        "disease_id": disease_id,
        "history": series,
        "forecast": points,
        "method": {
            "name": "EMA + Momentum Decay",
            "formula": "forecast[t+i] = EMA(α=0.35) + momentum × 0.7^(i-1)",
            "parameters": {
                "alpha": alpha,
                "momentum_decay": 0.7,
                "confidence_band": "±(volatility × (1 + 0.3×(i-1)))",
            },
            "description_kr": "지수이동평균(EMA)으로 최근 값에 가중치를 두고, "
                              "최근 4주와 이전 4주의 평균 차이(momentum)를 감쇄(0.7배/주)하여 "
                              "미래를 추정합니다. 신뢰구간은 과거 잔차의 표준편차로 계산합니다.",
        },
        "diagnostics": {"rolling_mae": rolling_mae, "validation_folds": len(validation_errors), "interval": "heuristic band; not calibrated coverage"},
        "ema_baseline": round(ema, 2),
        "momentum": round(momentum, 2),
        "volatility": round(vol, 2),
        "peak": {"date": peak_date, "value": peak_val},
        "narrative": f"{weeks}주 후 예상: {points[-1]['value']:.0f} (현재 {values[-1]:.0f}, "
                     f"{direction} {pct:+.0f}%). "
                     f"Peak: {peak_date} ({peak_val:.0f}).",
    }


register(FunctionSpec(
    name="forecastDiseaseTrend",
    label="Forecast disease trend (EMA)",
    inputs=[
        {"name": "disease_id", "type": "string", "required": True,
         "description": "Disease.id (e.g. 'influenza_ili', 'sari_pneumonia', 'rsv')"},
        {"name": "weeks", "type": "integer", "required": False, "default": 4,
         "description": "Forecast horizon (1-12 weeks)"},
    ],
    output="object<{history, forecast: list<{date,value,low,high}>, method, narrative}>",
    affects_objects=["Disease"],
    requires_admin=False,
    description="EMA + momentum-decay projection for a disease's weekly value. "
                "Returns history, forecast with confidence band, and methodology explanation. "
                "No external API needed — pure statistical computation.",
    fn=_forecast_disease_trend,
))


# ═════════════════════════════════════════════════════════════════════════════
# Function 6 — forecastDiseaseSARIMAX (statsmodels SARIMAX)
# ═════════════════════════════════════════════════════════════════════════════

def _forecast_disease_sarimax(inputs: dict) -> dict:
    """Walk-forward selected non-seasonal ARIMA forecast for weekly disease signals.

    The public function name remains for compatibility. The available 17--34 weekly
    observations cannot identify annual seasonality responsibly, so this function
    explicitly returns ARIMA rather than mislabelling a non-seasonal model SARIMAX.
    """
    disease_id = str(inputs.get("disease_id") or "")
    weeks = max(1, min(int(inputs.get("weeks") or 4), 12))
    if not disease_id:
        return {"error": "disease_id required"}
    series = _load_disease_series(disease_id)
    if not series:
        return {"error": f"No time-series data for disease '{disease_id}'"}
    if len(series) < 16:
        return {"error": f"Insufficient data for walk-forward ARIMA ({len(series)} points, need >= 16)",
                "disease_id": disease_id}

    values = [max(0.0, float(point["value"])) for point in series]
    try:
        import warnings
        import numpy as _np
        from statsmodels.tsa.statespace.sarimax import SARIMAX as _SARIMAX
        warnings.filterwarnings("ignore")

        candidates = ((0, 1, 1), (1, 1, 0), (1, 1, 1))
        holdouts = list(range(max(12, len(values) - 6), len(values)))
        candidate_mae: dict[str, float] = {}
        candidate_folds: dict[str, int] = {}
        for order in candidates:
            errors: list[float] = []
            for end_idx in holdouts:
                train = _np.log1p(_np.asarray(values[:end_idx], dtype=float))
                try:
                    fitted = _SARIMAX(
                        train, order=order, enforce_stationarity=False,
                        enforce_invertibility=False,
                    ).fit(disp=False, maxiter=100)
                    predicted = float(_np.expm1(fitted.get_forecast(steps=1).predicted_mean[0]))
                    errors.append(abs(max(0.0, predicted) - values[end_idx]))
                except Exception:
                    continue
            if errors:
                key = str(order)
                candidate_mae[key] = round(float(statistics.mean(errors)), 3)
                candidate_folds[key] = len(errors)
        if not candidate_mae:
            return {"error": "ARIMA walk-forward validation failed for every candidate", "disease_id": disease_id}

        selected_key = min(candidate_mae, key=candidate_mae.get)
        selected_order = next(order for order in candidates if str(order) == selected_key)
        fitted = _SARIMAX(
            _np.log1p(_np.asarray(values, dtype=float)), order=selected_order,
            enforce_stationarity=False, enforce_invertibility=False,
        ).fit(disp=False, maxiter=200)
        forecast = fitted.get_forecast(steps=weeks)
        mean_log = _np.asarray(forecast.predicted_mean).flatten()
        interval_log = _np.asarray(forecast.conf_int(alpha=0.10))

        try:
            last_date = _date.fromisoformat(series[-1]["date"])
        except Exception:
            last_date = _date.today()
        points: list[dict] = []
        for i in range(weeks):
            dt = last_date.fromordinal(last_date.toordinal() + (i + 1) * 7)
            value = max(0.0, float(_np.expm1(mean_log[i])))
            low = max(0.0, float(_np.expm1(interval_log[i, 0])))
            high = max(0.0, float(_np.expm1(interval_log[i, 1])))
            points.append({"date": dt.isoformat(), "weeks_ahead": i + 1,
                           "value": round(value, 1), "low": round(low, 1), "high": round(high, 1)})

        peak_value = max(values)
        peak_date = series[values.index(peak_value)]["date"]
        return {
            "warning": ("최근 관측값의 변화가 매우 작아 단기 예측의 식별력이 제한됩니다."
                        if len({round(value, 6) for value in values[-8:]}) <= 2 else None),            "disease_id": disease_id,
            "model_name": "ARIMA",
            "history": series,
            "forecast": points,
            "method": {
                "name": f"ARIMA{selected_order} (walk-forward selected)",
                "formula": "log1p(y) -> ARIMA(p,1,q) -> expm1 forecast",
                "parameters": {
                    "order": selected_order,
                    "transform": "log1p for non-negative, right-skewed weekly values",
                    "seasonality": "not fitted: fewer than 104 weekly observations",
                    "prediction_interval": "90% model interval; empirical coverage requires ongoing backtesting",
                },
                "validation": {
                    "scheme": "rolling-origin, one-week-ahead MAE",
                    "folds": candidate_folds[selected_key],
                    "selected_mae": candidate_mae[selected_key],
                    "candidate_mae": candidate_mae,
                },
                "description_kr": "짧은 주간 시계열에는 계절 SARIMAX를 과적합하지 않고, log1p 변환 ARIMA 후보를 최근 시점 롤링 검증 MAE로 선택합니다.",
            },
            "diagnostics": {
                "aic": round(float(fitted.aic), 1), "bic": round(float(fitted.bic), 1),
                "rolling_mae": candidate_mae[selected_key],
                "validation_folds": candidate_folds[selected_key], "candidate_mae": candidate_mae,
            },
            "peak": {"date": peak_date, "value": peak_value},
            "narrative": (f"[ARIMA walk-forward] {weeks}-week forecast: {points[-1]['value']:.0f} "
                          f"(latest {values[-1]:.0f}; rolling MAE {candidate_mae[selected_key]:.1f}, "
                          f"{candidate_folds[selected_key]} folds)."),
        }
    except Exception as exc:
        return {"error": f"ARIMA fitting failed: {type(exc).__name__}: {exc}", "disease_id": disease_id}

register(FunctionSpec(
    name="forecastDiseaseSARIMAX",
    label="Forecast disease trend (walk-forward ARIMA)",
    inputs=[
        {"name": "disease_id", "type": "string", "required": True,
         "description": "Disease.id"},
        {"name": "weeks", "type": "integer", "required": False, "default": 4,
         "description": "Forecast horizon (1-12 weeks)"},
    ],
    output="object<{history, forecast: list<{date,value,low,high}>, method, diagnostics, narrative}>",
    affects_objects=["Disease"],
    requires_admin=False,
    description="Walk-forward selected ARIMA forecast on log1p weekly values, with a 90% model interval. "
                "Uses >=16 points and reports rolling-origin validation MAE; compare against the transparent EMA benchmark.",
    fn=_forecast_disease_sarimax,
))


# ═════════════════════════════════════════════════════════════════════════════
# Function 7 — whatIfOutbreak  (scenario simulation + Gemini narrative)
# ═════════════════════════════════════════════════════════════════════════════

# Severity → exogenous score lift map
_SEVERITY_LIFT = {"low": 0.01, "medium": 0.025, "high": 0.05, "critical": 0.08}
# Proximity → multiplier (Asian neighbours are higher risk)
_PROXIMITY_MULT = {
    "china": 1.8, "japan": 1.5, "taiwan": 1.3, "vietnam": 1.2,
    "philippines": 1.1, "thailand": 1.1, "hong kong": 1.6,
    "north korea": 2.0, "mongolia": 1.0,
}


def _aviation_multiplier(country: str) -> dict | None:
    """Objective import-risk multiplier from real Incheon arriving-passenger volume.

    Used in place of the hardcoded _PROXIMITY_MULT when the "항공상황 add" toggle is
    on. Maps the aviation 0..1 score to the same ~0.5..2.0 range as the proxy so the
    downstream lift math is unchanged. Returns None (→ caller keeps the proxy) when
    the aviation file / matching country is unavailable.
    """
    data = _load_json(PROCESSED_DIR / "aviation_passenger_by_country.json")
    if not isinstance(data, dict):
        return None
    countries = data.get("countries") or {}
    c = (country or "").lower().strip()
    if not c:
        return None
    match = None
    for key, entry in countries.items():
        if key and (key in c or c in key):
            match = entry
            break
    if not match:
        return None
    score = float(match.get("score") or 0)
    return {
        "multiplier": round(0.5 + score * 1.5, 3),  # 0..1 score → 0.5..2.0 multiplier
        "arr_passengers": match.get("arr_passengers"),
        "country_kr": match.get("country_kr"),
        "month": data.get("month"),
    }


def _highway_mobility() -> dict:
    """Load the best available directed Korean mobility network.

    A multimodal file is used only when it has explicit corridors. Each mode retains
    its observation type in the source file; the simulator uses the combined OD shape
    but does not relabel schedule-capacity proxies as observed passenger counts.
    """
    multimodal = _load_json(PROCESSED_DIR / "multimodal_mobility_by_region.json")
    highway = _load_json(PROCESSED_DIR / "highway_connectivity_by_region.json")
    use_multimodal = isinstance(multimodal, dict) and bool(multimodal.get("corridors"))
    data = multimodal if use_multimodal else highway
    if not isinstance(data, dict):
        return {"connectivity": {}, "od_weights": {}, "od_volume": {}, "od_observation": {},
                "generated_at": None, "network_source": "unavailable", "mode_metadata": {}}

    regions = data.get("regions") or {}
    connectivity = {
        code: float(v.get("connectivity") or 0)
        for code, v in regions.items()
        if code in _SEIR_CODES and isinstance(v, dict)
    }
    od_weights: dict[tuple[str, str], float] = {}
    od_volume: dict[tuple[str, str], int] = {}
    od_observation: dict[tuple[str, str], str] = {}
    for edge in data.get("corridors") or []:
        if not isinstance(edge, dict):
            continue
        source, target = str(edge.get("source") or ""), str(edge.get("target") or "")
        if source not in _SEIR_CODES or target not in _SEIR_CODES or source == target:
            continue
        try:
            weight = max(0.0, float(edge.get("weight") or 0.0))
            volume = max(0, int(edge.get("traffic") or 0))
        except (TypeError, ValueError):
            continue
        if weight <= 0:
            continue
        pair = (source, target)
        od_weights[pair] = weight
        od_volume[pair] = volume
        edge_modes = edge.get("modes") or {}
        observations = [
            str(details.get("observation") or "")
            for details in edge_modes.values()
            if isinstance(details, dict)
        ] if isinstance(edge_modes, dict) else []
        od_observation[pair] = (
            "observed_od" if not observations or any(value.startswith("observed_") for value in observations)
            else observations[0]
        )

    mode_metadata = data.get("modes") or {}
    active_modes = [
        name for name, meta in mode_metadata.items()
        if isinstance(meta, dict) and bool(meta.get("corridors"))
    ]
    if use_multimodal and len(active_modes) > 1:
        network_source = "multimodal_od"
    elif use_multimodal and "highway" in active_modes:
        network_source = "highway_od"
    elif use_multimodal and "srt" in active_modes:
        network_source = "srt_od"
    elif use_multimodal and "korail" in active_modes:
        network_source = "korail_od"
    else:
        network_source = "highway_od"
    return {
        "connectivity": connectivity,
        "od_weights": od_weights,
        "od_volume": od_volume,
        "od_observation": od_observation,
        "generated_at": data.get("generated_at"),
        "network_source": network_source,
        "mode_metadata": mode_metadata,
    }

def _highway_connectivity() -> dict[str, float]:
    """Compatibility wrapper for callers that only need the regional index."""
    return _highway_mobility()["connectivity"]

def _weather_favorability() -> dict[str, float]:
    """Per-시도 respiratory-weather favorability (region_code → 0..1, cold+dry→higher).

    Used to weight seasonal transmissibility when the "기상상황 add" toggle is on —
    temperature is the dominant driver and absolute humidity carries the influenza
    seasonality mechanism (Shang 2026; Shaman 2009/2010). Returns {} when unavailable.
    """
    data = _load_json(PROCESSED_DIR / "weather_respiratory_by_region.json")
    if not isinstance(data, dict):
        return {}
    regions = data.get("regions") or {}
    return {
        code: float(v.get("favorability") or 0)
        for code, v in regions.items()
        if isinstance(v, dict)
    }


def _weather_favorability_live() -> dict[str, float]:
    """Fetch current KMA forecast weather LIVE (concurrent, ~2-3s) at scenario run-time,
    persist it to the cache (so the map layer benefits too), and return per-시도
    favorability. Falls back to the last cached value if the live fetch is unavailable
    (no WEATHER_API_KEY / API error)."""
    try:
        import importlib.util
        scripts_dir = Path(__file__).resolve().parent.parent / "scripts"
        spec = importlib.util.spec_from_file_location(
            "fetch_weather_stats", scripts_dir / "fetch_weather_stats.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        data = mod.fetch_weather_respiratory()
        if data.get("status") == "ok" and data.get("regions"):
            try:
                (PROCESSED_DIR / "weather_respiratory_by_region.json").write_text(
                    json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            except Exception:
                pass
            return {c: float(v.get("favorability") or 0)
                    for c, v in data["regions"].items() if isinstance(v, dict)}
    except Exception:
        pass
    return _weather_favorability()  # cache fallback


def _what_if_outbreak(inputs: dict) -> dict:
    region_id = str(inputs.get("region_id") or "")
    disease_name = str(inputs.get("disease") or "novel respiratory pathogen")
    country = str(inputs.get("country") or "China")
    severity = str(inputs.get("severity") or "high").lower()
    weeks = max(1, min(int(inputs.get("weeks") or 4), 12))

    if not region_id:
        return {"error": "region_id required"}

    # 1) Get BASELINE forecast (no extra outbreak)
    baseline = _forecast_region_score({"region_id": region_id, "weeks": weeks})
    if "error" in baseline:
        return {"error": baseline["error"]}

    # 2) Calculate hypothetical exogenous lift
    base_lift = _SEVERITY_LIFT.get(severity, 0.03)
    prox = _PROXIMITY_MULT.get(country.lower(), 0.5)
    hypo_lift = min(0.15, base_lift * prox)

    # 3) Re-project with added hypothetical lift
    history = baseline["history"]
    scores = [p["score"] for p in history if p.get("score") is not None]
    alpha = 0.4
    ema = scores[0]
    for s in scores[1:]:
        ema = alpha * s + (1 - alpha) * ema

    if len(scores) >= 8:
        momentum = statistics.mean(scores[-4:]) - statistics.mean(scores[-8:-4])
    elif len(scores) >= 4:
        momentum = statistics.mean(scores[-4:]) - statistics.mean(scores[:-4] or scores[:1])
    else:
        momentum = 0

    residuals = []
    e = scores[0]
    for s in scores[1:]:
        residuals.append(s - e)
        e = alpha * s + (1 - alpha) * e
    vol = statistics.stdev(residuals) if len(residuals) > 1 else 0.1
    vol = max(0.04, min(0.20, vol))

    # Original outbreak lift from real data
    outbreaks = _all_outbreaks()
    real_exo = min(0.05, len([o for o in outbreaks if _korea_relevance(o) >= 0.6]) * 0.005)

    # Scenario forecast = real exo + hypothetical lift
    total_exo = real_exo + hypo_lift
    last_date = _date.fromisoformat(history[-1]["date"])

    baseline_pts = baseline["forecast"]
    scenario_pts: list[dict] = []
    for i in range(1, weeks + 1):
        dt = last_date.fromordinal(last_date.toordinal() + i * 7)
        decayed_m = momentum * (0.7 ** (i - 1))
        proj = max(0.0, min(1.0, ema + decayed_m + total_exo))
        band = vol * (1 + 0.25 * (i - 1))
        scenario_pts.append({
            "date": dt.isoformat(),
            "weeks_ahead": i,
            "score": round(proj, 4),
            "level": _level_for(proj),
            "low": round(max(0, proj - band), 4),
            "high": round(min(1, proj + band), 4),
        })

    # Delta comparison
    comparison: list[dict] = []
    for b, s in zip(baseline_pts, scenario_pts):
        comparison.append({
            "weeks_ahead": b["weeks_ahead"],
            "baseline_score": b["score"],
            "baseline_level": b["level"],
            "scenario_score": s["score"],
            "scenario_level": s["level"],
            "delta": round(s["score"] - b["score"], 4),
            "level_changed": b["level"] != s["level"],
        })

    # 4) Gemini scenario narrative (if API key present)
    gemini_scenario = None
    api_key = os.getenv("GEMINI_API_KEY")
    if api_key:
        try:
            from google import genai
            client = genai.Client(api_key=api_key)
            model = os.getenv("RISK_ANALYSIS_MODEL") or os.getenv("GEMINI_MODEL") or "gemini-3.5-flash"

            snap_date = baseline.get("history", [{}])[-1].get("date", "")
            current_score = scores[-1] if scores else 0
            current_level = _level_for(current_score)

            prompt = f"""당신은 한국 호흡기 감염병 감시 시스템 Sentinel의 시나리오 분석 AI입니다.

## 가상 시나리오
- 발생 국가: {country}
- 질병: {disease_name}
- 심각도: {severity}
- 분석 대상 지역: region_id={region_id}

## 현재 상태 (기준일: {snap_date})
- 현재 score: {current_score:.3f} ({current_level})
- 현재 outbreak lift: +{real_exo:.3f}

## 시나리오 적용 후 변화
- 추가 exogenous lift: +{hypo_lift:.3f} (proximity×severity 기반)
- 총 outbreak lift: +{total_exo:.3f}
{json.dumps(comparison, ensure_ascii=False, indent=2)}

## 요청
위 시나리오를 기반으로 다음을 JSON으로 작성하세요:
1. "impact_summary": 이 시나리오가 해당 지역에 미치는 영향 요약 (2-3문장, 한국어)
2. "timeline": 주차별 예상 전개 시나리오 (각 주차에 어떤 일이 일어날 수 있는지, 배열)
3. "response_actions": 정책결정자가 취해야 할 선제 대응 조치 3-5개 (priority/action/timing 포함)
4. "risk_factors": 상황을 악화시킬 수 있는 추가 위험 요인 2-3개
5. "best_case": 최선의 시나리오 (1문장)
6. "worst_case": 최악의 시나리오 (1문장)

JSON 외 다른 텍스트 금지. 하나의 JSON object로만 응답.
"""
            resp = client.models.generate_content(model=model, contents=prompt)
            raw = (resp.text or "").strip()
            cleaned = raw
            if cleaned.startswith("```"):
                cleaned = cleaned.strip("`")
                if cleaned.startswith("json"):
                    cleaned = cleaned[4:]
                cleaned = cleaned.strip()
            try:
                gemini_scenario = json.loads(cleaned)
            except Exception:
                gemini_scenario = {"raw": raw[:800], "parse_error": True}
        except Exception as e:
            gemini_scenario = {"error": f"Gemini call failed: {type(e).__name__}: {e}"}

    return {
        "region_id": region_id,
        "scenario": {
            "disease": disease_name,
            "country": country,
            "severity": severity,
            "hypothetical_lift": round(hypo_lift, 4),
            "proximity_multiplier": round(prox, 2),
        },
        "baseline_forecast": baseline_pts,
        "scenario_forecast": scenario_pts,
        "comparison": comparison,
        "level_escalation": any(c["level_changed"] for c in comparison),
        "max_delta": round(max(c["delta"] for c in comparison), 4),
        "gemini_scenario": gemini_scenario,
        "narrative": f"가상 시나리오: {country}에서 {disease_name} ({severity}) 발생 시, "
                     f"region {region_id}의 score가 최대 +{max(c['delta'] for c in comparison):.3f} 상승 예상. "
                     f"{'G-level 상향 가능!' if any(c['level_changed'] for c in comparison) else 'G-level 변동 없음.'}",
    }


register(FunctionSpec(
    name="whatIfOutbreak",
    label="What-if outbreak simulation",
    inputs=[
        {"name": "region_id", "type": "string", "required": True,
         "description": "Region.code (e.g. '11' for Seoul)"},
        {"name": "disease", "type": "string", "required": False, "default": "novel respiratory pathogen",
         "description": "Hypothetical disease name"},
        {"name": "country", "type": "string", "required": False, "default": "China",
         "description": "Country of origin"},
        {"name": "severity", "type": "string", "required": False, "default": "high",
         "description": "low | medium | high | critical"},
        {"name": "weeks", "type": "integer", "required": False, "default": 4,
         "description": "Forecast horizon"},
    ],
    output="object<{baseline_forecast, scenario_forecast, comparison, gemini_scenario, narrative}>",
    affects_objects=["Region"],
    requires_admin=True,  # Gemini call
    description="What-if scenario: 'If outbreak X hits country Y, what happens to Region Z?' "
                "Compares baseline forecast vs scenario forecast with added exogenous lift. "
                "Gemini generates a full scenario narrative including timeline, response actions, "
                "risk factors, and best/worst case outcomes for policy decision-makers.",
    fn=_what_if_outbreak,
))


# ═════════════════════════════════════════════════════════════════════════════
# Function 7b — whatIfOutbreakNational (all-region spread from airport entry)
# ═════════════════════════════════════════════════════════════════════════════

# Airport entry points with primary-zone regions
_ENTRY_POINTS = {
    "ICN": {
        "label": "인천국제공항",
        "label_en": "Incheon International Airport",
        "primary_zones": ["11", "28", "41"],  # Seoul, Incheon, Gyeonggi (수도권)
        "lat": 37.4602, "lng": 126.4407,
    },
    "PUS": {
        "label": "김해국제공항",
        "label_en": "Gimhae International Airport",
        "primary_zones": ["26", "48"],  # Busan, Gyeongnam
        "lat": 35.1796, "lng": 128.9382,
    },
}

_REGION_COORDS = {
    "11": {"name": "서울", "lat": 37.5665, "lng": 126.9780},
    "26": {"name": "부산", "lat": 35.1796, "lng": 129.0756},
    "27": {"name": "대구", "lat": 35.8714, "lng": 128.6014},
    "28": {"name": "인천", "lat": 37.4563, "lng": 126.7052},
    "29": {"name": "광주", "lat": 35.1595, "lng": 126.8526},
    "30": {"name": "대전", "lat": 36.3504, "lng": 127.3845},
    "31": {"name": "울산", "lat": 35.5384, "lng": 129.3114},
    "36": {"name": "세종", "lat": 36.4800, "lng": 127.2890},
    "41": {"name": "경기", "lat": 37.2750, "lng": 127.0094},
    "42": {"name": "강원", "lat": 37.8228, "lng": 128.1555},
    "43": {"name": "충북", "lat": 36.6357, "lng": 127.4917},
    "44": {"name": "충남", "lat": 36.5184, "lng": 126.8000},
    "45": {"name": "전북", "lat": 35.7175, "lng": 127.1530},
    "46": {"name": "전남", "lat": 34.8161, "lng": 126.4629},
    "47": {"name": "경북", "lat": 36.4919, "lng": 128.8889},
    "48": {"name": "경남", "lat": 35.4606, "lng": 128.2132},
    "50": {"name": "제주", "lat": 33.4890, "lng": 126.4983},
}


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance between two points in km."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _spread_multiplier(region_code: str, entry_point: dict) -> float:
    """Compute spread multiplier for a region based on distance from entry point.

    Primary zones: 1.0 (full lift)
    Others: exponential decay based on distance from nearest primary zone region.
    Minimum: 0.15 (even remote regions have some baseline risk from travel/logistics).
    """
    if region_code in entry_point["primary_zones"]:
        return 1.0

    rc = _REGION_COORDS.get(region_code)
    if not rc:
        return 0.15

    # Distance from the nearest primary zone region
    min_dist = float("inf")
    for pz_code in entry_point["primary_zones"]:
        pz = _REGION_COORDS.get(pz_code)
        if pz:
            d = _haversine_km(rc["lat"], rc["lng"], pz["lat"], pz["lng"])
            min_dist = min(min_dist, d)

    if min_dist == float("inf"):
        return 0.15

    # Exponential decay: e^(-d/150) — halves at ~100km, floor at 0.15
    decay = math.exp(-min_dist / 150.0)
    return max(0.15, decay)


# ── Metapopulation SEIR+D outbreak model ────────────────────────────────────
# A real epidemiological simulator (replaces the abstract risk-score lift). Grounded
# in the GLEAM / gravity-metapopulation literature (Balcan 2009 PNAS; Chang 2020
# Nature; Flight-SEIR Ding 2020; Han 2025 Sci Rep). Day 0 = an imported outbreak from
# ZERO — only the entry 시도 is seeded; every other region starts fully susceptible.
# Emits real numbers per 시도: cases, deaths, attack rate, effective CFR.
_TIMELINE_DAYS = (0, 3, 7, 10, 14, 21, 28)

_SEIR_CODES = ["11", "26", "27", "28", "29", "30", "31", "36", "41", "42", "43", "44", "45", "46", "47", "48", "50"]
# 행정안전부 주민등록 인구 2026-06 (합계 51,091,769)
_SEIR_POP = {
    "11": 9289813, "26": 3232370, "27": 2348165, "28": 3061002, "29": 1385460,
    "30": 1442034, "31": 1087089, "36": 390923, "41": 13761783, "42": 1507217,
    "43": 1600787, "44": 2138785, "45": 1718633, "46": 1773646, "47": 2495919,
    "48": 3195351, "50": 662792,
}
_SEIR_TOTAL_POP = 51091769
# Per-region connectivity weight (hub/airport/rail) used when 교통상황 add is off.
_SEIR_CONN_DEFAULT = {c: 0.5 for c in _SEIR_CODES}
_SEIR_CONN_DEFAULT.update({"11": 1.0, "28": 1.0, "41": 0.9, "26": 0.8, "50": 0.7, "27": 0.6, "48": 0.6})

# How the simulation blends its inputs — surfaced verbatim to the UI so the "데이터 출처"
# panel never hardcodes numbers that could drift from the model.
#   OD_BLEND_OBSERVED: observed-OD share where a corridor is measured (rest = gravity fill);
#     mirrors _build_seir_conn(od_blend=0.7).
#   CONN_MARGINAL_WEIGHTS: how region connectivity is built from modal activity in
#     fetch_multimodal_mobility._region_connectivity (road/rail/air marginals).
OD_BLEND_OBSERVED = 0.7
CONN_MARGINAL_WEIGHTS = {"road": 0.60, "rail": 0.25, "air": 0.15}
# Per-mode display metadata: label + whether the mode feeds pairwise OD edges or the
# region-connectivity marginal that shapes the gravity fill.
_MODE_DISPLAY = {
    "highway":         {"label": "고속도로 OD",        "role": "od_edge",  "modal": "road"},
    "srt":             {"label": "SRT 노선",           "role": "od_edge",  "modal": "rail"},
    "domestic_flight": {"label": "국내선 항공(운항)",   "role": "od_edge",  "modal": "air"},
    "korail_marginal": {"label": "KORAIL 역별 승하차", "role": "conn_marginal", "modal": "rail"},
    "air_marginal":    {"label": "공항 예상 여객",      "role": "conn_marginal", "modal": "air"},
}


def _build_data_sources(*, network_source: str, traffic_source: str, observed_only: bool,
                        use_traffic: bool, use_weather: bool, weather_source: str,
                        use_aviation: bool, aviation_source: str,
                        mode_metadata: dict, generated_at: Any, od_pairs: int) -> dict:
    """A truthful, runtime-derived summary of what fed THIS simulation — every modal
    status is read from the live mode metadata, never hardcoded, so the UI shows only
    what was actually collected and reflected."""
    modes = []
    for key, disp in _MODE_DISPLAY.items():
        meta = mode_metadata.get(key) if isinstance(mode_metadata, dict) else None
        meta = meta if isinstance(meta, dict) else {}
        status = meta.get("status", "unavailable")
        corridors = meta.get("corridors")
        regions = meta.get("regions")
        # A mode is "reflected" only when traffic is on, it succeeded, and it produced
        # something the model consumes (OD corridors, or connectivity-shaping regions).
        reflected = bool(
            use_traffic and status == "ok"
            and ((disp["role"] == "od_edge" and (corridors or 0) > 0)
                 or (disp["role"] == "conn_marginal" and (regions or 0) > 0))
        )
        modes.append({
            "key": key, "label": disp["label"], "role": disp["role"], "modal": disp["modal"],
            "status": status, "reflected": reflected,
            "corridors": corridors, "regions": regions,
            "reason": meta.get("reason"),
            "conn_weight": CONN_MARGINAL_WEIGHTS.get(disp["modal"]) if disp["role"] == "conn_marginal" else None,
        })
    return {
        "traffic_on": use_traffic,
        "network_source": network_source,       # multimodal_od / highway_od / baseline_gravity …
        "traffic_source": traffic_source,
        "observed_only": observed_only,          # True → observed corridors blended with gravity floor
        "od_pairs": od_pairs,                    # measured directed OD pairs feeding the blend
        "od_blend_observed": OD_BLEND_OBSERVED,  # observed share on measured corridors
        "conn_marginal_weights": CONN_MARGINAL_WEIGHTS,
        "generated_at": generated_at,
        "weather_source": weather_source,
        "aviation_source": aviation_source if use_aviation else "off",
        "modes": modes,
    }

# Disease -> (R0, CFR, incubation_days, infectious_days). Representative literature
# point values (WHO/CDC-level). Used as the editable BASE; an unrecognised free-text
# disease falls back to DEFAULT and the user sets the parameters directly (신종감염병).
# Order matters — first substring match wins, so specific strains precede the generic
# "influenza"/"covid" (e.g. "H5N1 Avian Influenza" must hit h5n1, not influenza).
_DISEASE_TABLE = {
    "h5n1":     {"r0": 1.8,  "cfr": 0.30,  "inc": 3.0,  "inf": 5.0,   "aliases": ["avian", "bird flu", "조류독감", "고병원성", "h5"]},
    "h7n9":     {"r0": 1.5,  "cfr": 0.39,  "inc": 4.0,  "inf": 6.0,   "aliases": ["h7n9", "h7"]},
    "sars":     {"r0": 3.0,  "cfr": 0.10,  "inc": 5.0,  "inf": 7.0,   "aliases": ["sars-cov-1", "사스"]},
    "mers":     {"r0": 0.9,  "cfr": 0.34,  "inc": 5.0,  "inf": 7.0,   "aliases": ["mers-cov", "메르스"]},
    "measles":  {"r0": 15.0, "cfr": 0.002, "inc": 12.0, "inf": 8.0,   "aliases": ["홍역", "rubeola"]},
    "rsv":      {"r0": 1.5,  "cfr": 0.005, "inc": 4.0,  "inf": 7.0,   "aliases": ["호흡기세포융합"]},
    "covid19":  {"r0": 2.5,  "cfr": 0.010, "inc": 5.0,  "inf": 6.0,   "aliases": ["covid", "sars-cov-2", "코로나", "코로나19"]},
    "influenza": {"r0": 1.4, "cfr": 0.001, "inc": 2.0,  "inf": 4.0,   "aliases": ["flu", "독감", "인플루엔자", "seasonal"]},
}
_DEFAULT_DISEASE = {"r0": 2.5, "cfr": 0.02, "inc": 5.0, "inf": 6.0}
# Severity is a response-priority label only. Transmission and fatality are explicit inputs.
_SEVERITY_LEVELS = {"low", "medium", "high", "critical"}


def _resolve_disease(name: str) -> tuple[str, dict]:
    """Match a free-text disease name to a preset. Unknown/novel -> ('', DEFAULT)."""
    low = (name or "").lower()
    for canon, d in _DISEASE_TABLE.items():
        if canon in low:
            return canon, d
        for a in d["aliases"]:
            if a and a.lower() in low:
                return canon, d
    return "", _DEFAULT_DISEASE


def _build_seir_conn(conn_list: list[float],
                     od_weights: dict[tuple[str, str], float] | None = None,
                     observed_only: bool = False,
                     isolate_unobserved: bool = False,
                     od_blend: float = 0.7) -> list[list[float]]:
    """Incoming mobility matrix C[i][j] (target i, source j), each row summing to 1.

    Two OD-calibration behaviours (selected per run for the comparison view):
    - **blended (default, realistic)** — where a target has observed inbound OD it is
      blended with the gravity baseline (observed share = ``od_blend``); where it has no
      observation the gravity baseline is used. No region is isolated, because real
      Korean interregional travel is never exactly zero. This is the standard treatment
      when only a sparse OD sample is available (observed corridors + gravity fill).
    - **isolate_unobserved=True** — a target with no observed inbound keeps its exposure
      local (C[i][i]=1) and observed targets use their raw observed mix only. This is the
      "measured-OD only, invent nothing" variant shown alongside for comparison.

    Without measured OD (observed_only=False) a documented gravity/hub baseline is used.
    """
    n = len(_SEIR_CODES)
    coords = [(_REGION_COORDS[c]["lat"], _REGION_COORDS[c]["lng"]) for c in _SEIR_CODES]
    pops = [float(_SEIR_POP[c]) for c in _SEIR_CODES]
    C = [[0.0] * n for _ in range(n)]
    od_weights = od_weights or {}

    for i in range(n):
        gravity = []
        observed = []
        for j in range(n):
            if i == j:
                gravity.append(0.0)
                observed.append(0.0)
                continue
            distance = max(_haversine_km(coords[i][0], coords[i][1], coords[j][0], coords[j][1]), 10.0)
            gravity.append(pops[j] / (distance * distance) * max(conn_list[j], 0.01))
            observed.append(max(0.0, od_weights.get((_SEIR_CODES[j], _SEIR_CODES[i]), 0.0)))

        gravity_total = sum(gravity) or 1.0
        gravity = [value / gravity_total for value in gravity]
        observed_total = sum(observed)

        if not observed_only:
            C[i] = gravity
        elif observed_total > 0:
            obs = [value / observed_total for value in observed]
            if isolate_unobserved:
                C[i] = obs  # measured-OD only
            else:
                mixed = [od_blend * obs[j] + (1.0 - od_blend) * gravity[j] for j in range(n)]
                total = sum(mixed) or 1.0
                C[i] = [value / total for value in mixed]  # observed + gravity floor
        elif isolate_unobserved:
            C[i][i] = 1.0  # no observation → isolate (comparison variant)
        else:
            C[i] = gravity  # no observation → gravity fill (realistic)
    return C

def _epi_level(spread_score: float) -> str:
    """Map-color level from the infection-intensity score (so the map visibly lights up
    as regions get hit within the 28-day window; the table shows the real attack rate)."""
    if spread_score >= 0.66:
        return "G3"
    if spread_score >= 0.33:
        return "G2"
    if spread_score >= 0.08:
        return "G1"
    return "G0"


def _simulate_outbreak(entry_idx: int, r0_eff: float, cfr: float, inc_days: float, inf_days: float,
                       conn_list: list[float], seed_count: float, weather_fav: dict, use_weather: bool,
                       mobility: float = 0.10, weather_intensity: float = 0.3,
                       od_weights: dict[tuple[str, str], float] | None = None,
                       od_observation: dict[tuple[str, str], str] | None = None,
                       access_prior: dict[str, float] | None = None,
                       observed_only: bool = False,
                       isolate_unobserved: bool = False,
                       days: int = 28) -> tuple[dict, list, list, list]:
    """Daily discrete-time metapopulation SEIR+D over the 17 시도.

    C[i][j] is a normalized incoming mobility mix, so m is the share of exposure
    pressure attributed to interregional mixing. The returned edge events attribute
    imported exposures to their source region; they drive the map animation and are
    not mistaken for observed case-contact tracing.
    """
    n = len(_SEIR_CODES)
    Npop = [float(_SEIR_POP[c]) for c in _SEIR_CODES]
    sigma = 1.0 / max(inc_days, 0.5)
    gamma = 1.0 / max(inf_days, 0.5)
    beta_base = r0_eff * gamma
    m = max(0.0, min(0.4, mobility))
    od_weights = od_weights or {}
    od_observation = od_observation or {}
    C = _build_seir_conn(conn_list, od_weights, observed_only=observed_only,
                         isolate_unobserved=isolate_unobserved)
    # In the isolate-unobserved variant the expressway sample has no outbound row for
    # Incheon Airport's region, so add a separately-labelled airport-access bridge to the
    # capital area rather than an all-country radial route. The blended (default) variant
    # does not need this: the gravity floor already connects Incheon to Seoul/Gyeonggi.
    access_prior = access_prior or {}
    entry_code = _SEIR_CODES[entry_idx]
    entry_has_observed_outbound = any(source == entry_code for source, _ in od_weights)
    access_pairs: set[tuple[str, str]] = set()
    if observed_only and isolate_unobserved and access_prior and not entry_has_observed_outbound:
        for target_code, bridge_share in access_prior.items():
            if target_code not in _SEIR_CODES or target_code == entry_code:
                continue
            target_idx = _SEIR_CODES.index(target_code)
            share = max(0.0, min(0.5, float(bridge_share)))
            if not share:
                continue
            C[target_idx] = [value * (1.0 - share) for value in C[target_idx]]
            C[target_idx][entry_idx] += share
            access_pairs.add((entry_code, target_code))
    S = list(Npop); E = [0.0] * n; I = [0.0] * n; R = [0.0] * n; D = [0.0] * n; cum = [0.0] * n
    seed = min(max(1.0, seed_count), S[entry_idx])
    I[entry_idx] += seed; S[entry_idx] -= seed; cum[entry_idx] = seed
    weather_window = 10
    snaps: dict = {}
    day_onsets = [0.0] * n
    day_onsets[entry_idx] = seed
    daily_new: list = [(0, seed)]
    transmission_edges: list[dict] = []

    for d in range(days + 1):
        rows = []
        for i in range(n):
            cc = cum[i]
            ar = cc / Npop[i] if Npop[i] else 0.0
            ecfr = (D[i] / cc) if cc > 0 else 0.0
            prev = I[i] / Npop[i] if Npop[i] else 0.0
            spread = 1.0 - math.exp(-(1500.0 * prev + 12.0 * ar))
            rows.append({
                "i": i, "day": d,
                "cumulative_cases": int(round(cc)),
                "new_cases": max(0, int(round(day_onsets[i]))),
                "cumulative_deaths": int(round(D[i])),
                "attack_rate": round(ar, 6),
                "effective_cfr": round(ecfr, 4),
                "score": round(spread, 4),
                "level": _epi_level(spread),
            })
        snaps[d] = rows
        if d == days:
            break

        nS = list(S); nE = list(E); nI = list(I); nR = list(R); nD = list(D)
        next_onsets = [0.0] * n
        edge_events_today: list[dict] = []
        for i in range(n):
            beta_i = (beta_base * (1.0 + weather_intensity * weather_fav.get(_SEIR_CODES[i], 0.0))
                      if (use_weather and d <= weather_window) else beta_base)
            local_lambda = (1.0 - m) * beta_i * I[i] / Npop[i] if Npop[i] else 0.0
            imported_lambdas = [
                m * beta_i * C[i][j] * (I[j] / Npop[j] if Npop[j] else 0.0)
                for j in range(n)
            ]
            lam = local_lambda + sum(imported_lambdas)
            raw_exposed = lam * S[i]
            ne = min(raw_exposed, S[i])
            scale = ne / raw_exposed if raw_exposed > 0 else 0.0
            ni = min(sigma * E[i], E[i])
            li = min(gamma * I[i], I[i])
            nd = cfr * li; nr = li - nd
            nS[i] = max(0.0, S[i] - ne)
            nE[i] = max(0.0, E[i] + ne - ni)
            nI[i] = max(0.0, I[i] + ni - li)
            nR[i] = R[i] + nr; nD[i] = D[i] + nd
            cum[i] += ni
            next_onsets[i] = ni

            for j, imported_lambda in enumerate(imported_lambdas):
                exposure = imported_lambda * S[i] * scale
                # Low absolute floor (not a share of the seed's exposure): the seed's flow
                # dwarfs secondary hops, so a relative-to-max floor would suppress exactly
                # the secondary sources we want to surface once regions start re-exporting.
                if i != j and exposure >= 0.002:
                    edge_events_today.append({
                        "day": d + 1,
                        "source": _SEIR_CODES[j],
                        "target": _SEIR_CODES[i],
                        "expected_exposures": round(exposure, 4),
                        "mobility_weight": round(C[i][j], 5),
                        "mobility_source": (
                            "airport_access_prior" if (_SEIR_CODES[j], _SEIR_CODES[i]) in access_pairs
                            else od_observation.get(
                                (_SEIR_CODES[j], _SEIR_CODES[i]),
                                "observed_od" if od_weights.get((_SEIR_CODES[j], _SEIR_CODES[i])) else "baseline_gravity",
                            )
                        ),
                        "source_new_cases": round(day_onsets[j], 4),
                        "target_new_cases": round(ni, 4),
                    })

        # Keep a route from each active source before filling the display budget with
        # globally largest flows. This preserves observed network cascades (e.g.
        # Incheon -> Seoul -> Busan) in the daily animation instead of a radial fan.
        by_source: dict[str, list[dict]] = {}
        for edge in edge_events_today:
            by_source.setdefault(edge["source"], []).append(edge)
        balanced: list[dict] = []
        for source_edges in by_source.values():
            balanced.extend(sorted(source_edges, key=lambda edge: edge["expected_exposures"], reverse=True)[:3])
        chosen = {(edge["source"], edge["target"]) for edge in balanced}
        remainder = [edge for edge in edge_events_today if (edge["source"], edge["target"]) not in chosen]
        transmission_edges.extend((
            sorted(balanced, key=lambda edge: edge["expected_exposures"], reverse=True)
            + sorted(remainder, key=lambda edge: edge["expected_exposures"], reverse=True)
        )[:48])
        S, E, I, R, D = nS, nE, nI, nR, nD
        day_onsets = next_onsets
        daily_new.append((d + 1, sum(next_onsets)))

    return snaps, daily_new, C, transmission_edges

def _build_response_playbook(peak_day: int, input_cfr: float, r0_eff: float) -> list[dict]:
    """Stage-based public-health response recommendations, adapted to the simulated
    epidemic phase. Deterministic (no LLM), always present. Grounded in K-방역 3T
    (Test–Trace–Treat), WHO 봉쇄–완화(containment–mitigation) 단계, 감염병 위기경보 4단계."""
    high_cfr = input_cfr >= 0.05
    high_r0 = r0_eff >= 2.5
    still_growing = peak_day >= 21   # 신규 정점이 3주 이후 → 28일에도 성장기
    early_peak = peak_day <= 10      # 정점이 10일 이전 → 28일엔 감소기

    short = [
        "유입·발생 거점 중심 즉시 역학조사·접촉자 추적 및 확진자 격리 (3T: 검사·추적)",
        "진단검사 역량 확충, 의심사례 신고체계 가동, 유입 감시(검역) 강화",
        "감염병 위기경보 단계 격상 검토 및 중앙방역대책본부 가동",
    ]
    if high_r0:
        short.append(f"전파력이 높아(R0 {r0_eff}) 거점 지역 이동·집회 제한을 선제 검토")

    mid = [
        "사회적 거리두기·다중이용시설 방역으로 지역 간 전파 억제",
        "병상·중환자실·의료인력·치료제(항바이러스제) 선제 확보 (3T: 치료)",
        "고위험군(고령·기저질환자) 우선 보호 및 백신 우선접종 계획 수립",
    ]
    if high_cfr:
        mid.append(f"입력 CFR이 높아({input_cfr * 100:.1f}%) 중환자 병상·인공호흡기·ECMO 확보 우선")

    if still_growing:
        late_phase = "정점 대응 (성장기)"
        late = [
            f"신규 정점이 {peak_day}일차로 28일에도 성장기 — 의료체계 과부하 방지에 총력",
            "경증 재택치료 전환·병상 재배분으로 중증 진료역량 확보",
            "백신·치료제 확보 가속 및 방역 조치 강화 유지",
        ]
    elif early_peak:
        late_phase = "완화·출구 (감소기)"
        late = [
            f"신규 정점({peak_day}일차)을 지나 감소기 — 단계적 거리두기 완화·출구전략 검토",
            "재유행·변이 대비 감시체계 유지",
            "완치자 후유증 관리 및 의료체계 정상화",
        ]
    else:
        late_phase = "정점 전후 대응"
        late = [
            f"신규 정점({peak_day}일차) 전후 — 의료역량 유지하며 방역 수위 조정",
            "지역별 확산 속도에 따라 대응 자원 차등 배분",
            "재유행 대비 감시 유지 및 완화 시점 판단",
        ]

    return [
        {"stage": "단기 (0~7일)", "phase": "봉쇄·초기대응", "actions": short},
        {"stage": "중기 (1~3주)", "phase": "확산억제·의료대비", "actions": mid},
        {"stage": "후기 (21~28일)", "phase": late_phase, "actions": late},
    ]


# Real Korean healthcare capacity, so the AI calibrates severity to reality instead of
# over-claiming "medical-system collapse" for small outbreaks. Approximate/rounded figures
# from OECD Health at a Glance 2023, HIRA(심평원) 의료시설·장비 통계, KDCA 국가지정 입원치료병상
# 지침, plus historical anchors (MERS 2015, COVID omicron 2022). See research notes.
_KOREA_HEALTHCARE_CONTEXT = (
    "[한국 의료 대응역량 참고치 — 근사·반올림 값]\n"
    "- 총 병상: 약 68만 병상, 인구 1,000명당 약 12.6병상(OECD 최다 수준, 급성기 병상만도 약 7.4).\n"
    "- 중환자실(ICU): 성인 약 1만 병상, 소아·신생아 포함 전체 약 1.2만 병상.\n"
    "- 음압병상: 국가지정 입원치료병상 약 280병상(39개소)이 상시 핵심자원, 시도지정·의무설치 포함 광의로는 약 800병상 이상, 코로나19 시기엔 감염병전담병상 전환으로 일시 수천 병상까지 확대됨.\n"
    "- 인공호흡기 약 1만 대, ECMO 약 350대.\n"
    "- 역사적 기준점: 메르스 2015 = 186명 확진·38명 사망 → 원내감염으로 의료가 '심각히 압박'받았으나(삼성서울병원 부분폐쇄 등) 필수의료 붕괴는 없었음. 코로나 오미크론 2022 = 일 최대 약 62만 명 확진·일 432명 사망에도 재택·경증 분리와 중증병상 확보로 필수의료 체계는 '유지'됨."
)
_KOREA_SEVERITY_CALIBRATION = (
    "위 대응역량 수치에 비례해 심각도를 판단하라. 28일간 수백 명 확진·수백 명 사망 수준은 특정 지역에 상당한 부담을 주는 심각한 사건이지만, 한국 전체의 필수의료 체계를 붕괴시키는 규모는 아니다"
    "(메르스 186명·38명도 '붕괴'가 아닌 '압박'이었고, 오미크론 일 62만 명·432명 사망에도 체계는 유지됨). "
    "'붕괴·마비·전면 재난·의료 마비' 같은 표현은 총 병상·중환자실·음압병상 등 실제 역량치에 근접·초과하는 규모(예: 지속적으로 ICU·음압 수용력을 소진시키는 중증환자 급증)에만 사용하고, 그 외에는 '지역 의료 부담 가중', '중환자·격리 병상 압박 증가' 등 규모에 비례한 표현으로 서술하라. 국지적 원내 마비와 전국적 필수의료 붕괴를 혼동하지 말라."
)


def _gemini_national_scenario(*, disease_name: str, canon: str, is_novel: bool, country: str,
                              entry_label: str, origin_verb: str, seed_region_name: str,
                              r0_eff: float, cfr_eff: float, inc_days: float, inf_days: float,
                              total_cases: int, total_deaths: int, national_cfr: float, attack_rate: float,
                              peak_day: int, worst: list, national_curve: list,
                              use_aviation: bool, use_traffic: bool, use_weather: bool) -> dict | None:
    """AI (Gemini) interpretation of the SEIR result — impact, spread pattern, week-by-week
    timeline, stage-based response actions, high-risk regions, risk factors, best/worst case.
    Grounded in the actual simulation numbers. Returns None if no API key; an {error}/{parse_error}
    dict on failure (the frontend degrades gracefully)."""
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return None
    try:
        from google import genai
        client = genai.Client(api_key=api_key)
        model = os.getenv("RISK_ANALYSIS_MODEL") or os.getenv("GEMINI_MODEL") or "gemini-3.5-flash"
        signals = []
        if use_aviation:
            signals.append("항공 유입(실측 여객)")
        if use_traffic:
            signals.append("교통 연결성(실측 교통량)")
        if use_weather:
            signals.append("기상(예보 기온)")
        curve_txt = ", ".join(f"{p['day']}일 {p['cumulative_cases']:,}명" for p in national_curve)
        worst_txt = ", ".join(f"{w['region_name']} {w['cumulative_cases']:,}명" for w in worst)
        dtype = "신종 감염병(파라미터 사용자 지정)" if is_novel else f"기지 질병({canon})"
        prompt = f"""당신은 한국 호흡기 감염병 감시 시스템 Sentinel의 시나리오 분석 AI입니다. 아래는 메타population SEIR 역학 모델의 28일 시뮬레이션 결과입니다. 이 수치를 해석해 정책 결정자를 위한 분석을 제공하세요.

## 시나리오
- 질병: {disease_name} ({dtype}), R0 {r0_eff}, 치명률 {cfr_eff * 100:.1f}%, 잠복기 {inc_days}일, 전염기 {inf_days}일
- {origin_verb} 거점: {entry_label} → {seed_region_name}
- 반영 신호: {', '.join(signals) or '없음'}

## SEIR 시뮬레이션 결과 (28일)
- 전국 모형 누적 감염 {total_cases:,}명, 사망 {total_deaths:,}명, 28일 사망비 {national_cfr * 100:.1f}%, 입력 CFR {cfr_eff * 100:.1f}%, 발병률 {attack_rate * 100:.2f}%
- 신규 확진 정점: {peak_day}일차
- 최다 피해 지역: {worst_txt}
- 모형 누적 감염 추이: {curve_txt}

## 한국 의료 대응역량 (심각도 보정 기준)
{_KOREA_HEALTHCARE_CONTEXT}

## 작성 원칙 (정확도·톤)
- {_KOREA_SEVERITY_CALIBRATION}
- 당신은 최종 결정권자가 아니라 정책 결정자에게 선택지를 제시하는 자문 역할이며, 최종 판단은 정책 결정자가 한다. 단정적 명령("~한다", "~해야 한다", "~하라")이 아니라 검토·고려를 권하는 자문 어투("~을 고려한다", "~을 검토한다", "~이 필요할 수 있다", "~을 권고한다", "~을 검토할 필요가 있다")로 쓴다.
- "강제 격리 의무화", "전면 봉쇄", "즉각 격리" 같은 강압적·극단적 표현은 피하고, "격리 및 모니터링 강화 검토", "이동 자제 권고", "선제적 대비" 등 완화된 표현을 쓴다.

## 요청 (반드시 한국어, JSON object 하나로만. 각 항목을 충분히 구체적이고 상세하게 작성)
1. "impact_summary": 이 결과의 의미와 파급 요약 (4-5문장, 확진·사망·치명률·정점 수치를 인용)
2. "spread_pattern": 예상 확산 양상 (거점→수도권→전국 경로, 어떤 신호가 어떻게 작용하는지 포함, 3-4문장)
3. "timeline": 주차별 전개 배열, 각 항목 {{"week": 정수(1~4), "description": "각 주차의 확진 규모·전개·의료 부담을 2-3문장으로 구체적으로"}}
4. "response_actions": 시기별 대응 선택지 7-9개 배열(단기·중기·후기에 고르게 분배), 각 항목 {{"priority": "high|medium|low", "action": "정책 결정자가 검토할 선택지를 위 자문 어투(~검토/고려/권고)로 담은 구체적 조치(1-2문장). 강압적 표현 금지", "timing": "단기(0~7일)|중기(1~3주)|후기(21~28일)"}}. 위 결과(정점 시점·치명률·전파력·최다 피해 지역)에 근거해 작성.
5. "high_risk_regions": 고위험 지역 3-4개 배열, 각 항목 {{"region": "지역명", "reason": "확진 규모·연결성 근거를 담은 2문장"}}
6. "risk_factors": 악화 위험 요인 3-4개 (각 문자열은 근거를 담은 1문장)
7. "best_case": 최선 시나리오 (구체적 개입과 그 결과를 담은 2문장)
8. "worst_case": 최악 시나리오 (구체적 실패 경로와 그 결과를 담은 2문장)

JSON 외 다른 텍스트 금지."""
        resp = client.models.generate_content(model=model, contents=prompt)
        raw = (resp.text or "").strip()
        cleaned = raw
        if cleaned.startswith("```"):
            cleaned = cleaned.strip("`")
            if cleaned.startswith("json"):
                cleaned = cleaned[4:]
            cleaned = cleaned.strip()
        try:
            return json.loads(cleaned)
        except Exception:
            return {"raw": raw[:800], "parse_error": True}
    except Exception as e:
        return {"error": f"Gemini call failed: {type(e).__name__}: {e}"}


def _what_if_outbreak_national(inputs: dict) -> dict:
    entry_raw = str(inputs.get("entry_point") or "ICN").strip()
    entry_code = entry_raw.upper()
    disease_name = str(inputs.get("disease") or "novel respiratory pathogen")
    country = str(inputs.get("country") or "China")
    # Severity removed: transmission (R0) and fatality (CFR) are entered explicitly, so a
    # coarse severity label would only duplicate them. The epidemiology is fully specified
    # by R0 / CFR / incubation / infectious.

    # Origin can be an airport (해외 유입) OR a domestic 시도 by code/name (국내 발생).
    entry_point = _ENTRY_POINTS.get(entry_code)
    entry_type = "airport" if entry_point else None
    if not entry_point:
        dom = None
        for code, meta in _REGION_COORDS.items():
            nm = meta.get("name", "")
            if code == entry_code or (nm and (nm in entry_raw or entry_raw in nm)):
                dom = (code, meta); break
        if dom:
            code, meta = dom
            entry_point = {"label": meta.get("name", code), "label_en": code,
                           "primary_zones": [code], "lat": meta["lat"], "lng": meta["lng"]}
            entry_type = "domestic"
        else:
            entry_point = {"label": entry_raw, "label_en": entry_code, "primary_zones": [], "lat": 36.5, "lng": 127.8}
            entry_type = "custom"

    # Seed region: the primary zone nearest the airport, else the nearest 시도.
    def _nearest(codes: list[str]) -> str:
        return min(codes, key=lambda c: _haversine_km(entry_point["lat"], entry_point["lng"],
                                                       _REGION_COORDS[c]["lat"], _REGION_COORDS[c]["lng"]))
    pz = [c for c in entry_point["primary_zones"] if c in _SEIR_CODES]
    entry_region = _nearest(pz) if pz else _nearest(_SEIR_CODES)
    entry_idx = _SEIR_CODES.index(entry_region)

    # Disease parameters: preset base (known) or DEFAULT (novel), with optional user
    # overrides (신종감염병은 R0/CFR/잠복기/전염기를 직접 설정). Severity always scales.
    canon, dp = _resolve_disease(disease_name)

    def _num(key: str, default: float) -> float:
        v = inputs.get(key)
        try:
            return float(v) if v is not None and str(v) != "" else float(default)
        except (TypeError, ValueError):
            return float(default)

    r0_base = max(0.0, _num("r0", dp["r0"]))
    cfr_base = max(0.0, min(1.0, _num("cfr", dp["cfr"])))
    inc_days = max(0.5, _num("incubation_days", dp["inc"]))
    inf_days = max(0.5, _num("infectious_days", dp["inf"]))
    # Do not let a qualitative severity label alter two distinct natural-history
    # parameters. Scenario transmission is governed by the explicit R0/CFR inputs.
    r0_eff = round(r0_base, 3)
    cfr_eff = round(cfr_base, 4)

    # Aviation -> import seed scale — only for a 해외 유입(airport) origin; a 국내 발생
    # (domestic) origin has no import, so the seed stays at the base count.
    prox = _PROXIMITY_MULT.get(country.lower(), 1.0)
    aviation_source = "off"; aviation_info = None
    if entry_type == "airport" and inputs.get("use_aviation"):
        av = _aviation_multiplier(country)
        if av:
            prox, aviation_source, aviation_info = av["multiplier"], "aviation", av
        else:
            aviation_source = "unavailable"
    aviation_mult = max(1.0, prox) if entry_type == "airport" else 1.0
    # 유입 규모 강도(초기 감염자 수 스케일). aviation add 시 국가 여객지수까지 곱해짐.
    aviation_intensity = max(0.2, min(5.0, _num("aviation_intensity", 1.0)))
    seed_count = 5.0 * aviation_intensity * aviation_mult

    # Traffic: the toggle selects measured OD calibration. It never means that
    # interregional movement vanishes; OFF uses the documented gravity/hub baseline.
    use_traffic = bool(inputs.get("use_traffic"))
    highway_data = _highway_mobility() if use_traffic else {
        "connectivity": {}, "od_weights": {}, "od_volume": {}, "od_observation": {}, "generated_at": None, "network_source": "unavailable", "mode_metadata": {}}
    highway = highway_data["connectivity"]
    od_weights = highway_data["od_weights"]
    od_observation = highway_data["od_observation"]
    observed_only = bool(use_traffic and od_weights)
    if observed_only:
        traffic_source = highway_data.get("network_source", "highway_od")
    elif use_traffic:
        traffic_source = "baseline_mobility_data_unavailable"
    else:
        traffic_source = "baseline_mobility"
    conn_list = [(highway.get(c, 0.5) if (observed_only and highway) else _SEIR_CONN_DEFAULT[c])
                 for c in _SEIR_CODES]
    # ICN is in Incheon.  The available expressway sample lacks an Incheon-origin
    # row, so use a narrow, explicitly-labelled airport-access bridge instead of
    # either blocking all spread or portraying a gravity fallback as observed OD.
    airport_access_prior = (
        {"11": 0.28, "41": 0.14}
        if (observed_only and entry_type == "airport" and entry_region == "28") else {}
    )
    # m is active in both modes. It is the modeled interregional-mixing share.
    traffic_intensity = max(0.02, min(0.30, _num("traffic_intensity", 0.10)))
    # Weather -> transmissibility boost on days <= 10 (short-term forecast horizon).
    use_weather = bool(inputs.get("use_weather"))
    weather_live = bool(inputs.get("weather_live", True))
    weather_fav = ((_weather_favorability_live() if weather_live else _weather_favorability()) if use_weather else {})
    weather_source = (("kma_live" if weather_live else "kma_cached") if (use_weather and weather_fav) else ("unavailable" if use_weather else "off"))
    # 기상 강도 = β 보정 계수 (β = β·(1 + 강도·favorability), 클수록 계절 영향 큼).
    weather_intensity = max(0.0, min(1.0, _num("weather_intensity", 0.3)))

    snaps, daily_new, C, transmission_edges = _simulate_outbreak(
        entry_idx, r0_eff, cfr_eff, inc_days, inf_days, conn_list, seed_count,
        weather_fav, use_weather, mobility=traffic_intensity,
        weather_intensity=weather_intensity, od_weights=od_weights, od_observation=od_observation,
        access_prior=airport_access_prior, observed_only=observed_only)
    region_results = []
    for i, code in enumerate(_SEIR_CODES):
        tl = [snaps[d][i] for d in range(29)]
        last = tl[-1]
        region_results.append({
            "region_id": code,
            "region_name": _REGION_COORDS.get(code, {}).get("name", code),
            "is_primary_zone": code in entry_point["primary_zones"],
            "is_seed": code == entry_region,
            "population": _SEIR_POP[code],
            "cumulative_cases": last["cumulative_cases"],
            "cumulative_deaths": last["cumulative_deaths"],
            "attack_rate": last["attack_rate"],
            "effective_cfr": last["effective_cfr"],
            "scenario_level": last["level"],
            "spread_multiplier": round(C[i][entry_idx], 3) if i != entry_idx else 1.0,
            "connectivity": round(conn_list[i], 3),   # traffic connectivity weight (real highway when 교통 add)
            "timeline": [{"day": t["day"], "cumulative_cases": t["cumulative_cases"], "new_cases": t["new_cases"],
                          "cumulative_deaths": t["cumulative_deaths"], "attack_rate": t["attack_rate"],
                          "effective_cfr": t["effective_cfr"], "score": t["score"], "level": t["level"]} for t in tl],
        })
    region_results.sort(key=lambda r: r["cumulative_cases"], reverse=True)

    last_snap = snaps[28]
    total_cases = sum(r["cumulative_cases"] for r in last_snap)
    total_deaths = sum(r["cumulative_deaths"] for r in last_snap)
    national_cfr = (total_deaths / total_cases) if total_cases > 0 else 0.0
    peak_day, peak_new = max(daily_new, key=lambda t: t[1])
    affected = sum(1 for r in region_results if r["cumulative_cases"] >= 1)
    worst = region_results[:3]
    national_curve = [{
        "day": d,
        "cumulative_cases": sum(r["cumulative_cases"] for r in snaps[d]),
        "cumulative_deaths": sum(r["cumulative_deaths"] for r in snaps[d]),
        "new_cases": sum(r["new_cases"] for r in snaps[d]),
    } for d in range(29)]

    mobility_edges = []
    for target_idx, target_code in enumerate(_SEIR_CODES):
        for source_idx, source_code in enumerate(_SEIR_CODES):
            weight = C[target_idx][source_idx]
            if source_idx == target_idx or weight < 0.025:
                continue
            pair = (source_code, target_code)
            mobility_edges.append({
                "source": source_code,
                "target": target_code,
                "weight": round(weight, 5),
                "traffic_volume": highway_data["od_volume"].get(pair),
                "mobility_source": (
                    "airport_access_prior" if pair in {(entry_region, target) for target in airport_access_prior}
                    else (od_observation.get(pair, "observed_od") if observed_only else "baseline_gravity")
                ),
            })
    mobility_edges.sort(key=lambda edge: edge["weight"], reverse=True)
    network_source = highway_data.get("network_source", "highway_od") if observed_only else "baseline_gravity"
    # Sensitivity summary — re-run the SEIR (reusing already-fetched data, no re-fetch)
    # at each active signal's low/high intensity to show how much each knob drives the
    # 28-day case total. A compact "which factor matters most" figure.
    def _run_total(seed=seed_count, m=traffic_intensity, wi=weather_intensity):
        sn, _dn, _c, _edges = _simulate_outbreak(
            entry_idx, r0_eff, cfr_eff, inc_days, inf_days, conn_list, seed,
            weather_fav, use_weather, mobility=m, weather_intensity=wi,
            od_weights=od_weights, od_observation=od_observation,
            access_prior=airport_access_prior, observed_only=observed_only)
        rows = sn[28]
        return sum(r["cumulative_cases"] for r in rows), sum(r["cumulative_deaths"] for r in rows)

    sensitivity = []
    if inputs.get("use_aviation") and entry_type == "airport":
        lo = _run_total(seed=5.0 * 0.5 * aviation_mult); hi = _run_total(seed=5.0 * 3.0 * aviation_mult)
        sensitivity.append({"key": "aviation", "label": "항공 유입 규모", "unit": "×",
                            "low_val": 0.5, "cur_val": round(aviation_intensity, 2), "high_val": 3.0,
                            "low_cases": lo[0], "cur_cases": total_cases, "high_cases": hi[0],
                            "low_deaths": lo[1], "cur_deaths": total_deaths, "high_deaths": hi[1]})
    if use_traffic:
        lo = _run_total(m=0.05); hi = _run_total(m=0.25)
        sensitivity.append({"key": "traffic", "label": "교통 이동 강도(m)", "unit": "",
                            "low_val": 0.05, "cur_val": round(traffic_intensity, 2), "high_val": 0.25,
                            "low_cases": lo[0], "cur_cases": total_cases, "high_cases": hi[0],
                            "low_deaths": lo[1], "cur_deaths": total_deaths, "high_deaths": hi[1]})
    if use_weather:
        lo = _run_total(wi=0.0); hi = _run_total(wi=1.0)
        sensitivity.append({"key": "weather", "label": "기상 전파력 강도", "unit": "",
                            "low_val": 0.0, "cur_val": round(weather_intensity, 2), "high_val": 1.0,
                            "low_cases": lo[0], "cur_cases": total_cases, "high_cases": hi[0],
                            "low_deaths": lo[1], "cur_deaths": total_deaths, "high_deaths": hi[1]})
    sensitivity.sort(key=lambda x: abs(x["high_cases"] - x["low_cases"]), reverse=True)

    # OD-treatment comparison — same scenario under (A) measured-OD-only (unobserved
    # regions isolated) vs (B) observed + gravity fill (the default). Lets the reviewer
    # see which is more realistic. Only differs when traffic OD is on; identical gravity
    # baselines otherwise.
    def _summary_from_snaps(sn: dict) -> dict:
        rows28 = sn[28]
        tc = sum(r["cumulative_cases"] for r in rows28)
        td = sum(r["cumulative_deaths"] for r in rows28)
        return {
            "total_cases": tc, "total_deaths": td,
            "attack_rate": round(tc / _SEIR_TOTAL_POP, 6) if _SEIR_TOTAL_POP else 0.0,
            "affected_regions": sum(1 for r in rows28 if r["cumulative_cases"] >= 1),
            "national_curve": [{
                "day": d,
                "cumulative_cases": sum(r["cumulative_cases"] for r in sn[d]),
                "cumulative_deaths": sum(r["cumulative_deaths"] for r in sn[d]),
            } for d in range(29)],
            "regions": [{
                "code": _SEIR_CODES[r["i"]],
                "name": _REGION_COORDS.get(_SEIR_CODES[r["i"]], {}).get("name", _SEIR_CODES[r["i"]]),
                "cumulative_cases": r["cumulative_cases"],
                "cumulative_deaths": r["cumulative_deaths"],
            } for r in rows28],
        }

    if observed_only:
        snaps_iso, _di, _ci, _ei = _simulate_outbreak(
            entry_idx, r0_eff, cfr_eff, inc_days, inf_days, conn_list, seed_count,
            weather_fav, use_weather, mobility=traffic_intensity, weather_intensity=weather_intensity,
            od_weights=od_weights, od_observation=od_observation, access_prior=airport_access_prior,
            observed_only=observed_only, isolate_unobserved=True)
        comparison = {
            "active": True,
            "observed_only": _summary_from_snaps(snaps_iso),
            "blended": _summary_from_snaps(snaps),
            "note": "관측 OD only(A)는 관측된 경로만 쓰고 관측 없는 지역을 고립시킵니다. 관측+중력(B, 기본)은 관측 경로를 우선하되 나머지를 중력모형으로 채워, 실제로 모든 지역이 이동한다는 사실을 반영합니다. 희소 표본에서는 A가 확산을 과소추정하는 경향이 있어 B가 더 현실적입니다.",
        }
    else:
        comparison = {"active": False,
                      "note": "교통 OD 미사용 — 두 방식 모두 중력 baseline으로 동일합니다."}

    origin_verb = "발생" if entry_type == "domestic" else "유입"
    attack_rate_nat = total_cases / _SEIR_TOTAL_POP if _SEIR_TOTAL_POP else 0.0
    gemini_scenario = _gemini_national_scenario(
        disease_name=disease_name, canon=canon, is_novel=not canon, country=country,
        entry_label=entry_point["label"], origin_verb=origin_verb,
        seed_region_name=_REGION_COORDS.get(entry_region, {}).get("name", entry_region),
        r0_eff=r0_eff, cfr_eff=cfr_eff, inc_days=inc_days, inf_days=inf_days,
        total_cases=total_cases, total_deaths=total_deaths, national_cfr=national_cfr,
        attack_rate=attack_rate_nat, peak_day=peak_day, worst=worst, national_curve=national_curve,
        use_aviation=bool(inputs.get("use_aviation")) and entry_type == "airport",
        use_traffic=use_traffic, use_weather=use_weather)
    return {
        "entry_point": {
            "code": entry_code, "label": entry_point["label"], "entry_type": entry_type,
            "primary_zones": entry_point["primary_zones"], "seed_region": entry_region,
            "seed_region_name": _REGION_COORDS.get(entry_region, {}).get("name", entry_region),
        },
        "scenario": {
            "disease": disease_name, "disease_matched": canon, "is_novel": not canon,
            "country": country,
            "r0": r0_eff, "cfr": cfr_eff, "r0_base": round(r0_base, 3), "cfr_base": round(cfr_base, 4),
            "incubation_days": inc_days, "infectious_days": inf_days,
            "aviation": aviation_info, "aviation_source": aviation_source,
            "traffic_source": traffic_source, "weather_source": weather_source,
            "traffic_bridge": "airport_access_prior" if airport_access_prior else None,
            "aviation_intensity": round(aviation_intensity, 2), "traffic_intensity": round(traffic_intensity, 2),
            "weather_intensity": round(weather_intensity, 2), "seed_count": int(round(seed_count)),
        },
        "regions": region_results,
        "mobility_network": {
            "source": network_source,
            "generated_at": highway_data["generated_at"],
            "edges": mobility_edges,
        },
        "data_sources": _build_data_sources(
            network_source=network_source, traffic_source=traffic_source,
            observed_only=observed_only, use_traffic=use_traffic,
            use_weather=use_weather, weather_source=weather_source,
            use_aviation=bool(inputs.get("use_aviation")) and entry_type == "airport",
            aviation_source=aviation_source,
            mode_metadata=highway_data.get("mode_metadata") or {},
            generated_at=highway_data.get("generated_at"), od_pairs=len(od_weights),
        ),
        "transmission_edges": transmission_edges,
        "summary": {
            "total_regions": len(region_results),
            "total_cases": total_cases, "total_deaths": total_deaths,
            "national_cfr": round(national_cfr, 4),  # 28-day deaths / model cumulative infections, not an input CFR
            "input_cfr": cfr_eff,
            "attack_rate": round(total_cases / _SEIR_TOTAL_POP, 6),
            "peak_day": peak_day, "peak_new_cases": int(round(peak_new)),
            "affected_regions": affected,
            "worst_regions": [{"name": r["region_name"], "cases": r["cumulative_cases"]} for r in worst],
            "national_curve": national_curve,
            "sensitivity": sensitivity,
            "response_playbook": _build_response_playbook(peak_day, cfr_eff, r0_eff),
            "comparison": comparison,
            "total_population": _SEIR_TOTAL_POP,
        },
        "gemini_scenario": gemini_scenario,
        "narrative": (
            f"역학 시뮬레이션: {disease_name} (R0 {r0_eff}·CFR {cfr_eff * 100:.1f}%)가 "
            f"{entry_point['label']}에서 {origin_verb}({_REGION_COORDS.get(entry_region, {}).get('name', entry_region)} 거점) 시 — "
            f"28일 후 전국 모형 누적 감염 {total_cases:,}명, 사망 {total_deaths:,}명 (28일 사망비 {national_cfr * 100:.1f}%) "
            f"(전국 발병률 {total_cases / _SEIR_TOTAL_POP * 100:.2f}%, 정점 {peak_day}일차). "
            f"최다 피해: {', '.join(r['region_name'] for r in worst)}. "
            f"※ 개입(백신·거리두기) 없는 자연확산을 가정한 예시 시나리오입니다."
        ),
    }


register(FunctionSpec(
    name="whatIfOutbreakNational",
    label="National outbreak epidemiological simulation (SEIR)",
    inputs=[
        {"name": "entry_point", "type": "string", "required": False, "default": "ICN",
         "description": "Airport entry code (e.g. ICN, PUS) or free-text airport name"},
        {"name": "disease", "type": "string", "required": False, "default": "novel respiratory pathogen"},
        {"name": "country", "type": "string", "required": False, "default": "China"},
        {"name": "r0", "type": "number", "required": False,
         "description": "Base reproduction number R0 (override; auto-filled for known diseases, set manually for novel)"},
        {"name": "cfr", "type": "number", "required": False,
         "description": "Base case-fatality ratio 0..1 (override)"},
        {"name": "incubation_days", "type": "number", "required": False,
         "description": "Incubation period in days (override)"},
        {"name": "infectious_days", "type": "number", "required": False,
         "description": "Infectious period in days (override)"},
        {"name": "use_aviation", "type": "boolean", "required": False, "default": False,
         "description": "Scale the imported seed by real Incheon arriving-passenger volume for the origin country"},
        {"name": "aviation_intensity", "type": "number", "required": False, "default": 1.0,
         "description": "유입 규모 강도 (초기 감염자 수 = 5 × intensity × 국가 여객지수)"},
        {"name": "use_traffic", "type": "boolean", "required": False, "default": False,
         "description": "Use real highway traffic connectivity as the inter-region mobility weight"},
        {"name": "traffic_intensity", "type": "number", "required": False, "default": 0.1,
         "description": "교통 이동 강도 = 지역 간 결합 비율 m (0.02~0.30). 클수록 전국 확산 빠름"},
        {"name": "use_weather", "type": "boolean", "required": False, "default": False,
         "description": "Boost transmissibility on days <=10 by real forecast weather favorability"},
        {"name": "weather_intensity", "type": "number", "required": False, "default": 0.3,
         "description": "기상 강도 = β 보정계수 (β·(1+intensity·favorability), 0~1)"},
        {"name": "weather_live", "type": "boolean", "required": False, "default": True,
         "description": "Fetch weather live at run-time (example generation passes False to use cache)"},
    ],
    output="object<{entry_point, scenario, regions[], summary, narrative}>",
    affects_objects=["Region"],
    requires_admin=True,
    description="National outbreak epidemiological simulation: a daily metapopulation SEIR+D model "
                "of an imported outbreak spreading across all 17 Korean 시도 from a seeded entry region. "
                "Uses real 2026 population + disease R0/CFR/incubation/infectious parameters (editable) + "
                "a gravity mobility network fed by aviation import, highway connectivity and geographic "
                "proximity, with a short-term weather transmissibility boost. Outputs real cumulative "
                "cases, deaths, attack rate and effective CFR per region over a day-level timeline.",
    fn=_what_if_outbreak_national,
))


# ═════════════════════════════════════════════════════════════════════════════
# Function 8 — signalLeadLag  (cross-correlation between signals)
# ═════════════════════════════════════════════════════════════════════════════

def _signal_lead_lag(inputs: dict) -> dict:
    """Cross-correlation analysis between two signal time-series.

    Answers: "If signal A rises this week, does signal B follow N weeks later?"
    Uses normalized cross-correlation at lags -6..+6 weeks.
    """
    signal_a = str(inputs.get("signal_a") or "")
    signal_b = str(inputs.get("signal_b") or "")
    if not signal_a or not signal_b:
        return {"error": "signal_a and signal_b required"}

    # Build time-series from ALL snapshots
    if not SNAPSHOT_DIR.exists():
        return {"error": "no snapshot data"}
    files = sorted(SNAPSHOT_DIR.glob("*.json"))
    if len(files) < 10:
        return {"error": f"insufficient snapshots ({len(files)}, need >= 10)"}

    # Extract national-average signal values per snapshot date
    series_a: list[float] = []
    series_b: list[float] = []
    dates: list[str] = []

    for path in files:
        records = _load_json(path) or []
        if not isinstance(records, list) or not records:
            continue
        # Average across all regions for this snapshot
        vals_a: list[float] = []
        vals_b: list[float] = []
        for r in records:
            signals = r.get("signals") or {}
            va = signals.get(signal_a)
            vb = signals.get(signal_b)
            if va is not None:
                try: vals_a.append(float(va))
                except (TypeError, ValueError): pass
            if vb is not None:
                try: vals_b.append(float(vb))
                except (TypeError, ValueError): pass
        if vals_a and vals_b:
            series_a.append(statistics.mean(vals_a))
            series_b.append(statistics.mean(vals_b))
            dates.append(path.stem)

    n = len(series_a)
    if n < 16:
        return {"error": f"insufficient paired data points ({n}, need >= 16)"}

    # First differences remove level/trend before searching temporal association.
    # This remains an exploratory association analysis, not a causal estimator.
    diff_a = [series_a[i] - series_a[i - 1] for i in range(1, n)]
    diff_b = [series_b[i] - series_b[i - 1] for i in range(1, n)]
    dates = dates[1:]
    n = len(diff_a)
    mean_a = statistics.mean(diff_a)
    mean_b = statistics.mean(diff_b)
    std_a = max(statistics.stdev(diff_a), 1e-9)
    std_b = max(statistics.stdev(diff_b), 1e-9)
    norm_a = [(value - mean_a) / std_a for value in diff_a]
    norm_b = [(value - mean_b) / std_b for value in diff_b]
    # Cross-correlation at lags -6..+6
    max_lag = min(6, n // 3)
    correlations: list[dict] = []
    for lag in range(-max_lag, max_lag + 1):
        # Positive lag: A leads B by `lag` weeks (B shifted forward)
        if lag >= 0:
            a_slice = norm_a[:n - lag]
            b_slice = norm_b[lag:]
        else:
            a_slice = norm_a[-lag:]
            b_slice = norm_b[:n + lag]
        if len(a_slice) < 6:
            continue
        corr = sum(a * b for a, b in zip(a_slice, b_slice)) / len(a_slice)
        correlations.append({
            "lag": lag,
            "correlation": round(corr, 4),
            "interpretation": (
                f"{signal_a}가 {abs(lag)}주 앞서 이동" if lag > 0
                else f"{signal_b}가 {abs(lag)}주 앞서 이동" if lag < 0
                else "동시 이동"
            ),
            "pairs": len(a_slice),
        })

    # Find best lead/lag
    if not correlations:
        return {"error": "insufficient data for cross-correlation"}

    best = max(correlations, key=lambda c: abs(c["correlation"]))
    peak_lag = best["lag"]
    peak_corr = best["correlation"]
    # Test the selected *maximum* lag correlation against all non-zero circular
    # shifts of B. This adjusts for searching multiple lags while preserving each
    # differenced series' autocorrelation structure more faithfully than iid shuffles.
    def _max_abs_with(candidate_b: list[float]) -> float:
        observed: list[float] = []
        for lag in range(-max_lag, max_lag + 1):
            if lag >= 0:
                left, right = norm_a[:n - lag], candidate_b[lag:]
            else:
                left, right = norm_a[-lag:], candidate_b[:n + lag]
            if len(left) >= 6:
                observed.append(abs(sum(a * b for a, b in zip(left, right)) / len(left)))
        return max(observed, default=0.0)

    null_peaks = [_max_abs_with(norm_b[shift:] + norm_b[:shift]) for shift in range(1, n)]
    permutation_p = (1 + sum(value >= abs(peak_corr) for value in null_peaks)) / (1 + len(null_peaks))
    support = "suggestive" if permutation_p < 0.05 else "not_significant"

    # Strength interpretation
    abs_corr = abs(peak_corr)
    if abs_corr >= 0.7:
        strength = "strong"
        strength_kr = "강한 상관"
    elif abs_corr >= 0.4:
        strength = "moderate"
        strength_kr = "중간 상관"
    elif abs_corr >= 0.2:
        strength = "weak"
        strength_kr = "약한 상관"
    else:
        strength = "negligible"
        strength_kr = "무시할 수준"

    # Direction
    if peak_lag > 0:
        lead_signal = signal_a
        lag_signal = signal_b
        lead_label = _SIGNAL_LABELS.get(signal_a, signal_a)
        lag_label = _SIGNAL_LABELS.get(signal_b, signal_b)
    elif peak_lag < 0:
        lead_signal = signal_b
        lag_signal = signal_a
        lead_label = _SIGNAL_LABELS.get(signal_b, signal_b)
        lag_label = _SIGNAL_LABELS.get(signal_a, signal_a)
    else:
        lead_signal = signal_a
        lag_signal = signal_b
        lead_label = _SIGNAL_LABELS.get(signal_a, signal_a)
        lag_label = _SIGNAL_LABELS.get(signal_b, signal_b)

    return {
        "signal_a": signal_a,
        "signal_b": signal_b,
        "label_a": _SIGNAL_LABELS.get(signal_a, signal_a),
        "label_b": _SIGNAL_LABELS.get(signal_b, signal_b),
        "data_points": n,
        "date_range": {"start": dates[0], "end": dates[-1]},
        "correlations": correlations,
        "inference": {
            "status": support,
            "circular_shift_p_value": round(permutation_p, 4),
            "null_shifts": len(null_peaks),
            "caution": "Exploratory, trend-differenced association only; it is not causal evidence or a validated operational trigger.",
        },        "best_lag": {
            "lag": peak_lag,
            "correlation": peak_corr,
            "strength": strength,
            "strength_kr": strength_kr,
            "lead_signal": lead_signal,
            "lag_signal": lag_signal,
        },
        "series_a": [{"date": d, "value": round(v, 4)} for d, v in zip(dates, series_a)],
        "series_b": [{"date": d, "value": round(v, 4)} for d, v in zip(dates, series_b)],
        "method": {
            "name": "Normalized Cross-Correlation",
            "formula": "CCF(τ) = (1/N) Σ [(A(t)-μ_A)/σ_A × (B(t+τ)-μ_B)/σ_B]",
            "parameters": {
                "max_lag": f"±{max_lag} weeks",
                "normalization": "z-score (zero-mean, unit-variance)",
                "min_pairs": 6,
                "preprocessing": "first difference then z-score",
                "inference": "circular-shift p-value adjusted for the maximum correlation across tested lags",
            },
            "description_kr": "두 신호의 시간차 상관관계를 분석합니다. "
                              "lag=+N이면 신호 A가 N주 먼저 변동하고 신호 B가 따라가는 패턴, "
                              "lag=-N이면 반대입니다. 상관계수가 ±0.4 이상이면 중간 이상의 "
                              "유의미한 관계로 봅니다.",
        },
        "narrative": (
            f"[Lead-Lag] {lead_label}이(가) {lag_label}보다 {abs(peak_lag)}주 앞서 이동 "
            f"(r={peak_corr:.2f}, {strength_kr}). "
            f"데이터: {n}개 시점 ({dates[0]} ~ {dates[-1]})."
            if peak_lag != 0 else
            f"[Lead-Lag] {lead_label}과(와) {lag_label}이(가) 동시에 이동 "
            f"(r={peak_corr:.2f}, {strength_kr}). "
            f"데이터: {n}개 시점."
        ),
    }


register(FunctionSpec(
    name="signalLeadLag",
    label="Signal lead-lag analysis",
    inputs=[
        {"name": "signal_a", "type": "string", "required": True,
         "description": "Signal key (e.g. 'wastewater_pathogen', 'influenza_like')"},
        {"name": "signal_b", "type": "string", "required": True,
         "description": "Signal key to compare against"},
    ],
    output="object<{correlations: list<{lag,correlation}>, best_lag, series_a, series_b, method, narrative}>",
    affects_objects=["Region"],
    requires_admin=False,
    description="Cross-correlation analysis between two surveillance signals across all snapshots. "
                "Identifies whether signal A leads or lags signal B, and by how many weeks. "
                "Essential for early warning: 'wastewater rises → ILI follows 2 weeks later'.",
    fn=_signal_lead_lag,
))


# ═════════════════════════════════════════════════════════════════════════════
# Function 9 — forecastRegionSARIMAX (statsmodels SARIMAX on region scores)
# ═════════════════════════════════════════════════════════════════════════════

def _forecast_region_sarimax(inputs: dict) -> dict:
    """Walk-forward selected ARIMA projection for a bounded regional alert score."""
    region_id = str(inputs.get("region_id") or "")
    weeks = max(1, min(int(inputs.get("weeks") or 4), 12))
    if not region_id:
        return {"error": "region_id required"}
    # Use all available snapshots, not an arbitrary 24-week subset, for validation.
    history = _region_history_points(region_id, weeks=104)
    if not history:
        return {"error": f"no history for region {region_id}"}
    scores = [float(point["score"]) for point in history if point.get("score") is not None]
    if len(scores) < 16:
        return {"error": f"Insufficient history for walk-forward ARIMA ({len(scores)} points, need >= 16)"}

    try:
        import warnings
        import numpy as _np
        from statsmodels.tsa.statespace.sarimax import SARIMAX as _SARIMAX
        warnings.filterwarnings("ignore")
        eps = 1e-4
        bounded = _np.clip(_np.asarray(scores, dtype=float), eps, 1.0 - eps)
        transformed = _np.log(bounded / (1.0 - bounded))
        sigmoid = lambda x: 1.0 / (1.0 + _np.exp(-x))
        candidates = ((0, 1, 1), (1, 1, 0), (1, 1, 1))
        holdouts = list(range(max(12, len(scores) - 6), len(scores)))
        candidate_mae: dict[str, float] = {}
        candidate_folds: dict[str, int] = {}
        for order in candidates:
            errors: list[float] = []
            for end_idx in holdouts:
                try:
                    fitted = _SARIMAX(
                        transformed[:end_idx], order=order, enforce_stationarity=False,
                        enforce_invertibility=False,
                    ).fit(disp=False, maxiter=100)
                    predicted = float(sigmoid(fitted.get_forecast(steps=1).predicted_mean[0]))
                    errors.append(abs(predicted - scores[end_idx]))
                except Exception:
                    continue
            if errors:
                key = str(order)
                candidate_mae[key] = round(float(statistics.mean(errors)), 5)
                candidate_folds[key] = len(errors)
        if not candidate_mae:
            return {"error": "ARIMA walk-forward validation failed for every candidate", "region_id": region_id}

        selected_key = min(candidate_mae, key=candidate_mae.get)
        selected_order = next(order for order in candidates if str(order) == selected_key)
        fitted = _SARIMAX(
            transformed, order=selected_order, enforce_stationarity=False,
            enforce_invertibility=False,
        ).fit(disp=False, maxiter=200)
        forecast = fitted.get_forecast(steps=weeks)
        mean_logit = _np.asarray(forecast.predicted_mean).flatten()
        interval_logit = _np.asarray(forecast.conf_int(alpha=0.10))
        try:
            last_date = _date.fromisoformat(history[-1]["date"])
        except Exception:
            last_date = _date.today()
        points: list[dict] = []
        for i in range(weeks):
            dt = last_date.fromordinal(last_date.toordinal() + (i + 1) * 7)
            value = float(sigmoid(mean_logit[i]))
            low = float(sigmoid(interval_logit[i, 0]))
            high = float(sigmoid(interval_logit[i, 1]))
            points.append({"date": dt.isoformat(), "weeks_ahead": i + 1,
                           "score": round(value, 4), "level": _level_for(value),
                           "low": round(low, 4), "high": round(high, 4)})

        return {
            "warning": ("최근 관측 경보점수가 변하지 않아, 이 투영은 마지막 값 반복일 뿐 예측 정확도의 증거가 아닙니다."
                        if len({round(score, 6) for score in scores[-8:]}) <= 2 else None),            "region_id": region_id, "model_name": "ARIMA", "history": history, "forecast": points,
            "method": {
                "name": f"ARIMA{selected_order} on logit(score) (walk-forward selected)",
                "formula": "logit(alert_score) -> ARIMA(p,1,q) -> inverse-logit forecast",
                "parameters": {"order": selected_order, "score_bounds": "logit transform preserves 0..1 bounds",
                               "seasonality": "not fitted: fewer than 104 weekly snapshots",
                               "prediction_interval": "90% model interval; monitor empirical coverage"},
                "validation": {"scheme": "rolling-origin, one-week-ahead MAE",
                               "folds": candidate_folds[selected_key], "selected_mae": candidate_mae[selected_key],
                               "candidate_mae": candidate_mae},
                "description_kr": "0~1로 제한된 지역 경보점수는 logit 변환 후 ARIMA 후보를 롤링 검증 MAE로 선택합니다. 이는 질병 발생건수 예측이 아니라 합성 경보점수의 단기 투영입니다.",
            },
            "diagnostics": {"aic": round(float(fitted.aic), 1), "bic": round(float(fitted.bic), 1),
                            "rolling_mae": candidate_mae[selected_key], "validation_folds": candidate_folds[selected_key],
                            "candidate_mae": candidate_mae},
            "narrative": (f"[Regional ARIMA walk-forward] {weeks}-week alert-score projection: "
                          f"{points[-1]['score']:.3f} ({points[-1]['level']}); rolling MAE "
                          f"{candidate_mae[selected_key]:.3f} across {candidate_folds[selected_key]} folds."),
        }
    except Exception as exc:
        return {"error": f"Regional ARIMA fitting failed: {type(exc).__name__}: {exc}", "region_id": region_id}

register(FunctionSpec(
    name="forecastRegionSARIMAX",
    label="Forecast region score (walk-forward ARIMA)",
    inputs=[
        {"name": "region_id", "type": "string", "required": True,
         "description": "Region.code"},
        {"name": "weeks", "type": "integer", "required": False, "default": 4,
         "description": "Forecast horizon (1-12 weeks)"},
    ],
    output="object<{history, forecast: list<{date,score,level,low,high}>, method, diagnostics, narrative}>",
    affects_objects=["Region"],
    requires_admin=False,
    description="SARIMAX(1,1,1) forecast for Region composite score with 90% confidence interval. "
                "Compare against EMA+momentum model for dual-model decision support.",
    fn=_forecast_region_sarimax,
))


# ═════════════════════════════════════════════════════════════════════════════
# Function 10 — generateForecastReport (integrated report + Gemini)
# ═════════════════════════════════════════════════════════════════════════════

def _generate_forecast_report(inputs: dict) -> dict:
    """Generate an integrated forecasting report combining all analyses.

    Runs: decomposition + EMA forecast + SARIMAX forecast + hotspots for
    a region, then asks Gemini to synthesize a comprehensive Korean-language
    executive briefing for policy decision-makers.
    """
    region_id = str(inputs.get("region_id") or "")
    if not region_id:
        return {"error": "region_id required"}

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return {"error": "GEMINI_API_KEY missing", "sections": []}

    # Gather all analyses
    decomposed = _decompose_region_score({"region_id": region_id})
    forecast_ema = _forecast_region_score({"region_id": region_id, "weeks": 4})
    forecast_sarimax = _forecast_region_sarimax({"region_id": region_id, "weeks": 4})
    hotspots = _top_risk_hotspots({"weeks": 4, "top_n": 5})

    # Compute lead-lag for key pair
    leadlag = _signal_lead_lag({"signal_a": "wastewater_pathogen", "signal_b": "influenza_like"})

    # Build Gemini prompt
    prompt = f"""당신은 한국 호흡기 감염병 감시 시스템 Sentinel의 통합 예측 보고서 작성 AI입니다.
아래 분석 결과를 종합하여 정책결정자를 위한 간결한 브리핑 보고서를 작성하세요.

## 대상 지역: {region_id}

## 1. 점수 분해 (현재 상태)
- 등급: {decomposed.get('level', 'N/A')}
- 종합점수: {decomposed.get('composite_score', 'N/A')}
- 주요 기여 신호: {json.dumps(decomposed.get('contributions', [])[:3], ensure_ascii=False)}
- 해외 위험: {json.dumps(decomposed.get('top_imported_risk', [])[:2], ensure_ascii=False)}

## 2. EMA 예측 (4주)
{json.dumps(forecast_ema.get('forecast', []) if 'error' not in forecast_ema else [], ensure_ascii=False)}
- narrative: {forecast_ema.get('narrative', '')}

## 3. SARIMAX 예측 (4주)
{json.dumps(forecast_sarimax.get('forecast', []) if 'error' not in forecast_sarimax else [], ensure_ascii=False)}
- narrative: {forecast_sarimax.get('narrative', '')}

## 4. 전국 핫스팟 (상위 5)
{json.dumps([{{'region': h.get('name_kr'), 'score': h.get('projected_score'), 'level': h.get('projected_level'), 'delta': h.get('delta')}} for h in hotspots.get('hotspots', [])[:5]], ensure_ascii=False)}

## 5. 조기경보 신호 (Lead-Lag)
{leadlag.get('narrative', 'N/A') if 'error' not in leadlag else 'N/A'}

## 출력 규칙 (JSON)
하나의 JSON object로 응답하세요:
- "executive_summary": 2-3문장 요약 (정책결정자용, 현재 등급 + 향후 전망)
- "risk_assessment": 현재 위험 수준 평가 (1-2문장)
- "forecast_consensus": EMA와 SARIMAX 결과 비교 해석 (1-2문장, 두 모델이 일치하는지 발산하는지)
- "early_warning": 조기경보 신호 해석 (1문장)
- "action_items": 즉시 조치사항 3개 (각 1문장, 배열)
- "outlook": 향후 4주 전망 한 줄
JSON 외 다른 텍스트 금지.
"""

    try:
        from google import genai
        client = genai.Client(api_key=api_key)
        model_name = os.getenv("RISK_ANALYSIS_MODEL") or os.getenv("GEMINI_MODEL") or "gemini-3.5-flash"
        resp = client.models.generate_content(model=model_name, contents=prompt)
        raw = (resp.text or "").strip()
    except Exception as e:
        return {"error": f"Gemini call failed: {type(e).__name__}: {e}", "sections": []}

    cleaned = raw
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()

    try:
        report = json.loads(cleaned)
    except Exception:
        report = {"raw": raw[:800], "parse_error": True}

    return {
        "region_id": region_id,
        "report": report,
        "data_sources": {
            "decomposition": {"level": decomposed.get("level"), "score": decomposed.get("composite_score")},
            "forecast_ema": forecast_ema.get("narrative", "") if "error" not in forecast_ema else forecast_ema.get("error"),
            "forecast_sarimax": forecast_sarimax.get("narrative", "") if "error" not in forecast_sarimax else forecast_sarimax.get("error"),
            "hotspots_count": len(hotspots.get("hotspots", [])),
            "leadlag": leadlag.get("narrative", "") if "error" not in leadlag else "N/A",
        },
        "narrative": "통합 예측 보고서가 생성되었습니다. 모든 분석 결과를 종합한 Gemini 기반 executive briefing입니다.",
    }


register(FunctionSpec(
    name="generateForecastReport",
    label="Generate integrated forecast report",
    inputs=[
        {"name": "region_id", "type": "string", "required": True,
         "description": "Region.code (e.g. '11' for Seoul)"},
    ],
    output="object<{report: {executive_summary, risk_assessment, forecast_consensus, action_items, outlook}}>",
    affects_objects=["Region"],
    requires_admin=True,
    description="Generate an integrated forecasting report combining all analyses (decomposition, "
                "EMA, SARIMAX, hotspots, lead-lag) into a Gemini-synthesized executive briefing "
                "for policy decision-makers. Korean-language output.",
    fn=_generate_forecast_report,
))


# ═════════════════════════════════════════════════════════════════════════════
# Function 11 — generateDiseaseForecastReport (Disease integrated report + Gemini)
# ═════════════════════════════════════════════════════════════════════════════

def _generate_disease_forecast_report(inputs: dict) -> dict:
    """Generate an integrated forecasting report for a specific disease.

    Runs: EMA forecast + SARIMAX forecast + lead-lag analysis,
    then asks Gemini to synthesize a comprehensive Korean-language
    executive briefing for epidemiologists and policy decision-makers.
    """
    disease_id = str(inputs.get("disease_id") or "")
    if not disease_id:
        return {"error": "disease_id required"}

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return {"error": "GEMINI_API_KEY missing"}

    # Gather disease analyses
    forecast_ema = _forecast_disease_trend({"disease_id": disease_id, "weeks": 4})
    forecast_sarimax = _forecast_disease_sarimax({"disease_id": disease_id, "weeks": 4})
    leadlag = _signal_lead_lag({"signal_a": "wastewater_pathogen", "signal_b": "influenza_like"})

    # Disease registry for context
    _DISEASE_NAMES = {
        "influenza_ili": "인플루엔자 (ILI)", "sari_pneumonia": "중증폐렴 (SARI)",
        "sari_influenza": "중증인플루엔자 (SARI)", "ari_total": "급성호흡기감염증 (전체)",
        "rsv": "RSV (호흡기세포융합)", "hmpv": "사람메타뉴모바이러스",
        "adenovirus": "아데노바이러스", "covid19": "코로나19",
    }
    disease_name = _DISEASE_NAMES.get(disease_id, disease_id)

    prompt = f"""당신은 한국 호흡기 감염병 감시 시스템 Sentinel의 질병별 통합 예측 보고서 작성 AI입니다.
아래 분석 결과를 종합하여 역학자/정책결정자를 위한 간결한 브리핑 보고서를 작성하세요.

## 대상 질병: {disease_name} ({disease_id})

## 1. EMA 예측 (4주)
{json.dumps(forecast_ema.get('forecast', []) if 'error' not in forecast_ema else [], ensure_ascii=False)}
- 모델: {forecast_ema.get('method', {}).get('name', 'EMA')}
- EMA 기준선: {forecast_ema.get('ema_baseline', 'N/A')}
- 모멘텀: {forecast_ema.get('momentum', 'N/A')}
- narrative: {forecast_ema.get('narrative', '')}

## 2. SARIMAX 예측 (4주)
{json.dumps(forecast_sarimax.get('forecast', []) if 'error' not in forecast_sarimax else [], ensure_ascii=False)}
- AIC: {forecast_sarimax.get('diagnostics', {}).get('aic', 'N/A') if 'error' not in forecast_sarimax else 'N/A'}
- narrative: {forecast_sarimax.get('narrative', '')}

## 3. 조기경보 신호 (Lead-Lag)
{leadlag.get('narrative', 'N/A') if 'error' not in leadlag else 'N/A'}

## 출력 규칙 (JSON)
하나의 JSON object로 응답하세요:
- "executive_summary": 2-3문장 요약 (질병 현재 추세 + 향후 4주 전망)
- "risk_assessment": 현재 위험 수준 평가 (1-2문장, 이전 대비 증감 포함)
- "forecast_consensus": EMA와 SARIMAX 결과 비교 해석 (두 모델이 일치/발산 여부 + 어떤 모델을 더 신뢰할지)
- "early_warning": 조기경보 신호 해석 (1문장)
- "action_items": 해당 질병 관련 권장 조치사항 3개 (각 1문장, 배열)
- "outlook": 향후 4주 전망 한 줄
JSON 외 다른 텍스트 금지.
"""

    try:
        from google import genai
        client = genai.Client(api_key=api_key)
        model_name = os.getenv("RISK_ANALYSIS_MODEL") or os.getenv("GEMINI_MODEL") or "gemini-3.5-flash"
        resp = client.models.generate_content(model=model_name, contents=prompt)
        raw = (resp.text or "").strip()
    except Exception as e:
        return {"error": f"Gemini call failed: {type(e).__name__}: {e}"}

    cleaned = raw
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()

    try:
        report = json.loads(cleaned)
    except Exception:
        report = {"raw": raw[:800], "parse_error": True}

    return {
        "disease_id": disease_id,
        "report": report,
        "data_sources": {
            "forecast_ema": forecast_ema.get("narrative", "") if "error" not in forecast_ema else forecast_ema.get("error"),
            "forecast_sarimax": forecast_sarimax.get("narrative", "") if "error" not in forecast_sarimax else forecast_sarimax.get("error"),
            "leadlag": leadlag.get("narrative", "") if "error" not in leadlag else "N/A",
        },
        "narrative": f"{disease_name} 질병의 통합 예측 보고서가 생성되었습니다.",
    }


register(FunctionSpec(
    name="generateDiseaseForecastReport",
    label="Generate disease integrated forecast report",
    inputs=[
        {"name": "disease_id", "type": "string", "required": True,
         "description": "Disease ID (e.g. 'influenza', 'covid19')"},
    ],
    output="object<{report: {executive_summary, risk_assessment, forecast_consensus, action_items, outlook}}>",
    affects_objects=["Disease"],
    requires_admin=True,
    description="Generate an integrated forecasting report for a specific disease "
                "combining EMA, SARIMAX, and lead-lag analyses into a Gemini-synthesized "
                "executive briefing. Korean-language output.",
    fn=_generate_disease_forecast_report,
))
