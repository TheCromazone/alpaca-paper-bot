@echo off
REM Registers the bot with Windows Task Scheduler.
REM Triggers at 9:25am ET (13:25 UTC) on weekdays; the bot itself checks the NYSE calendar.
REM To remove:  schtasks /Delete /TN "AlpacaBot" /F
setlocal
set TASK=AlpacaBot
set BOT="%~dp0run_bot.bat"
schtasks /Create /TN %TASK% /TR %BOT% /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 09:25 /F
echo.
echo Registered: %TASK% triggers on weekdays at 09:25 local time.
echo Stop with:  schtasks /Delete /TN %TASK% /F
endlocal
