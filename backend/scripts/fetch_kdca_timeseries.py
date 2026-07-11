"""Fetch multi-year weekly KDCA notifiable-disease counts for aberration detection.

The regular ``fetch_kdca_api.py`` pipeline only pulls the *current* year of the
KDCA EIDAPIService/PeriodRegion endpoint, which is enough for the live digest but
far too short for Farrington Flexible: that algorithm builds its baseline from the
*same weeks in previous years*, so it needs several full years of weekly history.

This script reuses the exact same endpoint and row parser as ``fetch_kdca_api.py``
and simply loops over a range of years, then reshapes the rows into a per-disease
weekly time series that ``app/farrington.py`` can consume directly.

IMPORTANT — scope of what is real here:
  * These are REAL KDCA counts (data.go.kr, verified against the live API).
  * They are NATIONAL weekly totals per disease. The endpoint's "region" axis is
    domestic vs. imported (dmstcVal / outnatnVal), NOT the 17 sido provinces.
    KDCA does not expose weekly per-sido counts, so no regional series is built.

Usage:
    python -m scripts.fetch_kdca_timeseries            # 2016..current year
    python -m scripts.fetch_kdca_timeseries 2018 2026  # explicit range
"""

from __future__ import annotations

import json
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

# Reuse the audited endpoint + parsing primitives so this stays in lock-step with
# the production KDCA fetcher (same API key, same period parsing, same classifier).
from fetch_kdca_api import (  # type: ignore
    PERIOD_REGION_ENDPOINT,
    PROCESSED_DIR,
    _classify_disease,
    _parse_period,
    _parse_value,
    fetch_period_endpoint,
)

DEFAULT_START_YEAR = 2016
OUTPUT_PATH = PROCESSED_DIR / "kdca_notifiable_timeseries.json"


def _build_series(records_by_year: dict[int, list[dict[str, Any]]]) -> dict[str, Any]:
    """Reshape raw PeriodRegion rows into ``{disease: {..., series: [...]}}``.

    Rows are summed per (disease, epiweek) so that any duplicate/aggregate rows
    the API may return collapse into a single national weekly count.
    """
    # disease -> epiweek -> aggregated counts
    agg: dict[str, dict[str, dict[str, Any]]] = defaultdict(lambda: defaultdict(lambda: {
        "total": 0.0,
        "domestic": 0.0,
        "imported": 0.0,
    }))
    disease_meta: dict[str, dict[str, Any]] = {}

    for year, items in sorted(records_by_year.items()):
        for item in items:
            disease = (item.get("icdNm") or "").strip()
            if not disease:
                continue
            parsed_year, week, epiweek = _parse_period(item.get("period", ""))
            if not epiweek:
                # Skip "계" (annual total) and non-weekly summary rows.
                continue
            classification = _classify_disease(disease)
            disease_meta.setdefault(disease, {
                "category": classification["category"],
                "is_respiratory_related": classification["is_respiratory_related"],
                "is_respiratory_virus": classification["is_respiratory_virus"],
                "icd_group": item.get("icdGroupNm"),
            })
            bucket = agg[disease][epiweek]
            bucket["total"] += _parse_value(item.get("resultVal")) or 0.0
            bucket["domestic"] += _parse_value(item.get("dmstcVal")) or 0.0
            bucket["imported"] += _parse_value(item.get("outnatnVal")) or 0.0
            bucket["year"] = parsed_year
            bucket["week"] = week

    diseases: dict[str, Any] = {}
    for disease, weeks in agg.items():
        series = []
        for epiweek, bucket in weeks.items():
            series.append({
                "epiweek": epiweek,
                "year": bucket["year"],
                "week": bucket["week"],
                "total": round(bucket["total"], 4),
                "domestic": round(bucket["domestic"], 4),
                "imported": round(bucket["imported"], 4),
            })
        # Chronological order is required by Farrington's baseline windowing.
        series.sort(key=lambda r: (r["year"], r["week"]))
        meta = disease_meta[disease]
        diseases[disease] = {
            "category": meta["category"],
            "icd_group": meta["icd_group"],
            "is_respiratory_related": meta["is_respiratory_related"],
            "is_respiratory_virus": meta["is_respiratory_virus"],
            "weeks": len(series),
            "series": series,
        }
    return diseases


def fetch_timeseries(start_year: int, end_year: int) -> dict[str, Any]:
    records_by_year: dict[int, list[dict[str, Any]]] = {}
    for year in range(start_year, end_year + 1):
        try:
            items = fetch_period_endpoint(PERIOD_REGION_ENDPOINT, year)
        except Exception as exc:  # pragma: no cover - network dependent
            print(f"  [warn] {year}: {exc}", file=sys.stderr)
            continue
        records_by_year[year] = items
        print(f"  {year}: {len(items)} rows")
        time.sleep(0.2)

    diseases = _build_series(records_by_year)
    fetched_years = sorted(records_by_year.keys())
    respiratory = {d: v for d, v in diseases.items() if v["is_respiratory_related"]}

    return {
        "status": "ok" if diseases else "empty",
        "source": "KDCA EIDAPIService/PeriodRegion",
        "scope": (
            "national weekly notifiable disease counts, multi-year history for "
            "Farrington Flexible baselines. National totals only; the endpoint's "
            "region axis is domestic/imported, NOT the 17 sido provinces."
        ),
        "is_synthetic": False,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "year_start": fetched_years[0] if fetched_years else start_year,
        "year_end": fetched_years[-1] if fetched_years else end_year,
        "fetched_years": fetched_years,
        "disease_count": len(diseases),
        "respiratory_disease_count": len(respiratory),
        "diseases": diseases,
    }


def main(start_year: int | None = None, end_year: int | None = None) -> dict[str, Any]:
    start = int(start_year or DEFAULT_START_YEAR)
    end = int(end_year or date.today().year)
    print(f"Fetching KDCA weekly notifiable time series {start}..{end}")
    payload = fetch_timeseries(start, end)
    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"Wrote {OUTPUT_PATH.name}: {payload['disease_count']} diseases "
        f"({payload['respiratory_disease_count']} respiratory), "
        f"years {payload['year_start']}..{payload['year_end']}"
    )
    return payload


if __name__ == "__main__":
    args = sys.argv[1:]
    sy = int(args[0]) if len(args) >= 1 else None
    ey = int(args[1]) if len(args) >= 2 else None
    main(sy, ey)
