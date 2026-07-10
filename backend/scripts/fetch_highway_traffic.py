"""fetch_highway_traffic.py — Highway arrival-traffic connectivity index by region.

Grounds the Outbreak Scenario's domestic spread in real inter-regional mobility
(연결성), per the spatiotemporal COVID-19 spread-network research (KCI): COVID-19
spread from the 수도권 hub along proximity AND connectivity, and high-connectivity
regions act as spread hubs ("웜홀" = far-but-connected hubs spread despite distance).

We fetch highway ARRIVING traffic per tollgate (한국도로공사 odtraffic API,
startEndStdTypeCode=2=도착), aggregate to 17 시도, and log-normalize to a 0..1
connectivity score. The scenario combines this with its existing distance/proximity
multiplier → spread = proximity × connectivity, which corrects the wormhole effect.

Data note: the API caps ~100 rows/page and the full hourly set is huge, so we take
a bounded sample of a peak hour. Regional connectivity ratios are stable, so a
sample is sufficient for a relative index.

Requires env var HIGHWAY_API_KEY (data.ex.co.kr service key). Sends browser headers
(data.ex.co.kr WAF blocks header-less requests).
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
OUTPUT_FILE = PROCESSED_DIR / "highway_connectivity_by_region.json"

BASE = "https://data.ex.co.kr/openapi/odtraffic/trafficAmountByLane"
KST = timezone(timedelta(hours=9))
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    "Referer": "https://data.ex.co.kr/",
    "Accept": "application/json,*/*",
}
PEAK_HOUR = "08"   # a representative commute hour
MAX_PAGES = 25     # bounded sample (API caps ~100 rows/page)

# 도착영업소(톨게이트) 이름 → 시도 코드. Covers the tollgates that appear in the
# arrival feed; unmapped tollgates are skipped. (제주=고속도로 없음)
_TOLLGATE_REGION: dict[str, str] = {
    "서울": "11",
    # 경기 41
    "기흥": "41", "동수원": "41", "수원신갈": "41", "오산": "41", "안성": "41",
    "용인": "41", "양지": "41", "여주": "41", "이천": "41", "덕평": "41", "마성": "41",
    "판교": "41", "군포": "41", "신갈": "41", "김량장": "41", "송탄": "41", "평택": "41",
    # 인천 28
    "인천": "28", "서인천": "28", "남인천": "28",
    # 강원 42
    "대관령": "42", "둔내": "42", "문막": "42", "새말": "42", "원주": "42",
    "진부": "42", "춘천": "42", "평창": "42", "홍천": "42", "강릉": "42", "동해": "42",
    # 충북 43
    "남청주": "43", "서충주": "43", "충주": "43", "영동": "43", "옥천": "43",
    "음성": "43", "청주": "43", "황간": "43", "금왕꽃동네": "43", "괴산": "43", "증평": "43",
    # 충남 44
    "계룡": "44", "논산": "44", "독립기념관": "44", "천안": "44", "지곡": "44",
    "천안삼거리": "44", "정안": "44", "공주": "44", "당진": "44", "서산": "44", "홍성": "44",
    # 대전 30
    "남대전": "30", "대전": "30", "북대전": "30", "서대전": "30", "신탄진": "30",
    "안영": "30", "유성": "30", "판암": "30",
    # 세종 36
    "남세종": "36", "북세종": "36", "세종": "36",
    # 전북 45
    "김제": "45", "덕유산": "45", "무주": "45", "삼례": "45", "서전주": "45",
    "익산": "45", "장수": "45", "전주": "45", "정읍": "45", "군산": "45",
    # 광주 29
    "광주": "29", "동광주": "29",
    # 전남 46
    "백양사": "46", "장성": "46", "순천": "46", "목포": "46", "광양": "46", "나주": "46",
    # 경북 47
    "경산": "47", "경주": "47", "구미": "47", "김천": "47", "남구미": "47",
    "동김천": "47", "서경주": "47", "영천": "47", "왜관": "47", "포항": "47", "안동": "47", "칠곡": "47",
    # 대구 27
    "북대구": "27", "서대구": "27", "동대구": "27", "남대구": "27",
    # 경남 48
    "군북": "48", "동김해": "48", "동창원": "48", "산인": "48", "서김해": "48",
    "양산": "48", "진례": "48", "통도사": "48", "함안": "48", "북부산": "48",
    "창원": "48", "진주": "48", "김해": "48", "마산": "48",
    # 부산 26
    "부산": "26", "구서": "26", "부산요금소": "26",
    # 울산 31
    "서울산": "31", "울산": "31",
}


def _to_int(s: Any) -> int:
    try:
        return int(str(s).replace(",", "").strip() or 0)
    except Exception:
        return 0


def _dest_region(unit_name: str) -> str | None:
    """Map an OD unitName ('출발->도착') to the destination 시도 code."""
    if "->" not in unit_name:
        return None
    dest = unit_name.split("->", 1)[1].strip()
    # exact, then prefix/suffix contains (e.g. '북대구' → '대구' fallback handled by dict)
    if dest in _TOLLGATE_REGION:
        return _TOLLGATE_REGION[dest]
    for name, code in _TOLLGATE_REGION.items():
        if name and (name in dest or dest in name):
            return code
    return None


def fetch_highway_connectivity() -> dict[str, Any]:
    key = os.getenv("HIGHWAY_API_KEY", "").strip()
    if not key:
        print("[Highway] HIGHWAY_API_KEY not set — skipping", file=sys.stderr)
        return {"status": "skipped", "reason": "HIGHWAY_API_KEY not set", "regions": {}}

    region_traffic: dict[str, int] = {}
    total_rows = 0
    for page in range(1, MAX_PAGES + 1):
        params = {
            "key": key, "type": "json",
            "sumTmUnitTypeCode": "3", "startEndStdTypeCode": "2",
            "stdHour": PEAK_HOUR, "numOfRows": "100", "pageNo": str(page),
        }
        try:
            resp = httpx.get(BASE, params=params, headers=HEADERS, timeout=30)
            if resp.status_code != 200:
                print(f"[Highway] page {page} HTTP {resp.status_code}", file=sys.stderr)
                break
            data = resp.json()
        except Exception as exc:
            print(f"[Highway] page {page} failed: {exc}", file=sys.stderr)
            break
        rows = data.get("list") or []
        if not rows:
            break
        for r in rows:
            code = _dest_region(r.get("unitName", ""))
            if code:
                region_traffic[code] = region_traffic.get(code, 0) + _to_int(r.get("trafficAmout"))
        total_rows += len(rows)

    if not region_traffic:
        return {"status": "error", "reason": "no mapped traffic", "regions": {}}

    max_t = max(region_traffic.values()) or 1
    log_max = math.log10(max_t + 1) or 1.0
    regions = {
        code: {
            "connectivity": round(math.log10(t + 1) / log_max, 4),  # 0..1
            "arrival_traffic": t,
        }
        for code, t in region_traffic.items()
    }
    return {
        "status": "ok",
        "source": "한국도로공사 도착 교통량 (data.ex.co.kr odtraffic)",
        "note": "arrival-traffic connectivity index (sampled peak hour); relative & stable",
        "sampled_rows": total_rows,
        "peak_hour": PEAK_HOUR,
        "generated_at": datetime.now(KST).isoformat(),
        "regions": regions,
    }


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_highway_connectivity()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[Highway] saved {len(data.get('regions', {}))} regions (status={data.get('status')}) -> {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
