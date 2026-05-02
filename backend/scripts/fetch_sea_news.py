"""Fetch Southeast Asia (Vietnam, Thailand, Indonesia, Philippines, Malaysia, Singapore) outbreak news.

Primary: WHO WPRO / SEARO regional outbreak feeds.
Fallback: country-specific Google News RSS queries (most ASEAN MOH sites lack open RSS).
6-month cutoff. Standard outbreak item schema.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from _outbreak_common import (
    LOOKBACK_DAYS,
    dedupe_by_id,
    fetch_google_news_rss,
    log,
    normalize_item,
    parse_rss_feed,
)

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
OUTPUT_FILE = PROCESSED_DIR / "global_sea.json"

SOURCE_TAG = "sea"
PUBLISHER = "Southeast Asia (WHO WPRO/SEARO)"
ID_PREFIX = "sea"

PRIMARY_FEEDS: list[str] = [
    # WHO WPRO outbreaks
    "https://www.who.int/westernpacific/news/rss",
    # WHO SEARO press releases
    "https://www.who.int/southeastasia/news/rss",
]

FALLBACK_QUERIES: list[str] = [
    "Vietnam respiratory outbreak pneumonia",
    "Thailand respiratory outbreak influenza",
    "Indonesia respiratory outbreak pneumonia",
    "Philippines respiratory outbreak pneumonia",
    "Malaysia respiratory outbreak pneumonia",
    "Singapore respiratory outbreak pneumonia",
    "Cambodia avian influenza outbreak",
    "Laos respiratory outbreak",
    "Myanmar respiratory outbreak",
]


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


def fetch_sea_news() -> list[dict[str, Any]]:
    cutoff = datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)
    results: list[dict[str, Any]] = []

    for feed in PRIMARY_FEEDS:
        items = parse_rss_feed(feed, log_tag="SEA RSS")
        log("SEA RSS", f"feed {feed} → {len(items)} items raw")
        results.extend(_from_rss(items, cutoff))

    # Always also pull Google News fallback for breadth (SEA is highly fragmented)
    for query in FALLBACK_QUERIES:
        items = fetch_google_news_rss(query, window="6m", limit=8, log_tag=f"SEA Google {query}")
        results.extend(_from_rss(items, cutoff))

    unique = dedupe_by_id(results)
    log("SEA", f"final {len(unique)} respiratory items")
    return unique


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_sea_news()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[SEA] saved: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
