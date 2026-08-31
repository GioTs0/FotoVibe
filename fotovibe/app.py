import asyncio
import hashlib
import json
import logging
import os
import secrets
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass
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

ROOT = Path(__file__).resolve().parent.parent
SESSION_AGE = 7 * 24 * 60 * 60
COOKIE = "fotovibe_session"
log = logging.getLogger("fotovibe")


@dataclass
class Settings:
    party_code: str
    session_key: str
    secure_cookies: bool = True

    @classmethod
    def from_env(cls):
        secret_file = os.environ.get("AUTH_SECRET_FILE")
        if secret_file:
            values = json.loads(Path(secret_file).read_text())
            return cls(values["party_code"], values["session_key"])
        if os.environ.get("FOTOVIBE_DEV") == "1":
            return cls(os.environ.get("PARTY_CODE", "1234"), "development-only-key", False)
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
        limit = 4096 if path == "/api/session" else MAX_BYTES + 1024 * 1024
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


def create_app(settings=None, store=None):
    settings = settings or Settings.from_env()
    store = store or (
        LocalStore(".local/photos")
        if not settings.secure_cookies
        else CloudStore(os.environ["PHOTO_BUCKET"])
    )
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(SecurityMiddleware, secure=settings.secure_cookies)
    serializer = URLSafeTimedSerializer(settings.session_key, salt="fotovibe-session")
    cursors = URLSafeTimedSerializer(settings.session_key, salt="fotovibe-pages")
    code = normalized(settings.party_code)
    epoch = hashlib.sha256(code.encode()).hexdigest()
    limiter = RateLimiter()
    conversion_lock = threading.Lock()
    cache_lock = threading.Lock()
    cache = {"until": 0, "photos": []}
    app.state.serializer = serializer
    app.state.store = store

    def session(request):
        try:
            data = serializer.loads(request.cookies.get(COOKIE, ""), max_age=SESSION_AGE)
            if data["epoch"] != epoch or not isinstance(data["sid"], str):
                raise BadSignature("invalid session")
            return data["sid"]
        except (BadSignature, KeyError, TypeError):
            raise HTTPException(401, "Bitte den Party-Code eingeben.") from None

    def valid_id(value):
        try:
            if str(uuid.UUID(value)) != value:
                raise TypeError
        except (ValueError, AttributeError, TypeError):
            raise HTTPException(400, "Ungültige Foto-ID.") from None
        return value

    def manifest(photo_id):
        raw = store.read(f"published/{photo_id}.json")
        if raw is None:
            raise HTTPException(404, "Dieses Foto ist nicht verfügbar.")
        return json.loads(raw)

    @app.exception_handler(GoogleAPIError)
    async def storage_error(request, error):
        log.error("storage_request_failed type=%s", type(error).__name__)
        return JSONResponse(
            {"detail": "Der Fotospeicher ist gerade nicht erreichbar. Bitte erneut versuchen."}, 503
        )

    @app.get("/healthz")
    def health():
        return {"status": "ok"}

    @app.get("/")
    @app.get("/gallery")
    def page():
        if not settings.secure_cookies:
            html = (ROOT / "static/index.html").read_text()
            html = html.replace(
                "</body>", '<script src="/static/dev-reload.js"></script>\n</body>'
            )
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
        session(request)
        return {"authenticated": True}

    @app.post("/api/session")
    async def login(request: Request):
        key = "login:" + (request.client.host if request.client else "unknown")
        limiter.check(key, 30, consume=False)
        try:
            payload = await request.json()
            provided = payload.get("code", "")
            if not isinstance(provided, str):
                raise TypeError
        except (ValueError, AttributeError, TypeError):
            raise HTTPException(400, "Bitte einen Party-Code eingeben.") from None
        if not secrets.compare_digest(normalized(provided).encode(), code.encode()):
            limiter.check(key, 30)
            raise HTTPException(401, "Der Party-Code stimmt nicht. Bitte noch einmal prüfen.")
        token = serializer.dumps({"sid": str(uuid.uuid4()), "epoch": epoch})
        response = JSONResponse({"authenticated": True})
        response.set_cookie(
            COOKIE,
            token,
            max_age=SESSION_AGE,
            secure=settings.secure_cookies,
            httponly=True,
            samesite="strict",
            path="/",
        )
        return response

    @app.delete("/api/session")
    def logout():
        response = Response(status_code=204)
        response.delete_cookie(
            COOKIE, path="/", secure=settings.secure_cookies, httponly=True, samesite="strict"
        )
        return response

    def persist(raw, photo_id):
        digest = hashlib.sha256(raw).hexdigest()
        with conversion_lock:
            original_key = f"photos/{photo_id}/original"
            existing = store.info(original_key)
            if existing and existing.metadata.get("sha256") != digest:
                raise HTTPException(409, "Diese Upload-ID gehört bereits zu einem anderen Foto.")
            published = store.read(f"published/{photo_id}.json")
            if published:
                return json.loads(published), False
            images = derivatives(raw)
            created = store.put(original_key, raw, images["content_type"], {"sha256": digest})
            if not created and store.info(original_key).metadata.get("sha256") != digest:
                raise HTTPException(409, "Diese Upload-ID gehört bereits zu einem anderen Foto.")
            store.put(f"photos/{photo_id}/display.jpg", images["display"], "image/jpeg")
            store.put(f"photos/{photo_id}/thumb.jpg", images["thumb"], "image/jpeg")
            record = {
                "id": photo_id,
                "size": len(raw),
                "sha256": digest,
                "content_type": images["content_type"],
                "extension": images["extension"],
                "width": images["width"],
                "height": images["height"],
            }
            published_now = store.put(
                f"published/{photo_id}.json", json.dumps(record).encode(), "application/json"
            )
            with cache_lock:
                cache["until"] = 0
            return record, published_now

    @app.post("/api/photos")
    async def upload(request: Request):
        sid = session(request)
        limiter.check("upload:" + sid, 10)
        async with request.form(max_files=1, max_fields=1, max_part_size=1024) as form:
            photo = form.get("photo")
            photo_id = valid_id(form.get("upload_id"))
            if not isinstance(photo, UploadFile) or len(form.multi_items()) != 2:
                raise HTTPException(400, "Bitte genau ein Foto auswählen.")
            raw = await photo.read(MAX_BYTES + 1)
            if not raw:
                raise HTTPException(400, "Die Datei ist leer.")
            if len(raw) > MAX_BYTES:
                raise HTTPException(413, "Das Foto ist zu groß (maximal 25 MiB).")
            record, created = await run_in_threadpool(persist, raw, photo_id)
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
                entries = [
                    {"id": Path(obj.name).stem, "created_at": obj.created}
                    for obj in store.published()
                ]
                entries.sort(key=lambda item: (item["created_at"], item["id"]), reverse=True)
                cache.update(photos=entries, until=time.monotonic() + 5)
            entries = cache["photos"]
        if after:
            entries = [x for x in entries if (x["created_at"], x["id"]) < tuple(after)]
        page = entries[:30]
        next_cursor = (
            cursors.dumps([page[-1]["created_at"], page[-1]["id"]]) if len(entries) > 30 else None
        )
        return {"photos": page, "next_cursor": next_cursor}

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
