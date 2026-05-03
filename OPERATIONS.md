# Sentinel Korea — 주간 운영 체크리스트

매주 화·수요일쯤 KDCA가 새 주차 보고서를 발표하면 이 절차로 돌립니다.
**모든 데이터 갱신은 로컬에서**, 결과 JSON만 `git push`로 프로덕션 반영합니다
(Railway 컨테이너는 ephemeral filesystem이라 redeploy마다 reset됨).

---

## 0. 최초 1회 셋업

### 백엔드
```powershell
cd "C:\Users\han75\Desktop\Sentinel pneumonia\backend"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# backend/.env 생성 — backend/.env.example을 복사하고 키 채우기
copy .env.example .env
notepad .env
```

필수 키:
- `GEMINI_API_KEY` (https://aistudio.google.com/app/apikey)
- `KDCA_EID_API_KEY` (https://www.data.go.kr "감염병 발생")

선택 키 (있으면 더 풍부):
- `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` — 한국 뉴스/트렌드
- `NEWS_API_KEY` — 글로벌 뉴스 보조

자세한 설명은 `backend/.env.example` 주석 참조.

### 프론트엔드
```powershell
cd "C:\Users\han75\Desktop\Sentinel pneumonia\frontend"
npm install
```

`frontend/.env`에 `VITE_API_URL=http://localhost:8001` 한 줄 (없으면 만들기).

---

## 1. 매주 운영 — 실행

### 1.1. 로컬 백엔드 + 프론트 구동

```powershell
# PowerShell 1 — 백엔드
cd "C:\Users\han75\Desktop\Sentinel pneumonia\backend"
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8001
```

```powershell
# PowerShell 2 — 프론트
cd "C:\Users\han75\Desktop\Sentinel pneumonia\frontend"
npm run dev
```

브라우저: <http://localhost:5173>

### 1.2. KDCA 사이트에서 파일 다운로드

<https://www.kdca.go.kr/npt/> 에서 받기. 파일명에 다음 키워드 중 하나가
포함되어야 parser가 자동 인식합니다:

| 키워드 | 인식되는 lane | 형식 |
|--------|---------------|------|
| `급성호흡기감염증` | ARI 전체 | xlsx / csv |
| `인플루엔자` (단독) | ILI | xlsx / csv |
| `중증급성호흡기감염증 ... 폐렴` | SARI – pneumonia | xlsx / csv |
| `중증급성호흡기감염증 ... 인플루엔자` | SARI – influenza | xlsx / csv |
| `하수기반감염병감시 주간분석보고` | 폐하수 보조 | PDF |
| `감염병 표본감시 주간소식지` | 표본감시 bulletin | PDF |
| `전 세계 감염병 발생 동향` | 해외 outbreak | PDF |

### 1.3. localhost:5173 → OPERATOR LOGIN → DATA SOURCES

1. dropzone에 파일 drag & drop (5~6개)
2. 각 파일별로 "Records parsed: N · Snapshots updated: M" 응답 확인
3. UPLOAD HISTORY에 누적 기록 확인

### 1.4. PIPELINE 탭

순서대로 클릭:
1. **Refresh KDCA notifiable** — 공공데이터 EIDAPI 갱신 (~30초)
2. **Refresh Korea** — 네이버 + Google News + 트렌드 (~1분)
3. **Refresh Global** — 8개 outbreak source (~2~3분, Gemini 호출 포함)
4. **Run analyze** — 오늘 날짜 snapshot 생성, AI risk score 계산 (~1분)

### 1.5. REPORT 탭

**Generate FINAL report** 클릭 → 주간 통합 리포트 markdown 생성 (~30초).

---

## 2. Git push (Railway 영속화)

```powershell
cd "C:\Users\han75\Desktop\Sentinel pneumonia"

git status
# backend/data/processed/ 안의 JSON 파일들이 modified로 떠야 정상
# 새 snapshots/{today}.json 생성됨 (untracked)

git add backend/data/processed/
git add backend/data/reports/        # 리포트 폴더가 있으면

git commit -m "Weekly data refresh: WNN"
git push origin master
```

→ Railway가 push 감지 → 자동 redeploy (~2분)

---

## 3. 검증

1. **Railway**: 대시보드 → 백엔드 service → Deployments → 최신 빌드 status `SUCCESS`
2. **Production**: <https://sentinel-korea.vercel.app> 새로고침 (Ctrl+Shift+R)
3. 우측 timeline에 새 주차 (예: `2026-W19 · May 4 – May 10 · 05-09`) 표시
4. MAP 색상이 새 데이터 반영
5. REPORT 탭에서 새 FINAL 리포트 노출

---

## 4. 트러블슈팅

| 증상 | 원인 | 조치 |
|------|------|------|
| `localhost:5173`에서 fetch 에러 | 백엔드 `localhost:8001` 미구동 | PowerShell 1 다시 |
| DATA SOURCES 업로드가 401 | OPERATOR LOGIN 안 됨 | Firebase 로그인 또는 `.env`에 `SENTINEL_ADMIN_TOKEN` 설정 |
| Refresh Global이 일부 source `error` | API key 누락 / rate limit | `backend/.env` 확인, Naver/Gemini 키 유효성 |
| `git push` 후 Railway 빌드 실패 | `requirements.txt` 변경 / nixpacks 이슈 | Railway Logs 확인, `railway.toml` start cmd 점검 |
| Production에서 새 주차 안 보임 | Railway 빌드는 성공했으나 cache | 5분 대기 후 hard refresh, Vercel CDN cache 만료 |

---

## 5. 자동화 (선택)

매번 두 PowerShell + venv activate가 번거로우면 `scripts/dev-up.ps1`
한 줄짜리 스크립트로 자동 실행 가능 (선택 항목, 필요할 때 만들기).

---

## 6. 향후 로드맵 (참고)

- **Phase 2** (8주 데이터 누적 후): Forecasting tab — 누적 snapshot으로 다음 4주 risk score 예측
- **Phase 3**: WelcomeNotice 승인 후 음성 브리핑 (Web Speech API + 옵션으로 Jarvis 연동)

자세한 내용은 `~/.claude/plans/harmonic-whistling-dahl.md` 참조.
