#!/usr/bin/env python3
"""
Upload web/dist to S3 web/, write web/config.json, upload game runtime files (game/ and game3d/),
invalidate CloudFront distribution.
Run: python3 scripts/upload_web.py
"""
import json
import mimetypes
import pathlib
import sys

import boto3

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUTPUTS_FILE = ROOT / "build" / "outputs.json"
WEB_DIST = ROOT / "web" / "dist"
GAME_DIR = ROOT / "game"
GAME3D_DIR = ROOT / "game3d"

CONTENT_TYPES = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".map": "application/json",
    ".txt": "text/plain",
}

RUNTIME_FILES = ("index.html", "runtime.js", "shooter.js", "rpg.js", "gamespec.js")
# three.js runtime files (dev/ and test/ stay local). Keep in step with server/tools.py RUNTIME3D_FILES +
# CITY_RUNTIME_FILES: make_game copies these from runtime3d/v1/.
RUNTIME3D_FILES = ("index.html", "runtime3d.js", "world.js", "anim.js", "ualclips.js", "sf.js", "rpg.js", "gamespec3d.js",
                   "authored-contract.js", "city-contract.js", "background-data.js", "background.js",
                   "mission.js", "authored.js", "biome.js", "sky.js", "arpg.js", "arpg-data.js", "ui.css", "city.js", "city-controller.js", "city-layout.js", "race.js", "track.js", "carrig.js")
UAL_KEY = "runtime3d/v1/anims/ual.glb"  # must match server/providers/rig.py UAL_KEY


def content_type(path: pathlib.Path) -> str:
    return CONTENT_TYPES.get(path.suffix, mimetypes.guess_type(str(path))[0] or "application/octet-stream")


def upload_web() -> None:
    if not OUTPUTS_FILE.exists():
        print(f"ERROR: {OUTPUTS_FILE} not found. Run deploy first.", file=sys.stderr)
        sys.exit(1)

    outputs = json.loads(OUTPUTS_FILE.read_text())
    # cdk deploy --outputs-file writes {"IpverseCore": {"CdnDomainOutput": "...", ...}}.
    core = outputs.get("IpverseCore", {})
    cdn_domain = core.get("CdnDomain") or core.get("CdnDomainOutput")
    user_pool_id = core.get("UserPoolId") or core.get("UserPoolIdOutput")
    client_id = core.get("ClientId") or core.get("ClientIdOutput")
    bucket = core.get("AssetsBucket") or core.get("AssetsBucketOutput")

    if not all([cdn_domain, user_pool_id, client_id, bucket]):
        print(f"ERROR: Missing required outputs: {core}", file=sys.stderr)
        sys.exit(1)

    region = "us-east-1"
    cf_client = boto3.client("cloudfront", region_name=region)
    s3 = boto3.client("s3", region_name=region)

    # The invalidation needs the distribution id; the outputs only carry its domain.
    dist_id = None
    paginator = cf_client.get_paginator("list_distributions")
    for page in paginator.paginate():
        for dist in page.get("DistributionList", {}).get("Items", []):
            if dist["DomainName"] == cdn_domain:
                dist_id = dist["Id"]
                break
        if dist_id:
            break

    if not WEB_DIST.exists():
        print(f"ERROR: {WEB_DIST} not found. Run 'npm --prefix web run build' first.", file=sys.stderr)
        sys.exit(1)
    missing = [str(src_dir / name) for src_dir, files in ((GAME_DIR, RUNTIME_FILES), (GAME3D_DIR, RUNTIME3D_FILES))
               for name in files if not (src_dir / name).is_file()]
    if missing:
        print("ERROR: incomplete runtime bundle: " + ", ".join(missing), file=sys.stderr)
        sys.exit(1)

    print(f"Uploading web/dist to s3://{bucket}/web/ …")
    for file in WEB_DIST.rglob("*"):
        if not file.is_file():
            continue
        key = "web/" + str(file.relative_to(WEB_DIST))
        s3.upload_file(
            str(file),
            bucket,
            key,
            ExtraArgs={"ContentType": content_type(file)},
        )
    print("  Done.")

    config = {"region": region, "userPoolId": user_pool_id, "clientId": client_id}
    s3.put_object(
        Bucket=bucket,
        Key="web/config.json",
        Body=json.dumps(config).encode(),
        ContentType="application/json",
    )
    print("  Uploaded web/config.json")

    # Phaser 2D runtime, then three.js 3D.
    for src_dir, files, prefix in ((GAME_DIR, RUNTIME_FILES, "runtime/v1/"), (GAME3D_DIR, RUNTIME3D_FILES, "runtime3d/v1/")):
        print(f"Uploading game runtime files to {prefix} …")
        for fname in files:
            src = src_dir / fname
            if not src.exists():
                print(f"  WARNING: {fname} not found in {src_dir.name}/ — skipping", file=sys.stderr)
                continue
            s3.upload_file(
                str(src),
                bucket,
                f"{prefix}{fname}",
                ExtraArgs={"ContentType": content_type(src)},
            )
            print(f"  Uploaded {prefix}{fname}")

    # UAL animation clips shared by every rigged character (workers/rig/export_ual.py builds the file)
    s3.upload_file(str(ROOT / "workers" / "rig" / "ual.glb"), bucket, UAL_KEY,
                   ExtraArgs={"ContentType": "model/gltf-binary"})
    print(f"  Uploaded {UAL_KEY}")

    if dist_id:
        print(f"Invalidating CloudFront distribution {dist_id} …")
        cf_client.create_invalidation(
            DistributionId=dist_id,
            InvalidationBatch={
                "Paths": {"Quantity": 1, "Items": ["/*"]},
                "CallerReference": str(hash(cdn_domain)),
            },
        )
        print("  Invalidation submitted.")
    else:
        print("WARNING: Could not find CloudFront distribution for invalidation.")

    print(f"\nDone. App URL: https://{cdn_domain}/")


if __name__ == "__main__":
    upload_web()
