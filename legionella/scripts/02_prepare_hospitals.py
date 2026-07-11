"""02_prepare_hospitals.py — 심평원 병원정보서비스 API → 부산 고위험 병원 → facilities_hospital.geojson

건강보험심사평가원 병원정보서비스 v2 (data.go.kr B551182):
  GET https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList  (XML)
  종별코드 clCd: 01 상급종합병원 · 11 종합병원 · 28 요양병원 (부산 좌표+반경으로 조회 후
  sidoCdNm='부산' 및 clCdNm(상급종합/종합병원/요양병원)만 남김).
  XPos(경도)/YPos(위도)는 이미 WGS84 → 지오코딩 불필요.

키: 환경변수 HIRA_SERVICE_KEY (data.go.kr serviceKey). MOBILITY_API_KEY/DATA_GO_KR_API_KEY도 허용.
출력: frontend/public/data/facilities_hospital.geojson (WGS84 [lng,lat]).
"""
from __future__ import annotations

import json
import os
import xml.etree.ElementTree as ET
from pathlib import Path

import requests

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
except Exception:
    pass

OUT = Path(__file__).resolve().parents[1].parents[0] / "frontend" / "public" / "data" / "facilities_hospital.geojson"
URL = "https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList"
CL_CODES = {"01": "상급종합", "11": "종합병원", "28": "요양병원"}
HIGH_RISK = ("상급종합", "종합병원", "요양병원")
TARGET_SIDO = os.getenv("TARGET_SIDO", "").strip()  # 빈 값 = 전국


def _key() -> str:
    for name in ("HIRA_SERVICE_KEY", "MOBILITY_API_KEY", "DATA_GO_KR_API_KEY"):
        v = os.getenv(name, "").strip()
        if v:
            return v
    return ""


def _fetch(key: str, cl: str) -> list[dict]:
    rows: list[dict] = []
    for page in range(1, 30):  # nationwide: paginate all (요양병원 ~1,400 → ~14 pages)
        try:
            r = requests.get(URL, params={"ServiceKey": key, "pageNo": page, "numOfRows": 100,
                                          "clCd": cl}, timeout=30)
            root = ET.fromstring(r.text)
            items = root.findall(".//item")
            if not items:
                break
            for it in items:
                rows.append({t.tag: (t.text or "").strip() for t in it})
            total = int(root.findtext(".//body/totalCount") or 0)
            if page * 100 >= total:
                break
        except Exception as exc:
            print(f"  clCd={cl} page{page} failed: {exc}")
            break
    return rows


def main() -> None:
    key = _key()
    if not key:
        print("HIRA_SERVICE_KEY(또는 data.go.kr 키)가 환경변수에 없습니다.")
        return
    feats, seen = [], set()
    for cl, name in CL_CODES.items():
        rows = _fetch(key, cl)
        kept = 0
        for row in rows:
            sido = row.get("sidoCdNm", "")
            clnm = row.get("clCdNm", "")
            if (TARGET_SIDO and TARGET_SIDO not in sido) or not any(h in clnm for h in HIGH_RISK):
                continue
            try:
                lng, lat = float(row.get("XPos") or 0), float(row.get("YPos") or 0)
            except Exception:
                continue
            if not (124 < lng < 132 and 33 < lat < 39):
                continue
            k = (row.get("yadmNm", ""), round(lng, 5), round(lat, 5))
            if k in seen:
                continue
            seen.add(k)
            feats.append({"type": "Feature",
                          "properties": {"name": row.get("yadmNm", "병원"), "clCdNm": clnm, "sido": sido},
                          "geometry": {"type": "Point", "coordinates": [round(lng, 6), round(lat, 6)]}})
            kept += 1
        print(f"{name}(clCd={cl}): {len(rows)}건 조회 → {TARGET_SIDO or '전국'} {kept}건")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"type": "FeatureCollection",
                               "note": f"{TARGET_SIDO or '전국'} 고위험 병원(상급종합/종합/요양) · 심평원 병원정보서비스 · WGS84",
                               "features": feats}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"고위험 병원 {len(feats)}건 저장 → {OUT}")


if __name__ == "__main__":
    main()
