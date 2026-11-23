"""Local ownership/packing contracts, not model generation or browser proof."""
import base64
import copy
import json
import math
import struct

import pytest

from server import game_design, gamespec, store, tools
from server.authored_contract import AUTHORED_PROPERTIES
from server.tests.conftest import FakeBedrockRT, FakeS3, FakeTable, make_ctx
from server.tests.test_gamespec import authored_spec
from server.tests.test_city_contract import city_spec
from server.tests.test_tools import BUCKET, _add_ip, _glb, _session

# Real encoded one-pixel image for file-signature/byte-copy tests only.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="
)
document = b'{"asset":{"version":"2.0"}}'
document += b" " * (-len(document) % 4)
GLB = struct.pack("<4sII", b"glTF", 2, 20 + len(document)) + struct.pack("<II", len(document), 0x4E4F534A) + document


def design():
    return {"prompt": "원본 장소 배경 안에서 제나가 코어를 회수하고 안내인에게 보고",
            "castIpIds": ["ip_hero", "ip_core", "ip_mentor", "ip_background"],
            "playerIpId": "ip_hero", "weaponIpId": None, "backgroundIpId": "ip_background",
            "propIpIds": ["ip_core"], "enemyIpIds": [], "npcIpIds": ["ip_mentor"]}


def ips():
    return {"ip_hero": {"kind": "character"}, "ip_core": {"kind": "prop"},
            "ip_mentor": {"kind": "character"}, "ip_background": {"kind": "prop"}}


def background_spec(mode="image"):
    spec = authored_spec()
    spec["player"]["ipId"] = "ip_hero"
    spec["world"]["background"] = {"ipId": "ip_background", "mode": mode}
    return spec


def prepared(mode="image"):
    ctx = make_ctx(table=FakeTable(), s3=FakeS3())
    session = _session(ctx)
    sid = session["sessionId"]
    for name in tools.RUNTIME3D_FILES:
        ctx.s3._store[(BUCKET, f"runtime3d/v1/{name}")] = name.encode()
    for ip_id in ("ip_hero", "ip_core", "ip_mentor", "ip_background"):
        _add_ip(ctx, sid, ip_id, ("cutout-" + ip_id).encode())
    store.update_ip(ctx, sid, "ip_core", kind="prop")
    store.update_ip(ctx, sid, "ip_background", kind="prop", usage="background")
    snapshot = store.snapshot(ctx, sid)
    bg = next(ip for ip in snapshot["ips"] if ip["ipId"] == "ip_background")
    image = next(a for a in snapshot["assets"] if a["assetId"] == bg["imageAssetId"])
    ctx.s3._store[(BUCKET, image["key"])] = PNG
    _glb(ctx, sid, "ip_hero", body=b"hero-model")  # a 3D game needs its player in 3D
    if mode == "model":
        _glb(ctx, sid, "ip_background", body=GLB)
        _glb(ctx, sid, "ip_background", "rigged_glb", "riggedGlbAssetId", b"rig-must-not-be-used")
    return ctx, session


def test_background_selection_is_owned_singleton_prop_and_keeps_exact_provenance():
    request = design()
    original = copy.deepcopy(request)
    assert game_design.validate_design(request, ips(), request["prompt"]) == (request, [])
    assert request == original
    assert game_design.provenance(request)["backgroundIpId"] == "ip_background"
    assert game_design.role_errors(background_spec(), request) == []
    wrong = background_spec()
    wrong["world"]["background"]["ipId"] = "ip_core"
    assert "backgroundIpId" in game_design.role_errors(wrong, request)[0]


@pytest.mark.parametrize("background", ["foreign", "ip_hero", "ip_core", ["ip_background"], {}, True])
def test_background_selection_cannot_be_foreign_character_multi_value_or_duplicate_role(background):
    request = design()
    request["backgroundIpId"] = background
    value, errors = game_design.validate_design(request, ips(), request["prompt"])
    assert value is None and errors


@pytest.mark.parametrize("mode,rotation", [("image", 0), ("model", -math.pi), ("model", math.pi)])
def test_background_contract_is_additive_bounded_and_never_mutates_input(mode, rotation):
    raw = background_spec(mode)
    raw["world"]["background"].update(rotation=rotation)
    before = copy.deepcopy(raw)
    result, errors = gamespec.validate_spec(raw)
    assert errors == [] and result["world"]["background"]["rotation"] == rotation
    assert raw == before
    assert AUTHORED_PROPERTIES["world"]["properties"]["background"]["additionalProperties"] is False


@pytest.mark.parametrize("patch", [
    {"mode": "terrain"}, {"rotation": math.inf}, {"rotation": math.nan},
    {"rotation": True}, {"rotation": math.pi + .1}, {"rotation": .1},
    {"ipId": "https://evil.example/bg"}, {"ipId": "../other"}, {"ipId": ""},
    {"terrain": True}, {"heightmapUrl": "https://evil.example/x"}, {"position": {"x": 0}},
])
def test_background_contract_rejects_unsupported_or_ignored_fields(patch):
    raw = background_spec()
    raw["world"]["background"].update(patch)
    result, errors = gamespec.validate_spec(raw)
    assert result is None and any("background" in error for error in errors)


def test_background_urls_are_dropped_then_owned_urls_replaced_and_edit_roundtrip_unresolved():
    raw = background_spec()
    raw["world"]["background"].update(imageUrl="https://evil.example/bg.png", modelUrl="https://evil.example/bg.glb")
    result, errors = gamespec.validate_spec(raw)
    assert errors == [] and result["world"]["background"] == {
        "ipId": "ip_background", "mode": "image", "rotation": 0}
    known = {**ips(), "ip_background": {"kind": "prop", "imageAssetId": "raw-image"}}
    resolved = gamespec.resolve_sprites(result, known)
    assert resolved["world"]["background"]["imageUrl"] == "assets/ip_background.background.png"
    assert "modelUrl" not in resolved["world"]["background"]
    assert tools._unresolved(resolved)["world"]["background"] == result["world"]["background"]
    known["ip_background"] = {"kind": "prop", "riggedGlbAssetId": "rig-only"}
    raw["world"]["background"]["mode"] = "model"
    resolved = gamespec.resolve_sprites(raw, known, {"ip_background"}, {"ip_background"})
    assert "modelUrl" not in resolved["world"]["background"]
    assert "imageUrl" not in resolved["world"]["background"]


def test_background_counts_as_cast_but_cannot_hide_missing_or_unselected_ips():
    spec = background_spec()
    assert gamespec.cast_errors(spec, design()["castIpIds"], ips()) == []
    assert any("world.background" in e for e in gamespec.cast_errors(spec, design()["castIpIds"][:-1], ips()))
    spec["world"].pop("background")
    assert any("ip_background" in e for e in gamespec.cast_errors(spec, design()["castIpIds"], ips()))


@pytest.mark.parametrize("mode", ["image", "model"])
@pytest.mark.parametrize("city", [False, True])
def test_background_packing_uses_exact_original_image_or_raw_model_not_cutout_or_rig(mode, city):
    ctx, session = prepared(mode)
    raw = city_spec() if city else background_spec(mode)
    raw["player"]["ipId"] = "ip_hero"
    raw["world"]["background"] = {"ipId": "ip_background", "mode": mode}
    if city:
        for name in tools.CITY_RUNTIME_FILES:
            ctx.s3._store[(BUCKET, f"runtime3d/v1/{name}")] = name.encode()
    raw["world"]["background"].update(imageUrl="https://evil.example/x", modelUrl="https://evil.example/y")
    output = tools.make_game(ctx, session, {"spec": raw, "_game_design": design()})
    assert "error" not in output, output
    prefix = f"games/{output['gameId']}/"
    saved = json.loads(ctx.s3._store[(BUCKET, prefix + "spec.json")])
    background = saved["world"]["background"]
    field, extension, body = ("imageUrl", "png", PNG) if mode == "image" else ("modelUrl", "glb", GLB)
    assert background[field] == f"assets/ip_background.background.{extension}"
    assert ctx.s3._store[(BUCKET, prefix + background[field])] == body
    assert saved["design"]["backgroundIpId"] == "ip_background"
    assert "ip_background" in saved["design"]["castIpIds"]
    assert all(p["ipId"] != "ip_background" for p in saved["props"])
    if city:
        assert saved["world"]["width"] == 600 and len(saved["world"]["city"]["streets"]) == 6
        assert [s["type"] for s in saved["mission"]["stages"]] == ["talk", "drive", "collect", "reach"]
    assert "evil.example" not in json.dumps(saved)
    assert not any(key.endswith("ip_background.png") or key.endswith("ip_background.rig.glb")
                   for bucket, key in ctx.s3._store if key.startswith(prefix))
    assert tools._unresolved(saved)["world"]["background"] == {"ipId": "ip_background", "mode": mode, "rotation": 0}


@pytest.mark.parametrize("failure", [
    "unknown", "character", "cutout", "other-ip", "foreign-key", "unsafe-key", "missing-body", "bad-body", "rig-only",
])
def test_background_missing_owned_original_fails_before_game_or_s3_writes(failure):
    mode = "model" if failure == "rig-only" else "image"
    ctx, session = prepared(mode)
    sid = session["sessionId"]
    snapshot = store.snapshot(ctx, sid)
    bg = next(i for i in snapshot["ips"] if i["ipId"] == "ip_background")
    image = next(a for a in snapshot["assets"] if a["assetId"] == bg["imageAssetId"])
    raw = background_spec(mode)
    if failure == "unknown":
        raw["world"]["background"]["ipId"] = "ip_foreign"
    elif failure == "character":
        store.update_ip(ctx, sid, bg["ipId"], kind="character")
    elif failure == "cutout":
        store.update_ip(ctx, sid, bg["ipId"], imageAssetId=bg["cutoutAssetId"])
    elif failure in ("other-ip", "foreign-key", "unsafe-key"):
        fields = {"other-ip": {"ipId": "another-ip"},
                  "foreign-key": {"key": "sessions/other-session/background.png"},
                  "unsafe-key": {"key": f"sessions/{sid}/../other/background.png"}}[failure]
        store.put_asset(ctx, sid, {**image, **fields})
    elif failure == "missing-body":
        del ctx.s3._store[(BUCKET, image["key"])]
    elif failure == "bad-body":
        ctx.s3._store[(BUCKET, image["key"])] = b"not-an-image"
    elif failure == "rig-only":
        store.update_ip(ctx, sid, bg["ipId"], glbAssetId=None)
    before = copy.deepcopy(ctx.s3._store)
    output = tools.make_game(ctx, session, {"spec": raw})
    assert "background" in output["error"], output
    assert ctx.s3._store == before and not ctx.s3.copies
    assert store.snapshot(ctx, sid)["games"] == []


def test_background_duplicate_scene_role_is_rejected_without_structured_design():
    ctx, session = prepared()
    raw = background_spec()
    raw["world"]["background"]["ipId"] = "ip_core"
    before = copy.deepcopy(ctx.s3._store)
    output = tools.make_game(ctx, session, {"spec": raw})
    assert output["error"] == "background_role_conflict"
    assert ctx.s3._store == before


def test_background_creation_preserves_full_original_and_never_calls_removal(monkeypatch):
    # Fake native response: contract only, not an actual Bedrock/model claim.
    jpeg = b"\xff\xd8\xfffixture-jpeg"
    west = FakeBedrockRT([{"images": [base64.b64encode(jpeg).decode()]}])
    ctx = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_west=west)
    session = _session(ctx)
    monkeypatch.setattr(tools, "remove_background", lambda *_: pytest.fail("Background was removed"))
    output = tools.create_ip_asset(ctx, session, {"kind": "prop", "usage": "background", "name": "정원",
                                               "description": "a lush garden with winding paths and distant towers",
                                               "image_model": "stability-ultra"})
    snapshot = store.snapshot(ctx, session["sessionId"])
    [ip] = snapshot["ips"]
    assert ip["usage"] == "background" and ip["kind"] == "prop" and ip["ipId"] == output["ipId"]
    assets = {a["kind"]: a for a in snapshot["assets"]}
    full, preview = assets["image"], assets["cutout"]
    assert full["assetId"] != preview["assetId"]
    assert preview["meta"] == {"forAssetId": full["assetId"], "backgroundPreserved": True}
    for a in (full, preview):
        assert ctx.s3._store[(BUCKET, a["key"])] == jpeg
        assert a["contentType"] == "image/jpeg"
    body = west.calls[0]["body"]
    assert body["aspect_ratio"] == "16:9"
    assert "Full environmental scene" in body["prompt"] and "Wide establishing composition" in body["prompt"]
    assert "plain neutral studio background" not in body["prompt"] and "Single product render" not in body["prompt"]


@pytest.mark.parametrize("kind,usage", [("character", "background"), ("enemy", "background"),
                                       ("weapon", "background"), ("prop", "terrain"), ("prop", None)])
def test_invalid_background_creation_usage_rejects_before_provider_or_asset_writes(kind, usage):
    ctx = make_ctx(table=FakeTable(), s3=FakeS3())
    session = _session(ctx)
    output = tools.create_ip_asset(ctx, session, {"kind": kind, "usage": usage, "name": "test", "description": "test"})
    assert output["error"] == "bad_args"
    assert ctx.s3._store == {} and store.snapshot(ctx, session["sessionId"])["ips"] == []


def test_background_variant_and_reroll_keep_scene_usage_and_paired_full_preview(monkeypatch):
    from server import jobs
    from server.providers import mediagen_image
    from server.tests.fake_gpu import Clock, FakeImageBox
    ctx, session = prepared()
    sid = session["sessionId"]
    box = FakeImageBox(Clock(), gen_sec=0, swap_sec=0, png=lambda job: PNG).install(monkeypatch)
    monkeypatch.setattr(mediagen_image, "remove_background", lambda *_: pytest.fail("Scene variant was cut out"))

    def run():  # the image jobs: submit, then collect
        for _ in range(3):
            jobs.advance_jobs(ctx, sid)
    output = tools.make_ip_variant(ctx, session, {"ipId": "ip_background", "prompt": "Add golden evening sunlight"})
    assert output["version"] == 2
    run()
    first = box.starts[0]
    assert first["model"] == "klein9" and "complete location" in first["prompt"] and "same face" not in first["prompt"]
    output = tools.reroll_ip_image(ctx, session, {"ipId": "ip_background"})
    assert output["version"] == 3
    run()
    assert box.starts[-1]["prompt"] == first["prompt"]
    assert {j["input"]["usage"] for j in store.snapshot(ctx, sid)["jobs"]} == {"background"}
    snapshot = store.snapshot(ctx, sid)
    bg = next(i for i in snapshot["ips"] if i["ipId"] == "ip_background")
    assert bg["usage"] == "background"
    preview = next(a for a in snapshot["assets"] if a["assetId"] == bg["cutoutAssetId"])
    assert preview["meta"]["backgroundPreserved"] is True and ctx.s3._store[(BUCKET, preview["key"])] == PNG
