@echo off
REM Starts FastAPI + Next.js dev server in separate windows.
setlocal
cd /d "%~dp0\.."
start "alpaca-api" cmd /k ".venv\Scripts\activate && py -m uvicorn api.main:app --host 127.0.0.1 --port 8765"
start "alpaca-dashboard" cmd /k "cd dashboard && npm run dev"
echo Dashboard:     http://localhost:3000
echo API (JSON):    http://127.0.0.1:8765
endlocal
