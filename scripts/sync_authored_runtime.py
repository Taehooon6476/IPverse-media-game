#!/usr/bin/env python3
"""Synchronize runtime fixes to the template and only this run's two QA games."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import urllib.request
import uuid

import boto3

ROOT = Path(__file__).resolve().parent.parent
BUCKET = "ipverse-assets-087967639890-us-east-1"
HOST = "d12ka835iwfpnx.cloudfront.net"
FILES = ("runtime3d.js", "authored.js", "mission.js")


def main():
    assert boto3.client("sts").get_caller_identity()["Account"] == "087967639890"
    generated = json.loads((ROOT / "evidence/authored-generation-live.json").read_text())
    game_ids = [case["gameId"] for case in generated["cases"]]
    assert len(game_ids) == 2 and len(set(game_ids)) == 2
    assert all(re.fullmatch(r"gm_[a-f0-9]{10}", game_id) for game_id in game_ids)
    s3 = boto3.client("s3", region_name="us-east-1")
    report = {"scope": "Runtime template and the two newly generated QA games only.",
              "objects": [], "status": "UPLOADING"}
    keys = []
    for prefix in ["runtime3d/v1", *(f"games/{game_id}" for game_id in game_ids)]:
        for name in FILES:
            key = f"{prefix}/{name}"
            body = (ROOT / "game3d" / name).read_bytes()
            previous = s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
            backup = ROOT / "build/game-personalization/runtime-backup" / key
            backup.parent.mkdir(parents=True, exist_ok=True)
            backup.write_bytes(previous)
            s3.put_object(Bucket=BUCKET, Key=key, Body=body,
                          ContentType="application/javascript; charset=utf-8")
            assert s3.get_object(Bucket=BUCKET, Key=key)["Body"].read() == body
            keys.append("/" + key)
            report["objects"].append({"key": key, "sha256": hashlib.sha256(body).hexdigest(),
                                      "s3Verified": True})
    cf = boto3.client("cloudfront")
    deployment = json.loads((ROOT / "evidence/authored-deployment.json").read_text())
    inv = cf.create_invalidation(DistributionId=deployment["distributionId"], InvalidationBatch={
        "Paths": {"Quantity": len(keys), "Items": keys},
        "CallerReference": "authored-runtime-" + uuid.uuid4().hex,
    })["Invalidation"]
    report.update(status="S3_VERIFIED_CLOUDFRONT_PENDING", invalidationId=inv["Id"])
    (ROOT / "evidence/authored-runtime-sync.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2))
    print(f"{len(keys)} runtime objects verified; CloudFront invalidation started.", flush=True)


if __name__ == "__main__":
    main()
