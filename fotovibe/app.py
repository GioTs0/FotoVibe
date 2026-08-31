import asyncio
import base64
import hashlib
import json
import logging
import math
import os
import random
import re
import secrets
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from google.api_core.exceptions import GoogleAPIError
from itsdangerous import BadSignature, URLSafeTimedSerializer
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException

from .images import MAX_BYTES, derivatives
from .storage import CloudStore, LocalStore
from .tasks import FirestoreTaskStore, LocalTaskStore

ROOT = Path(__file__).resolve().parent.parent
SESSION_AGE = 7 * 24 * 60 * 60
COOKIE = "fotovibe_session"
TASK_ID_PATTERN = re.compile(r"[a-z0-9-]{1,100}")
NAME_MAX_LENGTH = 40
log = logging.getLogger("fotovibe")


def normalize_task(task_id=None, task_text=None):
    """Return the small, safe task shape exposed to party guests."""
    task_id = task_id.strip().lower() if isinstance(task_id, str) else None
    task_text = task_text.strip() if isinstance(task_text, str) else None
    task_id = task_id if task_id and TASK_ID_PATTERN.fullmatch(task_id) else None
    task_text = task_text if task_text and len(task_text) <= 500 else None
    if not task_id and not task_text:
        return None
    return {"id": task_id, "text": task_text}


def task_from_values(value=None, task_id=None, task_text=None):
    """Accept task objects, JSON metadata, and flat GCS metadata values."""
    if isinstance(value, dict):
        task_id = value.get("id", value.get("task_id", value.get("taskId", task_id)))
        task_text = value.get("text", value.get("task_text", value.get("taskText", task_text)))
    elif isinstance(value, str):
        try:
            decoded = json.loads(value)
        except (TypeError, ValueError):
            decoded = None
        if isinstance(decoded, dict):
            return task_from_values(decoded, task_id, task_text)
        task_text = value
    return normalize_task(task_id, task_text)


def task_from_record(record, metadata=None):
    """Read task information from a manifest or a GCS object's metadata."""
    record = record if isinstance(record, dict) else {}
    metadata = metadata if isinstance(metadata, dict) else {}

    task = task_from_values(record.get("task"))
    if task:
        return task

    task = task_from_values(
        metadata.get("task") or metadata.get("photo_task") or metadata.get("photoTask")
    )
    if task:
        return task

    def value(source, *names):
        for name in names:
            if name in source:
                return source[name]
            normalized_name = name.replace("-", "_").lower()
            for key, candidate in source.items():
                if str(key).replace("-", "_").lower() == normalized_name:
                    return candidate
        return None

    return task_from_values(
        task_id=value(record, "task_id", "taskId") or value(metadata, "task_id", "taskId"),
        task_text=value(record, "task_text", "taskText")
        or value(metadata, "task_text", "taskText"),
    )


def author_from_record(record, metadata=None):
    """Return only the public author snapshot stored with a photo."""
    record = record if isinstance(record, dict) else {}
    metadata = metadata if isinstance(metadata, dict) else {}
    author = record.get("author") or metadata.get("author")
    if not isinstance(author, dict):
        return None
    user_id, name = author.get("id"), author.get("name")
    if (
        not isinstance(user_id, str)
        or not user_id.startswith("u_")
        or not isinstance(name, str)
    ):
        return None
    name = " ".join(name.split())
    if not 2 <= len(name) <= NAME_MAX_LENGTH:
        return None
    return {"id": user_id, "name": name}


@dataclass
class Settings:
    party_code: str
    session_key: str
    secure_cookies: bool = True
    test_codes: tuple[str, ...] = ()

    @classmethod
    def from_env(cls):
        secret_file = os.environ.get("AUTH_SECRET_FILE")
        if secret_file:
            values = json.loads(Path(secret_file).read_text())
            test_codes = values.get("test_codes", [])
            if not isinstance(test_codes, list) or not all(
                isinstance(code, str) for code in test_codes
            ):
                raise RuntimeError("test_codes in AUTH_SECRET_FILE must be a list of strings")
            return cls(values["party_code"], values["session_key"], True, tuple(test_codes))
        if os.environ.get("FOTOVIBE_DEV") == "1":
            return cls(
                os.environ.get("PARTY_CODE", "1234"),
                "development-only-key",
                False,
                ("1234",),
            )
        raise RuntimeError("AUTH_SECRET_FILE is required outside explicit local development")


def normalized(code):
    return code.upper().replace("-", "").replace(" ", "").strip()


class RateLimiter:
    """Best-effort per-instance limits; not a global quota or billing cap."""

    def __init__(self):
        self.values = OrderedDict()
        self.lock = threading.Lock()

    def check(self, key, limit, consume=True):
        with self.lock:
            now = time.monotonic()
            started, count = self.values.get(key, (now, 0))
            if now - started >= 60:
                started, count = now, 0
            if count >= limit:
                raise HTTPException(
                    429,
                    "Bitte eine Minute warten und erneut versuchen.",
                    headers={"Retry-After": "60"},
                )
            self.values[key] = (started, count + int(consume))
            self.values.move_to_end(key)
            while len(self.values) > 10000:
                self.values.popitem(last=False)


class SecurityMiddleware:
    def __init__(self, app, secure):
        self.app, self.secure = app, secure

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        path = scope["path"]
        mutation = scope["method"] in {"POST", "PUT", "PATCH", "DELETE"}
        if mutation:
            origin = urlsplit(headers.get(b"origin", b"").decode())
            expected_scheme = "https" if self.secure else "http"
            if (
                origin.scheme != expected_scheme
                or origin.netloc != headers.get(b"host", b"").decode()
            ):
                return await JSONResponse({"detail": "Diese Anfrage ist nicht erlaubt."}, 403)(
                    scope, receive, send
                )
        limit = (
            4096
            if path in {"/api/session", "/api/session/restore", "/api/users/me"}
            else MAX_BYTES + 1024 * 1024
        )
        try:
            length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            length = limit + 1
        if length < 0 or length > limit:
            return await JSONResponse({"detail": "Die Datei ist zu groß (maximal 25 MiB)."}, 413)(
                scope, receive, send
            )
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise StarletteHTTPException(413, "Die Datei ist zu groß (maximal 25 MiB).")
            return message

        async def secure_send(message):
            if message["type"] == "http.response.start":
                extra = [
                    (b"x-content-type-options", b"nosniff"),
                    (b"x-frame-options", b"DENY"),
                    (b"referrer-policy", b"no-referrer"),
                    (b"permissions-policy", b"camera=(self), microphone=(), geolocation=()"),
                    (b"x-robots-tag", b"noindex, nofollow, noarchive"),
                    (
                        b"content-security-policy",
                        b"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
                    ),
                ]
                if self.secure:
                    extra.append((b"strict-transport-security", b"max-age=31536000"))
                if not any(k.lower() == b"cache-control" for k, _ in message.get("headers", [])):
                    extra.append((b"cache-control", b"no-store"))
                message["headers"] = list(message.get("headers", [])) + extra
            await send(message)

        await self.app(scope, limited_receive, secure_send)


def create_app(settings=None, store=None, task_store=None):
    settings = settings or Settings.from_env()
    store = store or (
        LocalStore(".local/photos")
        if not settings.secure_cookies
        else CloudStore(os.environ["PHOTO_BUCKET"])
    )
    database = os.environ.get("FIRESTORE_DATABASE")
    task_store = task_store or (
        FirestoreTaskStore(os.environ["GOOGLE_CLOUD_PROJECT"], database)
        if database
        else LocalTaskStore(ROOT / "infra/tasks.json")
    )
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(SecurityMiddleware, secure=settings.secure_cookies)
    serializer = URLSafeTimedSerializer(settings.session_key, salt="fotovibe-session")
    cursors = URLSafeTimedSerializer(settings.session_key, salt="fotovibe-pages")
    code = normalized(settings.party_code)
    accepted_codes = tuple(
        dict.fromkeys([code, *(normalized(value) for value in settings.test_codes)])
    )
    epoch = hashlib.sha256(code.encode()).hexdigest()
    limiter = RateLimiter()
    conversion_lock = threading.Lock()
    cache_lock = threading.Lock()
    cache = {"until": 0, "photos": []}
    app.state.serializer = serializer
    app.state.store = store
    app.state.task_store = task_store

    def session_data(request):
        try:
            data = serializer.loads(request.cookies.get(COOKIE, ""), max_age=SESSION_AGE)
            if (
                data["epoch"] != epoch
                or not isinstance(data["sid"], str)
                or not isinstance(data["device"], str)
            ):
                raise BadSignature("invalid session")
            return data
        except (BadSignature, KeyError, TypeError):
            raise HTTPException(401, "Bitte den Party-Code eingeben.") from None

    def session(request):
        return session_data(request)["sid"]

    def valid_device_id(value):
        try:
            return str(uuid.UUID(value))
        except (ValueError, AttributeError, TypeError):
            raise HTTPException(400, "Die Gerätekennung ist ungültig. Bitte die Seite neu laden.") from None

    def device_key(device_id):
        """Create a party-scoped, non-reversible key for a browser device."""
        return hashlib.sha256(f"{epoch}:{device_id}".encode()).hexdigest()

    def user_key(device):
        return f"users/{device}.json"

    def user_upload_prefix(device):
        return f"users/{device}/uploads/"

    def user_upload_key(device, photo_id):
        return f"{user_upload_prefix(device)}{photo_id}.json"

    def user_reconciled_key(device):
        return f"users/{device}/reconciled-authors-v1.json"

    def normalized_name(value):
        if not isinstance(value, str):
            raise HTTPException(400, "Bitte gib deinen Namen ein.")
        name = " ".join(value.split())
        if not 2 <= len(name) <= NAME_MAX_LENGTH or any(ord(char) < 32 for char in name):
            raise HTTPException(400, "Bitte wähle einen Namen mit 2 bis 40 Zeichen.")
        return name

    def user_for_device(device):
        raw = store.read(user_key(device))
        if raw is None:
            return None
        try:
            record = json.loads(raw)
        except (TypeError, ValueError):
            log.warning("invalid_user_record device=%s", device[:12])
            return None
        if not isinstance(record, dict):
            return None
        user_id, name = record.get("id"), record.get("name")
        if not isinstance(user_id, str) or not user_id.startswith("u_"):
            return None
        try:
            name = normalized_name(name)
        except HTTPException:
            return None
        return {"id": user_id, "name": name}

    def set_session_cookie(response, device):
        token = serializer.dumps({"sid": str(uuid.uuid4()), "device": device, "epoch": epoch})
        response.set_cookie(
            COOKIE,
            token,
            max_age=SESSION_AGE,
            secure=settings.secure_cookies,
            httponly=True,
            samesite="strict",
            path="/",
        )

    def valid_id(value):
        try:
            if str(uuid.UUID(value)) != value:
                raise TypeError
        except (ValueError, AttributeError, TypeError):
            raise HTTPException(400, "Ungültige Foto-ID.") from None
        return value

    def resolve_task(task_id):
        if task_id is None:
            return None
        if not isinstance(task_id, str) or not re.fullmatch(r"[a-z0-9-]{1,100}", task_id):
            raise HTTPException(400, "Die Foto-Aufgabe ist ungültig. Bitte neu auswählen.")
        for task in task_store.enabled():
            if task["id"] == task_id:
                # Save the current wording so historical photos do not change when
                # a Firestore task is edited later.
                return {"id": task["id"], "text": task["text"]}
        raise HTTPException(400, "Diese Foto-Aufgabe ist nicht mehr verfügbar. Bitte neu ziehen.")

    def metadata_index(metadata):
        raw = json.dumps(metadata, ensure_ascii=False, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).decode()

    def indexed_metadata(obj):
        encoded = obj.metadata.get("fotovibe_metadata")
        if not encoded:
            return None
        try:
            value = json.loads(base64.urlsafe_b64decode(encoded).decode())
        except (ValueError, TypeError, UnicodeDecodeError):
            log.warning("invalid_photo_metadata_index object=%s", obj.name)
            return None
        return value if isinstance(value, dict) else None

    def manifest(photo_id):
        raw = store.read(f"published/{photo_id}.json")
        if raw is None:
            raise HTTPException(404, "Dieses Foto ist nicht verfügbar.")
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            raise HTTPException(404, "Dieses Foto ist nicht verfügbar.") from None
        return value if isinstance(value, dict) else {}

    def gallery_entries():
        """Build the gallery index, including task metadata from the bucket."""
        entries = []
        for obj in store.published():
            photo_id = Path(obj.name).stem
            indexed = indexed_metadata(obj)
            task = task_from_record(indexed or {})
            author = author_from_record(indexed or {})
            # Older objects have no compact index. Read their manifest only as a
            # compatibility fallback; newly uploaded photos need no extra request.
            if indexed is None:
                try:
                    record = manifest(photo_id)
                except HTTPException:
                    log.warning("invalid_published_manifest object=%s", obj.name)
                    continue
                task = task_from_record(record)
                author = author_from_record(record)
                if task is None:
                    task = task_from_record(record.get("metadata", {}))
                if author is None:
                    author = author_from_record(record.get("metadata", {}))
            if task is None and indexed is None:
                original = store.info(f"photos/{photo_id}/original")
                if original:
                    original_index = indexed_metadata(original)
                    task = task_from_record(original_index or {}, original.metadata)
            metadata = indexed or ({"task": task} if task else {})
            entry = {"id": photo_id, "created_at": obj.created, "metadata": metadata}
            if task:
                entry["task"] = task
            if author:
                entry["author"] = author
            entries.append(entry)
        entries.sort(key=lambda item: (item["created_at"], item["id"]), reverse=True)
        return entries

    def marker_payload(photo_id):
        return json.dumps(
            {
                "schema_version": 1,
                "photo_id": photo_id,
                "recorded_at": datetime.now(UTC).isoformat(),
            },
            separators=(",", ":"),
        ).encode()

    def record_user_upload(device, photo_id):
        """Record one immutable event per photo so retries never increase the value twice."""
        store.put(
            user_upload_key(device, photo_id),
            marker_payload(photo_id),
            "application/json",
        )

    def reconcile_user_uploads(device, user):
        """Backfill upload events once for profiles created before user values existed."""
        if store.info(user_reconciled_key(device)) is None:
            for obj in store.published():
                photo_id = Path(obj.name).stem
                indexed = indexed_metadata(obj)
                author = author_from_record(indexed or {})
                if indexed is None:
                    try:
                        record = manifest(photo_id)
                    except HTTPException:
                        continue
                    author = author_from_record(record)
                    if author is None:
                        author = author_from_record(record.get("metadata", {}))
                if author and author["id"] == user["id"]:
                    record_user_upload(device, photo_id)
            store.put(
                user_reconciled_key(device),
                json.dumps(
                    {"schema_version": 1, "completed_at": datetime.now(UTC).isoformat()},
                    separators=(",", ":"),
                ).encode(),
                "application/json",
            )

    def user_profile(device):
        user = user_for_device(device)
        if user is None:
            return None
        reconcile_user_uploads(device, user)
        photos_uploaded = len(store.list_prefix(user_upload_prefix(device)))
        return {
            **user,
            "device_id": "d_" + device[:12],
            "values": {"photos_uploaded": photos_uploaded},
        }

    @app.exception_handler(GoogleAPIError)
    async def storage_error(request, error):
        log.error("cloud_backend_failed type=%s", type(error).__name__)
        return JSONResponse(
            {"detail": "Der Dienst ist gerade nicht erreichbar. Bitte erneut versuchen."}, 503
        )

    @app.get("/healthz")
    def health():
        return {"status": "ok"}

    @app.get("/")
    @app.get("/gallery")
    @app.get("/play")
    def page():
        if not settings.secure_cookies:
            html = (ROOT / "static/index.html").read_text()
            html = html.replace("</body>", '<script src="/static/dev-reload.js"></script>\n</body>')
            return HTMLResponse(html)
        return FileResponse(ROOT / "static/index.html")

    if not settings.secure_cookies:

        @app.get("/__dev/reload")
        async def development_reload_events():
            async def events():
                yield "data: connected\n\n"
                while True:
                    await asyncio.sleep(2)
                    yield ": keepalive\n\n"

            return StreamingResponse(events(), media_type="text/event-stream")

    @app.get("/api/session")
    def current_session(request: Request):
        data = session_data(request)
        return {"authenticated": True, "user": user_profile(data["device"])}

    @app.get("/api/tasks/random")
    def random_task(request: Request, exclude: str | None = None):
        sid = session(request)
        limiter.check("task:" + sid, 30)
        if exclude is not None and not re.fullmatch(r"[a-z0-9-]{1,100}", exclude):
            raise HTTPException(400, "Die Aufgabenliste bitte neu laden.")
        tasks = task_store.enabled()
        choices = [task for task in tasks if task["id"] != exclude]
        if not choices:
            choices = tasks
        if not choices:
            raise HTTPException(503, "Gerade ist keine Foto-Aufgabe verfügbar.")
        return secrets.choice(choices)

    @app.post("/api/session")
    async def login(request: Request):
        key = "login:" + (request.client.host if request.client else "unknown")
        limiter.check(key, 30, consume=False)
        try:
            payload = await request.json()
            provided = payload.get("code", "")
            if not isinstance(provided, str):
                raise TypeError
            device_id = payload.get("device_id")
            if device_id is not None:
                device_id = valid_device_id(device_id)
        except (ValueError, AttributeError, TypeError):
            raise HTTPException(400, "Bitte einen Party-Code eingeben.") from None
        provided_code = normalized(provided).encode()
        valid_code = sum(
            secrets.compare_digest(provided_code, accepted.encode()) for accepted in accepted_codes
        )
        if not valid_code:
            limiter.check(key, 30)
            raise HTTPException(401, "Der Party-Code stimmt nicht. Bitte noch einmal prüfen.")
        device = device_key(device_id or str(uuid.uuid4()))
        response = JSONResponse({"authenticated": True, "user": user_profile(device)})
        set_session_cookie(response, device)
        return response

    @app.post("/api/session/restore")
    async def restore_session(request: Request):
        try:
            payload = await request.json()
            device = device_key(valid_device_id(payload.get("device_id")))
        except (ValueError, AttributeError, TypeError):
            raise HTTPException(400, "Die Gerätekennung ist ungültig. Bitte die Seite neu laden.") from None
        user = user_profile(device)
        if user is None:
            raise HTTPException(401, "Dieses Gerät ist noch nicht für die Party angemeldet.")
        response = JSONResponse({"authenticated": True, "user": user})
        set_session_cookie(response, device)
        return response

    @app.post("/api/users/me")
    async def create_current_user(request: Request):
        data = session_data(request)
        try:
            payload = await request.json()
            name = normalized_name(payload.get("name"))
        except (ValueError, AttributeError, TypeError):
            raise HTTPException(400, "Bitte gib deinen Namen ein.") from None
        existing = user_for_device(data["device"])
        if existing:
            if existing["name"] != name:
                raise HTTPException(409, "Für dieses Gerät ist bereits ein Name festgelegt.")
            return {"user": user_profile(data["device"])}
        user = {"id": "u_" + data["device"][:16], "name": name}
        created = store.put(
            user_key(data["device"]),
            json.dumps({"schema_version": 1, **user}, ensure_ascii=False).encode(),
            "application/json",
        )
        if not created:
            existing = user_for_device(data["device"])
            if existing:
                return {"user": user_profile(data["device"])}
            raise HTTPException(503, "Dein Name konnte gerade nicht gespeichert werden.")
        store.put(
            user_reconciled_key(data["device"]),
            json.dumps(
                {"schema_version": 1, "completed_at": datetime.now(UTC).isoformat()},
                separators=(",", ":"),
            ).encode(),
            "application/json",
        )
        return {"user": user_profile(data["device"])}

    @app.delete("/api/session")
    def logout():
        response = Response(status_code=204)
        response.delete_cookie(
            COOKIE, path="/", secure=settings.secure_cookies, httponly=True, samesite="strict"
        )
        return response

    def persist(raw, photo_id, photo_metadata):
        digest = hashlib.sha256(raw).hexdigest()
        metadata_digest = hashlib.sha256(
            json.dumps(photo_metadata, sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()
        with conversion_lock:
            original_key = f"photos/{photo_id}/original"
            existing = store.info(original_key)
            if existing and existing.metadata.get("sha256") != digest:
                raise HTTPException(409, "Diese Upload-ID gehört bereits zu einem anderen Foto.")
            if existing and existing.metadata.get("metadata_sha256") not in {
                None,
                metadata_digest,
            }:
                raise HTTPException(
                    409, "Diese Upload-ID gehört bereits zu anderen Foto-Metadaten."
                )
            published = store.read(f"published/{photo_id}.json")
            if published:
                record = json.loads(published)
                if record.get("metadata", {}) != photo_metadata:
                    raise HTTPException(
                        409, "Diese Upload-ID gehört bereits zu anderen Foto-Metadaten."
                    )
                return record, False
            images = derivatives(raw)
            original_metadata = {"sha256": digest, "metadata_sha256": metadata_digest}
            if photo_metadata:
                original_metadata["fotovibe_metadata"] = metadata_index(photo_metadata)
                task = photo_metadata.get("task")
                if isinstance(task, dict):
                    original_metadata.update(
                        {
                            "task_id": task.get("id") or "",
                            "task_text": task.get("text") or "",
                        }
                    )
            created = store.put(
                original_key,
                raw,
                images["content_type"],
                original_metadata,
            )
            if not created:
                existing = store.info(original_key)
                if existing.metadata.get("sha256") != digest:
                    raise HTTPException(
                        409, "Diese Upload-ID gehört bereits zu einem anderen Foto."
                    )
                if existing.metadata.get("metadata_sha256") not in {None, metadata_digest}:
                    raise HTTPException(
                        409, "Diese Upload-ID gehört bereits zu anderen Foto-Metadaten."
                    )
            store.put(f"photos/{photo_id}/display.jpg", images["display"], "image/jpeg")
            store.put(f"photos/{photo_id}/thumb.jpg", images["thumb"], "image/jpeg")
            record = {
                "schema_version": 1,
                "id": photo_id,
                "size": len(raw),
                "sha256": digest,
                "content_type": images["content_type"],
                "extension": images["extension"],
                "width": images["width"],
                "height": images["height"],
                "metadata": photo_metadata,
            }
            published_now = store.put(
                f"published/{photo_id}.json",
                json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode(),
                "application/json",
                {
                    "schema_version": "1",
                    "fotovibe_metadata": metadata_index(photo_metadata),
                },
            )
            if not published_now:
                record = json.loads(store.read(f"published/{photo_id}.json"))
                if record.get("metadata", {}) != photo_metadata:
                    raise HTTPException(
                        409, "Diese Upload-ID gehört bereits zu anderen Foto-Metadaten."
                    )
            with cache_lock:
                cache["until"] = 0
            return record, published_now

    @app.post("/api/photos")
    async def upload(request: Request):
        data = session_data(request)
        sid = data["sid"]
        limiter.check("upload:" + sid, 10)
        async with request.form(max_files=1, max_fields=2, max_part_size=1024) as form:
            photo = form.get("photo")
            photo_id = valid_id(form.get("upload_id"))
            task_id = form.get("task_id")
            expected_fields = {"photo", "upload_id"} | (
                {"task_id"} if task_id is not None else set()
            )
            if (
                not isinstance(photo, UploadFile)
                or len(form.multi_items()) != len(expected_fields)
                or set(form.keys()) != expected_fields
            ):
                raise HTTPException(400, "Bitte genau ein Foto auswählen.")
            task = await run_in_threadpool(resolve_task, task_id)
            raw = await photo.read(MAX_BYTES + 1)
            if not raw:
                raise HTTPException(400, "Die Datei ist leer.")
            if len(raw) > MAX_BYTES:
                raise HTTPException(413, "Das Foto ist zu groß (maximal 25 MiB).")
            photo_metadata = {"task": task} if task else {}
            author = user_for_device(data["device"])
            if author:
                photo_metadata["author"] = author
            record, created = await run_in_threadpool(persist, raw, photo_id, photo_metadata)
            if author:
                await run_in_threadpool(record_user_upload, data["device"], photo_id)
        return JSONResponse(record, status_code=201 if created else 200)

    @app.get("/api/photos")
    def photos(request: Request, cursor: str | None = None):
        session(request)
        after = None
        if cursor:
            try:
                after = cursors.loads(cursor, max_age=SESSION_AGE)
                if (
                    not isinstance(after, list)
                    or len(after) != 2
                    or not all(isinstance(x, str) for x in after)
                ):
                    raise BadSignature("invalid cursor")
            except BadSignature:
                raise HTTPException(400, "Die Galerie bitte neu laden.") from None
        with cache_lock:
            if cache["until"] <= time.monotonic():
                cache.update(photos=gallery_entries(), until=time.monotonic() + 5)
            entries = cache["photos"]
        if after:
            entries = [x for x in entries if (x["created_at"], x["id"]) < tuple(after)]
        page = entries[:30]
        next_cursor = (
            cursors.dumps([page[-1]["created_at"], page[-1]["id"]]) if len(entries) > 30 else None
        )
        return {"photos": page, "next_cursor": next_cursor}

    @app.get("/api/photos/play")
    def play_photos(request: Request, count: int = 4, exclude: str | None = None):
        """Return a weighted, duplicate-free spread for the party photo book."""
        session(request)
        if count < 1 or count > 6:
            raise HTTPException(400, "Die Fotobuch-Größe muss zwischen 1 und 6 liegen.")
        excluded = set()
        if exclude:
            values = [value for value in exclude.split(",") if value]
            if len(values) > 24:
                raise HTTPException(400, "Zu viele ausgeschlossene Fotos.")
            for value in values:
                excluded.add(valid_id(value))
        with cache_lock:
            if cache["until"] <= time.monotonic():
                cache.update(photos=gallery_entries(), until=time.monotonic() + 5)
            candidates = [photo for photo in cache["photos"] if photo["id"] not in excluded]
        if not candidates:
            return {"photos": []}

        now = datetime.now(UTC)
        selected = []
        chooser = random.SystemRandom()
        while candidates and len(selected) < count:
            weights = []
            for photo in candidates:
                try:
                    created = datetime.fromisoformat(photo["created_at"])
                    age_hours = max(0.0, (now - created).total_seconds() / 3600)
                except (TypeError, ValueError):
                    age_hours = 24.0
                # New uploads are more likely, while every photo retains a chance.
                weights.append(1.0 + 4.0 * math.exp(-age_hours / 6.0))
            picked = chooser.choices(candidates, weights=weights, k=1)[0]
            selected.append(picked)
            candidates.remove(picked)
        return {"photos": selected}

    @app.get("/api/photos/{photo_id}/{variant}")
    def photo(request: Request, photo_id: str, variant: str):
        session(request)
        valid_id(photo_id)
        if variant not in {"thumb", "display", "original"}:
            raise HTTPException(404, "Diese Bildversion gibt es nicht.")
        record = manifest(photo_id)
        key = f"photos/{photo_id}/" + ("original" if variant == "original" else variant + ".jpg")
        headers = {"Cache-Control": "private, max-age=300", "Vary": "Cookie"}
        media_type = "image/jpeg"
        if variant == "original":
            media_type = record["content_type"]
            headers["Content-Disposition"] = (
                f'attachment; filename="FotoVibe-{photo_id}.{record["extension"]}"'
            )
        return StreamingResponse(store.stream(key), media_type=media_type, headers=headers)

    app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
    return app
