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

# Exact respiratory-related allow-list. This avoids treating every notifiable
# disease as a Sentinel respiratory signal while still preserving all raw rows
# in a separate "all notifiable" artifact.
RESPIRATORY_NOTIFIABLE_DISEASES: dict[str, dict[str, Any]] = {
    "중증급성호흡기증후군(SARS)": {"category": "emerging_respiratory_virus", "weight": 1.0, "is_respiratory_virus": True},
    "중동호흡기증후군(MERS)": {"category": "emerging_respiratory_virus", "weight": 1.0, "is_respiratory_virus": True},
    "동물인플루엔자 인체감염증": {"category": "zoonotic_influenza", "weight": 1.0, "is_respiratory_virus": True},
    "신종인플루엔자": {"category": "novel_influenza", "weight": 1.0, "is_respiratory_virus": True},
    "인플루엔자": {"category": "seasonal_influenza", "weight": 0.8, "is_respiratory_virus": True},
    "코로나바이러스감염증-19": {"category": "covid19", "weight": 0.85, "is_respiratory_virus": True},
    "홍역": {"category": "airborne_viral", "weight": 0.45, "is_respiratory_virus": True},
    "디프테리아": {"category": "respiratory_notifiable", "weight": 0.55, "is_respiratory_virus": False},
    "백일해": {"category": "respiratory_notifiable", "weight": 0.75, "is_respiratory_virus": False},
    "b형헤모필루스인플루엔자": {"category": "respiratory_bacterial", "weight": 0.45, "is_respiratory_virus": False},
    "폐렴구균 감염증": {"category": "respiratory_bacterial", "weight": 0.65, "is_respiratory_virus": False},
    "레지오넬라증": {"category": "respiratory_bacterial", "weight": 0.65, "is_respiratory_virus": False},
    "성홍열": {"category": "respiratory_related", "weight": 0.35, "is_respiratory_virus": False},
    "급성호흡기감염증": {"category": "respiratory_syndrome", "weight": 0.7, "is_respiratory_virus": False},
}

NOTIFIABLE_DEFINITION = (
    "법정감염병은 감염병의 예방 및 관리에 관한 법률에 따라 신고·감시 대상이 되는 감염병입니다. "
    "Sentinel은 KDCA EIDAPI PeriodRegion의 weekly resultVal, dmstcVal, outnatnVal을 원자료로 보관하고, "
    "그중 호흡기 관련 질환과 호흡기/공기전파 바이러스 질환을 별도 subset으로 파싱합니다."
)


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


def _classify_disease(disease: str) -> dict[str, Any]:
    meta = RESPIRATORY_NOTIFIABLE_DISEASES.get(disease)
    if not meta:
        return {
            "category": "other_notifiable",
            "weight": 0.0,
            "is_respiratory_related": False,
            "is_respiratory_virus": False,
        }
    return {
        "category": meta["category"],
        "weight": meta["weight"],
        "is_respiratory_related": True,
        "is_respiratory_virus": bool(meta.get("is_respiratory_virus")),
    }


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


def _normalize_period_region(items: list[dict[str, Any]], respiratory_only: bool = False) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    updated_at = datetime.now(timezone.utc).isoformat()
    for item in items:
        disease = item.get("icdNm") or ""
        classification = _classify_disease(disease)
        if respiratory_only and not classification["is_respiratory_related"]:
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
                "category": classification["category"],
                "weight": classification["weight"],
                "is_respiratory_related": classification["is_respiratory_related"],
                "is_respiratory_virus": classification["is_respiratory_virus"],
                "raw_value": total,
                "domestic_value": domestic,
                "imported_value": imported,
                "unit": "weekly reported cases",
                "updated_at": updated_at,
            }
        )
    return records


def _normalize_period_basic(items: list[dict[str, Any]], respiratory_only: bool = False) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    updated_at = datetime.now(timezone.utc).isoformat()
    for item in items:
        disease = item.get("icdNm") or ""
        classification = _classify_disease(disease)
        if respiratory_only and not classification["is_respiratory_related"]:
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
                "category": classification["category"],
                "is_respiratory_related": classification["is_respiratory_related"],
                "is_respiratory_virus": classification["is_respiratory_virus"],
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
                    "category": record.get("category"),
                    "is_respiratory_virus": record.get("is_respiratory_virus", False),
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
        row["diseases"] = sorted(row["diseases"], key=lambda disease: disease["total"], reverse=True)

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


def save_outputs(
    year: int,
    all_period_region_records: list[dict[str, Any]],
    respiratory_period_region_records: list[dict[str, Any]],
    all_period_basic_records: list[dict[str, Any]],
    respiratory_period_basic_records: list[dict[str, Any]],
) -> dict[str, Any]:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    all_summary = summarize_period_region(all_period_region_records)
    respiratory_summary = summarize_period_region(respiratory_period_region_records)
    respiratory_virus_records = [
        record for record in respiratory_period_region_records
        if record.get("is_respiratory_virus")
    ]
    respiratory_virus_summary = summarize_period_region(respiratory_virus_records)
    validation = validate_against_period_basic(respiratory_period_region_records, respiratory_period_basic_records)

    payload = {
        "status": "ok",
        "year": year,
        "primary_source": "KDCA EIDAPIService/PeriodRegion",
        "fallback_source": "KDCA EIDAPIService/PeriodBasic",
        "scope": "national weekly notifiable respiratory subset; PeriodRegion separates domestic/imported counts, not 17 sido regions",
        "definition": NOTIFIABLE_DEFINITION,
        "respiratory_diseases": sorted(RESPIRATORY_NOTIFIABLE_DISEASES),
        "respiratory_virus_diseases": sorted(
            disease for disease, meta in RESPIRATORY_NOTIFIABLE_DISEASES.items()
            if meta.get("is_respiratory_virus")
        ),
        "summary": respiratory_summary,
        "respiratory_virus_summary": respiratory_virus_summary,
        "all_notifiable_summary": all_summary,
        "validation": validation,
        "records": respiratory_period_region_records,
    }
    basic_payload = {
        "status": "ok",
        "year": year,
        "source": "KDCA EIDAPIService/PeriodBasic",
        "definition": NOTIFIABLE_DEFINITION,
        "records": respiratory_period_basic_records,
    }
    all_payload = {
        "status": "ok",
        "year": year,
        "source": "KDCA EIDAPIService/PeriodRegion",
        "definition": NOTIFIABLE_DEFINITION,
        "scope": "all national weekly notifiable disease rows; not 17 sido regions",
        "summary": all_summary,
        "respiratory_summary": respiratory_summary,
        "respiratory_virus_summary": respiratory_virus_summary,
        "validation": validation,
        "records": all_period_region_records,
    }
    _ = all_period_basic_records

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
    (PROCESSED_DIR / "kdca_notifiable_all_period_region.json").write_text(
        json.dumps(all_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (PROCESSED_DIR / "kdca_notifiable_respiratory_virus_weekly.json").write_text(
        json.dumps(
            {
                "status": "ok",
                "year": year,
                "source": "KDCA EIDAPIService/PeriodRegion",
                "definition": NOTIFIABLE_DEFINITION,
                "summary": respiratory_virus_summary,
                "records": respiratory_virus_records,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    # Compatibility summary for older code paths that look for kdca_notifiable.json.
    compatibility = {
        "status": "ok",
        "source": payload["primary_source"],
        "year": year,
        "latest_epiweek": respiratory_summary.get("latest_epiweek"),
        "latest_period": respiratory_summary.get("latest_period"),
        "latest_normalized_score": respiratory_summary.get("latest_normalized_score", 0.0),
        "record_count": respiratory_summary.get("record_count", 0),
        "all_notifiable_record_count": all_summary.get("record_count", 0),
        "respiratory_virus_record_count": respiratory_virus_summary.get("record_count", 0),
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
    all_region_records = _normalize_period_region(region_items, respiratory_only=False)
    respiratory_region_records = _normalize_period_region(region_items, respiratory_only=True)
    all_basic_records = _normalize_period_basic(basic_items, respiratory_only=False)
    respiratory_basic_records = _normalize_period_basic(basic_items, respiratory_only=True)

    if not all_region_records:
        raise RuntimeError("KDCA PeriodRegion returned no weekly notifiable records.")
    if not respiratory_region_records:
        raise RuntimeError("KDCA PeriodRegion returned no respiratory notifiable records.")

    payload = save_outputs(
        target_year,
        all_region_records,
        respiratory_region_records,
        all_basic_records,
        respiratory_basic_records,
    )
    summary = payload["summary"]
    print(
        f"Saved KDCA PeriodRegion weekly respiratory data: {summary['record_count']} records, "
        f"latest={summary.get('latest_epiweek')}, score={summary.get('latest_normalized_score')}"
    )
    print(
        f"Saved all notifiable data: {payload['all_notifiable_summary']['record_count']} records; "
        f"respiratory-virus subset={payload['respiratory_virus_summary']['record_count']} records."
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
        "all_notifiable_record_count": payload["all_notifiable_summary"]["record_count"],
        "respiratory_virus_record_count": payload["respiratory_virus_summary"]["record_count"],
        "latest_epiweek": summary.get("latest_epiweek"),
        "latest_period": summary.get("latest_period"),
        "latest_normalized_score": summary.get("latest_normalized_score"),
        "validation": validation,
        "files": [
            "kdca_notifiable_weekly.json",
            "kdca_notifiable_period_region.json",
            "kdca_notifiable_period_basic.json",
            "kdca_notifiable_all_period_region.json",
            "kdca_notifiable_respiratory_virus_weekly.json",
            "kdca_notifiable.json",
        ],
    }


if __name__ == "__main__":
    cli_year = int(sys.argv[1]) if len(sys.argv) > 1 else None
    print(json.dumps(main(cli_year), ensure_ascii=False, indent=2))
