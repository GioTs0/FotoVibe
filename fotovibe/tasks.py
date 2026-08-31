"""Small task repositories for Firestore and local development."""

import json
import threading
import uuid
from pathlib import Path
from urllib.parse import quote, urlencode

import google.auth
from google.api_core.exceptions import ServiceUnavailable
from google.auth.transport.requests import AuthorizedSession
from requests.exceptions import RequestException


class FirestoreTaskStore:
    """Read active party tasks from a named Firestore database."""

    def __init__(self, project: str, database: str):
        credentials, _ = google.auth.default(
            scopes=["https://www.googleapis.com/auth/datastore"]
        )
        self.credentials = credentials
        self.url = (
            "https://firestore.googleapis.com/v1/projects/"
            f"{quote(project, safe='')}/databases/{quote(database, safe='')}/documents/tasks"
        )

    def enabled(self):
        return [{"id": task["id"], "text": task["text"]} for task in self.all() if task["enabled"]]

    def all(self):
        session = AuthorizedSession(self.credentials)
        items = []
        token = None
        try:
            while True:
                parameters = [
                    ("pageSize", "100"),
                    ("mask.fieldPaths", "text"),
                    ("mask.fieldPaths", "enabled"),
                ]
                if token:
                    parameters.append(("pageToken", token))
                response = session.get(f"{self.url}?{urlencode(parameters)}", timeout=30)
                response.raise_for_status()
                payload = response.json()
                for document in payload.get("documents", []):
                    values = document.get("fields", {})
                    items.append(
                        {
                            "id": document.get("name", "").rsplit("/", 1)[-1],
                            "text": values.get("text", {}).get("stringValue"),
                            "enabled": values.get("enabled", {}).get("booleanValue") is True,
                        }
                    )
                token = payload.get("nextPageToken")
                if not token:
                    break
        except (RequestException, ValueError) as error:
            raise ServiceUnavailable("Firestore task request failed") from error
        finally:
            session.close()
        return self._valid_all(items)

    def create(self, text):
        task_id = "party-" + uuid.uuid4().hex
        return self.upsert(task_id, text, True)

    def upsert(self, task_id, text, enabled=True):
        task = self._normalize_one({"id": task_id, "text": text, "enabled": enabled})
        if task is None:
            raise ValueError("Die Aufgabe ist ungültig.")
        payload = {
            "fields": {
                "text": {"stringValue": task["text"]},
                "enabled": {"booleanValue": task["enabled"]},
            }
        }
        query = urlencode([("updateMask.fieldPaths", "text"), ("updateMask.fieldPaths", "enabled")])
        session = AuthorizedSession(self.credentials)
        try:
            response = session.patch(
                f"{self.url}/{quote(task_id, safe='')}?{query}", json=payload, timeout=30
            )
            response.raise_for_status()
        except RequestException as error:
            raise ServiceUnavailable("Firestore task write failed") from error
        finally:
            session.close()
        return task

    def delete(self, task_id):
        if not isinstance(task_id, str) or not task_id or len(task_id) > 100:
            raise ValueError("Die Aufgaben-ID ist ungültig.")
        session = AuthorizedSession(self.credentials)
        try:
            response = session.delete(f"{self.url}/{quote(task_id, safe='')}", timeout=30)
            if response.status_code == 404:
                return False
            response.raise_for_status()
        except RequestException as error:
            raise ServiceUnavailable("Firestore task delete failed") from error
        finally:
            session.close()
        return True

    @staticmethod
    def _valid(items):
        return [{"id": item["id"], "text": item["text"]} for item in FirestoreTaskStore._valid_all(items) if item["enabled"]]

    @staticmethod
    def _normalize_one(item):
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            return None
        task_id = item["id"].strip().lower()
        text = item.get("text")
        if (
            not task_id
            or len(task_id) > 100
            or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-" for character in task_id)
            or not isinstance(text, str)
        ):
            return None
        text = text.strip()
        if not 1 <= len(text) <= 500:
            return None
        return {"id": task_id, "text": text, "enabled": item.get("enabled") is True}

    @staticmethod
    def _valid_all(items):
        return [task for item in items if (task := FirestoreTaskStore._normalize_one(item)) is not None]


class LocalTaskStore:
    """JSON-backed task list for local development and tests."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.lock = threading.RLock()

    def enabled(self):
        return [{"id": task["id"], "text": task["text"]} for task in self.all() if task["enabled"]]

    def all(self):
        with self.lock:
            return FirestoreTaskStore._valid_all(json.loads(self.path.read_text()))

    def create(self, text):
        with self.lock:
            items = json.loads(self.path.read_text())
            task = {
                "id": "party-" + uuid.uuid4().hex,
                "text": text,
                "enabled": True,
            }
            task = FirestoreTaskStore._normalize_one(task)
            if task is None:
                raise ValueError("Die Aufgabe ist ungültig.")
            items.append(task)
            self.path.write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n")
            return task

    def upsert(self, task_id, text, enabled=True):
        with self.lock:
            task = FirestoreTaskStore._normalize_one(
                {"id": task_id, "text": text, "enabled": enabled}
            )
            if task is None:
                raise ValueError("Die Aufgabe ist ungültig.")
            items = json.loads(self.path.read_text())
            for index, existing in enumerate(items):
                if existing.get("id") == task["id"]:
                    items[index] = task
                    break
            else:
                items.append(task)
            self.path.write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n")
            return task

    def delete(self, task_id):
        with self.lock:
            items = json.loads(self.path.read_text())
            remaining = [item for item in items if item.get("id") != task_id]
            if len(remaining) == len(items):
                return False
            self.path.write_text(json.dumps(remaining, ensure_ascii=False, indent=2) + "\n")
            return True
