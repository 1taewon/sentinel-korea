import requests

base_url = "https://apis.data.go.kr/1790387/EIDAPIService"

urls_to_try = [
    base_url + "?wadl",
    base_url + "/openapi.json",
    base_url + "/swagger.json",
    base_url + "/v3/api-docs"
]

for url in urls_to_try:
    try:
        print(f"Trying {url}...")
        response = requests.get(url, verify=False, timeout=5)
        print("Status:", response.status_code)
        if response.status_code == 200:
            print("Content:", response.text[:500])
    except Exception as e:
        print("Error:", e)
    print("-" * 40)
