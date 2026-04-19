import pandas as pd
import json
import os

files = [
    r"C:\Users\han75\OneDrive\Desktop\Sentinel\인플루엔자 선택됨.csv",
    r"C:\Users\han75\OneDrive\Desktop\Sentinel\급성호흡기감염증 선택됨- 바이러스[전체].csv",
    r"C:\Users\han75\OneDrive\Desktop\Sentinel\중증급성호흡기감염증 선택됨.csv"
]

for f in files:
    print(f"\n--- {os.path.basename(f)} ---")
    try:
        df = pd.read_csv(f, encoding='utf-8', header=None)
    except:
        try:
            df = pd.read_csv(f, encoding='cp949', header=None)
        except:
            df = pd.read_csv(f, encoding='euc-kr', header=None)
    
    # Print the first 5 rows to understand the structure
    print(df.head((10)))
