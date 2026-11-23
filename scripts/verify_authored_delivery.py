#!/usr/bin/env python3
"""Read-only delivery checks after generation and physical gameplay verification."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import urllib.error
import urllib.request

import boto3

ROOT = Path(__file__).resolve().parent.parent
HOST = "https://d12ka835iwfpnx.cloudfront.net"
BUCKET = "ipverse-assets-087967639890-us-east-1"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def public_bytes(path):
    with urllib.request.urlopen(HOST + "/" + path, timeout=30) as response:
        return response.read()


def main():
    deployment = json.loads((ROOT / "evidence/authored-deployment.json").read_text())
    runtime = json.loads((ROOT / "evidence/authored-runtime-sync.json").read_text())
    generation = json.loads((ROOT / "evidence/authored-generation-live.json").read_text())
    gameplay = json.loads((ROOT / "evidence/authored-gameplay-live.json").read_text())
    assert gameplay["status"] == "PLAY_VERIFIED"
    assert boto3.client("sts").get_caller_identity()["Account"] == "087967639890"
    s3 = boto3.client("s3", region_name="us-east-1")
    config = boto3.client("lambda", region_name="us-east-1").get_function_configuration(
        FunctionName="ipverse-api")
    assert config["CodeSha256"] == deployment["codeSha256"]
    assert config["LastUpdateStatus"] == "Successful"
    for name, expected in deployment["modules"].items():
        assert digest((ROOT / name).read_bytes()) == expected
    objects = []
    for item in runtime["objects"]:
        local = (ROOT / "game3d" / item["key"].rsplit("/", 1)[-1]).read_bytes()
        actual = s3.get_object(Bucket=BUCKET, Key=item["key"])["Body"].read()
        assert actual == local
        objects.append({**item, "sha256": digest(local), "s3Verified": True})
    public_game_objects = [obj for obj in objects if obj["key"].startswith("games/")]
    with ThreadPoolExecutor(max_workers=6) as pool:
        delivered = list(pool.map(lambda obj: public_bytes(obj["key"]), public_game_objects))
    for obj, data in zip(public_game_objects, delivered):
        assert digest(data) == obj["sha256"], obj["key"]
        obj["cloudFrontVerified"] = True
    for obj in objects:
        if obj["key"].startswith("runtime3d/"):
            # Runtime templates are server-side copy sources. Keep existing CDN routing.
            obj["cloudFrontScope"] = "Template verified in S3; gameplay copies verified over HTTPS."
    html = public_bytes("")
    assert html == (ROOT / "web/dist/index.html").read_bytes()
    entry = re.search(rb'src="/(assets/index-[^"]+\.js)"', html).group(1).decode()
    assert public_bytes(entry) == (ROOT / "web/dist" / entry).read_bytes()
    gate = []
    for headers in ({}, {"X-Auth-Token": "invalid-delivery-check"}):
        try:
            urllib.request.urlopen(urllib.request.Request(HOST + "/api/sessions", headers=headers), timeout=30)
            raise AssertionError("Unauthorized request admitted")
        except urllib.error.HTTPError as error:
            body = json.load(error)
            assert error.code == 401 and body.get("error") == "unauthorized"
            gate.append({"status": error.code, "error": body["error"]})
    videos = []
    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg, "Full video decode requires ffmpeg"
    for case in generation["cases"]:
        path = ROOT / f"build/game-personalization/gameplay-video/{case['gameId']}.webm"
        result = subprocess.run([ffmpeg, "-v", "error", "-i", str(path), "-f", "null", "-"],
                                capture_output=True, text=True)
        assert result.returncode == 0 and not result.stderr.strip(), result.stderr[:500]
        videos.append({"path": str(path.relative_to(ROOT)), "sha256": digest(path.read_bytes()),
                       "bytes": path.stat().st_size, "fullDecodeVerified": True})
    runtime.update(status="S3_AND_GAME_CLOUDFRONT_VERIFIED", objects=objects)
    (ROOT / "evidence/authored-runtime-sync.json").write_text(json.dumps(runtime, indent=2))
    report = {"status": "DELIVERY_VERIFIED", "host": HOST, "codeSha256": config["CodeSha256"],
              "lambdaModulesMatch": True, "runtimeObjects": objects,
              "frontendEntry": entry, "frontendHtmlAndJsMatch": True,
              "anonymousAndInvalidAuthDenied": gate, "gameplayVideos": videos}
    (ROOT / "evidence/authored-delivery-live.json").write_text(json.dumps(report, indent=2))
    deployment["status"] = "DEPLOYED_AND_VERIFIED"
    deployment["finalDeliveryEvidence"] = "evidence/authored-delivery-live.json"
    (ROOT / "evidence/authored-deployment.json").write_text(json.dumps(deployment, indent=2))
    print("Lambda, frontend, both games' runtime bytes, auth denial, and full video decoding verified.")


if __name__ == "__main__":
    main()
