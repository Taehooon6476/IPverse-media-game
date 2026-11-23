"""A new game's first make_game call passes with the engine given as the tool's argument (the model fills that one,
not spec.engine), and a survive stage cannot be cleared by standing still."""
import copy
import json
import math
import pathlib

import pytest

from server import authored_contract, gamespec, prompts, store, tools
from server.gamespec import validate_spec
from server.tests.conftest import FakeS3, FakeTable, make_ctx
from server.tests.test_gamespec import authored_spec
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


def _cast(ctx, sid):
    for ip_id in ("ip_hero", "ip_core", "ip_mentor"):
        _add_ip(ctx, sid, ip_id, (ip_id + "-cutout").encode())
    store.update_ip(ctx, sid, "ip_core", kind="prop")
    _glb(ctx, sid, "ip_hero")  # a 3D game needs its player in 3D


def _new_game_spec():
    spec = authored_spec()
    spec["player"]["ipId"] = "ip_hero"
    del spec["engine"]  # as the model sends a new game: the engine is the tool's argument
    return spec


# ── the engine is the tool's argument ──────────────────────────────────────────

@pytest.mark.parametrize("args", [{}, {"engine": "three"}])
def test_a_new_authored_game_passes_on_its_first_call_with_the_engine_in_the_tools_argument(ctx, session, args):
    sid = session["sessionId"]
    _cast(ctx, sid)

    out = tools.run_tool(ctx, session, "make_game", {"spec": _new_game_spec(), **args})

    assert "error" not in out, out
    written = json.loads(ctx.s3._store[(BUCKET, f"games/{out['gameId']}/spec.json")])
    assert (written["version"], written["engine"]) == (2, "three")
    [game] = store.snapshot(ctx, sid)["games"]
    assert (game["engine"], game["specVersion"]) == ("three", 2)


def test_an_authored_world_still_runs_on_three_alone(ctx, session):
    """An authored world asked for on another engine is refused with its own error; a spec that itself names another
    engine is invalid."""
    sid = session["sessionId"]
    _cast(ctx, sid)
    for engine in ("phaser", "unreal"):
        out = tools.run_tool(ctx, session, "make_game", {"spec": _new_game_spec(), "engine": engine})
        assert out["error"] == "unsupported_authored_engine", out
    named = tools.run_tool(ctx, session, "make_game", {"spec": {**_new_game_spec(), "engine": "phaser"}})
    assert named["error"] == "invalid_spec" and "version 2 requires engine three" in named["message"]
    assert store.snapshot(ctx, sid)["games"] == []


def test_the_spec_the_agent_reads_back_keeps_its_engine_and_passes_too(ctx, session):
    """A game edit starts from get_game_spec, whose spec carries engine."""
    sid = session["sessionId"]
    _cast(ctx, sid)
    made = tools.run_tool(ctx, session, "make_game", {"spec": _new_game_spec()})
    read = tools.run_tool(ctx, session, "get_game_spec", {"gameId": made["gameId"]})
    assert read["spec"]["engine"] == "three"
    again = tools.run_tool(ctx, session, "make_game", {"spec": read["spec"], "engine": read["engine"],
                                                       "base_game_id": made["gameId"]})
    assert "error" not in again, again


def test_the_tool_says_where_the_engine_goes():
    [spec] = [s for s in tools.TOOL_SPECS if s["name"] == "make_game"]
    assert "engine" not in spec["inputSchema"]["json"]["properties"]["spec"]["required"]
    said = spec["inputSchema"]["json"]["properties"]["spec"]["properties"]["engine"]["description"]
    assert "생략" in said and "three" in said


# ── a survive stage cannot be cleared by standing still ────────────────────────
# The fixture gm_9539d06a71.spec.json is a stored 30-second survival game that was cleared without a key press; the
# node runtime test plays the same game.

FIXTURES = pathlib.Path(__file__).resolve().parents[2] / "game3d" / "test" / "fixtures"
# the request that game was made from
ASKED = ("[이미지 모델: Krea 2 Turbo (krea)] 이제 카이로 3D가 끝났으니 카이로를 주인공으로 30초 생존 게임을 만들어줘. "
         "사구 전갈이 적, 태양 나침반은 회복 아이템, 붉은 협곡 유적이 배경.")


def _as_made():
    """The 30초 생존 game as the model wrote it: the stored spec without what the server resolved."""
    stored = json.loads((FIXTURES / "gm_9539d06a71.spec.json").read_text())
    spec, errors = validate_spec(tools._unresolved({k: v for k, v in stored.items() if k != "design"}))
    assert errors == [], errors
    return spec


def _off(spec, point):
    start = spec["world"]["spawn"]
    return math.hypot(point["x"] - start["x"], point["z"] - start["z"])


def test_the_budget_an_idle_hero_loses_inside_the_clock():
    cap = authored_contract.survive_hp_cap
    assert (cap(30, "easy"), cap(30, "normal"), cap(30, "hard")) == (50, 70, 128)
    assert (cap(45, "normal"), cap(60, "normal"), cap(120, "normal")) == (116, 162, 347)
    assert cap(10, "normal") == cap(20, "normal") == 50  # the contract's floor: too short to settle
    assert cap(200, "normal") > 500  # a long stage keeps any HP the contract allows
    assert cap(30, "nightmare") == cap(30, "normal")


def test_the_rounds_first_survive_game_is_settled_on_three_numbers():
    spec = _as_made()
    before = copy.deepcopy(spec)
    assert (before["rules"]["playerHp"], before["mechanics"]["autoFire"]) == (150, True)
    assert min(_off(before, p) for p in before["world"]["enemySpawns"]) > 23  # the horde walked 10 s to the hero

    changed = gamespec.apply_survive(spec, ASKED)

    assert spec["mechanics"]["autoFire"] is False
    assert spec["rules"] == {**before["rules"], "playerHp": 70}
    spawns = spec["world"]["enemySpawns"]
    near, rest = spawns[:4], spawns[4:]
    assert rest == before["world"]["enemySpawns"]  # the model's own points are where they were, after the near ones
    assert [p["id"] for p in near] == ["near_1", "near_2", "near_3", "near_4"]
    half_w, half_d = spec["world"]["width"] / 2, spec["world"]["depth"] / 2
    for p in near:
        assert 12 <= _off(spec, p) <= authored_contract.SURVIVE_NEAR, p
        assert abs(p["x"]) <= half_w - 1 and abs(p["z"]) <= half_d - 1, p
        assert not authored_contract._in_solid(spec["world"], p["x"], p["z"]), p
        assert (p["enemyIndex"], p["stageId"]) == (0, "survive30")
    assert len({(p["x"], p["z"]) for p in near}) == 4
    assert len(changed) == 3 and "70" in changed[2] and "자동 공격" in changed[1] and "4곳" in changed[0]
    # everything else is the model's design
    for key in spec:
        if key not in ("mechanics", "rules", "world"):
            assert spec[key] == before[key], key
    assert {k: v for k, v in spec["world"].items() if k != "enemySpawns"} == \
        {k: v for k, v in before["world"].items() if k != "enemySpawns"}
    # the settled spec is a valid spec (an edit reads it back and sends it again), and settling it again adds nothing
    again, errors = validate_spec(spec)
    assert errors == [], errors
    assert gamespec.apply_survive(again, ASKED) == [] and again["world"]["enemySpawns"] == spawns


def test_the_settled_spec_is_the_one_the_runtime_test_plays():
    """game3d/test/round20-survive.test.mjs plays gm_9539d06a71.settled.spec.json, which is apply_survive's output on
    the stored spec."""
    spec = _as_made()
    gamespec.apply_survive(spec, ASKED)
    stored = json.loads((FIXTURES / "gm_9539d06a71.spec.json").read_text())
    settled = json.loads((FIXTURES / "gm_9539d06a71.settled.spec.json").read_text())
    assert settled["rules"] == spec["rules"] and settled["mechanics"] == spec["mechanics"]
    assert settled["world"]["enemySpawns"] == spec["world"]["enemySpawns"]
    assert {**settled, "rules": 0, "mechanics": 0, "world": {**settled["world"], "enemySpawns": 0}} == \
        {**stored, "rules": 0, "mechanics": 0, "world": {**stored["world"], "enemySpawns": 0}}


def test_what_the_user_asked_for_is_kept():
    spec = _as_made()
    changed = gamespec.apply_survive(spec, "카이로로 30초 생존 게임 만들어줘. 자동 공격으로 싸우고 체력은 300으로 해줘.")
    assert (spec["mechanics"]["autoFire"], spec["rules"]["playerHp"]) == (True, 150)  # the model's numbers stand
    assert len(changed) == 1 and "4곳" in changed[0]  # the horde still starts close
    for asked in ("오토 공격 켜고 30초 생존", "auto-fire survival 30s", "뱀서 같은 30초 생존 게임",
                  "자동 공격 켜고 대시는 빼줘"):
        spec = _as_made()
        gamespec.apply_survive(spec, asked)
        assert spec["mechanics"]["autoFire"] is True, asked
    for refused in ("자동 공격은 끄고 30초 생존 게임", "자동 공격 없이 30초 생존", "30초 생존 게임",
                    "자동 공격을 하지 말고 직접 쏘게", "30s survival, no auto-fire"):
        spec = _as_made()
        gamespec.apply_survive(spec, refused)
        assert spec["mechanics"]["autoFire"] is False, refused
    for named in ("HP 200으로 30초 생존", "체력을 150으로 하고 30초 생존", "생명력 120"):
        spec = _as_made()
        gamespec.apply_survive(spec, named)
        assert spec["rules"]["playerHp"] == 150, named


def test_a_revision_keeps_the_numbers_it_was_sent_with():
    """An edit is the user's own tuning: only the close spawn points are seen to."""
    spec = _as_made()
    changed = gamespec.apply_survive(spec, "[게임 수정 gameId=gm_9539d06a71] 적을 더 빠르게", revision=True)
    assert (spec["mechanics"]["autoFire"], spec["rules"]["playerHp"]) == (True, 150)
    assert len(changed) == 1 and [p["id"] for p in spec["world"]["enemySpawns"][:4]] == ["near_1", "near_2", "near_3", "near_4"]


def test_the_models_own_close_points_count_and_come_first():
    spec = _as_made()
    start = spec["world"]["spawn"]
    for p, (dx, dz) in zip(spec["world"]["enemySpawns"][4:], ((-10, -6), (10, -6), (-6, -12), (6, -12))):
        p["x"], p["z"] = start["x"] + dx, start["z"] + dz  # four of the model's eight within 16 m, listed last
    ids = [p["id"] for p in spec["world"]["enemySpawns"]]
    changed = gamespec.apply_survive(spec, ASKED)
    assert [p["id"] for p in spec["world"]["enemySpawns"]] == ids[4:] + ids[:4]  # no point added: the near ones first
    assert not any("곳" in line for line in changed)


def test_a_full_spawn_list_moves_its_farthest_points_in():
    spec = _as_made()
    spawns = spec["world"]["enemySpawns"]
    spawns += [{**spawns[i], "id": f"more_{i}", "x": spawns[i]["x"] * .9, "z": spawns[i]["z"] * .9} for i in range(8)]
    assert len(spawns) == 16
    far = sorted(spawns, key=lambda p: -_off(spec, p))[:4]
    gamespec.apply_survive(spec, ASKED)
    assert len(spec["world"]["enemySpawns"]) == 16
    assert {p["id"] for p in spec["world"]["enemySpawns"][:4]} == {p["id"] for p in far}
    assert all(_off(spec, p) <= authored_contract.SURVIVE_NEAR for p in spec["world"]["enemySpawns"][:4])
    assert validate_spec(spec)[1] == []


def test_only_an_action_world_with_a_survive_stage_is_settled():
    def settled(change):
        spec = _as_made()
        change(spec)
        before = copy.deepcopy(spec)
        return gamespec.apply_survive(spec, ASKED), spec, before

    def kills(spec):
        spec["mission"]["stages"][0].update(type="kills", target=4, entityIds=["sp1", "sp2", "sp3", "sp4"])
    for change in (kills, lambda s: s["mechanics"].update(style="arpg"), lambda s: s["artDirection"].update(setting="sky"),
                   lambda s: s["mechanics"].update(fallRespawn=True), lambda s: s["world"].update(track={}),
                   lambda s: s.update(enemies=[])):
        changed, spec, before = settled(change)
        assert changed == [] and spec == before, change

    def later(spec):  # the survive stage is not the opening one: where the hero stands then is not known
        spec["mission"]["stages"].insert(0, {"id": "walk", "type": "collect", "label": "나침반 줍기", "target": 1,
                                             "entityIds": ["compass_a"], "propIndex": 0})
    changed, spec, before = settled(later)
    assert spec["world"]["enemySpawns"] == before["world"]["enemySpawns"]
    assert (spec["rules"]["playerHp"], spec["mechanics"]["autoFire"]) == (70, False) and len(changed) == 2


def test_make_game_settles_the_game_and_tells_the_agent_what_it_changed(ctx, session):
    sid = session["sessionId"]
    for ip_id, kind in (("ip_c1a00163c0", "character"), ("ip_6e05239eda", "enemy"), ("ip_97d001d597", "prop"),
                        ("ip_5893a1fd24", "prop")):
        _add_ip(ctx, sid, ip_id, b"CUT")
        store.update_ip(ctx, sid, ip_id, kind=kind, **({"humanoid": False} if kind == "enemy" else {}))
    store.update_ip(ctx, sid, "ip_5893a1fd24", usage="background")
    ctx.s3._store[(BUCKET, f"sessions/{sid}/ip_5893a1fd24.jpg")] = b"\xff\xd8\xff-scene"
    _glb(ctx, sid, "ip_c1a00163c0")
    spec = _as_made()
    del spec["engine"]

    out = tools.run_tool(ctx, session, "make_game", {"spec": spec, "_source_prompt": ASKED})

    assert "error" not in out, out
    assert len(out["changed"]) == 3
    written = json.loads(ctx.s3._store[(BUCKET, f"games/{out['gameId']}/spec.json")])
    assert (written["rules"]["playerHp"], written["mechanics"]["autoFire"]) == (70, False)
    assert [p["id"] for p in written["world"]["enemySpawns"][:4]] == ["near_1", "near_2", "near_3", "near_4"]
    # the edit of it: the spec the agent reads back passes as it is and changes nothing more
    read = tools.run_tool(ctx, session, "get_game_spec", {"gameId": out["gameId"]})
    read["spec"]["rules"]["playerHp"] = 200  # "체력을 200으로 올려줘"
    again = tools.run_tool(ctx, session, "make_game", {
        "spec": read["spec"], "base_game_id": out["gameId"],
        "_source_prompt": f"[게임 수정 gameId={out['gameId']}] 체력을 200으로 올려줘"})
    assert "error" not in again and "changed" not in again, again
    rewritten = json.loads(ctx.s3._store[(BUCKET, f"games/{again['gameId']}/spec.json")])
    assert rewritten["rules"]["playerHp"] == 200 and len(rewritten["world"]["enemySpawns"]) == 12


def test_the_prompt_tells_how_a_survive_stage_is_made():
    s = prompts.SYSTEM
    rule = next(line for line in s.splitlines() if line.strip().startswith("- survive 단계는 가만히 서 있으면"))
    assert "12–16m" in rule and "4곳" in rule and "자동 공격" in rule
    assert "보통 30초 70" in rule and "45초 116" in rule and "60초 162" in rule  # survive_hp_cap's numbers
    assert "결과의 changed" in s
    assert "서서 버티기만 하면 보스와 후반 웨이브를 못 깬다" not in s


# ── the cap is the whole game's HP, and a re-make is a revision ────────────────
# rules.playerHp is one number for the whole game (game3d/authored.js sets hp from it once and refills only after a
# death), so a survive stage's cap applies only where no other fight shares the HP. A revision is known by
# base_game_id or by the request's own [게임 수정 gameId=…] marker.

QUEEN = {"id": "queen", "type": "boss", "label": "전갈 여왕을 쓰러뜨려라", "target": 1, "entityIds": ["queen_sp"],
         "enemyIndex": 0}
SWEEP = {"id": "sweep", "type": "kills", "label": "남은 전갈 3마리를 처치하라", "target": 3,
         "entityIds": ["sweep_1", "sweep_2", "sweep_3"], "enemyIndex": 0}


def _fights(stage, first=False):
    """The 30초 생존 game with one more stage that is fought, before or after its survive stage."""
    spec = _as_made()
    spec["world"]["enemySpawns"] += [{"id": ident, "enemyIndex": 0, "x": x, "z": z, "stageId": stage["id"]}
                                     for ident, (x, z) in zip(stage["entityIds"], ((-20, 12), (20, 12), (-20, -12)))]
    spec["mission"]["stages"].insert(0 if first else 1, dict(stage))
    assert validate_spec(spec)[1] == []
    return spec


@pytest.mark.parametrize("stage,first", [(QUEEN, False), (SWEEP, False), (SWEEP, True), (QUEEN, True)])
def test_a_mission_that_also_fights_a_boss_or_a_kill_count_keeps_its_hp(stage, first):
    spec = _fights(stage, first)
    changed = gamespec.apply_survive(spec, ASKED)
    assert spec["rules"]["playerHp"] == 150  # the later (or earlier) fight is played with the HP it was designed for
    assert not any("체력" in line for line in changed)
    # what cannot hurt another stage is still settled: no automatic attack, and the horde starts close when the
    # mission opens with the survive stage
    assert spec["mechanics"]["autoFire"] is False and any("자동 공격" in line for line in changed)
    near = [p["id"] for p in spec["world"]["enemySpawns"][:4]]
    assert (near == ["near_1", "near_2", "near_3", "near_4"]) is (not first)
    assert validate_spec(spec)[1] == []


def test_a_mission_whose_only_fights_are_survive_stages_is_capped_by_the_shortest():
    spec = _as_made()
    spec["mission"]["stages"].append({"id": "survive45", "type": "survive", "label": "45초 더 버텨라", "target": 45})
    spec["mission"]["stages"].insert(1, {"id": "walk", "type": "collect", "label": "나침반 줍기", "target": 1,
                                         "entityIds": ["compass_a"], "propIndex": 0})
    changed = gamespec.apply_survive(spec, ASKED)
    assert spec["rules"]["playerHp"] == authored_contract.survive_hp_cap(30, "normal") == 70
    assert any("70" in line and "30초" in line for line in changed)


def test_the_prompt_caps_the_hp_only_where_no_other_fight_shares_it():
    rule = next(line for line in prompts.SYSTEM.splitlines() if line.strip().startswith("- survive 단계는 가만히 서 있으면"))
    assert "싸우는 단계가 survive뿐인 미션" in rule and "kills·boss 단계가 함께 있는 미션" in rule
    assert "체력은 게임 전체에 하나" in rule


@pytest.mark.parametrize("asked,named", [
    ("체력 50으로 30초 생존", True), ("HP는 200", True), ("생명력: 120", True),
    # a share of a bar is no HP the user named for the hero
    ("체력이 50% 이하면 격노하는 보스가 나오는 30초 생존 게임", False), ("HP 30퍼센트 아래에서 빨라지는 적", False),
    ("체력 25프로가 되면 경고음", False), ("30초 생존 게임", False),
])
def test_a_share_of_the_health_bar_is_not_an_hp_the_user_named(asked, named):
    spec = _as_made()
    gamespec.apply_survive(spec, asked)
    assert (spec["rules"]["playerHp"] == 150) is named, asked


def _remade(ctx, session, source, **args):
    """A 30초 생존 game, then the same spec sent again with the user's tuning (HP 200, automatic attack on) under
    `source` → (the first game's id, the second call's answer, the spec it wrote)."""
    sid = session["sessionId"]
    for ip_id, kind in (("ip_c1a00163c0", "character"), ("ip_6e05239eda", "enemy"), ("ip_97d001d597", "prop"),
                        ("ip_5893a1fd24", "prop")):
        _add_ip(ctx, sid, ip_id, b"CUT")
        store.update_ip(ctx, sid, ip_id, kind=kind, **({"humanoid": False} if kind == "enemy" else {}))
    store.update_ip(ctx, sid, "ip_5893a1fd24", usage="background")
    ctx.s3._store[(BUCKET, f"sessions/{sid}/ip_5893a1fd24.jpg")] = b"\xff\xd8\xff-scene"
    _glb(ctx, sid, "ip_c1a00163c0")
    spec = _as_made()
    del spec["engine"]
    first = tools.run_tool(ctx, session, "make_game", {"spec": spec, "_source_prompt": ASKED})
    assert "error" not in first, first
    read = tools.run_tool(ctx, session, "get_game_spec", {"gameId": first["gameId"]})
    read["spec"]["rules"]["playerHp"] = 200
    read["spec"]["mechanics"]["autoFire"] = True
    again = tools.run_tool(ctx, session, "make_game", {"spec": read["spec"], **args,
                                                       "_source_prompt": source.format(game=first["gameId"])})
    assert "error" not in again, again
    return first["gameId"], again, json.loads(ctx.s3._store[(BUCKET, f"games/{again['gameId']}/spec.json")])


# what the page sends for 게임에 반영 (web/src/api.ts rebuildRequest) and for 이 게임 수정 (GameEditDrawer.tsx)
REMAKE = "[게임 수정 gameId={game}] 새 3D가 준비됐으니 '사구의 유적'을(를) 같은 설계와 출연 IP 그대로 다시 만들어 3D 모델로 바꿔줘. 나머지는 그대로 둬."
EDIT = "[게임 수정 gameId={game}] '사구의 유적'을(를) 이렇게 고친 새 버전을 만들어줘. 나머지는 그대로 둬.\n적을 더 빠르게"


@pytest.mark.parametrize("source", [REMAKE, EDIT])
def test_a_remake_the_model_sends_without_base_game_id_is_still_a_revision(ctx, session, source):
    first, again, written = _remade(ctx, session, source)
    assert (written["rules"]["playerHp"], written["mechanics"]["autoFire"]) == (200, True)  # the user's own tuning
    assert "changed" not in again
    made = next(g for g in store.snapshot(ctx, session["sessionId"])["games"] if g["gameId"] == again["gameId"])
    assert made["baseGameId"] == first  # and the game pane lists it as that game's next version


def test_the_requests_own_line_is_read_where_the_page_puts_it():
    assert gamespec.revises("[게임 수정 gameId=gm_1] 적을 더 빠르게") == "gm_1"
    assert gamespec.revises("[이미지 모델: Krea 2 Turbo (krea)] [영상 모델: LTX-2.5 (ltx)] [게임 수정 gameId=gm_1] 적을 더 빠르게") == "gm_1"
    for other in ("30초 생존 게임 만들어줘", "아까 [게임 수정 gameId=gm_1] 로 고친 것 말고 새로", "[에셋 수정 ipId=ip_1] 리라", "", None, 7):
        assert gamespec.revises(other) is None, other


def test_a_marker_that_names_no_game_of_the_session_links_nothing(ctx, session):
    _, again, written = _remade(ctx, session, "[게임 수정 gameId=gm_someone_elses] 적을 더 빠르게")
    assert (written["rules"]["playerHp"], written["mechanics"]["autoFire"]) == (200, True)  # said to be an edit
    made = next(g for g in store.snapshot(ctx, session["sessionId"])["games"] if g["gameId"] == again["gameId"])
    assert "baseGameId" not in made


def test_a_new_game_sent_with_the_same_numbers_is_tuned_as_before(ctx, session):
    """The marker counts only at the start of the request: with no base either, this is a new game."""
    _, again, written = _remade(ctx, session, "아까 [게임 수정 gameId={game}] 로 고친 것 말고, 30초 생존 게임을 새로 만들어줘")
    assert (written["rules"]["playerHp"], written["mechanics"]["autoFire"]) == (70, False)
    assert len(again["changed"]) == 2
