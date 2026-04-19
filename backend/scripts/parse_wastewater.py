import csv
import json
from pathlib import Path
from collections import defaultdict
from typing import Dict, Any

def normalize_wastewater_data(csv_path: Path) -> dict:
    """
    Parses a wastewater CSV and returns a dictionary indexed by Date, then Region.
    Normalizes the concentration vs baseline into a 0.0 - 1.0 signal value.
    """
    if not csv_path.exists():
        print(f"File not found: {csv_path}")
        return {}

    # Structure: { date: { region: signal_value } }
    data_by_date: Dict[str, Dict[str, float]] = defaultdict(dict)

    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            date = row["Date"]
            region = row["Region"]
            
            try:
                conc = float(row["Concentration"])
                baseline = float(row["Baseline"])
            except ValueError:
                continue

            # Calculate a ratio and cap it at 1.0
            # For example, if conc is 2x baseline, it's very critical (1.0)
            # If conc == baseline, it's 0.5
            if baseline > 0:
                ratio = conc / baseline
                # Map 0 -> 0.0, 1.0 -> 0.5, 2.0+ -> 1.0
                signal = min(1.0, ratio * 0.5)
            else:
                signal = 0.0

            # If there are multiple pathogens for a region on the same date, 
            # we'll take the maximum signal to represent the wastewater threat level.
            current_signal = data_by_date[date].get(region, 0.0)
            data_by_date[date][region] = round(max(current_signal, signal), 4)

    return dict(data_by_date)

if __name__ == "__main__":
    raw_dir = Path(__file__).resolve().parent.parent / "data" / "raw"
    csv_file = raw_dir / "wastewater.csv"
    
    parsed = normalize_wastewater_data(csv_file)
    print(json.dumps(parsed, indent=2, ensure_ascii=False))
