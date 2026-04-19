"""fetch_global_news.py — NewsAPI 글로벌 호흡기 뉴스 수집 (호흡기 관련성 필터 포함)"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv
from newsapi import NewsApiClient

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
OUTPUT_FILE = PROCESSED_DIR / "global_news.json"

CONFIG_FILE = PROCESSED_DIR.parent / "keywords_config.json"

COUNTRY_COORDS: dict[str, tuple[float, float]] = {
    "china": (35.86, 104.19), "usa": (38.0, -97.0), "united states": (38.0, -97.0),
    "korea": (36.5, 127.5), "japan": (36.2, 138.25), "india": (20.59, 78.96),
    "vietnam": (14.06, 108.28), "thailand": (13.75, 100.5),
    "indonesia": (-0.79, 113.92), "philippines": (12.88, 121.77),
    "france": (46.23, 2.21), "germany": (51.16, 10.45),
    "uk": (55.38, -3.44), "united kingdom": (55.38, -3.44),
    "brazil": (-14.24, -51.93), "nigeria": (9.08, 8.68),
    "saudi arabia": (23.89, 45.08), "iran": (32.43, 53.69),
    "egypt": (26.82, 30.08),
    "cambodia": (12.57, 104.99), "pakistan": (30.38, 69.35),
    "mexico": (23.63, -102.55), "turkey": (38.96, 35.24),
    "australia": (-25.27, 133.78), "singapore": (1.35, 103.82),
    "malaysia": (4.21, 101.98), "bangladesh": (23.68, 90.36),
}

# 호흡기 관련성 후처리 필터
RESPIRATORY_FILTER = [
    "pneumonia", "respiratory", "influenza", "flu", "covid", "sars", "mers",
    "rsv", "avian", "mycoplasma", "legionella", "bronchitis", "tuberculosis",
    "outbreak", "epidemic", "lung", "infection", "virus", "pathogen",
    "hmpv", "metapneumovirus", "whooping cough", "pertussis",
]


def _get_queries() -> tuple[list[str], str]:
    if CONFIG_FILE.exists():
        try:
            config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            if "global_news" in config:
                queries = config["global_news"].get("queries", [])
                exclude = config["global_news"].get("exclude", "")
                return queries, exclude
        except Exception:
            pass
    return [
        "respiratory virus outbreak", "pneumonia cluster",
        "influenza surge global", "MERS outbreak",
        "avian influenza H5N1", "WHO respiratory emergency",
    ], "-journal -study -nature.com -plos -lancet -cureus -review -editorial"


def _make_id(url: str) -> str:
    return "news-" + hashlib.md5(url.encode()).hexdigest()[:10]


def _extract_coords(title: str, description: str) -> tuple[float, float]:
    text = (title + " " + (description or "")).lower()
    for country, coords in COUNTRY_COORDS.items():
        if country in text:
            return coords
    return (20.0, 0.0)


def _severity(title: str, description: str) -> str:
    text = (title + " " + (description or "")).lower()
    if any(w in text for w in ["outbreak", "emergency", "pandemic", "surge", "cluster", "epidemic"]):
        return "high"
    if any(w in text for w in ["increase", "rise", "cases", "reported", "confirmed", "spreading"]):
        return "medium"
    return "low"


def _is_respiratory_relevant(title: str, snippet: str) -> bool:
    """호흡기 관련성 필터 — 제목+본문에 호흡기 키워드 없으면 제외"""
    text = (title + " " + (snippet or "")).lower()
    return any(kw in text for kw in RESPIRATORY_FILTER)


def fetch_global_news() -> list[dict]:
    api_key = os.getenv("NEWS_API_KEY")
    if not api_key:
        print("[GlobalNews] NEWS_API_KEY 없음", file=sys.stderr)
        return []

    client = NewsApiClient(api_key=api_key)
    from_date = (datetime.utcnow() - timedelta(days=30)).strftime("%Y-%m-%d")
    results: list[dict] = []
    seen: set[str] = set()

    queries, exclude_str = _get_queries()

    for q in queries:
        search_q = f"{q} {exclude_str}".strip() if exclude_str else q
        try:
            response = client.get_everything(
                q=search_q,
                language="en",
                from_param=from_date,
                sort_by="publishedAt",
                page_size=10,
            )
            articles = response.get("articles", [])
            for art in articles:
                url = art.get("url", "")
                if not url or url in seen:
                    continue
                seen.add(url)
                title = art.get("title") or ""
                desc = art.get("description") or ""
                # 호흡기 관련성 필터
                if not _is_respiratory_relevant(title, desc):
                    continue
                pub_str = (art.get("publishedAt") or "")[:10]
                lat, lng = _extract_coords(title, desc)
                results.append({
                    "id": _make_id(url),
                    "source": "news_global",
                    "title": title,
                    "snippet": desc[:200] if desc else "",
                    "url": url,
                    "date": pub_str,
                    "publisher": (art.get("source") or {}).get("name", ""),
                    "severity": _severity(title, desc),
                    "lat": lat,
                    "lng": lng,
                })
        except Exception as e:
            print(f"[GlobalNews] 쿼리 '{q}' 실패: {e}", file=sys.stderr)

    results.sort(key=lambda x: x["date"], reverse=True)
    print(f"[GlobalNews] {len(results)}개 글로벌 뉴스 수집 완료")
    return results


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_global_news()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[GlobalNews] 저장 완료: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
