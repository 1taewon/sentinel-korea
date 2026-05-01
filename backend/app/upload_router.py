"""upload_router.py — KDCA 파일 업로드 + 수집 트리거 API"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, UploadFile, File
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

router = APIRouter(prefix="/ingestion", tags=["ingestion"])

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PROCESSED_DIR = DATA_DIR / "processed"
UPLOAD_HISTORY_FILE = PROCESSED_DIR / "upload_history.json"
SENTINEL_DATA_DIR = Path(
    os.getenv("SENTINEL_DATA_DIR", r"C:\Users\han75\OneDrive\Desktop\Sentinel_data")
)

# scripts 폴더를 sys.path에 추가
SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


def _run_script(script_name: str) -> dict[str, Any]:
    """지정 스크립트를 임포트 + 실행합니다."""
    try:
        import importlib
        module = importlib.import_module(script_name)
        if hasattr(module, "main"):
            module.main()
        return {"status": "ok", "script": script_name}
    except Exception as e:
        return {"status": "error", "script": script_name, "error": str(e)}


@router.post("/upload-kdca")
async def upload_kdca_file(file: UploadFile = File(...)) -> dict[str, Any]:
    """KDCA 엑셀/CSV 파일을 업로드하고 파싱합니다."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="파일명이 없습니다.")

    allowed_ext = {".csv", ".xlsx"}
    ext = Path(file.filename).suffix.lower()
    if ext not in allowed_ext:
        raise HTTPException(status_code=400, detail=f"지원하지 않는 형식입니다: {ext}")

    content_bytes = await file.read()

    # process_kdca_excel 임포트 후 처리
    try:
        from process_kdca_excel import process_file, detect_file_type
    except ImportError:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "process_kdca_excel", SCRIPTS_DIR / "process_kdca_excel.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        process_file = module.process_file
        detect_file_type = module.detect_file_type

    file_type = detect_file_type(file.filename)
    if not file_type:
        raise HTTPException(
            status_code=400,
            detail=f"파일명에서 종류를 감지할 수 없습니다. '급성호흡기감염증', '인플루엔자', '중증급성호흡기' 등의 키워드를 포함해주세요."
        )

    result = process_file(Path(file.filename), content_bytes=content_bytes)
    if not result.get("success"):
        raise HTTPException(status_code=422, detail=result.get("error", "파싱 실패"))

    return result


@router.post("/process-folder")
async def process_sentinel_folder() -> dict[str, Any]:
    """SENTINEL_DATA_DIR 폴더를 스캔하여 미처리 파일을 처리합니다."""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "process_kdca_excel", SCRIPTS_DIR / "process_kdca_excel.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        results = module.scan_sentinel_data_dir()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"폴더 스캔 실패: {str(e)}")

    return {
        "status": "ok",
        "files_processed": len(results),
        "results": results,
        "sentinel_data_dir": str(SENTINEL_DATA_DIR),
    }


@router.post("/refresh-kdca-notifiable")
async def refresh_kdca_notifiable(year: int | None = None) -> dict[str, Any]:
    """KDCA EIDAPI PeriodRegion 데이터를 수집하고 PeriodBasic으로 검산합니다."""
    try:
        module = __import_script("fetch_kdca_api")
        return module.main(year=year)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"KDCA 법정감염병 API 갱신 실패: {str(e)}")


@router.post("/refresh-global")
async def refresh_global_signals() -> dict[str, Any]:
    """WHO DON + 글로벌 뉴스를 새로 수집합니다."""
    results = {}

    # WHO DON 스크래핑
    try:
        spec = __import_script("fetch_who_don")
        data = spec.fetch_who_don()
        out_path = PROCESSED_DIR / "global_who_don.json"
        out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        results["who_don"] = {"status": "ok", "count": len(data)}
    except Exception as e:
        results["who_don"] = {"status": "error", "error": str(e)}

    # 글로벌 뉴스
    try:
        spec = __import_script("fetch_global_news")
        data = spec.fetch_global_news()
        out_path = PROCESSED_DIR / "global_news.json"
        out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        results["global_news"] = {"status": "ok", "count": len(data)}
    except Exception as e:
        results["global_news"] = {"status": "error", "error": str(e)}

    return {"status": "completed", "results": results}


@router.post("/refresh-korea")
async def refresh_korea_signals() -> dict[str, Any]:
    """한국 뉴스를 새로 수집합니다 (네이버 + NewsAPI)."""
    results = {}

    # Naver News (한국어)
    try:
        naver_mod = __import_script("fetch_naver_news")
        naver_data = naver_mod.fetch_naver_news()
        (PROCESSED_DIR / "naver_news_kr.json").write_text(
            json.dumps(naver_data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        results["naver_news"] = {"status": "ok", "count": len(naver_data)}
    except Exception as e:
        results["naver_news"] = {"status": "error", "error": str(e)}

    # NewsAPI (영어)
    try:
        module = __import_script("fetch_korea_news")
        data = module.fetch_korea_news()
        (PROCESSED_DIR / "korea_news.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        results["newsapi"] = {"status": "ok", "count": len(data)}
    except Exception as e:
        results["newsapi"] = {"status": "error", "error": str(e)}

    total = sum(r.get("count", 0) for r in results.values() if r.get("status") == "ok")
    return {"status": "ok", "count": total, "details": results}


@router.post("/refresh-trends")
async def refresh_trends() -> dict[str, Any]:
    """Google Trends + Naver Trends 데이터를 새로 수집합니다."""
    results = {}

    # Google Trends
    try:
        module = __import_script("fetch_google_trends")

        kr_data = module.fetch_korea_trends()
        (PROCESSED_DIR / "google_trends_kr.json").write_text(
            json.dumps(kr_data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        results["google_korea"] = {"status": "ok", "keywords": kr_data.get("keywords", [])}

        global_data = module.fetch_global_trends()
        (PROCESSED_DIR / "google_trends_global.json").write_text(
            json.dumps(global_data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        results["google_global"] = {"status": "ok", "keywords": global_data.get("keywords", [])}
    except Exception as e:
        results["google"] = {"status": "error", "error": str(e)}

    # Naver Trends
    try:
        naver_module = __import_script("fetch_naver_trends")
        naver_data = naver_module.fetch_naver_trends()
        (PROCESSED_DIR / "naver_trends_kr.json").write_text(
            json.dumps(naver_data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        results["naver_korea"] = {"status": "ok", "keywords": naver_data.get("keywords", [])}
    except Exception as e:
        results["naver_korea"] = {"status": "error", "error": str(e)}

    return {"status": "completed", "results": results}


@router.get("/upload-history")
async def get_upload_history() -> list[dict]:
    """KDCA 파일 업로드 이력을 반환합니다."""
    if UPLOAD_HISTORY_FILE.exists():
        return json.loads(UPLOAD_HISTORY_FILE.read_text(encoding="utf-8"))
    return []


def __import_script(script_name: str):
    """scripts/ 폴더의 모듈을 동적으로 임포트합니다."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        script_name, SCRIPTS_DIR / f"{script_name}.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
