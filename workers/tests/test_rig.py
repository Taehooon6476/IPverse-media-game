"""workers/rig: pose decoding, GLB trimming, the OpenJD template, and ual.glb against the JSON contract."""
import json
import struct
import sys
from pathlib import Path

import pytest

RIG = Path(__file__).resolve().parents[1] / "rig"
sys.path.insert(0, str(RIG))

import glbtools  # noqa: E402
from workers.template_loader import load_rig_template  # noqa: E402

np = pytest.importorskip("numpy")


def test_pose_crop_keeps_model_aspect_and_decodes_back_to_pixels():
    pose2d = pytest.importorskip("pose2d")
    cx, cy, w, h = pose2d.crop_region([100, 50, 300, 450])  # 200 x 400 figure
    assert (cx, cy) == (200, 250) and h == 500 and w == pytest.approx(500 * 192 / 256)
    simcc_x, simcc_y = np.zeros((1, 17, 384)), np.zeros((1, 17, 512))
    simcc_x[0, :, 192], simcc_y[0, :, 256] = 0.9, 0.8  # centre of the crop
    simcc_x[0, 5, 0] = 1.0  # left shoulder at the crop's left edge
    kps = pose2d.decode(simcc_x, simcc_y, (cx, cy, w, h))
    assert kps[0] == pytest.approx([200, 250, 0.8])
    assert kps[5][0] == pytest.approx(cx - w / 2)


def _glb(nodes, animations, accessors, views, binary):
    return {"asset": {"version": "2.0"}, "nodes": nodes, "animations": animations, "accessors": accessors,
            "bufferViews": views, "buffers": [{"byteLength": len(binary)}]}, binary


def test_trim_keeps_rotations_and_pelvis_translation_and_repacks(tmp_path):
    times, rot, loc = struct.pack("<2f", 0, 1), struct.pack("<8f", *[0, 0, 0, 1] * 2), struct.pack("<6f", *[0] * 6)
    binary = times + rot + loc + loc
    views = [{"buffer": 0, "byteOffset": 0, "byteLength": 8}, {"buffer": 0, "byteOffset": 8, "byteLength": 32},
             {"buffer": 0, "byteOffset": 40, "byteLength": 24}, {"buffer": 0, "byteOffset": 64, "byteLength": 24}]
    acc = [{"bufferView": i, "componentType": 5126, "count": 2, "type": t}
           for i, t in enumerate(("SCALAR", "VEC4", "VEC3", "VEC3"))]
    acc[0].update(min=[0], max=[1])
    anim = {"name": "Run", "samplers": [{"input": 0, "output": o} for o in (1, 2, 3, 2)],
            "channels": [{"sampler": 0, "target": {"node": 1, "path": "rotation"}},
                         {"sampler": 1, "target": {"node": 0, "path": "translation"}},
                         {"sampler": 2, "target": {"node": 1, "path": "translation"}},
                         {"sampler": 3, "target": {"node": 1, "path": "scale"}}]}
    gltf, binary = _glb([{"name": "pelvis"}, {"name": "calf_l"}], [anim], acc, views, binary)
    path = tmp_path / "t.glb"
    glbtools.write_glb(path, *glbtools.trim_animations(gltf, binary))
    s = glbtools.summary(path)
    assert s["animations"]["Run"] == {"channels": {"rotation": 1, "translation": 1}, "translated": ["pelvis"],
                                      "keys": 2, "seconds": 1.0}
    g, b = glbtools.read_glb(path)
    assert len(g["accessors"]) == 3 and len(b) == 8 + 32 + 24  # the dropped track's data is gone
    assert struct.unpack_from("<8f", b, g["bufferViews"][g["accessors"][1]["bufferView"]]["byteOffset"])[3] == 1


def test_rig_template_embeds_every_worker_file_without_openjd_braces():
    t = load_rig_template()
    files = {f["name"]: f["data"] for f in t["steps"][0]["script"]["embeddedFiles"]}
    assert set(files) == {"Run", "Rig", "Pose", "Sheet", "Bones", "Clips", "Clean"}
    assert files["Rig"] == (RIG / "blender_rig.py").read_text()
    assert files["Clean"] == (RIG.parent / "img3d" / "meshclean.py").read_text()  # the slab cleanup the GPU box runs
    assert json.loads(files["Clips"]) == json.loads((RIG / "ual_clips.json").read_text())
    args = t["steps"][0]["script"]["actions"]["onRun"]["args"]
    assert args[0] == "{{Task.File.Run}}" and "{{Task.File.Clips}}" in args
    assert args[-1] == "{{Task.File.Clean}}"  # run_rig.py reads it as its 12th argument
    compile(files["Run"], "Run", "exec")
    assert "--meshclean" in files["Run"] and "sys.argv[1:13]" in files["Run"]
    params = {p["name"] for p in t["parameterDefinitions"]}
    assert {"InputUri", "AnimUri", "PoseModelUri", "OutputPrefix"} <= params
    assert "onnxruntime" in next(p["default"] for p in t["parameterDefinitions"] if p["name"] == "CondaPackages")


def test_ual_glb_matches_the_bone_and_clip_contract():
    bones = json.loads((RIG / "ual_bones.json").read_text())
    clips = json.loads((RIG / "ual_clips.json").read_text())
    s = glbtools.summary(RIG / "ual.glb")
    assert s["meshes"] == 0 and s["skins"] == [bones["count"]] == [65]
    g, _ = glbtools.read_glb(RIG / "ual.glb")
    assert {b["name"] for b in bones["bones"]} <= {n.get("name") for n in g["nodes"]}
    required = {"idle", "walk", "run", "sprint", "jump", "fall", "land", "attack_melee", "attack_gun", "hit", "death",
                "interact", "zombie_walk", "zombie_attack"}
    assert required <= set(clips) and set(clips.values()) == set(s["animations"])
    for name, a in s["animations"].items():
        assert a["channels"] == {"rotation": 65, "translation": 1} and a["translated"] == ["pelvis"], name
        assert a["keys"] == round(a["seconds"] * 30) + 1, name  # sampled at 30 fps


def _rig_function(*names):
    """Functions (and the module constants) from blender_rig.py, which imports bpy and cannot be imported here."""
    import ast
    tree = ast.parse((RIG / "blender_rig.py").read_text())
    keep = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names
            or isinstance(n, ast.Assign) and all(isinstance(t, ast.Name) and t.id.isupper() for t in n.targets)
            and not isinstance(n.value, ast.Call)]
    scope = {"math": __import__("math"), "Vector": _V, "log": lambda msg: None}
    exec(compile(ast.Module(body=keep, type_ignores=[]), "blender_rig.py", "exec"), scope)  # noqa: S102 - our own file
    return scope


class _V:
    """The bits of mathutils.Vector the joint functions use."""
    def __init__(self, *c):
        self.c = tuple(c[0]) if len(c) == 1 else c  # Vector((x, y, z)) and _V(x, y, z)

    def __sub__(self, o):
        return _V(*(a - b for a, b in zip(self.c, o.c)))

    def __add__(self, o):
        return _V(*(a + b for a, b in zip(self.c, o.c)))

    def __mul__(self, k):
        return _V(*(a * k for a in self.c))

    def dot(self, o):
        return sum(a * b for a, b in zip(self.c, o.c))

    x, y, z = (property(lambda self, i=i: self.c[i]) for i in range(3))

    @property
    def length(self):
        return sum(a * a for a in self.c) ** .5


def test_a_knee_read_in_the_tail_is_refused_and_sound_legs_pass():
    """A knee placed in a tail (proportional fallback) left the right leg 1.28 m of bone and the left 0.92 m: blender_rig.py
    refuses such a rig with "legs of uneven length". Joints in Blender space, z up."""
    scope = _rig_function("leg_imbalance")
    fox = {"hip_l": (0.09, -0.3598, 0.891), "knee_l": (0.1468, -0.5904, 0.522), "ankle_l": (0.1618, -0.3533, 0.1026),
           "hip_r": (-0.09, -0.3646, 0.891), "knee_r": (-0.316, 0.1015, 0.522), "ankle_r": (-0.1465, -0.3578, 0.1026)}
    sound = {"hip_l": (0.1265, 0.098, 0.9098), "knee_l": (0.1265, 0.1009, 0.494), "ankle_l": (0.1265, 0.1327, 0.0987),
             "hip_r": (-0.0983, 0.0737, 0.9126), "knee_r": (-0.0983, 0.0766, 0.5022), "ankle_r": (-0.0983, 0.1101, 0.0847)}
    imbalance = scope["leg_imbalance"]
    assert imbalance({k: _V(*v) for k, v in fox.items()}) > scope["LEG_IMBALANCE_MAX"]
    assert imbalance({k: _V(*v) for k, v in sound.items()}) < .05
    ualclips = (RIG.parents[1] / "game3d" / "ualclips.js").read_text()  # the runtime drops such a rig at the same limit
    assert f"LEG_IMBALANCE_MAX = {scope['LEG_IMBALANCE_MAX']}" in ualclips


class _Vol:
    """A Volume stand-in: every ray hits, limbs are already centred."""
    def snap(self, x, z, expected=None):
        return _V(x, expected or 0.0, z), "ray"

    def centre_across(self, p):
        return p


def _joints(d):
    return {k: _V(*v) for k, v in d.items()}


def _repair():
    return _rig_function("repair_legs", "leg_outside", "leg_imbalance", "symmetry_x")


# a fox character as the proportional fallback placed it: right knee in her tail
FOX_PROPORTIONS = {"hip_l": (0.09, -0.3598, 0.891), "knee_l": (0.1468, -0.5904, 0.522),
                   "ankle_l": (0.1618, -0.3533, 0.1026), "hip_r": (-0.09, -0.3646, 0.891),
                   "knee_r": (-0.316, 0.1015, 0.522), "ankle_r": (-0.1465, -0.3578, 0.1026),
                   "shoulder_l": (0.153, -0.3742, 1.524), "shoulder_r": (-0.153, -0.3459, 1.524)}


def test_a_knee_in_the_tail_leaves_the_leg_volume_and_the_sound_leg_is_mirrored():
    scope = _repair()
    j = _joints(FOX_PROPORTIONS)
    assert scope["leg_outside"](j, "r") and scope["leg_imbalance"](j) > scope["LEG_IMBALANCE_MAX"]
    how = {}
    scope["repair_legs"](j, how, _Vol())
    side = next(iter(how))[-1]
    good = "l" if side == "r" else "r"
    assert how == {"knee_" + side: "mirror", "ankle_" + side: "mirror"}
    assert scope["leg_imbalance"](j) < .05
    assert j["knee_" + side].x == pytest.approx(-j["knee_" + good].x, abs=.02)  # across the hips' midline
    assert j["knee_" + side].y == pytest.approx(j["knee_" + good].y)  # depth kept


def test_an_ankle_snapped_into_a_cape_is_mirrored_from_the_other_leg():
    """A cloaked figure (RTMPose): the front view read both legs right, but ankle_l's depth landed on the back of the
    cloak, 0.7 m behind its hip."""
    scope = _repair()
    j = _joints({"hip_l": (0.0781, -0.4453, 0.9375), "hip_r": (-0.1237, -0.453, 0.944),
                 "knee_l": (0.1319, -0.4209, 0.5404), "knee_r": (-0.1445, -0.3898, 0.5339),
                 "ankle_l": (0.0322, 0.2529, 0.1432), "ankle_r": (-0.1196, -0.3194, 0.1497),
                 "shoulder_l": (0.12, -0.4, 1.42), "shoulder_r": (-0.2, -0.4, 1.42)})
    assert not scope["leg_outside"](j, "l") and not scope["leg_outside"](j, "r")  # each leg alone looks fine
    how = {}
    assert "ankle 0.57 m deeper" in scope["repair_legs"](j, how, _Vol())
    assert set(how) == {"knee_l", "ankle_l"} and scope["leg_imbalance"](j) < .05
    assert j["ankle_l"].y == pytest.approx(-0.3194)


def test_sound_legs_are_left_alone():
    scope = _repair()
    j = _joints({"hip_l": (0.1265, 0.098, 0.9098), "knee_l": (0.1265, 0.1009, 0.494),
                 "ankle_l": (0.1265, 0.1327, 0.0987), "hip_r": (-0.0983, 0.0737, 0.9126),
                 "knee_r": (-0.0983, 0.0766, 0.5022), "ankle_r": (-0.0983, 0.1101, 0.0847),
                 "shoulder_l": (0.2, 0.1, 1.45), "shoulder_r": (-0.2, 0.1, 1.45)})
    before = {k: v.c for k, v in j.items()}
    how = {}
    assert scope["repair_legs"](j, how, _Vol()) == "" and how == {}
    assert {k: v.c for k, v in j.items()} == before


def test_a_weak_keypoint_takes_its_partners_mirror_image():
    """Every joint sound but wrist_l (score 0.299, behind a bag): it is mirrored across the hips' and shoulders'
    midline instead of throwing the whole detection away."""
    scope = _rig_function("mirror_weak", "partner")
    flat = {"shoulder_l": (0.16, 1.07), "shoulder_r": (-0.19, 1.07), "hip_l": (0.12, 0.6), "hip_r": (-0.14, 0.6),
            "wrist_l": (0.9, 0.2), "wrist_r": (-0.45, 0.82)}
    out, mirrored = scope["mirror_weak"](flat, ["wrist_l"])
    assert mirrored == {"wrist_l"}
    assert out["wrist_l"] == pytest.approx((2 * -0.0125 + 0.45, 0.82))
    assert scope["mirror_weak"](flat, ["wrist_l", "wrist_r"])[1] is None  # both sides weak: proportions
    assert scope["mirror_weak"](flat, ["wrist_l", "elbow_l", "knee_l", "ankle_r"])[1] is None  # too much is weak
    assert scope["mirror_weak"](flat, []) == (flat, set())


def test_chibi_proportions_are_plausible_and_a_squashed_torso_is_not():
    """A chibi body (shoulders at 60 % of the height, hips at 33 %) passes the plausibility ranges instead of falling
    back to proportions, which would put the shoulders in the head."""
    scope = _rig_function("implausible", "leg_imbalance")
    fox = {"shoulder_l": (0.1588, -0.3677, 1.072), "shoulder_r": (-0.1896, -0.3593, 1.0411),
           "elbow_l": (0.3175, -0.3391, 0.9353), "elbow_r": (-0.3131, -0.3765, 0.9265),
           "wrist_l": (0.4388, -0.3591, 0.8206), "wrist_r": (-0.4542, -0.4189, 0.8206),
           "hip_l": (0.1235, -0.3512, 0.6001), "hip_r": (-0.1235, -0.3652, 0.5913),
           "knee_l": (0.1499, -0.3607, 0.3664), "knee_r": (-0.1455, -0.3683, 0.3796),
           "ankle_l": (0.1591, -0.3334, 0.1106), "ankle_r": (-0.1452, -0.3212, 0.1239)}
    j = _joints(fox)
    assert scope["implausible"](j) == ""
    squashed = dict(j, hip_l=_V(0.12, -0.35, 0.98), hip_r=_V(-0.12, -0.36, 0.98))  # hips 9 cm under the shoulders
    assert scope["implausible"](squashed) == "hip or shoulder height out of range"


def test_leg_rules_leave_every_recorded_sound_rig_alone():
    """Sound rigs (legs under 5 % apart) keep both legs inside the leg volume, so repair_legs never touches them."""
    scope = _repair()
    rows = json.loads((Path(__file__).parent / "data" / "rig_leg_joints.json").read_text())
    assert len(rows) >= 40
    for job, joints in rows.items():
        j = _joints(joints)
        before = {k: v.c for k, v in j.items()}
        assert scope["repair_legs"](j, {}, _Vol()) == "", job
        assert {k: v.c for k, v in j.items()} == before, job
