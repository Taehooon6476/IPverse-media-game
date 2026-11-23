"""Four small server rules: the chain-end line's time stamp, how make_game says the hero fights, what 작업 기록 keeps
of a refusal, and the length and model a shot's result states."""
from server import authored_contract, jobs, prompts, store, tools
from server.tests import test_round20_games as r20
from server.tests.conftest import FakeS3, FakeTable, make_ctx
from server.tests.test_app import _new_session, call, ctx  # noqa: F401 (fixtures)
from server.tests.test_gamespec import authored_spec
from server.tests.test_round20_hold import _hero
from server.tests.test_tools import BUCKET, RUNTIME3D, _add_ip, _glb, _session
from server.tests.test_video_edit import mcp  # noqa: F401 (fixture)


# 1. The chain-end line is stamped with the chain's end, not with the poll that writes it (the tab may be closed)

def _chain_ended(ctx, sid, asked_at, ended_at):  # noqa: F811
    """A hero's 3D chain pressed from the card at asked_at whose last job finished at ended_at."""
    status, body = call("POST", f"/api/sessions/{sid}/tools/render_3d", {"ipId": "ip_hero"})
    assert status == 200, body
    for job in store.snapshot(ctx, sid)["jobs"]:
        store.update_job(ctx, sid, job["jobId"], status="done", createdAt=asked_at, updatedAt=ended_at,
                         finishedAt=ended_at if job["kind"] == "render3d" else "2026-11-17T04:50:44.000Z")


def _poll(sid):
    status, snap = call("GET", f"/api/sessions/{sid}")
    assert status == 200
    return snap["messages"]


def test_the_chain_end_line_is_stamped_with_the_last_jobs_finish_not_with_the_poll(ctx):  # noqa: F811
    sid = _new_session()
    _hero(ctx, sid)
    store.put_message(ctx, sid, "user", "주인공을 3D로 만들어줘", "done", ts="2026-11-17T04:40:23.000Z")
    _chain_ended(ctx, sid, "2026-11-17T04:40:33.000Z", "2026-11-17T04:54:44.000Z")
    said = _poll(sid)
    assert [m["role"] for m in said] == ["user", "assistant"] and said[-1]["ts"] == "2026-11-17T04:54:44.000Z"
    assert [m["ts"] for m in _poll(sid)] == [m["ts"] for m in said]  # stored under that time, once


def test_the_chain_end_line_still_sorts_after_what_the_chat_held(ctx):  # noqa: F811
    """A turn that ran after the chain's end and before any poll: the line comes after its messages, and a job with
    no finish time of its provider counts by its last write."""
    sid = _new_session()
    _hero(ctx, sid)
    _chain_ended(ctx, sid, "2026-11-17T04:40:33.000Z", "2026-11-17T04:54:44.000Z")
    for job in store.snapshot(ctx, sid)["jobs"]:
        store.update_job(ctx, sid, job["jobId"], finishedAt="")
    store.put_message(ctx, sid, "user", "다 됐어?", "done", ts="2026-11-17T04:55:00.000Z")
    store.put_message(ctx, sid, "assistant", "네, 다 됐어요.", "done", ts="2026-11-17T04:55:00.001Z")
    said = _poll(sid)
    assert [m["ts"] for m in said] == ["2026-11-17T04:55:00.000Z", "2026-11-17T04:55:00.001Z", "2026-11-17T04:55:00.002Z"]
    assert said[-1]["text"].endswith("‘3D’ 탭에서 돌려 볼 수 있어요.")


def test_the_chain_end_line_is_never_before_the_request_that_started_it(ctx):  # noqa: F811
    """A finish time that cannot be (a clock off, an old record): the press's own time is the floor, now the ceiling."""
    sid = _new_session()
    _hero(ctx, sid)
    _chain_ended(ctx, sid, "2026-11-17T04:40:33.000Z", "2026-11-17T04:54:44.000Z")
    for job in store.snapshot(ctx, sid)["jobs"]:
        store.update_job(ctx, sid, job["jobId"], finishedAt="2026-11-17T04:00:00.000Z", updatedAt="2026-11-17T04:00:00.000Z")
    assert _poll(sid)[-1]["ts"] == "2026-11-17T04:40:33.001Z"
    again = _new_session()
    _hero(ctx, again)
    _chain_ended(ctx, again, "2026-11-17T04:40:33.000Z", "2999-01-01T00:00:00.000Z")
    assert _poll(again)[-1]["ts"] <= store.now()


# 2. make_game says how the hero fights in the game as built. The survive rule turns the automatic attack off; the
# hero still attacks by key, weapon or none (game3d/authored.js: combatEnabled = enemies or a hand weapon or autoFire).

BY_KEY = "주인공은 마우스 클릭이나 F 키를 누를 때 공격합니다(자동 공격은 꺼져 있음)."


def _made_survive(asked):
    """A 30초 생존 game (a stored spec as the model wrote it) made through make_game with this request."""
    c = make_ctx(table=FakeTable(), s3=FakeS3())
    for name in RUNTIME3D:
        c.s3._store[(BUCKET, f"runtime3d/v1/{name}")] = name.encode()
    session, spec = _session(c), r20._as_made()
    spec["world"].pop("background", None)
    for ip_id in sorted(set(tools._ip_refs(spec))):
        _add_ip(c, session["sessionId"], ip_id, (ip_id + "-cutout").encode())
        _glb(c, session["sessionId"], ip_id)
    return spec, tools.run_tool(c, session, "make_game", {"spec": spec, "_source_prompt": asked})


def test_a_survive_game_with_no_weapon_says_the_hero_attacks_by_key():
    spec, out = _made_survive(r20.ASKED)
    assert "error" not in out, out
    assert not spec["player"].get("weaponIpId") and spec["mechanics"]["autoFire"] is True  # as the model sent it
    assert any("자동 공격을 껐습니다" in line for line in out["changed"])
    assert out["attack"] == f"{BY_KEY} 손에 든 무기가 없어도 탄환을 쏴 적을 쓰러뜨립니다."


def test_a_survive_game_that_asked_for_the_automatic_attack_says_both():
    _, out = _made_survive("카이로로 30초 생존 게임 만들어줘. 자동 공격으로 싸우게 해줘.")
    assert "error" not in out, out
    assert out["attack"].startswith("주인공은 15m 안의 가장 가까운 적을 자동으로 공격하고, 마우스 클릭이나 F 키로도 공격합니다.")


def test_how_the_hero_fights_follows_the_runtime():
    """game3d/authored.js (combatEnabled, attack) and arpg-data.js controlsFor: the same conditions, in their order."""
    says = authored_contract.hero_attack
    quiet = authored_spec()  # no enemy, no hand weapon, autoFire false
    assert says(quiet) == "이 게임에는 공격이 없습니다: 주인공은 싸우지 않습니다."
    blade = {**quiet, "player": {**quiet["player"], "weaponUrl": "assets/ip_blade.glb", "weaponType": "melee"}}
    assert says(blade) == f"{BY_KEY} 손에 든 무기를 휘둘러 앞쪽 가까이의 적을 칩니다."
    gun = {**quiet, "player": {**quiet["player"], "weaponUrl": "assets/ip_gun.glb", "weaponType": "gun"}}
    assert says(gun) == f"{BY_KEY} 손에 든 무기로 탄환을 쏩니다."
    arpg = {**quiet, "mechanics": {**quiet["mechanics"], "style": "arpg"}}
    assert "연속 베기" in says(arpg) and "R 키" in says(arpg)
    race = {**quiet, "enemies": [{"name": "적"}], "world": {**quiet["world"], "track": {}}}
    assert says(race) == says(quiet)


def test_the_prompt_has_the_reply_say_how_the_hero_fights_from_the_result():
    assert "make_game 결과의 attack" in prompts.SYSTEM and "무기가 없어서 싸우지 않는" in prompts.SYSTEM


# 3. 작업 기록 keeps the sentence a refusal has for the user: a bad_args refusal that carries a notice is logged with
# it, not with the plain "입력값이 맞지 않았어요" (tools.OWN_SHAPE).

def test_a_refusal_with_a_sentence_for_the_user_is_logged_with_its_first_sentence(ctx):  # noqa: F811
    sid = _new_session()
    _hero(ctx, sid)
    refused = tools.run_tool(ctx, store.get_session(ctx, sid), "render_3d", {"ipId": "ip_hero", "rig_only": True})
    assert refused["error"] == "bad_args" and refused["notice"].startswith("꼬마 마법사의 3D 모델이 아직 없으니")
    assert tools.summarize("render_3d", {}, refused) == f"3D로 만들기 실패: {refused['notice']}"
    two = {"error": "bad_args", "message": "skip_after_sec는 0–30 사이 정수여야 합니다",
           "notice": "건너뛰기 버튼 표시까지의 시간은 0–30초 사이로 적어 주세요. 게시 창에서 고칠 수 있어요."}
    assert tools.summarize("publish_game", {}, two) == "게시하기 실패: 건너뛰기 버튼 표시까지의 시간은 0–30초 사이로 적어 주세요."
    # one with no sentence of its own keeps the plain line, never the agent's copy
    assert tools.summarize("publish_game", {}, {k: two[k] for k in ("error", "message")}) == "게시하기 실패: 입력값이 맞지 않았어요"


# 4. A shot's result says the length and the model that were used: an argument that cannot matter is left out
# (test_round21_tool_args), so the reply must not promise the length or model that was asked.

def test_a_shot_says_the_seconds_and_the_model_it_was_registered_with(ctx):  # noqa: F811
    session = store.get_session(ctx, _new_session())
    _add_ip(ctx, session["sessionId"], "ip_hero", b"HERO")
    base = {"ipId": "ip_hero", "prompt": "orbit", "aspect_ratio": "16:9"}
    fixed = tools.run_tool(ctx, session, "make_video_shot", {**base, "model": "minimax-h3", "duration": 10})
    assert (fixed["seconds"], fixed["model"]) == (5, "minimax-h3")  # not the 10 that was asked
    asked = tools.run_tool(ctx, session, "make_video_shot", {**base, "duration": 12})
    assert (asked["seconds"], asked["model"]) == (12, "ltx")
    for out in (fixed, asked):
        made = store.get_job(ctx, session["sessionId"], out["jobId"])["input"]
        assert (made["seconds"], made["model"]) == (out["seconds"], out["model"])


def test_a_video_edit_says_the_model_it_runs_on_and_the_length_it_keeps(ctx, mcp):  # noqa: F811
    session = store.get_session(ctx, _new_session())
    sid = session["sessionId"]
    shot = jobs.create_job(ctx, sid, "shot", "mediagen_video", {"prompt": "orbit", "seconds": 8, "model": "minimax-h3"}, [])
    for edit, extra in (("v2v", {"task": "deblur"}), ("inpaint", {})):
        out = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": shot["jobId"], "edit": edit,
                                                               "prompt": "the same scene", "model": "wan-animate", **extra})
        assert "error" not in out, out
        assert (out["model"], out["seconds"]) == ("ltx", 8)  # not the Wan that was asked: these edits have one model
    wan = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": shot["jobId"], "edit": "restyle", "prompt": "watercolor",
                                                           "style": "watercolor", "model": "wan-animate"})
    assert wan.get("model") == "wan-animate", wan


def test_the_prompt_has_the_reply_state_the_length_and_model_of_the_result():
    rule = next(line for line in prompts.SYSTEM.splitlines() if "결과의 seconds와 model" in line)
    assert "make_video_shot" in rule and "edit_video_shot" in rule and "5초" in rule
