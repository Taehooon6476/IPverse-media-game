#!/usr/bin/env python3
"""Photoreal CC0 environment kit from Poly Haven (https://polyhaven.com, all assets CC0) for the three.js games.

  python3 scripts/acquire_env_kit.py            # download (build/env-kit/), write game3d/env-kit/catalog.json
  python3 scripts/acquire_env_kit.py --upload   # also upload to s3://<assets>/games/env-kit/v1/ (+ CloudFront invalidation)

Per biome: one 1k HDRI (sky background + image-based light), PBR ground and wall textures (1k jpg: diffuse, normal,
roughness), and a few real-world-scale glTF models (1k textures) grouped by role: tree, rock, debris, prop. Only
the files listed in BIOMES are fetched; nothing downloaded is executed. The kit stays out of git (size); the
catalog is committed.
"""
from __future__ import annotations
import concurrent.futures
import json
import pathlib
import sys
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "build" / "env-kit"
CATALOG = ROOT / "game3d" / "env-kit" / "catalog.json"
API = "https://api.polyhaven.com"
BUCKET = "ipverse-assets-087967639890-us-east-1"
PREFIX = "games/env-kit/v1/"
DISTRIBUTION = "EQC0HYZ4T1PP5"

# role -> Poly Haven model ids; picked for real-world scale and a polycount a browser can instance a few times
BIOMES = {
    "forest": {"hdri": "autumn_forest_01", "ground": "forest_ground_04", "wall": "brick_moss_001",
               "fog": "#9fae9a", "models": {
                   "tree": ["pine_sapling_small"],
                   "rock": ["rock_moss_set_01", "rock_moss_set_02", "boulder_01"],
                   "debris": ["tree_stump_01", "tree_stump_02", "fern_02", "shrub_02", "shrub_04", "dead_tree_trunk_02"],
                   "prop": ["wooden_crate_01", "wine_barrel_01"]}},
    "desert": {"hdri": "goegap", "ground": "coast_sand_01", "wall": "clay_plaster",
               "fog": "#d8c3a0", "models": {
                   "tree": ["quiver_tree_02", "dead_quiver_trunk"],
                   "rock": ["namaqualand_boulder_03", "namaqualand_boulder_04", "rock_07", "rock_09"],
                   "debris": ["namaqualand_stones_01", "dry_branches_medium_01", "old_tyre"],
                   "prop": ["Barrel_01", "rusted_wheel_rim_01", "wooden_crate_02"]}},
    "snow": {"hdri": "passendorf_snow", "ground": "snow_02", "wall": "concrete_block_wall",
             "fog": "#dfe6ee", "models": {
                 "tree": ["fir_sapling"],
                 "rock": ["rock_face_01", "rock_09", "boulder_01"],
                 "debris": ["tree_stump_01", "rock_07", "dead_tree_trunk_02"],
                 "prop": ["old_military_crate", "metal_jerrycan", "wooden_crate_01"]}},
    "ruins": {"hdri": "abandoned_construction", "ground": "asphalt_02", "wall": "damaged_plaster",
              "fog": "#a9a6a0", "models": {
                  "rock": ["rock_07", "concrete_road_barrier"],
                  "debris": ["old_tyre", "cardboard_box_01", "metal_trash_can", "concrete_road_barrier_02"],
                  "prop": ["Barrel_02", "covered_car", "fire_hydrant", "street_lamp_01", "wooden_crate_02"]}},
    "industrial": {"hdri": "abandoned_tank_farm_04", "ground": "gravel_concrete", "wall": "rusty_metal",
                   "fog": "#9c9a94", "models": {
                       "rock": ["concrete_road_barrier_02", "rock_09"],
                       "debris": ["Barrel_03", "old_tyre", "propane_tank", "utility_box_02"],
                       "prop": ["Barrel_01", "industrial_pastic_container", "portable_generator",
                                "wooden_military_crate", "power_box_01"]}},
    "volcanic": {"hdri": "aarfontein_dusk", "ground": "dark_rock_02", "wall": "rusty_metal",
                 "fog": "#3a2a26", "models": {
                     "tree": ["dead_quiver_trunk"],
                     "rock": ["rock_face_02", "boulder_01", "moon_rock_05", "rock_07"],
                     "debris": ["moon_rock_02", "moon_rock_03"],
                     "prop": ["barrel_stove", "Barrel_03"]}},
    "night-city": {"hdri": "modern_evening_street", "ground": "asphalt_04", "wall": "concrete",
                   "fog": "#2a2f3a", "models": {
                       "rock": ["concrete_road_barrier_02"],
                       "debris": ["cardboard_box_01", "metal_trash_can", "plastic_crate_03"],
                       "prop": ["street_lamp_02", "utility_box_01", "exterior_aircon_unit", "fire_hydrant"]}},
    # fantasy outdoor (sky temples, castle courtyards, ancient ruins): above the clouds, stone tiles, marble
    "temple": {"hdri": "cloud_layers", "ground": "stone_tiles_02", "wall": "marble_01",
               "fog": "#d9e3ee", "models": {
                   "tree": ["fir_sapling"],
                   "rock": ["boulder_01", "rock_moss_set_01"],
                   "debris": ["antique_ceramic_vase_01", "ceramic_vase_02", "brass_vase_01"],
                   "prop": ["gothic_statue", "treasure_chest", "wooden_lantern_01", "wooden_barrels_01"]}},
    # indoor: no sky dome; walls, ceiling and torches come from biome.js (indoor biomes)
    "crypt": {"hdri": "castle_zavelstein_cellar", "ground": "cobblestone_floor_04", "wall": "castle_brick_07",
              "fog": "#120e0b", "models": {
                  "rock": ["rock_07"],
                  "debris": ["antique_ceramic_vase_01", "ceramic_vase_02", "wooden_candlestick"],
                  "prop": ["treasure_chest", "wooden_barrels_01", "gothic_statue", "wooden_lantern_01"]}},
}


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "ipverse-env-kit/1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def download(url, dest: pathlib.Path):
    host = urllib.parse.urlsplit(url).hostname or ""
    if not host.endswith("polyhaven.org") and not host.endswith("polyhaven.com"):
        raise ValueError(f"unexpected host {host}")
    if dest.exists() and dest.stat().st_size:
        return dest.stat().st_size
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "ipverse-env-kit/1"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    dest.write_bytes(data)
    return len(data)


def texture_set(tid, biome):
    files = get_json(f"{API}/files/{tid}")
    want = {"map": ("Diffuse", "diff"), "normalMap": ("nor_gl", "nor"), "roughnessMap": ("Rough", "rough")}
    out = {}
    jobs = []
    for key, (field, short) in want.items():
        entry = files.get(field, {}).get("1k", {}).get("jpg")
        if not entry:
            continue
        rel = f"{biome}/tex/{tid}_{short}_1k.jpg"
        jobs.append((entry["url"], OUT / rel))
        out[key] = rel
    if "map" not in out:
        raise ValueError(f"texture {tid}: no 1k diffuse")
    return out, jobs


def model_set(mid, biome):
    files = get_json(f"{API}/files/{mid}")
    g = files.get("gltf", {}).get("1k", {}).get("gltf")
    if not g:
        raise ValueError(f"model {mid}: no 1k glTF")
    base = f"{biome}/models/{mid}/"
    jobs = [(g["url"], OUT / (base + pathlib.PurePosixPath(urllib.parse.urlsplit(g['url']).path).name))]
    for rel, inc in (g.get("include") or {}).items():
        jobs.append((inc["url"], OUT / (base + rel)))
    gltf_name = pathlib.PurePosixPath(urllib.parse.urlsplit(g["url"]).path).name
    return base + gltf_name, jobs


def main():
    catalog = {"version": 1, "source": "Poly Haven (polyhaven.com)", "license": "CC0-1.0",
               "licenseUrl": "https://polyhaven.com/license", "base": "/" + PREFIX, "biomes": {}}
    jobs = []
    for biome, cfg in BIOMES.items():
        h = get_json(f"{API}/files/{cfg['hdri']}")["hdri"]["1k"]["hdr"]
        hdri = f"{biome}/hdri/{cfg['hdri']}_1k.hdr"
        jobs.append((h["url"], OUT / hdri))
        ground, j = texture_set(cfg["ground"], biome)
        jobs += j
        wall, j = texture_set(cfg["wall"], biome)
        jobs += j
        models = {}
        for role, ids in cfg["models"].items():
            for mid in ids:
                try:
                    path, j = model_set(mid, biome)
                except Exception as e:  # noqa: BLE001 — one missing model must not lose the biome
                    print(f"skip {biome}/{mid}: {e}", file=sys.stderr)
                    continue
                jobs += j
                models.setdefault(role, []).append({"id": mid, "path": path, "page": f"https://polyhaven.com/a/{mid}"})
        catalog["biomes"][biome] = {"hdri": hdri, "hdriPage": f"https://polyhaven.com/a/{cfg['hdri']}",
                                    "ground": ground, "groundPage": f"https://polyhaven.com/a/{cfg['ground']}",
                                    "wall": wall, "wallPage": f"https://polyhaven.com/a/{cfg['wall']}",
                                    "fog": cfg["fog"], "models": models}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        sizes = list(pool.map(lambda j: download(*j), jobs))
    print(f"{len(jobs)} files, {sum(sizes) / 1e6:.1f} MB in {OUT}")
    CATALOG.parent.mkdir(parents=True, exist_ok=True)
    CATALOG.write_text(json.dumps(catalog, indent=1) + "\n")
    (OUT / "catalog.json").write_text(json.dumps(catalog, indent=1) + "\n")
    if "--upload" in sys.argv:
        import boto3
        s3 = boto3.client("s3", region_name="us-east-1")
        types = {".gltf": "model/gltf+json", ".bin": "application/octet-stream", ".jpg": "image/jpeg",
                 ".png": "image/png", ".hdr": "application/octet-stream", ".json": "application/json"}
        files = [p for p in OUT.rglob("*") if p.is_file()]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            list(pool.map(lambda p: s3.upload_file(str(p), BUCKET, PREFIX + p.relative_to(OUT).as_posix(), ExtraArgs={
                "ContentType": types.get(p.suffix.lower(), "application/octet-stream"),
                "CacheControl": "public, max-age=31536000, immutable" if p.name != "catalog.json" else "no-cache"}), files))
        boto3.client("cloudfront").create_invalidation(DistributionId=DISTRIBUTION, InvalidationBatch={
            "Paths": {"Quantity": 1, "Items": [f"/{PREFIX}catalog.json"]}, "CallerReference": f"envkit-{time.time()}"})
        print(f"uploaded {len(files)} files to s3://{BUCKET}/{PREFIX}")


if __name__ == "__main__":
    main()
