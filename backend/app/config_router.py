import json
from pathlib import Path
from typing import Any
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .auth import require_admin

router = APIRouter()

CONFIG_FILE = Path(__file__).resolve().parent.parent / "data" / "keywords_config.json"


class ConfigSection(BaseModel):
    """Loose schema — different sections of keywords_config.json use different
    field names (korea_news has queries_ko/queries_en/exclude_ko/exclude_en,
    while global_news and trends use a flat queries/exclude). Make every
    field optional so response validation never fails on legitimate input."""
    queries: list[str] | None = None
    queries_ko: list[str] | None = None
    queries_en: list[str] | None = None
    exclude: str | None = None
    exclude_ko: str | None = None
    exclude_en: str | None = None


class KeywordsConfigModel(BaseModel):
    korea_news: ConfigSection
    global_news: ConfigSection
    trends: ConfigSection


# NOTE: no response_model on the GET — the JSON file is the source of truth
# and may carry future fields the schema doesn't know about. Returning the
# parsed dict directly avoids 500s from response validation.
@router.get("/config/keywords")
def get_keywords_config() -> dict[str, Any]:
    if not CONFIG_FILE.exists():
        raise HTTPException(status_code=404, detail="Config not found.")
    return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))


@router.post("/config/keywords")
def update_keywords_config(config: KeywordsConfigModel, _: dict = Depends(require_admin)):
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(config.model_dump_json(indent=2), encoding="utf-8")
    return {"status": "ok", "message": "Keywords configuration updated successfully."}
