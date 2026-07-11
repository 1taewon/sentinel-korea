# Legionella Surveillance Intelligence (부산) — 위험지도 + 조사 우선순위

Sentinel 앱의 **SURVEILLANCE INTELLIGENCE → Legionella surveillance** 방법론으로 통합된
데모입니다(별도 Flask 서버 없음 · React 탭 + FastAPI 백엔드).

두 축으로 구성합니다.

**(A) 상시 위험지도** — V-World 위성영상 위에
1. **냉각탑** — 사람이 위성영상을 판독해 찍은 점(GeoJSON). **자동 탐지가 아닙니다.** 지도 내
   디지타이징 도구(클릭 추가 / 마커 클릭 삭제 / GeoJSON 저장) 제공.
2. **고위험 시설** — 목욕장업(행안부 공개데이터) + 고위험 병원(심평원, 상급종합·종합·요양).
3. **위험 히트맵** — PHWR(2021) 검출률 가중. **환경 오염 경향이며 환자 발생 예측이 아닙니다.**

**(B) 사건 대응**(Phase 5–6, 진행 예정) — 비식별 역학조사서를 업로드하면 Gemini로 파싱해 공통
노출원을 좁히고, "어디부터 조사할지"를 **조사 우선순위 Hotspot**(순위 배지 + 권장 조사 반경)으로
지도에 표출, 추정감염경로·종합의견 초안 제시.

## 대상 · 프레이밍
- 기본 **전국**(center=[36.4,127.9], zoom=7). 조사서가 들어오면 그 주소 지역으로 지도가 자동 포커스(fitBounds)된다.
  데이터 준비 스크립트는 `TARGET_SIDO`(빈 값=전국, 예 "부산"), `TARGET_SGGU`(옵션)로 한 지역만 뽑을 수도 있음.
  (참고: 부산은 2019–2021 평균 환경 검출률 32.2%로 전국 최고.)
- **위험 히트맵 = 환경 오염 경향, 환자 발생 예측 아님**(2021 PHWR: 지역 검출률과 환자 발생률 상관
  없음 — 제주 발생률 최고인데 검출률 평균 이하, 부산 검출률 최고인데 발생률 평균 이하).
- **냉각탑 = 위성 판독 좌표**(공개 등록부 없음).
- Hotspot = 노출 후보의 시공간 밀집(확정 감염원 아님). 채수·배양에서 환자와 동일 병원체 일치로
  오염원 확정, 최종 판단은 역학조사관.
- 역학조사 모듈은 **합성·비식별 데이터 데모**. 실제 환자 조사서(성명·주민번호·주소·연락처)는
  외부로 보내지 않음.

## PHWR 위험 가중치 (시설유형)
온천 0.394 · 찜질방 0.375 · 상급종합 0.35 · 대형목욕탕 0.328 · 종합병원 0.263 · 요양병원 0.20 ·
전체 0.164. 냉각탑 0.5. 부산 지역계수 0.296(단일 데모면 상수).

## 데이터 준비
데모는 `frontend/public/data/facilities_bath.geojson`·`facilities_hospital.geojson` 샘플로 바로
동작합니다(부산 예시 점). 실데이터로 바꾸려면:

```bash
pip install -r legionella/requirements.txt
# 프로젝트 루트 .env: VWORLD_KEY (타일+지오코더, 도메인 등록), GEMINI_API_KEY
# legionella/data/raw/ 에 공공데이터포털 CSV 두 개(행안부 목욕장업, 심평원 병의원 현황)를 넣는다.
python3 legionella/scripts/01_prepare_baths.py      # 목욕장업 → 부산·영업중 → EPSG:5174→4326 → facilities_bath.geojson
python3 legionella/scripts/02_prepare_hospitals.py  # 병의원 → 부산·고위험 종별 → XPos/YPos(WGS84) → facilities_hospital.geojson
python3 legionella/scripts/03_build_risk.py         # 위 + 냉각탑 → PHWR 가중 → risk_points.geojson
```
스크립트는 파일명이 아니라 **컬럼**으로 CSV를 판별합니다. CP949/UTF-8 인코딩 자동 시도.

## 중요한 좌표/엔드포인트 사실
- 지방행정인허가데이터개방(localdata.go.kr) 2026-04-16 폐쇄 → 목욕장업은 **공공데이터포털(data.go.kr)
  파일** 사용.
- **목욕장업 좌표 = EPSG:5174(Bessel 중부원점TM)** → pyproj로 4326 변환. 결측/이상치는 주소를
  V-World 지오코더(`request=getcoord`, `crs=EPSG:4326`)로 보완.
- **병원(심평원) XPos/YPos = 이미 WGS84** → 지오코딩 불필요. 종별은 `clCdNm` 텍스트로 필터.
- 인허가 파일에는 폐업 포함 → 영업상태 영업중/정상만 남김.
- 지도 EPSG:3857, 모든 GeoJSON은 WGS84 [lng,lat]. 거리·격자·hotspot 계산은 EPSG:5179 투영 후
  출력만 4326.
- V-World 클라이언트 타일 키는 브라우저 노출이 정상(도메인 락). 백엔드 `GET /config/vworld-key`로 전달.

## 출처 · 약관
V-World 위성영상(ToS) · 공공데이터포털(목욕장업·병의원 현황) · PHWR 2021 레지오넬라 환경검사 분석(가중치 근거).

## 한계 · 확장
- 냉각탑은 현재 수동 판독 개념증명 → 추후 공개 탐지기 **TowerScout**(CC-BY-NC-SA-4.0)로 자동화 가능.
- 실서비스 전환 시 조사·업로드 모듈은 외부 API가 아닌 KDCA 내부망/온프레미스, 실제 개인정보는
  개인정보 보호법·위탁 요건 준수.
- 실행 실패 점검: (a) VWORLD_KEY·도메인 등록, (b) data/raw 파일·컬럼, (c) 타일 레이어명/확장자
  (Satellite=.jpeg, Hybrid=.png), (d) hotspot 이상 시 EPSG:5179 투영·거리 우선 점검.
