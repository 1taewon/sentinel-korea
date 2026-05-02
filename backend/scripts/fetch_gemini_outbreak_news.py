"""Use Gemini's grounded web search (google_search tool) to find long-tail outbreak news.

Complements the WHO DON / CDC / ECDC / Africa CDC / East Asia / SEA agency fetchers
by asking Gemini to scan the web for recent (≤6 months) respiratory outbreak news that
those direct feeds may have missed. Results are normalized to the same schema.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from _outbreak_common import (
    LOOKBACK_DAYS,  # 90 days global default
    dedupe_by_id,
    log,
    normalize_item,
)

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
OUTPUT_FILE = PROCESSED_DIR / "global_gemini_outbreak.json"

SOURCE_TAG = "gemini_outbreak"
PUBLISHER = "Gemini Search"
ID_PREFIX = "gemini"

# Six regions to keep prompts focused and parsing manageable
REGIONS: list[tuple[str, str]] = [
    ("US CDC", "site:cdc.gov OR US CDC outbreak respiratory pneumonia influenza last 6 months"),
    ("ECDC EU", "ECDC OR EU communicable disease threat respiratory pneumonia influenza last 6 months"),
    ("Africa CDC", "Africa CDC OR African Union outbreak respiratory pneumonia tuberculosis last 6 months"),
    ("East Asia", "China CDC OR Japan NIID OR Taiwan CDC respiratory outbreak pneumonia influenza last 6 months"),
    ("Southeast Asia", "Vietnam OR Thailand OR Indonesia OR Philippines OR Malaysia OR Singapore respiratory outbreak last 6 months"),
    ("Other", "respiratory disease outbreak pneumonia influenza COVID RSV avian H5N1 last 6 months"),
]


def _build_prompt(region: str, query: str) -> str:
    today = datetime.utcnow().strftime("%Y-%m-%d")
    cutoff_date = (datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)).strftime("%Y-%m-%d")
    return (
        f"You are a public-health intelligence assistant. Search the web for {region} infectious-disease outbreak news using grounded search.\n"
        f"Search query: {query}\n\n"
        f"Constraints:\n"
        f"- Only include articles published between {cutoff_date} and {today} (last 3 months).\n"
        f"- Include both RESPIRATORY (pneumonia, influenza, COVID, RSV, MERS, SARS, avian flu, H5N1, mycoplasma, HMPV, TB) and other major INFECTIOUS-DISEASE outbreaks (measles, cholera, dengue, mpox, ebola, marburg, polio, meningitis, HFMD, Zika, chikungunya).\n"
        f"- Up to 12 distinct events. Deduplicate identical incidents.\n\n"
        f"Output ONLY a JSON array. No prose, no markdown fences, no explanation.\n"
        f"Each item shape:\n"
        f'{{ "title": str, "snippet": str (<=220 chars), "url": str, "date": "YYYY-MM-DD", "publisher": str, "country": str, "disease": str, "severity": "high"|"medium"|"low" }}\n'
    )


def _strip_codeblock(text: str) -> str:
    """Strip ```json ... ``` fences if Gemini ignores the prompt."""
    text = text.strip()
    if text.startswith("```"):
        # remove first fence
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        # remove trailing fence
        text = re.sub(r"\n?```\s*$", "", text)
    return text.strip()


def _parse_response(text: str) -> list[dict[str, Any]]:
    cleaned = _strip_codeblock(text)
    # Try direct parse
    try:
        data = json.loads(cleaned)
        if isinstance(data, list):
            return data
    except json.JSONDecodeError:
        pass
    # Try to find first JSON array in the text
    match = re.search(r"\[\s*\{.*?\}\s*\]", cleaned, re.DOTALL)
    if match:
        try:
            data = json.loads(match.group(0))
            if isinstance(data, list):
                return data
        except json.JSONDecodeError:
            return []
    return []


def _call_gemini(client: Any, model: str, prompt: str) -> list[dict[str, Any]]:
    try:
        # google-genai >= 1.0 syntax for grounded search
        from google.genai import types  # type: ignore

        config = types.GenerateContentConfig(
            tools=[types.Tool(google_search=types.GoogleSearch())],
            temperature=0.2,
            max_output_tokens=2048,
        )
        response = client.models.generate_content(model=model, contents=prompt, config=config)
    except Exception as exc:
        log("Gemini Outbreak", f"call failed (with grounding): {exc}; retrying without tools")
        try:
            response = client.models.generate_content(model=model, contents=prompt)
        except Exception as exc2:
            log("Gemini Outbreak", f"plain call also failed: {exc2}")
            return []

    text = getattr(response, "text", "") or ""
    if not text:
        # genai sometimes returns candidates without flat .text
        try:
            text = response.candidates[0].content.parts[0].text  # type: ignore[attr-defined]
        except Exception:
            return []

    return _parse_response(text)


def fetch_gemini_outbreak_news() -> list[dict[str, Any]]:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        log("Gemini Outbreak", "GEMINI_API_KEY missing; skipping")
        return []

    try:
        from google import genai  # type: ignore
    except ImportError:
        log("Gemini Outbreak", "google-genai package missing; skipping")
        return []

    client = genai.Client(api_key=api_key)
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    cutoff = datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)

    raw_items: list[dict[str, Any]] = []
    for region, query in REGIONS:
        log("Gemini Outbreak", f"searching {region}...")
        items = _call_gemini(client, model, _build_prompt(region, query))
        log("Gemini Outbreak", f"{region}: {len(items)} raw items")
        raw_items.extend(items)

    results: list[dict[str, Any]] = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        title = str(raw.get("title", ""))
        url = str(raw.get("url", ""))
        if not title or not url:
            continue
        # Use country/snippet as body so disease & coords detection work
        body = " ".join([str(raw.get("snippet", "")), str(raw.get("country", "")), str(raw.get("disease", ""))]).strip()
        # severity might come from gemini directly — pre-set body so guess fallback can use it
        normalized = normalize_item(
            source=SOURCE_TAG,
            publisher=str(raw.get("publisher")) or PUBLISHER,
            title=title,
            body=body,
            url=url,
            date_str=str(raw.get("date", "")),
            cutoff_date=cutoff,
            id_prefix=ID_PREFIX,
            allow_non_respiratory=True,  # match Google News broad scope
        )
        if not normalized:
            continue
        # Override fields gemini gave us explicitly when sensible
        if raw.get("severity") in ("high", "medium", "low"):
            normalized["severity"] = raw["severity"]
        if raw.get("disease"):
            normalized["disease"] = str(raw["disease"])
        if raw.get("country"):
            normalized["country"] = str(raw["country"]).lower()
        results.append(normalized)

    unique = dedupe_by_id(results)
    log("Gemini Outbreak", f"final {len(unique)} respiratory items across {len(REGIONS)} regions")
    return unique


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    data = fetch_gemini_outbreak_news()
    OUTPUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[Gemini Outbreak] saved: {OUTPUT_FILE} ({len(data)} items)")


if __name__ == "__main__":
    main()
