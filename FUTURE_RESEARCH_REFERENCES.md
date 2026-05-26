# Sentinel Korea — Future Update: Multi-Source Surveillance Integration Research

**Date:** 2026-05-09
**Purpose:** KDCA API 요청 근거 자료 + 향후 지표 확장 로드맵을 위한 연구 레퍼런스 정리

---

## 1. 기반 문서 — WHO 2014

**WHO. "Early Detection, Assessment and Response to Acute Public Health Events"**
(WHO/HSE/GCR/LYO/2014.4)

- 다중 독립 데이터 소스 통합의 원칙 정립
- 사건기반감시(EBS) + 지표기반감시(IBS) 병행 프레임워크
- Sentinel Korea의 6-lane 구조 설계 근거

---

## 2. 한국 KDCA 감시체계 관련

### 2-1. 한국 감시체계 방향성 (2025)
**"Surveillance System for Infectious Disease Prevention and Management: Direction of Korea's Infectious Disease Surveillance System"**
- Journal of Korean Medical Science, 2025
- https://jkms.org/DOIx.php?id=10.3346/jkms.2025.40.e108
- https://pmc.ncbi.nlm.nih.gov/articles/PMC11876785/

**핵심 내용:**
- 한국의 감시체계들이 현재 독립적으로 운영되어 기관 간 연계가 약함
- WHO/ECDC/US CDC는 통합 감시체계로 데이터 공유, 정책 조정, 글로벌 협력 추진 중
- 2023년부터 한국도 17개 시/도 하수 감시(Korea Wastewater Surveillance) 시행
- **Sentinel Korea 적용:** 독립 감시체계를 하나의 composite risk로 통합하는 것이 이 논문이 지적하는 gap을 정확히 메우는 접근

### 2-2. 한국 SARI 역학 데이터 (2025)
**"Epidemiology of Severe Acute Respiratory Infection in Korea: 2022 to 2024 Surveillance Data"**
- PMC, 2025
- https://pmc.ncbi.nlm.nih.gov/articles/PMC12235279/

**핵심 내용:**
- 한국 SARI 감시 데이터 분석 (2022-2024)
- 한계점: 병원 기반 표본감시 특성상 지역적 대표성 부족 — 시설 분포가 인구에 비례하지 않으면 지역 격차를 포착하지 못함
- **Sentinel Korea 적용:** 시/도별 다중 소스 통합 위험도 산출이 이 한계를 보완

### 2-3. 한국 EBS/RRA 체계 (2023)
**"Event-based Surveillance and Rapid Risk Assessment of Infectious Diseases in the Republic of Korea"**
- PMC, 2023
- https://pmc.ncbi.nlm.nih.gov/articles/PMC10186898/

**핵심 내용:**
- 2015 MERS 이후 KDCA가 구축한 사건기반감시(EBS) + 신속위험평가(RRA)
- 초기 단계에서 잠재적 공중보건 위협을 탐지, 평가, 경보
- **Sentinel Korea 적용:** Global Outbreak 모니터링 + 자동 위험 분석이 EBS 개념의 디지털 구현

---

## 3. 다중 소스 통합 프레임워크

### 3-1. 위험 모니터링 임베딩 (2025)
**"Embedding Risk Monitoring in Infectious Disease Surveillance for Timely and Effective Outbreak Prevention and Control"**
- PMC, 2025
- https://pmc.ncbi.nlm.nih.gov/articles/PMC11836831/

**핵심 내용:**
- COVID-19 이후 개발된 하수 감시, 결석률 모니터링 등 확장 감시체계를 기존 감시와 통합 평가
- 개별 감시 신호를 독립적으로 보는 게 아니라 risk monitoring framework에 embedding하여 종합 판단
- **Sentinel Korea 적용:** 6개 lane을 하나의 risk framework로 embedding하는 현재 구조가 정확히 이 접근법

### 3-2. 글로벌 조기경보 모델 리뷰 (2025)
**"Global Infectious Disease Early Warning Models: An Updated Review and Lessons from the COVID-19 Pandemic"**
- ScienceDirect / PMC, 2025
- https://pmc.ncbi.nlm.nih.gov/articles/PMC11731462/
- https://www.sciencedirect.com/science/article/pii/S2468042724001271

**핵심 내용:**
- 전 세계 조기경보 모델 종합 리뷰
- 현대 감시체계: 다중 소스 데이터(역학, 웹, 기후, 하수) 통합 + AI/ML로 정확도/민감도 향상
- **Sentinel Korea 적용:** 6개 lane 구조 (전수신고 + ILI + SARI + ARI + 하수 + 해외발생) 와 부합

### 3-3. 감시 진보와 도전 (2025)
**"Progress and Challenges in Infectious Disease Surveillance and Early Warning"**
- ScienceDirect, 2025
- https://www.sciencedirect.com/science/article/pii/S2950347725000027

**핵심 내용:**
- 감시 데이터의 범위가 증상, 위험인자(기상, 매개체 밀도, 병원체), 인구이동, 인터넷 검색까지 확장
- 다채널 데이터 통합이 시공간적 전파 양상 평가에 필수적

---

## 4. Syndromic Surveillance + 데이터 융합

### 4-1. Syndromic Surveillance 성능 리뷰 (2026)
**"Syndromic Surveillance — Review on Different Practices' Performance and Added Value for Public Health"**
- MDPI, 2026 (최신)
- https://www.mdpi.com/2673-3986/7/1/23

**핵심 내용:**
- 데이터 소스별 성능 비교:
  - 응급실 데이터: 민감도 47.34%, 특이도 91.95% (가장 높음)
  - 약국/OTC 판매: 커뮤니티 수준 조기 지표
  - 시민 참여 데이터: 초기 단계 포착
- 다중 소스 통합 시 실험실 보고 대비 2~14일 조기 탐지 가능
- ESSENCE (Johns Hopkins), SurSaUD (프랑스) 등 통합 시스템 사례
- **Sentinel Korea 적용:** 조기 탐지 2~14일 수치가 다중 소스 통합의 정량적 근거

### 4-2. 인터넷 기반 감시 시스템 (2024)
**"Internet-based Surveillance Systems and Infectious Diseases Prediction: An Updated Review of the Last 10 Years"**
- Springer Nature, 2024
- https://link.springer.com/article/10.1007/s44197-024-00272-y

**핵심 내용:**
- 인터넷 기반 데이터(검색 트렌드, 소셜미디어)를 전통 감시와 통합
- 질병별로 다중 소스 그룹화 후 융합 예측
- **Sentinel Korea 적용:** 네이버 트렌드 수집 기능이 이미 이 접근법 일부 구현 중

### 4-3. AI 기반 조기경보 체계적 리뷰 (2025)
**"Artificial Intelligence in Early Warning Systems for Infectious Disease Surveillance: A Systematic Review"**
- PMC, 2025
- https://pmc.ncbi.nlm.nih.gov/articles/PMC12230060/

**핵심 내용:**
- ML, 딥러닝, NLP가 다양한 데이터 소스(역학, 웹, 기후, 하수)를 통합
- 하수 감시가 무증상 감염까지 포착하는 unbiased data source로 부상
- **Sentinel Korea 적용:** Gemini 기반 분석 + 다중 lane 통합이 이 방향과 일치

---

## 5. 하수 감시 통합 방법론

### 5-1. 하수 → 역학 모델링 전략 (2025)
**"From Wastewater to Epidemiological Insights: A Systematic Review of Modeling Strategies for Infectious Disease Surveillance"**
- ScienceDirect, 2025
- https://www.sciencedirect.com/science/article/pii/S0043135425018809

**핵심 내용:**
- 하수 데이터 → 역학적 추정 모델링 전략 체계적 리뷰
- 추가 설명 변수(ILI, 입원 등)와 결합 시 예측 정확도 향상
- 단, 과도한 변수는 과적합(overfitting) 위험
- **Sentinel Korea 적용:** 하수 lane + ILI lane + SARI lane 통합 시 overfitting 방지 전략 필요

### 5-2. 하수 감시의 공중보건 활용 (National Academies)
**"Wastewater Surveillance for Communicable Diseases"**
- NCBI Bookshelf (National Academies)
- https://www.ncbi.nlm.nih.gov/books/NBK601834/

**핵심 내용:**
- 미국 National Academies 종합 보고서
- 하수 감시를 기존 법정감염병 신고체계에 통합 권고
- 국가 인프라 활용이 공중보건 실행력 극대화

### 5-3. CDWSRank — 하수 감시 질병 우선순위 랭킹 (2023)
**"Wastewater Surveillance Beyond COVID-19: A Ranking System for Communicable Disease Testing"**
- PMC, 2023
- https://pmc.ncbi.nlm.nih.gov/articles/PMC10272568/

**핵심 내용:**
- 96개 감염병을 하수 감시 우선순위로 랭킹하는 composite scoring system
- 이진 파라미터(CDC 신고 대상 여부, 하수 검출 가능성) + 정량 파라미터 결합
- **Sentinel Korea 적용:** lane별 가중치 접근법과 유사한 방법론. 향후 가중치 최적화에 참고

### 5-4. 항공기 기반 글로벌 하수 감시 네트워크 (2025)
**"Pandemic Monitoring with Global Aircraft-based Wastewater Surveillance Networks"**
- Nature Medicine, 2025
- https://www.nature.com/articles/s41591-025-03501-4

**핵심 내용:**
- 항공기 하수를 통한 글로벌 수준 병원체 감시
- **Sentinel Korea 적용:** 해외 유입 위험 신호의 추가 데이터 소스 가능성 (장기)

---

## 6. 호흡기 감시 전환기 도전과제

### 6-1. 호흡기 바이러스 감시 전환 (2024, CDC)
**"Key Challenges for Respiratory Virus Surveillance while Transitioning out of Acute Phase of COVID-19 Pandemic"**
- Emerging Infectious Diseases, CDC, 2024
- https://wwwnc.cdc.gov/eid/article/30/2/23-0768_article

**핵심 내용:**
- COVID-19 급성기 이후 호흡기 바이러스 감시체계 전환의 핵심 과제
- **Sentinel Korea 적용:** 코로나19 이후 통합 호흡기 감시로 전환하는 현 시점의 맥락적 근거

---

## 7. 향후 통합 가능한 추가 지표 (위 연구 기반)

현재 Sentinel Korea의 6개 감시 lane 외에, 연구에서 제시된 추가 통합 가능 지표:

| 지표 | 근거 논문 | 데이터 소스 | 적용 가능성 |
|------|-----------|------------|------------|
| 약국 OTC 감기약 판매량 | Syndromic Surveillance 리뷰 (4-1) | 건보공단 또는 약국 POS | 중 (데이터 접근성) |
| 학교 결석률 | Risk Monitoring Embedding (3-1) | 교육부 NEIS | 중 (API 존재 여부 확인 필요) |
| 응급실 호흡기 증상 방문 비율 | ESSENCE 모델 / Syndromic 리뷰 | 건보공단 실시간 데이터 | 높 (정형화된 데이터) |
| 인터넷 검색 트렌드 | Internet-based Surveillance (4-2) | 네이버 DataLab API | 높 (이미 일부 수집 중) |
| 기상 데이터 (온도, 습도) | Multi-source 리뷰 (3-3) | 기상청 API | 높 (공공 API 제공됨) |
| 항생제 처방률 | Antimicrobial surveillance | 건보공단 청구 데이터 | 중 (분석 필요) |
| 소셜미디어 증상 언급 | AI EWS 리뷰 (4-3) | Twitter/X, 네이버 카페/블로그 | 낮 (NLP 파이프라인 필요) |
| 119 호흡기 증상 신고 건수 | Syndromic Surveillance 리뷰 | 소방청 데이터 | 중 (데이터 접근성) |
| 건강보험 호흡기 진료 청구 | CDC RESP-NET 참고 | 건보공단 | 높 (이미 공개 통계 있음) |

### 우선순위 (구현 용이성 + 근거 강도)
1. **기상 데이터** — 공공 API 즉시 연동 가능, 계절성 보정에 활용
2. **응급실 호흡기 방문** — 건보공단 공개 통계 활용
3. **검색 트렌드 강화** — 기존 네이버 수집 확장 (질병별 키워드 세분화)
4. **학교 결석률** — 교육부 데이터 접근성 확인 후
5. **약국 OTC 판매** — 장기 과제

---

## 8. 연구 활용 방안

### 8-1. KDCA API 요청 근거 강화
- 위 논문들을 KDCA API 요청서에 첨부하여 다중 소스 통합 감시의 학술적 근거 제시
- 특히 2-1 (한국 감시체계 방향성 논문)이 현 체계의 gap을 직접 지적 — Sentinel Korea가 이 gap을 메우는 도구임을 강조

### 8-2. Forecasting (Phase 2) 모델 설계
- 3-2, 5-1 논문의 다중 소스 통합 모델링 전략 참고
- overfitting 방지를 위한 변수 선택 전략 (5-1)
- SARIMAX 외생변수로 하수 농도/ILI 비율 추가 시 정확도 향상 근거

### 8-3. 학술 발표 / 논문 작성
- Sentinel Korea의 6-lane composite risk scoring이 위 연구들의 프레임워크를 실용적으로 구현한 사례
- 한국 최초의 시/도별 다중 소스 통합 호흡기 감시 대시보드로서의 학술적 가치

---

*Last updated: 2026-05-09*
