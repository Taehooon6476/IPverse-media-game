#!/usr/bin/env python3
"""Acquire a small, licensed city mesh kit from Kenney's official public packs.

Only allowlisted packs/files are copied. Download links and cookies stay in memory.
No downloaded code is executed; no AWS or model APIs are called.
"""
from __future__ import annotations
import concurrent.futures
import datetime
import hashlib
import http.cookiejar
import io
import itertools
import json
import math
from pathlib import Path, PurePosixPath
import re
import struct
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "game3d/city-assets"
LIMIT = 30 * 1024 * 1024
SELECTION = {
    "city-kit-commercial": [*(f"building-{x}" for x in "abcdefgh"), "building-skyscraper-a",
                           "building-skyscraper-b", "building-skyscraper-c", "detail-awning-wide", "detail-parasol-a"],
    "city-kit-industrial": ["building-a", "building-d", "building-g", "building-j", "building-m",
                           "chimney-large", "shipping-container-a", "water-tower", "solar-panel-landscape-group"],
    "city-kit-roads": ["road-straight", "road-straight-half", "road-crossroad", "road-intersection",
                      "road-crossing", "road-bend", "road-side", "road-square", "road-curve-pavement",
                      "light-curved", "light-curved-double", "light-square", "road-sign-stop",
                      "sign-highway-detailed", "dumpster", "construction-barrier", "electricity-pole"],
    "car-kit": ["suv", "suv-luxury", "taxi", "sedan", "police", "delivery", "van"],
}


def digest(blob):
    return hashlib.sha256(blob).hexdigest()


def fetch(pack):
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    opener.addheaders = [("User-Agent", "Mozilla/5.0")]
    page = "https://kenney.nl/assets/" + pack
    html = opener.open(page, timeout=25).read().decode("utf-8")
    download_id = re.search(r'data-download-id=["\']([a-f0-9]+)', html).group(1)
    request = urllib.request.Request("https://kenney.nl/download-link/" + download_id,
                                    headers={"Referer": page, "Origin": "https://kenney.nl",
                                             "Accept": "application/json"})
    link = json.load(opener.open(request, timeout=25))["url"]
    url = urllib.parse.urlsplit(link)
    if url.scheme != "https" or not (url.hostname == "kenney.nl" or url.hostname.endswith(".kenney.nl")):
        raise ValueError("Official download did not resolve to an allowlisted HTTPS host")
    with opener.open(link, timeout=45) as response:
        blob = response.read(LIMIT + 1)
    if len(blob) > LIMIT:
        raise ValueError("Source archive exceeds the download bound")
    archive = zipfile.ZipFile(io.BytesIO(blob))
    license_blob = archive.read("License.txt")
    if b"Creative Commons Zero, CC0" not in license_blob:
        raise ValueError("Source archive does not contain the required CC0 license")
    names = archive.namelist()
    chosen = {}
    for stem in SELECTION[pack]:
        name = f"Models/GLB format/{stem}.glb"
        if name not in names:
            raise ValueError("A selected actual source mesh is missing: " + pack + "/" + stem)
        chosen[stem] = (name, archive.read(name))
    return pack, {"sourcePage": page, "archiveSha256": digest(blob), "archiveBytes": len(blob),
                  "licenseBlob": license_blob, "archive": archive, "chosen": chosen}


def glb_document(blob):
    magic, version, length = struct.unpack_from("<4sII", blob)
    if magic != b"glTF" or version != 2 or length != len(blob):
        raise ValueError("Invalid actual GLB container")
    size, kind = struct.unpack_from("<I4s", blob, 12)
    if kind != b"JSON":
        raise ValueError("GLB JSON chunk missing")
    return json.loads(blob[20:20 + size])


def multiply(a, b):
    return [sum(a[k * 4 + row] * b[col * 4 + k] for k in range(4))
            for col in range(4) for row in range(4)]


IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def transform(node):
    if "matrix" in node:
        return node["matrix"]
    x, y, z, w = node.get("rotation", [0, 0, 0, 1])
    sx, sy, sz = node.get("scale", [1, 1, 1])
    tx, ty, tz = node.get("translation", [0, 0, 0])
    return [(1 - 2 * (y*y + z*z))*sx, 2*(x*y + z*w)*sx, 2*(x*z - y*w)*sx, 0,
            2*(x*y - z*w)*sy, (1 - 2*(x*x + z*z))*sy, 2*(y*z + x*w)*sy, 0,
            2*(x*z + y*w)*sz, 2*(y*z - x*w)*sz, (1 - 2*(x*x + y*y))*sz, 0,
            tx, ty, tz, 1]


def bounds(document):
    nodes = document.get("nodes", [])
    low, high = [math.inf] * 3, [-math.inf] * 3
    counts = {"vertices": 0, "triangles": 0, "meshes": 0, "materials": len(document.get("materials", []))}
    def visit(index, parent, chain):
        if index in chain:
            raise ValueError("Cyclic node hierarchy")
        node = nodes[index]
        matrix = multiply(parent, transform(node))
        if "mesh" in node:
            counts["meshes"] += 1
            for primitive in document["meshes"][node["mesh"]]["primitives"]:
                accessor = document["accessors"][primitive["attributes"]["POSITION"]]
                if "min" not in accessor or "max" not in accessor:
                    raise ValueError("Actual mesh POSITION bounds are unavailable")
                counts["vertices"] += accessor["count"]
                if primitive.get("mode", 4) == 4:
                    count = (document["accessors"][primitive["indices"]]["count"]
                             if "indices" in primitive else accessor["count"])
                    counts["triangles"] += count // 3
                for point in itertools.product(*zip(accessor["min"], accessor["max"])):
                    for axis in range(3):
                        val = sum(matrix[k * 4 + axis] * point[k] for k in range(3)) + matrix[12 + axis]
                        low[axis] = min(low[axis], val); high[axis] = max(high[axis], val)
        for child in node.get("children", []):
            visit(child, matrix, chain | {index})
    scene = document["scenes"][document.get("scene", 0)]
    for index in scene["nodes"]:
        visit(index, IDENTITY, set())
    if not all(math.isfinite(v) for v in low + high):
        raise ValueError("Scene bounds are not finite")
    size = [high[i] - low[i] for i in range(3)]
    return {"min": low, "max": high, "size": size, "coordinateSystem": "glTF scene Y-up"}, counts


def category(pack, stem):
    if pack == "car-kit":
        return "vehicle"
    if stem.startswith("building"):
        return "building"
    if stem.startswith("light-"):
        return "streetlight"
    if stem.startswith("road-") and "sign" not in stem:
        return "road"
    return "street-prop"


def forward(document, kind):
    if kind != "vehicle":
        return None, "Not inferred from bounding boxes"
    roots = set(document["scenes"][document.get("scene", 0)]["nodes"])
    front, rear = [], []
    for i, node in enumerate(document.get("nodes", [])):
        if i not in roots or node.get("rotation") or node.get("matrix"):
            continue
        z = node.get("translation", [0, 0, 0])[2]
        if node.get("name", "").startswith("wheel-front"):
            front.append(z)
        if node.get("name", "").startswith("wheel-back"):
            rear.append(z)
    if front and rear and sum(front) / len(front) > sum(rear) / len(rear):
        return 0, "Official GLB named front/rear wheel root-node positions verify +Z front"
    return None, "Native forward was not verified"


def main():
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        packs = dict(pool.map(fetch, SELECTION))
    files, sources, assets = {}, [], []
    for pack, data in packs.items():
        license_path = f"licenses/{pack}.txt"
        files[license_path] = data["licenseBlob"]
        sources.append({k: data[k] for k in ("sourcePage", "archiveSha256", "archiveBytes")} |
                       {"id": pack, "license": "CC0-1.0", "licensePath": license_path,
                        "licenseSha256": digest(data["licenseBlob"])})
        for stem, (member, blob) in data["chosen"].items():
            path = f"models/{pack}/{stem}.glb"
            document = glb_document(blob)
            bound, counts = bounds(document)
            files[path] = blob
            dependencies = []
            for resource in [*document.get("buffers", []), *document.get("images", [])]:
                uri = resource.get("uri")
                if not uri or uri.startswith("data:"):
                    continue
                if urllib.parse.urlsplit(uri).scheme or uri.startswith("/"):
                    raise ValueError("External resource URL is not allowed")
                # Preserve original relative GLB texture references without rewriting the model.
                source = str(PurePosixPath(member).parent / uri)
                source = str(PurePosixPath(__import__("posixpath").normpath(source)))
                if not source.startswith("Models/"):
                    raise ValueError("Resource leaves the original model directory")
                dest = str(PurePosixPath(path).parent / uri)
                dest = str(PurePosixPath(__import__("posixpath").normpath(dest)))
                if not dest.startswith("models/"):
                    raise ValueError("Dependency leaves the owned kit")
                dependency = data["archive"].read(source)
                files[dest] = dependency
                dependencies.append({"path": dest, "bytes": len(dependency), "sha256": digest(dependency)})
            kind = category(pack, stem)
            yaw, yaw_proof = forward(document, kind)
            native_size = bound["size"]
            scale = (4.6 / max(native_size[0], native_size[2]) if kind == "vehicle"
                     else 12 / native_size[0] if kind == "road"
                     else 5 / native_size[1] if kind == "streetlight"
                     else 8 if kind == "building" else 4)
            assets.append({"id": pack + "-" + stem, "path": "city-assets/" + path,
                           "category": kind, "source": data["sourcePage"], "sourceArchiveMember": member,
                           "license": "CC0-1.0", "licensePath": "city-assets/" + license_path,
                           "sha256": digest(blob), "bytes": len(blob), "boundingBox": bound,
                           "nativeForwardYaw": yaw, "forwardVerification": yaw_proof,
                           "metersPerUnit": scale, "scaleBasis": "Authored recommended placement scale, not a real-world measurement",
                           "height": native_size[1] * scale,
                           "sizeMeters": [v * scale for v in native_size],
                           "meshCounts": counts, "dependencies": dependencies})
    total = sum(len(v) for v in files.values())
    if total > LIMIT:
        raise ValueError("Selected kit exceeds the 30 MiB bound")
    for relative, blob in files.items():
        out = DEST / relative
        out.parent.mkdir(parents=True, exist_ok=True); out.write_bytes(blob)
    catalog = {"version": 1, "provider": "Kenney official packs", "license": "CC0-1.0",
               "acquiredAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
               "style": "Stylized low-poly actual meshes; not photorealistic or GTA-level assets",
               "totalMeshAndDependencyBytes": total, "sources": sources, "assets": assets}
    DEST.mkdir(parents=True, exist_ok=True)
    (DEST / "commonassetcatalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
    report = {"status": "ACQUIRED_MESHES_LICENSE_VERIFIED", "scope": "Official source meshes and license acquisition; browser integration/gameplay not yet verified",
              "assetCount": len(assets), "totalBytes": total, "maximumBytes": LIMIT,
              "sourcePacks": sources, "catalog": "game3d/city-assets/commonassetcatalog.json",
              "catalogSha256": digest((DEST / "commonassetcatalog.json").read_bytes()),
              "awsWrites": False, "modelJobs": 0, "downloadedCodeExecuted": False,
              "search": {"provider": "Official Kenney assets search", "query": "city", "page": "https://kenney.nl/assets?search=city"}}
    (ROOT / "evidence/city-assets.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "assets": len(assets), "bytes": total}))


if __name__ == "__main__":
    main()
