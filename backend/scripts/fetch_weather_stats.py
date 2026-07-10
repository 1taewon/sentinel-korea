"""fetch_weather_stats.py — Respiratory-weather favorability index by 시도.

Grounds a seasonal transmissibility signal in the meteorology-of-respiratory-
infection literature:
  - Temperature is the dominant driver across a 108-study / 9.22M-case meta-
    analysis: colder → higher risk for influenza, RSV, SARS-CoV-2, HCoV
    (Shang et al. 2026, Environment International).
  - Absolute humidity is the physical driver of influenza seasonality: low AH →
    higher virus survival & transmission, explaining 50% of transmission and 90%
    of survival variability (Shaman & Kohn 2009, PNAS; Shaman et al. 2010, PLoS Biol).
  - Korea is temperate → low temperature + low humidity raise most respiratory
    infection risk (Xu et al. 2021, Lancet Planetary Health).

We pull current temperature + relative humidity per 시도 from the KMA 초단기실황
API, compute absolute humidity from (T, RH), and combine into a 0..1 favorability
index = 0.6·(cold score) + 0.4·(dry score). Temperature is weighted higher because
the large meta-analysis makes it the dominant predictor; AH carries the influenza
seasonality mechanism.

Requires env var WEATHER_API_KEY (data.go.kr 기상청 단기예보/초단기실황 service key).
No-op if the key is unset.
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
OUTPUT_FILE = PROCESSED_DIR / "weather_respiratory_by_region.json"

BASE = "http://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst"
KST = timezone(timedelta(hours=9))
HEADERS = {"User-Agent": "Mozilla/5.0 (SentinelKorea weather fetcher)"}

# 시도 대표 지점의 KMA 격자 좌표 (nx, ny). Weather is regionally smooth, so a single
# representative point per province is sufficient for a relative favorability index.
_REGION_GRID: dict[str, tuple[int, int]] = {
    "11": (60, 127),  # 서울
    "26": (98, 76),   # 부산
    "27": (89, 90),   # 대구
    "28": (55, 124),  # 인천
    "29": (58, 74),   # 광주
    "30": (67, 100),  # 대전
    "31": (102, 84),  # 울산
    "36": (66, 103),  # 세종
    "41": (60, 121),  # 경기(수원)
    "42": (73, 134),  # 강원(춘천)
    "43": (69, 106),  # 충북(청주)
    "44": (51, 110),  # 충남(홍성)
    "45": (63, 89),   # 전북(전주)
    "46": (51, 67),   # 전남(무안)
    "47": (91, 106),  # 경북(안동)
    "48": (91, 77),   # 경남(창원)
    "50": (53, 38),   # 제주
}


def _abs_humidity(temp_c: float, rh_pct: float) -> float:
    """Absolute humidity (g/m³) from temperature (°C) and relative humidity (%).
    Standard formula via saturation vapor pressure (Magnus)."""
    rh = max(0.0, min(100.0, rh_pct))
    svp = 6.112 * math.exp((17.67 * temp_c) / (temp_c + 243.5))  # hPa
    return (svp * rh * 2.1674) / (273.15 + temp_c)


def _favorability(temp_c: float, ah: float) -> float:
    """Respiratory-weather favorability 0..1: colder + drier → higher.
    Cold score: T=25°C→0, T=-5°C→1. Dry score: AH=16→0, AH=2→1."""
    cold = max(0.0, min(1.0, (25.0 - temp_c) / 30.0))
    dry = max(0.0, min(1.0, (16.0 - ah) / 14.0))
    return round(0.6 * cold + 0.4 * dry, 4)


def _base_datetime() -> tuple[str, str]:
    """KMA 초단기실황 base_date/base_time — last completed hour (published ~10min
    after the hour), so we step back 45 minutes and floor to the hour."""
    t = datetime.now(KST) - timedelta(minutes=45)
    return t.strftime("%Y%m%d"), t.strftime("%H00")


def fetch_weather_respiratory() -> dict[str, Any]:
    key = os.getenv("WEATHER_API_KEY", "").strip()
    if not key:
        print("[Weather] WEATHER_API_KEY not set — skipping", file=sys.stderr)
        return {"status": "skipped", "reason": "WEATHER_API_KEY not set", "regions": {}}

    base_date, base_time = _base_datetime()
    regions: dict[str, Any] = {}
    for code, (nx, ny) in _REGION_GRID.items():
        params = {
            "serviceKey": key, "dataType": "JSON", "numOfRows": "60", "pageNo": "1",
            "base_date": base_date, "base_time": base_time, "nx": str(nx), "ny": str(ny),
        }
        try:
            resp = httpx.get(BASE, params=params, headers=HEADERS, timeout=20)
            items = (resp.json().get("response", {}).get("body", {})
                     .get("items", {}).get("item", []))
        except Exception as exc:
            print(f"[Weather] region {code} failed: {exc}", file=sys.stderr)
            continue
        vals = {it.get("category"): it.get("obsrValue") for it in items if isinstance(it, dict)}
        try:
            temp_c = float(vals.get("T1H"))
            rh = float(vals.get("REH"))
        except (TypeError, ValueError):
            continue
        ah = _abs_humidity(temp_c, rh)
        regions[code] = {
            "favorability": _favorability(temp_c, ah),
            "temp_c": round(temp_c, 1),
            "humidity": round(rh, 0),
            "abs_humidity": round(ah, 2),
        }

    if not regions:
        return {"status": "error", "reason": "no weather data parsed", "regions": {}}

    return {
        "status": "ok",
        "source": "기상청 초단기실황 (data.go.kr VilageFcstInfoService)",
        "note": "respiratory-weather favorability = 0.6·cold + 0.4·dry (Shang 2026; Shaman 2009/2010)",
        "base": f"{base_date} {base_time} KST",
        "generated_at": datetime.now(KST).isoformat(),
        "regions": regions,
    }


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_weather_respiratory()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[Weather] saved {len(data.get('regions', {}))} regions (status={data.get('status')}) -> {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
