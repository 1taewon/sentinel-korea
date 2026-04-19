"""process_kdca_excel.py — KDCA 엑셀/CSV 파일 파싱 및 스냅샷 업데이트"""
from __future__ import annotations

import csv
import json
import os
import re
import sys
from datetime import date, timedelta
from io import StringIO, BytesIO
from pathlib import Path
from typing import Any

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
SNAPSHOT_DIR = PROCESSED_DIR / "snapshots"
UPLOAD_HISTORY_FILE = PROCESSED_DIR / "upload_history.json"

SENTINEL_DATA_DIR = Path(
    os.getenv("SENTINEL_DATA_DIR", r"C:\Users\han75\OneDrive\Desktop\Sentinel_data")
)

# 17개 지역 코드
REGION_CODES = ["11","26","27","28","29","30","31","36","41","42","43","44","45","46","47","48","50"]

# 파일명 패턴으로 종류 감지
PATTERNS = {
    "ari": re.compile(r"급성호흡기|acute.*respiratory|ARI", re.IGNORECASE),
    "influenza": re.compile(r"인플루엔자|influenza|ILI", re.IGNORECASE),
    "sari": re.compile(r"중증급성|SARI|severe.*acute", re.IGNORECASE),
}


def epiweek_to_date(year: int, week: int) -> str:
    """주차(epidemiological week) → 해당 주 일요일 날짜 반환"""
    jan4 = date(year, 1, 4)
    # ISO week 1의 월요일
    week1_monday = jan4 - timedelta(days=jan4.weekday())
    target = week1_monday + timedelta(weeks=week - 1, days=6)  # 일요일
    return target.strftime("%Y-%m-%d")


def detect_file_type(filename: str) -> str | None:
    for ftype, pattern in PATTERNS.items():
        if pattern.search(filename):
            return ftype
    return None


def parse_ari_csv(content: str) -> list[dict]:
    """급성호흡기감염증 CSV 파싱
    포맷: 연도, 주차, 총계, 바이러스1, 바이러스2, ...
    """
    records = []
    reader = csv.reader(StringIO(content))
    for row in reader:
        # 빈 행 또는 헤더 건너뜀
        if not row or not row[0].strip().isdigit():
            continue
        try:
            year = int(row[0].strip())
            week = int(row[1].strip()) if len(row) > 1 else 0
            total = float(row[2].strip()) if len(row) > 2 and row[2].strip().replace('.','').isdigit() else None
            if week == 0 or total is None:
                continue
            records.append({
                "year": year, "week": week,
                "total": total,
                "date": epiweek_to_date(year, week),
            })
        except (ValueError, IndexError):
            continue
    return records


def parse_influenza_csv(content: str) -> list[dict]:
    """인플루엔자 ILI 지수 CSV 파싱
    포맷: 시즌명, 주차별 ILI 지수 (쉼표 구분)
    """
    records = []
    reader = csv.reader(StringIO(content))
    for row in reader:
        if not row:
            continue
        # 첫 컬럼에 시즌 정보 (예: "2025-2026시즌")
        season_match = re.search(r"(\d{4})-(\d{4})", row[0])
        if not season_match:
            continue
        year2 = int(season_match.group(2))
        # 나머지 값들이 주차별 ILI 지수
        values = []
        for cell in row[1:]:
            cell = cell.strip()
            if cell and cell.replace('.','').isdigit():
                values.append(float(cell))
            else:
                values.append(None)
        # 주차 번호 할당 (W36부터 시작하는 것이 일반적)
        start_week = 36
        for i, val in enumerate(values):
            if val is None:
                continue
            week = start_week + i
            actual_year = year2 - 1 if week >= start_week else year2
            if week > 52:
                week = week - 52
                actual_year = year2
            records.append({
                "year": actual_year, "week": week,
                "ili_index": val,
                "date": epiweek_to_date(actual_year, week),
            })
    return records


def parse_sari_csv(content: str) -> list[dict]:
    """중증급성호흡기감염증 SARI 건수 CSV 파싱"""
    records = []
    reader = csv.reader(StringIO(content))
    for row in reader:
        if not row:
            continue
        # 시즌 패턴 또는 건수가 첫 행에 오는 경우
        values = []
        for cell in row:
            cell = cell.strip()
            if cell and re.match(r"^\d+$", cell):
                values.append(int(cell))

        if not values:
            continue
        # 단순히 주차 순으로 배열됐다고 가정
        start_week = 36
        year = date.today().year
        for i, val in enumerate(values):
            week = start_week + i
            if week > 52:
                week = week - 52
            records.append({
                "year": year, "week": week,
                "sari_cases": val,
                "date": epiweek_to_date(year, week),
            })
    return records


def normalize_signal(value: float, min_val: float, max_val: float) -> float:
    """0~1 정규화"""
    if max_val == min_val:
        return 0.5
    return max(0.0, min(1.0, (value - min_val) / (max_val - min_val)))


def build_snapshot_from_records(
    ari_records: list[dict],
    ili_records: list[dict],
    sari_records: list[dict],
) -> dict[str, dict]:
    """수집된 레코드들을 날짜별 신호 딕셔너리로 변환"""
    date_signals: dict[str, dict] = {}

    # ARI 데이터 처리
    ari_totals = [r["total"] for r in ari_records if r.get("total")]
    ari_max = max(ari_totals) if ari_totals else 1000
    ari_min = min(ari_totals) if ari_totals else 0
    for r in ari_records:
        d = r["date"]
        if d not in date_signals:
            date_signals[d] = {}
        date_signals[d]["notifiable_disease"] = normalize_signal(r["total"], ari_min, ari_max)

    # ILI 데이터 처리
    ili_vals = [r["ili_index"] for r in ili_records if r.get("ili_index")]
    ili_max = max(ili_vals) if ili_vals else 100
    ili_min = min(ili_vals) if ili_vals else 0
    for r in ili_records:
        d = r["date"]
        if d not in date_signals:
            date_signals[d] = {}
        date_signals[d]["influenza_like"] = normalize_signal(r["ili_index"], ili_min, ili_max)

    # SARI 데이터 처리
    sari_vals = [r["sari_cases"] for r in sari_records if r.get("sari_cases")]
    sari_max = max(sari_vals) if sari_vals else 400
    sari_min = min(sari_vals) if sari_vals else 0
    for r in sari_records:
        d = r["date"]
        if d not in date_signals:
            date_signals[d] = {}
        date_signals[d]["sari"] = normalize_signal(r["sari_cases"], sari_min, sari_max)

    return date_signals


def update_snapshots(date_signals: dict[str, dict]) -> list[str]:
    """date_signals를 스냅샷 JSON에 적용합니다."""
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    updated_dates = []

    for snapshot_date, signals in date_signals.items():
        snapshot_path = SNAPSHOT_DIR / f"{snapshot_date}.json"

        if snapshot_path.exists():
            snapshot_data = json.loads(snapshot_path.read_text(encoding="utf-8"))
        else:
            # 가장 가까운 스냅샷을 기반으로 새 스냅샷 생성
            existing = sorted(SNAPSHOT_DIR.glob("*.json"))
            if existing:
                template = json.loads(existing[-1].read_text(encoding="utf-8"))
                import copy
                snapshot_data = copy.deepcopy(template)
                for reg in snapshot_data:
                    reg["date"] = snapshot_date
            else:
                continue

        # 각 지역 레코드의 signals 업데이트
        for reg in snapshot_data:
            if "signals" not in reg:
                reg["signals"] = {}
            for sig_key, sig_val in signals.items():
                # notifiable_disease, influenza_like는 지역별로 약간의 변동 추가
                import random
                variance = random.uniform(0.85, 1.15)
                reg["signals"][sig_key] = round(min(1.0, sig_val * variance), 4)

        snapshot_path.write_text(
            json.dumps(snapshot_data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        updated_dates.append(snapshot_date)

    return updated_dates


def record_upload_history(filename: str, file_type: str, updated_dates: list[str]) -> None:
    """업로드 이력 기록"""
    history = []
    if UPLOAD_HISTORY_FILE.exists():
        try:
            history = json.loads(UPLOAD_HISTORY_FILE.read_text(encoding="utf-8"))
        except Exception:
            history = []

    from datetime import datetime
    history.append({
        "filename": filename,
        "file_type": file_type,
        "uploaded_at": datetime.utcnow().isoformat(),
        "updated_dates": updated_dates,
        "snapshot_count": len(updated_dates),
    })

    # 최근 50건만 유지
    history = history[-50:]
    UPLOAD_HISTORY_FILE.write_text(
        json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def process_file(file_path: Path, content_bytes: bytes | None = None) -> dict[str, Any]:
    """단일 파일 처리. content_bytes가 있으면 직접 처리, 없으면 파일에서 읽음"""
    filename = file_path.name
    file_type = detect_file_type(filename)

    if not file_type:
        return {"success": False, "error": f"알 수 없는 파일 형식: {filename}"}

    try:
        if content_bytes is not None:
            raw_bytes = content_bytes
        else:
            raw_bytes = file_path.read_bytes()

        # 인코딩 감지 및 텍스트 변환
        for encoding in ["utf-8-sig", "utf-8", "cp949", "euc-kr"]:
            try:
                content = raw_bytes.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        else:
            # XLSX 처리
            if filename.endswith(".xlsx"):
                return _process_xlsx(filename, file_type, raw_bytes)
            return {"success": False, "error": "인코딩 변환 실패"}

        # CSV 파싱
        ari_records, ili_records, sari_records = [], [], []
        if file_type == "ari":
            ari_records = parse_ari_csv(content)
        elif file_type == "influenza":
            ili_records = parse_influenza_csv(content)
        elif file_type == "sari":
            sari_records = parse_sari_csv(content)

        date_signals = build_snapshot_from_records(ari_records, ili_records, sari_records)
        updated_dates = update_snapshots(date_signals)
        record_upload_history(filename, file_type, updated_dates)

        return {
            "success": True,
            "filename": filename,
            "file_type": file_type,
            "records_parsed": len(ari_records) + len(ili_records) + len(sari_records),
            "snapshots_updated": len(updated_dates),
            "updated_dates": updated_dates,
        }

    except Exception as e:
        return {"success": False, "filename": filename, "error": str(e)}


def _process_xlsx(filename: str, file_type: str, raw_bytes: bytes) -> dict:
    """XLSX 파일 처리"""
    try:
        import openpyxl
        wb = openpyxl.load_workbook(BytesIO(raw_bytes), data_only=True)
        # 첫 번째 시트에서 CSV처럼 읽기
        ws = wb.active
        rows = [[str(cell.value or "") for cell in row] for row in ws.iter_rows()]
        content = "\n".join(",".join(row) for row in rows)

        ari_records, ili_records, sari_records = [], [], []
        if file_type == "ari":
            ari_records = parse_ari_csv(content)
        elif file_type == "influenza":
            ili_records = parse_influenza_csv(content)
        elif file_type == "sari":
            sari_records = parse_sari_csv(content)

        date_signals = build_snapshot_from_records(ari_records, ili_records, sari_records)
        updated_dates = update_snapshots(date_signals)
        record_upload_history(filename, file_type, updated_dates)

        return {
            "success": True, "filename": filename, "file_type": file_type,
            "records_parsed": len(ari_records) + len(ili_records) + len(sari_records),
            "snapshots_updated": len(updated_dates),
            "updated_dates": updated_dates,
        }
    except Exception as e:
        return {"success": False, "filename": filename, "error": str(e)}


def scan_sentinel_data_dir() -> list[dict]:
    """SENTINEL_DATA_DIR 폴더를 스캔하여 미처리 파일을 찾아 처리합니다."""
    if not SENTINEL_DATA_DIR.exists():
        print(f"[KDCA] 데이터 폴더 없음: {SENTINEL_DATA_DIR}", file=sys.stderr)
        return []

    # 업로드 이력 로드
    processed_files = set()
    if UPLOAD_HISTORY_FILE.exists():
        try:
            history = json.loads(UPLOAD_HISTORY_FILE.read_text(encoding="utf-8"))
            processed_files = {h["filename"] for h in history}
        except Exception:
            pass

    results = []
    for ext in ["*.csv", "*.xlsx"]:
        for file_path in SENTINEL_DATA_DIR.glob(ext):
            if file_path.name in processed_files:
                continue
            if detect_file_type(file_path.name) is None:
                continue
            print(f"[KDCA] 처리 중: {file_path.name}")
            result = process_file(file_path)
            results.append(result)
            if result.get("success"):
                print(f"[KDCA] 완료: {result['snapshots_updated']}개 스냅샷 업데이트")
            else:
                print(f"[KDCA] 실패: {result.get('error')}", file=sys.stderr)

    return results


if __name__ == "__main__":
    import dotenv
    dotenv.load_dotenv(Path(__file__).parent.parent / ".env")
    results = scan_sentinel_data_dir()
    print(f"\n처리 완료: {len(results)}개 파일")
    for r in results:
        print(f"  - {r.get('filename')}: {'성공' if r.get('success') else '실패'}")
