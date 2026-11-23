import base64
import json
import pathlib
import re

import pytest

from server import jobs, store, tools
from server.tests.conftest import FakeBedrockRT, FakeProvider, FakeS3, FakeTable, make_ctx
from server.tests.fake_gpu import Clock, FakeImageBox
from server.tests.test_gamespec import authored_spec, minimal_sf

BUCKET = "test-assets"
RUNTIME = ("index.html", "runtime.js", "shooter.js", "rpg.js", "gamespec.js")
PALETTE = ["#ffb86b", "#1b2a4a", "#5de6cf"]


@pytest.fixture
def ctx():
    return make_ctx(table=FakeTable(), s3=FakeS3())


def _session(ctx):
    s = store.put_session(ctx, "user-1", "루나", "sf-shooter")
    store.update_session(ctx, s, concept={"title": "루나의 궤도 탈출", "logline": "탈출극",
                                          "style": "Pixar-like 3D", "palette": PALETTE})
    return s


@pytest.fixture
def session(ctx):
    return _session(ctx)


def _add_ip(ctx, sid, ip_id, cutout_bytes):
    image = store.put_asset(ctx, sid, {"kind": "image", "key": f"sessions/{sid}/{ip_id}.jpg",
                                       "contentType": "image/jpeg", "ipId": ip_id})
    cutout = store.put_asset(ctx, sid, {"kind": "cutout", "key": f"sessions/{sid}/{ip_id}.png",
                                        "contentType": "image/png", "ipId": ip_id})
    ctx.s3._store[(BUCKET, cutout["key"])] = cutout_bytes
    return store.put_ip(ctx, sid, {"ipId": ip_id, "kind": "character", "name": ip_id, "version": 1,
                                   "imageAssetId": image["assetId"], "cutoutAssetId": cutout["assetId"]})


def _job(ctx, sid, job_id):
    return next(j for j in store.snapshot(ctx, sid)["jobs"] if j["jobId"] == job_id)


def test_create_ip_asset_stores_two_assets_and_ip():
    jpeg, png = b"\xff\xd8JPEG", b"\x89PNG"
    west = FakeBedrockRT([{"images": [base64.b64encode(jpeg).decode()]}])
    east = FakeBedrockRT([{"image": base64.b64encode(png).decode()}])
    ctx = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_west=west, bedrock_rt_east=east)
    session = _session(ctx)
    sid = session["sessionId"]

    out = tools.run_tool(ctx, session, "create_ip_asset",
                         {"kind": "character", "name": "Luna", "description": "a cat astronaut", "role": "주인공",
                          "image_model": "stability-ultra"})

    snap = store.snapshot(ctx, sid)
    [ip] = snap["ips"]
    by_kind = {a["kind"]: a for a in snap["assets"]}
    image, cutout = by_kind["image"], by_kind["cutout"]
    assert out == {"ipId": ip["ipId"], "imageUrl": image["url"], "cutoutUrl": cutout["url"],
                   "imageModel": "stability-ultra"}
    assert image["meta"]["model"] == "stability-ultra"
    assert image["key"] == f"sessions/{sid}/{image['assetId']}.jpg" and image["contentType"] == "image/jpeg"
    assert cutout["key"] == f"sessions/{sid}/{cutout['assetId']}.png" and cutout["contentType"] == "image/png"
    assert image["ipId"] == cutout["ipId"] == ip["ipId"]
    assert ctx.s3._store[(BUCKET, image["key"])] == jpeg
    assert ctx.s3._store[(BUCKET, cutout["key"])] == png
    assert (ip["kind"], ip["name"], ip["role"], ip["version"]) == ("character", "Luna", "주인공", 1)
    assert (ip["imageAssetId"], ip["cutoutAssetId"]) == (image["assetId"], cutout["assetId"])

    body = west.calls[0]["body"]
    assert body["prompt"] == (
        "Single full-body shot of ONE character, Luna: a cat astronaut. Pixar-like 3D. Exactly one figure standing "
        "alone in the middle of the wide frame, nobody else in the picture, empty background on both sides, entire "
        "body visible from the top of the head to the soles of the feet, the figure about two thirds of the frame "
        "height with empty space above the head and below the feet, A-pose: arms held straight out at about 45 "
        "degrees from the body, legs slightly apart, empty open hands, neutral expression, facing the camera, plain "
        "neutral studio background, no duplicates, no turnaround, no text")
    assert body["negative_prompt"] == ("text, watermark, blurry, multiple subjects, cropped, multiple characters, "
                                       "duplicate, character sheet")
    assert (body["aspect_ratio"], body["output_format"]) == ("1:1", "jpeg")
    assert east.calls[0]["body"]["image"] == base64.b64encode(jpeg).decode()


def test_render_3d_and_video_shot_create_jobs(ctx, session):
    sid = session["sessionId"]
    ip = _add_ip(ctx, sid, "ip_hero", b"HERO")

    out = tools.run_tool(ctx, session, "render_3d", {"ipId": "ip_hero"})  # character: A-pose → mesh → turntable
    pose = _job(ctx, sid, out["poseJobId"])
    assert (pose["kind"], pose["provider"], pose["deps"]) == ("apose", "apose", [])
    assert pose["input"] == {"ipId": "ip_hero", "name": "ip_hero", "imageKey": f"sessions/{sid}/ip_hero.jpg"}
    mesh, render = _job(ctx, sid, out["meshJobId"]), _job(ctx, sid, out["jobId"])
    assert (mesh["kind"], mesh["provider"], mesh["status"], mesh["deps"]) == ("mesh3d", "img3d", "queued",
                                                                              [pose["jobId"]])
    assert mesh["input"] == {"ipId": "ip_hero", "cutoutKey": f"sessions/{sid}/{pose['jobId']}-apose.png",
                             "model": "hunyuan3d"}
    assert (render["kind"], render["provider"], render["deps"]) == ("render3d", "deadline", [mesh["jobId"]])
    assert render["input"] == {"ipId": "ip_hero", "glbKey": f"sessions/{sid}/{mesh['jobId']}.glb",
                               "accent": PALETTE[0], "model": "hunyuan3d"}

    relief = tools.run_tool(ctx, session, "render_3d", {"ipId": "ip_hero", "model": "relief"})
    assert "meshJobId" not in relief
    relief = _job(ctx, sid, relief["jobId"])
    assert (relief["kind"], relief["provider"], relief["deps"]) == ("render3d", "deadline", [])
    assert relief["input"] == {"ipId": "ip_hero", "cutoutKey": f"sessions/{sid}/ip_hero.png", "accent": PALETTE[0],
                               "model": "relief"}
    assert tools.run_tool(ctx, session, "render_3d", {"ipId": "ip_hero", "model": "nerf"})["error"] == "bad_args"

    out = tools.run_tool(ctx, session, "make_video_shot",
                         {"ipId": "ip_hero", "prompt": "slow dolly in", "aspect_ratio": "9:16", "duration": 7})
    shot = _job(ctx, sid, out["jobId"])
    assert (shot["kind"], shot["provider"]) == ("shot", "mediagen_video")
    assert shot["input"] == {"ipId": "ip_hero", "imageKey": f"sessions/{sid}/ip_hero.jpg",  # full image, not cutout
                             "prompt": "slow dolly in", "aspect_ratio": "9:16", "seconds": 7, "model": "ltx"}

    assert tools.run_tool(ctx, session, "render_3d", {"ipId": "ip_made_up"})["error"] == "not_found"
    assert tools.run_tool(ctx, session, "make_video_shot",
                          {"ipId": ip["ipId"], "prompt": "x", "aspect_ratio": "4:3"})["error"] == "bad_args"


def test_make_video_shot_models_defaults_and_clamp(ctx, session):
    """The models come from the video MCP (test_video_edit.py); unit tests cannot reach it, so its defaults apply."""
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    base = {"ipId": "ip_hero", "prompt": "orbit", "aspect_ratio": "16:9"}

    def shot(**extra):
        out = tools.run_tool(ctx, session, "make_video_shot", {**base, **extra})
        return out if "error" in out else _job(ctx, sid, out["jobId"])["input"]

    assert (shot()["model"], shot()["seconds"]) == ("ltx", 5)
    assert (shot(model="minimax-h3", duration=8)["seconds"], shot(model="kandinsky-6-0-video-pro", duration=2)["seconds"]) == (5, 5)
    assert shot(model="ltx", duration=2)["seconds"] == 2 and shot(model="ltx", duration=20)["seconds"] == 20
    for bad in ({"model": "luma"}, {"model": "wan-animate"}, {"duration": 21}, {"duration": 1}, {"duration": "5s"},
                {"duration": True}):
        err = shot(**bad)
        assert err["error"] == "bad_args" and err["message"]
    spec = next(s for s in tools.TOOL_SPECS if s["name"] == "make_video_shot")["inputSchema"]["json"]
    assert "enum" not in spec["properties"]["model"]  # a model promoted on the MCP needs no code change
    assert spec["required"] == ["prompt", "aspect_ratio"]  # no ipId: text-to-video


def test_animate_character_waits_for_the_driving_shot(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _add_ip(ctx, sid, "ip_rival", b"RIVAL")
    drive = tools.run_tool(ctx, session, "make_video_shot",
                           {"ipId": "ip_hero", "prompt": "dance", "aspect_ratio": "9:16"})["jobId"]

    out = tools.run_tool(ctx, session, "animate_character",
                         {"ipId": "ip_rival", "driving_shot_job_id": drive, "prompt": "on a rooftop"})
    job = _job(ctx, sid, out["jobId"])
    assert (job["kind"], job["provider"], job["deps"]) == ("shot", "mediagen_video", [drive])
    assert job["input"] == {"ipId": "ip_rival", "imageKey": f"sessions/{sid}/ip_rival.jpg", "model": "wan-animate",
                            "driving_shot_job_id": drive, "prompt": "on a rooftop", "seconds": 4,
                            "aspect_ratio": "9:16"}
    # its output is a shot, so a trailer can cut it
    trailer = tools.run_tool(ctx, session, "cut_trailer", {"shot_job_ids": [out["jobId"]], "title": "t",
                                                           "subtitle": "", "lut": "none", "make_shorts": False})
    assert "jobId" in trailer

    assert tools.run_tool(ctx, session, "animate_character",
                          {"ipId": "ip_rival", "driving_shot_job_id": "job_nope"})["error"] == "not_found"
    assert tools.run_tool(ctx, session, "animate_character",
                          {"ipId": "ip_nope", "driving_shot_job_id": drive})["error"] == "not_found"
    store.update_job(ctx, sid, drive, status="failed")
    assert tools.run_tool(ctx, session, "animate_character",
                          {"ipId": "ip_rival", "driving_shot_job_id": drive})["error"] == "bad_args"


def test_cut_trailer_turntable_dependency(ctx, session):
    sid = session["sessionId"]
    store.put_ip(ctx, sid, {"ipId": "ip_1", "name": "루나"})
    store.put_ip(ctx, sid, {"ipId": "ip_2", "name": "코어"})
    shot = jobs.create_job(ctx, sid, "shot", "bedrock_video", {"ipId": "ip_1"}, [])
    render = jobs.create_job(ctx, sid, "render3d", "deadline", {"ipId": "ip_1"}, [])
    args = {"shot_job_ids": [shot["jobId"]], "title": "루나", "subtitle": "곧 공개", "lut": "teal-orange",
            "make_shorts": True, "include_turntable_ip_id": "ip_1"}

    waiting = _job(ctx, sid, tools.run_tool(ctx, session, "cut_trailer", args)["jobId"])
    assert (waiting["kind"], waiting["provider"], waiting["status"]) == ("trailer", "ffmpeg", "queued")
    assert waiting["deps"] == [shot["jobId"], render["jobId"]]  # turntable not ready: wait for the render
    assert waiting["input"]["shot_job_ids"] == [shot["jobId"]] and waiting["input"]["make_shorts"] is True
    assert "extra_asset_ids" not in waiting["input"]

    store.update_ip(ctx, sid, "ip_1", turntableAssetId="ast_tt")
    ready = _job(ctx, sid, tools.run_tool(ctx, session, "cut_trailer", args)["jobId"])
    assert ready["deps"] == [shot["jobId"]] and ready["input"]["extra_asset_ids"] == ["ast_tt"]

    no_render = tools.run_tool(ctx, session, "cut_trailer", {**args, "include_turntable_ip_id": "ip_2"})
    assert no_render["error"] == "bad_args" and "render_3d" in no_render["message"]
    assert tools.run_tool(ctx, session, "cut_trailer", {**args, "shot_job_ids": ["job_nope"]})["error"] == "not_found"


def test_make_game_rejects_invalid_spec(ctx, session):
    spec = minimal_sf()
    spec["objective"]["type"] = "talk"

    out = tools.run_tool(ctx, session, "make_game", {"spec": spec})

    assert out["error"] == "invalid_spec" and "objective.type" in out["message"]
    assert ctx.s3._store == {}
    assert store.snapshot(ctx, session["sessionId"])["games"] == []


def test_authored_game_rejects_unbound_npc_before_packaging(ctx, session):
    spec = authored_spec()
    spec["props"] = spec["props"][:1]
    spec["world"]["npc"].pop("propIndex")
    spec["mission"]["stages"] = [s for s in spec["mission"]["stages"] if s["type"] != "talk"]
    out = tools.run_tool(ctx, session, "make_game", {"spec": spec})
    assert out["error"] == "missing_npc_ip"
    assert ctx.s3._store == {}
    assert store.snapshot(ctx, session["sessionId"])["games"] == []


def test_authored_game_rejects_selected_weapon_without_3d_before_packaging(ctx, session):
    spec = authored_spec()
    sid = session["sessionId"]
    for ip_id in ("ip_hero", "ip_core", "ip_mentor", "ip_blade"):
        _add_ip(ctx, sid, ip_id, b"prepared-cutout")
    store.update_ip(ctx, sid, "ip_blade", kind="weapon")
    spec["player"].update(ipId="ip_hero", weaponIpId="ip_blade")
    before = dict(ctx.s3._store)
    out = tools.run_tool(ctx, session, "make_game", {"spec": spec})
    assert out["error"] == "missing_weapon_asset"
    assert ctx.s3._store == before
    assert store.snapshot(ctx, sid)["games"] == []


def test_make_game_writes_runtime_spec_and_sprites(ctx, session):
    sid = session["sessionId"]
    for name in RUNTIME:
        ctx.s3._store[(BUCKET, f"runtime/v1/{name}")] = name.encode()
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _add_ip(ctx, sid, "ip_core", b"CORE")
    spec = minimal_sf()
    spec["title"] = "루나의 궤도 탈출"
    spec["player"]["ipId"] = "ip_hero"
    spec["props"] = [{"ipId": "ip_core", "name": "코어", "effect": "score"}]

    out = tools.run_tool(ctx, session, "make_game", {"spec": spec, "engine": "phaser"})

    gid = out["gameId"]
    assert re.fullmatch(r"gm_[0-9a-f]{10}", gid)
    assert out["previewUrl"] == f"https://cdn.example.com/games/{gid}/index.html"
    s3 = ctx.s3._store
    for name in RUNTIME:
        assert s3[(BUCKET, f"games/{gid}/{name}")] == name.encode()
    assert s3[(BUCKET, f"games/{gid}/assets/ip_hero.png")] == b"HERO"
    assert s3[(BUCKET, f"games/{gid}/assets/ip_core.png")] == b"CORE"
    written = json.loads(s3[(BUCKET, f"games/{gid}/spec.json")])
    assert written["player"]["spriteUrl"] == "assets/ip_hero.png"
    assert written["props"][0]["spriteUrl"] == "assets/ip_core.png"
    assert written["dialogue"] == [] and written["quest"] is None
    assert json.loads(s3[(BUCKET, f"games/{gid}/release.json")]) == {"publishedAt": None, "ad": None}
    [game] = store.snapshot(ctx, sid)["games"]
    assert (game["gameId"], game["title"], game["genre"]) == (gid, "루나의 궤도 탈출", "sf-shooter")
    assert (game["specKey"], game["previewUrl"]) == (f"games/{gid}/spec.json", out["previewUrl"])


RUNTIME3D = ("index.html", "runtime3d.js", "world.js", "anim.js", "ualclips.js", "sf.js", "rpg.js", "gamespec3d.js",
             "authored-contract.js", "city-contract.js", "background-data.js", "background.js",
             "mission.js", "authored.js", "biome.js", "sky.js", "arpg.js", "arpg-data.js", "ui.css")


def test_make_game_defaults_to_three_with_glb_models(ctx, session):
    sid = session["sessionId"]
    for name in RUNTIME3D:
        ctx.s3._store[(BUCKET, f"runtime3d/v1/{name}")] = b"3d:" + name.encode()
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _add_ip(ctx, sid, "ip_core", b"CORE")  # no GLB yet: sprite only
    glb = store.put_asset(ctx, sid, {"kind": "glb", "key": f"sessions/{sid}/hero.glb", "contentType": "model/gltf-binary",
                                     "ipId": "ip_hero"})
    ctx.s3._store[(BUCKET, glb["key"])] = b"glTF"
    store.update_ip(ctx, sid, "ip_hero", glbAssetId=glb["assetId"])
    spec = minimal_sf()
    spec["player"]["ipId"] = "ip_hero"
    spec["player"]["modelUrl"] = "https://evil.example/x.glb"  # model-sent URLs are replaced
    spec["props"] = [{"ipId": "ip_core", "name": "코어", "effect": "score"}]

    out = tools.run_tool(ctx, session, "make_game", {"spec": spec})

    gid = out["gameId"]
    s3 = ctx.s3._store
    for name in RUNTIME3D:
        assert s3[(BUCKET, f"games/{gid}/{name}")] == b"3d:" + name.encode()
    assert (BUCKET, f"games/{gid}/runtime.js") not in s3
    assert s3[(BUCKET, f"games/{gid}/assets/ip_hero.glb")] == b"glTF"
    assert s3[(BUCKET, f"games/{gid}/assets/ip_hero.png")] == b"HERO"
    assert (BUCKET, f"games/{gid}/assets/ip_core.glb") not in s3
    written = json.loads(s3[(BUCKET, f"games/{gid}/spec.json")])
    assert written["engine"] == "three"
    assert written["player"]["modelUrl"] == "assets/ip_hero.glb" and written["player"]["spriteUrl"] == "assets/ip_hero.png"
    assert "modelUrl" not in written["props"][0] and written["props"][0]["spriteUrl"] == "assets/ip_core.png"
    [game] = store.snapshot(ctx, sid)["games"]
    assert game["engine"] == "three"


def test_runtime3d_files_exist_in_game3d():
    root = pathlib.Path(__file__).resolve().parents[2] / "game3d"
    assert tools.RUNTIME3D_FILES == RUNTIME3D
    assert [name for name in tools.RUNTIME3D_FILES if not (root / name).is_file()] == []


def test_make_game_engine_choice(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    glb = store.put_asset(ctx, sid, {"kind": "glb", "key": "k.glb", "contentType": "model/gltf-binary", "ipId": "ip_hero"})
    store.update_ip(ctx, sid, "ip_hero", glbAssetId=glb["assetId"])
    spec = minimal_sf()
    spec["player"]["ipId"] = "ip_hero"

    phaser = tools.run_tool(ctx, session, "make_game", {"spec": {**spec, "engine": "phaser"}})  # spec field works too
    written = json.loads(ctx.s3._store[(BUCKET, f"games/{phaser['gameId']}/spec.json")])
    assert written["engine"] == "phaser" and "modelUrl" not in written["player"]  # 2D runtime: sprites only
    assert tools.run_tool(ctx, session, "make_game", {"spec": spec, "engine": "unity"})["error"] == "bad_args"
    bad = tools.run_tool(ctx, session, "make_game", {"spec": {**spec, "engine": "unity"}})
    assert bad["error"] == "invalid_spec" and "engine" in bad["message"]


def test_publish_game_writes_release_with_ad(ctx, session):
    sid = session["sessionId"]
    url = "https://cdn.example.com/games/gm_1/index.html"
    store.put_game(ctx, sid, {"gameId": "gm_1", "title": "G", "genre": "sf-shooter",
                              "specKey": "games/gm_1/spec.json", "previewUrl": url})
    trailer = store.put_asset(ctx, sid, {"kind": "trailer", "key": f"sessions/{sid}/t.mp4",
                                         "contentType": "video/mp4", "meta": {}})

    out = tools.run_tool(ctx, session, "publish_game",
                         {"gameId": "gm_1", "ad_asset_id": trailer["assetId"], "skip_after_sec": 7})

    assert out == {"publishedUrl": url}
    key = (BUCKET, "games/gm_1/release.json")
    release = json.loads(ctx.s3._store[key])
    assert release["ad"] == {"videoUrl": trailer["url"], "skipAfterSec": 7}
    assert ctx.s3.put_kwargs[key]["CacheControl"] == "no-cache"  # preview's copy must not stick in CloudFront
    [game] = store.snapshot(ctx, sid)["games"]
    assert (game["publishedUrl"], game["adAssetId"], game["publishedAt"]) == (url, trailer["assetId"],
                                                                             release["publishedAt"])

    tools.run_tool(ctx, session, "publish_game", {"gameId": "gm_1", "ad_asset_id": trailer["assetId"], "ad_every_rounds": 3})
    assert json.loads(ctx.s3._store[key])["ad"]["everyRounds"] == 3
    assert tools.run_tool(ctx, session, "publish_game", {"gameId": "gm_1", "ad_asset_id": trailer["assetId"],
                                                         "ad_every_rounds": 21})["error"] == "bad_args"

    image = store.put_asset(ctx, sid, {"kind": "image", "key": "k.jpg", "contentType": "image/jpeg"})
    assert tools.run_tool(ctx, session, "publish_game",
                          {"gameId": "gm_1", "ad_asset_id": image["assetId"]})["error"] == "bad_args"
    assert tools.run_tool(ctx, session, "publish_game", {"gameId": "gm_nope"})["error"] == "not_found"


def test_urls_are_root_relative_without_cdn_domain():
    ctx = make_ctx(table=FakeTable(), s3=FakeS3(), cdn_domain="")
    session = _session(ctx)
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _glb(ctx, sid, "ip_hero")  # a 3D game needs its player in 3D
    spec = minimal_sf()
    spec["player"]["ipId"] = "ip_hero"
    trailer = store.put_asset(ctx, sid, {"kind": "trailer", "key": f"sessions/{sid}/t.mp4", "contentType": "video/mp4"})
    assert trailer["url"] == f"/sessions/{sid}/t.mp4"

    game = tools.run_tool(ctx, session, "make_game", {"spec": spec})
    page = f"/games/{game['gameId']}/index.html"
    assert game["previewUrl"] == page
    out = tools.run_tool(ctx, session, "publish_game", {"gameId": game["gameId"], "ad_asset_id": trailer["assetId"]})
    assert out == {"publishedUrl": page}
    release = json.loads(ctx.s3._store[(BUCKET, f"games/{game['gameId']}/release.json")])
    assert release["ad"] == {"videoUrl": f"/sessions/{sid}/t.mp4", "skipAfterSec": 5}
    [stored] = store.snapshot(ctx, sid)["games"]
    assert (stored["previewUrl"], stored["publishedUrl"]) == (page, page)


# ── weapons, enemies, action shots, animated 3D games ──────────────────────────


@pytest.fixture
def fake_image(monkeypatch):
    """The image GPU box answers at once; `starts` lists its start_image calls. The shot box is a fake provider."""
    box = FakeImageBox(Clock(), gen_sec=0, swap_sec=0).install(monkeypatch)
    monkeypatch.setattr(tools.mediagen_image, "remove_background", lambda ctx, image: b"\x89PNG-cut")
    monkeypatch.setitem(jobs.PROVIDERS, "mediagen_video", FakeProvider("mediagen_video"))
    return box


def _run_jobs(ctx, sid, passes=3):
    for _ in range(passes):
        jobs.advance_jobs(ctx, sid)


def test_create_ip_asset_weapon_and_enemy_kinds(ctx, session, fake_image):
    sid = session["sessionId"]
    sword = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "weapon", "name": "Plasma Blade",
                                                              "description": "a glowing katana"})
    blaster = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "weapon", "name": "Blaster", "weapon_type": "gun",
                                                                "description": "a chunky sci-fi pistol"})
    ghoul = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "enemy", "name": "Ghoul", "description": "a ghoul"})
    drone = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "enemy", "name": "Wasp", "humanoid": False,
                                                              "description": "a wasp drone"})
    ips = {ip["ipId"]: ip for ip in store.snapshot(ctx, sid)["ips"]}
    assert (ips[sword["ipId"]]["kind"], ips[sword["ipId"]]["weaponType"]) == ("weapon", "melee")
    assert ips[blaster["ipId"]]["weaponType"] == "gun"
    assert (ips[ghoul["ipId"]]["kind"], ips[ghoul["ipId"]]["humanoid"]) == ("enemy", True)
    assert ips[drone["ipId"]]["humanoid"] is False and "weaponType" not in ips[drone["ipId"]]
    prompt = {j["input"]["ipId"]: j["input"]["prompt"] for j in store.snapshot(ctx, sid)["jobs"]}
    sword_p, ghoul_p, drone_p = (prompt[x["ipId"]] for x in (sword, ghoul, drone))
    assert "grip or handle at the left end" in sword_p and "no hands" in sword_p and "one single view" in sword_p
    assert "close-up" not in sword_p  # the GPU box takes no negative prompt: naming the close-up drew one
    assert "A-pose" in ghoul_p  # humanoid enemies are drawn like characters so they can be rigged
    assert "A-pose" not in drone_p and "ONE creature or machine" in drone_p

    # an argument that says nothing for its kind is left out, not refused: test_round21_tool_args.py
    for bad in ({"kind": "vehicle"}, {"kind": "enemy", "humanoid": "yes"}, {"kind": "weapon", "weapon_type": "bow"}):
        out = tools.run_tool(ctx, session, "create_ip_asset", {"name": "X", "description": "x", **bad})
        assert out["error"] == "bad_args", bad
    assert "character|prop|weapon|enemy" in tools.run_tool(ctx, session, "create_ip_asset", {"kind": "x"})["message"]
    assert tools.summarize("create_ip_asset", {"kind": "weapon", "name": "B"}, sword) == "무기 만들기: B"
    assert tools.summarize("create_ip_asset", {"kind": ["enemy"], "name": "B"}, sword) == "캐릭터 만들기: B"


def test_make_action_shot_still_then_shot(ctx, session, fake_image):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _add_ip(ctx, sid, "ip_blade", b"BLADE")
    store.update_ip(ctx, sid, "ip_blade", kind="weapon", name="Plasma Blade", description="a glowing katana")

    out = tools.run_tool(ctx, session, "make_action_shot",
                         {"ipId": "ip_hero", "action": "running with the sword", "weapon_ip_id": "ip_blade"})

    snap = store.snapshot(ctx, sid)
    still_job, job = (next(j for j in snap["jobs"] if j["jobId"] == out[k]) for k in ("stillJobId", "jobId"))
    assert out == {"stillJobId": still_job["jobId"], "jobId": job["jobId"], "status": "queued"}
    assert fake_image.starts == []  # both are jobs: nothing waited for the GPU inside the call
    assert (still_job["kind"], still_job["provider"], still_job["input"]["asset"]) == ("image", "mediagen_image", "action_image")
    assert (job["kind"], job["provider"], job["deps"]) == ("shot", "mediagen_video", [still_job["jobId"]])
    assert job["input"]["imageKey"] == f"sessions/{sid}/{still_job['jobId']}.png"
    assert job["input"]["seconds"] == 5 and job["input"]["model"] == "ltx"

    _run_jobs(ctx, sid)

    snap = store.snapshot(ctx, sid)
    [still] = [a for a in snap["assets"] if a["kind"] == "action_image"]
    assert still["ipId"] == "ip_hero" and still["key"] == job["input"]["imageKey"]
    assert ctx.s3._store[(BUCKET, still["key"])] == b"\x89PNG-g1"
    assert (still["meta"]["action"], still["meta"]["weaponIpId"], still["meta"]["model"]) == (
        "running with the sword", "ip_blade", "klein9")
    [call] = fake_image.starts
    assert call["model"] == "klein9" and call["reference_image_urls"] == [
        f"https://cdn.example.com/sessions/{sid}/ip_hero.jpg", f"https://cdn.example.com/sessions/{sid}/ip_blade.jpg"]
    assert call["prompt"].startswith("ip_hero running with the sword, dynamic action pose, holding Plasma Blade")
    hero = next(ip for ip in snap["ips"] if ip["ipId"] == "ip_hero")
    assert hero["version"] == 1 and "imageJobId" not in hero  # a still under the IP, not a new version
    assert next(j for j in snap["jobs"] if j["jobId"] == out["jobId"])["status"] == "running"  # the shot went out

    assert tools.run_tool(ctx, session, "make_action_shot", {"ipId": "ip_hero", "action": "x",
                                                             "weapon_ip_id": "ip_hero"})["error"] == "bad_args"
    assert tools.run_tool(ctx, session, "make_action_shot", {"ipId": "ip_hero", "action": ""})["error"] == "bad_args"
    assert tools.run_tool(ctx, session, "make_action_shot", {"ipId": "ip_nope", "action": "x"})["error"] == "not_found"


def test_make_action_shot_battle_scene_with_opponents(ctx, session, fake_image):
    sid = session["sessionId"]
    for ip_id in ("ip_hero", "ip_blade", "ip_orc", "ip_crate"):
        _add_ip(ctx, sid, ip_id, ip_id.encode())
    store.update_ip(ctx, sid, "ip_blade", kind="weapon", name="Blade")
    store.update_ip(ctx, sid, "ip_orc", kind="enemy", name="Orc", description="a scarred orc warlord")
    store.update_ip(ctx, sid, "ip_crate", kind="prop")
    out = tools.run_tool(ctx, session, "make_action_shot", {
        "ipId": "ip_hero", "action": "leaps with a spinning slash", "weapon_ip_id": "ip_blade",
        "opponent_ip_ids": ["ip_orc"], "scene": "a burning ruined city at dusk", "seconds": 8})
    _run_jobs(ctx, sid)
    [call] = fake_image.starts
    assert len(call["reference_image_urls"]) == 3  # hero, blade, opponent
    assert call["prompt"].startswith("Epic battle scene: ip_hero leaps with a spinning slash")
    assert "Orc exactly as reference image 3" in call["prompt"] and "a burning ruined city at dusk" in call["prompt"]
    job = next(j for j in store.snapshot(ctx, sid)["jobs"] if j["jobId"] == out["jobId"])
    assert job["input"]["seconds"] == 8 and "against Orc" in job["input"]["prompt"]
    still = next(a for a in store.snapshot(ctx, sid)["assets"] if a["kind"] == "action_image")
    assert still["meta"]["opponentIpIds"] == ["ip_orc"]
    assert tools.run_tool(ctx, session, "make_action_shot", {"ipId": "ip_hero", "action": "x",
                                                             "opponent_ip_ids": ["ip_crate"]})["error"] == "not_found"


def _glb(ctx, sid, ip_id, kind="glb", field="glbAssetId", body=b"glTF"):
    asset = store.put_asset(ctx, sid, {"kind": kind, "key": f"sessions/{sid}/{ip_id}.{kind}", "ipId": ip_id,
                                       "contentType": "model/gltf-binary"})
    ctx.s3._store[(BUCKET, asset["key"])] = body
    store.update_ip(ctx, sid, ip_id, **{field: asset["assetId"]})


@pytest.mark.parametrize("weapon_kind,weapon_field", [
    ("glb", "glbAssetId"),
    ("rigged_glb", "riggedGlbAssetId"),
])
def test_authored_game_packs_selected_npc_and_prepared_weapon(ctx, session, weapon_kind, weapon_field):
    """Packing contract only: these labeled bytes are not engine-ready model fixtures."""
    sid = session["sessionId"]
    for name in RUNTIME3D:
        ctx.s3._store[(BUCKET, f"runtime3d/v1/{name}")] = name.encode()
    for ip_id in ("ip_hero", "ip_core", "ip_mentor", "ip_blade"):
        _add_ip(ctx, sid, ip_id, (ip_id + "-own-cutout").encode())
    store.update_ip(ctx, sid, "ip_core", kind="prop")
    store.update_ip(ctx, sid, "ip_blade", kind="weapon", weaponType="gun")
    _glb(ctx, sid, "ip_mentor", body=b"selected-npc-own-model")
    _glb(ctx, sid, "ip_hero")  # a 3D game needs its player in 3D
    weapon_bytes = ("selected-weapon-" + weapon_kind).encode()
    _glb(ctx, sid, "ip_blade", weapon_kind, weapon_field, weapon_bytes)

    spec = authored_spec()
    spec["player"].update(ipId="ip_hero", weaponIpId="ip_blade", weaponUrl="https://evil.example/weapon.glb")
    spec["props"][1].update(modelUrl="https://evil.example/npc.glb", spriteUrl="https://evil.example/npc.png")
    design = {"prompt": "선택한 안내인과 무기로 코어를 회수하고 탈출",
              "castIpIds": ["ip_hero", "ip_core", "ip_mentor", "ip_blade"],
              "playerIpId": "ip_hero", "weaponIpId": "ip_blade",
              "propIpIds": ["ip_core"], "enemyIpIds": [], "npcIpIds": ["ip_mentor"]}

    out = tools.run_tool(ctx, session, "make_game", {"spec": spec, "_game_design": design})
    assert "error" not in out, out
    prefix = f"games/{out['gameId']}/"
    written = json.loads(ctx.s3._store[(BUCKET, prefix + "spec.json")])
    npc = written["props"][written["world"]["npc"]["propIndex"]]
    assert npc["ipId"] == "ip_mentor"
    assert (npc["modelUrl"], npc["spriteUrl"]) == ("assets/ip_mentor.glb", "assets/ip_mentor.png")
    assert (written["player"]["weaponIpId"], written["player"]["weaponUrl"], written["player"]["weaponType"]) == (
        "ip_blade", "assets/ip_blade.glb", "gun")
    assert ctx.s3._store[(BUCKET, prefix + npc["modelUrl"])] == b"selected-npc-own-model"
    assert ctx.s3._store[(BUCKET, prefix + npc["spriteUrl"])] == b"ip_mentor-own-cutout"
    assert ctx.s3._store[(BUCKET, prefix + written["player"]["weaponUrl"])] == weapon_bytes
    assert written["design"]["npcIpIds"] == ["ip_mentor"]
    assert written["design"]["weaponIpId"] == "ip_blade"
    assert written["version"] == 2 and written["enemies"] == []
    assert "evil.example" not in json.dumps(written)
    [game] = store.snapshot(ctx, sid)["games"]
    assert game["specVersion"] == 2 and game["castIpIds"] == design["castIpIds"]


def test_a_named_prop_stands_as_cover_with_its_glb_or_else_its_cutout(ctx, session):
    """A set piece without a GLB stands as its own cutout (a panel with the entity's collider), not as a plain box;
    with a GLB it keeps the 3D model."""
    sid = session["sessionId"]
    for name in RUNTIME3D:
        ctx.s3._store[(BUCKET, f"runtime3d/v1/{name}")] = name.encode()
    for ip_id in ("ip_hero", "ip_core", "ip_mentor", "ip_wire", "ip_tank"):
        _add_ip(ctx, sid, ip_id, (ip_id + "-own-cutout").encode())
    for ip_id in ("ip_core", "ip_wire", "ip_tank"):
        store.update_ip(ctx, sid, ip_id, kind="prop")
    _glb(ctx, sid, "ip_tank", body=b"tank-own-model")
    _glb(ctx, sid, "ip_hero")  # a 3D game needs its player in 3D
    spec = authored_spec()
    spec["player"]["ipId"] = "ip_hero"
    spec["props"][1]["ipId"] = "ip_mentor"
    spec["world"]["entities"] += [
        {"id": "wire_a", "kind": "model", "ipId": "ip_wire", "x": -6, "z": -14, "width": 4, "depth": .8, "height": 1.4,
         "label": "철조망 바리케이드"},
        {"id": "tank", "kind": "model", "ipId": "ip_tank", "x": 5, "z": -17, "width": 3, "depth": 3, "height": 2}]
    cast = ["ip_hero", "ip_core", "ip_mentor", "ip_wire", "ip_tank"]
    out = tools.run_tool(ctx, session, "make_game", {"spec": spec, "cast_ip_ids": cast})
    assert "error" not in out, out
    prefix = f"games/{out['gameId']}/"
    written = json.loads(ctx.s3._store[(BUCKET, prefix + "spec.json")])
    pieces = {e["id"]: e for e in written["world"]["entities"] if e["kind"] == "model"}
    assert pieces["wire_a"]["spriteUrl"] == "assets/ip_wire.png" and "modelUrl" not in pieces["wire_a"]
    assert pieces["wire_a"]["solid"] is True  # cover: the runtime keeps the entity's box as its collider
    assert ctx.s3._store[(BUCKET, prefix + "assets/ip_wire.png")] == b"ip_wire-own-cutout"
    assert pieces["tank"]["modelUrl"] == "assets/ip_tank.set.glb" and "spriteUrl" not in pieces["tank"]
    assert ctx.s3._store[(BUCKET, prefix + "assets/ip_tank.set.glb")] == b"tank-own-model"
    assert "evil.example" not in json.dumps(written)
    # a race car body still needs a real 3D model
    spec["world"]["entities"][-2]["car"] = "player"
    car = tools.run_tool(ctx, session, "make_game", {"spec": spec, "cast_ip_ids": cast})
    assert car["error"] == "missing_set_piece_asset", car


def test_make_game_animated_player_enemies_and_weapons(ctx, session):
    sid = session["sessionId"]
    for ip_id in ("ip_hero", "ip_ghoul", "ip_wasp", "ip_blade", "ip_flat"):
        _add_ip(ctx, sid, ip_id, ip_id.encode())
    store.update_ip(ctx, sid, "ip_ghoul", kind="enemy", humanoid=True)
    store.update_ip(ctx, sid, "ip_wasp", kind="enemy", humanoid=False)
    store.update_ip(ctx, sid, "ip_flat", kind="enemy", humanoid=True)  # no GLB yet
    store.update_ip(ctx, sid, "ip_blade", kind="weapon", weaponType="gun")
    _glb(ctx, sid, "ip_hero", body=b"hero-raw")
    _glb(ctx, sid, "ip_hero", "rigged_glb", "riggedGlbAssetId", b"hero-rig")
    _glb(ctx, sid, "ip_ghoul", "rigged_glb", "riggedGlbAssetId", b"ghoul-rig")
    _glb(ctx, sid, "ip_wasp", body=b"wasp")
    _glb(ctx, sid, "ip_blade", body=b"blade")
    ctx.s3._store[(BUCKET, "runtime3d/v1/anims/ual.glb")] = b"UAL"
    spec = minimal_sf()
    spec["player"].update(ipId="ip_hero", weaponIpId="ip_blade", weaponUrl="https://evil/x.glb")
    base = spec["enemies"][0]
    spec["enemies"] = [{**base, "ipId": "ip_ghoul", "weaponIpId": "ip_blade"}, {**base, "ipId": "ip_wasp"},
                       {**base, "ipId": "ip_flat"}, {**base, "modelUrl": "https://evil/y.glb", "humanoid": True}]
    spec["animUrl"] = "https://evil/anim.glb"

    out = tools.run_tool(ctx, session, "make_game", {"spec": spec})

    s3, gid = ctx.s3._store, out["gameId"]
    written = json.loads(s3[(BUCKET, f"games/{gid}/spec.json")])
    player, (ghoul, wasp, flat, plain) = written["player"], written["enemies"]
    assert (player["modelUrl"], player["weaponUrl"], player["weaponType"]) == (
        "assets/ip_hero.rig.glb", "assets/ip_blade.glb", "gun")
    assert (ghoul["modelUrl"], ghoul["weaponUrl"], ghoul["humanoid"]) == ("assets/ip_ghoul.rig.glb", "assets/ip_blade.glb", True)
    assert (wasp["modelUrl"], wasp["humanoid"]) == ("assets/ip_wasp.glb", False)
    assert "modelUrl" not in flat and flat["humanoid"] is True
    assert "modelUrl" not in plain and "humanoid" not in plain  # procedural drone
    assert written["animUrl"] == "assets/ual.glb"
    assert s3[(BUCKET, f"games/{gid}/assets/ip_hero.rig.glb")] == b"hero-rig"
    assert s3[(BUCKET, f"games/{gid}/assets/ip_ghoul.rig.glb")] == b"ghoul-rig"
    assert s3[(BUCKET, f"games/{gid}/assets/ip_wasp.glb")] == b"wasp"
    assert s3[(BUCKET, f"games/{gid}/assets/ip_blade.glb")] == b"blade"
    assert s3[(BUCKET, f"games/{gid}/assets/ual.glb")] == b"UAL"
    # the raw mesh rides along as the runtime's fallback for a broken rig; none for the ghoul
    assert s3[(BUCKET, f"games/{gid}/assets/ip_hero.glb")] == b"hero-raw"
    assert (BUCKET, f"games/{gid}/assets/ip_ghoul.glb") not in s3


def test_make_game_unrigged_falls_back_to_glb_without_anim(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _glb(ctx, sid, "ip_hero")
    spec = minimal_sf()
    spec["player"]["ipId"] = "ip_hero"
    out = tools.run_tool(ctx, session, "make_game", {"spec": spec})
    written = json.loads(ctx.s3._store[(BUCKET, f"games/{out['gameId']}/spec.json")])
    assert written["player"]["modelUrl"] == "assets/ip_hero.glb" and "animUrl" not in written
    assert "weaponUrl" not in written["player"]


def test_make_skill_asset_makes_the_image_then_registers_its_3d(ctx, session, fake_image):
    out = tools.run_tool(ctx, session, "make_skill_asset", {"kind": "prop", "name": "타이어 방벽 (레이싱)",
                                                            "description": "a stack of racing tyres"})
    assert out["ipId"].startswith("ip_") and out["meshJobId"]
    snap = store.snapshot(ctx, session["sessionId"])
    assert [i["name"] for i in snap["ips"]] == ["타이어 방벽 (레이싱)"]
    mesh = next(j for j in snap["jobs"] if j["jobId"] == out["meshJobId"])
    assert mesh["kind"] == "mesh3d" and mesh["deps"] == [out["jobId"]]  # waits for the image job, then starts
    assert mesh["input"]["cutoutKey"] == f"sessions/{session['sessionId']}/{out['jobId']}-cutout.png"
    assert "make_skill_asset" not in {t["toolSpec"]["name"] if "toolSpec" in t else t["name"] for t in tools.TOOL_SPECS}
