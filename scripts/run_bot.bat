@echo off
setlocal
cd /d "%~dp0\.."
call .venv\Scripts\activate
py -m bot.main %*
endlocal
