"""fetch_korea_news.py — NewsAPI 한국 호흡기 뉴스 수집 (영어 전용)

NOTE: NewsAPI free tier는 language="ko"를 지원하지 않음.
      영어 쿼리만 사용하되, 한국 관련 호흡기 뉴스를 최대한 수집합니다.
"""
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
OUTPUT_FILE = PROCESSED_DIR / "korea_news.json"

CONFIG_FILE = PROCESSED_DIR.parent / "keywords_config.json"

RESPIRATORY_KEYWORDS_EN = [
    "pneumonia", "respiratory", "influenza", "flu", "covid", "sars", "mers",
    "rsv", "avian", "mycoplasma", "legionella", "bronchitis", "tuberculosis",
    "outbreak", "epidemic", "cough", "fever", "infection", "virus",
    "korea", "kdca", "korean", "who ", "cdc ", "disease",
]

# 시장조사/학술 노이즈 필터 — 이 키워드 포함하면 제외
NOISE_KEYWORDS = [
    "market size", "market research", "market report", "forecast",
    "billion", "million usd", "cagr", "revenue", "investment",
    "stock", "share price", "nasdaq", "ipo",
    "patent", "clinical trial phase",
]

# 영어 쿼리 — 네이버 뉴스가 한국어를 커버하므로 영어 보완
DEFAULT_QUERIES_EN = [
    "pneumonia Korea",
    "respiratory outbreak South Korea",
    "influenza Korea",
    "COVID Korea",
    "KDCA warning",
    "mycoplasma Korea",
    "RSV Korea",
]
DEFAULT_EXCLUDE_EN = "-journal -study -nature.com -plos -lancet -review -editorial -cureus"


def _get_queries() -> dict:
    """Return English-only queries and exclusions from config."""
    if CONFIG_FILE.exists():
        try:
            config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            kn = config.get("korea_news", {})
            queries = kn.get("queries_en", kn.get("queries", DEFAULT_QUERIES_EN))
            exclude = kn.get("exclude_en", kn.get("exclude", DEFAULT_EXCLUDE_EN))
            return {"queries_en": queries, "exclude_en": exclude}
        except Exception:
            pass
    return {"queries_en": DEFAULT_QUERIES_EN, "exclude_en": DEFAULT_EXCLUDE_EN}


def _make_id(url: str) -> str:
    return "kr-news-" + hashlib.md5(url.encode()).hexdigest()[:10]


def _severity(title: str, desc: str) -> str:
    text = (title + " " + (desc or "")).lower()
    if any(w in text for w in ["outbreak", "surge", "emergency", "epidemic", "crisis", "alert"]):
        return "high"
    if any(w in text for w in ["reported", "confirmed", "increase", "rise", "spread", "cases"]):
        return "medium"
    return "low"


def _is_noise(title: str, desc: str) -> bool:
    """시장조사/학술 노이즈 판별"""
    text = (title + " " + (desc or "")).lower()
    return any(noise in text for noise in NOISE_KEYWORDS)


def _is_respiratory(title: str, desc: str) -> bool:
    """호흡기 관련성 필터"""
    text = (title + " " + (desc or "")).lower()
    return any(kw in text for kw in RESPIRATORY_KEYWORDS_EN)


def fetch_korea_news(extra_queries: list[str] | None = None) -> list[dict]:
    api_key = os.getenv("NEWS_API_KEY")
    if not api_key:
        print("[KoreaNews] NEWS_API_KEY not found", file=sys.stderr)
        return []

    cfg = _get_queries()
    queries = list(cfg["queries_en"])
    exclude_str = cfg["exclude_en"]
    if extra_queries:
        queries.extend([q for q in extra_queries if q not in queries])

    client = NewsApiClient(api_key=api_key)
    from_date = (datetime.utcnow() - timedelta(days=29)).strftime("%Y-%m-%d")
    seen: set[str] = set()
    results: list[dict] = []

    for q in queries:
        search_q = f"{q} {exclude_str}".strip() if exclude_str else q
        try:
            resp = client.get_everything(
                q=search_q, language="en", from_param=from_date,
                sort_by="publishedAt", page_size=15,
            )
            for art in resp.get("articles", []):
                url = art.get("url", "")
                if not url or url in seen:
                    continue
                seen.add(url)
                title = art.get("title") or ""
                desc = art.get("description") or ""
                if not _is_respiratory(title, desc):
                    continue
                noise = _is_noise(title, desc)
                results.append({
                    "id": _make_id(url),
                    "source": "news_korea",
                    "language": "en",
                    "title": title,
                    "snippet": desc[:300] if desc else "",
                    "url": url,
                    "date": (art.get("publishedAt") or "")[:10],
                    "publisher": (art.get("source") or {}).get("name", ""),
                    "severity": "low" if noise else _severity(title, desc),
                    "is_respiratory": not noise,
                    "lat": 36.5, "lng": 127.5,
                })
        except Exception as e:
            print(f"[KoreaNews] Query '{q}' failed: {e}", file=sys.stderr)

    # 실제 호흡기 뉴스 우선, 노이즈(시장조사) 후순위
    results.sort(key=lambda x: (not x["is_respiratory"], x["date"]), reverse=False)
    results.sort(key=lambda x: (x["is_respiratory"], x["date"]), reverse=True)
    print(f"[KoreaNews] Total: {len(results)} articles collected (EN only)")
    return results


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_korea_news()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[KoreaNews] Saved: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
