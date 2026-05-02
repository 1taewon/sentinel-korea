"""Google News outbreak fetcher.

Replaces the previous Africa CDC / East Asia / SEA fetchers (which all relied on
Google News anyway). This single fetcher:

- Uses Google News RSS as its sole source (clearly labelled as such).
- Looks back **3 months** instead of 6 (to keep noise down).
- Casts a **broad** net: respiratory PLUS major non-respiratory infectious-
  disease outbreaks (measles, cholera, mpox, dengue, ebola, polio, HFMD, etc.)
  that could foreshadow imported risk to Korea.

Each item is tagged `source = "google_news_outbreak"` and explicitly attributes
to "Google News (analysis)" so users know this is media analysis, not an
official agency feed.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from _outbreak_common import (
    dedupe_by_id,
    fetch_google_news_rss,
    log,
    normalize_item,
)

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
OUTPUT_FILE = PROCESSED_DIR / "global_google_outbreak.json"

# Override LOOKBACK_DAYS for this fetcher only — 3 months as user requested.
LOOKBACK_DAYS = 90

SOURCE_TAG = "google_news_outbreak"
PUBLISHER = "Google News (analysis)"
ID_PREFIX = "google_outbreak"

# Broad query set: respiratory + non-respiratory infectious disease outbreaks
QUERIES: list[str] = [
    # ── Respiratory
    "respiratory virus outbreak",
    "pneumonia cluster outbreak",
    "influenza surge outbreak",
    "avian influenza H5N1 outbreak",
    "MERS outbreak",
    "RSV wave outbreak",
    "COVID new variant outbreak",
    "mycoplasma pneumonia outbreak",
    "tuberculosis outbreak",
    # ── Vaccine-preventable / measles
    "measles outbreak",
    "mumps outbreak",
    "diphtheria outbreak",
    "polio outbreak",
    # ── Vector-borne
    "dengue outbreak",
    "malaria outbreak surge",
    "zika outbreak",
    "chikungunya outbreak",
    "yellow fever outbreak",
    "encephalitis outbreak",
    # ── Hemorrhagic fevers
    "ebola outbreak",
    "marburg outbreak",
    "lassa fever outbreak",
    # ── Mpox & pox
    "mpox outbreak",
    "monkeypox outbreak",
    # ── Bacterial / zoonotic
    "cholera outbreak",
    "typhoid outbreak",
    "meningitis outbreak",
    "anthrax outbreak",
    "plague outbreak",
    "nipah outbreak",
    # ── Childhood
    "hand foot mouth disease outbreak",
    "enterovirus outbreak",
    # ── Asia-specific (since this fetcher replaces East Asia + SEA fetchers)
    "China respiratory outbreak",
    "Japan respiratory outbreak",
    "Taiwan outbreak respiratory",
    "Vietnam respiratory outbreak",
    "Thailand respiratory outbreak",
    "Indonesia respiratory outbreak",
    "Philippines respiratory outbreak",
    "Cambodia avian influenza outbreak",
    # ── Africa (since this also replaces Africa CDC fetcher)
    "Africa CDC outbreak",
    "African Union outbreak respiratory",
    "Nigeria outbreak respiratory",
    "DRC outbreak ebola",
    "Sudan outbreak cholera",
]


def fetch_google_news_outbreak() -> list[dict[str, Any]]:
    cutoff = datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)
    results: list[dict[str, Any]] = []

    for query in QUERIES:
        items = fetch_google_news_rss(query, limit=10, log_tag=f"GoogleOutbreak {query[:40]}")
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
                allow_non_respiratory=True,  # 광범위하게 받음
            )
            if normalized:
                results.append(normalized)

    unique = dedupe_by_id(results)
    cat_counts: dict[str, int] = {}
    for item in unique:
        c = item.get("category", "?")
        cat_counts[c] = cat_counts.get(c, 0) + 1
    log("GoogleOutbreak", f"final {len(unique)} items ({cat_counts}, last {LOOKBACK_DAYS}d)")
    return unique


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_google_news_outbreak()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[GoogleOutbreak] saved: {OUTPUT_FILE} ({len(data)} items)")


if __name__ == "__main__":
    main()
