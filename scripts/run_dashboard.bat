@echo off
REM Manual launch of FastAPI + Next.js dev server in separate visible windows.
REM Use this when you want to run the API and dashboard without the bot —
REM e.g. for dashboard development. The Task-Scheduler entry point
REM ``run_bot.bat`` already starts both alongside the scheduler.
setlocal
cd /d "%~dp0\.."
start "alpaca-api" cmd /k ".venv\Scripts\activate && py -m uvicorn api.main:app --host 127.0.0.1 --port 8765"
start "alpaca-dashboard" cmd /k "cd dashboard && npm run dev"
echo Dashboard:     http://localhost:3001
echo API (JSON):    http://127.0.0.1:8765
endlocal
