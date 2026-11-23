"""A game waits for 3D: make_game needs the player's 3D finished (a GLB, and its rig when a rig job is still queued or
running), and at least one cast IP in 3D besides the background and set pieces. A game made earlier would show the
protagonist as a flat cutout panel, which refresh_game_assets cannot turn into her model."""
import json

import pytest

from server import agent, jobs, prompts, store, tools
from server.tests.conftest import FakeS3, FakeTable, make_ctx
from server.tests.test_gamespec import authored_spec, minimal_sf
from server.tests.test_tools import BUCKET, RUNTIME, RUNTIME3D, _add_ip, _glb, _session


@pytest.fixture
def ctx():
    c = make_ctx(table=FakeTable(), s3=FakeS3())
    for name in RUNTIME3D:
        c.s3._store[(BUCKET, f"runtime3d/v1/{name}")] = name.encode()
    for name in RUNTIME:
        c.s3._store[(BUCKET, f"runtime/v1/{name}")] = name.encode()
    return c


@pytest.fixture
def session(ctx):
    return _session(ctx)


def _spec(player="ip_hero", props=("ip_core",)):
    spec = minimal_sf()
    spec["player"]["ipId"] = player
    spec["props"] = [{"ipId": p, "name": p, "effect": "score"} for p in props]
    return spec


def _three_d_job(ctx, sid, kind, ip_id, status="running", progress=None):
    job = jobs.create_job(ctx, sid, kind, "img3d" if kind == "mesh3d" else "rig", {"ipId": ip_id}, [])
    store.update_job(ctx, sid, job["jobId"], status=status, **({"progress": progress} if progress else {}))
    return job


def test_no_3d_at_all_is_refused_and_says_no_3d_was_started(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _add_ip(ctx, sid, "ip_core", b"CORE")
    store.update_ip(ctx, sid, "ip_core", kind="prop")
    out = tools.run_tool(ctx, session, "make_game", {"spec": _spec()})
    assert out["error"] == "needs_3d", out
    assert "ip_hero" in out["message"] and "3D를 시작하지 않았" in out["message"]
    assert "render_3d" in out["message"] and "납작한 그림 판" in out["message"]
    assert [w["state"] for w in out["waiting3d"]] == ["none"]
    assert store.snapshot(ctx, sid)["games"] == []


def test_a_3d_still_running_is_refused_with_its_phase_and_eta(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _add_ip(ctx, sid, "ip_core", b"CORE")
    _three_d_job(ctx, sid, "mesh3d", "ip_hero", progress="GPU 부팅 중")
    _three_d_job(ctx, sid, "rig", "ip_hero", status="queued")
    out = tools.run_tool(ctx, session, "make_game", {"spec": _spec()})
    assert out["error"] == "needs_3d", out
    [hero] = out["waiting3d"]
    assert (hero["ipId"], hero["state"], hero["phase"]) == ("ip_hero", "running", "3D 모델")  # the card's name
    assert hero["etaMinutes"] == 12  # mesh ~8 + rig ~4
    assert "3D 모델 단계" in out["message"] and "약 12분" in out["message"] and "GPU 부팅 중" in out["message"]
    assert "다시 부르지" in out["message"]  # the agent waits for it instead of re-calling or making a cutout game


def test_the_player_with_a_finished_3d_makes_the_game(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _add_ip(ctx, sid, "ip_core", b"CORE")  # a prop without 3D may still stand as its cutout
    _glb(ctx, sid, "ip_hero")
    out = tools.run_tool(ctx, session, "make_game", {"spec": _spec()})
    assert "error" not in out, out
    written = json.loads(ctx.s3._store[(BUCKET, f"games/{out['gameId']}/spec.json")])
    assert written["player"]["modelUrl"] == "assets/ip_hero.glb"


def test_the_player_rule_another_ip_in_3d_is_not_enough(ctx, session):
    """The protagonist is on screen the whole game: a 3D enemy next to a flat hero is the bug itself."""
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _add_ip(ctx, sid, "ip_core", b"CORE")
    store.update_ip(ctx, sid, "ip_core", kind="prop")
    _glb(ctx, sid, "ip_core")
    out = tools.run_tool(ctx, session, "make_game", {"spec": _spec()})
    assert out["error"] == "needs_3d", out
    assert "주인공" in out["message"]
    assert [w["ipId"] for w in out["waiting3d"]] == ["ip_hero"]


def test_a_player_whose_rig_is_still_running_waits_for_it(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _glb(ctx, sid, "ip_hero")  # the mesh landed, the rig has not
    rig = _three_d_job(ctx, sid, "rig", "ip_hero")
    out = tools.run_tool(ctx, session, "make_game", {"spec": _spec(props=())})
    assert out["error"] == "needs_3d" and out["waiting3d"][0]["phase"] == "움직임 뼈대", out
    store.update_job(ctx, sid, rig["jobId"], status="failed", error="리깅 실패")  # a failed rig: the raw mesh plays
    assert "error" not in tools.run_tool(ctx, session, "make_game", {"spec": _spec(props=())})


def test_a_rig_redone_over_an_existing_rig_does_not_block(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _glb(ctx, sid, "ip_hero")
    _glb(ctx, sid, "ip_hero", "rigged_glb", "riggedGlbAssetId")
    _three_d_job(ctx, sid, "rig", "ip_hero", status="queued")  # rig_only: the current rig plays meanwhile
    assert "error" not in tools.run_tool(ctx, session, "make_game", {"spec": _spec(props=())})


def test_backgrounds_and_set_pieces_do_not_count(ctx, session):
    """The background's or a set piece's 3D is not the 3D the game needs: the player stays a cutout without its own."""
    sid = session["sessionId"]
    for ip_id in ("ip_hero", "ip_core", "ip_mentor", "ip_tank", "ip_bg"):
        _add_ip(ctx, sid, ip_id, ip_id.encode())
    for ip_id in ("ip_core", "ip_tank", "ip_bg"):
        store.update_ip(ctx, sid, ip_id, kind="prop")
    store.update_ip(ctx, sid, "ip_bg", usage="background")
    _glb(ctx, sid, "ip_tank")
    _glb(ctx, sid, "ip_bg", body=b"glTF" + (2).to_bytes(4, "little") + (20).to_bytes(4, "little") + b"\0" * 8)
    spec = authored_spec()
    spec["player"]["ipId"] = "ip_hero"
    spec["props"][1]["ipId"] = "ip_mentor"
    spec["world"]["entities"].append({"id": "tank", "kind": "model", "ipId": "ip_tank", "x": 5, "z": -17,
                                      "width": 3, "depth": 3, "height": 2})
    spec["world"]["background"] = {"ipId": "ip_bg", "mode": "model"}
    out = tools.run_tool(ctx, session, "make_game", {"spec": spec})
    assert out["error"] == "needs_3d", out
    assert {w["ipId"] for w in out["waiting3d"]} == {"ip_hero"}
    assert tools.ready_3d_for_game(store.get_ip(ctx, sid, "ip_tank"),
                                   {a["assetId"]: a for a in store.snapshot(ctx, sid)["assets"]}, {})


def test_a_v1_game_without_an_ip_player_needs_one_cast_ip_in_3d(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_core", b"CORE")
    store.update_ip(ctx, sid, "ip_core", kind="prop")
    spec = _spec(player=None)
    spec["player"].pop("ipId")
    out = tools.run_tool(ctx, session, "make_game", {"spec": spec})
    assert out["error"] == "needs_3d" and "하나도" in out["message"], out
    _glb(ctx, sid, "ip_core")
    assert "error" not in tools.run_tool(ctx, session, "make_game", {"spec": spec})


def test_a_2d_phaser_game_is_made_of_cutouts_and_is_not_gated(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    assert "error" not in tools.run_tool(ctx, session, "make_game", {"spec": _spec(props=()), "engine": "phaser"})


def test_the_state_tells_the_agent_each_ips_3d_for_a_game(ctx, session):
    sid = session["sessionId"]
    for ip_id in ("ip_hero", "ip_core", "ip_mentor"):
        _add_ip(ctx, sid, ip_id, ip_id.encode())
    _glb(ctx, sid, "ip_hero")
    _three_d_job(ctx, sid, "mesh3d", "ip_core")
    ips = {i["ipId"]: i for i in json.loads(agent.state_summary(store.snapshot(ctx, sid)))["ips"]}
    assert (ips["ip_hero"]["game3d"], ips["ip_core"]["game3d"], ips["ip_mentor"]["game3d"]) == ("ready", "running", "none")


def test_the_prompt_says_a_game_needs_a_finished_3d():
    s = prompts.SYSTEM
    assert "make_game은 3D가 끝난 출연 IP가 하나 이상" in s
    assert "주인공(player)은 3D가 끝난 IP" in s
    assert "needs_3d" in s and "납작한 그림 게임을 먼저 만들지 않는다" in s
    # the game request is held until the 3D ends, not merely promised
    assert "hold_game_request(ipId=주인공)로 그 게임 요청을 보류한다" in s
    # no rule sends cutout games out while 3D still runs
    assert "3D가 진행 중이거나 없다는 이유로 게임을 다음 턴으로 미루지 않는다" not in s
    assert "3D가 없는 IP는 컷아웃으로 나온다)" not in s
