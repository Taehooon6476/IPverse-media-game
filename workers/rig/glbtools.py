"""Stdlib GLB helpers: read the JSON chunk, summarise skins/animations, trim animation channels.

python3 workers/rig/glbtools.py info FILE.glb
python3 workers/rig/glbtools.py trim IN.glb OUT.glb     # rotations on every joint + pelvis translation only

Trimming exists because Blender's glTF exporter samples translation, rotation and scale on every bone. UAL clips
must keep rotations on every joint (glTF rotations are absolute, so a missing channel leaves a rigged character's
own rest pose in place) but translation only on the pelvis, so other characters keep their own bone lengths.
"""
import json
import struct
import sys
from collections import Counter

KEEP_TRANSLATION = ("pelvis",)


def read_glb(path):
    """→ (gltf dict, bin bytes)."""
    with open(path, "rb") as f:
        data = f.read()
    magic, _version, _length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise ValueError("%s is not a GLB" % path)
    off, gltf, binary = 12, None, b""
    while off < len(data):
        size, kind = struct.unpack_from("<I4s", data, off)
        chunk = data[off + 8:off + 8 + size]
        if kind == b"JSON":
            gltf = json.loads(chunk)
        elif kind == b"BIN\x00":
            binary = chunk
        off += 8 + size
    return gltf, binary


def write_glb(path, gltf, binary):
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    binary += b"\x00" * (-len(binary) % 4)
    total = 12 + 8 + len(js) + (8 + len(binary) if binary else 0)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<I4s", len(js), b"JSON") + js)
        if binary:
            f.write(struct.pack("<I4s", len(binary), b"BIN\x00") + binary)


def trim_animations(gltf, binary, keep_translation=KEEP_TRANSLATION):
    """Drop scale channels and translation channels except on `keep_translation` nodes, then repack the
    buffer so only referenced data remains. Only for mesh-less files (accessors of animations and skins)."""
    if gltf.get("meshes") or gltf.get("images"):
        raise ValueError("trim_animations expects a skeleton-only GLB")
    nodes = gltf["nodes"]
    for anim in gltf.get("animations", []):
        kept, remap, samplers = [], {}, []
        for ch in anim["channels"]:
            path, name = ch["target"]["path"], nodes[ch["target"]["node"]].get("name")
            if path == "scale" or (path == "translation" and name not in keep_translation):
                continue
            s = ch["sampler"]
            if s not in remap:
                remap[s] = len(samplers)
                samplers.append(anim["samplers"][s])
            kept.append({**ch, "sampler": remap[s]})
        anim["channels"], anim["samplers"] = kept, samplers

    used = sorted({s[k] for a in gltf.get("animations", []) for s in a["samplers"] for k in ("input", "output")}
                  | {s["inverseBindMatrices"] for s in gltf.get("skins", []) if "inverseBindMatrices" in s})
    acc_map, accessors, views, out = {}, [], [], bytearray()
    view_map = {}
    for old in used:
        acc = dict(gltf["accessors"][old])
        bv = acc.get("bufferView")
        if bv is not None:
            if bv not in view_map:
                view = dict(gltf["bufferViews"][bv])
                start = view.get("byteOffset", 0)
                out += b"\x00" * (-len(out) % 4)
                view_map[bv] = len(views)
                views.append({**view, "buffer": 0, "byteOffset": len(out)})
                out += binary[start:start + view["byteLength"]]
            acc["bufferView"] = view_map[bv]
        acc_map[old] = len(accessors)
        accessors.append(acc)
    for a in gltf.get("animations", []):
        for s in a["samplers"]:
            s["input"], s["output"] = acc_map[s["input"]], acc_map[s["output"]]
    for s in gltf.get("skins", []):
        if "inverseBindMatrices" in s:
            s["inverseBindMatrices"] = acc_map[s["inverseBindMatrices"]]
    gltf["accessors"], gltf["bufferViews"] = accessors, views
    gltf["buffers"] = [{"byteLength": len(out)}]
    return gltf, bytes(out)


def summary(path):
    g, _ = read_glb(path)
    nodes = g.get("nodes", [])
    anims = {}
    for a in g.get("animations", []):
        paths, moved = Counter(), set()
        for ch in a["channels"]:
            t = ch["target"]
            paths[t["path"]] += 1
            if t["path"] == "translation":
                moved.add(nodes[t["node"]].get("name"))
        keys = max(g["accessors"][s["input"]]["count"] for s in a["samplers"])
        tmax = max(g["accessors"][s["input"]]["max"][0] for s in a["samplers"])
        anims[a["name"]] = {"channels": dict(paths), "translated": sorted(moved), "keys": keys, "seconds": round(tmax, 3)}
    return {"nodes": len(nodes), "meshes": len(g.get("meshes", [])),
            "skins": [len(s["joints"]) for s in g.get("skins", [])], "animations": anims,
            "extras": {n.get("name"): n["extras"] for n in nodes if n.get("extras")}}


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "info":
        print(json.dumps(summary(sys.argv[2]), indent=1))
    elif cmd == "trim":
        write_glb(sys.argv[3], *trim_animations(*read_glb(sys.argv[2])))
    else:
        sys.exit("usage: glbtools.py info FILE | trim IN OUT")
