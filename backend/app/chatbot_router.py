"""chatbot_router.py — Gemini 기반 대화형 챗봇 API (google-genai SDK)"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/chatbot", tags=["chatbot"])

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PROCESSED_DIR = DATA_DIR / "processed"
SNAPSHOT_DIR = PROCESSED_DIR / "snapshots"
MOCK_DIR = DATA_DIR / "mock"


def _get_gemini_client():
    from google import genai
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY가 설정되지 않았습니다.")
    return genai.Client(api_key=api_key)


def _model_name() -> str:
    return os.getenv("GEMINI_MODEL", "gemini-2.5-flash")


# ── 스키마 ───────────────────────────────────────────────────────────
class ChatMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []
    snapshot_date: str | None = None


class ChatResponse(BaseModel):
    reply: str
    context_used: list[str] = []
    model: str = ""


# ── 데이터 로더 ──────────────────────────────────────────────────────
def _load(path: Path) -> Any:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return []


def _load_snapshot(date_str: str | None = None) -> list[dict]:
    if date_str:
        p = SNAPSHOT_DIR / f"{date_str}.json"
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    snapshots = sorted(SNAPSHOT_DIR.glob("*.json"))
    if snapshots:
        return json.loads(snapshots[-1].read_text(encoding="utf-8"))
    p = MOCK_DIR / "mock_korea_alerts.json"
    return _load(p)


def _load_korea_news() -> list[dict]:
    return _load(PROCESSED_DIR / "korea_news.json")[:20]


def _load_global_signals() -> list[dict]:
    results = []
    for f in ["global_who_don.json", "global_news.json"]:
        p = PROCESSED_DIR / f
        if p.exists():
            results.extend(_load(p)[:8])
    if not results:
        results = _load(MOCK_DIR / "mock_global_signals.json")
    return results


def _load_trends() -> dict:
    out = {}
    for key, fname in [("korea", "google_trends_kr.json"), ("global", "google_trends_global.json")]:
        p = PROCESSED_DIR / fname
        if p.exists():
            out[key] = json.loads(p.read_text(encoding="utf-8"))
    return out


# ── 시스템 프롬프트 ───────────────────────────────────────────────────
SYSTEM_BASE = """당신은 Sentinel Korea의 AI 어시스턴트입니다.
Sentinel Korea는 대한민국 17개 시도의 호흡기 감염병 조기 경보 대시보드입니다.
복합 경보 점수(0~1)를 기반으로 G0~G3 네 단계 경보 레벨을 제공합니다.

경보 레벨:
- G3 (Critical, 빨강): 점수 ≥ 0.75 — 즉각 대응 필요
- G2 (Elevated, 주황): 점수 ≥ 0.50 — 강화 모니터링
- G1 (Guarded, 노랑): 점수 ≥ 0.25 — 주의
- G0 (Low, 초록): 점수 < 0.25 — 정상

신호 소스: Notifiable Disease (KDCA API)(notifiable_disease), ILI/SARI 감시(influenza_like), 하수 병원체(wastewater_pathogen)

항상 한국어로 답변하세요. 의학적 진단은 하지 않으며, 역학·감시 데이터 해석에 집중하세요."""


def _dashboard_ctx(snapshot: list[dict]) -> str:
    if not snapshot:
        return ""
    level_map: dict[str, list[str]] = {"G3": [], "G2": [], "G1": [], "G0": []}
    snap_date = snapshot[0].get("date", "")
    for r in snapshot:
        lvl = r.get("level", "G0")
        name = r.get("region_name_kr") or r.get("region_name_en", "")
        score = round(r.get("score", 0), 2)
        level_map.setdefault(lvl, []).append(f"{name}({score})")
    lines = [f"[Dashboard] 현황 ({snap_date}):"]
    for lvl in ["G3", "G2", "G1", "G0"]:
        regions = level_map.get(lvl, [])
        lines.append(f"  [{lvl}]: {', '.join(regions) if regions else '없음'}")
    return "\n".join(lines)


def _news_ctx(korea: list[dict], global_: list[dict]) -> str:
    lines = ["[Korea News]:"]
    for n in korea[:6]:
        lines.append(f"  [{n.get('date','')}] {n.get('title','')}")
    lines.append("[Global News]:")
    for n in global_[:4]:
        lines.append(f"  [{n.get('date','')}] {n.get('title','')}")
    return "\n".join(lines)


def _trends_ctx(trends: dict) -> str:
    lines = ["[Google Trends]:"]
    for s in (trends.get("korea", {}).get("series") or [])[:3]:
        pts = s.get("points", [])
        if pts:
            lines.append(f"  '{s.get('keyword','')}'={pts[-1].get('value',0)}/100 ({pts[-1].get('date','')})")
    return "\n".join(lines)


# ── 챗봇 엔드포인트 ──────────────────────────────────────────────────
@router.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> dict[str, Any]:
    """사용자 메시지에 대화형으로 응답합니다."""
    client = _get_gemini_client()
    model = _model_name()

    # 컨텍스트 구성
    ctx_parts = [SYSTEM_BASE]
    ctx_used = []

    snapshot = _load_snapshot(req.snapshot_date)
    if snapshot:
        ctx_parts.append(_dashboard_ctx(snapshot))
        ctx_used.append("dashboard")

    korea_news = _load_korea_news()
    global_signals = _load_global_signals()
    if korea_news or global_signals:
        ctx_parts.append(_news_ctx(korea_news, global_signals))
        ctx_used.append("news")

    trends = _load_trends()
    if trends:
        ctx_parts.append(_trends_ctx(trends))
        ctx_used.append("trends")

    # 대화 이력
    history_lines = ""
    for msg in req.history[-8:]:
        role_label = "사용자" if msg.role == "user" else "어시스턴트"
        history_lines += f"{role_label}: {msg.content}\n"

    prompt = "\n\n".join(ctx_parts)
    if history_lines:
        prompt += f"\n\n대화 이력:\n{history_lines}"
    prompt += f"\n사용자: {req.message}\n어시스턴트:"

    try:
        response = client.models.generate_content(model=model, contents=prompt)
        reply = response.text.strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini API 오류: {str(e)}")

    return {"reply": reply, "context_used": ctx_used, "model": model}


@router.post("/summarize-news", response_model=ChatResponse)
async def summarize_news() -> dict[str, Any]:
    """최근 뉴스를 AI가 요약합니다."""
    client = _get_gemini_client()
    model = _model_name()

    korea_news = _load_korea_news()
    global_signals = _load_global_signals()

    news_text = "## 한국 뉴스\n"
    for n in korea_news[:10]:
        news_text += f"- [{n.get('date','')}] {n.get('title','')} ({n.get('publisher','')})\n"
        if n.get("snippet"):
            news_text += f"  → {n['snippet'][:120]}\n"

    news_text += "\n## 글로벌 뉴스\n"
    for n in global_signals[:8]:
        news_text += f"- [{n.get('date','')}] {n.get('title','')} ({n.get('source',n.get('publisher',''))})\n"

    prompt = f"""{SYSTEM_BASE}

아래 뉴스들을 역학적 관점에서 핵심 위주로 3~5줄 요약해주세요.
특히 한국에 영향을 줄 수 있는 내용을 강조해주세요.

{news_text}

요약:"""

    try:
        response = client.models.generate_content(model=model, contents=prompt)
        reply = response.text.strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini API 오류: {str(e)}")

    return {"reply": reply, "context_used": ["news"], "model": model}


@router.post("/interpret-dashboard", response_model=ChatResponse)
async def interpret_dashboard(snapshot_date: str | None = None) -> dict[str, Any]:
    """현재 대시보드 상태를 AI가 해석합니다."""
    client = _get_gemini_client()
    model = _model_name()

    snapshot = _load_snapshot(snapshot_date)
    if not snapshot:
        raise HTTPException(status_code=404, detail="스냅샷 데이터 없음")

    trends = _load_trends()
    prompt = f"""{SYSTEM_BASE}

{_dashboard_ctx(snapshot)}

{_trends_ctx(trends) if trends else ''}

위 데이터를 바탕으로:
1. 현재 전국 호흡기 감시 상황 요약
2. 주목할 지역과 이유
3. 추세 경고 신호
4. 보건당국 권고사항 2~3가지

분석:"""

    try:
        response = client.models.generate_content(model=model, contents=prompt)
        reply = response.text.strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini API 오류: {str(e)}")

    return {"reply": reply, "context_used": ["dashboard", "trends"], "model": model}
