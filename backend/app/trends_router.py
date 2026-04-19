"""trends_router.py — Google Trends 엔드포인트"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter

router = APIRouter(prefix="/trends", tags=["trends"])

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"


def _load(path: Path):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


@router.get("/korea")
async def trends_korea() -> dict:
    return _load(PROCESSED_DIR / "google_trends_kr.json")


@router.get("/global")
async def trends_global() -> dict:
    return _load(PROCESSED_DIR / "google_trends_global.json")


@router.get("/naver")
async def trends_naver() -> dict:
    return _load(PROCESSED_DIR / "naver_trends_kr.json")
