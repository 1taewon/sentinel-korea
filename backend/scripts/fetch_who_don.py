"""Fetch WHO Disease Outbreak News for the global signal layer."""
from __future__ import annotations

import hashlib
import html
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from bs4 import BeautifulSoup

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
OUTPUT_FILE = PROCESSED_DIR / "global_who_don.json"

WHO_DON_URL = "https://www.who.int/emergencies/disease-outbreak-news"
WHO_DON_API = "https://cms.who.int/api/hubs/diseaseoutbreaknews"
LOOKBACK_DAYS = 5000

RESPIRATORY_KEYWORDS = [
    "respiratory", "pneumonia", "influenza", "flu", "sars", "mers",
    "avian", "covid", "coronavirus", "rsv", "metapneumovirus", "hmpv",
    "legionella", "tuberculosis", "whooping cough", "pertussis",
]

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
    "pakistan": (30.38, 69.35), "democratic republic of the congo": (-4.04, 21.76),
    "drc": (-4.04, 21.76), "congo": (-4.04, 21.76), "yemen": (15.55, 48.52),
    "sudan": (12.86, 30.22), "afghanistan": (33.94, 67.71),
    "laos": (19.86, 102.50), "myanmar": (21.91, 95.96),
    "bangladesh": (23.68, 90.36), "malaysia": (4.21, 101.98),
    "singapore": (1.35, 103.82), "australia": (-25.27, 133.78),
    "mexico": (23.63, -102.55), "turkey": (38.96, 35.24),
    "iraq": (33.22, 43.68), "italy": (41.87, 12.57), "spain": (40.46, -3.75),
}


def _clean_text(value: str | None) -> str:
    if not value:
        return ""
    text = re.sub(r"<[^>]+>", " ", value)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _parse_date(value: Any) -> str:
    if not value:
        return datetime.utcnow().strftime("%Y-%m-%d")
    raw = str(value).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(raw).strftime("%Y-%m-%d")
    except ValueError:
        return str(value)[:10]


def _extract_country_coords(text: str) -> tuple[float, float]:
    text_lower = text.lower()
    for country, coords in COUNTRY_COORDS.items():
        if country in text_lower:
            return coords
    return (20.0, 0.0)


def _is_respiratory(title: str, body: str = "") -> bool:
    text = f"{title} {body}".lower()
    return any(keyword in text for keyword in RESPIRATORY_KEYWORDS)


def _severity_from_text(title: str, body: str = "") -> str:
    text = f"{title} {body}".lower()
    if any(w in text for w in ["outbreak", "emergency", "pandemic", "surge", "cluster", "epidemic"]):
        return "high"
    if any(w in text for w in ["case", "cases", "reported", "confirmed", "update", "situation"]):
        return "medium"
    return "low"


def _guess_disease(title: str, body: str = "") -> str:
    text = f"{title} {body}".lower()
    if "influenza" in text or "flu" in text:
        return "influenza"
    if "covid" in text or "coronavirus" in text:
        return "COVID-19"
    if "pneumonia" in text:
        return "pneumonia"
    if "mers" in text:
        return "MERS"
    if "sars" in text:
        return "SARS"
    if "rsv" in text:
        return "RSV"
    if "avian" in text:
        return "avian influenza"
    if "hmpv" in text or "metapneumovirus" in text:
        return "hMPV"
    if "legionella" in text:
        return "legionellosis"
    if "tuberculosis" in text:
        return "tuberculosis"
    if "pertussis" in text or "whooping cough" in text:
        return "pertussis"
    return "respiratory"


def _make_id(url: str) -> str:
    return "who-" + hashlib.md5(url.encode()).hexdigest()[:10]


def _make_url(item: dict[str, Any]) -> str:
    item_url = item.get("ItemDefaultUrl") or item.get("Url") or item.get("url") or ""
    if item_url:
        return item_url if str(item_url).startswith("http") else f"https://www.who.int/emergencies/disease-outbreak-news/item{item_url}"
    slug = item.get("UrlName") or item.get("urlName") or item.get("Slug") or ""
    return f"https://www.who.int/emergencies/disease-outbreak-news/item/{slug}" if slug else WHO_DON_URL


def _normalize_item(item: dict[str, Any], cutoff: datetime) -> dict[str, Any] | None:
    title = item.get("OverrideTitle") or item.get("Title") or item.get("Name") or item.get("title") or ""
    title = _clean_text(str(title))
    if not title:
        return None

    body = _clean_text(
        item.get("Summary")
        or item.get("Overview")
        or item.get("Assessment")
        or item.get("Advice")
        or item.get("Description")
        or ""
    )
    date_str = _parse_date(
        item.get("PublicationDate")
        or item.get("PublicationDateAndTime")
        or item.get("DatePublished")
        or item.get("publicationDate")
        or item.get("date")
    )
    try:
        if datetime.strptime(date_str, "%Y-%m-%d") < cutoff:
            return None
    except ValueError:
        pass

    url = _make_url(item)
    is_resp = _is_respiratory(title, body)
    lat, lng = _extract_country_coords(f"{title} {body}")
    return {
        "id": _make_id(url),
        "source": "who_don",
        "title": title,
        "snippet": body[:220],
        "url": url,
        "date": date_str,
        "disease": _guess_disease(title, body) if is_resp else "other",
        "severity": _severity_from_text(title, body),
        "is_respiratory": is_resp,
        "lat": lat,
        "lng": lng,
    }


def _fetch_via_api(cutoff: datetime) -> list[dict]:
    results: list[dict] = []
    headers = {"User-Agent": "SentinelKorea/1.0 (research)"}
    try:
        response = httpx.get(
            WHO_DON_API,
            headers=headers,
            follow_redirects=True,
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()
    except Exception as exc:
        print(f"[WHO DON API] access failed: {exc}", file=sys.stderr)
        return results

    items = data.get("value", data if isinstance(data, list) else [])
    print(f"[WHO DON API] received {len(items)} items")
    for item in items:
        normalized = _normalize_item(item, cutoff)
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
        print(f"[WHO DON Scraper] access failed: {exc}", file=sys.stderr)
        return results

    soup = BeautifulSoup(response.text, "html.parser")
    for link in soup.find_all("a", href=True):
        href = link["href"]
        if "/emergencies/disease-outbreak-news/item/" not in href:
            continue
        title = _clean_text(link.get_text(" ", strip=True))
        if len(title) < 10:
            continue
        url = href if href.startswith("http") else f"https://www.who.int{href}"
        date_match = re.search(r"(\d{4}-\d{2}-\d{2})", href)
        item = {
            "Title": title,
            "Url": url,
            "PublicationDate": date_match.group(1) if date_match else datetime.utcnow().strftime("%Y-%m-%d"),
        }
        normalized = _normalize_item(item, cutoff)
        if normalized:
            results.append(normalized)
    return results


def fetch_who_don() -> list[dict]:
    cutoff = datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)
    results = _fetch_via_api(cutoff)
    if results:
        print(f"[WHO DON] API collected {len(results)} items")
    else:
        print("[WHO DON] API empty/failed, trying HTML scraping...", file=sys.stderr)
        results = _fetch_via_scraping(cutoff)
        print(f"[WHO DON] scraper collected {len(results)} items")

    seen: set[str] = set()
    unique: list[dict] = []
    for item in sorted(results, key=lambda row: (row.get("date", ""), row.get("is_respiratory", False)), reverse=True):
        if item["id"] in seen:
            continue
        seen.add(item["id"])
        unique.append(item)

    print(f"[WHO DON] final {len(unique)} items (respiratory {sum(1 for item in unique if item.get('is_respiratory'))})")
    return unique


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_who_don()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[WHO DON] saved: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
