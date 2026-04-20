@echo off
REM Registers the bot with Windows Task Scheduler.
REM The task fires weekdays at 06:25 local (PT) — 5 min before 09:30 ET open.
REM bot.main also checks the NYSE calendar on each tick, so holidays are no-ops.
REM run_bot.bat kills any stale bot.main before starting, so a 24/7 PC won't
REM accumulate processes across days.
REM To remove:  schtasks /Delete /TN "AlpacaBot" /F
setlocal enabledelayedexpansion
set TASK=AlpacaBot
REM /TR needs the path triple-quoted so schtasks stores "C:\Path With Spaces\run_bot.bat"
set BOT=\"%~dp0run_bot.bat\"
schtasks /Create /TN %TASK% /TR "%BOT%" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 06:25 /F
echo.
echo Registered: %TASK% triggers on weekdays at 06:25 local time.
echo Stop with:  schtasks /Delete /TN %TASK% /F
endlocal
