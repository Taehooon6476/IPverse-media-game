"""The image and 3D track on a fake image GPU box and a fake clock (no network).

- A 3D remake re-runs the mesh on the current picture with no redraw; an edit that fails its frame check never
  replaces a good version.
- Krea's frame is a fixed 1216x688 landscape, so a weapon is drawn lying along it and stood up in its cutout.
- A background's 3D is a relief of the whole scene, never a Hunyuan3D mesh (which makes one object).
"""
import json

import pytest

from server import agent, prompts, store, tools
from server.providers import cutout, mediagen_image as mi
from server.tests.conftest import FakeS3, FakeTable, make_ctx
from server.tests.test_cutout import alpha_box, png_rgba, sword
from server.tests.test_image_jobs import _concept, _create, _ip, _job, _poll, _snap, world  # noqa: F401 (fixture)

BUCKET = "test-assets"
CUT_TOP = png_rgba(sword(top=0))  # background removal of a draw whose blade runs off the top edge
# a sword lying along the wide frame: grip at the left (x 5–22), guard (x 22–30), blade to the right (x 30–200)
LYING = [(30, 75, 200, 85, 255), (22, 60, 30, 100, 255), (5, 77, 22, 83, 255)]
KATANA = ("plasma katana, black handle wrapped in magenta cord, ornate tsuba, blade made of glowing cyan plasma "
          "energy, sleek cyberpunk sword, vertical, handle at bottom")  # a description as the agent writes it


def _state(w):
    return json.loads(agent.state_summary(_snap(w)))


def _assets(w):
    return {a["assetId"]: a for a in _snap(w)["assets"]}


def _bytes(w, key):
    return w["ctx"].s3._store[(BUCKET, key)]


# ── a 3D remake re-runs the mesh on the picture there is ──────────────────────


@pytest.mark.parametrize("kind", ["weapon", "prop"])
def test_n4_remaking_a_weapons_3d_reruns_the_mesh_on_its_current_cutout_with_no_redraw(world, kind):
    _concept(world)
    sword_ip = _create(world, "마법검", kind=kind)
    _poll(world)
    ip = _ip(world, sword_ip["ipId"])
    before = len(world["box"].starts)

    out = tools.run_tool(world["ctx"], world["session"], "render_3d", {"ipId": sword_ip["ipId"]})

    new = [j for j in _snap(world)["jobs"] if j["jobId"] != sword_ip["jobId"]]
    assert sorted(j["kind"] for j in new) == ["mesh3d", "render3d"]  # no image, variant or A-pose job for an object
    mesh = _job(world, out["meshJobId"])
    assert (mesh["deps"], mesh["input"]["cutoutKey"]) == ([], _assets(world)[ip["cutoutAssetId"]]["key"])
    _poll(world)
    assert len(world["box"].starts) == before  # nothing was drawn again


def test_n4_the_prompt_says_a_3d_remake_calls_render_3d_alone_and_never_edits_the_picture_first():
    s = prompts.SYSTEM
    assert "3D를 다시 만들어 달라는 요청" in s and "make_ip_variant로 그림을 먼저 고치지 않는다" in s
    spec = next(t for t in tools.TOOL_SPECS if t["name"] == "render_3d")["description"]
    assert "그림을 먼저 고치지 않는다" in spec


def test_n4_an_edit_of_a_weapon_or_prop_keeps_the_object_alone_and_a_character_edit_keeps_the_face(world):
    _concept(world)
    sword_ip, hero = _create(world, "마법검", kind="weapon"), _create(world, "기사")
    _poll(world)
    ctx, session = world["ctx"], world["session"]
    edits = [tools.run_tool(ctx, session, "make_ip_variant", {"ipId": sword_ip["ipId"], "prompt": "a clean simple silhouette"}),
             tools.run_tool(ctx, session, "make_ip_variant", {"ipId": hero["ipId"], "prompt": "a red cape"})]
    edit_sword, edit_hero = (_job(world, e["jobId"])["input"]["prompt"] for e in edits)
    assert "face" not in edit_sword and "no person" in edit_sword and "no hands" in edit_sword  # or klein draws a person holding it
    assert "a clean simple silhouette" in edit_sword and "same head and face" in edit_hero


def test_n4_an_edit_that_fails_its_check_twice_keeps_the_previous_version_and_the_chained_3d_meshes_it(world):
    _concept(world)
    ctx, session, sid = world["ctx"], world["session"], world["sid"]
    made = _create(world, "마법검", kind="weapon")
    _poll(world)
    v1 = _ip(world, made["ipId"])
    world["cutouts"].update({b"\x89PNG-g2": CUT_TOP, b"\x89PNG-g3": CUT_TOP})  # the edit and its redraw: both cut
    edit = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": made["ipId"], "prompt": "a clean simple silhouette"})
    remake = tools.run_tool(ctx, session, "render_3d", {"ipId": made["ipId"]})  # chained on the edit

    _poll(world)

    ip, assets, job = _ip(world, made["ipId"]), _assets(world), _job(world, edit["jobId"])
    assert (ip["imageAssetId"], ip["cutoutAssetId"], ip["version"]) == (v1["imageAssetId"], v1["cutoutAssetId"], 1)
    assert len(world["box"].starts) == 3 and job["status"] == "done"
    assert job["error"].startswith(mi.CHECK_FAILED) and "위쪽이 프레임에 잘림" in job["error"]
    assert "v2" in job["error"] and "v1" in job["error"]  # 작업 현황 shows a done job's error line
    v2 = next(a for a in assets.values() if a["kind"] == "image" and a.get("jobId") == edit["jobId"])
    v2_cut = next(a for a in assets.values() if a["kind"] == "cutout" and a.get("jobId") == edit["jobId"])
    assert (v2["meta"]["version"], v2["meta"]["check"]["ok"], v2_cut["meta"]["forAssetId"]) == (2, False, v2["assetId"])
    assert _bytes(world, v2["key"]) == b"\x89PNG-g3"  # the rejected draw stays as a version (버전 기록)
    # what the 3D chained on the edit reads is the picture the IP kept, not the rejected draw
    mesh = _job(world, remake["meshJobId"])
    assert mesh["input"]["cutoutKey"] == mi.cutout_key(sid, edit["jobId"]) and mesh["status"] == "done"
    assert _bytes(world, mi.cutout_key(sid, edit["jobId"])) == _bytes(world, assets[v1["cutoutAssetId"]]["key"])
    assert _bytes(world, mi.image_key(sid, edit["jobId"])) == _bytes(world, assets[v1["imageAssetId"]]["key"])
    state = _state(world)
    assert next(j for j in state["jobs"] if j["jobId"] == edit["jobId"])["error"] == job["error"]  # the agent sees it
    assert "image" not in next(i for i in state["ips"] if i["ipId"] == made["ipId"])  # v1 itself is fine

    # the user may still pick the rejected draw: then the IP's picture is the one that failed its check
    tools.run_tool(ctx, session, "restore_ip_version", {"ipId": made["ipId"], "imageAssetId": v2["assetId"]})
    assert next(i for i in _state(world)["ips"] if i["ipId"] == made["ipId"])["image"] == "check_failed"


# ── a long weapon lies along the wide frame; a redraw is framed differently ──


def test_n0_a_weapon_is_drawn_lying_along_the_wide_frame_without_the_agents_upright_words(world):
    _concept(world)
    out = _create(world, "플라즈마 카타나", kind="weapon", description=KATANA)
    prompt = _job(world, out["jobId"])["input"]["prompt"]
    assert "lying horizontally across the wide frame" in prompt and "at the left end" in prompt
    assert "the whole object from end to end inside the frame" in prompt
    for upright in ("vertical", "handle at bottom", "upright", "pointing up", "at the bottom"):
        assert upright not in prompt, upright
    assert "ornate tsuba" in prompt and "sleek cyberpunk sword" in prompt  # the look itself stays
    assert _job(world, out["jobId"])["input"]["kind"] == "weapon"


@pytest.mark.parametrize("text,kept", [
    ("A dark fantasy enchanted longsword, leather-wrapped grip with a dark red gem pommel, vertical orientation with "
     "handle at the bottom, isolated on plain background",
     "A dark fantasy enchanted longsword, leather-wrapped grip with a dark red gem pommel, isolated on plain background"),
    ("A large black steel greatsword, long hilt with leather-wrapped grip pointing downward, single weapon isolated",
     "A large black steel greatsword, long hilt with leather-wrapped grip, single weapon isolated"),
    ("futuristic plasma pistol, grip pointing down, side view, single object",
     "futuristic plasma pistol, grip, side view, single object"),
    (KATANA, KATANA.replace(", vertical, handle at bottom", "")),
])
def test_n0_the_upright_words_the_agent_wrote_into_weapon_descriptions_are_dropped(text, kept):
    assert tools._lying(text) == kept


def test_n0_a_weapon_drawn_lying_down_is_stood_up_in_its_cutout_grip_at_the_bottom():
    lying = png_rgba(LYING)
    up = cutout.stand_up(lying)
    width, height, _ = cutout._read(up)
    assert (width, height) == (160, 240)
    x0, y0, x1, y1 = alpha_box(up)
    assert (x0, y0, x1, y1) == (60, 239 - 199, 99, 239 - 5)  # a quarter turn left: old (x, y) is now (y, 239 - x)
    _, _, rows = cutout._read(up)
    alpha = lambda x, y: rows[y][x * 4 + 3]  # noqa: E731
    assert alpha(80, 230) == 255 and alpha(65, 230) == 0  # the thin grip end is at the bottom...
    assert alpha(62, 212) == 255 and alpha(80, 45) == 255  # ...the guard just above it, the blade up to the top
    standing = png_rgba(sword())
    assert cutout.stand_up(standing) == standing and cutout.stand_up(b"JPEG?") == b"JPEG?"


def test_n0_a_weapon_job_keeps_its_picture_and_stands_its_cutout_up_for_the_3d_mesh(world):
    _concept(world)
    world["cutouts"].update({b"\x89PNG-g1": png_rgba(LYING), b"\x89PNG-g2": png_rgba(LYING)})
    out = _create(world, "플라즈마 카타나", kind="weapon", description=KATANA)
    prop = _create(world, "통나무", kind="prop")  # a lying prop stays as drawn: the game places and sizes props as drawn
    _poll(world)
    assets, ip = _assets(world), _ip(world, out["ipId"])
    image, cut = assets[ip["imageAssetId"]], assets[ip["cutoutAssetId"]]
    assert _bytes(world, image["key"]).startswith(b"\x89PNG-g") and image["meta"]["check"]["ok"] is True
    x0, y0, x1, y1 = alpha_box(_bytes(world, cut["key"]))
    assert y1 - y0 > x1 - x0  # standing: Hunyuan3D gets the upright weapon the game's mount expects
    prop_cut = assets[_ip(world, prop["ipId"])["cutoutAssetId"]]
    x0, y0, x1, y1 = alpha_box(_bytes(world, prop_cut["key"]))
    assert x1 - x0 > y1 - y0


def test_n0_a_long_prop_is_laid_along_the_wide_frame_by_its_description_and_stays_as_drawn(world):
    s = prompts.SYSTEM
    assert "가늘고 긴 소품" in s and "lying horizontally across the frame" in s
    described = next(t for t in tools.TOOL_SPECS if t["name"] == "create_ip_asset")["inputSchema"]["json"][
        "properties"]["description"]["description"]
    assert "무기에는" in described  # no orientation words is the weapon's rule: a long prop says it lies down
    _concept(world)
    oar = _create(world, "노", kind="prop", description="a long wooden rowing oar, lying horizontally across the frame")
    prompt = _job(world, oar["jobId"])["input"]["prompt"]
    assert "a long wooden rowing oar, lying horizontally across the frame." in prompt  # kept, unlike a weapon's
    assert "small enough that its full height fits" in prompt  # a tall prop that stands stays upright, smaller


def test_the_check_notice_says_the_redraw_failed_too_and_which_picture_is_used():
    check = {"problem": "위쪽·아래쪽이 프레임에 잘림"}
    assert mi.check_note(check, 2, 3, 2) == ("구도 검사 실패: 위쪽·아래쪽이 프레임에 잘림(2번 그려도 같음). "
                                           "새 그림(v3)은 버전 기록에만 두고 지금 그림(v2)을 그대로 써요.")
    assert mi.check_note(check) == "구도 검사 실패: 위쪽·아래쪽이 프레임에 잘림. 첫 그림이라 그대로 두었으니 다시 뽑아 주세요."
    assert "아직 알리지 않았으면" in prompts.SYSTEM  # the error stays on the job: the agent tells it once


def test_n0_the_redraw_after_a_failed_check_asks_for_another_framing(world):
    _concept(world)
    world["cutouts"][b"\x89PNG-g1"] = CUT_TOP
    _create(world, "플라즈마 카타나", kind="weapon", description=KATANA)
    _poll(world)
    first, second = world["box"].starts
    assert second["prompt"].startswith(first["prompt"]) and second["prompt"] != first["prompt"]
    assert "zoomed out" in second["prompt"] and "zoomed out" not in first["prompt"]
    assert first["prompt"].endswith("no text") and "no text. Redraw zoomed out:" in second["prompt"]  # a new sentence
    assert _job(world, _snap(world)["jobs"][0]["jobId"])["error"] == ""  # the redraw passed: no notice


def test_n0_a_first_picture_that_fails_its_check_twice_is_kept_and_the_job_and_the_ip_say_so(world):
    _concept(world)
    world["cutouts"].update({b"\x89PNG-g1": CUT_TOP, b"\x89PNG-g2": CUT_TOP})
    out = _create(world, "플라즈마 카타나", kind="weapon", description=KATANA)
    _poll(world)
    ip, job = _ip(world, out["ipId"]), _job(world, out["jobId"])
    assert ip["imageAssetId"] and ip["version"] == 1  # nothing earlier to keep
    assert job["status"] == "done" and job["error"].startswith(mi.CHECK_FAILED) and "다시 뽑" in job["error"]
    state = _state(world)
    assert next(i for i in state["ips"] if i["ipId"] == out["ipId"])["image"] == "check_failed"
    assert next(j for j in state["jobs"] if j["jobId"] == out["jobId"])["error"] == job["error"]
    remake = tools.run_tool(world["ctx"], world["session"], "render_3d", {"ipId": out["ipId"]})
    assert "jobId" in remake and job["error"] in remake["warning"]  # the agent tells the user before the 3D lands
    assert tools.image_state(ip, {}) is None and "check_failed" in prompts.SYSTEM


def test_n0_a_reroll_of_an_old_upright_weapon_redraws_it_with_todays_framing(world):
    _concept(world)
    ctx, session, sid = world["ctx"], world["session"], world["sid"]
    old = "Single product render of ONE weapon or tool, 플라즈마 카타나: x. Exactly one object standing upright"
    image = store.put_asset(ctx, sid, {"kind": "image", "key": f"sessions/{sid}/k.png", "contentType": "image/png",
                                       "ipId": "ip_k", "meta": {"model": "krea", "prompt": old, "version": 1}})
    cut = store.put_asset(ctx, sid, {"kind": "cutout", "key": f"sessions/{sid}/k-cut.png", "contentType": "image/png",
                                     "ipId": "ip_k", "meta": {"forAssetId": image["assetId"]}})
    store.put_ip(ctx, sid, {"ipId": "ip_k", "kind": "weapon", "weaponType": "melee", "name": "플라즈마 카타나",
                            "description": KATANA, "version": 1, "imageAssetId": image["assetId"],
                            "cutoutAssetId": cut["assetId"]})

    out = tools.run_tool(ctx, session, "reroll_ip_image", {"ipId": "ip_k"})

    prompt = _job(world, out["jobId"])["input"]["prompt"]
    assert "standing upright" not in prompt and "lying horizontally across the wide frame" in prompt


def test_n0_a_reroll_that_fails_its_check_keeps_the_current_picture(world):
    _concept(world)
    made = _create(world, "플라즈마 카타나", kind="weapon", description=KATANA)
    _poll(world)
    v1 = _ip(world, made["ipId"])
    world["cutouts"].update({b"\x89PNG-g2": CUT_TOP, b"\x89PNG-g3": CUT_TOP})
    out = tools.run_tool(world["ctx"], world["session"], "reroll_ip_image", {"ipId": made["ipId"]})
    _poll(world)
    ip = _ip(world, made["ipId"])
    assert (ip["imageAssetId"], ip["version"]) == (v1["imageAssetId"], 1)
    assert _job(world, out["jobId"])["error"].startswith(mi.CHECK_FAILED)


# ── Stable Image Ultra: no redraw, the same rule ───────────────────────────────


@pytest.fixture
def stability(monkeypatch):
    ctx = make_ctx(table=FakeTable(), s3=FakeS3())
    session = store.put_session(ctx, "user-1", None, "rpg-explore")
    store.update_session(ctx, session, concept={"title": "t", "logline": "", "style": "dark fantasy", "palette": []})
    cut = {"png": png_rgba(sword())}
    monkeypatch.setattr(tools, "generate_image", lambda *a, **k: b"\xff\xd8JPEG")
    monkeypatch.setattr(tools, "remove_background", lambda ctx, image: cut["png"])
    return ctx, session, cut


def test_a_stability_picture_that_fails_its_check_is_kept_once_and_never_replaces_a_good_one(stability):
    ctx, session, cut = stability
    sid = session["sessionId"]
    cut["png"] = CUT_TOP
    first = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "weapon", "name": "검", "description": "a sword",
                                                              "image_model": "stability-ultra"})
    assert first["imageUrl"] and "위쪽이 프레임에 잘림" in first["message"] and "다시 뽑" in first["message"]

    cut["png"] = png_rgba(sword())
    good = tools.run_tool(ctx, session, "reroll_ip_image", {"ipId": first["ipId"]})
    v2 = store.get_ip(ctx, sid, first["ipId"])
    assert good["version"] == v2["version"] == 2 and "message" not in good
    cut["png"] = CUT_TOP
    bad = tools.run_tool(ctx, session, "reroll_ip_image", {"ipId": first["ipId"]})
    ip = store.get_ip(ctx, sid, first["ipId"])
    assert bad["error"] == "check_failed" and "v3" in bad["message"] and "v2" in bad["message"]
    assert (ip["version"], ip["imageAssetId"], ip["cutoutAssetId"]) == (2, v2["imageAssetId"], v2["cutoutAssetId"])
    versions = sorted(a["meta"].get("version", 1) for a in store.snapshot(ctx, sid)["assets"] if a["kind"] == "image")
    assert versions == [1, 2, 3]  # the rejected draw is kept as a version


# ── a background's 3D is a relief of the scene, and the result says what it is ──


def test_n1_a_background_3d_is_a_25d_relief_of_the_whole_scene_never_a_hunyuan_mesh(world):
    _concept(world)
    ctx, session, sid = world["ctx"], world["session"], world["sid"]
    bg = _create(world, "비 내리는 네온 거리", kind="prop", usage="background")
    asked = tools.run_tool(ctx, session, "render_3d", {"ipId": bg["ipId"]})  # while its picture is still drawn
    _poll(world)
    named = tools.run_tool(ctx, session, "render_3d", {"ipId": bg["ipId"], "model": "hunyuan3d"})

    snap = _snap(world)
    assert not [j for j in snap["jobs"] if j["kind"] in ("mesh3d", "apose", "rig")]  # no object pipeline
    ip = _ip(world, bg["ipId"])
    for out, key in ((asked, mi.cutout_key(sid, bg["jobId"])), (named, _assets(world)[ip["cutoutAssetId"]]["key"])):
        job = _job(world, out["jobId"])
        assert (job["kind"], job["provider"], job["input"]["model"], job["input"]["cutoutKey"]) == (
            "render3d", "deadline", "relief", key)
        assert out["model"] == "relief" and "meshJobId" not in out
        assert "두께만 준 판" in out["message"] and "물체 하나를 3D로" in out["message"] and "mode image" in out["message"]
    assert _bytes(world, mi.cutout_key(sid, bg["jobId"])) == b"\x89PNG-g1"  # the whole scene, not a cutout


def test_n1_the_prompt_says_what_a_background_3d_is():
    s = prompts.SYSTEM
    assert "배경(usage background) IP의 render_3d" in s and "2.5D" in s and "걸어 다닐 수 있는 3D 환경" in s
