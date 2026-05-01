"""news_router.py — 뉴스 + 트렌드 엔드포인트"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter

router = APIRouter(tags=["news"])

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PROCESSED_DIR = DATA_DIR / "processed"
MOCK_DIR = DATA_DIR / "mock"


def _load(path: Path) -> Any:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return []


@router.get("/signals/global")
async def signals_global() -> list[dict]:
    results = []
    for fname in ["global_who_don.json", "global_news.json", "global_kdca_outbreaks.json"]:
        p = PROCESSED_DIR / fname
        if p.exists():
            results.extend(_load(p))
    return results or _load(MOCK_DIR / "mock_global_signals.json")


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
async def news_global(limit: int = 30) -> list[dict]:
    # WHO DON 먼저, 그 다음 글로벌 뉴스 — 날짜 내림차순 정렬
    who_don = _load(PROCESSED_DIR / "global_who_don.json")
    global_news = _load(PROCESSED_DIR / "global_news.json")
    kdca_outbreaks = _load(PROCESSED_DIR / "global_kdca_outbreaks.json")
    results = who_don + global_news + kdca_outbreaks
    results.sort(key=lambda x: x.get("date", ""), reverse=True)
    return results[:limit]
