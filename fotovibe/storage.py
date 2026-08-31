"""Immutable objects; only the final published record makes a photo visible."""

import json
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from google.api_core.exceptions import NotFound, PreconditionFailed
from google.cloud import storage
from google.cloud.storage.retry import DEFAULT_RETRY


@dataclass
class ObjectInfo:
    name: str
    created: str
    size: int
    content_type: str
    metadata: dict


class CloudStore:
    def __init__(self, bucket: str):
        self.bucket = storage.Client().bucket(bucket)
        self.retry = DEFAULT_RETRY.with_deadline(45)

    def info(self, key):
        blob = self.bucket.get_blob(key, timeout=30, retry=self.retry)
        if blob is None:
            return None
        return self._info(blob)

    @staticmethod
    def _info(blob):
        return ObjectInfo(
            blob.name,
            blob.time_created.isoformat(),
            blob.size,
            blob.content_type,
            blob.metadata or {},
        )

    def put(self, key, data, content_type, metadata=None):
        blob = self.bucket.blob(key)
        blob.metadata = metadata or {}
        blob.cache_control = "private, max-age=300"
        try:
            blob.upload_from_string(
                data,
                content_type=content_type,
                if_generation_match=0,
                timeout=60,
                retry=self.retry,
            )
            return True
        except PreconditionFailed:
            return False

    def read(self, key):
        try:
            return self.bucket.blob(key).download_as_bytes(timeout=30, retry=self.retry)
        except NotFound:
            return None

    def stream(self, key):
        with self.bucket.blob(key).open("rb", chunk_size=256 * 1024) as source:
            while chunk := source.read(256 * 1024):
                yield chunk

    def published(self):
        return [
            self._info(blob)
            for blob in self.bucket.list_blobs(prefix="published/", timeout=30, retry=self.retry)
        ]


class LocalStore:
    """Development/test storage only. Production always uses GCS."""

    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()

    def info(self, key):
        with self.lock:
            path = self.root / (key + ".info")
            return ObjectInfo(**json.loads(path.read_text())) if path.exists() else None

    def put(self, key, data, content_type, metadata=None):
        with self.lock:
            path = self.root / key
            if path.exists():
                return False
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            info = ObjectInfo(
                key, datetime.now(UTC).isoformat(), len(data), content_type, metadata or {}
            )
            (self.root / (key + ".info")).write_text(json.dumps(vars(info)))
            return True

    def read(self, key):
        with self.lock:
            path = self.root / key
            return path.read_bytes() if path.exists() else None

    def stream(self, key):
        with (self.root / key).open("rb") as source:
            while chunk := source.read(256 * 1024):
                yield chunk

    def published(self):
        with self.lock:
            return [
                ObjectInfo(**json.loads(path.read_text()))
                for path in (self.root / "published").glob("*.json.info")
            ]
