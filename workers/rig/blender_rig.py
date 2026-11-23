"""Auto-rig a Hunyuan3D GLB onto the Quaternius UAL skeleton, export rigged.glb, render validation frames.

blender -b --factory-startup -noaudio --python-exit-code 1 --python workers/rig/blender_rig.py -- \
  --glb IN.glb --ual ual.glb --bones workers/rig/ual_bones.json --clips workers/rig/ual_clips.json --out OUTDIR \
  [--pose-cmd "python workers/rig/pose2d.py rtmpose.onnx"] [--res 512] [--samples 12] [--no-validate] \
  [--meshclean workers/img3d/meshclean.py]

1. Import, join meshes, drop Hunyuan's floor slab and stray flat cards (meshclean.py), normalise: 1.8 m tall,
   feet on z = 0, centred, facing -Y (glTF +Z).
2. Render orthographic front and side views; `--pose-cmd` (pose2d.py) returns COCO-17 keypoints per view.
   Front gives (x, z); every joint is then snapped into the mesh volume by ray casting along the view axis and
   taking the midpoint of the entry/exit segment nearest the side view's depth. Limb joints are also centred
   across the limb. Missing or implausible detections fall back to proportions + cross-section slicing.
3. Copy the UAL armature from ual.glb and move its bones onto the joints (names, hierarchy and roll
   convention kept; untargeted bones follow their parent's similarity transform).
4. Automatic (heat) weights; when more than 2% of vertices stay unweighted, weights are computed on a voxel
   remesh proxy and copied over by name (nearest proxy vertices). Max 4 influences, normalised.
5. Rest = UAL rest: pose every bone to the UAL rest rotation, bake the skinned mesh, apply the pose as rest.
6. rigged.glb (skinned mesh + armature, no animations; armature extra `ualHipsScale`).
7. Validation: re-import rigged.glb, assign the ual.glb clips by name (no retarget):
   frames/run_NNNN.png (one run cycle), frames/attack_NN.png (6), frames/weights.png.

OUTDIR/meta.json records the joint method ("rtmpose" | "proportions"), joints, weight method and timings.
"""
import argparse
import json
import math
import os
import shlex
import subprocess
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

HEIGHT = 1.8
VIEW_RES = 640
ORTHO = 2.0
CAM_Z = 0.9
MIN_SCORE = 0.3
UNWEIGHTED_MAX = 0.02
# metres, on the 1.8 m normalised body; RIG_VOXEL_TRIES=0.012,0.025 overrides (tuning, and forcing the fallback in tests)
VOXEL_TRIES = tuple(float(v) for v in os.environ.get("RIG_VOXEL_TRIES", "0.012,0.025,0.045").split(","))
PROXY_UNWEIGHTED_MAX = 0.05  # the proxy only has to cover the body; transfer fills the rest by nearest neighbours

FRONT, DEPTH = Vector((0.0, 1.0, 0.0)), Vector((0.0, 1.0, 0.0))  # front camera looks +Y; depth axis is Y
LIMB_JOINTS = ("elbow", "wrist", "knee", "ankle")
LIMB_MAX_WIDTH = 0.22
ARM_SLACK = 0.1  # m: how far above its elbow a wrist (and above its shoulder an elbow) may be read
YAW_FIX = math.radians(4)
PARTIAL_HIP = 0.3  # a full figure has its hips near half its height; lower means the legs are cut off
PARTIAL = "not a full body: legs are missing or cut off"
PARTIAL_EXIT = 3
SIDES = ("l", "r")
# |left - right| / longer leg (hip-knee-ankle); sound rigs are under 5 %. A knee placed in a tail or a coat makes
# baking the UAL rest drive that leg through the floor. game3d/ualclips.js LEG_IMBALANCE_MAX drops such a rig too.
LEG_IMBALANCE_MAX = 0.12
UNEVEN = "legs of uneven length"
MIRROR_MAX = 3  # weak keypoints that may take their partner's mirrored position
LEG_OFF_LINE = 0.25  # knee distance from the hip-ankle line, over the leg length
LEG_SPREAD = 0.12  # m a knee or ankle may sit outside the hips' half width
LEG_DEPTH = 0.3  # m between the left and right knee (or ankle) depths (sound rigs: at most 0.15)
# chibi and stylised bodies: a big head puts the shoulders near 60 % of the height and the hips near a third;
# a human is about 0.82 and 0.52
HIP_RANGE = (PARTIAL_HIP, 0.65)
SHOULDER_RANGE = (0.5, 0.92)
TORSO_MIN = 0.15  # shoulders above hips, over the height


def parse_args():
    p = argparse.ArgumentParser(prog="blender_rig.py")
    p.add_argument("--glb", required=True)
    p.add_argument("--ual", required=True, help="ual.glb from export_ual.py")
    p.add_argument("--bones", required=True)
    p.add_argument("--clips", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--pose-cmd", default="", help="command prefix; gets OUT.json NAME=PNG... appended")
    p.add_argument("--res", type=int, default=512)
    p.add_argument("--samples", type=int, default=12)
    p.add_argument("--no-validate", action="store_true")
    p.add_argument("--meshclean", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "img3d",
                                                       "meshclean.py"), help="workers/img3d/meshclean.py")
    return p.parse_args(sys.argv[sys.argv.index("--") + 1:])


def log(msg):
    print("blender_rig: " + msg, flush=True)


# ---------------------------------------------------------------- import + normalise

def import_character(path, meshclean_path):
    """→ (normalised Character mesh object, meshclean info)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps, scene.render.fps_base = 30, 1.0
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        sys.exit("blender_rig: no mesh in %s" % path)
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.data.transform(mw)
        o.matrix_world = Matrix.Identity(4)
    for o in list(bpy.context.scene.objects):
        if o.type != "MESH":
            bpy.data.objects.remove(o)
    if len(meshes) > 1:
        with bpy.context.temp_override(active_object=meshes[0], selected_editable_objects=meshes):
            bpy.ops.object.join()
    obj = meshes[0]
    obj.name = "Character"
    cleanup = strip_sheets(obj, meshclean_path)  # before the 1.8 m scale: a slab must not count in the height
    co = vertex_array(obj)
    lo, hi = co.min(0), co.max(0)
    s = HEIGHT / (hi[2] - lo[2])
    centre = Vector(((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]))
    obj.data.transform(Matrix.Scale(s, 4) @ Matrix.Translation(-centre))
    obj.data.update()
    close_soles(obj)
    return obj, cleanup


def close_soles(obj, below=0.02):
    """Cap the open loops a removed slab leaves at the bottom (soles, a cape hem), also when the mesh came in
    already cleaned: the voxel proxy needs a closed body to tell inside from outside, or heat weighting fails."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    # the glTF import splits vertices along UV seams, which breaks every loop; UVs are per corner, so merge there
    bmesh.ops.remove_doubles(bm, verts=[v for v in bm.verts if v.co.z < below], dist=1e-5)
    edges = [e for e in bm.edges if e.is_boundary and all(v.co.z < below for v in e.verts)]
    if edges:
        made = bmesh.ops.holes_fill(bm, edges=edges, sides=0)["faces"]
        bm.to_mesh(obj.data)
        obj.data.update()
        log("closed %d open loop(s) at the soles" % len(made))
    bm.free()


def strip_sheets(obj, meshclean_path):
    """Hunyuan3D's floor slab (fused to the soles, it would ride a foot bone as a flapping plate) and stray flat
    cards out of the mesh: workers/img3d/meshclean.py on Blender axes (Z up, -Y toward the camera)."""
    import bmesh
    import importlib.machinery
    import importlib.util
    # OpenJD writes embedded files without a .py suffix, so name the loader instead of guessing it from the path
    loader = importlib.machinery.SourceFileLoader("meshclean", meshclean_path)
    meshclean = importlib.util.module_from_spec(importlib.util.spec_from_loader("meshclean", loader))
    loader.exec_module(meshclean)
    mesh = obj.data
    mesh.calc_loop_triangles()
    tris = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int64)
    mesh.loop_triangles.foreach_get("vertices", tris)
    poly = np.empty(len(mesh.loop_triangles), dtype=np.int64)
    mesh.loop_triangles.foreach_get("polygon_index", poly)
    keep, info = meshclean.clean(vertex_array(obj), tris.reshape(-1, 3), up=2, front=1)
    if not keep.all():
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.faces[i] for i in sorted(set(poly[~keep].tolist()))], context="FACES")
        bm.to_mesh(mesh)
        bm.free()
        mesh.update()
        log("removed %d faces: %d floor slab(s), %d flat card(s)" % (info["removedFaces"], len(info["slabs"]),
                                                                    info["cards"]))
    return {"removedFaces": info["removedFaces"], "slabs": len(info["slabs"]), "cards": info["cards"]}


def vertex_array(obj):
    co = np.empty(len(obj.data.vertices) * 3, dtype=np.float64)
    obj.data.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


# ---------------------------------------------------------------- views + pose

def setup_render(res, samples, transparent):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = transparent
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA" if transparent else "RGB"
    scene.view_settings.view_transform = "Standard"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("World")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.8, 0.8, 0.8, 1.0)
    bg.inputs["Strength"].default_value = 1.0


def camera(name, location, rotation, ortho=None, lens=50):
    cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
    bpy.context.scene.collection.objects.link(cam)
    cam.location, cam.rotation_euler = location, rotation
    if ortho:
        cam.data.type, cam.data.ortho_scale = "ORTHO", ortho
    else:
        cam.data.lens = lens
    return cam


def render(cam, path):
    scene = bpy.context.scene
    scene.camera = cam
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def render_views(out):
    setup_render(VIEW_RES, 16, transparent=True)
    front = camera("Front", (0, -6, CAM_Z), (math.pi / 2, 0, 0), ortho=ORTHO)
    side = camera("Side", (6, 0, CAM_Z), (math.pi / 2, 0, math.pi / 2), ortho=ORTHO)
    paths = {"front": os.path.join(out, "views", "front.png"), "side": os.path.join(out, "views", "side.png")}
    render(front, paths["front"])
    render(side, paths["side"])
    for cam in (front, side):
        bpy.data.objects.remove(cam)
    return paths


def run_pose(cmd, out, paths):
    if not cmd:
        return None
    result = os.path.join(out, "pose.json")
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONHOME")}
    argv = shlex.split(cmd) + [result] + ["%s=%s" % kv for kv in paths.items()]
    proc = subprocess.run(argv, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        log("pose estimator failed (%d): %s" % (proc.returncode, proc.stderr[-800:]))
        return None
    with open(result) as f:
        return json.load(f)


def pixel_to_plane(u, v):
    """Ortho view pixel → (horizontal, z): horizontal is world x for the front view, world y for the side view."""
    return (u / VIEW_RES - 0.5) * ORTHO, CAM_Z + (0.5 - v / VIEW_RES) * ORTHO


# ---------------------------------------------------------------- ray casting

class Volume:
    def __init__(self, obj):
        mesh = obj.data
        self.bvh = BVHTree.FromPolygons([v.co.copy() for v in mesh.vertices], [p.vertices[:] for p in mesh.polygons])

    def segments(self, origin, direction, limit=64):
        """Entry/exit pairs (as distances along `direction` from the axis origin) of a ray through the mesh."""
        hits, o = [], origin.copy()
        for _ in range(limit):
            loc, _n, _i, _d = self.bvh.ray_cast(o, direction)
            if loc is None:
                break
            hits.append((loc - origin).dot(direction))
            o = loc + direction * 1e-4
        if len(hits) % 2:
            hits.append(hits[-1])
        return [(hits[i], hits[i + 1]) for i in range(0, len(hits), 2)]

    def depth(self, x, z, expected=None):
        """Mid-depth (world y) of the solid segment at (x, z) along y; None if the ray misses."""
        origin = Vector((x, -5.0, z))
        segs = self.segments(origin, DEPTH)
        if not segs:
            return None
        if expected is None:
            a, b = segs[0]
        else:
            e = expected + 5.0
            a, b = min(segs, key=lambda s: 0 if s[0] <= e <= s[1] else min(abs(e - s[0]), abs(e - s[1])))
        return (a + b) / 2 - 5.0

    def snap(self, x, z, expected=None):
        """→ (Vector inside the mesh, how): ray at (x, z), else nearby rays, else the nearest surface point."""
        y = self.depth(x, z, expected)
        if y is not None:
            return Vector((x, y, z)), "ray"
        for r in (0.01, 0.02, 0.035):
            for k in range(8):
                dx, dz = r * math.cos(k * math.pi / 4), r * math.sin(k * math.pi / 4)
                y = self.depth(x + dx, z + dz, expected)
                if y is not None:
                    return Vector((x + dx, y, z + dz)), "ray_near"
        loc, *_ = self.bvh.find_nearest(Vector((x, expected or 0.0, z)))
        return loc, "nearest"

    def centre_across(self, p):
        """Centre a limb joint along x when the limb's cross-section there is limb-sized."""
        origin = Vector((-5.0, p.y, p.z))
        for a, b in self.segments(origin, Vector((1.0, 0.0, 0.0))):
            if a - 0.01 <= p.x + 5.0 <= b + 0.01 and b - a < LIMB_MAX_WIDTH:
                return Vector(((a + b) / 2 - 5.0, p.y, p.z))
        return p

    def hits_any(self, x, z):
        return bool(self.segments(Vector((x, -5.0, z)), DEPTH))


# ---------------------------------------------------------------- joints

def detected_joints(pose, vol):
    """RTMPose front + side keypoints → {joint: Vector} or (None, reason)."""
    names = pose["names"]
    front = {n: k for n, k in zip(names, pose["front"]["keypoints"])}
    side = {n: k for n, k in zip(names, pose.get("side", {}).get("keypoints", []))}
    need = ["%s_%s" % (j, s) for j in ("shoulder", "elbow", "wrist", "hip", "knee", "ankle") for s in SIDES]
    hips = [pixel_to_plane(*front[n][:2])[1] for n in ("hip_l", "hip_r") if front[n][2] >= MIN_SCORE]
    if len(hips) == 2 and sum(hips) / 2 < PARTIAL_HIP * HEIGHT:
        return None, PARTIAL + " (hips at %.0f%% of the height)" % (50 * sum(hips) / HEIGHT)
    weak = [n for n in need if front[n][2] < MIN_SCORE]
    flat = {n: pixel_to_plane(front[n][0], front[n][1]) for n in need}
    flat, mirrored = mirror_weak(flat, weak)
    if mirrored is None:
        return None, "low score: " + ", ".join(weak)
    if flat["shoulder_l"][0] < flat["shoulder_r"][0]:  # the model read the figure as facing away
        flat = {n: flat[n[:-1] + ("r" if n.endswith("l") else "l")] for n in need}
    joints, how = {}, {}
    for n in need:
        kind = n[:-2]
        depths = [pixel_to_plane(side[kind + "_" + s][0], side[kind + "_" + s][1])[0]
                  for s in SIDES if side and side[kind + "_" + s][2] >= MIN_SCORE]
        expected = sum(depths) / len(depths) if depths else None
        x, z = flat[n]
        p, how[n] = vol.snap(x, z, expected)
        if n in mirrored:
            how[n] = "mirror"
        if kind in LIMB_JOINTS:
            p = vol.centre_across(p)
        joints[n] = p
    for s in SIDES:  # a wrist read on a shoulder pad: continue the upper arm instead
        sh, el = joints["shoulder_" + s], joints["elbow_" + s]
        if joints["wrist_" + s].z > el.z + ARM_SLACK:
            p = el + (el - sh)
            q, _ = vol.snap(p.x, p.z)
            joints["wrist_" + s], how["wrist_" + s] = vol.centre_across(q), "upper_arm"
    repair_legs(joints, how, vol)
    reason = implausible(joints)
    if reason:
        return None, reason
    return joints, how


def partner(n):
    return n[:-1] + ("r" if n.endswith("l") else "l")


def mirror_weak(flat, weak):
    """A keypoint read below MIN_SCORE takes its partner's position mirrored across the body's symmetry plane (e.g. a
    wrist hidden behind a bag). → (flat, mirrored names), or (flat, None) when too much is weak or both sides of a
    joint are, which the proportional fallback handles."""
    weak = set(weak)
    if not weak:
        return flat, set()
    if len(weak) > MIRROR_MAX or any(partner(n) in weak for n in weak):
        return flat, None
    mids = [(flat[k + "_l"][0] + flat[k + "_r"][0]) / 2 for k in ("hip", "shoulder")
            if k + "_l" not in weak and k + "_r" not in weak]
    cx = sum(mids) / len(mids) if mids else 0.0
    out = dict(flat)
    for n in weak:
        x, z = flat[partner(n)]
        out[n] = (2 * cx - x, z)
    return out, weak


def symmetry_x(j):
    return ((j["hip_l"].x + j["hip_r"].x) / 2 + (j["shoulder_l"].x + j["shoulder_r"].x) / 2) / 2


def leg_outside(j, s):
    """Why the leg chain on side `s` leaves the leg volume below the hips, or "": seen from the front, a knee in a
    tail or a coat sits far off the hip-ankle line or far out to the side, or not between hip and ankle."""
    hp, kn, an = j["hip_" + s], j["knee_" + s], j["ankle_" + s]
    flat = lambda p: Vector((p.x, 0.0, p.z))  # noqa: E731 - in the front plane: depths are noisier
    axis = flat(an) - flat(hp)
    length = max(axis.length, 1e-6)
    t = max(0.0, min(1.0, (flat(kn) - flat(hp)).dot(axis) / (length * length)))
    off = (flat(kn) - (flat(hp) + axis * t)).length / length
    if off > LEG_OFF_LINE:
        return "knee %.0f%% of the leg off the hip-ankle line" % (100 * off)
    half = abs(j["hip_l"].x - j["hip_r"].x) / 2 + LEG_SPREAD
    for k, p in (("knee", kn), ("ankle", an)):
        if abs(p.x - hp.x) > half:
            return "%s %.2f m out from the hip" % (k, abs(p.x - hp.x))
    if not an.z < kn.z < hp.z:
        return "knee not between hip and ankle"
    return ""


def repair_legs(j, how, vol):
    """One leg outside its volume while the other is sound: the sound one is mirrored across the symmetry plane,
    its depth kept. A knee or ankle snapped into a cape or a tail shows as the two legs at different depths; the
    one farther from its hip is the misread one. Both bad, or uneven for another reason: left to implausible()."""
    bad = {s: leg_outside(j, s) for s in SIDES}
    if all(bad.values()):
        return ""
    if not any(bad.values()):
        for kind in ("knee", "ankle"):
            gap = abs(j[kind + "_l"].y - j[kind + "_r"].y)
            if gap > LEG_DEPTH:
                s = max(SIDES, key=lambda s: abs(j["%s_%s" % (kind, s)].y - j["hip_" + s].y))
                bad[s] = "%s %.2f m deeper than the other" % (kind, gap)
                break
        else:
            return ""
    s = next(k for k, v in bad.items() if v)
    good = "l" if s == "r" else "r"
    cx = symmetry_x(j)
    for kind in ("knee", "ankle"):
        g = j["%s_%s" % (kind, good)]
        # the mirror image itself, depth included: snapping again could land in the same cape
        j["%s_%s" % (kind, s)] = vol.centre_across(Vector((2 * cx - g.x, g.y, g.z)))
        how["%s_%s" % (kind, s)] = "mirror"
    log("leg %s %s: mirrored the %s leg" % (s, bad[s], good))
    return bad[s]


def facing_yaw(j):
    """Angle of the left-right shoulder/hip line in the ground plane (0 when the figure faces -Y)."""
    d = (j["shoulder_l"] - j["shoulder_r"]) + (j["hip_l"] - j["hip_r"])
    return math.atan2(d.y, d.x)


def leg_imbalance(j):
    legs = [(j["hip_" + s] - j["knee_" + s]).length + (j["knee_" + s] - j["ankle_" + s]).length for s in SIDES]
    return abs(legs[0] - legs[1]) / max(max(legs), 1e-6)


def implausible(j):
    if leg_imbalance(j) > LEG_IMBALANCE_MAX:
        return UNEVEN + " (%.0f%%)" % (100 * leg_imbalance(j))
    for s in SIDES:
        z = [j["%s_%s" % (k, s)].z for k in ("ankle", "knee", "hip", "shoulder")]
        if not all(a < b for a, b in zip(z, z[1:])):
            return "joint heights out of order on side " + s
        upper = (j["elbow_" + s] - j["shoulder_" + s]).length
        if not 0.12 < upper < 0.5:
            return "upper arm length %.2f" % upper
        # the input is an A-pose: arms hang down (a T-pose gets ARM_SLACK). An elbow far above its shoulder means
        # the arm was misread (a high wrist is repaired in detected_joints)
        if j["elbow_" + s].z > j["shoulder_" + s].z + ARM_SLACK:
            return "elbow above the shoulder on side " + s
    hip, sh = j["hip_l"].z / HEIGHT, j["shoulder_l"].z / HEIGHT
    if not HIP_RANGE[0] < hip < HIP_RANGE[1] or not SHOULDER_RANGE[0] < sh < SHOULDER_RANGE[1] or sh - hip < TORSO_MIN:
        return "hip or shoulder height out of range"
    if j["shoulder_l"].x - j["shoulder_r"].x < 0.12:
        return "shoulders too narrow"
    return ""


def proportional_joints(obj, vol):
    """Fallback: crotch from the first solid ray between the legs, neck from the narrowest slice, limb ends
    from the farthest vertices; everything snapped into the volume."""
    H, co = HEIGHT, vertex_array(obj)
    crotch = 0.45 * H
    for z in np.arange(0.2 * H, 0.62 * H, 0.005):
        if not vol.hits_any(0.0, z):
            crotch = z
    hip_z, ankle_z = crotch + 0.045 * H, 0.057 * H
    knee_z = ankle_z + 0.53 * (hip_z - ankle_z)  # 0.29 H on a human; lower on short legs
    core = co[np.abs(co[:, 0]) < 0.15 * H]
    widths = []
    for z in np.arange(0.78 * H, 0.92 * H, 0.005):
        band = core[np.abs(core[:, 2] - z) < 0.004]
        if len(band) > 3:
            widths.append((band[:, 0].max() - band[:, 0].min(), z))
    neck_z = min(widths)[1] if widths else 0.85 * H
    shoulder_z = neck_z - 0.05 * H
    chest = [s for s in vol.segments(Vector((-5.0, 0.0, shoulder_z - 0.06 * H)), Vector((1.0, 0.0, 0.0)))
             if s[0] - 5.0 <= 0.0 <= s[1] - 5.0]
    half = (chest[0][1] - chest[0][0]) / 2 if chest else 0.1 * H
    joints, how = {}, {}
    for s, sign in (("l", 1.0), ("r", -1.0)):
        hip_y = vol.depth(sign * 0.05 * H, hip_z) or 0.0

        def leg_x(z):
            # inside the leg volume: beside the hip and at its depth, so a tail or a bag beside the leg is not averaged in
            band = co[(np.abs(co[:, 2] - z) < 0.01) & (co[:, 0] * sign > 0.01)
                      & (co[:, 0] * sign < 0.05 * H + LEG_SPREAD) & (np.abs(co[:, 1] - hip_y) < LEG_SPREAD)]
            return float(band[:, 0].mean()) if len(band) else sign * 0.05 * H
        shoulder = Vector((sign * min(0.85 * half, 0.13 * H), 0.0, shoulder_z))
        arm = co[(co[:, 0] * sign > abs(shoulder.x)) & (co[:, 2] > 0.42 * H) & (co[:, 2] < shoulder_z + 0.05 * H)]
        if len(arm):
            tip = Vector(arm[np.argmax(np.linalg.norm(arm - np.array(shoulder), axis=1))])
        else:
            tip = shoulder + Vector((sign * 0.3 * H, 0, -0.3 * H))
        flat = {"shoulder": shoulder, "elbow": shoulder.lerp(tip, 0.36), "wrist": shoulder.lerp(tip, 0.72),
                "hip": Vector((sign * 0.05 * H, 0, hip_z)), "knee": Vector((leg_x(knee_z), 0, knee_z)),
                "ankle": Vector((leg_x(ankle_z + 0.02), 0, ankle_z))}
        for kind, p in flat.items():
            q, how[kind + "_" + s] = vol.snap(p.x, p.z)
            joints[kind + "_" + s] = vol.centre_across(q) if kind in LIMB_JOINTS else q
    repair_legs(joints, how, vol)
    return joints, how


# ---------------------------------------------------------------- skeleton

def similarity(a0, a1, b0, b1):
    """Rotation (minimal, a1-a0 onto b1-b0), uniform scale and translation mapping a0→b0 and a1→b1."""
    da, db = a1 - a0, b1 - b0
    rot = da.rotation_difference(db).to_matrix()
    scale = db.length / max(da.length, 1e-6)
    return lambda p: b0 + rot @ ((p - a0) * scale), rot


def build_rig(ual_arm, joints, vol, deform_excluded):
    rig = ual_arm.copy()
    rig.data = ual_arm.data.copy()
    rig.animation_data_clear()
    rig.name = rig.data.name = "Rig"
    bpy.context.scene.collection.objects.link(rig)
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = rig.data.edit_bones
    U = {b.name: (b.head.copy(), b.tail.copy(), b.z_axis.copy()) for b in eb}
    for b in eb:
        b.use_connect = False
    J = joints
    mid = lambda a, b: (a + b) / 2  # noqa: E731
    hip_mid, sh_mid = mid(J["hip_l"], J["hip_r"]), mid(J["shoulder_l"], J["shoulder_r"])
    u_hip_mid, u_sh_mid = mid(U["thigh_l"][0], U["thigh_r"][0]), mid(U["upperarm_l"][0], U["upperarm_r"][0])
    s_torso = (sh_mid - hip_mid).length / (u_sh_mid - u_hip_mid).length
    pelvis = hip_mid + (U["pelvis"][0] - u_hip_mid) * s_torso
    neck = sh_mid + (U["neck_01"][0] - u_sh_mid) * s_torso
    torso, r_torso = similarity(U["pelvis"][0], U["neck_01"][0], pelvis, neck)
    u_top = Vector((0.0, U["Head"][1].y, 1.829))  # UAL mannequin height
    head_y = vol.depth(neck.x, HEIGHT - 0.1) or neck.y
    head, r_head = similarity(U["neck_01"][0], u_top, neck, Vector((neck.x, head_y, HEIGHT)))
    place, rots = {}, {}

    def put(name, h, t, rot=None):
        uh, ut, _ = U[name]
        place[name] = (h, t)
        rots[name] = rot if rot is not None else (ut - uh).rotation_difference(t - h).to_matrix()

    put("root", Vector((0, 0, 0)), Vector((0, 0, U["root"][1].z * HEIGHT / 1.829)), Matrix.Identity(3))
    for n in ("pelvis", "spine_01", "spine_02", "spine_03"):
        put(n, torso(U[n][0]), torso(U[n][1]), r_torso)
    put("neck_01", neck, head(U["neck_01"][1]), r_head)
    put("Head", head(U["Head"][0]), head(U["Head"][1]), r_head)
    for s in SIDES:
        sh, el, wr = J["shoulder_" + s], J["elbow_" + s], J["wrist_" + s]
        put("clavicle_" + s, torso(U["clavicle_" + s][0]), sh)
        put("upperarm_" + s, sh, el)
        put("lowerarm_" + s, el, wr)
        s_fore = (wr - el).length / (U["lowerarm_" + s][1] - U["lowerarm_" + s][0]).length
        hand_len = (U["hand_" + s][1] - U["hand_" + s][0]).length * s_fore
        put("hand_" + s, wr, wr + (wr - el).normalized() * hand_len)
        hand_rot = rots["hand_" + s]
        uh = U["hand_" + s][0]
        for n in U:
            if any(n.startswith(f) for f in ("index_", "middle_", "ring_", "pinky_", "thumb_")) and n.endswith("_" + s):
                put(n, wr + hand_rot @ ((U[n][0] - uh) * s_fore), wr + hand_rot @ ((U[n][1] - uh) * s_fore), hand_rot)
        hp, kn, an = J["hip_" + s], J["knee_" + s], J["ankle_" + s]
        put("thigh_" + s, hp, kn)
        put("calf_" + s, kn, an)
        s_leg = (an - kn).length / (U["calf_" + s][1] - U["calf_" + s][0]).length
        uf = U["foot_" + s][0]
        for n in ("foot_", "ball_", "ball_leaf_"):
            h, t = an + (U[n + s][0] - uf) * s_leg, an + (U[n + s][1] - uf) * s_leg
            h.z, t.z = max(h.z, 0.01), max(t.z, 0.01)
            put(n + s, h, t, Matrix.Identity(3))
    missing = set(U) - set(place)
    if missing:
        raise RuntimeError("bones without placement: %s" % sorted(missing))
    for name, (h, t) in place.items():
        b = eb[name]
        if (t - h).length < 1e-3:
            t = h + (U[name][1] - U[name][0]).normalized() * 1e-3
        b.head, b.tail = h, t
        b.align_roll(rots[name] @ U[name][2])
    bpy.ops.object.mode_set(mode="OBJECT")
    for b in rig.data.bones:
        b.use_deform = b.name not in deform_excluded
    rig["ualHipsScale"] = round(rig.data.bones["pelvis"].head_local.z / U["pelvis"][0].z, 5)
    return rig


# ---------------------------------------------------------------- weights

def unweighted_fraction(obj):
    empty = sum(1 for v in obj.data.vertices if not any(g.weight > 1e-4 for g in v.groups))
    return empty / max(len(obj.data.vertices), 1)


def transfer_weights(src, dst, k=4):
    """Inverse-distance blend of the k nearest source vertices' weights, matched by group name."""
    kd = KDTree(len(src.data.vertices))
    for v in src.data.vertices:
        kd.insert(v.co, v.index)
    kd.balance()
    names = {g.index: g.name for g in src.vertex_groups}
    weights = [{names[g.group]: g.weight for g in v.groups if g.weight > 0} for v in src.data.vertices]
    groups = {}
    for v in dst.data.vertices:
        acc = {}
        for _co, idx, dist in kd.find_n(v.co, k):
            f = 1.0 / (dist + 1e-4)
            for n, w in weights[idx].items():
                acc[n] = acc.get(n, 0.0) + f * w
        total = sum(acc.values())
        for n, w in acc.items():
            if n not in groups:
                groups[n] = dst.vertex_groups.get(n) or dst.vertex_groups.new(name=n)
            groups[n].add([v.index], w / total, "REPLACE")


def bone_distance_weights(obj, rig, k=3, power=4.0):
    """Each vertex gets the k nearest deform bones (distance to the bone segment, rest pose), weighted 1/d^power.
    Coarser than heat weights (no volume awareness) but never fails; used only when heat fails everywhere."""
    bones = [b for b in rig.data.bones if b.use_deform]
    mw = rig.matrix_world
    heads = np.array([tuple(mw @ b.head_local) for b in bones])
    tails = np.array([tuple(mw @ b.tail_local) for b in bones])
    co = vertex_array(obj)
    seg = tails - heads                                            # (B, 3)
    rel = co[:, None, :] - heads[None, :, :]                       # (N, B, 3)
    t = np.clip((rel * seg[None]).sum(-1) / np.maximum((seg * seg).sum(-1), 1e-9)[None], 0.0, 1.0)
    d = np.linalg.norm(rel - t[..., None] * seg[None], axis=-1)    # (N, B)
    near = np.argsort(d, axis=1)[:, :k]
    w = 1.0 / (np.take_along_axis(d, near, axis=1) ** power + 1e-12)
    w /= w.sum(1, keepdims=True)
    obj.vertex_groups.clear()
    groups = [obj.vertex_groups.new(name=b.name) for b in bones]
    for i in range(len(co)):
        for j in range(k):
            groups[near[i, j]].add([i], float(w[i, j]), "REPLACE")


def parent_auto(obj, rig):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")


def weight(obj, rig):
    parent_auto(obj, rig)
    frac = unweighted_fraction(obj)
    method = "heat"
    if frac > UNWEIGHTED_MAX:
        log("heat weighting left %.1f%% unweighted; voxel proxy" % (frac * 100))
        method = "voxel_proxy"
        obj.parent = None
        for m in list(obj.modifiers):
            obj.modifiers.remove(m)
        obj.vertex_groups.clear()
        for size in VOXEL_TRIES:  # torn cloth and loose shards can still defeat heat at fine voxels; coarser fuses them
            proxy = obj.copy()
            proxy.data = obj.data.copy()
            bpy.context.scene.collection.objects.link(proxy)
            rm = proxy.modifiers.new("Remesh", "REMESH")
            rm.mode, rm.voxel_size, rm.use_smooth_shade = "VOXEL", size, False
            with bpy.context.temp_override(object=proxy, active_object=proxy):
                bpy.ops.object.modifier_apply(modifier=rm.name)
            parent_auto(proxy, rig)
            pfrac = unweighted_fraction(proxy)
            log("voxel proxy %.3f m: %.1f%% unweighted" % (size, pfrac * 100))
            if pfrac <= PROXY_UNWEIGHTED_MAX:
                break
            bpy.data.objects.remove(proxy)
        else:
            # wings, capes, loose shards: heat fails at every voxel size, so bind by distance to the bones instead
            log("no voxel proxy took heat weights; nearest-bone distance weights")
            method = "bone_distance"
            bone_distance_weights(obj, rig)
            proxy = None
        if proxy is not None:
            for b in rig.data.bones:
                if b.use_deform and b.name not in proxy.vertex_groups:
                    proxy.vertex_groups.new(name=b.name)
            transfer_weights(proxy, obj)
            bpy.data.objects.remove(proxy)
        obj.parent = rig
        arm_mod = obj.modifiers.new("Armature", "ARMATURE")
        arm_mod.object = rig
        frac = unweighted_fraction(obj)
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    with bpy.context.temp_override(object=obj, active_object=obj):
        bpy.ops.object.vertex_group_clean(group_select_mode="ALL", limit=0.001)
        bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
        bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
    return method, frac


# ---------------------------------------------------------------- export + validation

def render_weight_map(obj, path):
    """Front ortho view of the rest mesh coloured by each vertex's dominant bone (arm bones in warm colours)."""
    names = {vg.index: vg.name for vg in obj.vertex_groups}
    palette = {"upperarm_l": (1, 0.1, 0.1), "lowerarm_l": (1, 0.6, 0), "hand_l": (1, 1, 0),
               "upperarm_r": (0.8, 0, 0.8), "lowerarm_r": (1, 0.4, 0.7), "hand_r": (1, 0.85, 0.6),
               "spine_01": (0.1, 0.3, 0.9), "spine_02": (0.1, 0.5, 1), "spine_03": (0.2, 0.7, 1),
               "pelvis": (0.1, 0.8, 0.6), "thigh_l": (0.1, 0.7, 0.1), "thigh_r": (0.4, 0.9, 0.2),
               "calf_l": (0.1, 0.4, 0.1), "calf_r": (0.3, 0.5, 0.1), "neck_01": (0.6, 0.6, 0.6), "Head": (1, 1, 1),
               "clavicle_l": (0.5, 0.2, 0.2), "clavicle_r": (0.4, 0.2, 0.4)}
    attr = obj.data.color_attributes.new("dominant", "FLOAT_COLOR", "POINT")
    for v in obj.data.vertices:
        g = max(v.groups, key=lambda g: g.weight, default=None)
        c = palette.get(names.get(g.group), (0.3, 0.3, 0.3)) if g else (0, 0, 0)
        attr.data[v.index].color = (*c, 1.0)
    mat = bpy.data.materials.new("WeightMap")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    a, e, o = nt.nodes.new("ShaderNodeAttribute"), nt.nodes.new("ShaderNodeEmission"), nt.nodes.new("ShaderNodeOutputMaterial")
    a.attribute_name = "dominant"
    nt.links.new(a.outputs["Color"], e.inputs["Color"])
    nt.links.new(e.outputs["Emission"], o.inputs["Surface"])
    saved = [s.material for s in obj.material_slots]
    for slot in obj.material_slots:
        slot.material = mat
    if not obj.material_slots:
        obj.data.materials.append(mat)
    arm_mod = [m for m in obj.modifiers if m.type == "ARMATURE"]
    for m in arm_mod:
        m.show_render = False
    setup_render(VIEW_RES, 4, transparent=True)
    cam = camera("WeightCam", (0, -6, CAM_Z), (math.pi / 2, 0, 0), ortho=ORTHO)
    render(cam, path)
    bpy.data.objects.remove(cam)
    for slot, m in zip(obj.material_slots, saved):
        slot.material = m
    for m in arm_mod:
        m.show_render = True
    obj.data.color_attributes.remove(obj.data.color_attributes["dominant"])


def export_rig(obj, rig, path):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True,
                              export_animations=False, export_skins=True, export_def_bones=False,
                              export_influence_nb=4, export_all_influences=False, export_extras=True)


def rest_to_ual(obj, rig, ual_arm):
    """Make the rig's rest pose the UAL rest pose, so ual.glb clips play 1:1 by bone name in any runtime:
    pose every bone to its UAL rest world rotation, bake the skinned mesh in that pose (Armature modifier
    applied), apply the pose as the new rest, and re-skin with the same weights. → max rest deviation (deg)."""
    ad = ual_arm.animation_data
    if ad:
        ad.action = None
        for track in ad.nla_tracks:
            track.mute = True
    for pb in ual_arm.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    for pb in rig.pose.bones:
        c = pb.constraints.new("COPY_ROTATION")
        c.target, c.subtarget = ual_arm, pb.name
        c.target_space = c.owner_space = "WORLD"
    bpy.context.view_layer.update()
    mod = next(m for m in obj.modifiers if m.type == "ARMATURE")
    with bpy.context.temp_override(object=obj, active_object=obj):
        bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.select_all(action="SELECT")
    bpy.ops.pose.visual_transform_apply()
    for pb in rig.pose.bones:
        for c in list(pb.constraints):
            pb.constraints.remove(c)
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    obj.modifiers.new("Armature", "ARMATURE").object = rig
    worst = 0.0
    for b in rig.data.bones:
        q = b.matrix_local.to_quaternion().rotation_difference(ual_arm.data.bones[b.name].matrix_local.to_quaternion())
        worst = max(worst, math.degrees(q.angle if q.angle <= math.pi else 2 * math.pi - q.angle))
    return worst


def import_rigged(path, keep):
    """Drop everything but `keep` and load the exported file the way a runtime does."""
    for o in list(bpy.context.scene.objects):
        if o not in keep:
            bpy.data.objects.remove(o)
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=path, bone_heuristic="BLENDER")
    new = set(bpy.context.scene.objects) - before
    return next(o for o in new if o.type == "MESH"), next(o for o in new if o.type == "ARMATURE")


def play(arm, clip):
    """Assign the ual.glb clip to `arm` by name: rotations only differ from rest by the clip, as in glTF."""
    act = bpy.data.actions[clip]
    ad = arm.animation_data or arm.animation_data_create()
    for track in ad.nla_tracks:
        track.mute = True
    ad.action = act
    if hasattr(ad, "action_slot") and act.slots:
        ad.action_slot = act.slots[0]
    lo, hi = act.frame_range
    return int(round(lo)), int(round(hi))


def validation_stage(res, samples):
    setup_render(res, samples, transparent=False)
    scene = bpy.context.scene
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.05, 0.06, 0.08, 1.0)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    scene.collection.objects.link(sun)
    bpy.ops.mesh.primitive_plane_add(size=8)
    floor = bpy.context.active_object
    mat = bpy.data.materials.new("Floor")
    mat.diffuse_color = (0.2, 0.2, 0.22, 1)
    floor.data.materials.append(mat)
    cam = camera("Preview", (2.3, -3.9, 1.15), (0, 0, 0), lens=70)
    target = bpy.data.objects.new("Target", None)
    target.location = (0, 0, 0.88)
    scene.collection.objects.link(target)
    c = cam.constraints.new("TRACK_TO")
    c.target, c.track_axis, c.up_axis = target, "TRACK_NEGATIVE_Z", "UP_Y"
    scene.camera = cam
    return cam


def render_clip(arm, clip, frames, pattern):
    lo, hi = play(arm, clip)
    picks = list(range(lo, hi)) if frames is None else [lo + round(i * (hi - lo) / frames) for i in range(frames)]
    scene = bpy.context.scene
    for i, f in enumerate(picks, 1):
        scene.frame_set(f)
        scene.render.filepath = pattern % i
        bpy.ops.render.render(write_still=True)
    return len(picks)


# ---------------------------------------------------------------- main

def main():
    args = parse_args()
    t0 = time.time()
    timings = {}
    os.makedirs(os.path.join(args.out, "views"), exist_ok=True)
    obj, cleanup = import_character(args.glb, args.meshclean)
    vol = Volume(obj)
    paths = render_views(args.out)
    pose = run_pose(args.pose_cmd, args.out, paths)
    method, reason, how, yaw = "rtmpose", "", {}, 0.0
    joints = None
    if pose:
        joints, how = detected_joints(pose, vol)
        yaw = facing_yaw(joints) if joints else 0.0
        if abs(yaw) > YAW_FIX:  # Hunyuan meshes come out turned a little; square them up and look again
            log("turning the mesh %.1f deg to face the front camera" % math.degrees(-yaw))
            obj.data.transform(Matrix.Rotation(-yaw, 4, "Z"))
            obj.data.update()
            vol = Volume(obj)
            paths = render_views(args.out)
            pose = run_pose(args.pose_cmd, args.out, paths)
            joints, how = detected_joints(pose, vol) if pose else (None, "pose estimator failed")
        if joints is None:
            reason = how
    else:
        reason = "no pose estimator" if not args.pose_cmd else "pose estimator failed"
    if reason.startswith(PARTIAL):
        with open(os.path.join(args.out, "meta.json"), "w") as f:
            json.dump({"method": "refused", "fallbackReason": reason}, f)
        log(reason)
        sys.exit(PARTIAL_EXIT)
    if joints is None:
        log("detection unusable (%s): proportional fallback" % reason)
        method = "proportions"
        joints, how = proportional_joints(obj, vol)
        if leg_imbalance(joints) > LEG_IMBALANCE_MAX:  # a knee in a tail or a coat: every clip would bend it there
            reason = "%s (%.0f%%) after %s" % (UNEVEN, 100 * leg_imbalance(joints), reason)
            with open(os.path.join(args.out, "meta.json"), "w") as f:
                json.dump({"method": "refused", "fallbackReason": reason}, f)
            log(reason)
            sys.exit(PARTIAL_EXIT)
    log("joints by %s" % method)
    timings["joints"] = round(time.time() - t0, 1)

    bones = json.load(open(args.bones))
    clips = json.load(open(args.clips))
    bpy.ops.import_scene.gltf(filepath=args.ual, bone_heuristic="BLENDER")
    ual_arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    t1 = time.time()
    rig = build_rig(ual_arm, joints, vol, set(bones["deformExcluded"]))
    wmethod, unweighted = weight(obj, rig)
    rest_dev = rest_to_ual(obj, rig, ual_arm)
    log("rest pose = UAL rest (max bone deviation %.3f deg)" % rest_dev)
    timings["rig_weights"] = round(time.time() - t1, 1)
    rigged = os.path.join(args.out, "rigged.glb")
    export_rig(obj, rig, rigged)
    meta = {"method": method, "fallbackReason": reason, "yawFixDeg": round(math.degrees(-yaw), 1), "snap": how,
            "cleanup": cleanup,
            "weights": wmethod, "unweightedFraction": round(unweighted, 5), "vertices": len(obj.data.vertices),
            "ualHipsScale": rig["ualHipsScale"], "restDeviationDeg": round(rest_dev, 4),
            "joints": {k: [round(c, 4) for c in v] for k, v in joints.items()},
            "bones": {b.name: [round(c, 4) for c in b.head_local] for b in rig.data.bones if b.use_deform},
            }  # no closing double brace: OpenJD would read it as a template expression
    if not args.no_validate:
        t2 = time.time()
        os.makedirs(os.path.join(args.out, "frames"), exist_ok=True)
        obj, rig = import_rigged(rigged, keep={ual_arm})  # validate the exported file, not the working scene
        render_weight_map(obj, os.path.join(args.out, "frames", "weights.png"))
        validation_stage(args.res, args.samples)
        meta["runFrames"] = render_clip(rig, clips["run"], None, os.path.join(args.out, "frames", "run_%04d.png"))
        meta["attackFrames"] = render_clip(rig, clips["attack_melee"], 6,
                                           os.path.join(args.out, "frames", "attack_%02d.png"))
        timings["validation"] = round(time.time() - t2, 1)
    timings["total"] = round(time.time() - t0, 1)
    meta["seconds"] = timings
    with open(os.path.join(args.out, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    log("done %s" % json.dumps({k: meta[k] for k in ("method", "weights", "unweightedFraction", "seconds")}))


main()
