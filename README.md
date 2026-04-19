# Sentinel Korea 🛡️

**실시간 호흡기 감염병 조기경보 플랫폼**  
Real-time respiratory infection early warning platform powered by multi-source OSINT + AI.

## Architecture

```
SOURCES          AI DIGEST         DISPLAY          ANALYSIS
────────────     ──────────────     ──────────────   ──────────────
Korea News   ──► News Digest    ──► News Panel   ─┐
Global News                                        ├──► OSINT Analysis
Google/Naver ──► Trends Digest  ──► Trends Chart ─┘
KDCA Upload  ──► KDCA Digest    ──► KDCA Panel   ─┬──► Sentinel Report
                                                   └──► Sentinel Chat
```

## Stack

- **Frontend**: React + TypeScript + Vite, D3.js, Three.js (3D Globe)
- **Backend**: FastAPI (Python), Gemini AI API
- **Data Sources**: GNews API, Google Trends, Naver DataLab, KDCA PDF reports

## Local Development

### Backend (FastAPI)
```bash
cd backend
pip install -r requirements.txt
# Create .env with your API keys (see .env.example)
uvicorn app.main:app --reload --port 8001
```

### Frontend (React)
```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`

## Environment Variables

Create `backend/.env`:
```
GEMINI_API_KEY=your_key
GNEWS_API_KEY=your_key
KDCA_SERVICE_KEY=your_key
NAVER_CLIENT_ID=your_id
NAVER_CLIENT_SECRET=your_secret
```

For Vercel deployment, set `VITE_API_URL` to your backend URL.

## Features

- 🗺️ **Korea Risk Map** — 17 regions, multi-layer risk scoring
- 🌐 **3D Globe** — Global outbreak visualization
- 📰 **News Intelligence** — Korea + Global news with AI digest
- 📈 **Trends Analysis** — Google Trends + Naver DataLab
- 🏥 **KDCA Integration** — KDCA weekly report upload & AI analysis
- 🤖 **Sentinel Chat** — AI-powered Q&A on current situation
- 📊 **Flow Diagram** — Real-time pipeline status visualization
