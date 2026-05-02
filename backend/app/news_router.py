"""news_router.py — 뉴스 + 트렌드 엔드포인트"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter

router = APIRouter(tags=["news"])

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PROCESSED_DIR = DATA_DIR / "processed"
ARCHIVE_DIR = PROCESSED_DIR / "global_outbreak_archive"
MOCK_DIR = DATA_DIR / "mock"

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _load(path: Path) -> Any:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return []


def _resolve_source_dir(archive_date: str | None) -> Path:
    """Choose the directory to load outbreak JSON from — current or an archived snapshot."""
    if not archive_date:
        return PROCESSED_DIR
    if not DATE_RE.match(archive_date):
        return PROCESSED_DIR
    candidate = ARCHIVE_DIR / archive_date
    return candidate if candidate.exists() else PROCESSED_DIR


# Every outbreak source file the frontend should consume in /signals/global and /news/global
GLOBAL_SOURCE_FILES = [
    "global_who_don.json",            # WHO DON (official)
    "global_cdc.json",                # US CDC (HAN + Newsroom — MMWR removed to skip retrospectives)
    "global_ecdc.json",               # ECDC CDTR Weekly (PDF parsed)
    "global_healthmap.json",          # HealthMap curated outbreak alerts
    "global_gemini_outbreak.json",    # Gemini grounded search
    "global_google_outbreak.json",    # Google News broad outbreak (3 months, respiratory + other infectious)
    "global_news.json",               # NewsAPI + Google News (legacy)
    "global_kdca_outbreaks.json",     # KDCA imported outbreak signals
]


@router.get("/signals/global")
async def signals_global(archive_date: str | None = None) -> list[dict]:
    """Return the merged outbreak signal set.

    If `archive_date` is supplied (YYYY-MM-DD) and a snapshot exists for that
    day under `data/processed/global_outbreak_archive/{date}/`, replay that
    historical state instead of the live set.
    """
    source_dir = _resolve_source_dir(archive_date)
    results: list[dict] = []
    for fname in GLOBAL_SOURCE_FILES:
        p = source_dir / fname
        if p.exists():
            results.extend(_load(p))
    # dedupe by id, preserving the highest-priority occurrence (file order above)
    seen: set[str] = set()
    unique: list[dict] = []
    for item in results:
        item_id = item.get("id")
        if item_id and item_id in seen:
            continue
        if item_id:
            seen.add(item_id)
        unique.append(item)
    if unique:
        unique.sort(key=lambda x: x.get("date", ""), reverse=True)
        return unique
    return _load(MOCK_DIR / "mock_global_signals.json")


@router.get("/signals/global/archive-dates")
async def signals_global_archive_dates() -> list[str]:
    """List available archive snapshot dates (YYYY-MM-DD), newest first."""
    if not ARCHIVE_DIR.exists():
        return []
    dates = [p.name for p in ARCHIVE_DIR.iterdir() if p.is_dir() and DATE_RE.match(p.name)]
    return sorted(dates, reverse=True)


@router.get("/news/korea")
async def news_korea(limit: int = 30) -> list[dict]:
    # 네이버 뉴스(한국어) + NewsAPI(영어) 병합, 날짜 내림차순
    naver_path = PROCESSED_DIR / "naver_news_kr.json"
    naver = _load(naver_path)
    english = _load(PROCESSED_DIR / "korea_news.json")
    combined = naver + english
    combined.sort(key=lambda x: x.get("date", ""), reverse=True)
    return combined[:limit]


@router.get("/news/global")
async def news_global(limit: int = 60, archive_date: str | None = None) -> list[dict]:
    """Aggregate all outbreak sources (WHO DON + 5 agency feeds + Gemini + NewsAPI/Google).

    Sort by:
      1) is_respiratory == True first
      2) severity high > medium > low
      3) date descending

    If `archive_date` is supplied and an archived snapshot exists, replay
    that historical state (Phase 3-A).
    """
    severity_rank = {"high": 0, "medium": 1, "low": 2}
    source_dir = _resolve_source_dir(archive_date)

    results: list[dict] = []
    for fname in GLOBAL_SOURCE_FILES:
        p = source_dir / fname
        if p.exists():
            results.extend(_load(p))

    # dedupe
    seen: set[str] = set()
    unique: list[dict] = []
    for item in results:
        item_id = item.get("id")
        if item_id and item_id in seen:
            continue
        if item_id:
            seen.add(item_id)
        unique.append(item)

    unique.sort(
        key=lambda x: (
            0 if x.get("is_respiratory") else 1,
            severity_rank.get(x.get("severity", ""), 3),
            -1 * (int(x.get("date", "0000-00-00").replace("-", "")) if x.get("date") else 0),
        )
    )
    return unique[:limit]
