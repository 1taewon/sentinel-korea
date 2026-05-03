# Sentinel Korea — local dev launcher
# Opens two PowerShell windows (backend + frontend) and the browser.
# Usage from project root:  .\scripts\dev-up.ps1
#
# Requires:
#   - backend/.venv created and dependencies installed (`pip install -r backend/requirements.txt`)
#   - frontend/node_modules installed (`npm install` in frontend/)
#   - backend/.env populated (copy from backend/.env.example)

$ErrorActionPreference = "Stop"

# Resolve project root from this script's location
$projectRoot = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $projectRoot "backend"
$frontendDir = Join-Path $projectRoot "frontend"
$venvActivate = Join-Path $backendDir ".venv\Scripts\Activate.ps1"

if (-not (Test-Path $venvActivate)) {
    Write-Host "Backend venv not found at $venvActivate" -ForegroundColor Red
    Write-Host "Run first:  cd backend; python -m venv .venv; .\.venv\Scripts\Activate.ps1; pip install -r requirements.txt" -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path (Join-Path $frontendDir "node_modules"))) {
    Write-Host "Frontend node_modules not found at $frontendDir" -ForegroundColor Red
    Write-Host "Run first:  cd frontend; npm install" -ForegroundColor Yellow
    exit 1
}

Write-Host "Starting Sentinel Korea local dev..." -ForegroundColor Cyan

# Backend in its own PowerShell window
$backendCmd = "Set-Location '$backendDir'; & '$venvActivate'; uvicorn app.main:app --reload --port 8001"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $backendCmd

# Frontend in its own PowerShell window
$frontendCmd = "Set-Location '$frontendDir'; npm run dev"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendCmd

# Wait a few seconds for vite to spin up, then open the browser
Start-Sleep -Seconds 4
Start-Process "http://localhost:5173"

Write-Host ""
Write-Host "Backend:  http://localhost:8001  (health: /health)" -ForegroundColor Green
Write-Host "Frontend: http://localhost:5173" -ForegroundColor Green
Write-Host ""
Write-Host "When you're done with the weekly run, commit + push the data:" -ForegroundColor Cyan
Write-Host "  git add backend/data/processed/" -ForegroundColor Gray
Write-Host "  git commit -m 'Weekly data refresh: WNN'" -ForegroundColor Gray
Write-Host "  git push origin master" -ForegroundColor Gray
