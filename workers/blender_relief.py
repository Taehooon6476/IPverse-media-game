"""Silhouette relief turntable: cutout PNG -> extruded relief mesh -> Cycles frames + GLB.
GLB mode (--glb instead of --image): import a mesh (e.g. Hunyuan3D-2.1 output), fit it to the same stage,
render the same turntable; no model.glb is written (the input is the model).

blender -b --factory-startup -noaudio --python-exit-code 1 --python workers/blender_relief.py -- \
  --image IN.png --out OUTDIR --frames 72 --width 1280 --height 720 --samples 24 --thickness 0.12 --accent "#5de6cf"

Writes OUTDIR/frames/0001.png ... OUTDIR/poster.png (copy of frame 1), OUTDIR/model.glb (relief only), OUTDIR/meta.json.
Blender 4.2+ and 5.x: bpy/bmesh/mathutils/numpy only, Cycles on CPU, no compositor, no add-ons.
"""
import argparse
import json
import math
import os
import shutil
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

MAX_CELLS = 96  # mesh grid cells along the longer image side
SMOOTH_PASSES = 8  # outline smoothing (vertex averaging, factor 0.5)
SIZE = 2.0  # longer side of the relief, Blender units
WORLD_COLOR = "#0b0d12"
GROUND_COLOR = "#101218"


def parse_args():
    def hex_color(text):
        digits = text.lstrip("#")
        if len(digits) != 6 or any(c not in "0123456789abcdefABCDEF" for c in digits):
            raise argparse.ArgumentTypeError("expected #rrggbb, got %r" % text)
        return text

    p = argparse.ArgumentParser(prog="blender_relief.py")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--image", help="cutout PNG with alpha -> relief")
    src.add_argument("--glb", help="GLB mesh to import and turn (front = glTF +Z, Y up)")
    p.add_argument("--out", required=True, help="output directory")
    p.add_argument("--frames", type=int, default=72)
    p.add_argument("--width", type=int, default=1280)
    p.add_argument("--height", type=int, default=720)
    p.add_argument("--samples", type=int, default=24)
    p.add_argument("--thickness", type=float, default=0.12, help="relief depth as a fraction of its height")
    p.add_argument("--accent", type=hex_color, default="#5de6cf", help="side (rim) color")
    return p.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])


def linear_rgba(hex_color):
    """sRGB hex -> linear RGBA, the space shader color sockets expect."""
    digits = hex_color.lstrip("#")
    srgb = [int(digits[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb) + (1.0,)


def coverage_grid(image):
    """Bool grid (rows x cols, row 0 = image bottom): cell is set when >= half its pixels have alpha >= 0.5."""
    w, h = image.size
    px = np.empty(w * h * 4, dtype=np.float32)
    image.pixels.foreach_get(px)
    mask = (px[3::4] >= 0.5).reshape(h, w).astype(np.float32)
    cell = max(1.0, max(w, h) / MAX_CELLS)
    cols, rows = max(1, round(w / cell)), max(1, round(h / cell))
    ys, xs = np.arange(rows) * h // rows, np.arange(cols) * w // cols
    sums = np.add.reduceat(np.add.reduceat(mask, ys, axis=0), xs, axis=1)
    counts = np.outer(np.diff(np.append(ys, h)), np.diff(np.append(xs, w)))
    return sums / counts >= 0.5


def node_material(name):
    """Material with a fresh Principled BSDF -> Output tree (works on 4.2, where new materials have no nodes, and 5.x)."""
    mat = bpy.data.materials.new(name)
    if mat.node_tree is None:
        mat.use_nodes = True
    tree = mat.node_tree
    tree.nodes.clear()
    bsdf = tree.nodes.new("ShaderNodeBsdfPrincipled")
    tree.links.new(bsdf.outputs["BSDF"], tree.nodes.new("ShaderNodeOutputMaterial").inputs["Surface"])
    return mat, bsdf


def build_relief(covered, image, thickness, accent):
    """One quad per covered cell in the XZ plane, front facing -Y (glTF +Z), centered on the origin."""
    rows, cols = covered.shape
    bm = bmesh.new()
    for j, i in np.argwhere(covered).tolist():  # grid units: 1 = one cell
        corners = ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))  # this winding gives normal -Y
        bm.faces.new([bm.verts.new((a, 0.0, b)) for a, b in corners])
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-3)
    # Edges only: interior edges merge into flat ngons; boundary vertices stay one cell apart, so
    # smoothing rounds the staircase outline without shrinking long straight runs.
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(5), verts=[], edges=bm.edges[:])
    # Smoothing happens here, not in a Smooth modifier: UVs are computed from the smoothed positions
    # below, so the texture stays undistorted (a modifier moves vertices but not their UVs, which
    # warps the image across the big ngons). 2 passes leave visible stairs at 1280x720; 8 do not.
    for _ in range(SMOOTH_PASSES):
        bmesh.ops.smooth_vert(bm, verts=bm.verts, factor=0.5, use_axis_x=True, use_axis_z=True)
    uv = bm.loops.layers.uv.new("UVMap")
    for face in bm.faces:
        face.smooth = True
        for loop in face.loops:
            loop[uv].uv = (loop.vert.co.x / cols, loop.vert.co.z / rows)
    xs, zs = [v.co.x for v in bm.verts], [v.co.z for v in bm.verts]
    scale = SIZE / max(max(xs) - min(xs), max(zs) - min(zs))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(-(max(xs) + min(xs)) / 2, 0.0, -(max(zs) + min(zs)) / 2))
    bmesh.ops.scale(bm, verts=bm.verts, vec=(scale, scale, scale))
    width, height = (max(xs) - min(xs)) * scale, (max(zs) - min(zs)) * scale
    mesh = bpy.data.meshes.new("Relief")
    bm.to_mesh(mesh)
    bm.free()

    front, bsdf = node_material("Relief Front")
    tex = front.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image, tex.extension = image, "EXTEND"
    front.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.55
    side, bsdf = node_material("Relief Side")
    bsdf.inputs["Base Color"].default_value = linear_rgba(accent)
    bsdf.inputs["Roughness"].default_value = 0.35
    mesh.materials.append(front)
    mesh.materials.append(side)

    obj = bpy.data.objects.new("Relief", mesh)
    bpy.context.scene.collection.objects.link(obj)
    solid = obj.modifiers.new("Solidify", "SOLIDIFY")
    solid.thickness, solid.offset = thickness * height, 0.0
    solid.material_offset_rim = 1  # rim (side) faces -> accent; front/back shells keep the image
    bevel = obj.modifiers.new("Bevel", "BEVEL")
    bevel.width, bevel.segments = 0.15 * thickness * height, 2
    bevel.limit_method, bevel.angle_limit = "ANGLE", math.radians(60)
    bevel.harden_normals = True  # flat front/back despite smooth shading on the big ngons
    return obj, width, height


def import_glb(path):
    """Import a GLB under one empty, scaled so its longest side is SIZE and centered on the origin.
    Returns (pivot, width, depth, height, verts, faces); spin the pivot for the turntable."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.abspath(path))
    imported = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in imported if o.type == "MESH"]
    if not meshes:
        sys.exit("blender_relief: no mesh in %s" % path)
    bpy.context.view_layer.update()
    pts = np.array([tuple(o.matrix_world @ Vector(c)) for o in meshes for c in o.bound_box])
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    size = hi - lo
    scale = SIZE / max(float(size.max()), 1e-6)
    model = bpy.data.objects.new("Model", None)  # imported roots -> Model (fit) -> Pivot (spin)
    bpy.context.scene.collection.objects.link(model)
    for o in imported:
        if o.parent is None:
            o.parent = model
    model.scale = (scale,) * 3
    model.location = tuple(-c * scale for c in (lo + hi) / 2)
    pivot = bpy.data.objects.new("Pivot", None)
    bpy.context.scene.collection.objects.link(pivot)
    model.parent = pivot
    deps = bpy.context.evaluated_depsgraph_get()
    verts = faces = 0
    for o in meshes:
        ev = o.evaluated_get(deps)
        m = ev.to_mesh()
        verts, faces = verts + len(m.vertices), faces + len(m.polygons)
        ev.to_mesh_clear()
    w, d, h = (size * scale).tolist()
    return pivot, w, d, h, verts, faces


def look_at(obj, target=(0.0, 0.0, 0.0)):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def add_object(name, data, location):
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    look_at(obj)
    return obj


def build_stage(scene, width, depth, height, character=False):
    world = bpy.data.worlds.new("World")
    if world.node_tree is None:
        world.use_nodes = True
    world.node_tree.nodes.clear()
    bg = world.node_tree.nodes.new("ShaderNodeBackground")
    bg.inputs["Color"].default_value = linear_rgba(WORLD_COLOR)
    world.node_tree.links.new(bg.outputs["Background"], world.node_tree.nodes.new("ShaderNodeOutputWorld").inputs["Surface"])
    scene.world = world

    r, z = 400.0, -height / 2  # far enough that the low character camera never sees its edge
    ground = bpy.data.meshes.new("Ground")
    ground.from_pydata([(-r, -r, z), (r, -r, z), (r, r, z), (-r, r, z)], [], [(0, 1, 2, 3)])
    mat, bsdf = node_material("Ground")
    bsdf.inputs["Base Color"].default_value = linear_rgba(GROUND_COLOR)
    bsdf.inputs["Roughness"].default_value = 0.45
    ground.materials.append(mat)
    scene.collection.objects.link(bpy.data.objects.new("Ground", ground))

    for name, loc, energy, size in (("Key", (-3.0, -3.5, 3.0), 250, 2.5),
                                    ("Fill", (3.5, -2.5, 0.8), 60, 3.0),
                                    ("Rim", (1.5, 4.0, 3.0), 300, 2.0)):
        light = bpy.data.lights.new(name, "AREA")
        light.energy, light.size = energy, size
        add_object(name, light, loc)

    # Fit the bounding sphere of the spinning relief into the narrower field of view.
    cam = bpy.data.cameras.new("Camera")
    cam.angle = math.radians(35)
    res = (scene.render.resolution_x, scene.render.resolution_y)
    half_fov = math.atan(math.tan(cam.angle / 2) * min(res) / max(res))
    radius = math.sqrt((width / 2) ** 2 + (depth / 2) ** 2 + (height / 2) ** 2)
    dist = 1.03 * radius / math.sin(half_fov)
    if character:  # an upright mesh: fit its height and spin radius separately, camera near eye level
        spin = math.sqrt((width / 2) ** 2 + (depth / 2) ** 2)
        wide_fov = cam.angle / 2
        dist = 1.1 * max(height / 2 / math.tan(half_fov), spin / math.tan(wide_fov)) + spin
    # 35 deg above the floor, from the Blender front view (-Y) so the GLB front is glTF +Z; 10 deg off-axis.
    elev, azim = math.radians(12 if character else 35), math.radians(-10)
    flat = dist * math.cos(elev)
    scene.camera = add_object("Camera", cam, (flat * math.sin(azim), -flat * math.cos(azim), dist * math.sin(elev)))


def setup_render(scene, args):
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
    if hasattr(scene.cycles, "denoising_use_gpu"):  # 4.1+
        scene.cycles.denoising_use_gpu = False
    scene.render.use_motion_blur = False
    scene.render.resolution_x, scene.render.resolution_y = args.width, args.height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.view_settings.view_transform = "Standard"  # keep the cutout's colors as generated


def main():
    args = parse_args()
    out = os.path.abspath(args.out)
    frames_dir = os.path.join(out, "frames")
    os.makedirs(frames_dir, exist_ok=True)

    for obj in list(bpy.data.objects):  # factory scene: cube, camera, light
        bpy.data.objects.remove(obj, do_unlink=True)
    scene = bpy.context.scene
    setup_render(scene, args)

    if args.glb:
        relief, width, depth, height, verts, faces = import_glb(args.glb)
        build_stage(scene, width, depth, height, character=True)
    else:
        image = bpy.data.images.load(os.path.abspath(args.image))
        covered = coverage_grid(image)
        if not covered.any():
            sys.exit("blender_relief: no pixels with alpha >= 0.5 in %s (empty cutout)" % args.image)
        relief, width, height = build_relief(covered, image, args.thickness, args.accent)
        build_stage(scene, width, args.thickness * height, height)

        for obj in scene.objects:
            obj.select_set(obj == relief)
        bpy.context.view_layer.objects.active = relief
        bpy.ops.export_scene.gltf(filepath=os.path.join(out, "model.glb"), export_format="GLB",
                                  use_selection=True, export_apply=True)

        evaluated = relief.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh = evaluated.to_mesh()
        verts, faces = len(mesh.vertices), len(mesh.polygons)
        evaluated.to_mesh_clear()
    meta = {"frames": args.frames, "width": args.width, "height": args.height, "verts": verts, "faces": faces,
            "mode": "glb" if args.glb else "relief"}

    for i in range(args.frames):  # turntable: frame 1 faces the camera
        relief.rotation_euler.z = 2 * math.pi * i / args.frames
        scene.render.filepath = os.path.join(frames_dir, "%04d.png" % (i + 1))
        bpy.ops.render.render(write_still=True)
    shutil.copyfile(os.path.join(frames_dir, "0001.png"), os.path.join(out, "poster.png"))
    with open(os.path.join(out, "meta.json"), "w") as f:
        json.dump(meta, f)
    print("blender_relief: wrote %s %s" % (out, json.dumps(meta)))


if __name__ == "__main__":
    main()
