"""Build ual.glb: the UAL 1 + 2 clips named in ual_clips.json on the bare UAL skeleton (no mesh), 30 fps.

blender -b --factory-startup -noaudio --python-exit-code 1 --python workers/rig/export_ual.py -- \
  --ual1 ".../UAL1_Standard.glb" --ual2 ".../UAL2_Standard.glb" --clips workers/rig/ual_clips.json --out ual.glb

Inputs are the Quaternius "[Standard]" Unreal-Godot GLBs without root motion (CC0). Clips are sampled on every
frame at 30 fps; glbtools.trim_animations then keeps rotations on every joint plus the pelvis translation (hip
bob, crouch, death fall) and drops the rest, so the clips keep a rigged character's own bone lengths. Runtimes scale the pelvis translation by
the rig's `ualHipsScale` extra (see docs/rig-contract.md).
"""
import argparse
import json
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import glbtools  # noqa: E402

FPS = 30


def parse_args():
    p = argparse.ArgumentParser(prog="export_ual.py")
    p.add_argument("--ual1", required=True)
    p.add_argument("--ual2", required=True)
    p.add_argument("--clips", required=True, help="ual_clips.json {role: clipName}")
    p.add_argument("--out", required=True)
    return p.parse_args(sys.argv[sys.argv.index("--") + 1:])


def main():
    args = parse_args()
    wanted = set(json.load(open(args.clips)).values())
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps, scene.render.fps_base = FPS, 1.0  # the importer converts seconds to frames at this rate

    keep_arm, found = None, {}
    for path in (args.ual1, args.ual2):
        before = set(bpy.data.actions)
        bpy.ops.import_scene.gltf(filepath=path, bone_heuristic="BLENDER")
        arm = next(o for o in bpy.context.selected_objects if o.type == "ARMATURE")
        for act in set(bpy.data.actions) - before:
            name = act.name.split(".")[0]
            if name in wanted and name not in found:
                found[name] = act
        if keep_arm is None:
            keep_arm = arm
        else:
            bpy.data.objects.remove(arm)
    missing = wanted - set(found)
    if missing:
        sys.exit("export_ual: clips not in UAL1/UAL2: %s" % sorted(missing))
    for o in list(bpy.data.objects):
        if o is not keep_arm:
            bpy.data.objects.remove(o)
    keep_arm.name = keep_arm.data.name = "UAL"

    ad = keep_arm.animation_data or keep_arm.animation_data_create()
    ad.action = None
    for track in list(ad.nla_tracks):  # the importer puts every imported clip on its own track
        ad.nla_tracks.remove(track)
    for name in sorted(found):
        act = found[name]
        act.name = name
        track = ad.nla_tracks.new()
        track.name = name
        start = int(act.frame_range[0])
        strip = track.strips.new(name, start, act)
        if hasattr(strip, "action_slot") and act.slots:
            strip.action_slot = act.slots[0]
        track.mute = True
    for act in list(bpy.data.actions):
        if act.name not in found:
            bpy.data.actions.remove(act)

    bpy.ops.object.select_all(action="DESELECT")
    keep_arm.select_set(True)
    raw = args.out + ".raw.glb"
    bpy.ops.export_scene.gltf(filepath=raw, export_format="GLB", use_selection=True, export_yup=True,
                              export_animations=True, export_animation_mode="NLA_TRACKS",
                              export_force_sampling=True, export_frame_step=1, export_optimize_animation_size=False,
                              export_def_bones=False, export_skins=True, export_morph=False, export_materials="NONE")
    glbtools.write_glb(args.out, *glbtools.trim_animations(*glbtools.read_glb(raw)))
    os.remove(raw)
    print("export_ual: wrote %s with %d clips" % (args.out, len(found)))


main()
