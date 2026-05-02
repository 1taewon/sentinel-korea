"""Fetch US CDC outbreak / health alert news (HAN, MMWR, outbreak listing).

Primary: official CDC RSS feeds. Fallback: HTML scrape of /outbreaks/ + Google News RSS.
6-month cutoff. Same JSON shape as fetch_who_don.py.
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
OUTPUT_FILE = PROCESSED_DIR / "global_cdc.json"

SOURCE_TAG = "cdc"
PUBLISHER = "US CDC"
ID_PREFIX = "cdc"

# Primary feeds — CDC Health Alert Network and MMWR (RSS-friendly)
PRIMARY_FEEDS: list[str] = [
    # CDC Newsroom
    "https://tools.cdc.gov/api/v2/resources/media/132608.rss",
    # MMWR
    "https://www.cdc.gov/mmwr/rss/rss.html",
    # CDC Outbreaks (sometimes provides feed)
    "https://tools.cdc.gov/api/v2/resources/media/403372.rss",
]

FALLBACK_PAGE = "https://www.cdc.gov/outbreaks/index.html"


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
        log("CDC Scraper", f"failed: {exc}")
        return out

    soup = BeautifulSoup(resp.text, "html.parser")
    for link in soup.find_all("a", href=True):
        href = link["href"]
        if "/outbreaks/" not in href and "/han/" not in href:
            continue
        title = clean_text(link.get_text(" ", strip=True))
        if len(title) < 12:
            continue
        url = href if href.startswith("http") else f"https://www.cdc.gov{href}"
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


def fetch_cdc_news() -> list[dict[str, Any]]:
    cutoff = datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)
    results: list[dict[str, Any]] = []

    for feed in PRIMARY_FEEDS:
        items = parse_rss_feed(feed, log_tag="CDC RSS")
        log("CDC RSS", f"feed {feed} → {len(items)} items raw")
        results.extend(_from_rss(items, cutoff))

    if not results:
        log("CDC", "RSS empty, trying scrape fallback")
        results.extend(_scrape_fallback(cutoff))

    if not results:
        log("CDC", "scrape empty, trying Google News fallback")
        for query in [
            "CDC outbreak respiratory pneumonia",
            "CDC HAN respiratory health alert",
            "CDC MMWR respiratory",
        ]:
            items = fetch_google_news_rss(query, window="6m", limit=10, log_tag=f"CDC Google {query}")
            results.extend(_from_rss(items, cutoff))

    unique = dedupe_by_id(results)
    log("CDC", f"final {len(unique)} respiratory items")
    return unique


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_cdc_news()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[CDC] saved: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
