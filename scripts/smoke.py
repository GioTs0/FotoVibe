"""Live smoke test using only synthetic fixtures; deletes only its own UUIDs."""

import hashlib
import io
import json
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from PIL import Image
from pillow_heif import register_heif_opener

ROOT = Path(__file__).resolve().parent.parent


def main():
    register_heif_opener()
    config = json.loads((ROOT / ".local/deployment.json").read_text())
    project, bucket, url = config["project"], config["bucket"], config["url"]
    secret = subprocess.check_output(
        [
            "gcloud",
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
    ids = [str(uuid.uuid4()) for _ in range(4)]
    (ROOT / ".local/smoke-ids.json").write_text(json.dumps(ids))
    payloads = []
    for index in range(4):
        image = Image.new("RGB", (300, 400), (index * 60, 80, 120))
        output = io.BytesIO()
        image.save(output, "HEIF" if index == 3 else "JPEG")
        payloads.append(output.getvalue())

    with httpx.Client(base_url=url, timeout=300, headers=headers) as client:
        assert client.get("/healthz").status_code == 200
        assert client.get("/").status_code == 200
        assert client.get("/api/photos").status_code == 401
        assert client.post("/api/session", json={"code": party_code}).status_code == 200
        print("HTTPS and session checks passed", flush=True)

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
            print("4 concurrent uploads including HEIC and duplicate retry passed", flush=True)
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
            result = subprocess.run(
                ["gcloud", "storage", "rm", *objects, f"--project={project}", "--quiet"],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode:
                raise RuntimeError(
                    "Some synthetic objects could not be removed. See .local/smoke-ids.json. "
                    + result.stderr
                )
            print("Synthetic cloud test photos removed (7-day soft delete applies)", flush=True)


if __name__ == "__main__":
    main()
