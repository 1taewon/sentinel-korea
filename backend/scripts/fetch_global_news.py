"""Fetch overseas respiratory outbreak news from NewsAPI and Google News RSS."""
from __future__ import annotations

import hashlib
import html
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote_plus
from xml.etree import ElementTree as ET

import httpx
from dotenv import load_dotenv
from newsapi import NewsApiClient

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
OUTPUT_FILE = PROCESSED_DIR / "global_news.json"
CONFIG_FILE = PROCESSED_DIR.parent / "keywords_config.json"
GOOGLE_NEWS_RSS = "https://news.google.com/rss/search"

COUNTRY_COORDS: dict[str, tuple[float, float]] = {
    "china": (35.86, 104.19), "usa": (38.0, -97.0), "united states": (38.0, -97.0),
    "korea": (36.5, 127.5), "japan": (36.2, 138.25), "india": (20.59, 78.96),
    "vietnam": (14.06, 108.28), "thailand": (13.75, 100.5),
    "indonesia": (-0.79, 113.92), "philippines": (12.88, 121.77),
    "france": (46.23, 2.21), "germany": (51.16, 10.45),
    "uk": (55.38, -3.44), "united kingdom": (55.38, -3.44),
    "brazil": (-14.24, -51.93), "nigeria": (9.08, 8.68),
    "kenya": (-0.02, 37.91), "south africa": (-30.56, 22.94),
    "saudi arabia": (23.89, 45.08), "iran": (32.43, 53.69),
    "egypt": (26.82, 30.08), "cambodia": (12.57, 104.99),
    "pakistan": (30.38, 69.35), "mexico": (23.63, -102.55),
    "turkey": (38.96, 35.24), "australia": (-25.27, 133.78),
    "singapore": (1.35, 103.82), "malaysia": (4.21, 101.98),
    "bangladesh": (23.68, 90.36), "new zealand": (-40.90, 174.89),
    "canada": (56.13, -106.35), "peru": (-9.19, -75.02),
}

RESPIRATORY_FILTER = [
    "pneumonia", "respiratory", "influenza", "flu", "covid", "sars", "mers",
    "rsv", "avian", "mycoplasma", "legionella", "bronchitis", "tuberculosis",
    "outbreak", "epidemic", "lung", "infection", "virus", "pathogen",
    "hmpv", "metapneumovirus", "whooping cough", "pertussis", "h5n1",
]

DEFAULT_QUERIES = [
    "respiratory virus outbreak",
    "pneumonia cluster",
    "influenza surge",
    "avian influenza H5N1 outbreak",
    "MERS outbreak",
    "RSV wave",
    "COVID new variant",
    "mycoplasma pneumonia outbreak",
    "WHO respiratory emergency",
]


def _get_queries() -> tuple[list[str], str]:
    if CONFIG_FILE.exists():
        try:
            config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            if "global_news" in config:
                queries = config["global_news"].get("queries", [])
                exclude = config["global_news"].get("exclude", "")
                if queries:
                    return queries, exclude
        except Exception:
            pass
    return DEFAULT_QUERIES, "-journal -study -nature.com -plos -lancet -cureus -review -editorial"


def _clean(value: str | None) -> str:
    if not value:
        return ""
    text = html.unescape(value)
    text = " ".join(text.split())
    return text


def _make_id(url: str) -> str:
    return "news-" + hashlib.md5(url.encode()).hexdigest()[:10]


def _extract_coords(title: str, description: str) -> tuple[float, float]:
    text = f"{title} {description}".lower()
    for country, coords in COUNTRY_COORDS.items():
        if country in text:
            return coords
    return (20.0, 0.0)


def _severity(title: str, description: str) -> str:
    text = f"{title} {description}".lower()
    if any(w in text for w in ["outbreak", "emergency", "pandemic", "surge", "cluster", "epidemic"]):
        return "high"
    if any(w in text for w in ["increase", "rise", "cases", "reported", "confirmed", "spreading"]):
        return "medium"
    return "low"


def _is_respiratory_relevant(title: str, snippet: str) -> bool:
    text = f"{title} {snippet}".lower()
    return any(keyword in text for keyword in RESPIRATORY_FILTER)


def _append_result(
    results: list[dict],
    seen: set[str],
    *,
    source: str,
    title: str,
    snippet: str,
    url: str,
    date: str,
    publisher: str,
) -> None:
    if not title or not url or url in seen:
        return
    if not _is_respiratory_relevant(title, snippet):
        return
    seen.add(url)
    lat, lng = _extract_coords(title, snippet)
    results.append({
        "id": _make_id(url),
        "source": source,
        "title": title,
        "snippet": snippet[:220],
        "url": url,
        "date": date,
        "publisher": publisher,
        "severity": _severity(title, snippet),
        "lat": lat,
        "lng": lng,
    })


def _fetch_newsapi(queries: list[str], exclude_str: str, seen: set[str]) -> list[dict]:
    api_key = os.getenv("NEWS_API_KEY")
    if not api_key:
        print("[GlobalNews] NEWS_API_KEY missing; skipping NewsAPI", file=sys.stderr)
        return []

    client = NewsApiClient(api_key=api_key)
    from_date = (datetime.utcnow() - timedelta(days=30)).strftime("%Y-%m-%d")
    results: list[dict] = []
    for query in queries:
        search_q = f"{query} {exclude_str}".strip() if exclude_str else query
        try:
            response = client.get_everything(
                q=search_q,
                language="en",
                from_param=from_date,
                sort_by="publishedAt",
                page_size=12,
            )
            for article in response.get("articles", []):
                _append_result(
                    results,
                    seen,
                    source="news_global",
                    title=_clean(article.get("title") or ""),
                    snippet=_clean(article.get("description") or ""),
                    url=article.get("url") or "",
                    date=(article.get("publishedAt") or "")[:10],
                    publisher=(article.get("source") or {}).get("name", ""),
                )
        except Exception as exc:
            print(f"[GlobalNews] NewsAPI query '{query}' failed: {exc}", file=sys.stderr)
    return results


def _fetch_google_news(queries: list[str], seen: set[str]) -> list[dict]:
    results: list[dict] = []
    for query in queries:
        try:
            rss_url = f"{GOOGLE_NEWS_RSS}?q={quote_plus(query + ' when:30d')}&hl=en-US&gl=US&ceid=US:en"
            response = httpx.get(rss_url, follow_redirects=True, timeout=20)
            response.raise_for_status()
            root = ET.fromstring(response.content)
            for item in root.findall(".//item")[:14]:
                title = _clean(item.findtext("title"))
                url = item.findtext("link") or ""
                snippet = _clean(item.findtext("description"))
                pub_date = item.findtext("pubDate") or ""
                try:
                    date = datetime.strptime(pub_date[:25], "%a, %d %b %Y %H:%M:%S").strftime("%Y-%m-%d")
                except ValueError:
                    date = datetime.utcnow().strftime("%Y-%m-%d")
                publisher = title.rsplit(" - ", 1)[-1] if " - " in title else "Google News"
                _append_result(
                    results,
                    seen,
                    source="google_news",
                    title=title,
                    snippet=snippet,
                    url=url,
                    date=date,
                    publisher=publisher,
                )
        except Exception as exc:
            print(f"[GlobalNews] Google News RSS query '{query}' failed: {exc}", file=sys.stderr)
    return results


def fetch_global_news() -> list[dict]:
    queries, exclude_str = _get_queries()
    seen: set[str] = set()
    results = [
        *_fetch_newsapi(queries, exclude_str, seen),
        *_fetch_google_news(queries, seen),
    ]
    results.sort(key=lambda row: row["date"], reverse=True)
    print(
        f"[GlobalNews] collected {len(results)} overseas news "
        f"(NewsAPI {sum(1 for row in results if row['source'] == 'news_global')}, "
        f"Google News {sum(1 for row in results if row['source'] == 'google_news')})"
    )
    return results


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_global_news()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[GlobalNews] saved: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
