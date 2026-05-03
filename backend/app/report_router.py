"""report_router.py — AI 보고서 생성 + 이메일 전송 (google-genai SDK)"""
from __future__ import annotations

import json
import os
from datetime import datetime, date
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

from .auth import require_admin

router = APIRouter(prefix="/reports", tags=["reports"])

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PROCESSED_DIR = DATA_DIR / "processed"
SNAPSHOT_DIR = PROCESSED_DIR / "snapshots"
REPORTS_DIR = DATA_DIR / "reports"
RECIPIENTS_FILE = DATA_DIR / "email_recipients.json"
MOCK_DIR = DATA_DIR / "mock"


def _get_client():
    from google import genai
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY가 설정되지 않았습니다.")
    return genai.Client(api_key=api_key)


def _model_name() -> str:
    return os.getenv("GEMINI_MODEL", "gemini-2.5-flash")


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


def _load_prev_snapshot(current_date: str) -> list[dict]:
    snapshots = sorted(p.stem for p in SNAPSHOT_DIR.glob("*.json"))
    if current_date in snapshots:
        idx = snapshots.index(current_date)
        if idx > 0:
            return json.loads((SNAPSHOT_DIR / f"{snapshots[idx-1]}.json").read_text(encoding="utf-8"))
    return []


def _get_epiweek(dt: date | None = None) -> str:
    dt = dt or date.today()
    iso_year, iso_week, _ = dt.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


def _get_epiweek_for(value: str | None = None) -> str:
    if value:
        try:
            return _get_epiweek(date.fromisoformat(value[:10]))
        except ValueError:
            pass
    return _get_epiweek()


def _level_rank(level: str) -> int:
    return {"G0": 0, "G1": 1, "G2": 2, "G3": 3}.get(level, 0)


def _region_name(row: dict) -> str:
    return row.get("region_name_kr") or row.get("region_name_en") or row.get("region_code") or "미상 지역"


def _build_contract_sections(
    snapshot: list[dict],
    prev_snapshot: list[dict],
    korea_news: list[dict],
    global_signals: list[dict],
    trends: dict,
    report_kind: str,
) -> str:
    prev_map = {
        r.get("region_code") or r.get("region_name_en", ""): r.get("level", "G0")
        for r in prev_snapshot
    }
    watch_rows = sorted(
        snapshot,
        key=lambda row: (_level_rank(row.get("level", "G0")), float(row.get("score", 0) or 0)),
        reverse=True,
    )
    elevated = [row for row in watch_rows if row.get("level") in {"G3", "G2", "G1"}]
    top_watch = elevated[:5] or watch_rows[:3]

    changed = []
    for row in top_watch:
        key = row.get("region_code") or row.get("region_name_en", "")
        level = row.get("level", "G0")
        prev = prev_map.get(key, level)
        score = float(row.get("score", 0) or 0)
        delta = f", {prev}->{level}" if prev != level else ""
        changed.append(f"{_region_name(row)} {level} ({score:.2f}{delta})")

    trend_lines = []
    for series in (trends.get("korea", {}).get("series") or [])[:3]:
        pts = series.get("points", [])
        if len(pts) >= 2:
            diff = pts[-1].get("value", 0) - pts[-2].get("value", 0)
            trend_lines.append(f"{series.get('keyword', 'trend')} {'+' if diff >= 0 else ''}{diff}")

    quality_scores = [
        float((row.get("data_quality") or {}).get("score", 0))
        for row in snapshot
        if isinstance(row.get("data_quality"), dict)
    ]
    avg_quality = sum(quality_scores) / len(quality_scores) if quality_scores else 0
    independent_sources = [
        int(row.get("independent_sources", row.get("active_sources", 0)) or 0)
        for row in snapshot
    ]
    avg_independent = sum(independent_sources) / len(independent_sources) if independent_sources else 0
    confidence_label = "moderate"
    if avg_quality >= 0.75 and avg_independent >= 2:
        confidence_label = "high"
    elif avg_quality < 0.45 or avg_independent < 1:
        confidence_label = "low"

    report_scope = (
        "KDCA 공식 감시 baseline"
        if report_kind == "kdca"
        else "KDCA, 국내 OSINT, 검색 트렌드, 보조 corroboration을 결합한 Sentinel synthesis"
    )

    return f"""## What changed
- 이번 snapshot에서 관찰 우선순위가 높은 지역은 {', '.join(changed) if changed else '특이 상승 지역 없음'}입니다.
- 국내 OSINT 입력은 뉴스 {len(korea_news)}건, 검색 트렌드 {len(trend_lines)}개 키워드를 보조 신호로 확인했습니다.
- WHO/국제 뉴스 {len(global_signals)}건은 국내 경보를 대체하지 않고, 해외 유입 가능성 및 외부 corroboration 맥락으로만 분리했습니다.

## Why it matters
- 이 보고서는 {report_scope}입니다.
- Sentinel의 목적은 KDCA 자료를 단순 재표시하는 것이 아니라, 어떤 시도(region)가 평소보다 이상한지와 그 근거를 빠르게 설명하는 것입니다.
- 국내 뉴스/검색 신호는 증상탐색행동(OSINT 신호)으로 해석하며, 공식 감시자료와 수렴할 때 경보 설명력이 올라갑니다.

## Confidence
- 현재 confidence는 {confidence_label}입니다. 평균 data quality proxy는 {avg_quality:.2f}, 평균 independent source proxy는 {avg_independent:.1f}입니다.
- confidence는 source count 자체가 아니라 freshness, coverage, data quality, independent corroboration을 함께 반영해야 합니다.
- 폐하수 PDF와 CXR 계열 신호는 개인자료가 아니라 집계형 corroboration layer로만 해석합니다.

## Recommended watch actions
- G2/G3 또는 상승 전환 지역은 다음 epiweek까지 신호 breakdown과 원천자료 freshness를 우선 확인합니다.
- 국내 뉴스/검색 trend가 공식 감시자료와 같은 방향으로 움직이는지 retrospective timeline에서 검토합니다.
- 국제 신호는 globe 패널에서 Korea relevance와 raw data를 확인하되, 독립적인 글로벌 경보 점수로 해석하지 않습니다.

## Signal relationship figure
- Report 화면의 relationship figure는 이 raw artifact에서 지역, 신호원, 질병/키워드, action 용어를 추출해 구성합니다.
- 중심 노드는 이번 report이며, 주변 노드는 What changed, Why it matters, Confidence, Watch actions로 연결됩니다.
- 이 figure는 pipeline control이 아니라 이번 보고서 텍스트 안에서 signal들이 어떻게 의미적으로 묶였는지 보여주는 설명용 map입니다."""


def _strip_leading_report_title(markdown: str) -> str:
    lines = markdown.strip().splitlines()
    while lines and (
        lines[0].startswith("# Sentinel Korea")
        or lines[0].startswith("## Period:")
        or not lines[0].strip()
    ):
        lines.pop(0)
    return "\n".join(lines).strip()


def _ensure_report_contract(
    report_text: str,
    title: str,
    epiweek: str,
    target_date: str,
    contract_sections: str,
) -> str:
    required = ["## What changed", "## Why it matters", "## Confidence", "## Recommended watch actions"]
    if all(section in report_text for section in required):
        return report_text
    appendix = _strip_leading_report_title(report_text)
    return f"""# {title}
## Period: {epiweek} ({target_date})

{contract_sections}

## Evidence appendix
{appendix}""".strip()


def _build_prompt(snapshot, prev_snapshot, korea_news, global_signals, trends, target_date) -> str:
    epiweek = _get_epiweek_for(target_date)
    level_map: dict[str, list[str]] = {"G3": [], "G2": [], "G1": [], "G0": []}
    prev_map = {r.get("region_name_en", ""): r.get("level", "G0") for r in prev_snapshot}

    for r in snapshot:
        lvl = r.get("level", "G0")
        name_kr = r.get("region_name_kr") or r.get("region_name_en", "")
        name_en = r.get("region_name_en", "")
        prev_lvl = prev_map.get(name_en, "G0")
        change = f" ({'↑' if lvl > prev_lvl else '↓'} {prev_lvl}→{lvl})" if lvl != prev_lvl else ""
        level_map.setdefault(lvl, []).append(f"{name_kr}{change}")

    labels = {"G3": "[G3 Critical]", "G2": "[G2 Elevated]", "G1": "[G1 Guarded]", "G0": "[G0 Low]"}
    dash_lines = [f"{labels[l]} {', '.join(level_map.get(l,[])) or '없음'}" for l in ["G3","G2","G1","G0"]]

    news_lines = [f"- [{n.get('date','')}] {n.get('title','')}" for n in korea_news[:8]]
    global_lines = [f"- [{n.get('date','')}] {n.get('title','')}" for n in global_signals[:5]]

    trend_lines = []
    for s in (trends.get("korea", {}).get("series") or [])[:3]:
        pts = s.get("points", [])
        if len(pts) >= 2:
            diff = pts[-1].get("value", 0) - pts[-2].get("value", 0)
            trend_lines.append(f"- '{s.get('keyword','')}': {pts[-1].get('value',0)}/100 (전주 대비 {'+' if diff>=0 else ''}{diff})")

    return f"""당신은 한국 감염병 역학 전문가입니다. 아래 데이터로 주간 호흡기 감시 보고서를 작성하세요.

### 경보 현황 ({target_date}, {epiweek})
{chr(10).join(dash_lines)}

### 한국 뉴스
{chr(10).join(news_lines) if news_lines else '없음'}

### 글로벌 신호
{chr(10).join(global_lines) if global_lines else '없음'}

### Google Trends
{chr(10).join(trend_lines) if trend_lines else '없음'}

다음 구조를 반드시 지켜 한국어 보고서를 작성하세요. 첫 네 섹션 제목은 영어 그대로 사용하세요:

# Sentinel Korea 주간 호흡기 감시 보고서
## Period: {epiweek} ({target_date})

## What changed
## Why it matters
## Confidence
## Recommended watch actions
## Signal relationship figure
## Evidence appendix
### 1. 지역별 경보 현황
### 2. 신호 해석
### 3. 글로벌 맥락
### 4. 검색 트렌드 분석
### 5. 세부 권고사항

보고서:"""


def generate_report_content(target_date: str | None = None) -> dict[str, Any]:
    """KDCA 주간 리포트 (기존 동작 유지 - 하위 호환용)."""
    return generate_kdca_report(target_date)


# ── 리포트 타입별 생성기 ─────────────────────────────────────────────

def _save_report(kind: str, stem: str, content: str) -> Path:
    """kind: osint|kdca|final, stem: YYYY-MM-DD or YYYY-WNN → writes {kind}_{stem}.md"""
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORTS_DIR / f"{kind}_{stem}.md"
    path.write_text(content, encoding="utf-8")
    return path


def _build_osint_prompt(korea_news, global_signals, trends, target_date) -> str:
    news_lines = [f"- [{n.get('date','')}] {n.get('title','')} — {(n.get('snippet') or n.get('description') or '')[:140]}" for n in korea_news[:10]]
    global_lines = [f"- [{n.get('date','')}] {n.get('title','')} — {(n.get('snippet') or n.get('description') or '')[:140]}" for n in global_signals[:8]]
    trend_lines = []
    for s in (trends.get("korea", {}).get("series") or [])[:5]:
        pts = s.get("points", [])
        if len(pts) >= 2:
            diff = pts[-1].get("value", 0) - pts[-2].get("value", 0)
            trend_lines.append(f"- '{s.get('keyword','')}': {pts[-1].get('value',0)}/100 (전일 대비 {'+' if diff>=0 else ''}{diff})")

    return f"""당신은 한국 감염병 역학 OSINT(공개출처정보) 분석가입니다. 아래 최신 오픈소스 신호만을 바탕으로 **일간 OSINT 리포트**를 작성하세요.

### 한국 뉴스 (최근)
{chr(10).join(news_lines) if news_lines else '없음'}

### 글로벌 신호 (WHO DON + 뉴스)
{chr(10).join(global_lines) if global_lines else '없음'}

### Google Trends (한국)
{chr(10).join(trend_lines) if trend_lines else '없음'}

다음 구조로 한국어 리포트를 작성하세요:

# Sentinel Korea — OSINT 일간 리포트
## Date: {target_date}

## 1. 오늘의 핵심 OSINT 신호 (Top 3)
## 2. 국내 뉴스 인사이트
## 3. 글로벌 신호 인사이트
## 4. 검색 트렌드 해석
## 5. 위험도 초기 판단 (OSINT only)

리포트:"""


def _score_outbreak_for_korea(item: dict) -> float:
    """Lightweight Python port of scoreInternationalRelevance (frontend) so
    the FINAL report can pick the Top-3 most Korea-relevant outbreaks.
    Returns 0..1.
    """
    from datetime import datetime as _dt

    # Korea center (Seoul) for distance heuristic
    KOREA_LAT, KOREA_LNG = 37.57, 126.98
    SOURCE_RELIABILITY = {
        "who_don": 0.95, "ecdc": 0.92, "cdc": 0.90, "promed": 0.88,
        "kdca_global_report": 0.85, "healthmap": 0.78,
        "gemini_outbreak": 0.65, "news_global": 0.55,
        "google_news_outbreak": 0.50, "google_news": 0.45,
    }
    HIGH_TRAFFIC = {
        "china": 0.95, "japan": 0.95, "taiwan": 0.82, "vietnam": 0.78,
        "thailand": 0.76, "philippines": 0.72, "singapore": 0.72,
        "indonesia": 0.66, "malaysia": 0.65, "usa": 0.64, "united states": 0.64,
        "australia": 0.56, "canada": 0.52, "india": 0.50,
    }

    severity = item.get("severity", "low")
    severity_score = 1.0 if severity == "high" else 0.62 if severity == "medium" else 0.30
    source_score = SOURCE_RELIABILITY.get(item.get("source", ""), 0.55)

    # Disease risk
    text = " ".join(str(item.get(k, "")) for k in ("title", "snippet", "disease", "country", "source")).lower()
    if any(t in text for t in ["h5n1", "avian", "mers", "sars", "novel", "unknown", "fatal", "severe pneumonia"]):
        risk_score = 1.0
    elif any(t in text for t in ["covid", "coronavirus", "influenza", "pneumonia", "respiratory outbreak", "cluster"]):
        risk_score = 0.78
    elif any(t in text for t in ["rsv", "mycoplasma", "fever", "cough", "respiratory"]):
        risk_score = 0.58
    else:
        risk_score = 0.30

    # Distance & traffic proxy
    try:
        lat = float(item.get("lat", 20))
        lng = float(item.get("lng", 0))
        dist_km = max(100, ((lat - KOREA_LAT) ** 2 + (lng - KOREA_LNG) ** 2) ** 0.5 * 111)  # rough km
    except Exception:
        dist_km = 6000
    proximity = max(0.0, 1 - min(dist_km, 9000) / 9000)
    country = (item.get("country", "") or "").lower()
    traffic = next((v for k, v in HIGH_TRAFFIC.items() if k in country), None)
    if traffic is None:
        traffic = 0.82 if dist_km < 900 else 0.68 if dist_km < 2500 else 0.48 if dist_km < 5500 else 0.28

    # Recency
    try:
        days_old = (datetime.utcnow() - datetime.fromisoformat(str(item.get("date", ""))[:10])).days
    except Exception:
        days_old = 14
    import math
    recency = max(0.1, math.exp(-max(0, days_old) / 60))

    # HealthMap marker boost (if available)
    marker_count = item.get("marker_alert_count") or 0
    marker_boost = 0.18 + math.log10(marker_count + 1) * 0.45 if marker_count > 1 else 0

    base = (
        severity_score * 0.22
        + risk_score * 0.20
        + traffic * 0.18
        + proximity * 0.14
        + source_score * 0.06
        + min(1.0, marker_boost) * 0.10
        + (item.get("marker_significance") or 0) * 0.05
    )
    score = max(base * 0.25, base * recency)
    return min(1.0, score)


def _load_top_outbreaks_for_korea(top_n: int = 3, min_score: float = 0.6) -> list[dict]:
    """Load all current global_*.json source files and return the Top-N most
    Korea-relevant outbreak items (score >= min_score)."""
    files = [
        "global_who_don.json", "global_cdc.json", "global_ecdc.json",
        "global_healthmap.json", "global_gemini_outbreak.json",
        "global_google_outbreak.json", "global_news.json",
        "global_kdca_outbreaks.json",
    ]
    items: list[dict] = []
    seen: set[str] = set()
    for fname in files:
        p = PROCESSED_DIR / fname
        if not p.exists():
            continue
        for item in _load(p):
            iid = item.get("id")
            if iid and iid in seen:
                continue
            if iid:
                seen.add(iid)
            items.append({**item, "_korea_score": _score_outbreak_for_korea(item)})
    items.sort(key=lambda x: x.get("_korea_score", 0), reverse=True)
    qualified = [x for x in items if x.get("_korea_score", 0) >= min_score]
    return qualified[:top_n]


def _build_final_prompt(snapshot, prev_snapshot, korea_news, global_signals, trends, kdca_data, target_date) -> str:
    epiweek = _get_epiweek_for(target_date)
    level_map: dict[str, list[str]] = {"G3": [], "G2": [], "G1": [], "G0": []}
    prev_map = {r.get("region_name_en", ""): r.get("level", "G0") for r in prev_snapshot}
    for r in snapshot:
        lvl = r.get("level", "G0")
        name_kr = r.get("region_name_kr") or r.get("region_name_en", "")
        name_en = r.get("region_name_en", "")
        prev_lvl = prev_map.get(name_en, "G0")
        change = f" ({'↑' if lvl > prev_lvl else '↓'} {prev_lvl}→{lvl})" if lvl != prev_lvl else ""
        level_map.setdefault(lvl, []).append(f"{name_kr}{change}")

    labels = {"G3": "[G3 Critical]", "G2": "[G2 Elevated]", "G1": "[G1 Guarded]", "G0": "[G0 Low]"}
    dash_lines = [f"{labels[l]} {', '.join(level_map.get(l,[])) or '없음'}" for l in ["G3","G2","G1","G0"]]
    news_lines = [f"- [{n.get('date','')}] {n.get('title','')}" for n in korea_news[:8]]
    global_lines = [f"- [{n.get('date','')}] {n.get('title','')}" for n in global_signals[:5]]

    # Phase 3-B: Korea-relevant global outbreaks (≥70% only) auto-injected from all sources.
    # 70% threshold maps to the frontend "high"+"critical" tiers.
    top_outbreaks = _load_top_outbreaks_for_korea(top_n=10, min_score=0.70)
    outbreak_lines = []
    for item in top_outbreaks:
        score_pct = round(item.get("_korea_score", 0) * 100)
        country = item.get("country", "") or "unknown"
        date_s = item.get("date", "")
        title = item.get("title", "")
        source = item.get("source", "")
        publisher = item.get("publisher", "")
        outbreak_lines.append(
            f"- [관련성 {score_pct}%] [{date_s}] {country} — {title} (출처: {publisher or source})"
        )
    trend_lines = []
    for s in (trends.get("korea", {}).get("series") or [])[:3]:
        pts = s.get("points", [])
        if len(pts) >= 2:
            diff = pts[-1].get("value", 0) - pts[-2].get("value", 0)
            trend_lines.append(f"- '{s.get('keyword','')}': {pts[-1].get('value',0)}/100 (전주 대비 {'+' if diff>=0 else ''}{diff})")

    kdca_section = "KDCA 업로드 데이터 요약 없음"
    if kdca_data:
        kdca_section = json.dumps(kdca_data, ensure_ascii=False, indent=2)[:2000]

    return f"""당신은 한국 감염병 역학 총괄 분석가입니다. OSINT(뉴스/트렌드)와 KDCA 공식 감시 데이터를 **통합**하여 최종 주간 리포트를 작성하세요.

### 경보 현황 ({target_date}, {epiweek})
{chr(10).join(dash_lines)}

### OSINT — 한국 뉴스
{chr(10).join(news_lines) if news_lines else '없음'}

### OSINT — 글로벌 신호 (raw)
{chr(10).join(global_lines) if global_lines else '없음'}

### 한국 관련성 ≥70% outbreak (high tier, 자동 선정)
{chr(10).join(outbreak_lines) if outbreak_lines else '이번 주 한국 관련성 70%를 넘는 해외 outbreak 없음'}

### OSINT — Google Trends
{chr(10).join(trend_lines) if trend_lines else '없음'}

### KDCA 감시 데이터 (공식)
{kdca_section}

다음 구조를 반드시 지켜 한국어 **통합 리포트**를 작성하세요. 첫 네 섹션 제목은 영어 그대로 사용하고, OSINT와 KDCA 신호가 수렴하는지/충돌하는지 명시하세요.
**중요:** 위 "한국 관련성 ≥70% outbreak" 섹션은 모든 outbreak source(WHO DON / CDC / ECDC / HealthMap / Gemini / Google News)에서 자동 점수화로 선정된 high-tier imported-risk 후보입니다. **"Why it matters"** 섹션에서 이 항목들을 반드시 언급하고, 한국 입국 가능성·항공 노선·환자 표현형 측면에서 의미를 풀어 쓰세요. 항목이 비어 있으면 "이번 주 한국 관련성 70%를 넘는 해외 신호 없음"이라고 명시하세요.

# Sentinel Korea — 통합 최종 리포트 (FINAL)
## Period: {epiweek} ({target_date})

## What changed
## Why it matters
## Confidence
## Recommended watch actions
## Signal relationship figure
## Evidence appendix
### 1. OSINT vs KDCA 신호 수렴도
### 2. 지역별 경보 현황
### 3. 통합 위험 해석
### 4. 방역/의료/커뮤니케이션 세부 권고

리포트:"""


def generate_osint_report() -> dict[str, Any]:
    """OSINT 일간 리포트 — 뉴스+트렌드 기반, 매일 갱신 가능."""
    client = _get_client()
    model = _model_name()
    target_date = date.today().isoformat()

    korea_news = _load(PROCESSED_DIR / "korea_news.json")[:15]
    global_signals: list[dict] = []
    for f in ["global_who_don.json", "global_news.json"]:
        p = PROCESSED_DIR / f
        if p.exists():
            global_signals.extend(_load(p)[:8])
    if not global_signals:
        global_signals = _load(MOCK_DIR / "mock_global_signals.json")

    trends: dict = {}
    for key, fname in [("korea", "google_trends_kr.json"), ("global", "google_trends_global.json")]:
        p = PROCESSED_DIR / fname
        if p.exists():
            trends[key] = _load(p)

    prompt = _build_osint_prompt(korea_news, global_signals, trends, target_date)
    try:
        response = client.models.generate_content(model=model, contents=prompt)
        report_text = response.text.strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini API 오류: {str(e)}")

    snapshot = _load_snapshot()
    prev_snapshot = _load_prev_snapshot(snapshot[0].get("date", target_date) if snapshot else target_date)
    contract_sections = _build_contract_sections(
        snapshot=snapshot,
        prev_snapshot=prev_snapshot,
        korea_news=korea_news,
        global_signals=global_signals,
        trends=trends,
        report_kind="final",
    )
    report_text = _ensure_report_contract(
        report_text=report_text,
        title="Sentinel Korea OSINT 일간 리포트",
        epiweek=_get_epiweek_for(target_date),
        target_date=target_date,
        contract_sections=contract_sections,
    )
    path = _save_report("osint", target_date, report_text)
    return {
        "type": "osint",
        "stem": target_date,
        "report_filename": path.name,
        "report_content": report_text,
        "model": model,
        "generated_at": datetime.utcnow().isoformat(),
    }


def generate_kdca_report(target_date: str | None = None) -> dict[str, Any]:
    """KDCA 주간 리포트 — 공식 감시 데이터 기반, 주 1회."""
    client = _get_client()
    model = _model_name()

    snapshot = _load_snapshot(target_date)
    if not snapshot:
        raise HTTPException(status_code=404, detail="스냅샷 데이터 없음")

    actual_date = snapshot[0].get("date", target_date or date.today().isoformat())
    prev_snapshot = _load_prev_snapshot(actual_date)
    korea_news = _load(PROCESSED_DIR / "korea_news.json")[:15]
    global_signals: list[dict] = []
    for f in ["global_who_don.json", "global_news.json"]:
        p = PROCESSED_DIR / f
        if p.exists():
            global_signals.extend(_load(p)[:8])
    if not global_signals:
        global_signals = _load(MOCK_DIR / "mock_global_signals.json")

    trends: dict = {}
    for key, fname in [("korea", "google_trends_kr.json"), ("global", "google_trends_global.json")]:
        p = PROCESSED_DIR / fname
        if p.exists():
            trends[key] = _load(p)

    prompt = _build_prompt(snapshot, prev_snapshot, korea_news, global_signals, trends, actual_date)
    try:
        response = client.models.generate_content(model=model, contents=prompt)
        report_text = response.text.strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini API 오류: {str(e)}")

    epiweek = _get_epiweek_for(actual_date)
    contract_sections = _build_contract_sections(
        snapshot=snapshot,
        prev_snapshot=prev_snapshot,
        korea_news=korea_news,
        global_signals=global_signals,
        trends=trends,
        report_kind="kdca",
    )
    report_text = _ensure_report_contract(
        report_text=report_text,
        title="Sentinel Korea 주간 호흡기 감시 보고서",
        epiweek=epiweek,
        target_date=actual_date,
        contract_sections=contract_sections,
    )
    stem = epiweek.replace("/", "-")
    path = _save_report("kdca", stem, report_text)
    return {
        "type": "kdca",
        "stem": stem,
        "epiweek": epiweek,
        "snapshot_date": actual_date,
        "report_filename": path.name,
        "report_content": report_text,
        "model": model,
        "generated_at": datetime.utcnow().isoformat(),
    }


def generate_final_report(target_date: str | None = None) -> dict[str, Any]:
    """FINAL 통합 주간 리포트 — OSINT + KDCA 통합."""
    client = _get_client()
    model = _model_name()

    snapshot = _load_snapshot(target_date)
    if not snapshot:
        raise HTTPException(status_code=404, detail="스냅샷 데이터 없음")

    actual_date = snapshot[0].get("date", target_date or date.today().isoformat())
    prev_snapshot = _load_prev_snapshot(actual_date)
    korea_news = _load(PROCESSED_DIR / "korea_news.json")[:15]
    global_signals: list[dict] = []
    for f in ["global_who_don.json", "global_news.json"]:
        p = PROCESSED_DIR / f
        if p.exists():
            global_signals.extend(_load(p)[:8])
    if not global_signals:
        global_signals = _load(MOCK_DIR / "mock_global_signals.json")

    trends: dict = {}
    for key, fname in [("korea", "google_trends_kr.json"), ("global", "google_trends_global.json")]:
        p = PROCESSED_DIR / fname
        if p.exists():
            trends[key] = _load(p)

    # KDCA 업로드 데이터 요약 (snapshots 폴더 최신)
    kdca_summary: dict = {}
    kdca_dir = DATA_DIR / "kdca_uploads"
    if kdca_dir.exists():
        files = sorted(kdca_dir.glob("*.json"))[-3:]
        for f in files:
            try:
                kdca_summary[f.stem] = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                pass

    prompt = _build_final_prompt(snapshot, prev_snapshot, korea_news, global_signals, trends, kdca_summary, actual_date)
    try:
        response = client.models.generate_content(model=model, contents=prompt)
        report_text = response.text.strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini API 오류: {str(e)}")

    epiweek = _get_epiweek_for(actual_date)
    contract_sections = _build_contract_sections(
        snapshot=snapshot,
        prev_snapshot=prev_snapshot,
        korea_news=korea_news,
        global_signals=global_signals,
        trends=trends,
        report_kind="final",
    )
    report_text = _ensure_report_contract(
        report_text=report_text,
        title="Sentinel Korea — 통합 최종 리포트 (FINAL)",
        epiweek=epiweek,
        target_date=actual_date,
        contract_sections=contract_sections,
    )
    stem = epiweek.replace("/", "-")
    path = _save_report("final", stem, report_text)
    return {
        "type": "final",
        "stem": stem,
        "epiweek": epiweek,
        "snapshot_date": actual_date,
        "report_filename": path.name,
        "report_content": report_text,
        "model": model,
        "generated_at": datetime.utcnow().isoformat(),
    }


# ── 수신자 관리 ──────────────────────────────────────────────────────
def _load_recipients() -> list[dict]:
    return _load(RECIPIENTS_FILE)


def _save_recipients(recipients: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RECIPIENTS_FILE.write_text(json.dumps(recipients, ensure_ascii=False, indent=2), encoding="utf-8")


class RecipientModel(BaseModel):
    email: str
    name: str = ""


# ── 라우트 ───────────────────────────────────────────────────────────
@router.post("/generate")
async def generate_report(snapshot_date: str | None = None, _: dict = Depends(require_admin)) -> dict[str, Any]:
    """하위 호환: KDCA 주간 리포트 생성."""
    return generate_kdca_report(snapshot_date)


@router.post("/generate-osint")
async def generate_osint_endpoint(_: dict = Depends(require_admin)) -> dict[str, Any]:
    return generate_osint_report()


@router.post("/generate-kdca")
async def generate_kdca_endpoint(snapshot_date: str | None = None, _: dict = Depends(require_admin)) -> dict[str, Any]:
    return generate_kdca_report(snapshot_date)


@router.post("/generate-final")
async def generate_final_endpoint(snapshot_date: str | None = None, _: dict = Depends(require_admin)) -> dict[str, Any]:
    return generate_final_report(snapshot_date)


def _classify_report(p: Path) -> dict[str, Any]:
    name = p.stem
    report_type = "kdca"  # 레거시 파일 (prefix 없음) = KDCA
    stem = name
    if name.startswith("osint_"):
        report_type, stem = "osint", name[6:]
    elif name.startswith("kdca_"):
        report_type, stem = "kdca", name[5:]
    elif name.startswith("final_"):
        report_type, stem = "final", name[6:]
    return {
        "filename": p.name,
        "type": report_type,
        "stem": stem,
        "epiweek": stem if "W" in stem else None,
        "snapshot_date": stem if "W" not in stem else None,
        "generated_at": datetime.fromtimestamp(p.stat().st_mtime).isoformat(),
        "size_bytes": p.stat().st_size,
    }


@router.get("/list")
async def list_reports() -> list[dict]:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    items = [_classify_report(p) for p in REPORTS_DIR.glob("*.md")]
    items.sort(key=lambda x: x["generated_at"], reverse=True)
    return items


@router.get("/content/{filename}")
async def get_report(filename: str) -> dict[str, Any]:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    for p in [REPORTS_DIR / filename, REPORTS_DIR / f"{filename}.md"]:
        if p.exists():
            meta = _classify_report(p)
            return {
                **meta,
                "content": p.read_text(encoding="utf-8"),
            }
    raise HTTPException(status_code=404, detail="보고서를 찾을 수 없습니다.")


@router.post("/send")
async def send_report(
    background_tasks: BackgroundTasks,
    filename: str | None = None,
    _: dict = Depends(require_admin),
) -> dict[str, Any]:
    recipients = _load_recipients()
    if not recipients:
        raise HTTPException(status_code=400, detail="등록된 수신자가 없습니다. /reports/recipients/add 로 추가해주세요.")

    smtp_user = os.getenv("SMTP_USERNAME", "")
    smtp_pass = os.getenv("SMTP_PASSWORD", "")
    if not smtp_user or not smtp_pass:
        raise HTTPException(
            status_code=503,
            detail="이메일 미설정. .env에 SMTP_USERNAME, SMTP_PASSWORD를 설정해주세요."
        )

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    report_path = None
    if filename:
        for p in [REPORTS_DIR / filename, REPORTS_DIR / f"{filename}.md"]:
            if p.exists():
                report_path = p
                break
    else:
        reports = sorted(REPORTS_DIR.glob("*.md"), reverse=True)
        if reports:
            report_path = reports[0]

    if not report_path:
        raise HTTPException(status_code=404, detail="전송할 보고서가 없습니다. 먼저 /reports/generate 를 실행하세요.")

    background_tasks.add_task(
        _send_emails,
        recipients=recipients,
        subject=f"[Sentinel Korea] 주간 호흡기 감시 보고서 - {report_path.stem}",
        report_content=report_path.read_text(encoding="utf-8"),
        smtp_user=smtp_user,
        smtp_pass=smtp_pass,
    )

    return {
        "status": "sending",
        "report": report_path.name,
        "recipients": [r["email"] for r in recipients],
    }


async def _send_emails(recipients, subject, report_content, smtp_user, smtp_pass):
    import aiosmtplib
    import markdown as md
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    html_body = md.markdown(report_content, extensions=["tables", "fenced_code"])
    html_full = f"""<html><body style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:20px">
    <div style="background:#0d1b2a;color:#e0f2fe;padding:20px;border-radius:8px;margin-bottom:20px">
      <h2 style="margin:0;color:#38bdf8">Sentinel Korea</h2>
      <p style="margin:5px 0;font-size:12px;color:#94a3b8">호흡기 감염병 조기 경보 시스템</p>
    </div>
    {html_body}
    <hr style="border-color:#334155;margin-top:30px">
    <p style="color:#64748b;font-size:11px">본 보고서는 Sentinel Korea AI에 의해 자동 생성되었습니다.</p>
    </body></html>"""

    smtp_host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    sender_name = os.getenv("REPORT_SENDER_NAME", "Sentinel Korea")

    for recipient in recipients:
        try:
            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"] = f"{sender_name} <{smtp_user}>"
            msg["To"] = recipient["email"]
            msg.attach(MIMEText(report_content, "plain", "utf-8"))
            msg.attach(MIMEText(html_full, "html", "utf-8"))
            await aiosmtplib.send(msg, hostname=smtp_host, port=smtp_port,
                                  username=smtp_user, password=smtp_pass, start_tls=True)
            print(f"[Email] 전송 완료: {recipient['email']}")
        except Exception as e:
            print(f"[Email] 전송 실패 {recipient['email']}: {e}")


# ── 수신자 엔드포인트 ────────────────────────────────────────────────
@router.get("/recipients/list")
async def list_recipients() -> list[dict]:
    return _load_recipients()


@router.post("/recipients/add")
async def add_recipient(recipient: RecipientModel, _: dict = Depends(require_admin)) -> dict[str, Any]:
    recipients = _load_recipients()
    if recipient.email in [r["email"] for r in recipients]:
        raise HTTPException(status_code=400, detail="이미 등록된 이메일입니다.")
    recipients.append({"email": recipient.email, "name": recipient.name, "added_at": datetime.utcnow().isoformat()})
    _save_recipients(recipients)
    return {"status": "added", "email": recipient.email, "total": len(recipients)}


@router.delete("/recipients/{email}")
async def remove_recipient(email: str, _: dict = Depends(require_admin)) -> dict[str, Any]:
    recipients = _load_recipients()
    new_list = [r for r in recipients if r["email"] != email]
    if len(new_list) == len(recipients):
        raise HTTPException(status_code=404, detail="등록되지 않은 이메일입니다.")
    _save_recipients(new_list)
    return {"status": "removed", "email": email, "total": len(new_list)}
