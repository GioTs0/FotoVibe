"""Live smoke test using only synthetic fixtures; deletes only its own UUIDs."""

import hashlib
import io
import json
import shutil
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from PIL import Image
from pillow_heif import register_heif_opener

ROOT = Path(__file__).resolve().parent.parent
# Windows ships gcloud as a .cmd; CreateProcess only resolves .exe without a full path.
GCLOUD = shutil.which("gcloud") or "gcloud"


def main():
    register_heif_opener()
    config = json.loads((ROOT / ".local/deployment.json").read_text())
    project, bucket, url = config["project"], config["bucket"], config["url"]
    secret = subprocess.check_output(
        [
            GCLOUD,
            "secrets",
            "versions",
            "access",
            config["secret_version"],
            "--secret=fotovibe-auth",
            f"--project={project}",
        ],
        text=True,
    )
    party_code = json.loads(secret)["party_code"]
    headers = {"Origin": url}
    device_id = str(uuid.uuid4())
    epoch = hashlib.sha256(party_code.upper().replace("-", "").replace(" ", "").encode()).hexdigest()
    device_key = hashlib.sha256(f"{epoch}:{device_id}".encode()).hexdigest()
    ids = [str(uuid.uuid4()) for _ in range(4)]
    (ROOT / ".local/smoke-ids.json").write_text(
        json.dumps({"photo_ids": ids, "device_key": device_key}, indent=2)
    )
    payloads = []
    for index in range(4):
        image = Image.new("RGB", (300, 400), (index * 60, 80, 120))
        output = io.BytesIO()
        image.save(output, "HEIF" if index == 3 else "JPEG")
        payloads.append(output.getvalue())

    with httpx.Client(base_url=url, timeout=300, headers=headers) as client:
        assert client.get("/").status_code == 200
        assert client.get("/api/photos").status_code == 401
        login = client.post(
            "/api/session", json={"code": party_code, "device_id": device_id}
        )
        assert login.status_code == 200
        assert login.json()["user"] is None
        created = client.post("/api/users/me", json={"name": "FotoVibe Smoke Test"})
        assert created.status_code == 200, created.text
        user = created.json()["user"]
        assert user["id"] == "u_" + device_key[:16]
        assert user["device_id"] == "d_" + device_key[:12]
        assert user["values"] == {"photos_uploaded": 0}
        print("HTTPS, session and device profile checks passed", flush=True)

        def upload(index):
            return client.post(
                "/api/photos",
                data={"upload_id": ids[index]},
                files={"photo": ("synthetic", payloads[index])},
            )

        try:
            with ThreadPoolExecutor(4) as pool:
                responses = list(pool.map(upload, range(4)))
            for response in responses:
                assert response.status_code == 201, response.text
            assert upload(0).status_code == 200
            profile = client.get("/api/session").json()["user"]
            assert profile["values"] == {"photos_uploaded": 4}
            print(
                "4 concurrent uploads, duplicate retry and per-device count passed",
                flush=True,
            )
            for index, photo_id in enumerate(ids):
                original = client.get(f"/api/photos/{photo_id}/original")
                assert original.status_code == 200
                assert (
                    hashlib.sha256(original.content).digest()
                    == hashlib.sha256(payloads[index]).digest()
                )
                for variant in ["thumb", "display"]:
                    response = client.get(f"/api/photos/{photo_id}/{variant}")
                    assert response.status_code == 200
                    with Image.open(io.BytesIO(response.content)) as image:
                        assert image.size == (300, 400)
                        assert not image.getexif()
                anonymous = httpx.get(f"{url}/api/photos/{photo_id}/original", timeout=30)
                assert anonymous.status_code == 401
                direct = httpx.get(
                    f"https://storage.googleapis.com/{bucket}/photos/{photo_id}/original",
                    timeout=30,
                )
                assert direct.status_code == 403
            print(
                "Byte-identical originals, previews, anonymous denial and private bucket passed",
                flush=True,
            )
            page = client.get("/api/photos").json()
            listed = {photo["id"] for photo in page["photos"]}
            while page["next_cursor"]:
                page = client.get("/api/photos", params={"cursor": page["next_cursor"]}).json()
                listed.update(photo["id"] for photo in page["photos"])
            assert set(ids) <= listed
            assert client.delete("/api/session").status_code == 204
            assert client.get("/api/photos").status_code == 401
            print("Gallery and logout passed", flush=True)
        finally:
            objects = [f"gs://{bucket}/published/{photo_id}.json" for photo_id in ids]
            objects += [
                f"gs://{bucket}/photos/{photo_id}/{variant}"
                for photo_id in ids
                for variant in ["original", "display.jpg", "thumb.jpg"]
            ]
            objects += [
                f"gs://{bucket}/users/{device_key}.json",
                f"gs://{bucket}/users/{device_key}/reconciled-authors-v1.json",
                *[
                    f"gs://{bucket}/users/{device_key}/uploads/{photo_id}.json"
                    for photo_id in ids
                ],
            ]
            result = subprocess.run(
                [
                    GCLOUD,
                    "storage",
                    "rm",
                    *objects,
                    f"--project={project}",
                    "--quiet",
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode:
                raise RuntimeError(
                    "Some synthetic objects could not be removed. See .local/smoke-ids.json. "
                    + result.stderr
                )
            print(
                "Synthetic cloud test photos and device profile removed "
                "(7-day soft delete applies)",
                flush=True,
            )


if __name__ == "__main__":
    main()
