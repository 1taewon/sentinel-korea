"""Fetch KDCA notifiable disease data for Sentinel Korea.

Primary lane:
  EIDAPIService/PeriodRegion
  - weekly notifiable disease counts
  - domestic/imported split via dmstcVal and outnatnVal

Fallback/validation lane:
  EIDAPIService/PeriodBasic
  - weekly notifiable disease totals without domestic/imported split

The old Region endpoint is annual and regional, so it is no longer used as the
main weekly notifiable-disease signal.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import requests

try:
    import urllib3

    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except Exception:
    pass

BASE_URL = "https://apis.data.go.kr/1790387/EIDAPIService"
PERIOD_REGION_ENDPOINT = f"{BASE_URL}/PeriodRegion"
PERIOD_BASIC_ENDPOINT = f"{BASE_URL}/PeriodBasic"

API_KEY = os.getenv(
    "KDCA_EID_API_KEY",
    "25ac8da3a174e6fbf48e5f9bcc7786d566e67debe50164ee459c41f67b612f77",
)

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"

# Exact disease allow-list. This avoids treating Hib as seasonal influenza and
# keeps the API lane as a respiratory/notifiable corroboration source.
RESPIRATORY_NOTIFIABLE_DISEASES: dict[str, dict[str, Any]] = {
    "중증급성호흡기증후군(SARS)": {"category": "emerging_respiratory", "weight": 1.0},
    "중동호흡기증후군(MERS)": {"category": "emerging_respiratory", "weight": 1.0},
    "동물인플루엔자 인체감염증": {"category": "zoonotic_influenza", "weight": 1.0},
    "신종인플루엔자": {"category": "novel_influenza", "weight": 1.0},
    "디프테리아": {"category": "respiratory_notifiable", "weight": 0.55},
    "백일해": {"category": "respiratory_notifiable", "weight": 0.75},
    "b형헤모필루스인플루엔자": {"category": "respiratory_bacterial", "weight": 0.45},
    "폐렴구균 감염증": {"category": "respiratory_bacterial", "weight": 0.65},
    "레지오넬라증": {"category": "respiratory_bacterial", "weight": 0.65},
    "홍역": {"category": "airborne_notifiable", "weight": 0.45},
    "성홍열": {"category": "respiratory_related", "weight": 0.35},
}


def _parse_value(value: Any) -> float | None:
    if value in (None, "", "-"):
        return None
    try:
        return float(str(value).replace(",", "").strip())
    except ValueError:
        return None


def _parse_period(period: str) -> tuple[int | None, int | None, str | None]:
    match = re.search(r"(\d{4})년\s*(\d{1,2})주", period or "")
    if not match:
        return None, None, None
    year = int(match.group(1))
    week = int(match.group(2))
    return year, week, f"{year}-W{week:02d}"


def _items_from_response(data: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
    response = data.get("response", {})
    header = response.get("header", {})
    if header.get("resultCode") != "00":
        raise RuntimeError(f"KDCA API error: {header.get('resultMsg') or header}")

    body = response.get("body", {})
    items = body.get("items", {}).get("item", [])
    if isinstance(items, dict):
        items = [items]
    total = int(body.get("totalCount") or len(items) or 0)
    return items, total


def _fetch_page(endpoint: str, params: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
    response = requests.get(endpoint, params=params, verify=False, timeout=25)
    response.encoding = "utf-8"
    return _items_from_response(response.json())


def fetch_period_endpoint(endpoint: str, year: int, page_size: int = 1000) -> list[dict[str, Any]]:
    """Fetch all weekly rows for a KDCA period endpoint."""
    all_items: list[dict[str, Any]] = []
    page = 1
    total = 0
    while True:
        params = {
            "serviceKey": API_KEY,
            "resType": "2",
            "searchPeriodType": "3",  # weekly
            "searchStartYear": str(year),
            "searchEndYear": str(year),
            "pageNo": str(page),
            "numOfRows": str(page_size),
        }
        items, total = _fetch_page(endpoint, params)
        all_items.extend(items)
        if len(all_items) >= total or not items:
            break
        page += 1
        time.sleep(0.12)
    return all_items[:total]


def _normalize_period_region(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    updated_at = datetime.now(timezone.utc).isoformat()
    for item in items:
        disease = item.get("icdNm") or ""
        meta = RESPIRATORY_NOTIFIABLE_DISEASES.get(disease)
        if not meta:
            continue

        year, week, epiweek = _parse_period(item.get("period", ""))
        if not epiweek:
            # KDCA period endpoints include "계" total rows. Sentinel keeps only
            # epiweek-addressable records so snapshots remain region/week/pathogen compatible.
            continue
        total = _parse_value(item.get("resultVal")) or 0.0
        domestic = _parse_value(item.get("dmstcVal")) or 0.0
        imported = _parse_value(item.get("outnatnVal")) or 0.0
        records.append(
            {
                "source_type": "kdca_period_region",
                "period": item.get("period"),
                "year": year,
                "week": week,
                "epiweek": epiweek,
                "icd_group": item.get("icdGroupNm"),
                "disease": disease,
                "category": meta["category"],
                "weight": meta["weight"],
                "raw_value": total,
                "domestic_value": domestic,
                "imported_value": imported,
                "unit": "weekly reported cases",
                "updated_at": updated_at,
            }
        )
    return records


def _normalize_period_basic(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    updated_at = datetime.now(timezone.utc).isoformat()
    for item in items:
        disease = item.get("icdNm") or ""
        meta = RESPIRATORY_NOTIFIABLE_DISEASES.get(disease)
        if not meta:
            continue

        year, week, epiweek = _parse_period(item.get("period", ""))
        if not epiweek:
            continue
        records.append(
            {
                "source_type": "kdca_period_basic",
                "period": item.get("period"),
                "year": year,
                "week": week,
                "epiweek": epiweek,
                "icd_group": item.get("icdGroupNm"),
                "disease": disease,
                "category": meta["category"],
                "raw_value": _parse_value(item.get("resultVal")) or 0.0,
                "unit": "weekly reported cases",
                "updated_at": updated_at,
            }
        )
    return records


def summarize_period_region(records: list[dict[str, Any]]) -> dict[str, Any]:
    weekly: dict[str, dict[str, Any]] = {}
    disease_totals: defaultdict[str, float] = defaultdict(float)
    imported_totals: defaultdict[str, float] = defaultdict(float)

    for record in records:
        epiweek = record.get("epiweek") or "unknown"
        slot = weekly.setdefault(
            epiweek,
            {
                "epiweek": epiweek,
                "period": record.get("period"),
                "total": 0.0,
                "domestic": 0.0,
                "imported": 0.0,
                "weighted_total": 0.0,
                "diseases": [],
            },
        )
        total = float(record.get("raw_value") or 0.0)
        domestic = float(record.get("domestic_value") or 0.0)
        imported = float(record.get("imported_value") or 0.0)
        weight = float(record.get("weight") or 1.0)
        slot["total"] += total
        slot["domestic"] += domestic
        slot["imported"] += imported
        slot["weighted_total"] += total * weight
        if total or imported:
            slot["diseases"].append(
                {
                    "disease": record.get("disease"),
                    "total": total,
                    "domestic": domestic,
                    "imported": imported,
                }
            )
        disease_totals[str(record.get("disease"))] += total
        imported_totals[str(record.get("disease"))] += imported

    weekly_rows = sorted(
        weekly.values(),
        key=lambda row: (str(row.get("epiweek") or "")),
    )
    max_weighted = max((float(row["weighted_total"]) for row in weekly_rows), default=0.0)
    for row in weekly_rows:
        row["total"] = round(float(row["total"]), 3)
        row["domestic"] = round(float(row["domestic"]), 3)
        row["imported"] = round(float(row["imported"]), 3)
        row["weighted_total"] = round(float(row["weighted_total"]), 3)
        row["normalized_score"] = round(float(row["weighted_total"]) / max_weighted, 4) if max_weighted else 0.0

    latest = weekly_rows[-1] if weekly_rows else {}
    return {
        "record_count": len(records),
        "weekly": weekly_rows,
        "latest_epiweek": latest.get("epiweek"),
        "latest_period": latest.get("period"),
        "latest_normalized_score": latest.get("normalized_score", 0.0),
        "disease_totals": dict(sorted(disease_totals.items())),
        "imported_totals": dict(sorted(imported_totals.items())),
    }


def validate_against_period_basic(
    region_records: list[dict[str, Any]],
    basic_records: list[dict[str, Any]],
) -> dict[str, Any]:
    basic_map = {
        (record.get("epiweek"), record.get("disease")): float(record.get("raw_value") or 0.0)
        for record in basic_records
    }
    mismatches = []
    missing = []
    for record in region_records:
        key = (record.get("epiweek"), record.get("disease"))
        region_value = float(record.get("raw_value") or 0.0)
        basic_value = basic_map.get(key)
        if basic_value is None:
            missing.append({"epiweek": key[0], "disease": key[1]})
        elif abs(region_value - basic_value) > 0.0001:
            mismatches.append(
                {
                    "epiweek": key[0],
                    "disease": key[1],
                    "period_region": region_value,
                    "period_basic": basic_value,
                }
            )
    return {
        "period_basic_records": len(basic_records),
        "missing_in_period_basic": missing[:20],
        "mismatch_count": len(mismatches),
        "mismatches": mismatches[:20],
    }


def save_outputs(year: int, period_region_records: list[dict[str, Any]], period_basic_records: list[dict[str, Any]]) -> dict[str, Any]:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    summary = summarize_period_region(period_region_records)
    validation = validate_against_period_basic(period_region_records, period_basic_records)

    payload = {
        "status": "ok",
        "year": year,
        "primary_source": "KDCA EIDAPIService/PeriodRegion",
        "fallback_source": "KDCA EIDAPIService/PeriodBasic",
        "scope": "national weekly notifiable respiratory subset; PeriodRegion separates domestic/imported counts, not 17 sido regions",
        "respiratory_diseases": sorted(RESPIRATORY_NOTIFIABLE_DISEASES),
        "summary": summary,
        "validation": validation,
        "records": period_region_records,
    }
    basic_payload = {
        "status": "ok",
        "year": year,
        "source": "KDCA EIDAPIService/PeriodBasic",
        "records": period_basic_records,
    }

    (PROCESSED_DIR / "kdca_notifiable_weekly.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (PROCESSED_DIR / "kdca_notifiable_period_region.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (PROCESSED_DIR / "kdca_notifiable_period_basic.json").write_text(
        json.dumps(basic_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # Compatibility summary for older code paths that look for kdca_notifiable.json.
    compatibility = {
        "status": "ok",
        "source": payload["primary_source"],
        "year": year,
        "latest_epiweek": summary.get("latest_epiweek"),
        "latest_period": summary.get("latest_period"),
        "latest_normalized_score": summary.get("latest_normalized_score", 0.0),
        "record_count": summary.get("record_count", 0),
        "note": payload["scope"],
    }
    (PROCESSED_DIR / "kdca_notifiable.json").write_text(
        json.dumps(compatibility, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return payload


def main(year: int | None = None) -> dict[str, Any]:
    target_year = int(year or os.getenv("KDCA_NOTIFIABLE_YEAR") or date.today().year)
    region_items = fetch_period_endpoint(PERIOD_REGION_ENDPOINT, target_year)
    basic_items = fetch_period_endpoint(PERIOD_BASIC_ENDPOINT, target_year)
    region_records = _normalize_period_region(region_items)
    basic_records = _normalize_period_basic(basic_items)

    if not region_records:
        raise RuntimeError("KDCA PeriodRegion returned no respiratory notifiable records.")

    payload = save_outputs(target_year, region_records, basic_records)
    summary = payload["summary"]
    print(
        f"Saved KDCA PeriodRegion weekly data: {summary['record_count']} records, "
        f"latest={summary.get('latest_epiweek')}, score={summary.get('latest_normalized_score')}"
    )
    validation = payload["validation"]
    if validation["mismatch_count"]:
        print(f"Validation warning: {validation['mismatch_count']} PeriodBasic mismatches.")
    else:
        print("Validation OK: PeriodRegion totals match PeriodBasic for the respiratory subset.")
    return {
        "status": "ok",
        "year": target_year,
        "primary_source": payload["primary_source"],
        "fallback_source": payload["fallback_source"],
        "record_count": summary["record_count"],
        "latest_epiweek": summary.get("latest_epiweek"),
        "latest_period": summary.get("latest_period"),
        "latest_normalized_score": summary.get("latest_normalized_score"),
        "validation": validation,
        "files": [
            "kdca_notifiable_weekly.json",
            "kdca_notifiable_period_region.json",
            "kdca_notifiable_period_basic.json",
            "kdca_notifiable.json",
        ],
    }


if __name__ == "__main__":
    cli_year = int(sys.argv[1]) if len(sys.argv) > 1 else None
    print(json.dumps(main(cli_year), ensure_ascii=False, indent=2))
