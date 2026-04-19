"""fetch_who_don.py — WHO Disease Outbreak News 수집 (API 우선, HTML 스크래핑 fallback)"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
OUTPUT_FILE = PROCESSED_DIR / "global_who_don.json"

RESPIRATORY_KEYWORDS = [
    "respiratory", "pneumonia", "influenza", "flu", "sars", "mers",
    "avian", "covid", "coronavirus", "rsv", "metapneumovirus", "hmpv",
    "mpox", "legionella", "tuberculosis",
    "호흡기", "폐렴", "인플루엔자",
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
    "egypt": (26.82, 30.08),
    "cambodia": (12.57, 104.99), "pakistan": (30.38, 69.35),
    "democratic republic of the congo": (-4.04, 21.76), "drc": (-4.04, 21.76),
    "congo": (-4.04, 21.76), "yemen": (15.55, 48.52), "sudan": (12.86, 30.22),
    "afghanistan": (33.94, 67.71), "laos": (19.86, 102.50),
    "myanmar": (21.91, 95.96), "bangladesh": (23.68, 90.36),
    "malaysia": (4.21, 101.98), "singapore": (1.35, 103.82),
    "australia": (-25.27, 133.78), "mexico": (23.63, -102.55),
    "turkey": (38.96, 35.24), "iraq": (33.22, 43.68),
    "italy": (41.87, 12.57), "spain": (40.46, -3.75),
}

WHO_DON_URL = "https://www.who.int/emergencies/disease-outbreak-news"
WHO_DON_API = "https://www.who.int/api/hubs/dons"


def _extract_country_coords(text: str) -> tuple[float, float]:
    text_lower = text.lower()
    for country, coords in COUNTRY_COORDS.items():
        if country in text_lower:
            return coords
    return (20.0, 0.0)


def _is_respiratory(title: str) -> bool:
    title_lower = title.lower()
    return any(kw in title_lower for kw in RESPIRATORY_KEYWORDS)


def _severity_from_title(title: str) -> str:
    title_lower = title.lower()
    if any(w in title_lower for w in ["outbreak", "emergency", "pandemic", "surge", "cluster", "epidemic"]):
        return "high"
    if any(w in title_lower for w in ["case", "cases", "reported", "confirmed", "update", "situation"]):
        return "medium"
    return "low"


def _make_id(url: str) -> str:
    return "who-" + hashlib.md5(url.encode()).hexdigest()[:10]


def _guess_disease(title: str) -> str:
    t = title.lower()
    if "influenza" in t or "flu" in t or "인플루엔자" in t:
        return "influenza"
    if "covid" in t or "coronavirus" in t:
        return "COVID-19"
    if "pneumonia" in t or "폐렴" in t:
        return "pneumonia"
    if "mers" in t:
        return "MERS"
    if "sars" in t:
        return "SARS"
    if "rsv" in t:
        return "RSV"
    if "avian" in t:
        return "avian influenza"
    if "hmpv" in t or "metapneumovirus" in t:
        return "hMPV"
    if "mpox" in t:
        return "mpox"
    if "legionella" in t:
        return "legionellosis"
    if "tuberculosis" in t:
        return "tuberculosis"
    return "respiratory"


def _fetch_via_api(cutoff: datetime) -> list[dict]:
    """WHO DON API에서 데이터를 가져옵니다."""
    results: list[dict] = []
    headers = {"User-Agent": "SentinelKorea/1.0 (research)"}

    try:
        resp = httpx.get(
            WHO_DON_API,
            headers=headers,
            follow_redirects=True,
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"[WHO DON API] 접속 실패: {e}", file=sys.stderr)
        return results

    items = data.get("value", [])
    if not items:
        print("[WHO DON API] 'value' 필드 없음, 전체 응답 키 확인 중...", file=sys.stderr)
        # API 응답 구조가 다를 수 있음 — 최상위가 리스트일 수도 있음
        if isinstance(data, list):
            items = data
        else:
            print(f"[WHO DON API] 응답 키: {list(data.keys()) if isinstance(data, dict) else type(data)}", file=sys.stderr)
            return results

    print(f"[WHO DON API] {len(items)}개 항목 수신")

    for item in items:
        title = item.get("Title", "") or item.get("Name", "") or item.get("title", "") or ""
        if not title:
            continue

        pub_date = (
            item.get("PublicationDate", "")
            or item.get("DatePublished", "")
            or item.get("publicationDate", "")
            or item.get("date", "")
        )
        date_str = str(pub_date)[:10] if pub_date else datetime.utcnow().strftime("%Y-%m-%d")

        try:
            dt = datetime.strptime(date_str, "%Y-%m-%d")
            if dt < cutoff:
                continue
        except ValueError:
            pass

        url_segment = item.get("UrlName", "") or item.get("urlName", "") or ""
        if url_segment:
            full_url = f"https://www.who.int/emergencies/disease-outbreak-news/{url_segment}"
        else:
            full_url = item.get("Url", "") or item.get("url", "") or WHO_DON_URL

        # 호흡기 필터는 선택적 — API에서는 모든 DON을 가져오되 호흡기 우선 표시
        is_resp = _is_respiratory(title)

        lat, lng = _extract_country_coords(title)
        results.append({
            "id": _make_id(full_url),
            "source": "who_don",
            "title": title,
            "url": full_url,
            "date": date_str,
            "disease": _guess_disease(title) if is_resp else "other",
            "severity": _severity_from_title(title),
            "is_respiratory": is_resp,
            "lat": lat,
            "lng": lng,
        })

    return results


def _fetch_via_scraping(cutoff: datetime) -> list[dict]:
    """Fallback: WHO DON 페이지를 HTML 스크래핑합니다."""
    results: list[dict] = []

    try:
        headers = {"User-Agent": "SentinelKorea/1.0 (research; contact: sentinel@example.com)"}
        response = httpx.get(WHO_DON_URL, headers=headers, follow_redirects=True, timeout=20)
        response.raise_for_status()
    except Exception as e:
        print(f"[WHO DON Scraper] 접속 실패: {e}", file=sys.stderr)
        return results

    soup = BeautifulSoup(response.text, "html.parser")

    for a_tag in soup.find_all("a", href=True):
        href = a_tag["href"]
        if "/emergencies/disease-outbreak-news/" not in href:
            continue
        if href.rstrip("/") == "/emergencies/disease-outbreak-news":
            continue

        title = a_tag.get_text(strip=True)
        if not title or len(title) < 10:
            continue

        full_url = href if href.startswith("http") else "https://www.who.int" + href

        date_match = re.search(r"(\d{4}-\d{2}-\d{2})", href)
        if date_match:
            date_str = date_match.group(1)
        else:
            parent = a_tag.find_parent()
            parent_text = parent.get_text() if parent else ""
            date_match2 = re.search(
                r"(\d{1,2}\s+\w+\s+\d{4}|\w+\s+\d{1,2},?\s+\d{4})", parent_text
            )
            if date_match2:
                try:
                    dt = datetime.strptime(date_match2.group(1).replace(",", ""), "%d %B %Y")
                    date_str = dt.strftime("%Y-%m-%d")
                except ValueError:
                    date_str = datetime.utcnow().strftime("%Y-%m-%d")
            else:
                date_str = datetime.utcnow().strftime("%Y-%m-%d")

        try:
            dt = datetime.strptime(date_str, "%Y-%m-%d")
            if dt < cutoff:
                continue
        except ValueError:
            pass

        is_resp = _is_respiratory(title)
        lat, lng = _extract_country_coords(title)
        results.append({
            "id": _make_id(full_url),
            "source": "who_don",
            "title": title,
            "url": full_url,
            "date": date_str,
            "disease": _guess_disease(title) if is_resp else "other",
            "severity": _severity_from_title(title),
            "is_respiratory": is_resp,
            "lat": lat,
            "lng": lng,
        })

    return results


def fetch_who_don() -> list[dict]:
    """WHO DON에서 호흡기 관련 항목을 수집합니다. API 우선, 실패 시 스크래핑."""
    cutoff = datetime.utcnow() - timedelta(days=30)

    # 1차: API 시도
    results = _fetch_via_api(cutoff)
    if results:
        print(f"[WHO DON] API에서 {len(results)}개 항목 수집")
    else:
        # 2차: HTML 스크래핑 fallback
        print("[WHO DON] API 실패, HTML 스크래핑으로 전환...", file=sys.stderr)
        results = _fetch_via_scraping(cutoff)
        print(f"[WHO DON] 스크래핑에서 {len(results)}개 항목 수집")

    # 호흡기 관련 항목 우선 정렬 (호흡기 먼저, 그 다음 날짜순)
    results.sort(key=lambda x: (not x.get("is_respiratory", False), x.get("date", "")), reverse=False)
    results.sort(key=lambda x: x.get("date", ""), reverse=True)

    # 중복 제거
    seen: set[str] = set()
    unique: list[dict] = []
    for item in results:
        if item["id"] not in seen:
            seen.add(item["id"])
            unique.append(item)

    print(f"[WHO DON] 최종 {len(unique)}개 항목 (호흡기 {sum(1 for u in unique if u.get('is_respiratory'))}개)")
    return unique


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_who_don()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[WHO DON] 저장 완료: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
