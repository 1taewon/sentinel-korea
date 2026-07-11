"""01_prepare_baths.py — 행안부 목욕장업 CSV → 부산 영업중 → EPSG:5174→4326 → facilities_bath.geojson

- data/raw/ 안의 CSV들을 컬럼으로 판별(파일명 의존 X).
- 소재지주소가 TARGET_SIDO(기본 부산), 영업상태 영업중/정상만.
- 좌표: 목욕장업 좌표는 Bessel 중부원점TM(EPSG:5174) → pyproj로 EPSG:4326. 결측/이상치는
  소재지주소를 V-World 지오코더로 보완.
- 세부유형(대중목욕탕/찜질방/사우나/온천)은 위생업태명 등에서 판별(가능 시).
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

BASE = Path(__file__).resolve().parents[1]          # legionella/
RAW = BASE / "data" / "raw"
OUT = BASE.parents[0] / "frontend" / "public" / "data" / "facilities_bath.geojson"
TARGET_SIDO = os.getenv("TARGET_SIDO", "부산")
TARGET_SGGU = os.getenv("TARGET_SGGU", "").strip()

TF_5174_4326 = Transformer.from_crs("EPSG:5174", "EPSG:4326", always_xy=True)
VWORLD_GEOCODE = "https://api.vworld.kr/req/address"


def _read_csv(path: Path) -> pd.DataFrame | None:
    for enc in ("utf-8-sig", "cp949", "euc-kr", "utf-8"):
        try:
            return pd.read_csv(path, dtype=str, encoding=enc, low_memory=False).fillna("")
        except Exception:
            continue
    return None


def _col(df: pd.DataFrame, *keys: str) -> str | None:
    for c in df.columns:
        cl = str(c).replace(" ", "")
        if any(k in cl for k in keys):
            return c
    return None


def _find_bath_csv() -> tuple[pd.DataFrame, dict] | None:
    """A bath CSV has a business name + address + a 5174 coord pair (or looks like 목욕장업)."""
    for path in sorted(RAW.glob("*.csv")):
        df = _read_csv(path)
        if df is None or df.empty:
            continue
        name = _col(df, "사업장명", "업소명")
        addr = _col(df, "도로명전체주소", "소재지전체주소", "지번주소", "주소")
        x = _col(df, "좌표정보x", "좌표정보(x)", "좌표x", "x좌표")
        y = _col(df, "좌표정보y", "좌표정보(y)", "좌표y", "y좌표")
        hint = _col(df, "위생업태명", "업태구분명", "업종")
        looks_bath = ("목욕" in path.name) or (hint and df[hint].astype(str).str.contains("목욕|찜질|온천|사우나").any())
        if name and addr and (x and y) and looks_bath:
            return df, {"name": name, "addr": addr, "x": x, "y": y,
                        "state": _col(df, "영업상태명", "상세영업상태명", "영업상태"),
                        "subtype": hint}
    return None


def _subtype(text: str) -> str:
    t = text or ""
    if "온천" in t: return "온천"
    if "찜질" in t: return "찜질방"
    if "사우나" in t: return "사우나"
    if "대중" in t: return "대중목욕탕"
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
        print(f"목욕장업 CSV를 {RAW} 에서 찾지 못했습니다. (사업장명·주소·5174좌표 컬럼 확인)")
        return
    df, c = found
    feats = []
    for _, row in df.iterrows():
        addr = str(row[c["addr"]])
        if TARGET_SIDO not in addr or (TARGET_SGGU and TARGET_SGGU not in addr):
            continue
        if c["state"] and not any(s in str(row[c["state"]]) for s in ("영업", "정상")):
            continue
        lng = lat = None
        try:
            xv, yv = float(row[c["x"]] or 0), float(row[c["y"]] or 0)
            if xv > 0 and yv > 0:
                lng, lat = TF_5174_4326.transform(xv, yv)
                if not (124 < lng < 132 and 33 < lat < 39):  # sanity for Korea
                    lng = lat = None
        except Exception:
            pass
        if lng is None:
            g = _geocode(addr); time.sleep(0.12)
            if g:
                lng, lat = g
        if lng is None:
            continue
        sub = _subtype(str(row[c["subtype"]]) if c["subtype"] else "")
        feats.append({"type": "Feature",
                      "properties": {"name": str(row[c["name"]]).strip(), "category": "목욕장업", "subtype": sub},
                      "geometry": {"type": "Point", "coordinates": [round(lng, 6), round(lat, 6)]}})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"목욕장업 {len(feats)}건 → {OUT}")


if __name__ == "__main__":
    main()
