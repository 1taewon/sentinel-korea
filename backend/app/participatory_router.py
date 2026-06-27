"""participatory_router.py — lightweight anonymous participatory symptom reporting.

Casual visitors can optionally self-report respiratory symptoms via a dismissible
widget. Stored ANONYMOUSLY (no PII, no IP) and aggregated by ISO epiweek so the
weekly symptomatic RATE can be tracked over time. This is a community/best-effort
signal — self-selected, so it is reported as a rate with clear caveats, never as
a hard case count.
"""
from __future__ import annotations

import json
from datetime import date as date_cls
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter(prefix="/participatory", tags=["participatory"])

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
REPORTS_FILE = PROCESSED_DIR / "participatory_reports.json"
KST = timezone(timedelta(hours=9))

# Allowed symptom keys — anything else is dropped (defensive sanitization).
VALID_SYMPTOMS = {"fever", "cough", "sore_throat", "runny_nose", "body_ache", "none"}
# 17 시/도 short names — anything else is dropped.
VALID_REGIONS = {
    "서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기",
    "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주",
}
MAX_STORED = 5000  # keep the file bounded


class SymptomReport(BaseModel):
    symptoms: list[str] = Field(default_factory=list)
    region: str | None = None


def _load() -> list[dict[str, Any]]:
    if REPORTS_FILE.exists():
        try:
            return json.loads(REPORTS_FILE.read_text(encoding="utf-8"))
        except Exception:
            return []
    return []


def _epiweek(d: date_cls) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


@router.post("/report")
async def submit_report(report: SymptomReport) -> dict[str, Any]:
    """Anonymous symptom self-report. No PII / IP is stored."""
    syms = [s for s in dict.fromkeys(report.symptoms) if s in VALID_SYMPTOMS][:6]
    if not syms:
        return {"status": "ignored", "reason": "no valid symptom selection"}
    region = report.region if report.region in VALID_REGIONS else None

    now = datetime.now(KST)
    entry = {
        "ts": now.isoformat(),
        "epiweek": _epiweek(now.date()),
        "region": region,
        "symptoms": syms,
    }
    data = _load()
    data.append(entry)
    if len(data) > MAX_STORED:
        data = data[-MAX_STORED:]
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"status": "ok", "message": "감사합니다. 익명으로 집계되었습니다."}


@router.get("/summary")
async def summary() -> dict[str, Any]:
    """Aggregate (rate-based) view of this week's self-reports."""
    data = _load()
    now = datetime.now(KST)
    cw = _epiweek(now.date())
    this_week = [r for r in data if r.get("epiweek") == cw]

    symptom_counts: dict[str, int] = {}
    region_counts: dict[str, int] = {}
    symptomatic = 0
    for r in this_week:
        syms = r.get("symptoms", [])
        if any(s != "none" for s in syms):
            symptomatic += 1
        for s in syms:
            symptom_counts[s] = symptom_counts.get(s, 0) + 1
        reg = r.get("region")
        if reg:
            region_counts[reg] = region_counts.get(reg, 0) + 1

    total = len(this_week)
    return {
        "epiweek": cw,
        "total_reports": total,
        "symptomatic": symptomatic,
        # RATE, not count — self-selected sample, denominator-aware.
        "symptomatic_rate": round(symptomatic / total, 3) if total else 0.0,
        "symptom_counts": symptom_counts,
        "region_counts": region_counts,
        "all_time_total": len(data),
        "note": "self-selected community signal; interpret as rate trend, not case counts",
    }
