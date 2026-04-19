import requests
import json
import time
from pathlib import Path

# KDCA Region Endpoint
URL = "https://apis.data.go.kr/1790387/EIDAPIService/Region"
API_KEY = "25ac8da3a174e6fbf48e5f9bcc7786d566e67debe50164ee459c41f67b612f77"

# standard KDCA/Kostat Sido Codes
SIDO_CODES = {
    "11": "Seoul",
    "21": "Busan",
    "22": "Daegu",
    "23": "Incheon",
    "24": "Gwangju",
    "25": "Daejeon",
    "26": "Ulsan",
    "29": "Sejong",
    "31": "Gyeonggi-do",
    "32": "Gangwon-do",
    "33": "Chungcheongbuk-do",
    "34": "Chungcheongnam-do",
    "35": "Jeollabuk-do",
    "36": "Jeollanam-do",
    "37": "Gyeongsangbuk-do",
    "38": "Gyeongsangnam-do",
    "39": "Jeju-do"
}

def fetch_kdca_data(year="2023"):
    """
    Fetches the incidence rate of notifiable diseases for all regions by iterating.
    searchType=2 means incidence rate per 100,000 people.
    """
    region_totals = {}
    
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    
    for sido, region in SIDO_CODES.items():
        params = {
            "serviceKey": API_KEY,
            "resType": "2",       # JSON
            "searchType": "2",    # Incidence rate
            "searchYear": year,
            "searchSidoCd": sido,
            "pageNo": "1",
            "numOfRows": "1000"   
        }
        
        try:
            response = requests.get(URL, params=params, verify=False, timeout=10)
            response.encoding = 'utf-8'
            data = response.json()
            
            if data.get("response", {}).get("header", {}).get("resultCode") != "00":
                print(f"API Error for {region}: {data.get('response', {}).get('header', {}).get('resultMsg')}")
                continue
                
            items = data["response"]["body"]["items"]["item"]
            
            total_rate = 0.0
            for item in items:
                 # API returns both '00' (전국) and the specific 'sido' we requested. Filter for the requested.
                 if item.get("sidoCd") == sido:
                     try:
                         val = float(item["resultVal"])
                         total_rate += val
                     except:
                         pass
            
            region_totals[region] = total_rate
            print(f"Fetched {region}: {total_rate:.2f} incidence rate sum")
            
        except Exception as e:
            print(f"Failed to fetch API for {region}:", e)
            
        # tiny sleep to be nice to open API
        time.sleep(0.1)

    return region_totals

def process_and_save(region_totals):
    """
    Normalizes the total rates to a 0.0 - 1.0 signal.
    """
    if not region_totals:
        print("No region data found to process.")
        return
        
    # We find the max total or use a sensible cap to normalize values
    # In reality, this cap might be determined historically.
    # Let's dynamically find max to ensure good color spread,,
    # but give a reasonable floor so we don't blow up tiny numbers.
    max_val = max(region_totals.values())
    cap = max(max_val, 1000.0)
    
    results = {}
    for region, total in region_totals.items():
        signal = min(1.0, total / cap)
        results[region] = round(signal, 4)
        
    out_dir = Path(__file__).resolve().parent.parent / "data" / "processed"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "kdca_notifiable.json"
    
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
        
    print(f"\nSaved processed data for {len(results)} regions to {out_file.name}")
    print("Sample Output:", json.dumps(list(results.items())[:3], ensure_ascii=False))

if __name__ == "__main__":
    totals = fetch_kdca_data("2023")
    if totals:
        process_and_save(totals)
