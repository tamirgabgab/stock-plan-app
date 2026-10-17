@echo off
REM Double-click to install requirements (first run) and start the app.
cd /d "%~dp0"
set PY=python
where python >nul 2>nul || set PY=py
%PY% --version >nul 2>nul || (
  echo Python was not found. Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
  pause
  exit /b 1
)
%PY% -m pip install -q -r requirements-local.txt
%PY% run.py %*
pause
