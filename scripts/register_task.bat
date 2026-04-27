@echo off
REM Registers the AlpacaBot task: weekdays at 06:25 local — Mon-Fri pre-open
REM health check. With MultipleInstancesPolicy=IgnoreNew (the schtasks default),
REM this fire is a no-op when the bot is already alive, but restarts it if
REM the previous run died overnight.
REM
REM run_bot.bat brings up all three services: bot scheduler (foreground),
REM API on :8765, and dashboard on :3001 (both backgrounded). The bat's
REM kill-stale logic guarantees no duplicate processes.
REM
REM On a 24/7 PC this trigger plus the kill-stale step is sufficient. If you
REM ever need at-boot recovery, register an additional trigger from an
REM elevated shell using register_task.ps1.
REM
REM To remove: schtasks /Delete /TN "AlpacaBot" /F
setlocal enabledelayedexpansion
set TASK=AlpacaBot
REM /TR needs the path triple-quoted so schtasks stores the path with spaces.
set BOT=\"%~dp0run_bot.bat\"
schtasks /Create /TN %TASK% /TR "%BOT%" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 06:25 /F
echo.
echo Registered: %TASK% triggers on weekdays at 06:25 local time.
echo Stop with:  schtasks /Delete /TN %TASK% /F
endlocal
