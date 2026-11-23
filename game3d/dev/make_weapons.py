"""Writes the dev weapon GLBs (dev/assets/blade.glb, dev/assets/blaster.glb) from boxes, no dependencies.

Both stand upright like a raw Hunyuan3D mesh of the weapon prompt (grip at the bottom, long axis +Y), so the
runtime's prepareWeapon turn (+Y -> +Z, grip to the origin) is exercised. python3 game3d/dev/make_weapons.py
"""
import json
import pathlib
import struct

OUT = pathlib.Path(__file__).parent / "assets"


def box(cx, cy, cz, sx, sy, sz):
    """24 vertices (flat normals) and 36 indices of an axis-aligned box."""
    pos, nrm, idx = [], [], []
    for axis in range(3):
        for sign in (-1, 1):
            n = [0, 0, 0]
            n[axis] = sign
            u, v = [(1, 2), (0, 2), (0, 1)][axis]
            base = len(pos)
            for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                p = [0, 0, 0]
                p[axis] = sign
                p[u], p[v] = a, b
                pos.append([cx + p[0] * sx / 2, cy + p[1] * sy / 2, cz + p[2] * sz / 2])
                nrm.append(n)
            quad = [0, 1, 2, 0, 2, 3] if sign > 0 else [0, 2, 1, 0, 3, 2]
            if axis == 1:
                quad = [0, 2, 1, 0, 3, 2] if sign > 0 else [0, 1, 2, 0, 2, 3]
            idx += [base + q for q in quad]
    return pos, nrm, idx


def write(name, parts):
    """parts: [(boxes, rgba, metallic, roughness, emissive)] -> one mesh, one primitive per part."""
    blob, views, accessors, prims, materials = bytearray(), [], [], [], []
    for boxes, rgba, metal, rough, emissive in parts:
        pos, nrm, idx = [], [], []
        for b in boxes:
            p, n, i = box(*b)
            idx += [len(pos) + k for k in i]
            pos += p
            nrm += n
        prim = {"attributes": {}, "material": len(materials)}
        for kind, data, fmt, comp, typ in (("POSITION", pos, "3f", 5126, "VEC3"), ("NORMAL", nrm, "3f", 5126, "VEC3"),
                                            (None, idx, "H", 5123, "SCALAR")):
            start = len(blob)
            for item in data:
                blob += struct.pack("<" + fmt, *(item if isinstance(item, list) else [item]))
            while len(blob) % 4:
                blob += b"\0"
            views.append({"buffer": 0, "byteOffset": start, "byteLength": len(blob) - start})
            acc = {"bufferView": len(views) - 1, "componentType": comp, "count": len(data), "type": typ}
            if kind == "POSITION":
                acc["min"] = [min(v[k] for v in data) for k in range(3)]
                acc["max"] = [max(v[k] for v in data) for k in range(3)]
            accessors.append(acc)
            if kind:
                prim["attributes"][kind] = len(accessors) - 1
            else:
                prim["indices"] = len(accessors) - 1
        prims.append(prim)
        materials.append({"pbrMetallicRoughness": {"baseColorFactor": rgba, "metallicFactor": metal, "roughnessFactor": rough},
                          "emissiveFactor": emissive, "doubleSided": True})
    gltf = {"asset": {"version": "2.0", "generator": "make_weapons.py"}, "scene": 0, "scenes": [{"nodes": [0]}],
            "nodes": [{"mesh": 0, "name": name}], "meshes": [{"primitives": prims}], "materials": materials,
            "accessors": accessors, "bufferViews": views, "buffers": [{"byteLength": len(blob)}]}
    js = json.dumps(gltf).encode()
    js += b" " * (-len(js) % 4)
    out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob))
    out += struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(blob), 0x004E4942) + bytes(blob)
    (OUT / f"{name}.glb").write_bytes(out)


# units: centimetres-ish on purpose (raw meshes are not metric); the runtime rescales
write("blade", [
    ([(0, 6, 0, 3, 12, 3)], [0.15, 0.12, 0.1, 1], 0.1, 0.8, [0, 0, 0]),                     # grip
    ([(0, 12.5, 0, 14, 1.5, 4)], [0.8, 0.65, 0.2, 1], 0.9, 0.3, [0, 0, 0]),                  # guard
    ([(0, 45, 0, 5, 64, 1)], [0.7, 0.85, 1.0, 1], 1.0, 0.15, [0.1, 0.5, 0.7]),               # blade
])
write("blaster", [
    ([(0, 5, 0, 3.2, 10, 4)], [0.12, 0.13, 0.15, 1], 0.4, 0.6, [0, 0, 0]),                   # grip
    ([(0, 18, 0, 4.4, 26, 6)], [0.3, 0.32, 0.36, 1], 0.8, 0.35, [0, 0, 0]),                   # body / barrel
    ([(0, 31.5, 0, 2.2, 2, 2.2)], [0.2, 1, 0.9, 1], 0.2, 0.3, [0.2, 1.5, 1.3]),               # muzzle glow
])
