#!/usr/bin/env python3
"""Sharp sky backdrops for the env kit: each biome's HDRI as Poly Haven's tonemapped JPG, resized to 4096x2048
(the 1k HDR stays the light source). Adds "backdrop" to the catalog; --upload sends the JPGs and the catalog.
"""
import io
import json
import pathlib
import sys
import time
import urllib.request

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "build" / "env-kit"
CATALOG = ROOT / "game3d" / "env-kit" / "catalog.json"
catalog = json.loads(CATALOG.read_text())
for name, b in catalog["biomes"].items():
    hid = b["hdriPage"].rsplit("/", 1)[1]
    rel = f"{name}/hdri/{hid}_bg.jpg"
    dest = OUT / rel
    if not dest.exists():
        meta = json.loads(urllib.request.urlopen(urllib.request.Request(
            f"https://api.polyhaven.com/files/{hid}", headers={"User-Agent": "ipverse-env-kit/1"}), timeout=60).read())
        url = meta["tonemapped"]["url"]
        assert url.startswith("https://dl.polyhaven.org/"), url
        raw = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "ipverse-env-kit/1"}), timeout=180).read()
        img = Image.open(io.BytesIO(raw)).convert("RGB").resize((4096, 2048), Image.LANCZOS)
        dest.parent.mkdir(parents=True, exist_ok=True)
        img.save(dest, "JPEG", quality=84, optimize=True, progressive=True)
    b["backdrop"] = rel
    print(name, rel, f"{dest.stat().st_size / 1e6:.1f} MB")
CATALOG.write_text(json.dumps(catalog, indent=1) + "\n")
(OUT / "catalog.json").write_text(json.dumps(catalog, indent=1) + "\n")
if "--upload" in sys.argv:
    import boto3
    s3 = boto3.client("s3", region_name="us-east-1")
    bucket, prefix = "ipverse-assets-087967639890-us-east-1", "games/env-kit/v1/"
    for name, b in catalog["biomes"].items():
        s3.upload_file(str(OUT / b["backdrop"]), bucket, prefix + b["backdrop"],
                       ExtraArgs={"ContentType": "image/jpeg", "CacheControl": "public, max-age=31536000, immutable"})
    s3.upload_file(str(OUT / "catalog.json"), bucket, prefix + "catalog.json",
                   ExtraArgs={"ContentType": "application/json", "CacheControl": "no-cache"})
    boto3.client("cloudfront").create_invalidation(DistributionId="EQC0HYZ4T1PP5", InvalidationBatch={
        "Paths": {"Quantity": 1, "Items": [f"/{prefix}catalog.json"]}, "CallerReference": f"envkit-bg-{time.time()}"})
    print("uploaded backdrops")
