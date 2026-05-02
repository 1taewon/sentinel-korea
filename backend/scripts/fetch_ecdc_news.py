"""Fetch ECDC outbreak signals from the Communicable Disease Threats Report (CDTR).

Strategy:
  1. Scrape the CDTR listing page → get up to N recent weekly CDTR detail-page URLs.
  2. For each detail page, find the linked PDF (e.g. `2026-WCP-0022 Final.pdf`).
  3. Download the PDF and extract the "This week's topics" section from page 1
     to enumerate the individual disease events covered that week.
  4. Each numbered topic ("1. Influenza A(H5N1) – Multi-country (World) – Monitoring human cases")
     becomes one normalized outbreak item with a link to the CDTR detail page.

The 6-month cutoff is enforced by stopping at older weekly reports.
"""
from __future__ import annotations

import io
import json
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx
import pdfplumber

from _outbreak_common import (
    LOOKBACK_DAYS,
    clean_text,
    dedupe_by_id,
    extract_country_coords,
    extract_country_name,
    guess_disease,
    log,
    make_id,
    severity_from_text,
)

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
OUTPUT_FILE = PROCESSED_DIR / "global_ecdc.json"

SOURCE_TAG = "ecdc"
PUBLISHER = "ECDC CDTR"
ID_PREFIX = "ecdc"

LISTING_URL = "https://www.ecdc.europa.eu/en/threats-and-outbreaks/reports-and-data/weekly-threats"
BASE = "https://www.ecdc.europa.eu"

UA = {"User-Agent": "Mozilla/5.0 (compatible; SentinelKorea/1.0; research)"}

# Match "...-DD-month-YYYY-week-NN" in CDTR detail URL (the most reliable date source)
WEEK_SLUG_RE = re.compile(
    r"(\d{1,2})(?:-\d{1,2})?-([a-z]+)(?:-\d{1,2}-[a-z]+)?-(\d{4})-week-\d{1,2}",
    re.IGNORECASE,
)
WEEK_NUM_RE = re.compile(r"week-(\d{1,2})$")
# Match "Week NN, DD Month to DD Month YYYY" header on page 1
WEEK_HEADER_RE = re.compile(r"Week\s+(\d{1,2}),\s+(\d{1,2})\s+([A-Za-z]+).*?(\d{4})", re.IGNORECASE)
# Numbered topic lines in the "This week's topics" section
TOPIC_LINE_RE = re.compile(r"^\s*(\d{1,2})\.\s+(.+?)\s*$")


def _list_cdtr_pages(cutoff: datetime) -> list[tuple[str, str]]:
    """Return list of (detail_url, week_label) for CDTRs in the lookback window."""
    out: list[tuple[str, str]] = []
    try:
        r = httpx.get(LISTING_URL, follow_redirects=True, timeout=20, headers=UA)
        r.raise_for_status()
    except Exception as exc:
        log("ECDC CDTR", f"listing fetch failed: {exc}")
        return out

    seen: set[str] = set()
    for match in re.finditer(r'href=["\']([^"\']*communicable-disease-threats-report[^"\']*)["\']', r.text):
        href = match.group(1)
        if href in seen:
            continue
        seen.add(href)
        full = href if href.startswith("http") else urljoin(BASE, href)
        # Skip future-dated entries (defensive)
        out.append((full, href.rsplit("/", 1)[-1]))

    # Cap at 30 to avoid excessive PDFs; the cutoff filter is applied per-PDF below.
    return out[:30]


def _find_pdf_url(detail_url: str) -> str | None:
    try:
        r = httpx.get(detail_url, follow_redirects=True, timeout=20, headers=UA)
        r.raise_for_status()
    except Exception as exc:
        log("ECDC CDTR", f"detail fetch failed for {detail_url}: {exc}")
        return None
    pdf_match = re.search(r'href=["\']([^"\']+communicable-disease-threats-report[^"\']*\.pdf[^"\']*|[^"\']+\d{4}-WCP-\d+[^"\']*\.pdf[^"\']*)["\']', r.text)
    if not pdf_match:
        # Fallback: any PDF link on the page
        pdf_match = re.search(r'href=["\']([^"\']+\.pdf[^"\']*)["\']', r.text)
    if not pdf_match:
        return None
    pdf_href = pdf_match.group(1)
    return pdf_href if pdf_href.startswith("http") else urljoin(BASE, pdf_href)


def _extract_topics_from_pdf(pdf_bytes: bytes) -> tuple[str, list[str]]:
    """Return (week_date_iso, topic_lines) parsed from page 1 of a CDTR PDF.

    Falls back to today's date if the week header isn't recognised.
    """
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            if not pdf.pages:
                return datetime.utcnow().strftime("%Y-%m-%d"), []
            page1 = pdf.pages[0].extract_text() or ""
    except Exception as exc:
        log("ECDC CDTR", f"PDF parse failed: {exc}")
        return datetime.utcnow().strftime("%Y-%m-%d"), []

    # Determine the publication week date
    date_iso = datetime.utcnow().strftime("%Y-%m-%d")
    m = WEEK_HEADER_RE.search(page1)
    if m:
        try:
            day = int(m.group(2))
            month_name = m.group(3)
            year = int(m.group(4))
            month = datetime.strptime(month_name[:3], "%b").month
            date_iso = datetime(year, month, day).strftime("%Y-%m-%d")
        except Exception:
            pass

    # Parse "This week's topics"
    topics: list[str] = []
    in_topics = False
    for raw_line in page1.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if "this week" in line.lower() and "topic" in line.lower():
            in_topics = True
            continue
        if in_topics:
            if line.lower().startswith("executive summary"):
                break
            tm = TOPIC_LINE_RE.match(line)
            if tm:
                topic_text = tm.group(2)
                if topic_text:
                    topics.append(topic_text)
            elif topics and line:
                # continuation of previous topic line
                topics[-1] = (topics[-1] + " " + line).strip()
    return date_iso, topics


def _topic_to_item(*, topic: str, detail_url: str, date_iso: str, cutoff: datetime) -> dict[str, Any] | None:
    """Convert one CDTR topic line into an outbreak item.

    CDTR topics are accepted whether respiratory or not (cholera, mpox etc are still
    high-value surveillance signals). We tag is_respiratory accordingly.
    """
    title = clean_text(topic)
    if not title:
        return None
    try:
        if datetime.strptime(date_iso, "%Y-%m-%d") < cutoff:
            return None
    except ValueError:
        pass

    body = title  # CDTR topic line already contains disease + location + framing
    # Manual respiratory check (can't use _outbreak_common.normalize_item because
    # we want CDTR cholera/chikungunya/mpox items too)
    from _outbreak_common import is_respiratory
    is_resp = is_respiratory(title, body)

    lat, lng = extract_country_coords(body)
    country = extract_country_name(body) or "europe"

    return {
        "id": make_id(ID_PREFIX, f"{detail_url}#{title}"),
        "source": SOURCE_TAG,
        "agency": SOURCE_TAG,
        "publisher": PUBLISHER,
        "title": title,
        "snippet": title[:220],
        "url": detail_url,
        "date": date_iso,
        "disease": guess_disease(title, body),
        "severity": severity_from_text(title, body) if "monitoring" not in title.lower() else "medium",
        "is_respiratory": is_resp,
        "country": country,
        "lat": lat,
        "lng": lng,
    }


def fetch_ecdc_news() -> list[dict[str, Any]]:
    cutoff = datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)
    detail_pages = _list_cdtr_pages(cutoff)
    log("ECDC CDTR", f"found {len(detail_pages)} listing entries")

    results: list[dict[str, Any]] = []
    for detail_url, slug in detail_pages:
        # Derive a publication date from the URL slug — most reliable.
        slug_date_iso: str | None = None
        sm = WEEK_SLUG_RE.search(slug)
        if sm:
            try:
                day = int(sm.group(1))
                month_name = sm.group(2)
                year = int(sm.group(3))
                month = datetime.strptime(month_name[:3], "%b").month
                slug_date_iso = datetime(year, month, day).strftime("%Y-%m-%d")
            except Exception:
                slug_date_iso = None

        pdf_url = _find_pdf_url(detail_url)
        if not pdf_url:
            log("ECDC CDTR", f"no PDF link in {detail_url}")
            continue
        try:
            pdf_resp = httpx.get(pdf_url, follow_redirects=True, timeout=30, headers=UA)
            pdf_resp.raise_for_status()
        except Exception as exc:
            log("ECDC CDTR", f"PDF download failed {pdf_url}: {exc}")
            continue
        pdf_date_iso, topics = _extract_topics_from_pdf(pdf_resp.content)
        # Prefer slug-derived date when PDF header parsing fell back to today
        date_iso = slug_date_iso or pdf_date_iso
        try:
            if datetime.strptime(date_iso, "%Y-%m-%d") < cutoff:
                # this report is older than 6 months — stop walking
                log("ECDC CDTR", f"reached cutoff at {date_iso}, stopping")
                break
        except ValueError:
            pass
        log("ECDC CDTR", f"{date_iso}: {len(topics)} topics")
        for topic in topics:
            item = _topic_to_item(topic=topic, detail_url=detail_url, date_iso=date_iso, cutoff=cutoff)
            if item:
                results.append(item)

    unique = dedupe_by_id(results)
    log("ECDC CDTR", f"final {len(unique)} disease events (last 6 months)")
    return unique


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_ecdc_news()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[ECDC CDTR] saved: {OUTPUT_FILE} ({len(data)} items)")


if __name__ == "__main__":
    main()
