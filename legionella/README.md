# Legionella surveillance AI — 수동 판독 PoC

레지오넬라 위험을 **V-World 위성영상** 위에 세 계층으로 표출하는 데모입니다. 현재 Sentinel 앱의
**SURVEILLANCE INTELLIGENCE** 탭에 React 컴포넌트로 통합되어 있습니다.

1. **냉각탑** — 사람이 위성영상을 판독해 찍은 점 (GeoJSON). **자동 탐지가 아닙니다.**
2. **취약시설** — LocalData 인허가(목욕장업·숙박업·병원/의원) 위치.
3. **위험 히트맵** — 위 둘의 가중합 (냉각탑 가중치 > 시설).

**원칙:** ML 학습·GPU 추론 없음, 무거운 딥러닝 의존성 없음. 국내 Open API(V-World, LocalData)만
사용. 환자·개인정보 일절 미사용(환경/시설 공개데이터만). 대상은 한 개 구(기본: 서울 중구,
center=[37.5636, 126.9976], zoom=15).

## 앱에서 보기 (통합 탭)
빌드/실행은 기존 Sentinel 프런트엔드 그대로입니다.
- 백엔드 env `VWORLD_KEY` 설정 → 프런트가 `/config/vworld-key`로 받아 타일을 로드합니다.
  (V-World 클라이언트 타일 키가 브라우저에 노출되는 것은 정상 — **도메인 락**으로 보호됩니다.
  등록 도메인(localhost, 배포 도메인)에서만 동작.)
- 상단 **SURVEILLANCE INTELLIGENCE** 탭 → 위성 지도 + 레이어 토글/범례/판독 도구.

### 냉각탑 디지타이징
- "지도 클릭으로 추가" 체크 후 위성영상 위를 클릭 → 냉각탑 점 추가.
- 마커 클릭 → 삭제.
- **GeoJSON 저장** → 현재 점들을 `cooling_towers.geojson`(WGS84 `[lng,lat]`)으로 다운로드.
- 앱은 로드 시 `frontend/public/data/cooling_towers.geojson`이 있으면 불러오고, 없으면 중구 내
  예시 점 5개로 시작합니다(실제 판독으로 교체하세요). 저장한 파일을 그 경로에 두면 고정됩니다.

## 취약시설 데이터 준비 (`prepare_data.py`)
데모는 `frontend/public/data/facilities.geojson` 샘플로 바로 동작합니다. 실제 데이터로 바꾸려면:

```bash
pip install requests python-dotenv
# 프로젝트 루트 .env 에 VWORLD_KEY, LOCALDATA_KEY 설정
python3 legionella/prepare_data.py   # -> frontend/public/data/facilities.geojson 갱신
```

- LocalData Open API로 대상 구의 업종 인허가 목록을 받아 주소를 V-World 지오코더
  (`request=getcoord`, `crs=EPSG:4326`)로 위경도화합니다.
- **정확한 엔드포인트·업종코드(opnSvcId)·지역코드(localCode)·파라미터는 반드시
  [localdata.go.kr] 공식 가이드로 확인**하세요(스크립트 상단의 값은 확인용 placeholder이며 임의
  추정 금지). LocalData가 좌표를 직접 제공하면 EPSG를 문서로 확인 후 `pyproj`로 4326 변환도 가능.

## 좌표계
- 지도: EPSG:3857(Web Mercator, Leaflet 기본).
- 모든 GeoJSON: WGS84(EPSG:4326), `[lng, lat]` 순서.

## 데이터 출처 · 이용약관
- 위성영상/지오코더: **V-World**(국토교통부) — 영상 및 API 이용약관 준수.
- 시설 인허가: **LocalData**(localdata.go.kr) 공개데이터.
- 환자·개인정보 미사용.

## 한계와 확장
- 현재는 **수동 판독 개념증명**입니다(냉각탑 자동 탐지 없음).
- 추후 공개 냉각탑 탐지기 **TowerScout**(CC-BY-NC-SA-4.0)로 냉각탑 계층을 자동화할 수 있습니다.
- 문제 발생 시 점검: (a) VWORLD_KEY 유효성, (b) 도메인 등록(localhost/배포 도메인),
  (c) 타일 URL 레이어명/확장자(Satellite=.jpeg, Hybrid/Base/gray/midnight=.png).
