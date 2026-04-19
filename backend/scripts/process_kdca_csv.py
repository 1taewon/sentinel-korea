import pandas as pd
import json
import os

# We extract weeks 1-10 for the year 2026.
# Based on the structure of the CSVs provided:

# 1. Influenza Data
# Format: Row 0 has the data. 
# Columns 1-28 appear to be weekly data. We don't have the exact week alignment from the header, 
# but assuming the last 10 entries before the Nan/text represent the most recent weeks.
# Let's extract the array and take the last 10 numerical values.
file_flu = r"C:\Users\han75\OneDrive\Desktop\Sentinel\인플루엔자 선택됨.csv"
try:
    df_flu = pd.read_csv(file_flu, encoding='utf-8', header=None)
except:
    try:
        df_flu = pd.read_csv(file_flu, encoding='cp949', header=None)
    except:
        df_flu = pd.read_csv(file_flu, encoding='euc-kr', header=None)

flu_row = df_flu.iloc[0].values.tolist()
flu_values = []
for v in flu_row:
    try:
        if pd.notna(v):
            flu_values.append(float(v))
    except (ValueError, TypeError):
        pass
# We need weeks 1-10 of 2026. The data clearly shows a trend.
# Looking at the data: 6.6, 6.7 ... 70.9 ... 44.2, 22.3, 17.4
# We will just take the last 10 flu rates for week 1-10.
flu_target = flu_values[-10:] if len(flu_values) >= 10 else flu_values


# 2. ARI (Acute Respiratory Infection) Data
# Format: Columns are: Year, Week, Total, Adeno, Boca, Parainfluenza, Rhino, RSV, hMPV, Corona
file_ari = r"C:\Users\han75\OneDrive\Desktop\Sentinel\급성호흡기감염증 선택됨- 바이러스[전체].csv"
try:
    df_ari = pd.read_csv(file_ari, encoding='utf-8', header=None)
except:
    try:
        df_ari = pd.read_csv(file_ari, encoding='cp949', header=None)
    except:
        df_ari = pd.read_csv(file_ari, encoding='euc-kr', header=None)

# The first 10 rows are exactly weeks 1-10 for 2026
ari_target = []
for i in range(min(10, len(df_ari))):
    row = df_ari.iloc[i]
    if pd.notna(row[2]):
        ari_target.append(int(row[2]))


# 3. SARI (Severe Acute Respiratory Infection) Data
# Format: Row 0 has data.
file_sari = r"C:\Users\han75\OneDrive\Desktop\Sentinel\중증급성호흡기감염증 선택됨.csv"
try:
    df_sari = pd.read_csv(file_sari, encoding='utf-8', header=None)
except:
    try:
        df_sari = pd.read_csv(file_sari, encoding='cp949', header=None)
    except:
        df_sari = pd.read_csv(file_sari, encoding='euc-kr', header=None)

sari_row = df_sari.iloc[0].values.tolist()
sari_values = []
for v in sari_row:
    try:
        if pd.notna(v) and str(v).strip() != ' ' and str(v).strip() != '전체':
            sari_values.append(float(v))
    except (ValueError, TypeError):
        pass

sari_target = sari_values[-10:] if len(sari_values) >= 10 else sari_values

print(f"Flu values (W1-10): {flu_target}")
print(f"ARI values (W1-10): {ari_target}")
print(f"SARI values (W1-10): {sari_target}")


# Alert Levels computation
# G0: Low, G1: Guarded, G2: Elevated, G3: Critical
# Define thresholds dynamically based on max
def get_alert_level(val, max_val):
    ratio = val / max_val if max_val > 0 else 0
    if ratio > 0.75: return "G3"
    if ratio > 0.50: return "G2"
    if ratio > 0.25: return "G1"
    return "G0"

max_flu = max(flu_target) if flu_target else 1
max_ari = max(ari_target) if ari_target else 1
max_sari = max(sari_target) if sari_target else 1

output_data = {}
for i in range(10):
    week_num = i + 1
    
    # Use index safely
    f_val = flu_target[i] if i < len(flu_target) else 0
    a_val = ari_target[i] if i < len(ari_target) else 0
    s_val = sari_target[i] if i < len(sari_target) else 0
    
    # We will pick the highest alert level among the three to represent the "National Respiratory" state
    al_flu = get_alert_level(f_val, max_flu)
    al_ari = get_alert_level(a_val, max_ari)
    al_sari = get_alert_level(s_val, max_sari)
    
    levels = {"G0": 0, "G1": 1, "G2": 2, "G3": 3}
    num_to_level = {0: "G0", 1: "G1", 2: "G2", 3: "G3"}
    max_al = num_to_level[max(levels[al_flu], levels[al_ari], levels[al_sari])]
    
    # 2026 Week to Date approximation (Sundays)
    # W1 approx Jan 4, so let's use strings like '2026-W01' or map to dates used in timeline.
    # The timeline uses "YYYY-MM-DD". Let's map Week 1 to Week 10 to dates starting from 2026-01-04 spaced by 7 days.
    from datetime import date, timedelta
    start_date = date(2026, 1, 4)
    current_date = start_date + timedelta(weeks=i)
    date_str = current_date.strftime("%Y-%m-%d")
    
    output_data[date_str] = {
        "alert_level": max_al,
        "details": {
            "influenza_rate": f_val,
            "ari_cases": a_val,
            "sari_cases": s_val
        }
    }

out_path = os.path.join(os.path.dirname(__file__), "..", "data", "processed", "kdca_national_w1_w10.json")
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(output_data, f, indent=2, ensure_ascii=False)

print(f"Successfully wrote parsed JSON to {out_path}")
