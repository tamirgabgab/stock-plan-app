#!/usr/bin/env sh
# Install requirements (first run) and start the app.
cd "$(dirname "$0")"
python3 -m pip install -q -r requirements.txt
python3 run.py "$@"
