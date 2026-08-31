"""Manage FotoVibe task documents using the active gcloud login."""

import argparse
import json
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROJECT = "project-8b626ca4-30b1-415b-84b"
DATABASE = "fotovibe"
BASE = (
    "https://firestore.googleapis.com/v1/projects/"
    f"{PROJECT}/databases/{DATABASE}/documents/tasks"
)


def access_token():
    result = subprocess.run(
        ["gcloud", "auth", "print-access-token", f"--project={PROJECT}", "--quiet"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def request(method, url, body=None, missing_ok=False):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {access_token()}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, data=data, headers=headers, method=method), timeout=30
        ) as response:
            return json.load(response) if response.length != 0 else None
    except urllib.error.HTTPError as error:
        if missing_ok and error.code == 404:
            return None
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"Firestore returned HTTP {error.code}: {detail}") from None


def document_url(task_id):
    return f"{BASE}/{urllib.parse.quote(task_id, safe='')}"


def fields(text, enabled):
    return {
        "fields": {
            "text": {"stringValue": text},
            "enabled": {"booleanValue": enabled},
        }
    }


def put(task_id, text, enabled=True):
    if not task_id or len(task_id) > 100 or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in task_id):
        raise ValueError("Task IDs may contain only lowercase letters, digits, and hyphens")
    text = text.strip()
    if not 1 <= len(text) <= 500:
        raise ValueError("Task text must contain 1 to 500 characters")
    query = urllib.parse.urlencode(
        [("updateMask.fieldPaths", "text"), ("updateMask.fieldPaths", "enabled")]
    )
    request("PATCH", f"{document_url(task_id)}?{query}", fields(text, enabled))


def seed():
    created = 0
    for task in json.loads((ROOT / "infra/tasks.json").read_text()):
        if request("GET", document_url(task["id"]), missing_ok=True) is None:
            put(task["id"], task["text"], task["enabled"])
            created += 1
    print(f"{created} task(s) created; existing task documents were kept")


def list_tasks():
    result = request("GET", f"{BASE}?pageSize=100") or {}
    rows = []
    for document in result.get("documents", []):
        task_id = document["name"].rsplit("/", 1)[-1]
        values = document.get("fields", {})
        rows.append(
            (
                task_id,
                values.get("enabled", {}).get("booleanValue", False),
                values.get("text", {}).get("stringValue", ""),
            )
        )
    for task_id, enabled, text in sorted(rows):
        print(f"{task_id}\t{'active' if enabled else 'disabled'}\t{text}")


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("seed", help="Create the ten example tasks when missing")
    commands.add_parser("list", help="List all task documents")
    set_parser = commands.add_parser("set", help="Create or update one active task")
    set_parser.add_argument("id")
    set_parser.add_argument("text")
    disable_parser = commands.add_parser("disable", help="Keep a task but stop serving it")
    disable_parser.add_argument("id")
    args = parser.parse_args()

    if args.command == "seed":
        seed()
    elif args.command == "list":
        list_tasks()
    elif args.command == "set":
        put(args.id, args.text)
    else:
        document = request("GET", document_url(args.id))
        text = document.get("fields", {}).get("text", {}).get("stringValue", "")
        put(args.id, text, enabled=False)


if __name__ == "__main__":
    main()
