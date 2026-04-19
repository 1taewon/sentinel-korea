"""fetch_naver_news.py — 네이버 검색 API를 이용한 한국 호흡기/폐렴 뉴스 수집

네이버 오픈API(뉴스 검색)를 통해 한국어 호흡기 관련 뉴스를 수집하고,
관련성 필터링 및 심각도 분류를 수행합니다.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx
from dotenv import load_dotenv

# ── 경로 설정 ──────────────────────────────────────────────────────────────
BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")

CONFIG_FILE = BACKEND_DIR / "data" / "keywords_config.json"
PROCESSED_DIR = BACKEND_DIR / "data" / "processed"
OUTPUT_FILE = PROCESSED_DIR / "naver_news_kr.json"

# ── Naver API ──────────────────────────────────────────────────────────────
NAVER_SEARCH_URL = "https://openapi.naver.com/v1/search/news.json"

# ── 기본 한국어 쿼리 ───────────────────────────────────────────────────────
DEFAULT_QUERIES_KO = [
    "폐렴 유행",
    "마이코플라스마 폐렴",
    "호흡기 감염병",
    "독감 유행",
    "코로나 확산",
    "RSV 유행",
    "호흡기질환 증가",
]

# ── 호흡기 관련성 키워드 ───────────────────────────────────────────────────
RESPIRATORY_KEYWORDS_KO = [
    "폐렴", "호흡기", "인플루엔자", "독감", "코로나", "감염", "유행",
    "확산", "발열", "기침", "결핵", "마이코플라스마", "RSV", "바이러스",
    "메르스", "사스",
]

# ── 심각도 분류 키워드 ────────────────────────────────────────────────────
SEVERITY_HIGH = ["유행", "확산", "급증", "비상", "경보"]
SEVERITY_MEDIUM = ["증가", "발생", "상승", "주의"]

# ── HTML 태그 제거 정규식 ─────────────────────────────────────────────────
_RE_HTML = re.compile(r"<[^>]+>")
_RE_ENTITY = re.compile(r"&(?:quot|amp|lt|gt|apos|#\d+|#x[\da-fA-F]+);")


def _strip_html(text: str) -> str:
    """네이버 검색 결과의 HTML 태그(<b> 등)와 엔티티를 제거한다."""
    text = _RE_HTML.sub("", text)
    text = text.replace("&quot;", '"')
    text = text.replace("&amp;", "&")
    text = text.replace("&lt;", "<")
    text = text.replace("&gt;", ">")
    text = text.replace("&apos;", "'")
    # 남은 숫자 엔티티 등 정리
    text = _RE_ENTITY.sub("", text)
    return text.strip()


def _get_queries() -> list[str]:
    """keywords_config.json에서 한국어 쿼리 목록을 읽어온다."""
    if CONFIG_FILE.exists():
        try:
            config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            queries = config.get("korea_news", {}).get("queries_ko")
            if queries and isinstance(queries, list):
                return queries
        except Exception:
            pass
    return DEFAULT_QUERIES_KO


def _make_id(url: str) -> str:
    """URL 기반 고유 ID 생성."""
    return "naver-news-" + hashlib.md5(url.encode()).hexdigest()[:10]


def _parse_pub_date(pub_date: str) -> str:
    """네이버 pubDate 형식을 YYYY-MM-DD로 변환한다.

    네이버 형식 예: "Mon, 07 Apr 2026 10:30:00 +0900"
    """
    try:
        dt = parsedate_to_datetime(pub_date)
        return dt.strftime("%Y-%m-%d")
    except Exception:
        return datetime.now().strftime("%Y-%m-%d")


def _is_respiratory(title: str, description: str) -> bool:
    """호흡기 관련성 필터."""
    text = title + " " + description
    return any(kw in text for kw in RESPIRATORY_KEYWORDS_KO)


def _classify_severity(title: str, description: str) -> str:
    """심각도 분류: high / medium / low."""
    text = title + " " + description
    if any(kw in text for kw in SEVERITY_HIGH):
        return "high"
    if any(kw in text for kw in SEVERITY_MEDIUM):
        return "medium"
    return "low"


def fetch_naver_news(extra_queries: list[str] | None = None) -> list[dict]:
    """네이버 뉴스 검색 API를 호출하여 호흡기 관련 뉴스를 수집한다."""
    client_id = os.getenv("NAVER_CLIENT_ID")
    client_secret = os.getenv("NAVER_CLIENT_SECRET")

    if not client_id or not client_secret:
        print(
            "[NaverNews] NAVER_CLIENT_ID 또는 NAVER_CLIENT_SECRET이 설정되지 않았습니다.",
            file=sys.stderr,
        )
        return []

    headers = {
        "X-Naver-Client-Id": client_id,
        "X-Naver-Client-Secret": client_secret,
    }

    queries = _get_queries()
    if extra_queries:
        queries = queries + [q for q in extra_queries if q not in queries]

    seen_urls: set[str] = set()
    results: list[dict] = []

    with httpx.Client(timeout=15.0) as http:
        for query in queries:
            try:
                resp = http.get(
                    NAVER_SEARCH_URL,
                    headers=headers,
                    params={
                        "query": query,
                        "display": 30,
                        "start": 1,
                        "sort": "date",
                    },
                )
                resp.raise_for_status()
                data = resp.json()
            except httpx.HTTPStatusError as e:
                print(
                    f"[NaverNews] 쿼리 '{query}' HTTP 에러: {e.response.status_code}",
                    file=sys.stderr,
                )
                continue
            except Exception as e:
                print(f"[NaverNews] 쿼리 '{query}' 실패: {e}", file=sys.stderr)
                continue

            for item in data.get("items", []):
                url = item.get("originallink") or item.get("link", "")
                if not url or url in seen_urls:
                    continue
                seen_urls.add(url)

                title = _strip_html(item.get("title", ""))
                description = _strip_html(item.get("description", ""))

                if not _is_respiratory(title, description):
                    continue

                pub_date = _parse_pub_date(item.get("pubDate", ""))

                results.append({
                    "id": _make_id(url),
                    "source": "naver_news",
                    "language": "ko",
                    "title": title,
                    "snippet": description[:300] if description else "",
                    "url": url,
                    "date": pub_date,
                    "publisher": _strip_html(item.get("source", "")),
                    "severity": _classify_severity(title, description),
                    "is_respiratory": True,
                    "lat": 36.5,
                    "lng": 127.5,
                })

    # 최신 기사 우선, 심각도 높은 것 우선
    severity_order = {"high": 0, "medium": 1, "low": 2}
    results.sort(key=lambda x: (severity_order.get(x["severity"], 2), x["date"]))
    results.sort(key=lambda x: x["date"], reverse=True)

    print(f"[NaverNews] 총 {len(results)}건 수집 완료")
    return results


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_naver_news()
    OUTPUT_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"[NaverNews] 저장: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
