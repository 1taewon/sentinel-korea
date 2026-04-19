"""risk_analysis_router.py — 2-stage Gemini AI risk analysis pipeline

Stage 1: POST /analyze-news-trends — News+Trends only → news_trends_risk
Stage 2: POST /analyze           — Full (News+Trends+KDCA) → total_risk
"""
from __future__ import annotations

import json
import os
from datetime import datetime, date
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/risk-analysis", tags=["risk-analysis"])

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PROCESSED_DIR = DATA_DIR / "processed"
SNAPSHOT_DIR = PROCESSED_DIR / "snapshots"
MOCK_DIR = DATA_DIR / "mock"

REGION_CODES = {
    "11": "Seoul", "26": "Busan", "27": "Daegu", "28": "Incheon",
    "29": "Gwangju", "30": "Daejeon", "31": "Ulsan", "36": "Sejong",
    "41": "Gyeonggi", "42": "Gangwon", "43": "Chungbuk", "44": "Chungnam",
    "45": "Jeonbuk", "46": "Jeonnam", "47": "Gyeongbuk", "48": "Gyeongnam",
    "50": "Jeju",
}

REGION_KR = {
    "11": "서울", "26": "부산", "27": "대구", "28": "인천",
    "29": "광주", "30": "대전", "31": "울산", "36": "세종",
    "41": "경기", "42": "강원", "43": "충북", "44": "충남",
    "45": "전북", "46": "전남", "47": "경북", "48": "경남",
    "50": "제주",
}

# ── Prompt templates ─────────────────────────────────────────────────

NEWS_DIGEST_PROMPT = """아래는 최근 수집된 한국 및 글로벌 호흡기 감염병 관련 **뉴스** 데이터입니다.

뉴스만 분석하여 아래 JSON 형식으로 요약 보고서를 작성하세요:
{{
  "korea_summary": "한국 호흡기 감염병 뉴스 현황 요약 (한국어, 5~8줄)",
  "global_summary": "글로벌 호흡기 감염병 뉴스 현황 요약 (한국어, 3~5줄)",
  "risk_assessment": "뉴스 기반 위험 평가 (한국어, 2~3줄)",
  "key_alerts": [
    {{"title": "핵심 경고 제목", "detail": "상세 설명", "severity": "high/medium/low"}},
    ...최대 5개
  ],
  "source_count": {{"naver_news": 0, "english_news": 0, "global_news": 0, "who_don": 0}},
  "generated_at": "생성 시각"
}}

분석 시 주의사항:
- 네이버 뉴스(한국어)를 가장 중요한 소스로 취급
- 시장조사/학술 논문은 무시하고 실제 감염병 동향만 분석
- 최근 1주일 뉴스에 더 높은 가중치 부여
- 반드시 JSON만 반환하세요
"""

TRENDS_DIGEST_PROMPT = """아래는 최근 수집된 한국의 검색 트렌드 데이터입니다 (Google Trends + 네이버 Trends).

트렌드만 분석하여 아래 JSON 형식으로 요약 보고서를 작성하세요:
{{
  "trends_insight": "검색 트렌드 종합 분석 (한국어, 5~8줄, Google+Naver 비교 포함)",
  "rising_keywords": ["급상승 키워드 목록"],
  "risk_assessment": "트렌드 기반 위험 평가 (한국어, 2~3줄)",
  "key_signals": [
    {{"keyword": "키워드", "trend": "상승/하락/안정", "insight": "의미 해석"}},
    ...최대 5개
  ]
}}

분석 시 주의사항:
- 네이버 Trends는 한국인의 실제 검색량을 반영하므로 높은 가중치
- Google Trends는 영어권/글로벌 관점에서의 한국 관련 관심도
- 급상승 키워드는 유행 초기 신호일 수 있음
- 반드시 JSON만 반환하세요
"""

KDCA_DIGEST_PROMPT = """아래는 KDCA(질병관리청) 공식 감시 데이터입니다 (법정감염병 신고, ILI/SARI 감시, 하수 병원체 감시).

KDCA 데이터만 분석하여 아래 JSON 형식으로 요약 보고서를 작성하세요:
{{
  "kdca_summary": "KDCA 감시 데이터 종합 분석 (한국어, 5~8줄, 주요 변동 포함)",
  "regional_highlights": [
    {{"region": "지역명", "finding": "주요 발견사항", "severity": "high/medium/low"}},
    ...최대 5개
  ],
  "risk_assessment": "KDCA 데이터 기반 위험 평가 (한국어, 2~3줄)",
  "key_indicators": [
    {{"indicator": "지표명", "trend": "상승/하락/안정", "detail": "상세 설명"}},
    ...최대 5개
  ]
}}

분석 시 주의사항:
- ILI(인플루엔자 유사 질환) 발생률 변화에 주의
- 하수감시 데이터는 지역사회 감염 조기 지표로 중요
- 시도별 차이를 분석하여 지역별 위험도 차이를 파악
- 전주 대비 증감 추세에 주목
- 반드시 JSON만 반환하세요
"""

NEWS_TRENDS_PROMPT = """아래 한국의 뉴스(한국어+영어), Google Trends, 네이버 Trends 데이터를 분석해서 각 지역의 호흡기 감염병 위험도를 평가해줘.

분석 결과를 아래 JSON 형식으로 반환해줘:
{{
  "summary": "전체 상황 요약 (한국어, 3~5줄)",
  "regions": {{
    "Seoul": {{"score": 0.0~1.0, "level": "G0~G3", "reason": "근거"}},
    "Busan": {{"score": 0.0~1.0, "level": "G0~G3", "reason": "근거"}},
    ...17개 시도 전부
  }},
  "key_signals": ["핵심 신호 1", "핵심 신호 2", ...]
}}

점수 기준:
- G3 (Critical): score >= 0.75 — 뉴스에서 해당 지역 관련 심각한 유행/폭발 보도
- G2 (Elevated): score >= 0.50 — 뉴스에서 증가 추세 보도 + 트렌드 상승
- G1 (Guarded): score >= 0.25 — 약간의 관련 뉴스 또는 트렌드 변동
- G0 (Low): score < 0.25 — 특이사항 없음

참고: 네이버 뉴스(한국어)는 한국 실정을 가장 잘 반영하는 1차 소스이고, 네이버 Trends는 한국인의 실제 검색량을 반영합니다.
반드시 JSON만 반환하세요. 다른 텍스트 없이 JSON만.
"""

FULL_ANALYSIS_PROMPT = """아래 한국의 뉴스(한국어+영어), Google Trends, 네이버 Trends, 그리고 KDCA 공식 감시 데이터를 통합 분석해서 최종 호흡기 감염병 위험도를 평가해줘.

분석 결과를 아래 JSON 형식으로 반환해줘:
{{
  "summary": "전체 상황 통합 요약 (한국어, 5~8줄)",
  "regions": {{
    "Seoul": {{"score": 0.0~1.0, "level": "G0~G3", "reason": "근거 (뉴스+트렌드+KDCA 종합)"}},
    "Busan": {{"score": 0.0~1.0, "level": "G0~G3", "reason": "근거"}},
    ...17개 시도 전부
  }},
  "global_risk_summary": "글로벌 위험 요약 (한국어, 2~3줄)",
  "key_signals": ["핵심 신호 1", "핵심 신호 2", ...]
}}

점수 기준:
- G3 (Critical): score >= 0.75 — KDCA 데이터 + 뉴스에서 해당 지역 심각한 유행
- G2 (Elevated): score >= 0.50 — 복수 신호에서 증가 추세
- G1 (Guarded): score >= 0.25 — 일부 신호에서 약간의 변동
- G0 (Low): score < 0.25 — 특이사항 없음

참고: 네이버 뉴스와 네이버 Trends는 한국 내 실제 상황을 가장 정확히 반영하므로 높은 가중치를 부여하세요.
반드시 JSON만 반환하세요. 다른 텍스트 없이 JSON만.
"""


# ── Helpers ──────────────────────────────────────────────────────────

def _load(path: Path) -> Any:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return []


def _get_client():
    from google import genai
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY not set")
    return genai.Client(api_key=api_key)


def _risk_model() -> str:
    return os.getenv("RISK_ANALYSIS_MODEL", "gemini-2.5-flash")


class AnalysisRequest(BaseModel):
    custom_prompt: str | None = None
    include_kdca: bool = False


class AnalysisResponse(BaseModel):
    status: str
    mode: str = ""
    model: str
    summary: str = ""
    global_risk_summary: str = ""
    key_signals: list[str] = []
    regions: dict = {}
    snapshot_date: str = ""
    analyzed_at: str = ""


def _build_news_trends_context() -> tuple[str, list[str]]:
    """Builds context from news + trends data (including Naver)."""
    ctx_parts = []
    sources_used = []

    # Naver Korea news (한국어 — 1차 소스)
    naver_news = _load(PROCESSED_DIR / "naver_news_kr.json")
    if naver_news:
        lines = ["## 네이버 한국 뉴스 (한국어, 최신)"]
        for n in naver_news[:20]:
            lines.append(f"- [{n.get('date','')}] {n.get('title','')} ({n.get('publisher','')}) severity={n.get('severity','')}")
            if n.get("snippet"):
                lines.append(f"  {n['snippet'][:150]}")
        ctx_parts.append("\n".join(lines))
        sources_used.append("naver_news")

    # Korea news (영어)
    korea_news = _load(PROCESSED_DIR / "korea_news.json")
    if korea_news:
        lines = ["## Korea News (English)"]
        for n in korea_news[:10]:
            lines.append(f"- [{n.get('date','')}] {n.get('title','')} ({n.get('publisher','')}) severity={n.get('severity','')}")
            if n.get("snippet"):
                lines.append(f"  {n['snippet'][:150]}")
        ctx_parts.append("\n".join(lines))
        sources_used.append("korea_news")

    # Global news
    for fname in ["global_news.json", "global_who_don.json"]:
        data = _load(PROCESSED_DIR / fname)
        if data:
            lines = [f"## Global News ({fname})"]
            for n in data[:10]:
                lines.append(f"- [{n.get('date','')}] {n.get('title','')} ({n.get('source', n.get('publisher',''))}) severity={n.get('severity','')}")
            ctx_parts.append("\n".join(lines))
            sources_used.append(fname.replace(".json", ""))

    # Naver Trends (한국어 검색 트렌드)
    naver_trends = _load(PROCESSED_DIR / "naver_trends_kr.json")
    if naver_trends and naver_trends.get("series"):
        lines = ["## 네이버 Trends (한국 검색량)"]
        for s in naver_trends["series"]:
            pts = s.get("points", [])
            if pts:
                latest = pts[-1]
                prev = pts[-4] if len(pts) >= 4 else pts[0]
                diff = latest["value"] - prev["value"]
                trend = "상승" if diff > 5 else "하락" if diff < -5 else "안정"
                lines.append(f"- '{s['keyword']}': {latest['value']}/100 (변화: {'+' if diff >= 0 else ''}{diff}, {trend})")
        ctx_parts.append("\n".join(lines))
        sources_used.append("naver_trends")

    # Google Trends
    for key, fname in [("Korea", "google_trends_kr.json"), ("Global", "google_trends_global.json")]:
        data = _load(PROCESSED_DIR / fname)
        if data and data.get("series"):
            lines = [f"## Google Trends ({key})"]
            for s in data["series"]:
                pts = s.get("points", [])
                if pts:
                    latest = pts[-1]
                    prev = pts[-2] if len(pts) >= 2 else latest
                    diff = latest["value"] - prev["value"]
                    lines.append(f"- '{s['keyword']}': {latest['value']}/100 (change: {'+' if diff >= 0 else ''}{diff})")
            ctx_parts.append("\n".join(lines))
            sources_used.append(f"trends_{key.lower()}")

    return "\n\n".join(ctx_parts), sources_used


def _build_kdca_context() -> tuple[str, list[str]]:
    """Builds context from KDCA data sources."""
    ctx_parts = []
    sources_used = []

    kdca_national = _load(PROCESSED_DIR / "kdca_national_w1_w10.json")
    if kdca_national:
        lines = ["## KDCA National Data"]
        # kdca_national is a dict of date -> entry, convert to list of values for slicing
        data_list = list(kdca_national.values()) if isinstance(kdca_national, dict) else kdca_national
        for entry in data_list[-5:]:
            lines.append(f"- Week {entry.get('week','')}: {json.dumps(entry, ensure_ascii=True)[:200]}")
        ctx_parts.append("\n".join(lines))
        sources_used.append("kdca_national")

    kdca_ww = _load(PROCESSED_DIR / "kdca_wastewater_regional.json")
    if kdca_ww:
        lines = ["## KDCA Wastewater Regional Data"]
        if isinstance(kdca_ww, list):
            for entry in kdca_ww[-5:]:
                lines.append(f"- {json.dumps(entry, ensure_ascii=False)[:200]}")
        elif isinstance(kdca_ww, dict):
            for region, vals in list(kdca_ww.items())[:5]:
                lines.append(f"- {region}: {json.dumps(vals, ensure_ascii=False)[:150]}")
        ctx_parts.append("\n".join(lines))
        sources_used.append("kdca_wastewater")

    return "\n\n".join(ctx_parts), sources_used


def _parse_ai_response(text: str) -> dict:
    """Extract JSON from AI response."""
    import re
    match = re.search(r"```(?:json)?\s*\n?(.*?)```", text, re.DOTALL)
    if match:
        text = match.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}") + 1
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end])
            except json.JSONDecodeError:
                pass
    return {}


def _score_to_level(score: float) -> str:
    if score >= 0.75:
        return "G3"
    elif score >= 0.50:
        return "G2"
    elif score >= 0.25:
        return "G1"
    return "G0"


def _update_snapshot(analysis_result: dict, mode: str = "news_trends") -> str:
    """Merge AI analysis into snapshot.

    mode='news_trends' → saves to news_trends_risk field
    mode='full'        → saves to total_risk field
    """
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    today = date.today().isoformat()

    regions_data = analysis_result.get("regions", {})
    field_name = "news_trends_risk" if mode == "news_trends" else "total_risk"

    # Load existing snapshot
    snapshot_path = SNAPSHOT_DIR / f"{today}.json"
    existing = []
    if snapshot_path.exists():
        existing = json.loads(snapshot_path.read_text(encoding="utf-8"))
    else:
        snapshots = sorted(SNAPSHOT_DIR.glob("*.json"))
        if snapshots:
            existing = json.loads(snapshots[-1].read_text(encoding="utf-8"))

    if existing:
        for region_alert in existing:
            en_name = region_alert.get("region_name_en", "")
            if en_name in regions_data:
                ai_data = regions_data[en_name]
                region_alert[field_name] = {
                    "score": ai_data.get("score", 0),
                    "level": ai_data.get("level", "G0"),
                    "reason": ai_data.get("reason", ""),
                }
            region_alert["date"] = today
    else:
        existing = []
        for code, en_name in REGION_CODES.items():
            ai_data = regions_data.get(en_name, {})
            score = ai_data.get("score", 0)
            existing.append({
                "region_code": code,
                "region_name_en": en_name,
                "region_name_kr": REGION_KR.get(code, en_name),
                "date": today,
                "score": score,
                "level": _score_to_level(score),
                field_name: {
                    "score": score,
                    "level": ai_data.get("level", _score_to_level(score)),
                    "reason": ai_data.get("reason", ""),
                },
            })

    snapshot_path.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
    return today


# ── Endpoints ────────────────────────────────────────────────────────

@router.post("/analyze-news-trends", response_model=AnalysisResponse)
async def run_news_trends_analysis(req: AnalysisRequest | None = None) -> dict[str, Any]:
    """Stage 1: Analyze news + trends data only → news_trends_risk."""
    req = req or AnalysisRequest()
    client = _get_client()
    model = _risk_model()

    data_context, sources = _build_news_trends_context()
    if not data_context:
        raise HTTPException(status_code=404, detail="No news/trends data. Refresh news or trends first.")

    prompt = f"{req.custom_prompt or NEWS_TRENDS_PROMPT}\n\n--- Data ---\n\n{data_context}"

    try:
        response = client.models.generate_content(model=model, contents=prompt)
        raw_text = response.text.strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini API error: {str(e)}")

    parsed = _parse_ai_response(raw_text)
    if not parsed:
        return {
            "status": "partial",
            "mode": "news_trends",
            "model": model,
            "summary": raw_text[:500],
            "key_signals": [],
            "regions": {},
            "snapshot_date": "",
            "analyzed_at": datetime.utcnow().isoformat(),
        }

    snapshot_date = _update_snapshot(parsed, mode="news_trends")

    return {
        "status": "ok",
        "mode": "news_trends",
        "model": model,
        "summary": parsed.get("summary", ""),
        "global_risk_summary": parsed.get("global_risk_summary", ""),
        "key_signals": parsed.get("key_signals", []),
        "regions": parsed.get("regions", {}),
        "snapshot_date": snapshot_date,
        "analyzed_at": datetime.utcnow().isoformat(),
    }


@router.post("/analyze", response_model=AnalysisResponse)
async def run_full_analysis(req: AnalysisRequest | None = None) -> dict[str, Any]:
    """Stage 2: Full integration analysis (News+Trends+KDCA) → total_risk."""
    req = req or AnalysisRequest(include_kdca=True)
    client = _get_client()
    model = _risk_model()

    # Combine news/trends + KDCA
    nt_context, nt_sources = _build_news_trends_context()
    kdca_context, kdca_sources = _build_kdca_context()
    data_context = "\n\n".join(filter(None, [nt_context, kdca_context]))
    sources = nt_sources + kdca_sources

    if not data_context:
        raise HTTPException(status_code=404, detail="No data available. Collect news/trends and upload KDCA data first.")

    prompt = f"{req.custom_prompt or FULL_ANALYSIS_PROMPT}\n\n--- Data ---\n\n{data_context}"

    try:
        response = client.models.generate_content(model=model, contents=prompt)
        raw_text = response.text.strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini API error: {str(e)}")

    parsed = _parse_ai_response(raw_text)
    if not parsed:
        return {
            "status": "partial",
            "mode": "full",
            "model": model,
            "summary": raw_text[:500],
            "key_signals": [],
            "regions": {},
            "snapshot_date": "",
            "analyzed_at": datetime.utcnow().isoformat(),
        }

    snapshot_date = _update_snapshot(parsed, mode="full")

    return {
        "status": "ok",
        "mode": "full",
        "model": model,
        "summary": parsed.get("summary", ""),
        "global_risk_summary": parsed.get("global_risk_summary", ""),
        "key_signals": parsed.get("key_signals", []),
        "regions": parsed.get("regions", {}),
        "snapshot_date": snapshot_date,
        "analyzed_at": datetime.utcnow().isoformat(),
    }


def _build_news_only_context() -> tuple[str, list[str]]:
    """Builds context from NEWS only (no trends)."""
    ctx_parts = []
    sources_used = []

    naver_news = _load(PROCESSED_DIR / "naver_news_kr.json")
    if naver_news:
        lines = ["## 네이버 한국 뉴스 (한국어, 최신)"]
        for n in naver_news[:25]:
            lines.append(f"- [{n.get('date','')}] {n.get('title','')} ({n.get('publisher','')}) severity={n.get('severity','')}")
            if n.get("snippet"):
                lines.append(f"  {n['snippet'][:150]}")
        ctx_parts.append("\n".join(lines))
        sources_used.append("naver_news")

    korea_news = _load(PROCESSED_DIR / "korea_news.json")
    if korea_news:
        lines = ["## Korea News (English)"]
        for n in korea_news[:10]:
            lines.append(f"- [{n.get('date','')}] {n.get('title','')} ({n.get('publisher','')}) severity={n.get('severity','')}")
        ctx_parts.append("\n".join(lines))
        sources_used.append("korea_news")

    for fname in ["global_news.json", "global_who_don.json"]:
        data = _load(PROCESSED_DIR / fname)
        if data:
            lines = [f"## Global News ({fname})"]
            for n in data[:10]:
                lines.append(f"- [{n.get('date','')}] {n.get('title','')} ({n.get('source', n.get('publisher',''))}) severity={n.get('severity','')}")
            ctx_parts.append("\n".join(lines))
            sources_used.append(fname.replace(".json", ""))

    return "\n\n".join(ctx_parts), sources_used


def _build_trends_only_context() -> tuple[str, list[str]]:
    """Builds context from TRENDS only (no news)."""
    ctx_parts = []
    sources_used = []

    naver_trends = _load(PROCESSED_DIR / "naver_trends_kr.json")
    if naver_trends and naver_trends.get("series"):
        lines = ["## 네이버 Trends (한국 검색량)"]
        for s in naver_trends["series"]:
            pts = s.get("points", [])
            if pts:
                latest = pts[-1]
                prev = pts[-4] if len(pts) >= 4 else pts[0]
                diff = latest["value"] - prev["value"]
                trend = "상승" if diff > 5 else "하락" if diff < -5 else "안정"
                lines.append(f"- '{s['keyword']}': {latest['value']}/100 (변화: {'+' if diff >= 0 else ''}{diff}, {trend})")
        ctx_parts.append("\n".join(lines))
        sources_used.append("naver_trends")

    for key, fname in [("Korea", "google_trends_kr.json"), ("Global", "google_trends_global.json")]:
        data = _load(PROCESSED_DIR / fname)
        if data and data.get("series"):
            lines = [f"## Google Trends ({key})"]
            for s in data["series"]:
                pts = s.get("points", [])
                if pts:
                    latest = pts[-1]
                    prev = pts[-2] if len(pts) >= 2 else latest
                    diff = latest["value"] - prev["value"]
                    lines.append(f"- '{s['keyword']}': {latest['value']}/100 (change: {'+' if diff >= 0 else ''}{diff})")
            ctx_parts.append("\n".join(lines))
            sources_used.append(f"trends_{key.lower()}")

    return "\n\n".join(ctx_parts), sources_used


@router.post("/news-digest")
async def generate_news_digest() -> dict[str, Any]:
    """NEWS-only AI digest summary."""
    client = _get_client()
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

    context, sources = _build_news_only_context()
    if not context:
        raise HTTPException(status_code=404, detail="No news data. Run news refresh first.")

    source_count = {"naver_news": 0, "english_news": 0, "global_news": 0, "who_don": 0}
    naver_news = _load(PROCESSED_DIR / "naver_news_kr.json")
    source_count["naver_news"] = len(naver_news) if isinstance(naver_news, list) else 0
    en_news = _load(PROCESSED_DIR / "korea_news.json")
    source_count["english_news"] = len(en_news) if isinstance(en_news, list) else 0
    global_news = _load(PROCESSED_DIR / "global_news.json")
    source_count["global_news"] = len(global_news) if isinstance(global_news, list) else 0
    who_don = _load(PROCESSED_DIR / "global_who_don.json")
    source_count["who_don"] = len(who_don) if isinstance(who_don, list) else 0

    prompt = f"{NEWS_DIGEST_PROMPT}\n\n--- News Data ---\n\n{context}"

    try:
        response = client.models.generate_content(model=model, contents=prompt)
        raw_text = response.text.strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini API error: {str(e)}")

    parsed = _parse_ai_response(raw_text)
    if not parsed:
        return {"status": "partial", "raw_summary": raw_text[:1000], "source_count": source_count, "generated_at": datetime.utcnow().isoformat()}

    parsed["source_count"] = source_count
    parsed["sources_used"] = sources
    parsed["status"] = "ok"
    parsed["generated_at"] = datetime.utcnow().isoformat()

    (PROCESSED_DIR / "news_digest.json").write_text(json.dumps(parsed, ensure_ascii=False, indent=2), encoding="utf-8")
    return parsed


@router.get("/news-digest")
async def get_news_digest() -> dict[str, Any]:
    digest_path = PROCESSED_DIR / "news_digest.json"
    if digest_path.exists():
        return json.loads(digest_path.read_text(encoding="utf-8"))
    return {"status": "empty", "message": "No digest available. Click Refresh to generate."}


@router.post("/trends-digest")
async def generate_trends_digest() -> dict[str, Any]:
    """TRENDS-only AI digest summary."""
    client = _get_client()
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

    context, sources = _build_trends_only_context()
    if not context:
        raise HTTPException(status_code=404, detail="No trends data. Run trends refresh first.")

    prompt = f"{TRENDS_DIGEST_PROMPT}\n\n--- Trends Data ---\n\n{context}"

    try:
        response = client.models.generate_content(model=model, contents=prompt)
        raw_text = response.text.strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini API error: {str(e)}")

    parsed = _parse_ai_response(raw_text)
    if not parsed:
        return {"status": "partial", "raw_summary": raw_text[:1000], "generated_at": datetime.utcnow().isoformat()}

    parsed["sources_used"] = sources
    parsed["status"] = "ok"
    parsed["generated_at"] = datetime.utcnow().isoformat()

    (PROCESSED_DIR / "trends_digest.json").write_text(json.dumps(parsed, ensure_ascii=False, indent=2), encoding="utf-8")
    return parsed


@router.get("/trends-digest")
async def get_trends_digest() -> dict[str, Any]:
    digest_path = PROCESSED_DIR / "trends_digest.json"
    if digest_path.exists():
        return json.loads(digest_path.read_text(encoding="utf-8"))
    return {"status": "empty", "message": "No trends digest available."}


@router.post("/kdca-digest")
async def generate_kdca_digest() -> dict[str, Any]:
    """KDCA-only AI digest summary."""
    client = _get_client()
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

    context, sources = _build_kdca_context()
    if not context:
        raise HTTPException(status_code=404, detail="No KDCA data. Upload KDCA files first.")

    prompt = f"{KDCA_DIGEST_PROMPT}\n\n--- KDCA Data ---\n\n{context}"

    try:
        response = client.models.generate_content(model=model, contents=prompt)
        raw_text = response.text.strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini API error: {str(e)}")

    parsed = _parse_ai_response(raw_text)
    if not parsed:
        return {"status": "partial", "raw_summary": raw_text[:1000], "generated_at": datetime.utcnow().isoformat()}

    parsed["sources_used"] = sources
    parsed["status"] = "ok"
    parsed["generated_at"] = datetime.utcnow().isoformat()

    (PROCESSED_DIR / "kdca_digest.json").write_text(json.dumps(parsed, ensure_ascii=False, indent=2), encoding="utf-8")
    return parsed


@router.get("/kdca-digest")
async def get_kdca_digest() -> dict[str, Any]:
    digest_path = PROCESSED_DIR / "kdca_digest.json"
    if digest_path.exists():
        return json.loads(digest_path.read_text(encoding="utf-8"))
    return {"status": "empty", "message": "No KDCA digest available. Upload data first."}


@router.get("/latest")
async def get_latest_analysis() -> dict[str, Any]:
    """Return latest snapshot with risk analysis fields."""
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    snapshots = sorted(SNAPSHOT_DIR.glob("*.json"), reverse=True)
    if not snapshots:
        raise HTTPException(status_code=404, detail="No snapshots available")

    data = json.loads(snapshots[0].read_text(encoding="utf-8"))
    has_nt_risk = any(r.get("news_trends_risk") for r in data)
    has_total_risk = any(r.get("total_risk") for r in data)

    return {
        "snapshot_date": snapshots[0].stem,
        "has_news_trends_risk": has_nt_risk,
        "has_total_risk": has_total_risk,
        "regions": data,
    }
