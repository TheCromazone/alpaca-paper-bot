@echo off
REM Runs a single strategy tick (ignores market hours check) for testing.
setlocal
cd /d "%~dp0\.."
call .venv\Scripts\activate
py -m bot.main --once
endlocal
