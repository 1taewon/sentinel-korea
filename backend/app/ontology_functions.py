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
        model = os.getenv("RISK_ANALYSIS_MODEL") or os.getenv("GEMINI_MODEL") or "gemini-2.5-flash"
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
    """SARIMAX-based forecast for disease time-series.

    Uses statsmodels SARIMAX with regularization. Designed to work alongside
    the EMA forecast so the operator can compare two models side-by-side.
    """
    disease_id = str(inputs.get("disease_id") or "")
    weeks = max(1, min(int(inputs.get("weeks") or 4), 12))
    if not disease_id:
        return {"error": "disease_id required"}

    series = _load_disease_series(disease_id)
    if not series:
        return {"error": f"No time-series data for disease '{disease_id}'"}
    if len(series) < 10:
        return {"error": f"Insufficient data for SARIMAX ({len(series)} points, need >= 10)"}

    values = [p["value"] for p in series]

    try:
        import warnings
        warnings.filterwarnings("ignore")
        from statsmodels.tsa.statespace.sarimax import SARIMAX as _SARIMAX

        # SARIMAX(1,1,1) — order(p=1, d=1, q=1) with regularization
        # d=1 handles non-stationarity (trending data)
        model = _SARIMAX(
            values,
            order=(1, 1, 1),
            enforce_stationarity=False,
            enforce_invertibility=False,
        )
        results = model.fit(disp=False, maxiter=200)

        # Forecast
        import numpy as _np
        fc = results.get_forecast(steps=weeks)
        pred_mean = _np.asarray(fc.predicted_mean).flatten()
        conf_int_raw = fc.conf_int(alpha=0.1)  # 90% confidence
        conf_int_arr = _np.asarray(conf_int_raw)

        last_date = series[-1]["date"]
        try:
            ld = _date.fromisoformat(last_date)
        except Exception:
            ld = _date.today()

        points: list[dict] = []
        for i in range(weeks):
            dt = ld.fromordinal(ld.toordinal() + (i + 1) * 7)
            val = max(0, float(pred_mean[i]))
            lo = max(0, float(conf_int_arr[i, 0]))
            hi = max(0, float(conf_int_arr[i, 1]))
            points.append({
                "date": dt.isoformat(),
                "weeks_ahead": i + 1,
                "value": round(val, 1),
                "low": round(lo, 1),
                "high": round(hi, 1),
            })

        # Model diagnostics
        aic = round(float(results.aic), 1)
        bic = round(float(results.bic), 1)

        # Peak detection
        peak_val = max(values)
        peak_idx = values.index(peak_val)
        peak_date = series[peak_idx]["date"] if peak_idx < len(series) else ""

        # Narrative
        delta = points[-1]["value"] - values[-1]
        pct = (delta / max(1, values[-1])) * 100
        direction = "상승" if pct > 10 else "하락" if pct < -10 else "유지"

        return {
            "disease_id": disease_id,
            "model_name": "SARIMAX",
            "history": series,
            "forecast": points,
            "method": {
                "name": "SARIMAX(1,1,1)",
                "formula": "(1-φB)(1-B)Yₜ = (1+θB)εₜ",
                "parameters": {
                    "order": "(p=1, d=1, q=1)",
                    "differencing": "d=1 (1차 차분으로 비정상성 제거)",
                    "confidence": "90% (α=0.10)",
                    "AIC": aic,
                    "BIC": bic,
                },
                "description_kr": "SARIMAX(1,1,1) 모델은 자기회귀(AR), 차분(I), "
                                  "이동평균(MA)을 결합한 시계열 예측 방법입니다. "
                                  "1차 차분(d=1)으로 추세를 제거하고, AR(1)으로 이전 값의 영향을, "
                                  "MA(1)으로 잔차 패턴을 포착합니다. "
                                  "90% 신뢰구간은 모델의 예측 불확실성을 반영합니다.",
            },
            "diagnostics": {"aic": aic, "bic": bic},
            "peak": {"date": peak_date, "value": peak_val},
            "narrative": f"[SARIMAX] {weeks}주 후 예상: {points[-1]['value']:.0f} "
                         f"(현재 {values[-1]:.0f}, {direction} {pct:+.0f}%). "
                         f"AIC={aic}, 90% CI: [{points[-1]['low']:.0f}-{points[-1]['high']:.0f}].",
        }

    except Exception as e:
        return {"error": f"SARIMAX fitting failed: {type(e).__name__}: {e}",
                "disease_id": disease_id}


register(FunctionSpec(
    name="forecastDiseaseSARIMAX",
    label="Forecast disease trend (SARIMAX)",
    inputs=[
        {"name": "disease_id", "type": "string", "required": True,
         "description": "Disease.id"},
        {"name": "weeks", "type": "integer", "required": False, "default": 4,
         "description": "Forecast horizon (1-12 weeks)"},
    ],
    output="object<{history, forecast: list<{date,value,low,high}>, method, diagnostics, narrative}>",
    affects_objects=["Disease"],
    requires_admin=False,
    description="SARIMAX(1,1,1) forecast with 90% confidence interval. "
                "Statsmodels-based — requires >= 10 data points. Compare against EMA forecast "
                "for multi-model decision support.",
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
            model = os.getenv("RISK_ANALYSIS_MODEL") or os.getenv("GEMINI_MODEL") or "gemini-2.5-flash"

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
    "CJU": {
        "label": "제주국제공항",
        "label_en": "Jeju International Airport",
        "primary_zones": ["50"],  # Jeju
        "lat": 33.5104, "lng": 126.4914,
    },
    "TAE": {
        "label": "대구국제공항",
        "label_en": "Daegu International Airport",
        "primary_zones": ["27", "47"],  # Daegu, Gyeongbuk
        "lat": 35.8941, "lng": 128.6589,
    },
    "MWX": {
        "label": "무안국제공항",
        "label_en": "Muan International Airport",
        "primary_zones": ["46"],  # Jeonnam
        "lat": 34.9914, "lng": 126.3828,
    },
    "CJJ": {
        "label": "청주국제공항",
        "label_en": "Cheongju International Airport",
        "primary_zones": ["43", "44"],  # Chungbuk, Chungnam
        "lat": 36.7166, "lng": 127.4991,
    },
    "YNY": {
        "label": "양양국제공항",
        "label_en": "Yangyang International Airport",
        "primary_zones": ["42"],  # Gangwon
        "lat": 38.0613, "lng": 128.6690,
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


def _what_if_outbreak_national(inputs: dict) -> dict:
    entry_code = str(inputs.get("entry_point") or "ICN").upper()
    disease_name = str(inputs.get("disease") or "novel respiratory pathogen")
    country = str(inputs.get("country") or "China")
    severity = str(inputs.get("severity") or "high").lower()
    weeks = max(1, min(int(inputs.get("weeks") or 4), 12))

    entry_point = _ENTRY_POINTS.get(entry_code)
    if not entry_point:
        # Fallback for custom/unknown entry: use Korea center, no primary zones, all distance-based
        entry_point = {
            "label": entry_code,
            "label_en": entry_code,
            "primary_zones": [],
            "lat": 36.5,  # Korea geographic center
            "lng": 127.8,
        }

    # Base lift from severity × country proximity
    base_lift = _SEVERITY_LIFT.get(severity, 0.03)
    prox = _PROXIMITY_MULT.get(country.lower(), 0.5)
    full_lift = min(0.15, base_lift * prox)

    # Real outbreak context
    outbreaks = _all_outbreaks()
    real_exo = min(0.05, len([o for o in outbreaks if _korea_relevance(o) >= 0.6]) * 0.005)

    # Compute per-region scenarios
    region_results = []
    for code, meta in sorted(_REGION_COORDS.items()):
        spread_mult = _spread_multiplier(code, entry_point)
        region_lift = full_lift * spread_mult
        total_exo = real_exo + region_lift

        # Get baseline forecast for this region
        baseline = _forecast_region_score({"region_id": code, "weeks": weeks})
        if "error" in baseline:
            region_results.append({
                "region_id": code, "region_name": meta["name"],
                "spread_multiplier": round(spread_mult, 3),
                "lift": round(region_lift, 4),
                "error": baseline["error"],
            })
            continue

        history = baseline["history"]
        scores = [p["score"] for p in history if p.get("score") is not None]
        if not scores:
            region_results.append({
                "region_id": code, "region_name": meta["name"],
                "spread_multiplier": round(spread_mult, 3),
                "lift": round(region_lift, 4),
                "error": "No score history",
            })
            continue

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

        last_date = _date.fromisoformat(history[-1]["date"])
        baseline_pts = baseline["forecast"]
        scenario_pts: list[dict] = []
        for i in range(1, weeks + 1):
            dt = last_date.fromordinal(last_date.toordinal() + i * 7)
            decayed_m = momentum * (0.7 ** (i - 1))
            proj = max(0.0, min(1.0, ema + decayed_m + total_exo))
            band = vol * (1 + 0.25 * (i - 1))
            scenario_pts.append({
                "date": dt.isoformat(), "weeks_ahead": i,
                "score": round(proj, 4), "level": _level_for(proj),
                "low": round(max(0, proj - band), 4),
                "high": round(min(1, proj + band), 4),
            })

        comparison = []
        for b, s in zip(baseline_pts, scenario_pts):
            comparison.append({
                "weeks_ahead": b["weeks_ahead"],
                "baseline_score": b["score"], "baseline_level": b["level"],
                "scenario_score": s["score"], "scenario_level": s["level"],
                "delta": round(s["score"] - b["score"], 4),
                "level_changed": b["level"] != s["level"],
            })

        # Use last week's data for summary
        last_b = baseline_pts[-1] if baseline_pts else {}
        last_s = scenario_pts[-1] if scenario_pts else {}

        region_results.append({
            "region_id": code,
            "region_name": meta["name"],
            "is_primary_zone": code in entry_point["primary_zones"],
            "spread_multiplier": round(spread_mult, 3),
            "lift": round(region_lift, 4),
            "baseline_level": last_b.get("level", "G0"),
            "baseline_score": last_b.get("score", 0),
            "scenario_level": last_s.get("level", "G0"),
            "scenario_score": last_s.get("score", 0),
            "max_delta": round(max(c["delta"] for c in comparison), 4),
            "level_changed": any(c["level_changed"] for c in comparison),
            "comparison": comparison,
        })

    # Sort by max_delta descending for ranking
    region_results.sort(key=lambda r: r.get("max_delta", 0), reverse=True)

    # Summary stats
    escalated_regions = [r for r in region_results if r.get("level_changed")]
    total_delta = sum(r.get("max_delta", 0) for r in region_results if "error" not in r)

    # Gemini national scenario narrative
    gemini_scenario = None
    api_key = os.getenv("GEMINI_API_KEY")
    if api_key:
        try:
            from google import genai
            client = genai.Client(api_key=api_key)
            model = os.getenv("RISK_ANALYSIS_MODEL") or os.getenv("GEMINI_MODEL") or "gemini-2.5-flash"

            top5 = region_results[:5]
            summary_lines = []
            for r in top5:
                if "error" in r:
                    continue
                spread = "PRIMARY ZONE" if r.get("is_primary_zone") else "spread x{:.2f}".format(r.get("spread_multiplier", 0))
                summary_lines.append(
                    "  - {}({}): baseline {} -> scenario {} (delta +{:.3f}, {})".format(
                        r["region_name"], r["region_id"],
                        r.get("baseline_level", "?"), r.get("scenario_level", "?"),
                        r.get("max_delta", 0), spread
                    )
                )
            region_summary = "\n".join(summary_lines)

            prompt = f"""당신은 한국 호흡기 감염병 감시 시스템 Sentinel의 전국 확산 시나리오 분석 AI입니다.

## 가상 시나리오
- 발생 국가: {country}
- 질병: {disease_name}
- 심각도: {severity}
- 유입 거점: {entry_point['label']} ({entry_code})
- 1차 영향권: {', '.join(entry_point['primary_zones'])} ({', '.join(_REGION_COORDS[c]['name'] for c in entry_point['primary_zones'] if c in _REGION_COORDS)})

## 전국 확산 분석 결과 (위험도 상승 상위 5개 지역)
{region_summary}

## 전체 통계
- G-level 상향된 지역: {len(escalated_regions)}/{len(region_results)}개
- 전국 총 delta 합: +{total_delta:.3f}

## 요청
전국 확산 관점에서 다음을 JSON으로 작성하세요:
1. "impact_summary": 이 시나리오의 전국적 영향 요약 (3-4문장, 한국어). 유입 거점에서의 1차 영향과 주변 지역으로의 확산 패턴을 설명.
2. "spread_pattern": 확산 경로 설명 (유입 거점 → 인접 지역 → 전국, 2-3문장)
3. "timeline": 주차별 예상 전개 시나리오 (전국 관점, 배열 [{{"week": 1, "description": "..."}}])
4. "response_actions": 정책결정자가 취해야 할 선제 대응 조치 4-6개 (유입 거점 + 전국 단위, priority/action/timing 포함)
5. "high_risk_regions": 특별 주의 필요 지역 목록과 이유 (배열 [{{"region": "...", "reason": "..."}}])
6. "risk_factors": 상황을 악화시킬 수 있는 추가 위험 요인 3-4개
7. "best_case": 최선의 시나리오 (1문장)
8. "worst_case": 최악의 시나리오 (1문장)

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
                gemini_scenario = {"raw": raw[:1200], "parse_error": True}
        except Exception as e:
            gemini_scenario = {"error": f"Gemini call failed: {type(e).__name__}: {e}"}

    return {
        "entry_point": {
            "code": entry_code,
            "label": entry_point["label"],
            "primary_zones": entry_point["primary_zones"],
        },
        "scenario": {
            "disease": disease_name,
            "country": country,
            "severity": severity,
            "base_lift": round(full_lift, 4),
            "proximity_multiplier": round(prox, 2),
        },
        "regions": region_results,
        "summary": {
            "total_regions": len(region_results),
            "escalated_count": len(escalated_regions),
            "escalated_regions": [r["region_name"] for r in escalated_regions],
            "total_delta": round(total_delta, 4),
        },
        "gemini_scenario": gemini_scenario,
        "narrative": (
            f"전국 확산 시나리오: {country}에서 {disease_name} ({severity}) 발생 → "
            f"{entry_point['label']} 유입. "
            f"{len(escalated_regions)}개 지역 G-level 상향 예상. "
            f"1차 영향권: {', '.join(_REGION_COORDS[c]['name'] for c in entry_point['primary_zones'] if c in _REGION_COORDS)}"
        ),
    }


register(FunctionSpec(
    name="whatIfOutbreakNational",
    label="National outbreak spread simulation",
    inputs=[
        {"name": "entry_point", "type": "string", "required": False, "default": "ICN",
         "description": "Airport entry code: ICN (인천), PUS (김해), CJU (제주), TAE (대구)"},
        {"name": "disease", "type": "string", "required": False, "default": "novel respiratory pathogen"},
        {"name": "country", "type": "string", "required": False, "default": "China"},
        {"name": "severity", "type": "string", "required": False, "default": "high",
         "description": "low | medium | high | critical"},
        {"name": "weeks", "type": "integer", "required": False, "default": 4},
    ],
    output="object<{entry_point, scenario, regions[], summary, gemini_scenario, narrative}>",
    affects_objects=["Region"],
    requires_admin=True,
    description="National outbreak spread simulation: models disease entry through a selected "
                "airport and computes proximity-weighted spread to all 17 Korean regions. "
                "Primary zones (e.g. 수도권 for Incheon) get full lift; other regions decay by distance. "
                "Gemini generates a national spread narrative with response recommendations.",
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
    if n < 10:
        return {"error": f"insufficient paired data points ({n}, need >= 10)"}

    # Normalize to zero-mean, unit-variance
    mean_a = statistics.mean(series_a)
    mean_b = statistics.mean(series_b)
    std_a = statistics.stdev(series_a) if n > 1 else 1
    std_b = statistics.stdev(series_b) if n > 1 else 1
    std_a = max(std_a, 1e-9)
    std_b = max(std_b, 1e-9)
    norm_a = [(v - mean_a) / std_a for v in series_a]
    norm_b = [(v - mean_b) / std_b for v in series_b]

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
        if len(a_slice) < 4:
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
        "best_lag": {
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
                "min_pairs": 4,
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
    """SARIMAX-based forecast for Region composite score time-series.

    Uses snapshot history (same as forecastRegionScore) but applies statsmodels
    SARIMAX(1,1,1) for a more rigorous statistical forecast with confidence
    intervals. Designed to run alongside the EMA model for dual-model comparison.
    """
    region_id = str(inputs.get("region_id") or "")
    weeks = max(1, min(int(inputs.get("weeks") or 4), 12))
    if not region_id:
        return {"error": "region_id required"}

    history = _region_history_points(region_id, weeks=24)
    if not history:
        return {"error": f"no history for region {region_id}"}

    scores = [p["score"] for p in history if p.get("score") is not None]
    if len(scores) < 10:
        return {"error": f"Insufficient data for SARIMAX ({len(scores)} points, need >= 10)"}

    try:
        import warnings
        warnings.filterwarnings("ignore")
        from statsmodels.tsa.statespace.sarimax import SARIMAX as _SARIMAX
        import numpy as _np

        model = _SARIMAX(
            scores,
            order=(1, 1, 1),
            enforce_stationarity=False,
            enforce_invertibility=False,
        )
        results = model.fit(disp=False, maxiter=200)

        fc = results.get_forecast(steps=weeks)
        pred_mean = _np.asarray(fc.predicted_mean).flatten()
        conf_int_raw = fc.conf_int(alpha=0.1)  # 90% CI
        conf_int_arr = _np.asarray(conf_int_raw)

        last_date = history[-1]["date"]
        try:
            ld = _date.fromisoformat(last_date)
        except Exception:
            ld = _date.today()

        points: list[dict] = []
        for i in range(weeks):
            dt = ld.fromordinal(ld.toordinal() + (i + 1) * 7)
            val = max(0.0, min(1.0, float(pred_mean[i])))
            lo = max(0.0, float(conf_int_arr[i, 0]))
            hi = min(1.0, float(conf_int_arr[i, 1]))
            points.append({
                "date": dt.isoformat(),
                "weeks_ahead": i + 1,
                "score": round(val, 4),
                "level": _level_for(val),
                "low": round(lo, 4),
                "high": round(hi, 4),
            })

        aic = round(float(results.aic), 1)
        bic = round(float(results.bic), 1)

        delta = points[-1]["score"] - scores[-1]
        direction = "상승" if delta > 0.05 else "하락" if delta < -0.05 else "유지"

        return {
            "region_id": region_id,
            "model_name": "SARIMAX",
            "history": history,
            "forecast": points,
            "method": {
                "name": "SARIMAX(1,1,1)",
                "formula": "(1-φB)(1-B)Yₜ = (1+θB)εₜ",
                "parameters": {
                    "order": "(p=1, d=1, q=1)",
                    "differencing": "d=1 (1차 차분으로 비정상성 제거)",
                    "confidence": "90% (α=0.10)",
                    "AIC": aic,
                    "BIC": bic,
                },
                "description_kr": "SARIMAX(1,1,1) 모델을 지역 복합점수 시계열에 적용합니다. "
                                  "1차 차분(d=1)으로 추세를 제거하고, AR(1)으로 이전 값의 영향을, "
                                  "MA(1)으로 잔차 패턴을 포착합니다. "
                                  "EMA 모델과 비교하여 다중 모델 관점에서 의사결정을 지원합니다.",
            },
            "diagnostics": {"aic": aic, "bic": bic},
            "narrative": f"[SARIMAX] {weeks}주 후 예상 score {points[-1]['score']:.3f} "
                         f"({points[-1]['level']}), 현재 대비 {direction} (Δ {delta:+.3f}). "
                         f"AIC={aic}, 90% CI: [{points[-1]['low']:.3f}-{points[-1]['high']:.3f}].",
        }

    except Exception as e:
        return {"error": f"SARIMAX fitting failed: {type(e).__name__}: {e}",
                "region_id": region_id}


register(FunctionSpec(
    name="forecastRegionSARIMAX",
    label="Forecast region score (SARIMAX)",
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
        model_name = os.getenv("RISK_ANALYSIS_MODEL") or os.getenv("GEMINI_MODEL") or "gemini-2.5-flash"
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
        model_name = os.getenv("RISK_ANALYSIS_MODEL") or os.getenv("GEMINI_MODEL") or "gemini-2.5-flash"
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
