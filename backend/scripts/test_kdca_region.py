import requests
import json
import urllib.parse

base_url = "https://apis.data.go.kr/1790387/EIDAPIService"
api_key = "25ac8da3a174e6fbf48e5f9bcc7786d566e67debe50164ee459c41f67b612f77"
url = base_url + "/Region"

def test_api(sido="11"):
    query_string = f"?serviceKey={api_key}&resType=2&searchType=1&searchYear=2023&pageNo=1&numOfRows=10"
    if sido is not None:
        query_string += f"&searchSidoCd={sido}"
        
    full_url = url + query_string
    print(f"Testing Sido: '{sido}'")
    try:
        response = requests.get(full_url, verify=False)
        data = response.json()
        print(json.dumps(data, indent=2, ensure_ascii=False))
    except Exception as e:
        print("Error:", e)
        print("Response:", response.text[:500])

test_api("11")
