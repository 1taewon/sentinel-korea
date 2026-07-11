"""legionella_lib.py — de-identified survey → source matching → investigation hotspots.

Deterministic epidemiology (match + KDE hotspot) + a Gemini parse step for the
free-text survey. NO patient/personal data leaves the box: PII patterns are stripped
before the LLM call and dropped from any output. All distances use a latitude-aware
local metre projection (pyproj-free, valid nationwide); output GeoJSON stays WGS84 [lng,lat].

Framing (fixed in outputs): the risk map is an environmental-contamination tendency,
NOT a patient-incidence forecast; a hotspot is a spatiotemporal cluster of exposure
candidates, NOT a confirmed source — confirmation needs 채수·배양 병원체 일치, and the
final call is the epidemiologist's. Demo uses synthetic/de-identified data only.
"""
from __future__ import annotations

import json
import math
import os
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

# 전국 사업장·병원 좌표 소스 (Phase 1-4 산출물). 두 위치를 순서대로 탐색한다:
# (1) 레포 루트 frontend/public/data — 로컬 개발(프론트와 공유),
# (2) backend/app/legionella_data — 배포용 번들(Railway 백엔드 컨테이너엔 frontend/ 가 없으므로).
_DATA_CANDIDATES = [
    Path(__file__).resolve().parents[2] / "frontend" / "public" / "data",
    Path(__file__).resolve().parent / "legionella_data",
]
_PUBLIC_DATA = next((p for p in _DATA_CANDIDATES if (p / "facilities_bath.geojson").exists()), _DATA_CANDIDATES[0])
_MPD_LAT = 111_000.0  # metres per degree latitude (거의 상수)

EXPOSURE_BACK_MAX = 14  # 발병 전 최대일 (노출 시간창 시작)
EXPOSURE_BACK_MIN = 2   # 발병 전 최소일 (노출 시간창 끝)
DEFAULT_RADIUS_M = 500.0
KDE_BANDWIDTH_M = 300.0

_BATH_W = {"온천": 0.394, "찜질방": 0.375, "대형목욕탕": 0.328, "대중목욕탕": 0.164, "사우나": 0.164, "목욕장업": 0.164}
_HOSP_W = {"상급종합": 0.35, "종합병원": 0.263, "요양병원": 0.20}
TOWER_W = 0.5

_PII = [
    (re.compile(r"\d{6}\s*[-–]\s*\d{7}"), "[주민번호제거]"),        # RRN
    (re.compile(r"01[0-9]\s*[-–]?\s*\d{3,4}\s*[-–]?\s*\d{4}"), "[연락처제거]"),  # mobile
    (re.compile(r"0\d{1,2}\s*[-–]\s*\d{3,4}\s*[-–]\s*\d{4}"), "[연락처제거]"),   # landline
]


def strip_pii(text: str) -> str:
    out = text or ""
    for pat, repl in _PII:
        out = pat.sub(repl, out)
    return out


# ── metre helpers (local equirectangular; latitude-aware so it holds nationwide) ──
def _xy(lat: float, lng: float) -> tuple[float, float]:
    return (lng * _MPD_LAT * math.cos(math.radians(lat)), lat * _MPD_LAT)


def _dist_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    (ax, ay), (bx, by) = _xy(*a), _xy(*b)
    return math.hypot(ax - bx, ay - by)


def _bath_weight(sub: str) -> float:
    for k, w in _BATH_W.items():
        if k in (sub or ""):
            return w
    return _BATH_W["목욕장업"]


def _hosp_weight(cl: str) -> float:
    for k, w in _HOSP_W.items():
        if k in (cl or ""):
            return w
    return 0.20


def load_facilities() -> list[dict]:
    """부산 목욕장업 + 고위험 병원 → [{lat,lng,kind,name,weight,sub}]."""
    out: list[dict] = []
    for fn, kind in (("facilities_bath.geojson", "bath"), ("facilities_hospital.geojson", "hospital")):
        p = _PUBLIC_DATA / fn
        if not p.exists():
            continue
        try:
            for f in json.loads(p.read_text(encoding="utf-8")).get("features", []):
                c = (f.get("geometry") or {}).get("coordinates")
                pr = f.get("properties") or {}
                if not c:
                    continue
                if kind == "bath":
                    sub = pr.get("subtype", "목욕장업"); w = _bath_weight(sub); name = pr.get("name", "목욕장업")
                else:
                    sub = pr.get("clCdNm", "병원"); w = _hosp_weight(sub); name = pr.get("name", "병원")
                out.append({"lat": c[1], "lng": c[0], "kind": kind, "name": name, "sub": sub, "weight": w})
        except Exception:
            continue
    return out


# ── survey parsing (Gemini + regex fallback) ────────────────────────────────
_PARSE_SCHEMA_HINT = (
    '{"onset_date":"YYYY-MM-DD|null","hospitalized":true|false,'
    '"hospital_days":정수|null,"hospitalized_consecutive_10d":true|false,'
    '"travel_overnight_2w":true|false,'
    '"risk_places":[{"type":"요양시설|의료기관|숙박업소|대형건물|수영장·온천|목욕장·온천|기타",'
    '"used_date":"YYYY-MM-DD|null","exposures":["냉방·가습기기|샤워 또는 목욕|수영"]}],'
    '"presumed_area":"읍면동 수준 주소|null"}'
)


def parse_survey_text(text: str, use_llm: bool = True) -> dict:
    """Extract G-6/Z fields. Gemini if GEMINI_API_KEY set, else regex fallback.
    Never extracts/returns 성명·주민번호·연락처. Pass use_llm=False for a deterministic,
    offline parse (used by the 예시 분석 demo so it is reproducible across deploys)."""
    clean = strip_pii(text or "")
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if use_llm and key:
        try:
            from google import genai
            client = genai.Client(api_key=key)
            model = os.getenv("RISK_ANALYSIS_MODEL") or os.getenv("GEMINI_MODEL") or "gemini-3.5-flash"
            prompt = (
                "당신은 레지오넬라증 역학조사서(G-6 위험요인·입원)를 구조화하는 도구다. 아래 조사서에서 "
                "양식에 명시된 값만 추출하고 추론하지 말 것. 개인식별정보(성명·주민등록번호·주소 상세·연락처)는 "
                "추출·반환 금지(추정감염지역은 읍면동 수준까지만). 다음 JSON 하나로만 응답:\n"
                f"{_PARSE_SCHEMA_HINT}\n\n[조사서]\n{clean[:6000]}\n\nJSON:"
            )
            raw = (client.models.generate_content(model=model, contents=prompt).text or "").strip()
            if raw.startswith("```"):
                raw = raw.strip("`")
                raw = raw[4:] if raw.startswith("json") else raw
            data = json.loads(raw.strip())
            return _sanitize_case(data)
        except Exception:
            pass
    return _sanitize_case(_regex_parse(clean))


def _regex_parse(text: str) -> dict:
    def find(*pats):
        for p in pats:
            m = re.search(p, text)
            if m:
                return m.group(1).strip()
        return None
    onset = find(r"최초증상\s*발생일[:\s]*([\d]{4}[-.\s/][\d]{1,2}[-.\s/][\d]{1,2})",
                 r"발병일[:\s]*([\d]{4}[-.\s/][\d]{1,2}[-.\s/][\d]{1,2})")
    # area may be inline ("추정 감염지역: 부산…") or on the line after a section header ("[7. 추정 감염지역]\n부산…").
    area = find(r"추정\s*감염\s*지역[ \t]*[:：][ \t]*([^\n\]]+)",
                r"추정\s*감염\s*지역[^\n]*\][ \t]*\n[ \t]*([^\n]+)",
                r"추정감염지역[:\s]*(.+)")
    hosp_days = find(r"입원\s*기간[:\s]*([\d]+)\s*일", r"입원[:\s]*([\d]+)\s*일")
    hospitalized = bool(hosp_days) or ("입원" in text and "입원 안" not in text and "미입원" not in text)
    places = []
    for kw, typ in (("온천", "목욕장·온천"), ("목욕", "목욕장·온천"), ("찜질", "목욕장·온천"),
                    ("사우나", "목욕장·온천"), ("요양", "요양시설"), ("병원", "의료기관"),
                    ("숙박", "숙박업소"), ("호텔", "숙박업소"), ("수영", "수영장·온천"), ("대형건물", "대형건물")):
        if kw in text:
            places.append({"type": typ, "used_date": None,
                           "exposures": (["샤워 또는 목욕"] if typ == "목욕장·온천" else ["냉방·가습기기"])})
    # colon/spacing-robust travel detection (KDCA form uses "여행력: 없음" / "여행력 있음(2박)").
    no_travel = bool(re.search(r"여행\s*력?\s*[:：]?\s*(없|안\s*함|해당\s*없)", text))
    travel = (not no_travel) and (
        bool(re.search(r"여행\s*력?\s*[:：]?\s*있", text))
        or bool(re.search(r"\d\s*박", text)) and "여행" in text
        or "숙박업소" in text
    )
    return {"onset_date": _norm_date(onset), "hospitalized": hospitalized,
            "hospital_days": int(hosp_days) if hosp_days else None,
            "hospitalized_consecutive_10d": bool(hosp_days and int(hosp_days) >= 10),
            "travel_overnight_2w": travel,
            "risk_places": places, "presumed_area": area}


def _norm_date(s: str | None) -> str | None:
    if not s:
        return None
    m = re.search(r"(\d{4})[-.\s/](\d{1,2})[-.\s/](\d{1,2})", s)
    if not m:
        return None
    try:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
    except Exception:
        return None


def _sanitize_case(d: dict) -> dict:
    """Keep only the allowed fields; never carry a name/RRN/phone through."""
    d = d if isinstance(d, dict) else {}
    places = []
    for p in (d.get("risk_places") or [])[:8]:
        if isinstance(p, dict):
            places.append({"type": str(p.get("type") or "기타"),
                           "used_date": _norm_date(p.get("used_date")) if isinstance(p.get("used_date"), str) else None,
                           "exposures": [str(x) for x in (p.get("exposures") or [])][:4]})
    return {
        "onset_date": _norm_date(d.get("onset_date")) if isinstance(d.get("onset_date"), str) else None,
        "hospitalized": bool(d.get("hospitalized")),
        "hospital_days": int(d["hospital_days"]) if str(d.get("hospital_days") or "").isdigit() else None,
        "hospitalized_consecutive_10d": bool(d.get("hospitalized_consecutive_10d")),
        "travel_overnight_2w": bool(d.get("travel_overnight_2w")),
        "risk_places": places,
        "presumed_area": strip_pii(str(d["presumed_area"])) if d.get("presumed_area") else None,
    }


# ── geocode (V-World) with a small 부산 fallback for the demo ────────────────
_BUSAN_FALLBACK = {
    # 온천 = 동래온천 목욕장 밀집지(허심청·반도온천·대성관 일대) 중심 → 반경 내 실제 시설 다수.
    "온천": (129.0815, 35.2195), "동래": (129.0836, 35.1970), "서면": (129.0602, 35.1577),
    "부산진": (129.0498, 35.1631), "해운대": (129.1603, 35.1631), "연산": (129.0836, 35.1846),
    "사상": (128.9915, 35.1524), "남포": (129.0281, 35.0979), "광안": (129.1183, 35.1533),
}


def geocode(address: str) -> tuple[float, float] | None:
    if not address:
        return None
    key = os.getenv("VWORLD_KEY", "").strip()
    if key:
        for atype in ("ROAD", "PARCEL"):
            try:
                j = httpx.get("https://api.vworld.kr/req/address", params={
                    "service": "address", "request": "getcoord", "version": "2.0", "crs": "EPSG:4326",
                    "type": atype, "address": address, "format": "json", "key": key}, timeout=12).json()
                if (j.get("response") or {}).get("status") == "OK":
                    p = j["response"]["result"]["point"]
                    return float(p["x"]), float(p["y"])
            except Exception:
                continue
    for kw, (lng, lat) in _BUSAN_FALLBACK.items():  # demo fallback by dong keyword
        if kw in address:
            return lng, lat
    return None


def demo_geocode(address: str) -> tuple[float, float] | None:
    """Stable, curated coordinates for the synthetic demo only (no live geocoder).

    The 예시 분석 must produce the same investigation every time regardless of whether a
    live V-World key is set, so it maps 읍면동 keywords straight to curated 부산 anchors
    (온천 = 동래온천 목욕장 밀집지) instead of geocoding a vague administrative name."""
    if not address:
        return None
    for kw, (lng, lat) in _BUSAN_FALLBACK.items():
        if kw in address:
            return lng, lat
    return None


# ── deterministic matching ──────────────────────────────────────────────────
def _proximity(dist_m: float, radius_m: float) -> float:
    return max(0.0, 1.0 - dist_m / radius_m)


def match_sources(cases: list[dict], towers: list[tuple[float, float]], facilities: list[dict],
                  radius_m: float = DEFAULT_RADIUS_M) -> dict:
    """cases (parsed + id) → per-case exposure candidates, common-source ranking, Z route draft."""
    candidates_all = (
        [{"kind": "cooling_tower", "name": "냉각탑", "lat": t[0], "lng": t[1], "weight": TOWER_W} for t in towers]
        + [{"kind": f["kind"], "name": f["name"], "sub": f.get("sub"), "lat": f["lat"], "lng": f["lng"], "weight": f["weight"]} for f in facilities]
    )
    case_results = []
    cand_scores: dict[tuple, dict] = {}
    for case in cases:
        loc = case.get("location")  # [lng,lat]
        exposed = []
        if loc:
            cloc = (loc[1], loc[0])
            for c in candidates_all:
                d = _dist_m(cloc, (c["lat"], c["lng"]))
                if d <= radius_m:
                    prox = _proximity(d, radius_m)
                    exposed.append({**c, "dist_m": round(d), "proximity": round(prox, 3)})
                    kkey = (round(c["lat"], 5), round(c["lng"], 5), c["kind"])
                    agg = cand_scores.setdefault(kkey, {**c, "cases": set(), "prox_sum": 0.0})
                    agg["cases"].add(case["id"]); agg["prox_sum"] += prox
        exposed.sort(key=lambda x: (x["proximity"] * x["weight"]), reverse=True)
        case_results.append({
            "id": case["id"], "onset_date": case.get("onset_date"), "location": loc,
            "exposure_candidates": exposed[:8],
            "route": _infer_route(case, exposed),
        })
    common = []
    for agg in cand_scores.values():
        n = len(agg["cases"])
        common.append({
            "kind": agg["kind"], "name": agg["name"], "sub": agg.get("sub"),
            "lat": agg["lat"], "lng": agg["lng"],
            "linked_cases": sorted(agg["cases"]), "case_count": n,
            # case convergence dominates: a source shared by multiple cases outranks any
            # single-case proximity. score = case_count² · PHWR weight · mean proximity.
            "score": round(n * agg["weight"] * agg["prox_sum"], 4),
        })
    common.sort(key=lambda x: x["score"], reverse=True)
    return {"case_results": case_results, "common_candidates": common}


def _infer_route(case: dict, exposed: list[dict]) -> dict:
    """Z 감염경로 용어정의 규칙(초안). 확정 아님.

    의료기관내감염은 환자가 노출 시간창(발병 전 2~14일)에 '의료기관/요양시설을 이용/입원'했다고
    조사서에 보고된 경우만 해당한다(치료 목적 입원이나 단순 인근 병원 존재는 제외 — 그래서 위치가
    아니라 보고된 위험장소(risk_places)로 판정)."""
    days = case.get("hospital_days") or 0
    med_place = any(p.get("type") in ("의료기관", "요양시설") for p in case.get("risk_places", []))
    if med_place and (case.get("hospitalized_consecutive_10d") or days >= 10):
        return {"label": "의료기관내감염(확정)", "reason": "발병 전 10일 연속 의료기관 입원력 보고."}
    if med_place and case.get("hospitalized") and 1 <= days <= 9:
        return {"label": "의료기관내감염(가능성 높음)", "reason": f"노출 시간창 내 의료기관 이용력 + {days}일 입원."}
    if case.get("travel_overnight_2w"):
        return {"label": "여행관련감염", "reason": "2주 이내 1박 이상 여행."}
    if any(p.get("type") in ("목욕장·온천", "수영장·온천", "대형건물") for p in case.get("risk_places", [])) or exposed:
        return {"label": "지역사회감염", "reason": "2주 이내 수계시설(목욕장·온천·대형건물 등) 노출."}
    return {"label": "불분명", "reason": "위 조건 미해당."}


# ── KDE hotspots ("어디부터 조사할지") ──────────────────────────────────────
def build_hotspots(match: dict, towers: list[tuple[float, float]], facilities: list[dict],
                   cell_m: float = 150.0, bandwidth_m: float = KDE_BANDWIDTH_M) -> dict:
    import numpy as np
    common = match["common_candidates"]
    if not common:
        return {"type": "FeatureCollection", "features": [], "plan": []}
    # KDE point weight emphasises CASE CONVERGENCE over facility density: a source shared by
    # multiple cases must out-peak many single-case facilities clustered in a dense area.
    # weight = score(=case_count·PHWR·Σprox) × case_count → convergence enters cubically.
    pts = [(c["lat"], c["lng"], max(c["score"] * c["case_count"], 1e-3)) for c in common]
    lats = [p[0] for p in pts]; lngs = [p[1] for p in pts]
    pad = 0.012
    lat_min, lat_max = min(lats) - pad, max(lats) + pad
    lng_min, lng_max = min(lngs) - pad, max(lngs) + pad
    nlat = max(6, int(_dist_m((lat_min, lng_min), (lat_max, lng_min)) / cell_m))
    nlng = max(6, int(_dist_m((lat_min, lng_min), (lat_min, lng_max)) / cell_m))
    nlat, nlng = min(nlat, 120), min(nlng, 120)
    grid_lat = np.linspace(lat_min, lat_max, nlat)
    grid_lng = np.linspace(lng_min, lng_max, nlng)
    score = np.zeros((nlat, nlng))
    for i, gl in enumerate(grid_lat):
        for j, gn in enumerate(grid_lng):
            s = 0.0
            for (plat, plng, w) in pts:
                d = _dist_m((gl, gn), (plat, plng))
                s += w * math.exp(-(d * d) / (2 * bandwidth_m * bandwidth_m))
            score[i, j] = s
    mx = float(score.max()) or 1.0
    score /= mx
    # Greedy peak-picking → candidate hotspots, suppressing neighbours within ~2*bandwidth.
    # Pick up to 6 peaks; the final rank is decided by case convergence below, not KDE height.
    flat = sorted(((score[i, j], i, j) for i in range(nlat) for j in range(nlng)), reverse=True)
    chosen: list[tuple[float, float, float]] = []  # (score, lat, lng)
    for sc, i, j in flat:
        if sc < 0.12:  # surface secondary clusters too (weaker = lighter/broader)
            break
        lat, lng = float(grid_lat[i]), float(grid_lng[j])
        if all(_dist_m((lat, lng), (c[1], c[2])) > 2 * bandwidth_m for c in chosen):
            chosen.append((sc, lat, lng))
        if len(chosen) >= 6:
            break
    if not chosen:  # single diffuse case → one broad hotspot at the top cell
        sc, i, j = flat[0]
        chosen = [(float(sc), float(grid_lat[i]), float(grid_lng[j]))]

    # Coverage guarantee: when one cluster dominates the KDE, weaker single-case clusters fall
    # below threshold and would vanish. Add the strongest shared source per case so every case
    # gets an investigation lead; the case-set dedupe below folds redundant ones into the peaks.
    best_per_case: dict[int, dict] = {}
    for c in common:
        for cid in c["linked_cases"]:
            if cid not in best_per_case or c["score"] > best_per_case[cid]["score"]:
                best_per_case[cid] = c
    for c in best_per_case.values():
        lat, lng = c["lat"], c["lng"]
        if all(_dist_m((lat, lng), (x[1], x[2])) > bandwidth_m for x in chosen):
            ii = min(max(int(round((lat - lat_min) / (lat_max - lat_min) * (nlat - 1))), 0), nlat - 1)
            jj = min(max(int(round((lng - lng_min) / (lng_max - lng_min) * (nlng - 1))), 0), nlng - 1)
            chosen.append((float(score[ii, jj]), lat, lng))

    # Build candidate hotspots, keep only those tied to ≥1 case (drop KDE spillover), re-rank.
    kept = []
    for (sc, lat, lng) in chosen:
        radius = 300.0 + (1.0 - sc) * 200.0  # denser → tighter
        near_towers = [{"lat": t[0], "lng": t[1]} for t in towers if _dist_m((lat, lng), t) <= radius]
        near_fac = [{"name": f["name"], "sub": f.get("sub"), "kind": f["kind"], "lat": f["lat"], "lng": f["lng"]}
                    for f in facilities if _dist_m((lat, lng), (f["lat"], f["lng"])) <= radius]
        linked = sorted({cid for c in common
                         if _dist_m((lat, lng), (c["lat"], c["lng"])) <= radius for cid in c["linked_cases"]})
        if not linked:
            continue
        kept.append((sc, lat, lng, radius, near_towers, near_fac, linked))

    # Priority = case convergence first (more cases sharing a source = investigate first),
    # KDE density as tie-breaker. Then drop peaks that only re-surface a case set already
    # covered (multiple adjacent peaks from the same co-located cases) so each distinct
    # case cluster gets its own slot. Keep the top 3.
    kept.sort(key=lambda k: (len(k[6]), k[0]), reverse=True)
    deduped: list = []
    covered: list[set] = []
    for k in kept:
        s = set(k[6])
        if any(s <= c for c in covered):  # same/subset case-set already surfaced
            continue
        deduped.append(k); covered.append(s)
    kept = deduped[:3]

    feats, plan = [], []
    for rank, (sc, lat, lng, radius, near_towers, near_fac, linked) in enumerate(kept, 1):
        feats.append({"type": "Feature",
                      "properties": {"rank": rank, "score": round(sc, 3), "radius_m": round(radius),
                                     "cooling_towers": near_towers, "facilities": near_fac,
                                     "linked_case_count": len(linked)},
                      "geometry": {"type": "Point", "coordinates": [round(lng, 6), round(lat, 6)]}})
        plan.append({"rank": rank, "center": [round(lng, 6), round(lat, 6)], "radius_m": round(radius),
                     "cooling_tower_count": len(near_towers), "high_risk_facility_count": len(near_fac),
                     "linked_case_count": len(linked),
                     "facilities": [f["name"] for f in near_fac][:6]})
    return {"type": "FeatureCollection",
            "note": "환경검사 우선순위 제안이며 확정 감염원 아님. 채수·배양 병원체 일치로 확정, 최종 판단은 조사관.",
            "features": feats, "plan": plan}


# ── 역학조사서 초안 (report draft) ───────────────────────────────────────────
def _report_template(result: dict) -> str:
    """Deterministic 역학조사 결과 보고서 초안 assembled from the analysis (Gemini-free fallback)."""
    crs = result.get("case_results", [])
    cases = {c.get("id"): c for c in result.get("cases", [])}
    plan = (result.get("hotspots") or {}).get("plan", [])
    common = result.get("common_candidates", [])
    onsets = sorted([cr.get("onset_date") for cr in crs if cr.get("onset_date")])
    span = f"{onsets[0]} ~ {onsets[-1]}" if onsets else "미상"
    areas = sorted({(cases.get(cr.get("id"), {}).get("presumed_area") or "미상") for cr in crs})
    conv_ids = sorted({cid for c in common if c.get("case_count", 0) >= 2 for cid in c.get("linked_cases", [])})
    conv = next((p for p in plan if p.get("linked_case_count", 0) >= 2), None)
    L: list[str] = []
    L.append("레지오넬라증 역학조사 결과 보고서 (초안)")
    L.append("※ 자동 분석 요약 초안이며 확정 결론이 아님. 최종 판단은 역학조사관.")
    L.append("")
    L.append("1. 사건 개요")
    L.append(f" - 조사 대상: 레지오넬라증 {len(crs)}건 (비식별 조사서)")
    L.append(f" - 발병 시기: {span}")
    L.append(f" - 발생 지역: {', '.join(areas)}")
    L.append("")
    L.append("2. 사례 요약")
    for cr in crs:
        c = cases.get(cr.get("id"), {})
        hosp = (f"입원 {c.get('hospital_days')}일" if c.get("hospital_days")
                else ("입원" if c.get("hospitalized") else "미입원"))
        L.append(f" - 케이스 {cr.get('id')}: 발병 {cr.get('onset_date', '?')}, "
                 f"{(cr.get('route') or {}).get('label', '-')} · {c.get('presumed_area', '미상')} · {hosp}")
    L.append("")
    L.append("3. 역학적 연관성")
    if conv and conv_ids:
        L.append(f" - 케이스 {'·'.join(map(str, conv_ids))}가 공통 노출후보로 수렴: "
                 f"{', '.join(conv.get('facilities', [])[:3])} 등 (반경 {conv.get('radius_m')}m, "
                 f"고위험시설 {conv.get('high_risk_facility_count')}곳) — 동일 목욕장 밀집지.")
    else:
        L.append(" - 다수 사례 간 공통 노출원 수렴은 확인되지 않음(개별 노출 가능성).")
    L.append("")
    L.append("4. 환경조사 우선순위 (제안)")
    for p in plan:
        L.append(f" - {p.get('rank')}순위: 반경 {p.get('radius_m')}m · 고위험시설 "
                 f"{p.get('high_risk_facility_count')}곳 · 연관 케이스 {p.get('linked_case_count')}건 — "
                 f"{', '.join(p.get('facilities', [])[:2])}")
    L.append("")
    L.append("5. 권고 사항")
    L.append(" - 우선순위 지점의 냉각탑·목욕장·급수설비 채수 및 배양 검사 실시.")
    L.append(" - 환자 임상검체와 환경검체의 레지오넬라 혈청형·유전형 일치 여부 확인.")
    if any("의료기관" in (cr.get("route") or {}).get("label", "") for cr in crs):
        L.append(" - 의료기관내감염(확정) 사례 관련 기관의 급수·냉각·가습설비 즉시 점검.")
    if any("여행" in (cr.get("route") or {}).get("label", "") for cr in crs):
        L.append(" - 여행관련 사례 숙박시설 급수·냉방설비 조사 및 관할 보건소 통보.")
    L.append("")
    L.append("6. 한계 및 유의")
    L.append(" - Hotspot은 노출후보의 시공간 밀집이며 확정 감염원이 아님(채수·배양 일치로 확정).")
    L.append(" - 위험 히트맵은 PHWR 가중 환경 오염 경향이며 환자 발생 예측이 아님.")
    L.append(" - 본 자료는 합성·비식별 데모이며 실제 환자정보를 포함하지 않음.")
    return "\n".join(L)


def build_report_draft(result: dict, use_llm: bool = True) -> str:
    """역학조사서 초안: Gemini writes a polished draft grounded in the analysis facts, with the
    deterministic template as fallback (LLM off, no key, or on any error)."""
    template = _report_template(result)
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not (use_llm and key):
        return template
    try:
        from google import genai
        client = genai.Client(api_key=key)
        model = os.getenv("RISK_ANALYSIS_MODEL") or os.getenv("GEMINI_MODEL") or "gemini-3.5-flash"
        prompt = (
            "당신은 감염병 역학조사관을 보조하는 도구다. 아래 '분석 사실'만 근거로 레지오넬라증 역학조사 "
            "결과 보고서 초안을 한국어로 작성하라. 사실을 새로 지어내지 말고, 추정·초안임을 명시하며, "
            "'확정 감염원이 아니고 채수·배양 병원체 일치로 확정하며 최종 판단은 역학조사관'이라는 점과 "
            "'합성·비식별 데모'라는 점을 반드시 포함하라. 6개 절 구성(1 사건 개요, 2 사례 요약, "
            "3 역학적 연관성, 4 환경조사 우선순위, 5 권고 사항, 6 한계 및 유의)으로 간결한 개조식.\n\n"
            f"[분석 사실]\n{template}\n\n[보고서 초안]:"
        )
        txt = (client.models.generate_content(model=model, contents=prompt).text or "").strip()
        if txt.startswith("```"):
            txt = txt.strip("`")
        return txt if len(txt) > 120 else template
    except Exception:
        return template
