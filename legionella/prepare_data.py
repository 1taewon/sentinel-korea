"""prepare_data.py — build data/facilities.geojson for the Legionella surveillance demo.

Pipeline: LocalData(localdata.go.kr) 인허가 목록 → 주소 → V-World 지오코더 → WGS84 point
→ frontend/public/data/facilities.geojson (the SURVEILLANCE INTELLIGENCE tab reads this).

No ML / GPU. Environment/facility open data only — NO patient or personal data.

Required env (project-root .env):
  VWORLD_KEY     V-World key (geocoder + tiles enabled, localhost domain registered)
  LOCALDATA_KEY  LocalData Open API authKey  (apply at www.localdata.go.kr → 오픈API)

⚠ VERIFY BEFORE RUNNING (do not guess — the spec requires official-doc confirmation):
  - LocalData endpoint / params / opnSvcId(업종 서비스 ID) / localCode(지역코드):
    https://www.localdata.go.kr/  (오픈API 가이드).  The OPN_SVC and LOCAL_CODE below are
    placeholders you MUST confirm against the guide for your target 업종/구.
  - V-World geocoder params: https://dev.vworld.kr/  (address getcoord reference).
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import requests

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except Exception:
    pass

OUT = Path(__file__).resolve().parent.parent / "frontend" / "public" / "data" / "facilities.geojson"

# 서울 중구. Confirm LOCAL_CODE at localdata.go.kr (지역코드 목록).
TARGET_LOCAL_CODE = os.getenv("LOCALDATA_LOCAL_CODE", "3000000")  # ⚠ verify (서울 중구)
# 업종명 → opnSvcId. ⚠ VERIFY every code at localdata.go.kr before trusting output.
OPN_SVC = {
    "목욕장업": os.getenv("OPNSVC_BATH", "07_24_04_P"),
    "숙박업": os.getenv("OPNSVC_LODGING", "07_24_02_P"),
    "병원": os.getenv("OPNSVC_HOSPITAL", "01_01_01_P"),
    "의원": os.getenv("OPNSVC_CLINIC", "01_01_02_P"),
}

LOCALDATA_URL = "http://www.localdata.go.kr/platform/rest/GR0/openDataApi"
VWORLD_GEOCODE = "https://api.vworld.kr/req/address"


def fetch_localdata(auth_key: str, opn_svc_id: str) -> list[dict]:
    """Fetch 영업중 licences for one 업종 in the target 구. Confirm param names in the guide."""
    rows: list[dict] = []
    for page in range(1, 6):  # bounded
        try:
            r = requests.get(LOCALDATA_URL, params={
                "authKey": auth_key, "opnSvcId": opn_svc_id, "localCode": TARGET_LOCAL_CODE,
                "pageIndex": page, "pageSize": 100, "resultType": "json", "state": "01",
            }, timeout=25)
            if r.status_code != 200:
                break
            data = r.json()
            body = (data.get("result") or {}).get("body") or data.get("body") or {}
            items = body.get("rows") or body.get("items") or []
            if isinstance(items, dict):
                items = items.get("row") or items.get("item") or []
            if not items:
                break
            rows.extend(items)
        except Exception as exc:
            print(f"  LocalData page {page} failed: {exc}")
            break
    return rows


def geocode(address: str, vworld_key: str) -> tuple[float, float] | None:
    """Address → (lng, lat) via V-World. Tries road then parcel addressing."""
    if not address:
        return None
    for atype in ("ROAD", "PARCEL"):
        try:
            r = requests.get(VWORLD_GEOCODE, params={
                "service": "address", "request": "getcoord", "version": "2.0",
                "crs": "EPSG:4326", "type": atype, "address": address,
                "format": "json", "key": vworld_key,
            }, timeout=20)
            j = r.json()
            if (j.get("response") or {}).get("status") == "OK":
                pt = j["response"]["result"]["point"]
                return float(pt["x"]), float(pt["y"])  # x=lng, y=lat
        except Exception:
            continue
    return None


def _addr(row: dict) -> str:
    for k in ("rdnWhlAddr", "rdnwhladdr", "SITEWHLADDR", "sitewhladdr", "도로명전체주소", "소재지전체주소"):
        v = row.get(k)
        if v:
            return str(v).strip()
    return ""


def _name(row: dict) -> str:
    for k in ("bplcNm", "bplcnm", "BPLCNM", "사업장명"):
        v = row.get(k)
        if v:
            return str(v).strip()
    return "시설"


def main() -> None:
    vworld_key = os.getenv("VWORLD_KEY", "").strip()
    local_key = os.getenv("LOCALDATA_KEY", "").strip()
    if not vworld_key:
        sys.exit("VWORLD_KEY missing in .env")
    if not local_key:
        sys.exit("LOCALDATA_KEY missing in .env (apply at www.localdata.go.kr).")

    features = []
    for label, svc_id in OPN_SVC.items():
        rows = fetch_localdata(local_key, svc_id)
        print(f"{label} ({svc_id}): {len(rows)} licences")
        for row in rows:
            coord = geocode(_addr(row), vworld_key)
            time.sleep(0.15)  # be gentle with the geocoder
            if not coord:
                continue
            features.append({
                "type": "Feature",
                "properties": {"name": _name(row), "category": label},
                "geometry": {"type": "Point", "coordinates": [coord[0], coord[1]]},  # [lng,lat]
            })

    if not features:
        print("No features geocoded. Confirm LOCAL_CODE / opnSvcId / param names against the LocalData guide.")
        return
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": features},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {len(features)} facilities -> {OUT}")


if __name__ == "__main__":
    main()
