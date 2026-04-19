"""fetch_naver_trends.py — 네이버 데이터랩 검색어 트렌드 수집"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
OUTPUT_FILE = PROCESSED_DIR / "naver_trends_kr.json"
CONFIG_FILE = PROCESSED_DIR.parent / "keywords_config.json"

NAVER_DATALAB_URL = "https://openapi.naver.com/v1/datalab/search"

DEFAULT_KEYWORD_GROUPS = [
    {"groupName": "폐렴", "keywords": ["폐렴", "폐렴 증상", "폐렴 원인"]},
    {"groupName": "독감", "keywords": ["독감", "인플루엔자", "독감 증상"]},
    {"groupName": "기침", "keywords": ["기침", "마른기침", "가래"]},
    {"groupName": "호흡곤란", "keywords": ["호흡곤란", "숨가쁨", "호흡 어려움"]},
    {"groupName": "발열", "keywords": ["발열", "고열", "열나요"]},
]


def _get_keyword_groups() -> list[dict]:
    """keywords_config.json에서 네이버 트렌드 키워드 그룹을 로드합니다."""
    if CONFIG_FILE.exists():
        try:
            config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            groups = config.get("naver_trends", {}).get("queries", [])
            if groups:
                return groups
        except Exception:
            pass
    return DEFAULT_KEYWORD_GROUPS


def fetch_naver_trends() -> dict:
    """네이버 데이터랩 API로 호흡기 검색 트렌드를 수집합니다."""
    client_id = os.getenv("NAVER_CLIENT_ID")
    client_secret = os.getenv("NAVER_CLIENT_SECRET")

    if not client_id or not client_secret:
        print("[NaverTrends] NAVER_CLIENT_ID 또는 NAVER_CLIENT_SECRET 없음", file=sys.stderr)
        return {
            "keywords": [],
            "geo": "KR",
            "source": "naver",
            "series": [],
            "fetched_at": datetime.utcnow().isoformat(),
            "error": "Naver API credentials not configured",
        }

    keyword_groups = _get_keyword_groups()
    end_date = datetime.utcnow().strftime("%Y-%m-%d")
    start_date = (datetime.utcnow() - timedelta(days=30)).strftime("%Y-%m-%d")

    headers = {
        "X-Naver-Client-Id": client_id,
        "X-Naver-Client-Secret": client_secret,
        "Content-Type": "application/json",
    }

    # 네이버 API는 한 번에 최대 5개 keywordGroups 지원 → 5개씩 나눠서 호출
    all_api_results = []
    for batch_start in range(0, len(keyword_groups), 5):
        batch = keyword_groups[batch_start:batch_start + 5]
        body = {
            "startDate": start_date,
            "endDate": end_date,
            "timeUnit": "date",
            "keywordGroups": [
                {"groupName": g["groupName"], "keywords": g["keywords"]}
                for g in batch
            ],
        }

        try:
            resp = httpx.post(
                NAVER_DATALAB_URL,
                headers=headers,
                json=body,
                timeout=20,
            )
            resp.raise_for_status()
            data = resp.json()
            all_api_results.extend(data.get("results", []))
        except Exception as e:
            print(f"[NaverTrends] API 호출 실패 (batch {batch_start}): {e}", file=sys.stderr)

    if not all_api_results:
        return {
            "keywords": [g["groupName"] for g in keyword_groups],
            "geo": "KR",
            "source": "naver",
            "series": [],
            "fetched_at": datetime.utcnow().isoformat(),
            "error": "All API calls failed",
        }

    # 응답 파싱 → Google Trends와 동일한 구조로 변환
    all_series = []
    results = all_api_results

    # ratio 값의 최대값을 구해서 0-100 스케일로 정규화
    max_ratio = 0.0
    for result in results:
        for pt in result.get("data", []):
            r = pt.get("ratio", 0)
            if r > max_ratio:
                max_ratio = r

    for result in results:
        keyword = result.get("title", "")
        points = []
        for pt in result.get("data", []):
            period = pt.get("period", "")
            ratio = pt.get("ratio", 0)
            # 0-100 스케일로 정규화
            normalized = round((ratio / max_ratio) * 100) if max_ratio > 0 else 0
            points.append({"date": period, "value": normalized})
        all_series.append({"keyword": keyword, "points": points})

    keywords = [g["groupName"] for g in keyword_groups]
    print(f"[NaverTrends] {len(all_series)}개 키워드 수집 완료 ({start_date} ~ {end_date})")

    return {
        "keywords": keywords,
        "geo": "KR",
        "source": "naver",
        "series": all_series,
        "fetched_at": datetime.utcnow().isoformat(),
    }


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_naver_trends()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[NaverTrends] 저장 완료: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
