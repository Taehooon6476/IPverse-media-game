"""A tool takes an argument that cannot matter for its call and leaves it out, instead of refusing the call.

An argument the call would not have used is dropped (`humanoid` on a character says nothing the tool does not know);
one that changes what is made (an unknown model, a last frame the model cannot take, a background that is no prop) is
still refused."""
import json

import pytest

from server import agent, jobs, store, tools
from server.tests.conftest import FakeBedrockRT, FakeProvider, FakeS3, FakeTable, make_ctx
from server.tests.fake_gpu import Clock, FakeImageBox
from server.tests.test_agent import _final, _tool_use, _turn
from server.tests.test_gamespec import minimal_sf
from server.tests.test_tools import BUCKET, RUNTIME3D, _add_ip, _glb, _job, _session
from server.tests.test_video_edit import mcp  # noqa: F401 (fixture)


@pytest.fixture
def ctx():
    c = make_ctx(table=FakeTable(), s3=FakeS3())
    for name in RUNTIME3D:
        c.s3._store[(BUCKET, f"runtime3d/v1/{name}")] = name.encode()
    return c


@pytest.fixture
def session(ctx):
    return _session(ctx)


@pytest.fixture
def box(monkeypatch):
    fake = FakeImageBox(Clock(), gen_sec=0, swap_sec=0).install(monkeypatch)
    monkeypatch.setitem(jobs.PROVIDERS, "mediagen_video", FakeProvider("mediagen_video"))
    return fake


def _ips(ctx, session):
    return {ip["name"]: ip for ip in store.snapshot(ctx, session["sessionId"])["ips"]}


# ── 캐릭터 만들기 ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("kind,extra", [
    ("character", {"humanoid": True}),
    ("character", {"humanoid": False}),  # a character is drawn standing whatever this says
    ("prop", {"humanoid": True}),
    ("weapon", {"humanoid": False}),
    ("character", {"weapon_type": "gun"}),
    ("prop", {"weapon_type": "melee"}),
    ("enemy", {"weapon_type": "gun"}),
    ("character", {"humanoid": "yes", "weapon_type": "bow"}),  # not even read where it says nothing
])
def test_an_argument_that_says_nothing_for_this_kind_is_left_out(ctx, session, box, kind, extra):
    made = tools.run_tool(ctx, session, "create_ip_asset", {"kind": kind, "name": "꼬마 마법사",
                                                            "description": "a small wizard in a big hat", **extra})
    assert "error" not in made and made["ipId"].startswith("ip_")
    ip = _ips(ctx, session)["꼬마 마법사"]
    assert ip["kind"] == kind
    assert ("humanoid" in ip) == (kind == "enemy") and ("weaponType" in ip) == (kind == "weapon")
    prompt = _job(ctx, session["sessionId"], made["jobId"])["input"]["prompt"]
    assert ("A-pose" in prompt) == (kind in ("character", "enemy"))  # drawn as its kind is drawn


def test_what_the_argument_is_for_still_takes_it(ctx, session, box):
    drone = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "enemy", "name": "드론", "humanoid": False,
                                                             "description": "a wasp drone"})
    gun = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "weapon", "name": "블래스터", "weapon_type": "gun",
                                                           "description": "a chunky pistol"})
    ips = _ips(ctx, session)
    assert "error" not in drone and ips["드론"]["humanoid"] is False
    assert "error" not in gun and ips["블래스터"]["weaponType"] == "gun"


@pytest.mark.parametrize("bad", [
    {"kind": "enemy", "humanoid": "yes"},        # how the enemy stands and moves: the tool cannot guess
    {"kind": "weapon", "weapon_type": "bow"},    # which hand rig: neither melee nor gun
    {"kind": "character", "usage": "background"},  # a whole scene is a prop: this call contradicts itself
    {"kind": "vehicle"},
])
def test_an_argument_that_changes_what_is_made_is_still_refused(ctx, session, box, bad):
    out = tools.run_tool(ctx, session, "create_ip_asset", {"name": "X", "description": "x", **bad})
    assert out["error"] == "bad_args", bad
    assert store.snapshot(ctx, session["sessionId"])["ips"] == []


def test_the_first_call_of_a_new_session_leaves_no_failure_in_the_work_log(monkeypatch):
    """One character asked for, and the model sends humanoid with it."""
    model = FakeBedrockRT([_tool_use("create_ip_asset", {"kind": "character", "name": "꼬마 마법사", "humanoid": True,
                                                         "description": "a small wizard in a big hat"}),
                           _final("꼬마 마법사 그림을 그리고 있어요.")])
    c = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=model)
    FakeImageBox(Clock(), gen_sec=0, swap_sec=0).install(monkeypatch)
    sid, pending = _turn(c, "꼬마 마법사 그려줘")

    agent.run_turn(c, sid, pending["messageId"])

    events = [e["summary"] for e in store.snapshot(c, sid)["messages"][-1]["toolEvents"]]
    assert events == ["캐릭터 만들기: 꼬마 마법사"]
    assert len(model.calls) == 2  # no second try


# ── the other tools ───────────────────────────────────────────────────────────

def test_a_length_given_to_a_shot_model_with_a_fixed_length_is_left_out(ctx, session):
    """MiniMax H3 and Kandinsky make 5 seconds whatever is asked: a length out of LTX's range is no reason to refuse."""
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    base = {"ipId": "ip_hero", "prompt": "orbit", "aspect_ratio": "16:9"}
    for model in ("minimax-h3", "kandinsky-6-0-video-pro"):
        for duration in (30, 1, "5s", True):
            out = tools.run_tool(ctx, session, "make_video_shot", {**base, "model": model, "duration": duration})
            assert "error" not in out, (model, duration)
            assert _job(ctx, sid, out["jobId"])["input"]["seconds"] == 5
    for duration in (21, 1, "5s", True):  # LTX makes what is asked: there it matters
        assert tools.run_tool(ctx, session, "make_video_shot", {**base, "duration": duration})["error"] == "bad_args"


def test_an_empty_cast_list_is_no_cast(ctx, session):
    """cast_ip_ids [] names nobody: the game is made as with no list (the cast rule needs at least one IP to hold)."""
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _glb(ctx, sid, "ip_hero")
    spec = minimal_sf()
    spec["player"]["ipId"] = "ip_hero"
    made = tools.run_tool(ctx, session, "make_game", {"spec": spec, "cast_ip_ids": []})
    assert "error" not in made
    game = next(g for g in store.snapshot(ctx, sid)["games"] if g["gameId"] == made["gameId"])
    assert "castIpIds" not in game
    # a list that names something that is no id is still refused
    assert tools.run_tool(ctx, session, "make_game", {"spec": spec, "cast_ip_ids": [{"ipId": "ip_hero"}]})["error"] == "bad_args"
    assert tools.run_tool(ctx, session, "make_game", {"spec": spec, "cast_ip_ids": "ip_hero"})["error"] == "bad_args"


def test_a_model_given_to_3d_that_will_not_use_it_is_left_out(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    mesh = jobs.create_job(ctx, sid, "mesh3d", "img3d", {"ipId": "ip_hero"}, [])
    glb = store.put_asset(ctx, sid, {"kind": "glb", "key": f"sessions/{sid}/{mesh['jobId']}.glb", "jobId": mesh["jobId"],
                                     "ipId": "ip_hero", "contentType": "model/gltf-binary"})
    store.update_job(ctx, sid, mesh["jobId"], status="done", outputs=[glb["assetId"]])
    store.update_ip(ctx, sid, "ip_hero", glbAssetId=glb["assetId"])
    # the skeleton alone, on the model there is: no model is made
    again = tools.run_tool(ctx, session, "render_3d", {"ipId": "ip_hero", "rig_only": True, "model": "hunyuan"})
    assert "error" not in again and again["rigJobId"]
    # a whole scene is always made as a panel
    _add_ip(ctx, sid, "ip_forest", b"FOREST")
    store.update_ip(ctx, sid, "ip_forest", kind="prop", usage="background")
    scene = tools.run_tool(ctx, session, "render_3d", {"ipId": "ip_forest", "model": "hunyuan"})
    assert "error" not in scene and scene["model"] == "relief"
    # where the model is what gets made, an unknown one is still refused
    assert tools.run_tool(ctx, session, "render_3d", {"ipId": "ip_hero", "model": "hunyuan"})["error"] == "bad_args"


def test_a_model_given_to_a_video_edit_that_has_one_model_is_left_out(ctx, session, mcp):  # noqa: F811
    """model is the restyle's choice (LTX or Wan); v2v and inpaint run on LTX whatever is said."""
    sid = session["sessionId"]
    shot = jobs.create_job(ctx, sid, "shot", "mediagen_video", {"prompt": "orbit", "seconds": 5, "model": "ltx"}, [])
    for edit, extra in (("v2v", {"task": "deblur"}), ("inpaint", {})):
        out = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": shot["jobId"], "edit": edit,
                                                               "prompt": "the same scene", "model": "wan-animate", **extra})
        assert "error" not in out, (edit, out)
        assert _job(ctx, sid, out["jobId"])["input"]["model"] == "ltx"
    # a restyle picks between two: an unknown one is still refused
    bad = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": shot["jobId"], "edit": "restyle",
                                                           "prompt": "watercolor", "style": "watercolor", "model": "luma"})
    assert bad["error"] == "bad_args"


def test_the_tools_say_in_their_specs_which_arguments_are_only_for_some_calls():
    """What is left out is what the spec already calls "only for": the model reads the same rule."""
    spec = {s["name"]: s["inputSchema"]["json"]["properties"] for s in tools.TOOL_SPECS}
    assert spec["create_ip_asset"]["humanoid"]["description"].startswith("enemy만")
    assert spec["create_ip_asset"]["weapon_type"]["description"].startswith("weapon만")
    assert "restyle만" in spec["edit_video_shot"]["model"]["description"]
    assert json.dumps(spec["create_ip_asset"], ensure_ascii=False).count("다른 kind에서는 무시") == 2
