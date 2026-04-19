"""report_router.py — AI 보고서 생성 + 이메일 전송 (google-genai SDK)"""
from __future__ import annotations

import json
import os
from datetime import datetime, date
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

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


def _build_prompt(snapshot, prev_snapshot, korea_news, global_signals, trends, target_date) -> str:
    epiweek = _get_epiweek()
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

다음 구조로 한국어 보고서를 작성하세요:

# Sentinel Korea 주간 호흡기 감시 보고서
## Period: {epiweek} ({target_date})

## 1. 주요 요약
## 2. 지역별 경보 현황
## 3. 신호 해석
## 4. 글로벌 맥락
## 5. 검색 트렌드 분석
## 6. 권고사항

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


def _build_final_prompt(snapshot, prev_snapshot, korea_news, global_signals, trends, kdca_data, target_date) -> str:
    epiweek = _get_epiweek()
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

    kdca_section = "KDCA 업로드 데이터 요약 없음"
    if kdca_data:
        kdca_section = json.dumps(kdca_data, ensure_ascii=False, indent=2)[:2000]

    return f"""당신은 한국 감염병 역학 총괄 분석가입니다. OSINT(뉴스/트렌드)와 KDCA 공식 감시 데이터를 **통합**하여 최종 주간 리포트를 작성하세요.

### 경보 현황 ({target_date}, {epiweek})
{chr(10).join(dash_lines)}

### OSINT — 한국 뉴스
{chr(10).join(news_lines) if news_lines else '없음'}

### OSINT — 글로벌 신호
{chr(10).join(global_lines) if global_lines else '없음'}

### OSINT — Google Trends
{chr(10).join(trend_lines) if trend_lines else '없음'}

### KDCA 감시 데이터 (공식)
{kdca_section}

다음 구조로 한국어 **통합 리포트**를 작성하세요 — OSINT와 KDCA 신호가 수렴하는지/충돌하는지 명시하세요:

# Sentinel Korea — 통합 최종 리포트 (FINAL)
## Period: {epiweek} ({target_date})

## 1. 경영진 요약 (Executive Summary)
## 2. OSINT vs KDCA 신호 수렴도
## 3. 지역별 경보 현황
## 4. 통합 위험 해석
## 5. 권고사항 (방역/의료/커뮤니케이션)

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

    epiweek = _get_epiweek()
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

    epiweek = _get_epiweek()
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
async def generate_report(snapshot_date: str | None = None) -> dict[str, Any]:
    """하위 호환: KDCA 주간 리포트 생성."""
    return generate_kdca_report(snapshot_date)


@router.post("/generate-osint")
async def generate_osint_endpoint() -> dict[str, Any]:
    return generate_osint_report()


@router.post("/generate-kdca")
async def generate_kdca_endpoint(snapshot_date: str | None = None) -> dict[str, Any]:
    return generate_kdca_report(snapshot_date)


@router.post("/generate-final")
async def generate_final_endpoint(snapshot_date: str | None = None) -> dict[str, Any]:
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
async def add_recipient(recipient: RecipientModel) -> dict[str, Any]:
    recipients = _load_recipients()
    if recipient.email in [r["email"] for r in recipients]:
        raise HTTPException(status_code=400, detail="이미 등록된 이메일입니다.")
    recipients.append({"email": recipient.email, "name": recipient.name, "added_at": datetime.utcnow().isoformat()})
    _save_recipients(recipients)
    return {"status": "added", "email": recipient.email, "total": len(recipients)}


@router.delete("/recipients/{email}")
async def remove_recipient(email: str) -> dict[str, Any]:
    recipients = _load_recipients()
    new_list = [r for r in recipients if r["email"] != email]
    if len(new_list) == len(recipients):
        raise HTTPException(status_code=404, detail="등록되지 않은 이메일입니다.")
    _save_recipients(new_list)
    return {"status": "removed", "email": email, "total": len(new_list)}
