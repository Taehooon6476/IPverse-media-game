#!/usr/bin/env python3
"""Publish only the three requested demos' gallery through the existing web origin."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import mimetypes
from pathlib import Path
import time
import urllib.error
import urllib.request
import uuid

import boto3

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "artifacts/three-game-showcase/site"
PREFIX = "web/showcases/three-game-types-20261101/"
HOST = "https://d12ka835iwfpnx.cloudfront.net"
BUCKET = "ipverse-assets-087967639890-us-east-1"


def sha(blob):
    return hashlib.sha256(blob).hexdigest()


def main():
    assert boto3.client("sts").get_caller_identity()["Account"] == "087967639890"
    generated = json.loads((ROOT / "evidence/three-game-showcase-generation.json").read_text())
    played = json.loads((ROOT / "evidence/three-game-showcase-play.json").read_text())
    assert len(generated["cases"]) == 3
    assert len(played["cases"]) == 3 and all(c["status"] == "PASS" for c in played["cases"])
    assert {c["gameId"] for c in generated["cases"]} == {c["gameId"] for c in played["cases"]}
    assert (SITE / "index.html").is_file()
    html = (SITE / "index.html").read_text()
    assert all(c["previewUrl"] in html for c in generated["cases"])
    assert not any(term in html.lower() for term in ("password", "access_token", "x-auth-token"))
    gate = []
    for headers in ({}, {"X-Auth-Token": "invalid-showcase-publication-check"}):
        try:
            urllib.request.urlopen(urllib.request.Request(HOST + "/api/sessions", headers=headers), timeout=30)
            raise AssertionError("Unauthorized session access was admitted")
        except urllib.error.HTTPError as error:
            body = json.load(error)
            assert error.code == 401 and body.get("error") == "unauthorized"
            gate.append({"status": error.code, "error": body["error"]})
    s3 = boto3.client("s3", region_name="us-east-1")
    manifest = json.loads((SITE.parent / "build-manifest.json").read_text())
    assert manifest["status"] == "READY" and manifest["publicPrefix"] == PREFIX
    files = [SITE / entry["path"] for entry in manifest["files"]]
    for file in files:
        assert file.resolve().is_relative_to(SITE.resolve()) and file.is_file()
    assert len(files) >= 4
    objects = []
    for file in files:
        assert file.suffix in (".html", ".css", ".js", ".png", ".jpg", ".webp", ".mp4", ".webm")
        relative = file.relative_to(SITE).as_posix()
        body = file.read_bytes()
        key = PREFIX + relative
        content_type = mimetypes.guess_type(str(file))[0] or "application/octet-stream"
        s3.put_object(Bucket=BUCKET, Key=key, Body=body, ContentType=content_type,
                      CacheControl="public, max-age=60" if file.suffix == ".html" else "public, max-age=3600")
        assert s3.get_object(Bucket=BUCKET, Key=key)["Body"].read() == body
        objects.append({"key": key, "url": HOST + "/" + key.removeprefix("web/"),
                        "sha256": sha(body), "bytes": len(body), "s3Verified": True})
    cf = boto3.client("cloudfront")
    previous = json.loads((ROOT / "evidence/authored-deployment.json").read_text())
    inv = cf.create_invalidation(DistributionId=previous["distributionId"], InvalidationBatch={
        "Paths": {"Quantity": 1, "Items": ["/showcases/three-game-types-20261101/*"]},
        "CallerReference": "three-games-" + uuid.uuid4().hex,
    })["Invalidation"]

    def verify(obj):
        for attempt in range(10):
            try:
                with urllib.request.urlopen(obj["url"], timeout=40) as response:
                    actual = response.read()
                if sha(actual) == obj["sha256"]:
                    return {**obj, "httpsVerified": True}
            except urllib.error.HTTPError as error:
                if error.code not in (403, 404, 502, 503):
                    raise
            time.sleep(2)
        raise AssertionError("Gallery delivery did not match: " + obj["key"])

    with ThreadPoolExecutor(max_workers=4) as pool:
        objects = list(pool.map(verify, objects))
    report = {"status": "PUBLISHED_BYTES_VERIFIED", "scope": "Three new game demos' public gallery only; existing web app and infrastructure unchanged.",
              "url": HOST + "/showcases/three-game-types-20261101/index.html",
              "anonymousAndInvalidAuthDenied": gate, "objects": objects,
              "invalidationId": inv["Id"], "gameIds": [c["gameId"] for c in generated["cases"]]}
    (ROOT / "evidence/three-game-showcase-delivery.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print("Three-game gallery published; all delivered bytes verified.", flush=True)


if __name__ == "__main__":
    main()
