"""fetch_multimodal_mobility.py — build a transparent Korean interregional mobility network.

The simulator needs directed region-to-region mixing, not a generic "traffic score".
This collector combines:
  * Korea Expressway Corporation tollgate OD traffic (observed traffic, including
    intercity/highway buses in the road flow);
  * KORAIL main-line passenger transport statistics when the API returns OD counts;
  * domestic-flight schedules as a clearly labelled capacity proxy only -- the public
    schedule API publishes movements, not boarded passengers.

Every corridor records its contributing modes and observation type.  The model can
therefore distinguish observed OD data from schedule topology/capacity proxies and
never label all of them "measured passenger volume".
"""
from __future__ import annotations

import json
import math
import os
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

import httpx

try:
    from fetch_highway_traffic import fetch_highway_connectivity
except ImportError:  # imported dynamically by upload_router
    from .fetch_highway_traffic import fetch_highway_connectivity

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
OUTPUT_FILE = PROCESSED_DIR / "multimodal_mobility_by_region.json"
KST = timezone(timedelta(hours=9))

KORAIL_STATS = "https://apis.data.go.kr/B551457/carriageStatistics/mainLineTravelerTrain"
DOMESTIC_FLIGHT = "http://openapi.airport.co.kr/service/rest/FlightScheduleList/getDflightScheduleList"

# Region resolver deliberately covers principal stations, airports and terminals used
# by national movement; unknown labels are skipped rather than guessed.
_REGION_ALIASES: dict[str, str] = {
    "서울": "11", "수서": "11", "용산": "11", "청량리": "11", "김포": "11",
    "부산": "26", "구포": "26", "대구": "27", "동대구": "27", "서대구": "27",
    "인천": "28", "광주": "29", "송정": "29", "대전": "30", "울산": "31",
    "세종": "36", "수원": "41", "평택": "41", "광명": "41", "경기": "41",
    "강릉": "42", "춘천": "42", "원주": "42", "청주": "43", "충주": "43",
    "천안": "44", "아산": "44", "공주": "44", "전주": "45", "익산": "45",
    "목포": "46", "여수": "46", "순천": "46", "포항": "47", "경주": "47",
    "구미": "47", "안동": "47", "창원": "48", "진주": "48", "김해": "48",
    "마산": "48", "제주": "50",
}
_AIRPORT_REGION = {
    "GMP": "11", "SEL": "11", "PUS": "26", "TAE": "27", "ICN": "28",
    "KWJ": "29", "CJJ": "43", "USN": "31", "KUV": "45", "RSU": "46",
    "KPO": "47", "HIN": "48", "CJU": "50", "YNY": "42",
}
_DOMESTIC_FLIGHT_PAIRS = (
    ("GMP", "CJU"), ("GMP", "PUS"), ("GMP", "TAE"), ("GMP", "KWJ"),
    ("GMP", "CJJ"), ("CJU", "PUS"), ("CJU", "TAE"), ("CJU", "KWJ"),
    ("CJU", "USN"), ("CJU", "RSU"), ("CJU", "KPO"),
)


def _service_key() -> str:
    """Accept the common Railway variable names without exposing their values."""
    for name in ("MOBILITY_API_KEY", "DATA_GO_KR_API_KEY", "KORAIL_API_KEY", "HIGHWAY_API_KEY"):
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def _as_int(value: Any) -> int:
    try:
        return int(float(str(value).replace(",", "").strip() or 0))
    except (TypeError, ValueError):
        return 0


def _items(payload: Any) -> list[dict[str, Any]]:
    """Extract list-shaped records from common data.go.kr JSON response envelopes."""
    if not isinstance(payload, dict):
        return []
    candidates: list[Any] = [
        payload.get("items"), payload.get("item"), payload.get("data"),
        ((payload.get("response") or {}).get("body") or {}).get("items"),
        ((payload.get("response") or {}).get("body") or {}).get("item"),
        ((payload.get("response") or {}).get("body") or {}).get("data"),
    ]
    for candidate in candidates:
        if isinstance(candidate, list):
            return [row for row in candidate if isinstance(row, dict)]
        if isinstance(candidate, dict):
            nested = candidate.get("item") or candidate.get("items")
            if isinstance(nested, list):
                return [row for row in nested if isinstance(row, dict)]
            return [candidate]
    return []


def _value(row: dict[str, Any], *names: str) -> Any:
    lookup = {str(key).lower(): value for key, value in row.items()}
    for name in names:
        value = lookup.get(name.lower())
        if value not in (None, ""):
            return value
    return None


def _region_from_label(value: Any) -> str | None:
    label = str(value or "").replace("역", "").replace("터미널", "").strip()
    if not label:
        return None
    for name, code in sorted(_REGION_ALIASES.items(), key=lambda item: len(item[0]), reverse=True):
        if name in label:
            return code
    return None


def _get_json(url: str, params: dict[str, Any], timeout: int = 20) -> dict[str, Any] | None:
    try:
        response = httpx.get(url, params=params, timeout=timeout,
                             headers={"User-Agent": "Sentinel-Korea mobility collector"})
        if response.status_code != 200:
            return None
        return response.json()
    except Exception:
        return None


def _fetch_korail_passenger_od(key: str) -> tuple[dict[tuple[str, str], float], dict[str, Any]]:
    """Use KORAIL transport-statistics OD counts if its response exposes both stations and passengers."""
    if not key:
        return {}, {"status": "skipped", "reason": "no public-data service key"}
    params = {"serviceKey": key, "pageNo": 1, "numOfRows": 1000, "resultType": "json", "_type": "json"}
    payload = _get_json(KORAIL_STATS, params)
    rows = _items(payload)
    corridors: dict[tuple[str, str], float] = defaultdict(float)
    parsed = 0
    for row in rows:
        source = _region_from_label(_value(row, "dptreStnNm", "dptreStationNm", "startStationNm", "fromStationNm"))
        target = _region_from_label(_value(row, "arvlStnNm", "arvlStationNm", "endStationNm", "toStationNm"))
        passengers = _as_int(_value(
            row, "passengerCnt", "passengerCo", "psngrCo", "psngrCnt", "trnpsnCnt",
            "transportPassengerCnt", "boardPassengerCnt", "ridePassengerCnt",
        ))
        if source and target and source != target and passengers > 0:
            corridors[(source, target)] += passengers
            parsed += 1
    if corridors:
        return dict(corridors), {"status": "ok", "observation": "observed_passenger_od",
                                 "rows": parsed, "endpoint": "KORAIL carriageStatistics/mainLineTravelerTrain"}
    return {}, {"status": "unavailable", "reason": "API response did not expose usable station-pair passenger counts",
                "rows_received": len(rows)}


def _fetch_domestic_flight_proxy(key: str) -> tuple[dict[tuple[str, str], float], dict[str, Any]]:
    """Count current domestic scheduled flights; convert to a labelled seat-capacity proxy."""
    if not key:
        return {}, {"status": "skipped", "reason": "no public-data service key"}
    day = datetime.now(KST).strftime("%Y%m%d")
    corridors: dict[tuple[str, str], float] = defaultdict(float)

    def one_pair(pair: tuple[str, str]) -> tuple[tuple[str, str], int]:
        origin, destination = pair
        payload = _get_json(DOMESTIC_FLIGHT, {
            "serviceKey": key, "schDate": day, "schDeptCityCode": origin,
            "schArrvCityCode": destination, "numOfRows": 200, "pageNo": 1, "_type": "json",
        })
        return pair, len(_items(payload))

    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(one_pair, pair) for pair in _DOMESTIC_FLIGHT_PAIRS]
        for future in as_completed(futures):
            (origin, destination), flights = future.result()
            source, target = _AIRPORT_REGION[origin], _AIRPORT_REGION[destination]
            if flights and source != target:
                # 180 is a configurable representative narrow-body seat count, not observed passengers.
                corridors[(source, target)] += flights * int(os.getenv("DOMESTIC_FLIGHT_PROXY_SEATS", "180"))
    if corridors:
        return dict(corridors), {"status": "ok", "observation": "scheduled_capacity_proxy",
                                 "date": day, "routes": len(corridors),
                                 "endpoint": "KAC domestic flight schedule"}
    return {}, {"status": "unavailable", "reason": "no domestic schedule rows parsed"}


def _mode_mix(mode: str, observed: bool) -> float:
    defaults = {
        "highway": 0.80,
        "korail": 0.18,
        "domestic_flight": 0.02,
    }
    try:
        configured = json.loads(os.getenv("MOBILITY_MODE_WEIGHTS_JSON", "{}"))
        if isinstance(configured, dict) and mode in configured:
            return max(0.0, float(configured[mode]))
    except Exception:
        pass
    # Schedule data informs topology but remains down-weighted against observed OD.
    return defaults.get(mode, 0.0) * (1.0 if observed else 0.35)


def _combine(mode_data: dict[str, tuple[dict[tuple[str, str], float], dict[str, Any]]]) -> tuple[list[dict], dict[str, dict]]:
    combined: dict[tuple[str, str], float] = defaultdict(float)
    edge_modes: dict[tuple[str, str], dict[str, dict]] = defaultdict(dict)
    summaries: dict[str, dict] = {}

    for mode, (corridors, metadata) in mode_data.items():
        observed = metadata.get("observation") == "observed_passenger_od" or mode == "highway"
        total = sum(max(0.0, value) for value in corridors.values())
        mix = _mode_mix(mode, observed)
        summaries[mode] = {**metadata, "corridors": len(corridors), "mix_weight": round(mix, 4)}
        if total <= 0 or mix <= 0:
            continue
        for edge, value in corridors.items():
            normalized = max(0.0, value) / total
            contribution = mix * normalized
            combined[edge] += contribution
            edge_modes[edge][mode] = {
                "observation": metadata.get("observation", "observed_traffic" if mode == "highway" else "unknown"),
                "normalized_contribution": round(contribution, 8),
            }

    max_value = max(combined.values(), default=0.0)
    corridors = [
        {
            "source": source,
            "target": target,
            "traffic": int(round(value * 1_000_000)),
            "weight": round(value / max_value, 6) if max_value else 0.0,
            "modes": edge_modes[(source, target)],
        }
        for (source, target), value in sorted(combined.items(), key=lambda item: item[1], reverse=True)
        if value > 0
    ]
    return corridors, summaries


def fetch_multimodal_mobility(highway_data: dict[str, Any] | None = None) -> dict[str, Any]:
    key = _service_key()
    highway = highway_data if isinstance(highway_data, dict) else fetch_highway_connectivity()
    highway_corridors = {
        (str(row.get("source")), str(row.get("target"))): float(row.get("traffic") or 0)
        for row in highway.get("corridors") or []
        if row.get("source") and row.get("target")
    }
    korail, korail_meta = _fetch_korail_passenger_od(key)
    domestic_air, domestic_air_meta = _fetch_domestic_flight_proxy(key)

    mode_data = {
        "highway": (highway_corridors, {
            "status": highway.get("status"), "observation": "observed_traffic_od",
            "source": highway.get("source"), "sampled_rows": highway.get("sampled_rows"),
        }),
        "korail": (korail, korail_meta),
        "domestic_flight": (domestic_air, domestic_air_meta),
    }
    corridors, modes = _combine(mode_data)
    inbound: dict[str, float] = defaultdict(float)
    for edge in corridors:
        inbound[edge["target"]] += float(edge["weight"])
    max_inbound = max(inbound.values(), default=0.0)
    regions = {
        code: {
            "connectivity": round(value / max_inbound, 4) if max_inbound else 0.0,
            "arrival_traffic": int(round(value * 1_000_000)),
        }
        for code, value in inbound.items()
    }
    observed_modes = [name for name, meta in modes.items() if meta.get("observation") in ("observed_traffic_od", "observed_passenger_od")]
    status = "ok" if corridors else ("partial" if highway.get("status") == "ok" else "empty")
    return {
        "status": status,
        "source": "Korea multimodal OD mobility network",
        "note": "Observed highway/KORAIL OD is kept distinct from the domestic-flight schedule-capacity proxy. "
                "Mode weights are configurable via MOBILITY_MODE_WEIGHTS_JSON.",
        "generated_at": datetime.now(KST).isoformat(),
        "observed_modes": observed_modes,
        "regions": regions,
        "corridors": corridors,
        "modes": modes,
    }


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_multimodal_mobility()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[Mobility] saved {len(data.get('corridors', []))} corridors (status={data.get('status')}) -> {OUTPUT_FILE}")


if __name__ == "__main__":
    main()