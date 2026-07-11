"""01_prepare_baths.py — 행안부 목욕장업 CSV → 부산 영업중 → EPSG:5174→4326 → facilities_bath.geojson

- data/raw/ 안의 CSV를 컬럼으로 판별(파일명 의존 X). 실제 컬럼명을 먼저 출력.
- 소재지주소가 TARGET_SIDO(기본 부산), 영업상태 영업중/정상만.
- 좌표: 목욕장업 좌표 = EPSG:5174(Bessel 중부원점TM) → pyproj로 EPSG:4326.
  결측/이상치는 소재지주소를 V-World 지오코더로 보완.
출력: frontend/public/data/facilities_bath.geojson (WGS84 [lng,lat]).
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pandas as pd
import requests
from pyproj import Transformer

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
except Exception:
    pass

BASE = Path(__file__).resolve().parents[1]
RAW = BASE / "data" / "raw"
OUT = BASE.parents[0] / "frontend" / "public" / "data" / "facilities_bath.geojson"
TARGET_SIDO = os.getenv("TARGET_SIDO", "").strip()  # 빈 값 = 전국
TARGET_SGGU = os.getenv("TARGET_SGGU", "").strip()

TF = Transformer.from_crs("EPSG:5174", "EPSG:4326", always_xy=True)
VWORLD_GEOCODE = "https://api.vworld.kr/req/address"


def _read_csv(path: Path) -> pd.DataFrame | None:
    for enc in ("cp949", "euc-kr", "utf-8-sig", "utf-8"):
        try:
            return pd.read_csv(path, dtype=str, encoding=enc, low_memory=False).fillna("")
        except Exception:
            continue
    return None


def _col(df: pd.DataFrame, *keys: str) -> str | None:
    for c in df.columns:
        cl = str(c).replace(" ", "").lower()
        if any(k.lower() in cl for k in keys):
            return c
    return None


def _find_bath_csv() -> tuple[pd.DataFrame, dict, Path] | None:
    for path in sorted(RAW.glob("*.csv")):
        df = _read_csv(path)
        if df is None or df.empty:
            continue
        cols = {
            "name": _col(df, "사업장명", "업소명"),
            "road": _col(df, "도로명주소", "도로명전체주소"),
            "jibun": _col(df, "지번주소", "소재지전체주소", "소재지지번"),
            "x": _col(df, "좌표정보(x", "좌표x", "x좌표"),
            "y": _col(df, "좌표정보(y", "좌표y", "y좌표"),
            "state": _col(df, "영업상태명", "상세영업상태명"),
            "subtype": _col(df, "위생업태명", "업태구분명"),
        }
        looks_bath = ("목욕" in path.name) or (cols["subtype"] and df[cols["subtype"]].astype(str).str.contains("목욕|찜질|온천|탕|사우나").any())
        if cols["name"] and (cols["road"] or cols["jibun"]) and cols["x"] and cols["y"] and looks_bath:
            return df, cols, path
    return None


def _subtype(text: str) -> str:
    t = text or ""
    if "온천" in t: return "온천"
    if "찜질" in t: return "찜질방"
    if "사우나" in t: return "사우나"
    if "공동" in t or "일반" in t or "탕" in t: return "대중목욕탕"
    return "목욕장업"


def _geocode(address: str) -> tuple[float, float] | None:
    key = os.getenv("VWORLD_KEY", "").strip()
    if not key or not address:
        return None
    for atype in ("ROAD", "PARCEL"):
        try:
            j = requests.get(VWORLD_GEOCODE, params={
                "service": "address", "request": "getcoord", "version": "2.0", "crs": "EPSG:4326",
                "type": atype, "address": address, "format": "json", "key": key}, timeout=15).json()
            if (j.get("response") or {}).get("status") == "OK":
                p = j["response"]["result"]["point"]
                return float(p["x"]), float(p["y"])
        except Exception:
            continue
    return None


def main() -> None:
    found = _find_bath_csv()
    if not found:
        print(f"목욕장업 CSV를 {RAW} 에서 찾지 못했습니다.")
        return
    df, c, path = found
    print(f"CSV: {path.name} · rows={len(df)}")
    print(f"컬럼 매핑 → 사업장명={c['name']!r}, 주소(도로명={c['road']!r}/지번={c['jibun']!r}), "
          f"영업상태={c['state']!r}, 좌표=({c['x']!r},{c['y']!r}), 세부유형={c['subtype']!r}")
    feats, geocoded, skipped = [], 0, 0
    for _, row in df.iterrows():
        addr = (str(row[c["road"]]).strip() if c["road"] else "") or (str(row[c["jibun"]]).strip() if c["jibun"] else "")
        if TARGET_SIDO and (TARGET_SIDO not in addr or (TARGET_SGGU and TARGET_SGGU not in addr)):
            continue
        if c["state"] and not any(s in str(row[c["state"]]) for s in ("영업", "정상")):
            continue
        lng = lat = None
        try:
            xv, yv = float(str(row[c["x"]]).strip() or 0), float(str(row[c["y"]]).strip() or 0)
            if xv > 0 and yv > 0:
                lng, lat = TF.transform(xv, yv)
                if not (124 < lng < 132 and 33 < lat < 39):
                    lng = lat = None
        except Exception:
            pass
        if lng is None:
            g = _geocode(addr); time.sleep(0.1)
            if g:
                lng, lat = g; geocoded += 1
        if lng is None:
            skipped += 1
            continue
        feats.append({"type": "Feature",
                      "properties": {"name": str(row[c["name"]]).strip(), "category": "목욕장업",
                                     "subtype": _subtype(str(row[c["subtype"]]) if c["subtype"] else "")},
                      "geometry": {"type": "Point", "coordinates": [round(lng, 6), round(lat, 6)]}})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"type": "FeatureCollection",
                               "note": f"{TARGET_SIDO or '전국'} 목욕장업(영업중) · 행안부 공개데이터 · EPSG:5174→4326",
                               "features": feats}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"목욕장업 {len(feats)}건 저장 (지오코딩 보완 {geocoded}, 좌표없음 스킵 {skipped}) → {OUT}")


if __name__ == "__main__":
    main()
