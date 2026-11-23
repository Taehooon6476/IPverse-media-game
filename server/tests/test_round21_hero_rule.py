"""Who can be a game's hero is one rule (the 3D gate's, tools._needs_3d): an IP of any kind that can stand in a game
and whose 3D is finished, never a whole-scene background; a character by default, any other IP when the session has
none (tools.hold_heroes). The game design's check, the refusals, the prompt and snapshot.gameHeroes all say it."""
import json

import pytest

from server import game_design, prompts, store, tools
from server.tests.conftest import FakeS3, FakeTable, make_ctx
from server.tests.test_app import _new_session, call, ctx as app_ctx  # noqa: F401 (fixtures)
from server.tests.test_gamespec import minimal_sf
from server.tests.test_round20_errors import plain
from server.tests.test_tools import BUCKET, RUNTIME3D, _add_ip, _glb, _session


@pytest.fixture
def ctx():
    c = make_ctx(table=FakeTable(), s3=FakeS3())
    for name in RUNTIME3D:
        c.s3._store[(BUCKET, f"runtime3d/v1/{name}")] = name.encode()
    return c


@pytest.fixture
def session(ctx):
    return _session(ctx)


def _ip(ctx, sid, ip_id, kind, name, three_d=False, **fields):
    _add_ip(ctx, sid, ip_id, ip_id.encode())
    store.update_ip(ctx, sid, ip_id, kind=kind, name=name, **fields)
    if three_d:
        _glb(ctx, sid, ip_id)


def _heroes(ctx, sid):
    """game_heroes with its ids sorted: IPs made in the same millisecond have no order of their own."""
    heroes = tools.game_heroes(store.snapshot(ctx, sid))
    return {**heroes, "ipIds": sorted(heroes["ipIds"]), "ready": sorted(heroes["ready"])}


# ── the rule ──────────────────────────────────────────────────────────────────

def test_a_session_with_only_a_prop_in_3d_makes_its_game_with_the_prop_as_the_hero(ctx, session):
    """One prop in 3D and no character: the gate takes the prop as the player."""
    sid = session["sessionId"]
    _ip(ctx, sid, "ip_lantern", "prop", "반딧불 등불", three_d=True)
    spec = minimal_sf()
    spec["player"]["ipId"] = "ip_lantern"
    made = tools.run_tool(ctx, session, "make_game", {"spec": spec})
    assert "error" not in made
    written = json.loads(ctx.s3._store[(BUCKET, f"games/{made['gameId']}/spec.json")])
    assert written["player"]["modelUrl"] == "assets/ip_lantern.glb"
    assert _heroes(ctx, sid) == {"ipIds": ["ip_lantern"], "ready": ["ip_lantern"], "noCharacter": True}


def test_the_studio_takes_a_character_when_there_is_one(ctx, session):
    sid = session["sessionId"]
    _ip(ctx, sid, "ip_lantern", "prop", "반딧불 등불", three_d=True)
    _ip(ctx, sid, "ip_wolf", "enemy", "그림자 늑대", three_d=True)
    _ip(ctx, sid, "ip_hero", "character", "꼬마 마법사")
    assert _heroes(ctx, sid) == {"ipIds": ["ip_hero"], "ready": [], "noCharacter": False}
    _glb(ctx, sid, "ip_hero")
    assert _heroes(ctx, sid)["ready"] == ["ip_hero"]


def test_without_a_character_every_ip_that_can_stand_in_a_game_can_be_the_hero(ctx, session):
    sid = session["sessionId"]
    _ip(ctx, sid, "ip_lantern", "prop", "반딧불 등불")
    _ip(ctx, sid, "ip_wolf", "enemy", "그림자 늑대", three_d=True)
    _ip(ctx, sid, "ip_blade", "weapon", "달빛 검")
    _ip(ctx, sid, "ip_forest", "prop", "달빛 숲", three_d=True, usage="background")  # a whole scene is scenery
    assert _heroes(ctx, sid) == {"ipIds": ["ip_blade", "ip_lantern", "ip_wolf"], "ready": ["ip_wolf"], "noCharacter": True}


def test_a_session_with_nothing_to_stand_in_a_game_has_no_hero(ctx, session):
    sid = session["sessionId"]
    assert _heroes(ctx, sid) == {"ipIds": [], "ready": [], "noCharacter": False}
    _ip(ctx, sid, "ip_forest", "prop", "달빛 숲", three_d=True, usage="background")
    assert _heroes(ctx, sid) == {"ipIds": [], "ready": [], "noCharacter": False}


def test_a_whole_scene_is_never_the_hero(ctx, session):
    sid = session["sessionId"]
    _ip(ctx, sid, "ip_forest", "prop", "달빛 숲", three_d=True, usage="background")
    spec = minimal_sf()
    spec["player"]["ipId"] = "ip_forest"
    out = tools.run_tool(ctx, session, "make_game", {"spec": spec})
    assert out["error"] == "background_player" and "주인공이 될 수 없습니다" in out["message"]
    assert store.snapshot(ctx, sid)["games"] == []


def test_a_hero_without_3d_is_refused_in_words_that_fit_any_kind(ctx, session):
    sid = session["sessionId"]
    _ip(ctx, sid, "ip_lantern", "prop", "반딧불 등불")
    spec = minimal_sf()
    spec["player"]["ipId"] = "ip_lantern"
    out = tools.run_tool(ctx, session, "make_game", {"spec": spec})
    assert out["error"] == "needs_3d"
    assert "주인공 반딧불 등불(ip_lantern)의 3D가 아직 끝나지 않아" in out["message"]
    assert "3D가 없는 주인공은 납작한 그림 판으로 나오므로" in out["message"] and "캐릭터는" not in out["message"]


# ── 게임 설계 ───────────────────────────────────────────────────────────────────

ASK = "등불로 숲을 밝히는 게임 만들기"


def _design(**patch):
    return {"prompt": ASK, "castIpIds": ["lantern"], "playerIpId": "lantern", "weaponIpId": None, "propIpIds": [],
            "enemyIpIds": [], "npcIpIds": [], **patch}


IPS = {"lantern": {"ipId": "lantern", "kind": "prop"}, "blade": {"ipId": "blade", "kind": "weapon"},
       "wolf": {"ipId": "wolf", "kind": "enemy"}, "hero": {"ipId": "hero", "kind": "character"},
       "forest": {"ipId": "forest", "kind": "prop", "usage": "background"}}


@pytest.mark.parametrize("player", ["lantern", "blade", "wolf", "hero"])
def test_the_game_design_takes_as_its_hero_what_the_gate_takes(player):
    value, errors = game_design.validate_design(_design(castIpIds=[player], playerIpId=player), IPS, ASK)
    assert errors == [] and value["playerIpId"] == player


def test_the_game_design_refuses_a_whole_scene_as_its_hero_in_a_sentence():
    value, errors = game_design.validate_design(_design(castIpIds=["forest"], playerIpId="forest"), IPS, ASK)
    assert value is None and errors == ["배경(장면 전체)은 주인공이 될 수 없어요. 다른 IP를 주인공으로 골라 주세요."]
    assert plain(errors[0])


def test_a_design_with_no_hero_asks_for_one_in_words_that_fit_any_kind():
    value, errors = game_design.validate_design(_design(playerIpId=None, propIpIds=["lantern"]), IPS, ASK)
    assert value is None and errors == ["주인공을 하나 골라 주세요."] and plain(errors[0])


# ── what the page and the agent are told ──────────────────────────────────────

def test_the_sessions_snapshot_carries_who_can_be_the_hero(app_ctx):  # noqa: F811
    sid = _new_session()
    _ip(app_ctx, sid, "ip_lantern", "prop", "반딧불 등불", three_d=True)
    status, snap = call("GET", f"/api/sessions/{sid}")
    assert status == 200 and snap["gameHeroes"] == {"ipIds": ["ip_lantern"], "ready": ["ip_lantern"], "noCharacter": True}
    # the stored session has no such item: it is said as the session is read
    assert "gameHeroes" not in store.snapshot(app_ctx, sid)


def test_the_prompt_says_the_same_rule():
    player = next(line for line in prompts.SYSTEM.splitlines() if line.startswith("- player {ipId"))
    assert "주인공 IP" in player and "주인공 캐릭터 IP" not in player
    assert "보통 캐릭터다" in player and "세션에 캐릭터가 없거나 사용자가 그렇게 말하면" in player
    assert "적·소품·무기" in player and "배경" in player and "주인공이 될 수 없다" in player
    # ... and the spec the model fills in
    spec = next(s for s in tools.TOOL_SPECS if s["name"] == "hold_game_request")
    assert "캐릭터" not in spec["description"]  # the hero, whatever its kind
