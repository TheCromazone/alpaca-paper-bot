@echo off
REM Entry point used by Windows Task Scheduler.
REM On a 24/7 machine, the prior day's bot.main may still be alive. Kill any
REM existing instance first so we never double-submit orders from two
REM blocking schedulers running side-by-side.
setlocal
cd /d "%~dp0\.."

echo [run_bot] %DATE% %TIME% starting...
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*bot.main*' -and $_.Name -like 'python*' } | ForEach-Object { Write-Host ('killing stale bot pid=' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

call .venv\Scripts\activate
py -m bot.main %*
endlocal
