"""pipeline_runner.py — In-process weekly pipeline orchestrator.

Replaces the Vercel cron function (`api/cron/weekly-refresh.ts`), which hit a
hard 300-second serverless timeout and never reached the analysis/report steps.

This runs INSIDE the long-running Railway web service, so there is no execution
time limit. It drives the same pipeline by calling the backend's own HTTP
endpoints over loopback (127.0.0.1), which reuses all existing auth / request /
BackgroundTasks handling with zero refactoring.

Triggered by:
  - APScheduler cron job (every Monday 07:00 KST) — see main.py startup
  - Manual admin call to POST /scheduler/run-now
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

PROCESSED_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
STATUS_FILE = PROCESSED_DIR / "scheduler_last_run.json"

KST = timezone(timedelta(hours=9))

# Pipeline steps — mirrors api/cron/weekly-refresh.ts, but with NO 300s limit.
#   name      : display/log label
#   path      : backend endpoint (called over loopback)
#   body      : JSON body to POST (None → no body)
#   timeout   : per-step client timeout in seconds (generous; Trends backoff is slow)
#   critical  : informational only — pipeline is best-effort and never aborts,
#               so that the FINAL report is still produced from whatever data exists
STEPS: list[dict[str, Any]] = [
    # Phase 1: Data ingestion (non-critical — best-effort)
    {"name": "korea_news",   "path": "/ingestion/refresh-korea",           "body": None,                   "timeout": 240,  "critical": False},
    {"name": "trends",       "path": "/ingestion/refresh-trends",          "body": None,                   "timeout": 720,  "critical": False},
    {"name": "global",       "path": "/ingestion/refresh-global",          "body": None,                   "timeout": 720,  "critical": False},
    {"name": "kdca_api",     "path": "/ingestion/refresh-kdca-notifiable", "body": None,                   "timeout": 240,  "critical": False},
    # Phase 2: AI analysis (critical — these update the dashboard / latest analysis date)
    {"name": "kdca_digest",  "path": "/risk-analysis/kdca-digest",         "body": None,                   "timeout": 240,  "critical": True},
    {"name": "osint",        "path": "/risk-analysis/analyze-news-trends", "body": None,                   "timeout": 360,  "critical": True},
    {"name": "sentinel",     "path": "/risk-analysis/analyze",             "body": {"include_kdca": True}, "timeout": 360,  "critical": True},
    # Phase 3: Reports
    {"name": "final_report", "path": "/reports/generate-final",            "body": None,                   "timeout": 360,  "critical": True},
    {"name": "disease_forecast_reports", "path": "/ontology/disease-forecast-reports/generate-all", "body": None, "timeout": 720, "critical": False},
    # Phase 4: Email dispatch (non-critical)
    {"name": "email_send",   "path": "/reports/send-weekly",               "body": None,                   "timeout": 120,  "critical": False},
]

# Module-level guard so two triggers (cron + manual) can't overlap.
_running = False


def _base_url() -> str:
    """Loopback URL of this very server. Railway injects PORT; default 8000 locally."""
    port = os.getenv("PORT", "8000")
    return f"http://127.0.0.1:{port}"


def _now() -> datetime:
    return datetime.now(KST)


def _write_status(payload: dict[str, Any]) -> None:
    try:
        PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
        import json
        STATUS_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as exc:  # status persistence must never crash the pipeline
        print(f"[pipeline] status write failed: {exc}")


def read_status() -> dict[str, Any]:
    if STATUS_FILE.exists():
        try:
            import json
            return json.loads(STATUS_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def is_running() -> bool:
    return _running


async def run_weekly_pipeline(trigger: str = "schedule") -> dict[str, Any]:
    """Run every pipeline step sequentially over loopback. Best-effort, never aborts.

    `trigger` is just a label ("schedule" | "manual") recorded in the status file.
    Returns a summary dict and also persists progress to scheduler_last_run.json.
    """
    global _running
    if _running:
        print("[pipeline] already running — ignoring duplicate trigger")
        return {"status": "already_running"}
    _running = True

    token = os.getenv("SENTINEL_ADMIN_TOKEN", "")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    else:
        print("[pipeline] WARNING: SENTINEL_ADMIN_TOKEN not set — admin endpoints will 401")

    base = _base_url()
    started = _now()
    results: list[dict[str, Any]] = []

    def _snapshot(status: str) -> dict[str, Any]:
        return {
            "status": status,
            "trigger": trigger,
            "started_at": started.isoformat(),
            "started_at_kst": started.strftime("%Y-%m-%d %H:%M:%S KST"),
            "steps_total": len(STEPS),
            "steps_ok": sum(1 for r in results if r.get("ok")),
            "results": results,
        }

    print(f"[pipeline] >> weekly pipeline START (trigger={trigger}) at {started.isoformat()}")
    _write_status(_snapshot("running"))

    try:
        # Names of critical steps that failed — used to gate the email dispatch.
        critical_failed: list[str] = []
        for step in STEPS:
            step_started = _now()
            entry: dict[str, Any] = {"step": step["name"], "critical": step["critical"]}

            # Quality gate: never email a defective report. If any critical step
            # (kdca_digest / osint / sentinel / final_report) failed, skip dispatch.
            if step["name"] == "email_send" and critical_failed:
                entry.update({
                    "skipped": True,
                    "reason": f"critical step(s) failed: {', '.join(critical_failed)}",
                    "duration_s": 0.0,
                })
                results.append(entry)
                print(f"[pipeline]   [SKIP] email_send - 발송 보류 (critical 실패: {critical_failed})")
                _write_status(_snapshot("running"))
                continue

            try:
                async with httpx.AsyncClient(timeout=step["timeout"]) as client:
                    resp = await client.post(
                        f"{base}{step['path']}",
                        headers=headers,
                        json=step["body"],  # httpx omits body when None
                    )
                ok = resp.status_code < 400
                entry.update({"status": resp.status_code, "ok": ok})
                if not ok:
                    entry["detail"] = resp.text[:300]
                    if step["critical"]:
                        entry["critical_failure"] = True
                        critical_failed.append(step["name"])
                tag = "[ok]" if ok else "[FAIL]"
                print(f"[pipeline]   {tag} {step['name']} -> HTTP {resp.status_code} "
                      f"({(_now() - step_started).total_seconds():.0f}s)")
            except Exception as exc:
                entry.update({"ok": False, "error": str(exc)})
                if step["critical"]:
                    entry["critical_failure"] = True
                    critical_failed.append(step["name"])
                print(f"[pipeline]   [FAIL] {step['name']} -> ERROR: {exc} "
                      f"({(_now() - step_started).total_seconds():.0f}s)")

            entry["duration_s"] = round((_now() - step_started).total_seconds(), 1)
            results.append(entry)
            _write_status(_snapshot("running"))  # persist after every step

        finished = _now()
        summary = _snapshot("completed")
        summary.update({
            "finished_at": finished.isoformat(),
            "finished_at_kst": finished.strftime("%Y-%m-%d %H:%M:%S KST"),
            "duration_s": round((finished - started).total_seconds(), 1),
        })
        _write_status(summary)
        print(f"[pipeline] == weekly pipeline DONE - {summary['steps_ok']}/{summary['steps_total']} ok, "
              f"{summary['duration_s']:.0f}s total")
        return summary
    finally:
        _running = False
