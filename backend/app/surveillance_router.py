"""surveillance_router.py — Legionella investigation module (de-identified demo).

Upload de-identified survey files → extract text → Gemini/regex parse (G-6/Z) →
geocode presumed area → deterministic source matching → KDE investigation hotspots.
Only the sanitized case JSON is kept; raw uploads are parsed in memory and discarded,
and PII patterns (성명·주민번호·연락처) are stripped before any LLM call.
"""
from __future__ import annotations

import io
import json
import os
import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, UploadFile
from starlette.concurrency import run_in_threadpool

from . import legionella_lib as LL
from .auth import require_admin

router = APIRouter()

_STATE_FILE = Path(__file__).resolve().parent.parent / "data" / "processed" / "legionella_cases.json"
# Synthetic surveys live beside the facility data, resolved the same way (frontend repo path
# for local dev, backend-bundled legionella_data for the deployed backend container).
_SYNTH_DIR = LL._PUBLIC_DATA / "synthetic_surveys"
_lock = threading.Lock()

# Pre-warmed, stateless 예시 분석 (4 synthetic de-identified surveys) so non-admin judges
# get the investigation demo instantly and reproducibly — it never touches the shared
# case store and uses curated demo coordinates (not the live geocoder).
_EXAMPLE_CACHE: dict[str, Any] | None = None
_example_lock = threading.Lock()


def _load_cases() -> list[dict]:
    if _STATE_FILE.exists():
        try:
            data = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except Exception:
            return []
    return []


def _save_cases(cases: list[dict]) -> None:
    try:
        _STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _STATE_FILE.write_text(json.dumps(cases, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _extract_text(filename: str, content: bytes) -> str:
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if ext in ("txt", "md", "csv"):
        for enc in ("utf-8-sig", "utf-8", "cp949", "euc-kr"):
            try:
                return content.decode(enc)
            except Exception:
                continue
        return content.decode("utf-8", "ignore")
    if ext == "pdf":
        try:
            import pdfplumber
            with pdfplumber.open(io.BytesIO(content)) as pdf:
                return "\n".join((pg.extract_text() or "") for pg in pdf.pages)
        except Exception:
            return ""
    if ext == "docx":
        try:
            import docx  # python-docx (optional)
            return "\n".join(p.text for p in docx.Document(io.BytesIO(content)).paragraphs)
        except Exception:
            return ""  # not installed → skip gracefully
    return ""


def _pipeline(cases: list[dict], towers: list[tuple[float, float]]) -> dict:
    facilities = LL.load_facilities()
    match = LL.match_sources(cases, towers, facilities)
    hotspots = LL.build_hotspots(match, towers, facilities)
    return {"cases": cases, "case_results": match["case_results"],
            "common_candidates": match["common_candidates"], "hotspots": hotspots,
            "facility_count": len(facilities)}


def _parse_towers(raw: str | None) -> list[tuple[float, float]]:
    if not raw:
        return []
    try:
        arr = json.loads(raw)
        return [(float(p[0]), float(p[1])) for p in arr if isinstance(p, (list, tuple)) and len(p) >= 2]
    except Exception:
        return []


@router.post("/surveillance/parse-survey")
async def parse_survey(files: list[UploadFile] = File(...),
                       cooling_towers: str | None = Form(None),
                       _: dict = Depends(require_admin)) -> dict[str, Any]:
    """Parse uploaded de-identified surveys, append cases, and re-run match + hotspot."""
    towers = _parse_towers(cooling_towers)

    def work() -> dict:
        with _lock:
            cases = _load_cases()
            base = len(cases)
            unreadable_files: list[str] = []
            for idx, up in enumerate(_read):
                fname, content = up
                text = _extract_text(fname, content)
                if not text.strip():
                    unreadable_files.append(fname)
                    continue
                parsed = LL.parse_survey_text(text)
                loc = None
                g = LL.geocode(parsed.get("presumed_area") or "")
                if g:
                    loc = [round(g[0], 6), round(g[1], 6)]
                parsed.update({"id": base + idx + 1, "source_file": fname, "location": loc})
                cases.append(parsed)
            _save_cases(cases)
            result = _pipeline(cases, towers)
            result["narrative"] = _example_narrative(result)
            result["report_draft"] = LL.build_report_draft(result, use_llm=True)
            result["unreadable_files"] = unreadable_files
            return result

    # Read file bytes in the async context, then run the CPU/IO pipeline off-thread.
    _read = [(up.filename or f"survey_{i}.txt", await up.read()) for i, up in enumerate(files)]
    return await run_in_threadpool(work)


@router.get("/surveillance/state")
async def surveillance_state(cooling_towers: str | None = None,
                             _: dict = Depends(require_admin)) -> dict[str, Any]:
    towers = _parse_towers(cooling_towers)
    return await run_in_threadpool(lambda: _pipeline(_load_cases(), towers))


@router.post("/surveillance/recompute")
async def surveillance_recompute(cooling_towers: str | None = Form(None),
                                 _: dict = Depends(require_admin)) -> dict[str, Any]:
    """Re-run match + hotspot against updated cooling towers without new uploads."""
    towers = _parse_towers(cooling_towers)
    return await run_in_threadpool(lambda: _pipeline(_load_cases(), towers))


@router.post("/surveillance/reset")
async def surveillance_reset(_: dict = Depends(require_admin)) -> dict[str, Any]:
    with _lock:
        _save_cases([])
    return {"status": "ok", "cases": 0}


# ── 예시 분석 (stateless synthetic demo, pre-warmed) ─────────────────────────
def _example_narrative(result: dict) -> dict:
    """A small headline summary for the demo panel (routes + the multi-case convergence)."""
    crs = result.get("case_results", [])
    routes: dict[str, int] = {}
    for cr in crs:
        lab = (cr.get("route") or {}).get("label") or "불분명"
        routes[lab] = routes.get(lab, 0) + 1
    plan = (result.get("hotspots") or {}).get("plan", [])
    convergence = next((p for p in plan if p.get("linked_case_count", 0) >= 2), None)
    return {"total_cases": len(crs), "hotspot_count": len(plan),
            "route_summary": routes, "convergence": convergence}


def _compute_example() -> dict:
    """Run the 4 synthetic surveys through the full pipeline without persisting anything."""
    cases: list[dict] = []
    for idx, p in enumerate(sorted(_SYNTH_DIR.glob("case_*.txt"))):
        try:
            text = p.read_text(encoding="utf-8")
        except Exception:
            continue
        parsed = LL.parse_survey_text(text, use_llm=False)  # deterministic, offline
        g = LL.demo_geocode(parsed.get("presumed_area") or "")  # curated → reproducible
        parsed.update({"id": idx + 1, "source_file": p.name,
                       "location": [round(g[0], 6), round(g[1], 6)] if g else None})
        cases.append(parsed)
    result = _pipeline(cases, [])          # towers empty (national default)
    result["narrative"] = _example_narrative(result)
    result["report_draft"] = LL.build_report_draft(result, use_llm=True)  # AI 초안 (템플릿 폴백)
    result["example"] = True
    return result


def _get_example() -> dict:
    global _EXAMPLE_CACHE
    with _example_lock:
        if _EXAMPLE_CACHE is None:
            _EXAMPLE_CACHE = _compute_example()
        return _EXAMPLE_CACHE


def _prewarm_example() -> None:
    try:
        _get_example()
    except Exception:
        pass


@router.get("/surveillance/example")
async def surveillance_example() -> dict[str, Any]:
    """Pre-warmed synthetic investigation demo (no auth, no state, instant)."""
    return await run_in_threadpool(_get_example)


# Warm the demo in the background so the first judge request is instant. Parsing is offline
# (use_llm=False) so this is pure local file IO. Skipped under pytest so test collection stays
# side-effect-free; the endpoint's lazy cache still computes on first request if unwarmed.
if not os.getenv("PYTEST_CURRENT_TEST"):
    threading.Thread(target=_prewarm_example, daemon=True).start()
