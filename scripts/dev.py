"""Local development supervisor with backend restart and browser hot reload."""

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WATCH_SUFFIXES = {".py", ".html", ".css", ".js", ".svg"}
WATCH_ROOTS = (ROOT / "fotovibe", ROOT / "static")


def _process_exists(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def listeners_on_port(port):
    """Return PIDs that currently listen on the requested TCP port."""
    try:
        result = subprocess.run(
            ["lsof", "-tiTCP:" + str(port), "-sTCP:LISTEN"],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return []

    pids = []
    for line in result.stdout.splitlines():
        try:
            pid = int(line.strip())
        except ValueError:
            continue
        if pid != os.getpid() and pid not in pids:
            pids.append(pid)
    return pids


def release_port(port):
    """Gracefully stop listeners on a port before starting the dev server."""
    pids = listeners_on_port(port)
    if not pids:
        return 0

    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    deadline = time.monotonic() + 5
    remaining = set(pids)
    while remaining and time.monotonic() < deadline:
        remaining = {pid for pid in remaining if _process_exists(pid)}
        if remaining:
            time.sleep(0.1)

    for pid in remaining:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return len(pids)


def snapshot():
    files = [ROOT / "pyproject.toml"]
    for root in WATCH_ROOTS:
        files.extend(path for path in root.rglob("*") if path.suffix in WATCH_SUFFIXES)
    return {str(path): path.stat().st_mtime_ns for path in files if path.exists()}


def start_server(host, port):
    environment = os.environ.copy()
    environment["FOTOVIBE_DEV"] = "1"
    environment["FOTOVIBE_HOT_RELOAD"] = "1"
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "fotovibe.app:create_app",
            "--factory",
            "--host",
            host,
            "--port",
            str(port),
            "--no-access-log",
        ],
        cwd=ROOT,
        env=environment,
    )


def stop_server(process):
    if process.poll() is not None:
        return
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def main():
    parser = argparse.ArgumentParser(description="Start FotoVibe with local hot reload")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8080, type=int)
    args = parser.parse_args()

    vendor = ROOT / "static/vendor/heic-to.js"
    if not vendor.exists():
        print("Preparing the local HEIC preview asset …", flush=True)
        subprocess.run(
            ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
            cwd=ROOT,
            check=True,
        )
        subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True)

    released = release_port(args.port)
    if released:
        print(f"Released port {args.port} (stopped {released} existing listener(s)).", flush=True)

    process = start_server(args.host, args.port)
    state = snapshot()
    print(
        f"FotoVibe development server: http://{args.host}:{args.port} "
        "(code 1234, hot reload active)",
        flush=True,
    )
    try:
        while True:
            time.sleep(0.4)
            current = snapshot()
            if current == state:
                if process.poll() is not None:
                    raise RuntimeError(f"Development server exited with code {process.returncode}")
                continue
            state = current
            print("Change detected, restarting FotoVibe …", flush=True)
            stop_server(process)
            process = start_server(args.host, args.port)
    except KeyboardInterrupt:
        print("\nStopping FotoVibe …", flush=True)
    finally:
        stop_server(process)


if __name__ == "__main__":
    main()
