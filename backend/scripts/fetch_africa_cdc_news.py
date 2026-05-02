"""Fetch Africa CDC outbreak / weekly bulletin news.

Primary: Africa CDC RSS feed (WordPress).
Fallback: news page scrape + Google News.
6-month cutoff. Standard outbreak item schema.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from bs4 import BeautifulSoup

from _outbreak_common import (
    LOOKBACK_DAYS,
    clean_text,
    dedupe_by_id,
    fetch_google_news_rss,
    log,
    normalize_item,
    parse_rss_feed,
)

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
OUTPUT_FILE = PROCESSED_DIR / "global_africa_cdc.json"

SOURCE_TAG = "africa_cdc"
PUBLISHER = "Africa CDC"
ID_PREFIX = "africacdc"

PRIMARY_FEEDS: list[str] = [
    "https://africacdc.org/feed/",
    "https://africacdc.org/news/feed/",
]
FALLBACK_PAGE = "https://africacdc.org/news/"


def _from_rss(items: list[dict[str, str]], cutoff: datetime) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in items:
        normalized = normalize_item(
            source=SOURCE_TAG,
            publisher=PUBLISHER,
            title=item.get("title", ""),
            body=item.get("description", ""),
            url=item.get("link", ""),
            date_str=item.get("pubDate", ""),
            cutoff_date=cutoff,
            id_prefix=ID_PREFIX,
        )
        if normalized:
            out.append(normalized)
    return out


def _scrape_fallback(cutoff: datetime) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    try:
        resp = httpx.get(FALLBACK_PAGE, headers={"User-Agent": "SentinelKorea/1.0 (research)"}, follow_redirects=True, timeout=20)
        resp.raise_for_status()
    except Exception as exc:
        log("AfricaCDC Scraper", f"failed: {exc}")
        return out

    soup = BeautifulSoup(resp.text, "html.parser")
    for link in soup.find_all("a", href=True):
        href = link["href"]
        if "/news-item/" not in href:
            continue
        title = clean_text(link.get_text(" ", strip=True))
        if len(title) < 12:
            continue
        url = href if href.startswith("http") else f"https://africacdc.org{href}"
        normalized = normalize_item(
            source=SOURCE_TAG,
            publisher=PUBLISHER,
            title=title,
            body="",
            url=url,
            date_str=datetime.utcnow().strftime("%Y-%m-%d"),
            cutoff_date=cutoff,
            id_prefix=ID_PREFIX,
        )
        if normalized:
            out.append(normalized)
    return out


def fetch_africa_cdc_news() -> list[dict[str, Any]]:
    cutoff = datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)
    results: list[dict[str, Any]] = []

    for feed in PRIMARY_FEEDS:
        items = parse_rss_feed(feed, log_tag="AfricaCDC RSS")
        log("AfricaCDC RSS", f"feed {feed} → {len(items)} items raw")
        results.extend(_from_rss(items, cutoff))

    if not results:
        log("AfricaCDC", "RSS empty, trying scrape fallback")
        results.extend(_scrape_fallback(cutoff))

    if not results:
        log("AfricaCDC", "scrape empty, trying Google News fallback")
        for query in [
            "Africa CDC outbreak respiratory pneumonia",
            "Africa CDC weekly bulletin influenza",
            "African Union outbreak respiratory",
        ]:
            items = fetch_google_news_rss(query, window="6m", limit=10, log_tag=f"AfricaCDC Google {query}")
            results.extend(_from_rss(items, cutoff))

    unique = dedupe_by_id(results)
    log("AfricaCDC", f"final {len(unique)} respiratory items")
    return unique


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_africa_cdc_news()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[AfricaCDC] saved: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
