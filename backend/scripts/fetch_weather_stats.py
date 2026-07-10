"""fetch_weather_stats.py — Respiratory-weather favorability index by 시도 (temperature).

Grounded in the single strongest signal from the meteorology-of-respiratory-infection
literature: TEMPERATURE is the dominant driver across a 108-study / 9.22M-case
meta-analysis — each 1°C rise lowers risk for influenza, RSV, SARS-CoV-2 and HCoV
(colder → higher risk); Korea is temperate, so cold seasons raise most respiratory
infection risk (Shang et al. 2026, Environment International).

We use the KMA 단기예보 (동네예보, getVilageFcst) — a real 3-day hourly FORECAST, not
just current observation — and average the forecast temperature (TMP) over the coming
~2 days per 시도, then map it to a 0..1 favorability (colder → higher). Absolute
humidity was dropped in favor of the temperature-only signal, which the meta-analysis
makes the dominant, best-supported predictor.

Requires env var WEATHER_API_KEY (data.go.kr 기상청 단기예보 service key). No-op if unset.
"""
from __future__ import annotations

import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
OUTPUT_FILE = PROCESSED_DIR / "weather_respiratory_by_region.json"

BASE = "http://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst"
KST = timezone(timedelta(hours=9))
HEADERS = {"User-Agent": "Mozilla/5.0 (SentinelKorea weather fetcher)"}
FORECAST_HOURS = 48  # average TMP over the coming ~2 days

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


def _favorability(temp_c: float) -> float:
    """Respiratory-weather favorability 0..1 from temperature: T=25°C→0, T=-5°C→1
    (colder → higher). Temperature is the dominant predictor (Shang 2026)."""
    return round(max(0.0, min(1.0, (25.0 - temp_c) / 30.0)), 4)


def _base_datetime() -> tuple[str, str]:
    """Latest available 단기예보 issuance. getVilageFcst publishes at 02/05/08/11/14/
    17/20/23시 (available ~10min after); we step back 15 min and pick the latest slot."""
    now = datetime.now(KST) - timedelta(minutes=15)
    for h in (23, 20, 17, 14, 11, 8, 5, 2):
        if now.hour >= h:
            return now.strftime("%Y%m%d"), f"{h:02d}00"
    prev = now - timedelta(days=1)
    return prev.strftime("%Y%m%d"), "2300"


def _fetch_region_temp(code: str, nx: int, ny: int, key: str,
                       base_date: str, base_time: str) -> tuple[str, dict[str, Any] | None]:
    """Fetch one 시도's forecast TMP and reduce to a favorability record."""
    params = {
        "serviceKey": key, "dataType": "JSON", "numOfRows": "700", "pageNo": "1",
        "base_date": base_date, "base_time": base_time, "nx": str(nx), "ny": str(ny),
    }
    try:
        resp = httpx.get(BASE, params=params, headers=HEADERS, timeout=8)
        items = (resp.json().get("response", {}).get("body", {})
                 .get("items", {}).get("item", []))
    except Exception as exc:
        print(f"[Weather] region {code} failed: {exc}", file=sys.stderr)
        return code, None
    # TMP (기온) forecast values, in time order, over the coming FORECAST_HOURS.
    temps: list[float] = []
    for it in items:
        if isinstance(it, dict) and it.get("category") == "TMP":
            try:
                temps.append(float(it.get("fcstValue")))
            except (TypeError, ValueError):
                pass
    temps = temps[:FORECAST_HOURS]
    if not temps:
        return code, None
    avg_t = sum(temps) / len(temps)
    return code, {
        "favorability": _favorability(avg_t),
        "temp_c": round(avg_t, 1),
        "forecast_hours": len(temps),
    }


def fetch_weather_respiratory() -> dict[str, Any]:
    key = os.getenv("WEATHER_API_KEY", "").strip()
    if not key:
        print("[Weather] WEATHER_API_KEY not set — skipping", file=sys.stderr)
        return {"status": "skipped", "reason": "WEATHER_API_KEY not set", "regions": {}}

    base_date, base_time = _base_datetime()
    regions: dict[str, Any] = {}
    # Fetch all 17 시도 concurrently so a live call (per Outbreak Scenario run) stays
    # fast (~2-3s) instead of ~15s sequential.
    with ThreadPoolExecutor(max_workers=len(_REGION_GRID)) as ex:
        futures = [ex.submit(_fetch_region_temp, code, nx, ny, key, base_date, base_time)
                   for code, (nx, ny) in _REGION_GRID.items()]
        for fut in futures:
            code, data = fut.result()
            if data:
                regions[code] = data

    if not regions:
        return {"status": "error", "reason": "no forecast temperature parsed", "regions": {}}

    return {
        "status": "ok",
        "source": "기상청 단기예보 기온 (data.go.kr getVilageFcst, 3-day forecast)",
        "note": "temperature-only respiratory favorability = clamp((25-T)/30) (Shang 2026 — temp dominant)",
        "base": f"{base_date} {base_time} KST",
        "forecast_hours": FORECAST_HOURS,
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
