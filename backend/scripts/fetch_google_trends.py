"""fetch_google_trends.py — pytrends 기반 호흡기 검색 트렌드 수집 (영문 키워드, geo=KR)

429 Rate Limit 대응:
  - 청크 간 10~20초 랜덤 딜레이 (봇 패턴 회피)
  - 429 발생 시 최대 3회 지수 백오프 재시도 (30s → 60s → 120s)
  - 요청마다 새 TrendReq 세션 생성 (쿠키/세션 초기화)
  - 실패 시 기존 캐시 파일 유지 (빈 데이터로 덮어쓰지 않음)
"""
from __future__ import annotations

import json
import random
import sys
import time
from datetime import datetime
from pathlib import Path

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
OUTPUT_KR = PROCESSED_DIR / "google_trends_kr.json"
OUTPUT_GLOBAL = PROCESSED_DIR / "google_trends_global.json"

# 기본 키워드 (영문 사용 — pytrends 한국어 키워드 400 에러 방지)
DEFAULT_KR_KEYWORDS = ["pneumonia", "respiratory symptoms", "flu", "influenza", "cough", "fever", "dyspnea"]
DEFAULT_GLOBAL_KEYWORDS = ["pneumonia", "respiratory virus", "influenza", "MERS", "avian flu"]

# --- Rate Limit 대응 설정 ---
CHUNK_DELAY_MIN = 10       # 청크 간 최소 대기 (초)
CHUNK_DELAY_MAX = 20       # 청크 간 최대 대기 (초)
MAX_RETRIES = 3            # 429 발생 시 최대 재시도 횟수
BACKOFF_BASE = 30          # 첫 재시도 대기 (초), 이후 x2 증가
BETWEEN_GEO_DELAY_MIN = 15 # Korea→Global 간 최소 대기
BETWEEN_GEO_DELAY_MAX = 30 # Korea→Global 간 최대 대기


def _new_session(geo: str):
    """매 요청마다 새 TrendReq 세션 생성 — 쿠키/세션 초기화로 429 회피."""
    from pytrends.request import TrendReq
    return TrendReq(
        hl="en-US",
        tz=540 if geo == "KR" else 0,
        retries=2,
        backoff_factor=0.5,
        requests_args={
            "headers": {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/125.0.0.0 Safari/537.36"
                ),
            },
        },
    )


def _fetch_chunk_with_retry(chunk: list[str], geo: str, label: str) -> list[dict] | None:
    """단일 청크를 429 백오프 재시도로 수집합니다."""
    for attempt in range(MAX_RETRIES + 1):
        try:
            pt = _new_session(geo)
            pt.build_payload(chunk, cat=0, timeframe="today 3-m", geo=geo)
            df = pt.interest_over_time()
            if df.empty:
                print(f"[Trends/{label}] 키워드 {chunk} 데이터 없음", file=sys.stderr)
                return []
            series = []
            for kw in chunk:
                if kw not in df.columns:
                    continue
                points = [
                    {"date": idx.strftime("%Y-%m-%d"), "value": int(row[kw])}
                    for idx, row in df.iterrows()
                ]
                series.append({"keyword": kw, "points": points})
            return series

        except Exception as e:
            err_str = str(e)
            is_rate_limit = "429" in err_str or "Too Many Requests" in err_str

            if is_rate_limit and attempt < MAX_RETRIES:
                wait = BACKOFF_BASE * (2 ** attempt) + random.uniform(0, 10)
                print(
                    f"[Trends/{label}] 청크 {chunk} 429 Rate Limit — "
                    f"재시도 {attempt + 1}/{MAX_RETRIES}, {wait:.0f}초 대기...",
                    file=sys.stderr,
                )
                time.sleep(wait)
            else:
                tag = "429 Rate Limit (재시도 소진)" if is_rate_limit else "에러"
                print(f"[Trends/{label}] 청크 {chunk} {tag}: {e}", file=sys.stderr)
                return None
    return None


def _fetch_trends(keywords: list[str], geo: str, label: str) -> dict:
    """pytrends로 주간 트렌드 데이터를 수집합니다."""
    try:
        all_series = []
        chunks = [keywords[i:i + 5] for i in range(0, len(keywords), 5)]

        for idx, chunk in enumerate(chunks):
            result = _fetch_chunk_with_retry(chunk, geo, label)
            if result is not None:
                all_series.extend(result)

            # 마지막 청크가 아니면 랜덤 딜레이
            if idx < len(chunks) - 1:
                delay = random.uniform(CHUNK_DELAY_MIN, CHUNK_DELAY_MAX)
                print(f"[Trends/{label}] 다음 청크까지 {delay:.0f}초 대기...", file=sys.stderr)
                time.sleep(delay)

        if not all_series:
            return {
                "keywords": keywords, "geo": geo, "series": [],
                "fetched_at": datetime.utcnow().isoformat(),
                "error": "No data returned (all chunks failed or empty)",
            }

        print(f"[Trends/{label}] {len(all_series)}개 키워드 수집 완료")
        return {
            "keywords": keywords,
            "geo": geo,
            "series": all_series,
            "fetched_at": datetime.utcnow().isoformat(),
        }
    except Exception as e:
        print(f"[Trends/{label}] 수집 실패: {e}", file=sys.stderr)
        return {
            "keywords": keywords, "geo": geo, "series": [],
            "fetched_at": datetime.utcnow().isoformat(),
            "error": str(e),
        }


def _load_cached(path: Path) -> dict | None:
    """기존 캐시 데이터가 있으면 로드. 수집 실패 시 fallback용."""
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("series"):
                return data
        except Exception:
            pass
    return None


def fetch_korea_trends(extra_keywords: list[str] | None = None) -> dict:
    kw = list(DEFAULT_KR_KEYWORDS)
    if extra_keywords:
        kw.extend([k for k in extra_keywords if k not in kw])
    return _fetch_trends(kw, "KR", "Korea")


def fetch_global_trends(extra_keywords: list[str] | None = None) -> dict:
    kw = list(DEFAULT_GLOBAL_KEYWORDS)
    if extra_keywords:
        kw.extend([k for k in extra_keywords if k not in kw])
    return _fetch_trends(kw, "", "Global")


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

    # --- 한국 트렌드 ---
    print("[Trends] 한국 트렌드 수집 중...")
    kr_data = fetch_korea_trends()
    if kr_data.get("series"):
        OUTPUT_KR.write_text(json.dumps(kr_data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[Trends] 한국 저장 완료: {OUTPUT_KR}")
    else:
        cached = _load_cached(OUTPUT_KR)
        if cached:
            print(f"[Trends] 한국 수집 실패 — 기존 캐시 유지 (fetched_at: {cached.get('fetched_at', '?')})")
        else:
            OUTPUT_KR.write_text(json.dumps(kr_data, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[Trends] 한국 수집 실패, 캐시도 없음: {kr_data.get('error', 'unknown')}")

    # --- Korea→Global 간 충분한 대기 ---
    geo_delay = random.uniform(BETWEEN_GEO_DELAY_MIN, BETWEEN_GEO_DELAY_MAX)
    print(f"[Trends] Korea→Global 전환 대기 {geo_delay:.0f}초...")
    time.sleep(geo_delay)

    # --- 글로벌 트렌드 ---
    print("[Trends] 글로벌 트렌드 수집 중...")
    global_data = fetch_global_trends()
    if global_data.get("series"):
        OUTPUT_GLOBAL.write_text(json.dumps(global_data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[Trends] 글로벌 저장 완료: {OUTPUT_GLOBAL}")
    else:
        cached = _load_cached(OUTPUT_GLOBAL)
        if cached:
            print(f"[Trends] 글로벌 수집 실패 — 기존 캐시 유지 (fetched_at: {cached.get('fetched_at', '?')})")
        else:
            OUTPUT_GLOBAL.write_text(json.dumps(global_data, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[Trends] 글로벌 수집 실패, 캐시도 없음: {global_data.get('error', 'unknown')}")


if __name__ == "__main__":
    main()
