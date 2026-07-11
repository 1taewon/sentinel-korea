"""fetch_multimodal_mobility.py — Korean interregional mobility network (road + rail + air).

The available public passenger APIs do NOT expose station-pair / airport-pair OD, so we
build the network the standard way for a partial OD sample: observed pairwise corridors +
region-level activity marginals that shape each region's gravity connectivity.

  * Korea Expressway tollgate data — real pairwise OD  (the one true OD source).
  * KAC domestic flight schedule (/dom) — city-pair FLIGHT COUNTS (OD-shaped capacity proxy).
  * SRT daily_passengers — per-ROUTE boarding counts; SRT runs 수서↔부산 / 수서↔호남, so a
    route ≈ a corridor (observed rail corridor, coarse).
  * KORAIL mainLineTravelerTrain — per-STATION 승차/하차 (a regional MARGINAL, not a pair).
  * KAC daily expected passengers (/info) — per-AIRPORT totals (a regional MARGINAL, 3 airports).

So:
  * pairwise OD EDGES  = highway OD (observed) + flight schedule (proxy) + SRT route (observed corridor)
  * region CONNECTIVITY = road + rail(marginal) + air(marginal) activity → feeds the gravity model
Every mode keeps its observation/proxy label so nothing is mislabelled as measured passenger OD.
When a passenger API's JSON field names differ from what we try, the mode metadata records
``sample_keys`` (the first row's keys) so the exact fields can be wired up from a real run.
"""
from __future__ import annotations

import json
import os
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
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

KORAIL_MAIN_LINE = "https://apis.data.go.kr/B551457/carriageStatistics/mainLineTravelerTrain"
SRT_DAILY_PASSENGERS = "https://apis.data.go.kr/B553912/srt_passenger/v1/daily_passengers"
DOMESTIC_FLIGHT = "https://apis.data.go.kr/B551178/flight-schedule/dom"
AIRPORT_EXPECT_PASSENGER = "https://apis.data.go.kr/B551178/airport-daily-expect-passenger/info"

# Station / terminal label → 시도 code (principal stations only; unknown labels skipped).
_REGION_ALIASES: dict[str, str] = {
    "서울": "11", "수서": "11", "용산": "11", "청량리": "11", "김포": "11", "영등포": "11",
    "부산": "26", "구포": "26", "대구": "27", "동대구": "27", "서대구": "27",
    "인천": "28", "광주": "29", "송정": "29", "대전": "30", "서대전": "30", "울산": "31",
    "세종": "36", "오송": "36", "수원": "41", "평택": "41", "광명": "41", "경기": "41",
    "강릉": "42", "춘천": "42", "원주": "42", "청주": "43", "충주": "43",
    "천안": "44", "아산": "44", "공주": "44", "전주": "45", "익산": "45", "정읍": "45",
    "목포": "46", "여수": "46", "순천": "46", "포항": "47", "경주": "47",
    "구미": "47", "안동": "47", "김천": "47", "창원": "48", "진주": "48", "김해": "48",
    "마산": "48", "제주": "50",
}
# KAC city codes → 시도 code.
_AIRPORT_REGION = {
    "GMP": "11", "SEL": "11", "PUS": "26", "TAE": "27", "ICN": "28",
    "KWJ": "29", "CJJ": "43", "USN": "31", "KUV": "45", "RSU": "46",
    "KPO": "47", "HIN": "48", "CJU": "50", "YNY": "42",
}
_DOMESTIC_FLIGHT_PAIRS = (
    ("GMP", "CJU"), ("GMP", "PUS"), ("GMP", "TAE"), ("GMP", "KWJ"), ("GMP", "CJJ"),
    ("CJU", "PUS"), ("CJU", "TAE"), ("CJU", "KWJ"), ("CJU", "USN"), ("CJU", "RSU"), ("CJU", "KPO"),
)
# KAC "일별 예상승객 정보" only covers three airports.
_EXPECT_AIRPORTS = {"GMP": "11", "CJU": "50", "PUS": "26"}
# SRT route name → the non-Suseo (11) end of the corridor.
_SRT_ROUTE_TARGETS = (("부산", "26"), ("경부", "26"), ("목포", "46"), ("호남", "29"),
                      ("광주", "29"), ("송정", "29"))


def _service_key() -> str:
    for name in ("MOBILITY_API_KEY", "DATA_GO_KR_API_KEY", "KORAIL_API_KEY"):
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
    if not isinstance(payload, dict):
        return []
    body = (payload.get("response") or {}).get("body") or {}
    candidates: list[Any] = [
        payload.get("data"), payload.get("items"), payload.get("item"),
        body.get("items"), body.get("item"), body.get("data"),
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
    for name, code in sorted(_REGION_ALIASES.items(), key=lambda kv: len(kv[0]), reverse=True):
        if name in label:
            return code
    return None


def _get_json(url: str, params: dict[str, Any], timeout: int = 20) -> dict[str, Any] | None:
    """GET JSON with one retry on transient failure / throttle (429/5xx)."""
    for attempt in range(2):
        try:
            response = httpx.get(url, params=params, timeout=timeout,
                                 headers={"User-Agent": "Sentinel-Korea mobility collector"})
            if response.status_code == 200:
                return response.json()
            if response.status_code in (429, 500, 502, 503) and attempt == 0:
                time.sleep(1.2)
                continue
            return None
        except Exception:
            if attempt == 0:
                time.sleep(0.8)
                continue
            return None
    return None


def _recent_day(offset_days: int = 8) -> str:
    return (datetime.now(KST) - timedelta(days=offset_days)).strftime("%Y%m%d")


def _sample_keys(rows: list[dict[str, Any]]) -> list[str]:
    return list(rows[0].keys())[:24] if rows else []


# ── Rail: KORAIL per-station boarding/alighting → regional marginal ──────────────
def _fetch_korail_marginals(key: str) -> tuple[dict[str, float], dict[str, Any]]:
    if not key:
        return {}, {"status": "skipped", "reason": "no public-data service key"}
    gte, lte = _recent_day(50), _recent_day(5)  # KORAIL stats lag; sample a recent window
    rows = _items(_get_json(KORAIL_MAIN_LINE, {
        "serviceKey": key, "pageNo": 1, "numOfRows": 1000, "returnType": "JSON",
        "cond[run_ymd::GTE]": gte, "cond[run_ymd::LTE]": lte,
    }))
    activity: dict[str, float] = defaultdict(float)
    parsed = 0
    for row in rows:
        region = _region_from_label(_value(row, "stn_nm", "STN_NM", "역명"))
        board = _as_int(_value(row, "abrd_nope", "ABRD_NOPE", "승차인원수"))     # 승차 인원
        alight = _as_int(_value(row, "goff_nope", "GOFF_NOPE", "하차인원수"))    # 하차 인원
        if region and (board + alight) > 0:
            activity[region] += board + alight
            parsed += 1
    if activity:
        return dict(activity), {"status": "ok", "observation": "observed_station_marginal",
                                "window": f"{gte}~{lte}", "rows": parsed, "endpoint": "KORAIL mainLineTravelerTrain"}
    return {}, {"status": "unavailable", "reason": "station 승차/하차 fields not matched",
                "rows_received": len(rows), "sample_keys": _sample_keys(rows)}


# ── Rail: SRT per-route boarding → corridor (수서↔부산 / 수서↔호남) ─────────────
def _srt_route_pair(route_nm: Any) -> tuple[str, str] | None:
    label = str(route_nm or "")
    for keyword, code in _SRT_ROUTE_TARGETS:
        if keyword in label:
            return ("11", code)
    return None


def _fetch_srt_corridors(key: str) -> tuple[dict[tuple[str, str], float], dict[str, Any]]:
    if not key:
        return {}, {"status": "skipped", "reason": "no public-data service key"}
    d0, d1 = _recent_day(50), _recent_day(5)  # SRT stats lag; sample a recent window
    rows = _items(_get_json(SRT_DAILY_PASSENGERS, {
        "serviceKey": key, "page": 1, "perPage": 2000, "returnType": "JSON",
        "cond[RUN_YMD::GTE]": d0, "cond[RUN_YMD::LTE]": d1,
    }))
    corridors: dict[tuple[str, str], float] = defaultdict(float)
    parsed = 0
    for row in rows:
        pair = _srt_route_pair(_value(row, "ROUTE_NM", "route_nm", "운행노선명"))
        passengers = _as_int(_value(row, "TKCAR_NMPR_CNT", "tkcar_nmpr_cnt", "승차인원수"))
        if pair and passengers > 0:
            corridors[pair] += passengers
            corridors[(pair[1], pair[0])] += passengers  # route boarding is aggregated → treat symmetric
            parsed += 1
    if corridors:
        return dict(corridors), {"status": "ok", "observation": "observed_route_corridor",
                                 "rows": parsed, "endpoint": "SRT daily_passengers"}
    return {}, {"status": "unavailable", "reason": "route 승차인원 fields not matched",
                "rows_received": len(rows), "sample_keys": _sample_keys(rows)}


# ── Air: KAC domestic flight schedule → city-pair flight-count capacity proxy ─────
def _fetch_flight_proxy(key: str) -> tuple[dict[tuple[str, str], float], dict[str, Any]]:
    if not key:
        return {}, {"status": "skipped", "reason": "no public-data service key"}
    day = datetime.now(KST).strftime("%Y%m%d")
    corridors: dict[tuple[str, str], float] = defaultdict(float)
    seats = int(os.getenv("DOMESTIC_FLIGHT_PROXY_SEATS", "180"))

    def one_pair(pair: tuple[str, str]) -> tuple[tuple[str, str], int]:
        origin, destination = pair
        payload = _get_json(DOMESTIC_FLIGHT, {
            "serviceKey": key, "schDate": day, "schDeptCityCode": origin,
            "schArrvCityCode": destination, "numOfRows": 200, "pageNo": 1, "type": "json",
        })
        return pair, len(_items(payload))

    with ThreadPoolExecutor(max_workers=2) as pool:  # gentle: avoid tripping data.go.kr burst throttle
        futures = [pool.submit(one_pair, pair) for pair in _DOMESTIC_FLIGHT_PAIRS]
        for future in as_completed(futures):
            (origin, destination), flights = future.result()
            source, target = _AIRPORT_REGION[origin], _AIRPORT_REGION[destination]
            if flights and source != target:
                corridors[(source, target)] += flights * seats
                corridors[(target, source)] += flights * seats  # scheduled both ways
    if corridors:
        return dict(corridors), {"status": "ok", "observation": "scheduled_capacity_proxy",
                                 "date": day, "routes": len(corridors), "endpoint": "KAC flight-schedule/dom"}
    return {}, {"status": "unavailable", "reason": "no domestic schedule rows parsed"}


# ── Air: KAC daily expected passengers → airport regional marginal (3 airports) ───
def _fetch_air_marginals(key: str) -> tuple[dict[str, float], dict[str, Any]]:
    if not key:
        return {}, {"status": "skipped", "reason": "no public-data service key"}
    day = datetime.now(KST).strftime("%Y%m%d")
    activity: dict[str, float] = defaultdict(float)
    parsed = 0
    sample: list[str] = []
    for airport, code in _EXPECT_AIRPORTS.items():
        # Same-day forecast only (future dates return empty); sum all hours + arr/dep.
        rows = _items(_get_json(AIRPORT_EXPECT_PASSENGER, {
            "serviceKey": key, "pageNo": 1, "numOfRows": 200, "schDate": day,
            "schAirport": airport, "schTof": "D", "type": "json",
        }))
        if rows and not sample:
            sample = _sample_keys(rows)
        for row in rows:
            passengers = _as_int(_value(row, "PCT", "pct", "예상승객수"))  # 예상 승객수 (시간대별)
            if passengers > 0:
                activity[code] += passengers
                parsed += 1
    activity = {code: value for code, value in activity.items() if value > 0}
    if activity:
        return activity, {"status": "ok", "observation": "observed_airport_marginal",
                          "date": day, "rows": parsed, "endpoint": "KAC airport-daily-expect-passenger"}
    return {}, {"status": "unavailable", "reason": "expected-passenger fields not matched",
                "sample_keys": sample}


def _mode_mix(mode: str, observed: bool) -> float:
    defaults = {"highway": 0.62, "srt": 0.12, "domestic_flight": 0.06}
    try:
        configured = json.loads(os.getenv("MOBILITY_MODE_WEIGHTS_JSON", "{}"))
        if isinstance(configured, dict) and mode in configured:
            return max(0.0, float(configured[mode]))
    except Exception:
        pass
    return defaults.get(mode, 0.0) * (1.0 if observed else 0.4)  # proxies down-weighted


def _combine_edges(edge_modes: dict[str, tuple[dict[tuple[str, str], float], dict[str, Any]]]
                   ) -> tuple[list[dict], dict[str, dict]]:
    """Blend the pairwise-OD modes (each normalized, mode-weighted) into corridors."""
    combined: dict[tuple[str, str], float] = defaultdict(float)
    edge_modes_seen: dict[tuple[str, str], dict[str, dict]] = defaultdict(dict)
    summaries: dict[str, dict] = {}
    for mode, (corridors, metadata) in edge_modes.items():
        observed = metadata.get("observation") in ("observed_traffic_od", "observed_route_corridor") or mode == "highway"
        total = sum(max(0.0, v) for v in corridors.values())
        mix = _mode_mix(mode, observed)
        summaries[mode] = {**metadata, "corridors": len(corridors), "mix_weight": round(mix, 4)}
        if total <= 0 or mix <= 0:
            continue
        for edge, value in corridors.items():
            contribution = mix * (max(0.0, value) / total)
            combined[edge] += contribution
            edge_modes_seen[edge][mode] = {
                "observation": metadata.get("observation", "observed_traffic" if mode == "highway" else "unknown"),
                "normalized_contribution": round(contribution, 8),
            }
    max_value = max(combined.values(), default=0.0)
    corridors = [
        {"source": s, "target": t, "traffic": int(round(v * 1_000_000)),
         "weight": round(v / max_value, 6) if max_value else 0.0, "modes": edge_modes_seen[(s, t)]}
        for (s, t), v in sorted(combined.items(), key=lambda kv: kv[1], reverse=True) if v > 0
    ]
    return corridors, summaries


def _region_connectivity(highway_regions: dict[str, Any], rail_marginal: dict[str, float],
                         air_marginal: dict[str, float]) -> dict[str, dict]:
    """Per-region gravity connectivity = road + rail(marginal) + air(marginal) activity,
    floored so no region is starved (real travel is never exactly zero)."""
    def _norm(values: dict[str, float]) -> dict[str, float]:
        mx = max(values.values(), default=0.0)
        return {c: (v / mx) for c, v in values.items()} if mx else {}

    road = {c: float((v or {}).get("connectivity") or 0.0) for c, v in highway_regions.items()}
    rail = _norm(rail_marginal)
    air = _norm(air_marginal)
    w_road, w_rail, w_air = 0.6, 0.25, 0.15
    codes = set(road) | set(rail) | set(air)
    activity = {c: w_road * road.get(c, 0.0) + w_rail * rail.get(c, 0.0) + w_air * air.get(c, 0.0)
                for c in codes}
    mx = max(activity.values(), default=0.0)
    return {
        c: {
            "connectivity": round(0.3 + 0.7 * (activity[c] / mx), 4) if mx else 0.5,
            "rail_activity": int(round(rail_marginal.get(c, 0.0))),
            "air_activity": int(round(air_marginal.get(c, 0.0))),
            "road_index": round(road.get(c, 0.0), 4),
        }
        for c in codes
    }


def fetch_multimodal_mobility(highway_data: dict[str, Any] | None = None) -> dict[str, Any]:
    key = _service_key()
    highway = highway_data if isinstance(highway_data, dict) else fetch_highway_connectivity()
    highway_regions = highway.get("regions") or {}
    highway_corridors = {
        (str(r.get("source")), str(r.get("target"))): float(r.get("traffic") or 0)
        for r in highway.get("corridors") or []
        if r.get("source") and r.get("target")
    }
    flight, flight_meta = _fetch_flight_proxy(key)
    srt, srt_meta = _fetch_srt_corridors(key)
    korail_marginal, korail_meta = _fetch_korail_marginals(key)
    air_marginal, air_meta = _fetch_air_marginals(key)

    corridors, modes = _combine_edges({
        "highway": (highway_corridors, {"status": highway.get("status"),
                                        "observation": "observed_traffic_od",
                                        "source": highway.get("source"),
                                        "sampled_rows": highway.get("sampled_rows")}),
        "domestic_flight": (flight, flight_meta),
        "srt": (srt, srt_meta),
    })
    # Marginal modes shape region connectivity, not pairwise edges — record separately.
    modes["korail_marginal"] = {**korail_meta, "regions": len(korail_marginal)}
    modes["air_marginal"] = {**air_meta, "regions": len(air_marginal)}

    regions = _region_connectivity(highway_regions, korail_marginal, air_marginal)

    observed_edge_modes = [name for name, meta in modes.items()
                           if meta.get("observation") in ("observed_traffic_od", "observed_route_corridor")
                           and meta.get("corridors")]
    active_marginals = [name for name in ("korail_marginal", "air_marginal") if modes[name].get("regions")]
    status = "ok" if corridors else ("partial" if highway.get("status") == "ok" else "empty")
    return {
        "status": status,
        "source": "Korea multimodal mobility (road OD + flight proxy + rail corridor/marginals)",
        "note": "Pairwise edges = highway OD (observed) + flight schedule (capacity proxy) + SRT route "
                "(observed corridor). Region connectivity = road + rail(마진) + air(마진) activity. "
                "Rail/air passenger APIs give per-station/airport totals, not pairwise OD, so they "
                "inform connectivity and the gravity fill — not fabricated corridors. Mode weights "
                "are configurable via MOBILITY_MODE_WEIGHTS_JSON.",
        "generated_at": datetime.now(KST).isoformat(),
        "observed_edge_modes": observed_edge_modes,
        "active_marginals": active_marginals,
        "regions": regions,
        "corridors": corridors,
        "modes": modes,
    }


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_multimodal_mobility()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[Mobility] {len(data.get('corridors', []))} corridors, "
          f"edges={data.get('observed_edge_modes')}, marginals={data.get('active_marginals')} "
          f"(status={data.get('status')}) -> {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
