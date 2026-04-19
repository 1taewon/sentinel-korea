import requests
import json

base_url = "https://apis.data.go.kr/1790387/EIDAPIService"
api_key = "25ac8da3a174e6fbf48e5f9bcc7786d566e67debe50164ee459c41f67b612f77"

# First, let's try to hit the root or an invalid endpoint to see the error message which might include hints.
url = base_url + "/getOccrrncList"  # Guessing an operation name
params = {
    "serviceKey": api_key,
    "pageNo": "1",
    "numOfRows": "10",
    "type": "json"
}

try:
    response = requests.get(base_url, params=params, verify=False)
    print("Status:", response.status_code)
    print("Response Text:", response.text[:1000])
except Exception as e:
    print("Error:", e)
