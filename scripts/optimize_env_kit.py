#!/usr/bin/env python3
"""Shrink the downloaded env kit for the browser: every glTF becomes one Draco-compressed GLB (simplified mesh,
WebP textures at most 1024 px), next to it; the catalog points at the .glb. Run after acquire_env_kit.py.

  python3 scripts/optimize_env_kit.py [--ratio 0.25]
"""
import concurrent.futures
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "build" / "env-kit"
CATALOG = ROOT / "game3d" / "env-kit" / "catalog.json"
RATIO = float(sys.argv[sys.argv.index("--ratio") + 1]) if "--ratio" in sys.argv else 0.25


def optimize(gltf: pathlib.Path):
    glb = gltf.with_suffix(".glb")
    if glb.exists():
        return glb
    # heavy scans (trees, cliffs) are cut harder; the error bound keeps silhouettes
    size = sum(p.stat().st_size for p in gltf.parent.glob("*.bin"))
    ratio = RATIO if size < 4e6 else RATIO / 4
    cmd = ["npx", "--yes", "@gltf-transform/cli", "optimize", str(gltf), str(glb), "--compress", "draco",
           "--texture-compress", "webp", "--texture-size", "1024", "--simplify-ratio", str(ratio),
           "--simplify-error", "0.002"]
    subprocess.run(cmd, check=True, capture_output=True, timeout=600)
    return glb


catalog = json.loads(CATALOG.read_text())
paths = [m for b in catalog["biomes"].values() for ms in b["models"].values() for m in ms]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    done = list(pool.map(lambda m: optimize(OUT / m["path"]), paths))
for m, glb in zip(paths, done):
    m["path"] = glb.relative_to(OUT).as_posix()
    m["bytes"] = glb.stat().st_size
CATALOG.write_text(json.dumps(catalog, indent=1) + "\n")
(OUT / "catalog.json").write_text(json.dumps(catalog, indent=1) + "\n")
for name, b in catalog["biomes"].items():
    total = sum(m["bytes"] for ms in b["models"].values() for m in ms)
    print(f"{name}: {sum(len(ms) for ms in b['models'].values())} models, {total / 1e6:.1f} MB")

if "--upload" in sys.argv:  # only what the runtime loads: GLBs, ground/wall textures, HDRIs, the catalog
    import time
    import boto3
    bucket, prefix = "ipverse-assets-087967639890-us-east-1", "games/env-kit/v1/"
    types = {".glb": "model/gltf-binary", ".jpg": "image/jpeg", ".hdr": "application/octet-stream", ".json": "application/json"}
    files = [OUT / "catalog.json"] + [p for p in OUT.rglob("*") if p.is_file() and (
        p.suffix == ".glb" or "/tex/" in p.as_posix() or "/hdri/" in p.as_posix())]
    s3 = boto3.client("s3", region_name="us-east-1")
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(lambda p: s3.upload_file(str(p), bucket, prefix + p.relative_to(OUT).as_posix(), ExtraArgs={
            "ContentType": types.get(p.suffix, "application/octet-stream"),
            "CacheControl": "no-cache" if p.name == "catalog.json" else "public, max-age=31536000, immutable"}), files))
    boto3.client("cloudfront").create_invalidation(DistributionId="EQC0HYZ4T1PP5", InvalidationBatch={
        "Paths": {"Quantity": 1, "Items": [f"/{prefix}*"]}, "CallerReference": f"envkit-{time.time()}"})
    print(f"uploaded {len(files)} files, {sum(p.stat().st_size for p in files) / 1e6:.1f} MB")
