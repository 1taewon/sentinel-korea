import json
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

CONFIG_FILE = Path(__file__).resolve().parent.parent / "data" / "keywords_config.json"

class ConfigSection(BaseModel):
    queries: list[str]
    exclude: str | None = None

class KeywordsConfigModel(BaseModel):
    korea_news: ConfigSection
    global_news: ConfigSection
    trends: ConfigSection

@router.get("/config/keywords", response_model=KeywordsConfigModel)
def get_keywords_config():
    if not CONFIG_FILE.exists():
        raise HTTPException(status_code=404, detail="Config not found.")
    data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    return data

@router.post("/config/keywords")
def update_keywords_config(config: KeywordsConfigModel):
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(config.model_dump_json(indent=2), encoding="utf-8")
    return {"status": "ok", "message": "Keywords configuration updated successfully."}
