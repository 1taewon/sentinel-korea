"""03_build_risk.py — 냉각탑 + 목욕장업 + 고위험병원 → PHWR 가중 → risk_points.geojson

2021 PHWR 레지오넬라 환경검사 검출률을 시설유형 위험 가중치로 인코딩한다.
출력 risk_points.geojson 각 점: properties.weight (0~1). (지도 히트맵은 프런트에서 동일 가중치로
직접 계산하지만, 이 파일은 배치/재현·격자 choropleth 확장을 위한 산출물.)

주의: 위험도는 '환경 오염 경향'이며 '환자 발생 예측'이 아니다(2021 PHWR: 지역 검출률과 환자
발생률 사이 상관 없음).
"""
from __future__ import annotations

import json
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
PUB = BASE.parents[0] / "frontend" / "public" / "data"
OUT = PUB / "risk_points.geojson"

# 시설유형 PHWR 위험 가중치.
BATH_W = {"온천": 0.394, "찜질방": 0.375, "대형목욕탕": 0.328, "대중목욕탕": 0.164, "사우나": 0.164, "목욕장업": 0.164}
HOSP_W = {"상급종합": 0.35, "종합병원": 0.263, "요양병원": 0.20}
TOWER_W = 0.5  # 냉각탑 최고 가중치
BUSAN_COEF = float(0.296)  # 부산 지역 계수(단일 데모면 상수)


def _load(name: str) -> list[dict]:
    p = PUB / name
    if not p.exists():
        return []
    try:
        return (json.loads(p.read_text(encoding="utf-8")).get("features") or [])
    except Exception:
        return []


def _bath_weight(sub: str) -> float:
    for k, w in BATH_W.items():
        if k in (sub or ""):
            return w
    return BATH_W["목욕장업"]


def _hosp_weight(cl: str) -> float:
    for k, w in HOSP_W.items():
        if k in (cl or ""):
            return w
    return 0.20


def main() -> None:
    feats = []
    for f in _load("cooling_towers.geojson"):
        c = f.get("geometry", {}).get("coordinates")
        if c:
            feats.append({"type": "Feature", "properties": {"kind": "cooling_tower", "weight": round(TOWER_W, 4)},
                          "geometry": {"type": "Point", "coordinates": c}})
    for f in _load("facilities_bath.geojson"):
        c = f.get("geometry", {}).get("coordinates")
        if c:
            w = _bath_weight((f.get("properties") or {}).get("subtype", ""))
            feats.append({"type": "Feature", "properties": {"kind": "bath", "weight": round(w, 4)},
                          "geometry": {"type": "Point", "coordinates": c}})
    for f in _load("facilities_hospital.geojson"):
        c = f.get("geometry", {}).get("coordinates")
        if c:
            w = _hosp_weight((f.get("properties") or {}).get("clCdNm", ""))
            feats.append({"type": "Feature", "properties": {"kind": "hospital", "weight": round(w, 4)},
                          "geometry": {"type": "Point", "coordinates": c}})
    OUT.write_text(json.dumps({
        "type": "FeatureCollection",
        "note": "PHWR-weighted risk points. 환경 오염 경향이며 환자 발생 예측 아님.",
        "region_coefficient": BUSAN_COEF,
        "features": feats,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"위험 점 {len(feats)}건 (냉각탑+목욕장+병원) → {OUT}")


if __name__ == "__main__":
    main()
