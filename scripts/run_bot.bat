@echo off
REM Entry point used by Windows Task Scheduler.
REM Brings up all three services for 24/7 operation: bot scheduler (this
REM blocking process) plus the FastAPI service and the Next.js dashboard
REM (both backgrounded). Kill-stale runs first so a relaunch never leaves
REM duplicates side by side — a duplicate bot would double-submit orders;
REM duplicate API or dashboard would just consume RAM.

setlocal
cd /d "%~dp0\.."

echo [run_bot] %DATE% %TIME% starting...

REM --- Kill any stale instances of all three services ---
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process | Where-Object { ($_.Name -like 'python*' -and ($_.CommandLine -like '*bot.main*' -or $_.CommandLine -like '*uvicorn*api.main*')) -or ($_.Name -eq 'node.exe' -and ($_.CommandLine -like '*\\dashboard\\*' -or $_.CommandLine -like '*alpaca*' -and $_.CommandLine -like '*next*')) } | ForEach-Object { Write-Host ('killing stale ' + $_.Name + ' pid=' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

call .venv\Scripts\activate

REM --- Start the FastAPI service (port 8765) in a new background window ---
start "alpaca-api" /MIN cmd /c ".venv\Scripts\activate && py -m uvicorn api.main:app --host 127.0.0.1 --port 8765 >> api.log 2>&1"

REM --- Start the Next.js dashboard (port 3001) in a new background window ---
REM Port 3001 is canonical for the trading dashboard. The user's personal
REM portfolio site lives on port 3000.
start "alpaca-dashboard" /MIN cmd /c "cd dashboard && npm run dev >> ..\dashboard.log 2>&1"

echo [run_bot] API     -> http://127.0.0.1:8765
echo [run_bot] Dashboard -> http://localhost:3001

REM --- Now run the bot scheduler in the foreground (blocking) ---
py -m bot.main %*

endlocal
