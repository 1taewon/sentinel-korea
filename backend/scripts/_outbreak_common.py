"""Shared helpers used by every outbreak-news fetcher (WHO DON, CDC, ECDC, Africa CDC, East Asia, SEA, Gemini, etc.).

Each fetcher emits the same JSON shape so the frontend can treat them uniformly.

Standard item schema:
    {
      "id":            str,            # "<prefix>-<md5[:10]>"
      "source":        str,            # e.g. "who_don", "cdc", "ecdc"
      "agency":        str,            # human/short tag, equal to source by default
      "publisher":     str,            # display label, e.g. "US CDC"
      "title":         str,
      "snippet":       str,            # <= 220 chars
      "url":           str,
      "date":          str,            # YYYY-MM-DD
      "disease":       str,            # best-effort guess
      "severity":      "high|medium|low",
      "is_respiratory": bool,
      "lat":           float,
      "lng":           float,
    }
"""
from __future__ import annotations

import hashlib
import html
import re
import sys
from datetime import datetime
from typing import Any

# ── 6-month default cutoff used by every fetcher ───────────────────────────────
LOOKBACK_DAYS = 180

# ── Respiratory keyword filter ─────────────────────────────────────────────────
RESPIRATORY_KEYWORDS: list[str] = [
    "respiratory", "pneumonia", "influenza", "flu", "sars", "mers",
    "avian", "covid", "coronavirus", "rsv", "metapneumovirus", "hmpv",
    "legionella", "tuberculosis", "whooping cough", "pertussis",
    "h5n1", "h7n9", "mycoplasma", "lung", "bronchitis",
]

# ── Country → (lat, lng) for naive geocoding from titles/snippets ──────────────
COUNTRY_COORDS: dict[str, tuple[float, float]] = {
    "china": (35.86, 104.19), "usa": (38.0, -97.0), "united states": (38.0, -97.0),
    "korea": (36.5, 127.5), "south korea": (36.5, 127.5), "republic of korea": (36.5, 127.5),
    "japan": (36.2, 138.25), "india": (20.59, 78.96),
    "vietnam": (14.06, 108.28), "thailand": (13.75, 100.5),
    "indonesia": (-0.79, 113.92), "philippines": (12.88, 121.77),
    "france": (46.23, 2.21), "germany": (51.16, 10.45),
    "uk": (55.38, -3.44), "united kingdom": (55.38, -3.44), "england": (52.36, -1.17),
    "scotland": (56.49, -4.20), "ireland": (53.14, -7.69),
    "italy": (41.87, 12.57), "spain": (40.46, -3.75), "portugal": (39.39, -8.22),
    "netherlands": (52.13, 5.29), "belgium": (50.50, 4.47),
    "sweden": (60.13, 18.64), "norway": (60.47, 8.47), "finland": (61.92, 25.75),
    "denmark": (56.26, 9.50), "poland": (51.92, 19.14), "greece": (39.07, 21.82),
    "switzerland": (46.82, 8.23), "austria": (47.52, 14.55),
    "czech republic": (49.82, 15.47), "czechia": (49.82, 15.47),
    "hungary": (47.16, 19.50), "romania": (45.94, 24.97),
    "russia": (61.52, 105.32), "ukraine": (48.38, 31.17),
    "brazil": (-14.24, -51.93), "argentina": (-38.42, -63.62),
    "chile": (-35.68, -71.54), "peru": (-9.19, -75.02),
    "colombia": (4.57, -74.30), "mexico": (23.63, -102.55),
    "canada": (56.13, -106.35), "australia": (-25.27, 133.78),
    "new zealand": (-40.90, 174.89),
    "nigeria": (9.08, 8.68), "kenya": (-0.02, 37.91),
    "south africa": (-30.56, 22.94), "egypt": (26.82, 30.08),
    "ethiopia": (9.15, 40.49), "ghana": (7.95, -1.02),
    "uganda": (1.37, 32.29), "tanzania": (-6.37, 34.89),
    "morocco": (31.79, -7.09), "algeria": (28.03, 1.66),
    "saudi arabia": (23.89, 45.08), "iran": (32.43, 53.69),
    "iraq": (33.22, 43.68), "turkey": (38.96, 35.24),
    "israel": (31.05, 34.85), "jordan": (30.59, 36.24),
    "lebanon": (33.85, 35.86), "yemen": (15.55, 48.52),
    "afghanistan": (33.94, 67.71), "pakistan": (30.38, 69.35),
    "bangladesh": (23.68, 90.36), "sri lanka": (7.87, 80.77),
    "myanmar": (21.91, 95.96), "laos": (19.86, 102.50),
    "cambodia": (12.57, 104.99), "malaysia": (4.21, 101.98),
    "singapore": (1.35, 103.82), "taiwan": (23.69, 120.96),
    "hong kong": (22.31, 114.17),
    "democratic republic of the congo": (-4.04, 21.76), "drc": (-4.04, 21.76),
    "congo": (-4.04, 21.76), "sudan": (12.86, 30.22), "south sudan": (6.87, 31.31),
    "somalia": (5.15, 46.20), "rwanda": (-1.94, 29.87), "burundi": (-3.37, 29.92),
    "zimbabwe": (-19.02, 29.15), "zambia": (-13.13, 27.85),
    "mozambique": (-18.67, 35.53), "angola": (-11.20, 17.87),
    "mali": (17.57, -3.99), "senegal": (14.50, -14.45),
    "niger": (17.61, 8.08), "chad": (15.45, 18.73),
    "ivory coast": (7.54, -5.55), "cote d'ivoire": (7.54, -5.55),
}

# ── Severity heuristic ─────────────────────────────────────────────────────────
SEVERITY_HIGH = ["outbreak", "emergency", "pandemic", "surge", "cluster", "epidemic", "fatal", "deaths"]
SEVERITY_MED = ["case", "cases", "reported", "confirmed", "update", "situation", "increase", "rise", "spreading"]


def clean_text(value: str | None) -> str:
    """Strip HTML, normalize whitespace, html-unescape entities."""
    if not value:
        return ""
    text = re.sub(r"<[^>]+>", " ", str(value))
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def parse_date(value: Any) -> str:
    """Best-effort parse to YYYY-MM-DD. Falls back to today."""
    if not value:
        return datetime.utcnow().strftime("%Y-%m-%d")
    raw = str(value).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(raw).strftime("%Y-%m-%d")
    except ValueError:
        pass
    # RFC 822 / pubDate format ("Wed, 21 Apr 2025 12:34:56 GMT")
    try:
        return datetime.strptime(str(raw)[:25], "%a, %d %b %Y %H:%M:%S").strftime("%Y-%m-%d")
    except ValueError:
        pass
    # ISO date only
    try:
        return datetime.strptime(str(raw)[:10], "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        return str(raw)[:10] or datetime.utcnow().strftime("%Y-%m-%d")


def extract_country_coords(text: str) -> tuple[float, float]:
    """Return (lat, lng) for the first country name found in text. Defaults to (20, 0)."""
    text_lower = (text or "").lower()
    for country, coords in COUNTRY_COORDS.items():
        if country in text_lower:
            return coords
    return (20.0, 0.0)


def extract_country_name(text: str) -> str:
    """Return the first country name token found, or empty string."""
    text_lower = (text or "").lower()
    for country in COUNTRY_COORDS.keys():
        if country in text_lower:
            return country
    return ""


def is_respiratory(title: str, body: str = "") -> bool:
    text = f"{title} {body}".lower()
    return any(keyword in text for keyword in RESPIRATORY_KEYWORDS)


def severity_from_text(title: str, body: str = "") -> str:
    text = f"{title} {body}".lower()
    if any(w in text for w in SEVERITY_HIGH):
        return "high"
    if any(w in text for w in SEVERITY_MED):
        return "medium"
    return "low"


def guess_disease(title: str, body: str = "") -> str:
    text = f"{title} {body}".lower()
    if "h5n1" in text or "avian" in text or "bird flu" in text:
        return "avian influenza"
    if "covid" in text or "coronavirus" in text or "sars-cov-2" in text:
        return "COVID-19"
    if "influenza" in text or " flu" in text or "flu " in text:
        return "influenza"
    if "pneumonia" in text:
        return "pneumonia"
    if "mers" in text:
        return "MERS"
    if "sars" in text:
        return "SARS"
    if "rsv" in text or "respiratory syncytial" in text:
        return "RSV"
    if "hmpv" in text or "metapneumovirus" in text:
        return "hMPV"
    if "mycoplasma" in text:
        return "mycoplasma pneumonia"
    if "legionella" in text or "legionnaire" in text:
        return "legionellosis"
    if "tuberculosis" in text or " tb " in text:
        return "tuberculosis"
    if "pertussis" in text or "whooping cough" in text:
        return "pertussis"
    return "respiratory"


def make_id(prefix: str, url: str) -> str:
    return f"{prefix}-{hashlib.md5((url or '').encode()).hexdigest()[:10]}"


def normalize_item(
    *,
    source: str,
    publisher: str,
    title: str,
    body: str,
    url: str,
    date_str: str,
    cutoff_date: datetime,
    id_prefix: str | None = None,
) -> dict[str, Any] | None:
    """Build a standard outbreak item dict, applying respiratory filter and date cutoff.

    Returns None when:
    - title is empty
    - date is before cutoff
    - the article is not respiratory-relevant
    """
    title = clean_text(title)
    body = clean_text(body)
    if not title:
        return None

    date_norm = parse_date(date_str)
    try:
        if datetime.strptime(date_norm, "%Y-%m-%d") < cutoff_date:
            return None
    except ValueError:
        pass

    is_resp = is_respiratory(title, body)
    if not is_resp:
        return None

    lat, lng = extract_country_coords(f"{title} {body}")
    country = extract_country_name(f"{title} {body}")

    return {
        "id": make_id(id_prefix or source, url),
        "source": source,
        "agency": source,
        "publisher": publisher,
        "title": title,
        "snippet": body[:220],
        "url": url,
        "date": date_norm,
        "disease": guess_disease(title, body),
        "severity": severity_from_text(title, body),
        "is_respiratory": True,
        "country": country,
        "lat": lat,
        "lng": lng,
    }


def dedupe_by_id(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sort by date desc and drop duplicate ids."""
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for item in sorted(items, key=lambda r: r.get("date", ""), reverse=True):
        item_id = item.get("id")
        if not item_id or item_id in seen:
            continue
        seen.add(item_id)
        unique.append(item)
    return unique


def log(tag: str, message: str) -> None:
    print(f"[{tag}] {message}", file=sys.stderr)


# ── RSS feed parsing helper ────────────────────────────────────────────────────
def parse_rss_feed(url: str, *, timeout: int = 20, log_tag: str = "RSS") -> list[dict[str, str]]:
    """Fetch and parse an RSS/Atom feed. Returns list of {title, link, description, pubDate}.

    Tolerant of namespace differences and Atom feeds.
    """
    import httpx
    from xml.etree import ElementTree as ET

    try:
        resp = httpx.get(url, headers={"User-Agent": "SentinelKorea/1.0 (research)"}, follow_redirects=True, timeout=timeout)
        resp.raise_for_status()
    except Exception as exc:
        log(log_tag, f"feed {url} failed: {exc}")
        return []

    items: list[dict[str, str]] = []
    try:
        root = ET.fromstring(resp.content)
    except ET.ParseError as exc:
        log(log_tag, f"XML parse error for {url}: {exc}")
        return items

    # RSS 2.0 — channel/item
    for item in root.findall(".//item"):
        items.append({
            "title": (item.findtext("title") or "").strip(),
            "link": (item.findtext("link") or "").strip(),
            "description": (item.findtext("description") or "").strip(),
            "pubDate": (item.findtext("pubDate") or item.findtext("{http://purl.org/dc/elements/1.1/}date") or "").strip(),
        })

    # Atom — entry
    if not items:
        ns = {"a": "http://www.w3.org/2005/Atom"}
        for entry in root.findall(".//a:entry", ns):
            link_el = entry.find("a:link", ns)
            link_href = (link_el.get("href") if link_el is not None else "") or ""
            items.append({
                "title": (entry.findtext("a:title", default="", namespaces=ns) or "").strip(),
                "link": link_href.strip(),
                "description": (entry.findtext("a:summary", default="", namespaces=ns) or entry.findtext("a:content", default="", namespaces=ns) or "").strip(),
                "pubDate": (entry.findtext("a:updated", default="", namespaces=ns) or entry.findtext("a:published", default="", namespaces=ns) or "").strip(),
            })

    return items


def fetch_google_news_rss(query: str, *, window: str = "6m", timeout: int = 20, limit: int = 14, log_tag: str = "GoogleNews") -> list[dict[str, str]]:
    """Fetch a Google News RSS query as a fallback. Returns same dict shape as parse_rss_feed.

    Note: the `when:` operator is no longer supported by Google News RSS — it
    silently returns 0 items. We pass the bare query and rely on `cutoff_date`
    filtering inside `normalize_item` to drop articles older than 6 months.
    The `window` argument is retained for API compatibility but unused.
    """
    del window  # operator no longer supported
    from urllib.parse import quote_plus

    url = f"https://news.google.com/rss/search?q={quote_plus(query)}&hl=en-US&gl=US&ceid=US:en"
    items = parse_rss_feed(url, timeout=timeout, log_tag=log_tag)
    return items[:limit]
