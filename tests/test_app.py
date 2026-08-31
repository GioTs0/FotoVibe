import hashlib
import io
import json
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from google.api_core.exceptions import ServiceUnavailable
from PIL import Image
from pillow_heif import register_heif_opener

from fotovibe.app import COOKIE, Settings, create_app
from fotovibe.storage import LocalStore

register_heif_opener()
ORIGIN = {"Origin": "https://testserver"}


def picture(fmt="JPEG", color="red", orientation=None):
    # HEIF's encoder normalizes the orientation tag; provide already-oriented pixels.
    image = Image.new("RGB", (80, 120) if fmt == "HEIF" and orientation == 6 else (120, 80), color)
    output = io.BytesIO()
    exif = Image.Exif()
    if orientation:
        exif[274] = orientation
        exif[270] = "Private original metadata"
    image.save(output, fmt, exif=exif)
    return output.getvalue()


@pytest.fixture
def env(tmp_path):
    store = LocalStore(tmp_path)
    app = create_app(Settings("TEST-CODE", "test-signing-key"), store)
    client = TestClient(app, base_url="https://testserver")
    return client, app, store


def login(client):
    response = client.post("/api/session", json={"code": "test code"}, headers=ORIGIN)
    assert response.status_code == 200
    return response


def upload(client, data=None, photo_id=None):
    return client.post(
        "/api/photos",
        headers=ORIGIN,
        data={"upload_id": photo_id or str(uuid.uuid4())},
        files={"photo": ("photo.jpg", data if data is not None else picture(), "image/jpeg")},
    )


def test_private_endpoints_and_cookie(env):
    client, _, store = env
    photo_id = str(uuid.uuid4())
    for path in [
        "/api/session",
        "/api/photos",
        f"/api/photos/{photo_id}/original",
        f"/api/photos/{photo_id}/thumb",
    ]:
        assert client.get(path).status_code == 401
    assert upload(client).status_code == 401
    assert not store.published()
    result = login(client)
    cookie = result.headers["set-cookie"]
    assert all(
        flag in cookie for flag in ["Secure", "HttpOnly", "SameSite=strict", "Max-Age=604800"]
    )
    assert client.get("/api/photos").json() == {"photos": [], "next_cursor": None}
    client.delete("/api/session", headers=ORIGIN)
    assert client.get("/api/photos").status_code == 401


def test_origin_and_invalid_login(env):
    client, _, _ = env
    assert client.post("/api/session", json={"code": "TESTCODE"}).status_code == 403
    assert (
        client.post(
            "/api/session", json={"code": "TESTCODE"}, headers={"Origin": "https://evil.example"}
        ).status_code
        == 403
    )
    assert client.post("/api/session", json={"code": "wrong"}, headers=ORIGIN).status_code == 401
    for bad in [{"code": []}, [], None]:
        assert client.post("/api/session", json=bad, headers=ORIGIN).status_code == 400


def test_expired_and_changed_code_sessions(env, monkeypatch):
    client, _, store = env
    login(client)
    with monkeypatch.context() as patch:
        patch.setattr(
            "itsdangerous.timed.TimestampSigner.get_timestamp",
            lambda self: int(time.time()) + 604801,
        )
        assert client.get("/api/photos").status_code == 401
    other = TestClient(
        create_app(Settings("NEWCODE", "test-signing-key"), store), base_url="https://testserver"
    )
    other.cookies.update(client.cookies)
    assert other.get("/api/photos").status_code == 401
    client.cookies.clear()
    client.cookies.set(COOKIE, "tampered")
    assert client.get("/api/photos").status_code == 401


@pytest.mark.parametrize("fmt", ["JPEG", "PNG", "WEBP", "HEIF"])
def test_originals_preserved_and_previews_metadata_free(env, fmt):
    client, _, store = env
    login(client)
    raw = picture(fmt, orientation=6)
    result = upload(client, raw)
    assert result.status_code == 201, result.text
    photo_id = result.json()["id"]
    original = client.get(f"/api/photos/{photo_id}/original")
    assert original.content == raw
    assert "attachment" in original.headers["content-disposition"]
    assert result.json()["sha256"] == hashlib.sha256(raw).hexdigest()
    for variant in ["thumb", "display"]:
        response = client.get(f"/api/photos/{photo_id}/{variant}")
        with Image.open(io.BytesIO(response.content)) as image:
            assert image.height > image.width
            assert not image.getexif()
            assert image.format == "JPEG"
    assert len(store.published()) == 1


def test_retry_is_idempotent_and_conflict_is_rejected(env):
    client, _, store = env
    login(client)
    photo_id = str(uuid.uuid4())
    assert upload(client, photo_id=photo_id).status_code == 201
    assert upload(client, photo_id=photo_id).status_code == 200
    assert upload(client, picture(color="blue"), photo_id).status_code == 409
    assert len(store.published()) == 1


def test_partial_upload_hidden_and_retry_recovers(env, monkeypatch):
    client, _, store = env
    login(client)
    original_put = store.put
    photo_id = str(uuid.uuid4())

    def fail_thumb(key, *args, **kwargs):
        if key.endswith("thumb.jpg"):
            raise ServiceUnavailable("simulated interruption")
        return original_put(key, *args, **kwargs)

    monkeypatch.setattr(store, "put", fail_thumb)
    assert upload(client, photo_id=photo_id).status_code == 503
    assert not client.get("/api/photos").json()["photos"]
    assert client.get(f"/api/photos/{photo_id}/original").status_code == 404
    monkeypatch.setattr(store, "put", original_put)
    assert upload(client, photo_id=photo_id).status_code == 201
    assert len(client.get("/api/photos").json()["photos"]) == 1


def test_invalid_empty_oversized_and_animated_files(env):
    client, _, store = env
    login(client)
    assert upload(client, b"<svg><script>evil</script></svg>").status_code == 415
    assert upload(client, b"").status_code == 400
    assert upload(client, b"a" * (25 * 1024 * 1024 + 1)).status_code == 413
    assert (
        client.post(
            "/api/photos", content=b"", headers={**ORIGIN, "Content-Length": str(27 * 1024 * 1024)}
        ).status_code
        == 413
    )
    output = io.BytesIO()
    Image.new("RGB", (8001, 8000)).save(output, "PNG")
    assert upload(client, output.getvalue()).status_code == 413
    assert upload(client, photo_id="../../bad").status_code == 400
    assert not store.published()


def test_streamed_size_limit_without_content_length(env):
    client, _, _ = env
    chunks = (b"x" * 1024 for _ in range(5))
    response = client.post(
        "/api/session", content=chunks, headers={**ORIGIN, "Content-Type": "application/json"}
    )
    assert response.status_code == 413


def test_pagination_is_stable_when_new_photo_arrives(env):
    client, _, store = env
    login(client)
    for _ in range(65):
        photo_id = str(uuid.uuid4())
        store.put(
            f"published/{photo_id}.json", json.dumps({"id": photo_id}).encode(), "application/json"
        )
    first = client.get("/api/photos").json()
    assert len(first["photos"]) == 30
    assert upload(client).status_code == 201
    ids = [x["id"] for x in first["photos"]]
    cursor = first["next_cursor"]
    while cursor:
        page = client.get("/api/photos", params={"cursor": cursor}).json()
        ids.extend(x["id"] for x in page["photos"])
        cursor = page["next_cursor"]
    assert len(ids) == len(set(ids)) == 65
    assert client.get("/api/photos?cursor=invalid").status_code == 400


def test_concurrent_duplicate_uploads_across_instances(env):
    client, _, store = env
    other = TestClient(
        create_app(Settings("TESTCODE", "test-signing-key"), store), base_url="https://testserver"
    )
    login(client)
    login(other)
    photo_id = str(uuid.uuid4())
    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(lambda c: upload(c, photo_id=photo_id), [client, other]))
    assert sorted(response.status_code for response in responses) == [200, 201]
    assert len(store.published()) == 1


def test_login_rate_limit(env):
    client, _, _ = env
    for _ in range(30):
        assert (
            client.post("/api/session", json={"code": "wrong"}, headers=ORIGIN).status_code == 401
        )
    response = client.post("/api/session", json={"code": "wrong"}, headers=ORIGIN)
    assert response.status_code == 429
    assert response.headers["retry-after"] == "60"


def test_upload_rate_limit(env):
    client, _, _ = env
    login(client)
    photo_id = str(uuid.uuid4())
    for _ in range(10):
        assert upload(client, photo_id=photo_id).status_code in {200, 201}
    assert upload(client).status_code == 429


def test_security_headers_and_missing_photos(env):
    client, _, _ = env
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["x-frame-options"] == "DENY"
    assert "script-src 'self'" in response.headers["content-security-policy"]
    assert response.headers["cache-control"] == "no-store"
    login(client)
    assert client.get(f"/api/photos/{uuid.uuid4()}/original").status_code == 404
