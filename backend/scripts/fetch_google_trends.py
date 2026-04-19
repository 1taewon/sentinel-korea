"""fetch_google_trends.py — pytrends 기반 호흡기 검색 트렌드 수집 (영문 키워드, geo=KR)"""
from __future__ import annotations

import json
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


def _fetch_trends(keywords: list[str], geo: str, label: str) -> dict:
    """pytrends로 주간 트렌드 데이터를 수집합니다."""
    try:
        from pytrends.request import TrendReq
        pt = TrendReq(hl="en-US", tz=540 if geo == "KR" else 0)
        all_series = []
        # pytrends는 한 번에 최대 5개 키워드만 지원
        for i in range(0, len(keywords), 5):
            chunk = keywords[i:i + 5]
            try:
                pt.build_payload(chunk, cat=0, timeframe="today 3-m", geo=geo)
                df = pt.interest_over_time()
                if df.empty:
                    print(f"[Trends/{label}] 키워드 {chunk} 데이터 없음", file=sys.stderr)
                    continue
                for kw in chunk:
                    if kw not in df.columns:
                        continue
                    points = [
                        {"date": idx.strftime("%Y-%m-%d"), "value": int(row[kw])}
                        for idx, row in df.iterrows()
                    ]
                    all_series.append({"keyword": kw, "points": points})
                time.sleep(2)
            except Exception as e:
                print(f"[Trends/{label}] 청크 {chunk} 실패: {e}", file=sys.stderr)

        if not all_series:
            return {
                "keywords": keywords, "geo": geo, "series": [],
                "fetched_at": datetime.utcnow().isoformat(),
                "error": "No data returned",
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

    print("[Trends] 한국 트렌드 수집 중...")
    kr_data = fetch_korea_trends()
    OUTPUT_KR.write_text(json.dumps(kr_data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[Trends] 한국 저장 완료: {OUTPUT_KR}")

    time.sleep(3)

    print("[Trends] 글로벌 트렌드 수집 중...")
    global_data = fetch_global_trends()
    OUTPUT_GLOBAL.write_text(json.dumps(global_data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[Trends] 글로벌 저장 완료: {OUTPUT_GLOBAL}")


if __name__ == "__main__":
    main()
