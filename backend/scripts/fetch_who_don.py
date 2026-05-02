"""Fetch WHO Disease Outbreak News for the global signal layer.

Refactored to use `_outbreak_common` for shared helpers. Output schema matches
all other agency fetchers (CDC, ECDC, Africa CDC, East Asia, SEA).
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from bs4 import BeautifulSoup

from _outbreak_common import (
    LOOKBACK_DAYS,
    clean_text,
    dedupe_by_id,
    log,
    normalize_item,
)

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
OUTPUT_FILE = PROCESSED_DIR / "global_who_don.json"

WHO_DON_URL = "https://www.who.int/emergencies/disease-outbreak-news"
WHO_DON_API = "https://cms.who.int/api/hubs/diseaseoutbreaknews"
SOURCE_TAG = "who_don"
PUBLISHER = "WHO DON"


def _make_url(item: dict[str, Any]) -> str:
    item_url = item.get("ItemDefaultUrl") or item.get("Url") or item.get("url") or ""
    if item_url:
        return item_url if str(item_url).startswith("http") else f"https://www.who.int/emergencies/disease-outbreak-news/item{item_url}"
    slug = item.get("UrlName") or item.get("urlName") or item.get("Slug") or ""
    return f"https://www.who.int/emergencies/disease-outbreak-news/item/{slug}" if slug else WHO_DON_URL


def _normalize(item: dict[str, Any], cutoff: datetime) -> dict[str, Any] | None:
    title = item.get("OverrideTitle") or item.get("Title") or item.get("Name") or item.get("title") or ""
    body = (
        item.get("Summary")
        or item.get("Overview")
        or item.get("Assessment")
        or item.get("Advice")
        or item.get("Description")
        or ""
    )
    date_str = (
        item.get("PublicationDate")
        or item.get("PublicationDateAndTime")
        or item.get("DatePublished")
        or item.get("publicationDate")
        or item.get("date")
        or ""
    )
    return normalize_item(
        source=SOURCE_TAG,
        publisher=PUBLISHER,
        title=str(title),
        body=str(body),
        url=_make_url(item),
        date_str=str(date_str),
        cutoff_date=cutoff,
        id_prefix="who",
    )


def _fetch_via_api(cutoff: datetime) -> list[dict]:
    results: list[dict] = []
    headers = {"User-Agent": "SentinelKorea/1.0 (research)"}
    try:
        response = httpx.get(WHO_DON_API, headers=headers, follow_redirects=True, timeout=30)
        response.raise_for_status()
        data = response.json()
    except Exception as exc:
        log("WHO DON API", f"access failed: {exc}")
        return results

    items = data.get("value", data if isinstance(data, list) else [])
    log("WHO DON API", f"received {len(items)} items")
    for item in items:
        normalized = _normalize(item, cutoff)
        if normalized:
            results.append(normalized)
    return results


def _fetch_via_scraping(cutoff: datetime) -> list[dict]:
    results: list[dict] = []
    try:
        response = httpx.get(
            WHO_DON_URL,
            headers={"User-Agent": "SentinelKorea/1.0 (research)"},
            follow_redirects=True,
            timeout=20,
        )
        response.raise_for_status()
    except Exception as exc:
        log("WHO DON Scraper", f"access failed: {exc}")
        return results

    soup = BeautifulSoup(response.text, "html.parser")
    for link in soup.find_all("a", href=True):
        href = link["href"]
        if "/emergencies/disease-outbreak-news/item/" not in href:
            continue
        title = clean_text(link.get_text(" ", strip=True))
        if len(title) < 10:
            continue
        url = href if href.startswith("http") else f"https://www.who.int{href}"
        date_match = re.search(r"(\d{4}-\d{2}-\d{2})", href)
        item = {
            "Title": title,
            "Url": url,
            "PublicationDate": date_match.group(1) if date_match else datetime.utcnow().strftime("%Y-%m-%d"),
        }
        normalized = _normalize(item, cutoff)
        if normalized:
            results.append(normalized)
    return results


def fetch_who_don() -> list[dict]:
    cutoff = datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)
    results = _fetch_via_api(cutoff)
    if results:
        log("WHO DON", f"API collected {len(results)} items")
    else:
        log("WHO DON", "API empty/failed, trying HTML scraping...")
        results = _fetch_via_scraping(cutoff)
        log("WHO DON", f"scraper collected {len(results)} items")

    unique = dedupe_by_id(results)
    log("WHO DON", f"final {len(unique)} items (last 6 months)")
    return unique


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_who_don()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[WHO DON] saved: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
