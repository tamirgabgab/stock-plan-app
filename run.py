"""Start the Stock Plan App: ``python run.py`` (add ``--demo`` for synthetic offline data)."""
from __future__ import annotations

import argparse
import os
import socket
import threading
import webbrowser


def running_app_version(port: int):
    """Version of a Stock Plan App already listening on ``port``, or None."""
    import json
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/meta", timeout=1) as r:
            return json.load(r).get("version", "unknown (older)")
    except Exception:
        return None


def free_port(preferred: int) -> int:
    for port in [preferred] + list(range(preferred + 1, preferred + 50)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise RuntimeError("no free port found")


def main() -> None:
    parser = argparse.ArgumentParser(description="Stock Plan App")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--demo", action="store_true", help="use synthetic data (no internet needed)")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser tab")
    args = parser.parse_args()

    if args.demo:
        os.environ["STOCKPLAN_DEMO"] = "1"

    import uvicorn  # imported after the env var is set

    from stockplan import __version__

    port = free_port(args.port)
    if port != args.port:
        other = running_app_version(args.port)
        if other:
            print(f"NOTE: another Stock Plan App (version {other}) is still running on port {args.port}.")
            print("      Close its window so you don't look at the old version by mistake.")
    url = f"http://127.0.0.1:{port}"
    print(f"Stock Plan App {__version__} running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    uvicorn.run("stockplan.api:app", host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
