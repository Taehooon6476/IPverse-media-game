#!/usr/bin/env python3
"""Publish only the allowlisted CC0 city kit through the existing public games route.

Scope: games/city-kit/v1/city-assets/**, actual catalog-listed
meshes/textures/licenses only. No private IP, game session, infra or auth changes.
Default verifies existing publication; --publish uploads the bounded kit first.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
from pathlib import Path
import sys
import urllib.parse
import urllib.request

import boto3

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import deploy_city_games as core

PREFIX = "games/city-kit/v1/"
REPORT = ROOT / "evidence/city-kit-publication.json"


def actual_kit():
    files, kit = core.collect_files()
    selected = {
        PREFIX + key.removeprefix("runtime3d/v1/"): item
        for key, item in files.items() if key.startswith("runtime3d/v1/city-assets/")
    }
    core.require(selected and all(key.startswith(PREFIX + "city-assets/") for key in selected),
                 "Publication escaped the cataloged CC0 city kit prefix")
    return selected, kit


def public_verify(pair):
    key, item = pair
    url = "https://" + core.HOST + "/" + urllib.parse.quote(key, safe="/")
    with urllib.request.urlopen(url, timeout=30) as response:
        core.require(response.status == 200 and response.geturl() == url,
                     "Public city asset did not return a direct HTTPS success")
        body = response.read(item["bytes"] + 1)
    core.require(len(body) == item["bytes"] and core.sha(body) == item["sha256"],
                 "Public city asset differs from the catalog-verified source")
    return {"key": key, "sha256": core.sha(body), "bytes": len(body),
            "httpsStatus": 200, "httpsByteVerified": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publish", action="store_true", help="Root-authorized bounded CC0 kit upload")
    args = parser.parse_args()
    caller = boto3.client("sts", region_name=core.REGION).get_caller_identity()
    core.require(caller["Account"] == core.ACCOUNT, "Unexpected AWS account")
    gate = core.audience_gate()
    files, kit = actual_kit()
    s3 = boto3.client("s3", region_name=core.REGION)
    report = {
        "status": "PUBLISHING" if args.publish else "VERIFYING", "observedAt": core.now(),
        "awsWrites": args.publish, "host": core.HOST, "bucket": core.BUCKET, "prefix": PREFIX,
        "scope": "Catalog-allowlisted CC0 environmental kit only; no private IP/model job/session/infra/auth changes",
        "proofScope": "Actual S3 and public HTTPS byte delivery; not gameplay or visual quality proof",
        "catalogUrlPath": "/" + PREFIX + "city-assets/commonassetcatalog.json",
        "license": "CC0-1.0", "assetCount": kit["assetCount"], "kitBytes": kit["uploadBytes"],
        "catalogSha256": kit["catalogSha256"], "anonymousAndInvalidAuthDenied": gate,
        "s3Objects": [], "publicObjects": [],
    }
    core.save(REPORT, report)
    try:
        # Dependencies and actual meshes precede the catalog entry point.
        ordered = sorted(files, key=lambda key: key.endswith("commonassetcatalog.json"))
        for key in ordered:
            item = files[key]
            body = item["file"].read_bytes()
            core.require(core.sha(body) == item["sha256"], "Actual source changed during kit publication")
            if args.publish:
                mime = "model/gltf-binary" if item["file"].suffix == ".glb" else core.content_type(item["file"])
                s3.put_object(Bucket=core.BUCKET, Key=key, Body=body, ContentType=mime)
            delivered = core.object_snapshot(s3, key)
            core.require(delivered is not None and delivered[0] == body, "Published city S3 object differs from source")
            report["s3Objects"].append({"key": key, "sha256": item["sha256"], "bytes": len(body),
                                        "s3ByteVerified": True})
            core.save(REPORT, report)
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            report["publicObjects"] = list(pool.map(public_verify, files.items()))
        report.update(status="PUBLIC_KIT_VERIFIED", completedAt=core.now(), privateIpUploads=0,
                      modelJobs=0, configurationChanges=False, publicRoute="/games/*")
        core.save(REPORT, report)
        print(json.dumps({"status": report["status"], "objects": len(files), "actualModels": kit["assetCount"],
                          "awsWrites": args.publish, "publicPrefix": "/" + PREFIX,
                          "report": REPORT.relative_to(ROOT).as_posix()}), flush=True)
    except Exception as error:
        report.update(status="FAILED_OR_PARTIAL_PUBLICATION", failedAt=core.now(),
                      failureType=type(error).__name__)
        core.save(REPORT, report)
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        detail = str(error) if type(error) is RuntimeError else "Review the saved publication report."
        print(f"City kit publication stopped ({type(error).__name__}): {detail}", file=sys.stderr)
        sys.exit(1)
