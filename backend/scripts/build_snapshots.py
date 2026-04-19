import json
from pathlib import Path
import copy

def load_json(path: Path) -> dict:
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def load_list(path: Path) -> list:
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return []

def build_snapshots():
    base_dir = Path(__file__).resolve().parent.parent
    data_dir = base_dir / "data"
    
    # Load sources
    mock_korea = load_list(data_dir / "mock" / "mock_korea_alerts.json")
    kdca_national = load_json(data_dir / "processed" / "kdca_national_w1_w10.json")
    kdca_regional_ww = load_json(data_dir / "processed" / "kdca_wastewater_regional.json")
    
    # 10 Weekly dates for 2026 W1-W10
    from datetime import date, timedelta
    start_date = date(2026, 1, 4)
    dates = [(start_date + timedelta(weeks=i)).strftime("%Y-%m-%d") for i in range(10)]
    
    snapshots_dir = data_dir / "processed" / "snapshots"
    snapshots_dir.mkdir(parents=True, exist_ok=True)
    
    # Scoring helpers
    import sys
    sys.path.append(str(base_dir))
    from app.scoring import score_to_level
    
    level_to_score = {"G0": 0.1, "G1": 0.35, "G2": 0.65, "G3": 0.9}

    for current_date in dates:
        snapshot_data = copy.deepcopy(mock_korea)
        
        # Get data for this date
        nat_data = kdca_national.get(current_date, {})
        reg_ww_data = kdca_regional_ww.get(current_date, {})
        
        for region_obj in snapshot_data:
            region_name = region_obj["region_name_en"]
            
            # --- LAYER 1: National Respiratory (ILI/ARI/SARI) ---
            # We add a custom layer field that the frontend can pick up
            nat_level = nat_data.get("alert_level", "G0")
            region_obj["national_respiratory"] = {
                "level": nat_level,
                "score": level_to_score[nat_level],
                "details": nat_data.get("details", {})
            }
            
            # --- LAYER 2: Regional Wastewater (COVID/Flu) ---
            # We specifically use the regional data extracted from PDF
            reg_ww = reg_ww_data.get(region_name, {"covid19": "G0", "influenza": "G0"})
            region_obj["regional_wastewater"] = {
                "covid19": {
                    "level": reg_ww["covid19"],
                    "score": level_to_score[reg_ww["covid19"]]
                },
                "influenza": {
                    "level": reg_ww["influenza"],
                    "score": level_to_score[reg_ww["influenza"]]
                }
            }
            
            # Update the main signal for wastewater to be the max of covid/flu for visualization
            ww_score = max(level_to_score[reg_ww["covid19"]], level_to_score[reg_ww["influenza"]])
            region_obj["signals"]["wastewater_pathogen"] = ww_score
            
            # Update the composite score for this snapshot (Legacy support)
            # For now, let's just make the primary 'level' reflect the wastewater data if available
            region_obj["score"] = ww_score
            region_obj["level"] = score_to_level(ww_score)
            region_obj["date"] = current_date
            
        out_file = snapshots_dir / f"{current_date}.json"
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump(snapshot_data, f, indent=2, ensure_ascii=False)
            
        print(f"Generated snapshot for {current_date} with layers.")

if __name__ == "__main__":
    build_snapshots()
