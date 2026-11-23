"""A game asked for in chat while the hero's 3D is not ready is held, and the hold is on record.

The agent records the hold (hold_game_request), the turn marks the user message that asked (gameHeld), and the page
offers the request again once the 3D is ready (web/src/api.ts heldGame). Also: render_3d tells the agent a 3D
chain's steps in the order they run."""
import json

import pytest

from server import agent, jobs, prompts, store, tools
from server.tests.conftest import FakeBedrockRT, FakeS3, FakeTable, make_ctx
from server.tests.test_agent import _final
from server.tests.test_gamespec import minimal_sf
from server.tests.test_tools import BUCKET, RUNTIME3D, _add_ip, _glb, _session

ASK = "이 IP들로 30초 생존 게임 만들어줘"


@pytest.fixture
def ctx():
    c = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=FakeBedrockRT())
    for name in RUNTIME3D:
        c.s3._store[(BUCKET, f"runtime3d/v1/{name}")] = name.encode()
    return c


@pytest.fixture
def session(ctx):
    return _session(ctx)


def _ask(ctx, sid, text=ASK, at="01:34:32"):
    """A chat line and its pending reply, as POST /chat stores them."""
    asked = store.put_message(ctx, sid, "user", text, "done", ts=f"2026-11-11T{at}.222Z")
    return asked, store.put_message(ctx, sid, "assistant", "", "pending", ts=f"2026-11-11T{at}.229Z")


def _calls(*calls):
    """One model answer that calls these tools: (name, input) each."""
    content = [{"toolUse": {"toolUseId": f"tu_{i}", "name": name, "input": args}} for i, (name, args) in enumerate(calls)]
    return {"stopReason": "tool_use", "output": {"message": {"role": "assistant", "content": content}}}


def _results(ctx, call=1):
    """The tool results the model read back in its next call."""
    return [b["toolResult"] for b in ctx.bedrock_rt_east.calls[call]["messages"][-1]["content"]]


def _three_d_job(ctx, sid, kind, ip_id, status="running"):
    job = jobs.create_job(ctx, sid, kind, "img3d" if kind == "mesh3d" else "rig", {"ipId": ip_id}, [])
    store.update_job(ctx, sid, job["jobId"], status=status)
    return job


def _message(ctx, sid, message):
    return next(m for m in store.snapshot(ctx, sid)["messages"] if m["messageId"] == message["messageId"])


def test_a_chat_game_request_held_for_the_heros_3d_is_marked_on_its_message(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")  # 세린: her picture, no 3D
    asked, pending = _ask(ctx, sid)
    ctx.bedrock_rt_east._responses = [
        _calls(("render_3d", {"ipId": "ip_hero"}), ("hold_game_request", {"ipId": "ip_hero"})),
        _final("세린 3D를 걸어 두었습니다. 끝나면 화면의 '게임에 반영'으로 만들 수 있어요.")]

    agent.run_turn(ctx, sid, pending["messageId"])

    snap = store.snapshot(ctx, sid)
    assert _message(ctx, sid, asked)["gameHeld"] == {"ipIds": ["ip_hero"]} and snap["games"] == []
    reply = snap["messages"][-1]
    assert reply["status"] == "done"
    assert [e["tool"] for e in reply["toolEvents"]] == ["render_3d", "hold_game_request"]
    assert reply["toolEvents"][1]["summary"] == "게임 요청 보류"
    _, hold = _results(ctx)
    assert hold["status"] == "success"
    [row] = hold["content"][0]["json"]["waiting3d"]
    assert (row["ipId"], row["state"], row["phase"]) == ("ip_hero", "running", "3D용 자세 그림")  # the chain render_3d just queued


def test_the_mark_is_on_the_request_of_this_turn_and_a_plain_3d_request_carries_none(ctx, session):
    """The held request need not be the newest user message when the 3D lands."""
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _add_ip(ctx, sid, "ip_can", b"CAN")
    asked, pending = _ask(ctx, sid)
    ctx.bedrock_rt_east._responses = [
        _calls(("render_3d", {"ipId": "ip_hero"}), ("hold_game_request", {"ipId": "ip_hero"})), _final("보류했어요."),
        _calls(("render_3d", {"ipId": "ip_can"})), _final("소품 3D를 걸었어요.")]
    agent.run_turn(ctx, sid, pending["messageId"])
    later, pending = _ask(ctx, sid, "소품도 3D로 만들어줘", at="01:34:46")
    agent.run_turn(ctx, sid, pending["messageId"])

    assert _message(ctx, sid, asked)["gameHeld"] == {"ipIds": ["ip_hero"]}
    assert "gameHeld" not in _message(ctx, sid, later)


def test_a_game_refused_for_3d_by_make_game_is_marked_the_same_way(ctx, session):
    """The agent called make_game all the same (or a 게임 설계 came from the Skills drawer, whose button the server alone
    gates): needs_3d names the IP the game waits for."""
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _three_d_job(ctx, sid, "rig", "ip_hero")
    spec = minimal_sf()
    spec["player"]["ipId"] = "ip_hero"
    asked, pending = _ask(ctx, sid)
    ctx.bedrock_rt_east._responses = [_calls(("make_game", {"spec": spec})), _final("3D가 아직이에요.")]

    agent.run_turn(ctx, sid, pending["messageId"])

    [refused] = _results(ctx)
    assert refused["status"] == "error" and refused["content"][0]["json"]["error"] == "needs_3d"
    assert _message(ctx, sid, asked)["gameHeld"] == {"ipIds": ["ip_hero"]}
    assert store.snapshot(ctx, sid)["games"] == []


def test_another_game_asked_for_while_one_is_held_replaces_it(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _three_d_job(ctx, sid, "mesh3d", "ip_hero")
    _, pending = _ask(ctx, sid)
    ctx.bedrock_rt_east._responses = [
        _calls(("hold_game_request", {"ipId": "ip_hero"})), _final("보류했어요."),
        _calls(("hold_game_request", {"ipId": "ip_hero", "replace": True})), _final("이 요청으로 바꿔 보류했어요.")]
    agent.run_turn(ctx, sid, pending["messageId"])
    _, pending = _ask(ctx, sid, "아니, 60초 보스전 게임으로 만들어줘", at="01:36:00")
    agent.run_turn(ctx, sid, pending["messageId"])

    snap = store.snapshot(ctx, sid)
    held = [m["text"] for m in snap["messages"] if m.get("gameHeld")]
    assert held == [ASK, "아니, 60초 보스전 게임으로 만들어줘"]  # the page takes the newest (web/src/api.ts heldGame)
    assert json.loads(agent.state_summary(snap))["heldGame"]["request"] == "아니, 60초 보스전 게임으로 만들어줘"


def test_a_line_that_asks_for_no_other_game_keeps_the_request_that_was_held(ctx, session):
    """A hold repeated on a line like "게임 빨리 만들어줘" must not move the mark: the button would send that line,
    without the setting the server reads off the request (gamespec.apply_setting). The request on hold stays unless
    the call says this turn asks for another game (replace)."""
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _three_d_job(ctx, sid, "mesh3d", "ip_hero")
    rainy = "달빛이 비치는 밤의 온실에서 비가 내리는 30초 생존 게임을 이 IP들로 만들어줘"
    _, pending = _ask(ctx, sid, rainy)
    ctx.bedrock_rt_east._responses = [_calls(("hold_game_request", {"ipId": "ip_hero"})), _final("보류했어요."),
                                      _calls(("hold_game_request", {"ipId": "ip_hero"})), _final("3D가 끝나야 해요."),
                                      _calls(("hold_game_request", {"ipId": "ip_hero"})), _final("소품 3D를 걸었어요.")]
    agent.run_turn(ctx, sid, pending["messageId"])
    _, pending = _ask(ctx, sid, "게임 빨리 만들어줘", at="01:36:00")
    agent.run_turn(ctx, sid, pending["messageId"])
    _, pending = _ask(ctx, sid, "소품도 3D로 만들어줘", at="01:37:00")  # no game request at all: the hold was a slip
    agent.run_turn(ctx, sid, pending["messageId"])

    snap = store.snapshot(ctx, sid)
    assert [m["text"] for m in snap["messages"] if m.get("gameHeld")] == [rainy]
    assert json.loads(agent.state_summary(snap))["heldGame"] == {"request": rainy, "ipIds": ["ip_hero"], "ready": False}
    [kept] = (r["content"][0]["json"] for r in _results(ctx, call=3))  # what the model read back in the second turn
    assert kept["kept"] == rainy and rainy in kept["message"] and "replace true" in kept["message"]
    assert "'게임 만들기'" in kept["message"]  # the held request's button


def test_the_hold_says_where_the_3d_is_and_what_brings_the_game_back(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    store.update_ip(ctx, sid, "ip_hero", name="세린")
    _three_d_job(ctx, sid, "mesh3d", "ip_hero")
    _three_d_job(ctx, sid, "render3d", "ip_hero", status="queued")
    _three_d_job(ctx, sid, "rig", "ip_hero", status="queued")

    out = tools.run_tool(ctx, session, "hold_game_request", {"ipId": "ip_hero"})

    assert "error" not in out, out
    [row] = out["waiting3d"]
    assert (row["name"], row["state"], row["phase"], row["etaMinutes"]) == ("세린", "running", "3D 모델", 12)
    assert row["steps"] == "3D 모델 → 3D 회전 영상과 움직임 뼈대(3D 모델이 나오면 함께 시작)"
    said = out["message"]
    assert "세린" in said and "3D 모델 단계" in said and "약 12분" in said
    assert "'게임 만들기'" in said and "다시 요청" in said
    assert "약속하지" in said  # the server makes no game by itself when the 3D lands


def test_a_hold_before_any_3d_was_started_says_to_start_it(ctx, session):
    """The model may call the hold before render_3d in one answer: the hold stands, and says what is missing."""
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    out = tools.run_tool(ctx, session, "hold_game_request", {"ipId": "ip_hero"})
    assert "error" not in out and [w["state"] for w in out["waiting3d"]] == ["none"], out
    assert "render_3d" in out["message"] and "'게임 만들기'" in out["message"]


def test_a_hero_whose_3d_is_ready_is_not_held(ctx, session):
    """The rig landed between the state the model read and its call: the game is made now, and nothing is marked."""
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _glb(ctx, sid, "ip_hero")
    asked, pending = _ask(ctx, sid)
    ctx.bedrock_rt_east._responses = [_calls(("hold_game_request", {"ipId": "ip_hero"}),
                                             ("hold_game_request", {"ipId": "ip_made_up"})), _final("지금 만들게요.")]

    agent.run_turn(ctx, sid, pending["messageId"])

    ready, unknown = (r["content"][0]["json"] for r in _results(ctx))
    assert ready["error"] == "ready_3d" and "make_game" in ready["message"]
    assert unknown["error"] == "not_found"
    assert "gameHeld" not in _message(ctx, sid, asked)


def test_a_rig_still_running_over_a_finished_mesh_holds_the_game(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _glb(ctx, sid, "ip_hero")  # the mesh landed, the rig has not
    _three_d_job(ctx, sid, "rig", "ip_hero")
    _three_d_job(ctx, sid, "render3d", "ip_hero")
    out = tools.run_tool(ctx, session, "hold_game_request", {"ipId": "ip_hero"})
    [row] = out["waiting3d"]
    assert (row["phase"], row["steps"]) == ("움직임 뼈대", "3D 회전 영상과 움직임 뼈대(함께 진행)")


def test_the_state_tells_the_agent_which_game_request_is_on_hold(ctx, session):
    """A later turn that asks for no game must not hold again: the state says a game is on hold already, and in
    which words it was asked."""
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _three_d_job(ctx, sid, "mesh3d", "ip_hero")
    _, pending = _ask(ctx, sid)
    assert "heldGame" not in json.loads(agent.state_summary(store.snapshot(ctx, sid)))
    ctx.bedrock_rt_east._responses = [_calls(("hold_game_request", {"ipId": "ip_hero"})), _final("보류했어요.")]
    agent.run_turn(ctx, sid, pending["messageId"])
    _ask(ctx, sid, "소품도 3D로 만들어줘", at="01:34:46")

    state = json.loads(agent.state_summary(store.snapshot(ctx, sid)))
    assert state["heldGame"] == {"request": ASK, "ipIds": ["ip_hero"], "ready": False}  # ready: its 3D is not in yet
    # once a game is made after the request, the hold is answered
    store.put_game(ctx, sid, {"gameId": "gm_1", "title": "달빛 온실 30초 방어전", "genre": "sf-shooter",
                              "createdAt": "2026-11-11T01:47:01.981Z"})
    assert "heldGame" not in json.loads(agent.state_summary(store.snapshot(ctx, sid)))
    rule = next(line for line in prompts.SYSTEM.splitlines() if line.startswith("- 3D 규칙:"))
    assert "state.heldGame" in rule and "게임을 만들어 달라는 요청을 받은 턴에만 부른다" in rule
    assert "다른 게임을 요청받았을 때만 replace true로" in rule and "재촉하는 말" in rule


def test_the_agent_has_the_tool_and_the_studio_has_a_word_for_it():
    assert "hold_game_request" in tools.TOOLS and "hold_game_request" not in tools.UI_ONLY_TOOLS
    [spec] = [s for s in tools.TOOL_SPECS if s["name"] == "hold_game_request"]
    assert spec["inputSchema"]["json"]["required"] == ["ipId"]
    assert spec["inputSchema"]["json"]["properties"]["replace"]["type"] == "boolean"
    assert tools._LABELS["hold_game_request"] == agent.TOOL_LABELS["hold_game_request"] == "게임 요청 보류"


def test_the_prompt_holds_a_game_request_instead_of_promising_the_game():
    s = prompts.SYSTEM
    assert "hold_game_request(ipId=주인공)" in s and "- hold_game_request:" in s
    assert "화면에 '게임 만들기' 버튼이 나타나고" in s
    assert "'3D가 끝나면 게임을 만들겠다'고 약속하지 않는다" in s
    # no rule asks for the bare promise
    assert "3D가 끝나면 게임을 만들겠다고 알린다" not in s and "3D가 끝나면 게임을 만들겠다고 그 단계와" not in s
    # needs_3d tells the same: the refused request is on hold, the button brings it back
    refused = tools._needs_3d({"player": {"ipId": "ip_1"}}, {"ip_1": {"ipId": "ip_1", "name": "기사"}}, set(), {})
    assert "'게임 만들기'" in refused["message"] and "3D가 끝나면 게임을 만들겠다고" not in refused["message"]


def test_render_3d_tells_the_agent_the_steps_in_the_order_they_run(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")  # a character: A-pose, mesh, then the turntable and the rig together
    out = tools.run_tool(ctx, session, "render_3d", {"ipId": "ip_hero"})
    kinds = {j["jobId"]: j["kind"] for j in store.snapshot(ctx, sid)["jobs"]}
    read = [kinds[v] for v in out.values() if isinstance(v, str) and v in kinds]  # the ids as the model reads them
    assert read == ["apose", "mesh3d", "render3d", "rig"], read
    assert out["steps"] == "3D용 자세 그림 → 3D 모델 → 3D 회전 영상과 움직임 뼈대(3D 모델이 나오면 함께 시작)"
    by_kind = {kind: job_id for job_id, kind in kinds.items()}
    deps = {j["kind"]: j["deps"] for j in store.snapshot(ctx, sid)["jobs"]}
    assert deps == {"apose": [], "mesh3d": [by_kind["apose"]], "render3d": [by_kind["mesh3d"]], "rig": [by_kind["mesh3d"]]}


def test_render_3d_of_an_ip_that_is_not_rigged_has_two_steps(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_can", b"CAN")
    store.update_ip(ctx, sid, "ip_can", kind="prop")
    out = tools.run_tool(ctx, session, "render_3d", {"ipId": "ip_can"})
    assert out["steps"] == "3D 모델 → 3D 회전 영상"
    assert list(out)[:2] == ["meshJobId", "jobId"] and "poseJobId" not in out and "rigJobId" not in out


def test_the_prompt_states_the_order_of_the_3d_steps():
    s = prompts.SYSTEM
    assert "3D용 자세 그림 → 3D 모델 → 3D 회전 영상과 움직임 뼈대" in s and "결과의 steps" in s
    [spec] = [t for t in tools.TOOL_SPECS if t["name"] == "render_3d"]
    assert "steps" in spec["description"]
