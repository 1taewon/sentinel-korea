"""02_prepare_hospitals.py — 심평원 전국 병의원 현황 CSV → 부산 고위험 병원 → facilities_hospital.geojson

- data/raw/ 안의 CSV들을 컬럼으로 판별.
- 시도가 TARGET_SIDO(기본 부산), 종별(clCdNm)이 상급종합/종합병원/요양병원인 행만.
- 좌표: XPos(경도)/YPos(위도)가 이미 WGS84 → 그대로 사용(지오코딩 불필요).
출력: frontend/public/data/facilities_hospital.geojson (WGS84 [lng,lat]).
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pandas as pd

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
except Exception:
    pass

BASE = Path(__file__).resolve().parents[1]
RAW = BASE / "data" / "raw"
OUT = BASE.parents[0] / "frontend" / "public" / "data" / "facilities_hospital.geojson"
TARGET_SIDO = os.getenv("TARGET_SIDO", "부산")
HIGH_RISK = ("상급종합", "종합병원", "요양병원")


def _read_csv(path: Path) -> pd.DataFrame | None:
    for enc in ("utf-8-sig", "cp949", "euc-kr", "utf-8"):
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


def _find_hospital_csv() -> tuple[pd.DataFrame, dict] | None:
    for path in sorted(RAW.glob("*.csv")):
        df = _read_csv(path)
        if df is None or df.empty:
            continue
        name = _col(df, "요양기관명", "기관명", "병원명")
        cl = _col(df, "종별코드명", "clcdnm", "종별")
        x = _col(df, "xpos", "x좌표", "경도")
        y = _col(df, "ypos", "y좌표", "위도")
        sido = _col(df, "시도코드명", "시도명", "시도")
        if name and cl and x and y:
            return df, {"name": name, "cl": cl, "x": x, "y": y, "sido": sido,
                        "addr": _col(df, "주소", "소재지")}
    return None


def main() -> None:
    found = _find_hospital_csv()
    if not found:
        print(f"병의원 현황 CSV를 {RAW} 에서 찾지 못했습니다. (요양기관명·종별코드명·XPos/YPos 확인)")
        return
    df, c = found
    feats = []
    for _, row in df.iterrows():
        cl = str(row[c["cl"]])
        if not any(h in cl for h in HIGH_RISK):
            continue
        region = str(row[c["sido"]]) if c["sido"] else (str(row[c["addr"]]) if c["addr"] else "")
        if TARGET_SIDO not in region:
            continue
        try:
            lng, lat = float(row[c["x"]] or 0), float(row[c["y"]] or 0)
        except Exception:
            continue
        if not (124 < lng < 132 and 33 < lat < 39):
            continue
        feats.append({"type": "Feature",
                      "properties": {"name": str(row[c["name"]]).strip(), "clCdNm": cl.strip()},
                      "geometry": {"type": "Point", "coordinates": [round(lng, 6), round(lat, 6)]}})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"고위험 병원 {len(feats)}건 → {OUT}")


if __name__ == "__main__":
    main()
