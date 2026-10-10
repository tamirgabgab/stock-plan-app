@echo off
REM Double-click to install requirements (first run) and start the app.
cd /d "%~dp0"
python -m pip install -q -r requirements.txt
python run.py
pause
