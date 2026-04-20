@echo off
REM Registers the bot with Windows Task Scheduler.
REM Triggers at 9:25am ET (13:25 UTC) on weekdays; the bot itself checks the NYSE calendar.
REM To remove:  schtasks /Delete /TN "AlpacaBot" /F
setlocal
set TASK=AlpacaBot
set BOT="%~dp0run_bot.bat"
REM 06:25 local time is 5 minutes before NYSE open for Pacific Time (09:30 ET).
REM If you're not in PT, adjust /ST to be ~5 min before your local equivalent.
schtasks /Create /TN %TASK% /TR %BOT% /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 06:25 /F
echo.
echo Registered: %TASK% triggers on weekdays at 06:25 local time.
echo Stop with:  schtasks /Delete /TN %TASK% /F
endlocal
