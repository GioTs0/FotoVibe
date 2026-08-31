"""Small task repositories for Firestore and local development."""

import json
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
                    if values.get("enabled", {}).get("booleanValue") is True:
                        items.append(
                            {
                                "id": document.get("name", "").rsplit("/", 1)[-1],
                                "text": values.get("text", {}).get("stringValue"),
                            }
                        )
                token = payload.get("nextPageToken")
                if not token:
                    break
        except (RequestException, ValueError) as error:
            raise ServiceUnavailable("Firestore task request failed") from error
        finally:
            session.close()
        return self._valid(items)

    @staticmethod
    def _valid(items):
        return [
            {"id": item["id"], "text": item["text"].strip()}
            for item in items
            if isinstance(item.get("id"), str)
            and isinstance(item.get("text"), str)
            and 1 <= len(item["text"].strip()) <= 500
        ]


class LocalTaskStore:
    """JSON-backed task list for local development and tests."""

    def __init__(self, path: str | Path):
        self.path = Path(path)

    def enabled(self):
        items = json.loads(self.path.read_text())
        return FirestoreTaskStore._valid(item for item in items if item.get("enabled") is True)
