#!/usr/bin/env bash
# Runs every time the codespace is opened: move to the latest main, then (re)start the app.
# The app opens in a new browser tab on its own (port 8000, see devcontainer.json).
cd "$(dirname "$0")/.."
{ git fetch -q origin main && git merge -q --ff-only FETCH_HEAD; } \
  || echo "Could not update to the latest main (local changes?); starting the current version."
pip3 install --user -q -r requirements-local.txt   # no-op unless requirements changed

# Stop an app left running from an earlier visit, and wait until its port is free.
# The pattern is anchored so it matches only the app process itself.
pkill -f "^python3? run.py --no-browser" 2>/dev/null
for _ in $(seq 1 20); do
  pgrep -f "^python3? run.py --no-browser" >/dev/null || break
  sleep 0.5
done
pkill -9 -f "^python3? run.py --no-browser" 2>/dev/null

exec python3 run.py --no-browser --host 0.0.0.0 --port 8000
