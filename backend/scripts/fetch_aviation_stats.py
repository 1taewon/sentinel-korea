"""fetch_aviation_stats.py — Incheon Airport arriving-passenger volume by country.

Turns the outbreak layer's hardcoded "한국 이동량 proxy" into OBJECTIVE data:
real monthly arriving-passenger counts from data.go.kr
(인천국제공항공사_운항 실적 국가별 통계 / getTotalNumberOfPassenger).

Rationale (BlueDot / GLEAM standard): an outbreak in a country with high
passenger volume into Korea carries higher import risk than one in a
low-connectivity country. We fetch arriving-passenger counts per country and
log-normalize them to a 0..1 "traffic" score keyed by an English country name
that substring-matches the outbreak `country` field.

Requires env var AVIATION_API_KEY (data.go.kr service key). If unset, the
fetcher is a no-op (the outbreak layer keeps using its proxy).
"""
from __future__ import annotations

import json
import math
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
OUTPUT_FILE = PROCESSED_DIR / "aviation_passenger_by_country.json"

BASE = "https://apis.data.go.kr/B551177/AviationStatsByCountry/getTotalNumberOfPassenger"
KST = timezone(timedelta(hours=9))

# Korean country name (as returned by the API) -> canonical English key.
# The key must substring-match the outbreak item's `country` field (English).
KR_TO_EN: dict[str, str] = {
    "일본": "japan", "중국": "china", "베트남": "vietnam", "미국": "united states",
    "대만": "taiwan", "홍콩": "hong kong", "필리핀": "philippines", "싱가포르": "singapore",
    "태국": "thailand", "인도네시아": "indonesia", "캐나다": "canada", "몽골": "mongolia",
    "호주": "australia", "말레이시아": "malaysia", "독일": "germany", "프랑스": "france",
    "이탈리아": "italy", "튀르키예": "turkey", "아랍에미리트": "united arab emirates",
    "영국": "united kingdom", "마카오": "macau", "스페인": "spain", "네덜란드": "netherlands",
    "우즈베키스탄": "uzbekistan", "카자흐스탄": "kazakhstan", "괌": "guam", "하와이": "hawaii",
    "카타르": "qatar", "핀란드": "finland", "인도": "india", "체코": "czech",
    "헝가리": "hungary", "폴란드": "poland", "덴마크": "denmark", "스위스": "switzerland",
    "캄보디아": "cambodia", "멕시코": "mexico", "오스트리아": "austria", "뉴질랜드": "new zealand",
    "포르투갈": "portugal", "에티오피아": "ethiopia", "라오스": "laos", "미얀마": "myanmar",
    "키르기즈스탄": "kyrgyzstan", "브루나이": "brunei", "네팔": "nepal", "스리랑카": "sri lanka",
    "사이판": "saipan", "투르크메니스탄": "turkmenistan", "아르메니아": "armenia",
    "조지아": "georgia", "크로아티아": "croatia", "브라질": "brazil", "칠레": "chile",
    "페루": "peru", "노르웨이": "norway", "룩셈부르크": "luxembourg", "벨기에": "belgium",
    "아제르바이잔": "azerbaijan",
}
# Extra English aliases so common outbreak-country spellings also match. Only
# aliases long enough to avoid false substring hits (no "us"/"uk").
EN_ALIASES: dict[str, list[str]] = {
    "united states": ["usa", "america"],
    "united kingdom": ["britain", "england"],
    "czech": ["czechia"],
    "turkey": ["turkiye"],
    "united arab emirates": ["uae"],
}


def _to_int(s: Any) -> int:
    try:
        return int(str(s).replace(",", "").strip() or 0)
    except Exception:
        return 0


def _request(month: str, key: str) -> list[dict] | None:
    params = {
        "serviceKey": key,
        "from_month": month,
        "to_month": month,
        "passenger_type": "1",  # 유임(paid) — bulk of entering travelers, excludes transfers
        "type": "json",
    }
    try:
        resp = httpx.get(BASE, params=params, timeout=30)
        if resp.status_code != 200:
            print(f"[Aviation] {month} HTTP {resp.status_code}: {resp.text[:120]}", file=sys.stderr)
            return None
        data = resp.json()
    except Exception as exc:
        print(f"[Aviation] {month} request/parse failed: {exc}", file=sys.stderr)
        return None
    header = (data.get("response") or {}).get("header") or {}
    if header.get("resultCode") not in ("00", 0):
        print(f"[Aviation] {month} API error: {header.get('resultMsg')}", file=sys.stderr)
        return None
    items = (((data.get("response") or {}).get("body") or {}).get("items")) or []
    if isinstance(items, dict):  # single-item responses can be an object
        items = [items]
    return items


def fetch_aviation_stats() -> dict[str, Any]:
    key = os.getenv("AVIATION_API_KEY", "").strip()
    if not key:
        print("[Aviation] AVIATION_API_KEY not set — skipping (outbreak layer keeps proxy)", file=sys.stderr)
        return {"status": "skipped", "reason": "AVIATION_API_KEY not set", "countries": {}}

    # Walk back from the current KST month to find the latest month with data
    # (aviation stats typically lag ~1 month).
    now = datetime.now(KST)
    items: list[dict] = []
    used_month = ""
    for back in range(0, 6):
        y = now.year
        m = now.month - back
        while m <= 0:
            m += 12
            y -= 1
        month = f"{y}{m:02d}"
        got = _request(month, key)
        if got:
            items, used_month = got, month
            break

    if not items:
        return {"status": "error", "reason": "no data in last 6 months", "countries": {}}

    max_arr = max((_to_int(i.get("arrPassenger")) for i in items), default=0)
    log_max = math.log10(max_arr + 1) or 1.0

    countries: dict[str, dict[str, Any]] = {}
    unmapped: list[str] = []
    for it in items:
        kr = (it.get("country") or "").strip()
        arr = _to_int(it.get("arrPassenger"))
        en = KR_TO_EN.get(kr)
        if not en:
            unmapped.append(kr)
            continue
        score = round(math.log10(arr + 1) / log_max, 4) if arr > 0 else 0.0
        entry = {"score": score, "arr_passengers": arr, "country_kr": kr, "region": it.get("region", "")}
        countries[en] = entry
        for alias in EN_ALIASES.get(en, []):
            countries[alias] = entry

    if unmapped:
        print(f"[Aviation] {len(unmapped)} unmapped countries: {unmapped}", file=sys.stderr)

    return {
        "status": "ok",
        "month": used_month,
        "source": "인천국제공항공사 국가별 여객통계 (data.go.kr B551177)",
        "passenger_type": "유임(arriving)",
        "max_arr": max_arr,
        "country_count": len(items),
        "generated_at": datetime.now(KST).isoformat(),
        "countries": countries,
    }


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_aviation_stats()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    n = len(data.get("countries", {}))
    print(f"[Aviation] saved {n} country keys (month={data.get('month')}, status={data.get('status')}) -> {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
