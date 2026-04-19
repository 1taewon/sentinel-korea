import json
import os
from datetime import date, timedelta

# Accurate data points based on visual inspection of the charts for weeks 1-10 (2026).
# Alert Levels: G0 (Low), G1 (Guarded), G2 (Elevated), G3 (Critical)

regions = [
    "Seoul", "Busan", "Daegu", "Incheon",
    "Gwangju", "Daejeon", "Ulsan", "Sejong",
    "Gyeonggi-do", "Gangwon-do", "Chungcheongbuk-do", "Chungcheongnam-do",
    "Jeollabuk-do", "Jeollanam-do", "Gyeongsangbuk-do", "Gyeongsangnam-do", "Jeju-do"
]

# Mapping regions from the PDF (Korean) to English keys used in map
region_map = {
    1: "Seoul", 2: "Busan", 3: "Daegu", 4: "Incheon",
    5: "Gwangju", 6: "Daejeon", 7: "Ulsan", 8: "Sejong",
    9: "Gyeonggi-do", 10: "Gangwon-do", 11: "Chungcheongbuk-do", 12: "Chungcheongnam-do",
    13: "Jeollabuk-do", 14: "Jeollanam-do", 15: "Gyeongsangbuk-do", 16: "Gyeongsangnam-do", 17: "Jeju-do"
}

# Covid-19 regional trends (W1-W10)
# Most regions follow: High in Jan (W1-4), then Decelerating in Feb/Mar (W5-10)
covid_regional = {
    "Seoul": ["G2", "G2", "G1", "G1", "G1", "G1", "G1", "G1", "G1", "G1"],
    "Busan": ["G2", "G2", "G2", "G1", "G1", "G1", "G1", "G1", "G1", "G1"],
    "Daegu": ["G3", "G2", "G2", "G1", "G1", "G1", "G1", "G0", "G0", "G0"],
    "Incheon": ["G2", "G2", "G1", "G1", "G1", "G1", "G1", "G1", "G1", "G1"],
    "Gwangju": ["G2", "G2", "G1", "G1", "G1", "G1", "G2", "G2", "G1", "G1"],
    "Daejeon": ["G2", "G2", "G1", "G1", "G1", "G1", "G1", "G1", "G1", "G1"],
    "Ulsan": ["G2", "G1", "G1", "G1", "G0", "G0", "G1", "G1", "G1", "G0"],
    "Sejong": ["G1", "G1", "G1", "G2", "G1", "G1", "G1", "G1", "G1", "G1"],
    "Gyeonggi-do": ["G2", "G2", "G1", "G1", "G1", "G1", "G1", "G1", "G1", "G1"],
    "Gangwon-do": ["G2", "G1", "G1", "G1", "G1", "G1", "G1", "G1", "G1", "G1"],
    "Chungcheongbuk-do": ["G1", "G1", "G1", "G1", "G1", "G1", "G1", "G1", "G1", "G1"],
    "Chungcheongnam-do": ["G2", "G1", "G1", "G1", "G1", "G1", "G1", "G1", "G1", "G1"],
    "Jeollabuk-do": ["G2", "G2", "G2", "G1", "G1", "G1", "G1", "G1", "G1", "G1"],
    "Jeollanam-do": ["G2", "G2", "G1", "G1", "G1", "G1", "G1", "G1", "G1", "G1"],
    "Gyeongsangbuk-do": ["G1", "G1", "G1", "G2", "G2", "G2", "G1", "G1", "G1", "G1"],
    "Gyeongsangnam-do": ["G3", "G2", "G2", "G1", "G1", "G1", "G1", "G1", "G1", "G1"],
    "Jeju-do": ["G2", "G2", "G2", "G1", "G1", "G1", "G1", "G1", "G1", "G1"]
}

# Influenza regional trends (W1-W10)
# Most regions follow: Peaking mid-quarter (W4-7), then decreasing
flu_regional = {
    "Seoul": ["G1", "G1", "G2", "G2", "G2", "G2", "G1", "G1", "G1", "G1"],
    "Busan": ["G2", "G3", "G3", "G3", "G2", "G2", "G2", "G2", "G1", "G1"],
    "Daegu": ["G1", "G1", "G1", "G1", "G1", "G1", "G1", "G1", "G1", "G1"],
    "Incheon": ["G2", "G2", "G3", "G3", "G3", "G3", "G2", "G3", "G2", "G2"],
    "Gwangju": ["G1", "G1", "G1", "G1", "G2", "G3", "G3", "G3", "G1", "G1"],
    "Daejeon": ["G2", "G2", "G1", "G2", "G2", "G3", "G2", "G2", "G2", "G2"],
    "Ulsan": ["G1", "G1", "G2", "G2", "G3", "G2", "G1", "G1", "G2", "G2"],
    "Sejong": ["G2", "G2", "G3", "G3", "G3", "G3", "G2", "G2", "G1", "G1"],
    "Gyeonggi-do": ["G1", "G1", "G1", "G2", "G2", "G3", "G3", "G3", "G2", "G1"],
    "Gangwon-do": ["G1", "G1", "G2", "G3", "G3", "G3", "G1", "G1", "G1", "G1"],
    "Chungcheongbuk-do": ["G2", "G2", "G2", "G2", "G2", "G2", "G1", "G1", "G1", "G1"],
    "Chungcheongnam-do": ["G2", "G2", "G3", "G3", "G3", "G3", "G2", "G2", "G1", "G1"],
    "Jeollabuk-do": ["G0", "G0", "G0", "G0", "G0", "G0", "G0", "G3", "G2", "G1"],
    "Jeollanam-do": ["G0", "G0", "G1", "G2", "G2", "G1", "G1", "G0", "G0", "G0"],
    "Gyeongsangbuk-do": ["G1", "G1", "G2", "G2", "G2", "G2", "G1", "G1", "G1", "G1"],
    "Gyeongsangnam-do": ["G0", "G0", "G1", "G1", "G2", "G2", "G2", "G3", "G2", "G1"],
    "Jeju-do": ["G1", "G1", "G2", "G2", "G2", "G3", "G3", "G2", "G1", "G1"]
}

start_date = date(2026, 1, 4)
output_data = {}

for w in range(10):
    date_str = (start_date + timedelta(weeks=w)).strftime("%Y-%m-%d")
    region_data = {}
    for r in regions:
        region_data[r] = {
            "covid19": covid_regional.get(r, ["G0"]*10)[w],
            "influenza": flu_regional.get(r, ["G0"]*10)[w]
        }
    output_data[date_str] = region_data

out_path = os.path.join(os.path.dirname(__file__), "..", "data", "processed", "kdca_wastewater_regional.json")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(output_data, f, indent=2, ensure_ascii=False)

print(f"Generated detailed regional wastewater data to {out_path}")
