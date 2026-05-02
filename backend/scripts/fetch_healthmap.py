"""Fetch HealthMap (healthmap.org/getAlerts.php) outbreak signals.

HealthMap aggregates curated outbreak alerts from media, governments and
official health agencies. The public `getAlerts.php` endpoint returns a JSON
payload of map markers — each marker carries a `place_name`, lat/lon,
disease labels, and an HTML blob enumerating individual alert dates / titles /
internal alertids.

We parse that HTML to produce one outbreak item per alert. Each item links
back to the HealthMap permalink for that alert.

3-month cutoff (matches the rest of the outbreak fetchers).
Allows respiratory **and** broader infectious-disease alerts (cholera,
measles, dengue, mpox, ebola, polio, etc.).
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from bs4 import BeautifulSoup

from _outbreak_common import (
    dedupe_by_id,
    log,
    normalize_item,
)

# HealthMap aggregates many sources at high frequency, so 14 days keeps the
# globe legible. (3-month window yields 900+; even 30 days yields 537. Two
# weeks gives ~250-300 well-curated alerts which is the sweet spot.)
LOOKBACK_DAYS = 14

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
OUTPUT_FILE = PROCESSED_DIR / "global_healthmap.json"

SOURCE_TAG = "healthmap"
PUBLISHER = "HealthMap"
ID_PREFIX = "healthmap"

ENDPOINT = "https://www.healthmap.org/getAlerts.php"
PERMALINK = "https://www.healthmap.org/feedalert.php?alertid={alertid}&lang=en"
UA = {"User-Agent": "Mozilla/5.0 (compatible; SentinelKorea/1.0; research)"}

# `javascript:b(11489664,'en','es',7)` → 11489664
ALERTID_RE = re.compile(r"b\((\d+)\b")
# "27 Apr 2026 - " or "1 May 2026 - "
DATE_RE = re.compile(r"^\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s*$")


def _parse_date_token(text: str) -> str | None:
    m = DATE_RE.match(text or "")
    if not m:
        return None
    try:
        day = int(m.group(1))
        month = datetime.strptime(m.group(2)[:3], "%b").month
        year = int(m.group(3))
        return datetime(year, month, day).strftime("%Y-%m-%d")
    except Exception:
        return None


def _parse_marker(marker: dict[str, Any], cutoff: datetime) -> list[dict[str, Any]]:
    """Convert one HealthMap marker (place + alerts HTML) into outbreak items."""
    out: list[dict[str, Any]] = []
    raw_html = marker.get("html") or ""
    if not raw_html:
        return out

    place_name = marker.get("place_name") or ""
    lat = marker.get("lat") or 0
    lon = marker.get("lon") or 0
    disease_labels = marker.get("label") or ""

    soup = BeautifulSoup(raw_html, "html.parser")
    # Each alert is wrapped in <div class="at"> ... <span class="d">DATE - </span> <a class="fbox" ...>TITLE</a> </div>
    # Cap at MAX_PER_MARKER to avoid one country drowning the globe with same-event headlines.
    # 3 alerts/place × ~270 markers ≈ 250-300 items total (target).
    MAX_PER_MARKER = 3
    kept_for_marker = 0
    for block in soup.find_all("div", class_="at"):
        if kept_for_marker >= MAX_PER_MARKER:
            break
        date_span = block.find("span", class_="d")
        if date_span is None:
            continue
        date_text = (date_span.get_text() or "").strip()
        # Date string has trailing " - "
        date_iso = _parse_date_token(date_text.rstrip("-").strip())
        if not date_iso:
            continue
        try:
            if datetime.strptime(date_iso, "%Y-%m-%d") < cutoff:
                continue
        except ValueError:
            continue

        link = block.find("a", class_="fbox")
        if link is None:
            continue
        title = (link.get_text() or "").strip().rstrip("- ").rstrip()
        if not title:
            continue
        alertid_match = ALERTID_RE.search(link.get("href") or "")
        if not alertid_match:
            continue
        alertid = alertid_match.group(1)
        url = PERMALINK.format(alertid=alertid)

        # Body is the comma-separated disease labels for this place — gives the
        # respiratory/infectious filter a chance to accept the item even when
        # the title is short or in another language.
        body = f"{title}. {disease_labels}. {place_name}."

        normalized = normalize_item(
            source=SOURCE_TAG,
            publisher=PUBLISHER,
            title=title,
            body=body,
            url=url,
            date_str=date_iso,
            cutoff_date=cutoff,
            id_prefix=ID_PREFIX,
            allow_non_respiratory=True,
        )
        if not normalized:
            continue
        # Override coords with HealthMap's per-place data (more precise than country fallback)
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            try:
                normalized["lat"] = float(lat)
                normalized["lng"] = float(lon)
            except Exception:
                pass
        normalized["country"] = (place_name or normalized.get("country", "")).lower()
        out.append(normalized)
        kept_for_marker += 1

    return out


def fetch_healthmap() -> list[dict[str, Any]]:
    cutoff = datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)
    try:
        r = httpx.get(ENDPOINT, follow_redirects=True, timeout=30, headers=UA)
        r.raise_for_status()
    except Exception as exc:
        log("HealthMap", f"endpoint failed: {exc}")
        return []

    try:
        payload = r.json()
    except Exception:
        try:
            payload = json.loads(r.text)
        except Exception as exc:
            log("HealthMap", f"JSON parse failed: {exc}")
            return []

    markers = payload.get("markers", [])
    log("HealthMap", f"received {len(markers)} markers")

    results: list[dict[str, Any]] = []
    for marker in markers:
        results.extend(_parse_marker(marker, cutoff))

    unique = dedupe_by_id(results)
    cat: dict[str, int] = {}
    for item in unique:
        c = item.get("category", "?")
        cat[c] = cat.get(c, 0) + 1
    log("HealthMap", f"final {len(unique)} alerts ({cat}, last {LOOKBACK_DAYS}d)")
    return unique


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_healthmap()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[HealthMap] saved: {OUTPUT_FILE} ({len(data)} items)")


if __name__ == "__main__":
    main()
