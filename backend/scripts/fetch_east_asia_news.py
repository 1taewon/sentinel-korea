"""Fetch East Asia (China / Japan / Taiwan) outbreak news.

Primary: official agency feeds where available (Taiwan CDC RSS, China CDC Weekly,
Japan NIID IASR-E). Fallback: country-specific Google News RSS queries.
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
OUTPUT_FILE = PROCESSED_DIR / "global_east_asia.json"

SOURCE_TAG = "east_asia"
PUBLISHER = "East Asia (CN/JP/TW)"
ID_PREFIX = "east_asia"

# Some agency feeds expose RSS, others require scraping. Start with the easiest.
PRIMARY_FEEDS: list[str] = [
    # Taiwan CDC press releases (English)
    "https://www.cdc.gov.tw/En/RSS/News/9bH9CYjeXrRWmaB94RZBFA",
    # China CDC Weekly (Atom)
    "https://weekly.chinacdc.cn/web/site_2/api/rss",
]

# If primary feeds return nothing, fall back to Google News country queries
FALLBACK_QUERIES: list[str] = [
    "China CDC respiratory outbreak pneumonia",
    "Japan NIID influenza pneumonia outbreak",
    "Taiwan CDC respiratory outbreak",
    "China respiratory infection cluster",
    "Japan respiratory virus surge",
    "Hong Kong respiratory outbreak",
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


def fetch_east_asia_news() -> list[dict[str, Any]]:
    cutoff = datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)
    results: list[dict[str, Any]] = []

    for feed in PRIMARY_FEEDS:
        items = parse_rss_feed(feed, log_tag="EastAsia RSS")
        log("EastAsia RSS", f"feed {feed} → {len(items)} items raw")
        results.extend(_from_rss(items, cutoff))

    # Always also pull Google News fallback for breadth (East Asia is fragmented)
    for query in FALLBACK_QUERIES:
        items = fetch_google_news_rss(query, window="6m", limit=10, log_tag=f"EastAsia Google {query}")
        results.extend(_from_rss(items, cutoff))

    unique = dedupe_by_id(results)
    log("EastAsia", f"final {len(unique)} respiratory items")
    return unique


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_east_asia_news()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[EastAsia] saved: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
