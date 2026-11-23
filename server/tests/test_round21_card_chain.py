"""A 3D chain or a trailer started from a card's button tells the chat when it has ended, as one asked for in chat
does: a toast needs the tab open, so the button's route marks its chain the same way a chat turn does."""
import pytest

from server import jobs, prompts, store, tools
from server.tests.test_app import _new_session, call, ctx  # noqa: F401 (fixtures)
from server.tests.test_round20_errors import plain
from server.tests.test_round20_hold import _hero
from server.tests.test_tools import _glb

READY = "꼬마 마법사의 3D가 준비됐어요. ‘3D’ 탭에서 돌려 볼 수 있어요."
WHERE = "‘작업 현황’ 탭에서 이유와 다음에 할 일을 볼 수 있어요."


def _press(sid, tool="render_3d", **args):
    """The card's button: POST /tools/<tool>, as the page sends it."""
    status, body = call("POST", f"/api/sessions/{sid}/tools/{tool}", {"ipId": "ip_hero", **args})
    assert status == 200, body
    return body["result"]


def _jobs(ctx, sid):  # noqa: F811
    return {j["kind"]: j for j in store.snapshot(ctx, sid)["jobs"]}


def _end(ctx, sid, job, status="done", error=None):  # noqa: F811
    store.update_job(ctx, sid, job["jobId"], status=status, **({"error": error} if error else {}))


def _chat(sid):
    """The session's poll, as the page that comes back sends it → the chat's lines."""
    status, snap = call("GET", f"/api/sessions/{sid}")
    assert status == 200
    return [m["text"] for m in snap["messages"]]


def test_a_3d_chain_started_from_the_card_says_in_the_chat_when_it_is_ready(ctx):  # noqa: F811
    sid = _new_session()
    _hero(ctx, sid)
    made = _press(sid)
    chain = _jobs(ctx, sid)
    assert sorted(chain) == ["apose", "mesh3d", "render3d", "rig"] and made["rigJobId"] == chain["rig"]["jobId"]
    assert store.snapshot(ctx, sid)["messages"] == []  # the press itself writes nothing

    for kind in ("apose", "mesh3d", "render3d"):
        _end(ctx, sid, chain[kind])
    store.update_job(ctx, sid, chain["rig"]["jobId"], status="running", externalId="")  # (owned: the poll leaves it)
    assert _chat(sid) == []  # the skeleton still runs

    _end(ctx, sid, chain["rig"])
    assert _chat(sid) == [READY] and plain(READY)  # the tab was away: this is the poll of the page that came back
    assert _chat(sid) == [READY]  # once
    line = store.snapshot(ctx, sid)["messages"][-1]
    assert (line["role"], line["status"]) == ("assistant", "done")


def test_a_card_started_chain_that_failed_says_what_is_missing(ctx):  # noqa: F811
    sid = _new_session()
    _hero(ctx, sid)
    _press(sid)
    chain = _jobs(ctx, sid)
    _end(ctx, sid, chain["apose"])
    _end(ctx, sid, chain["mesh3d"], "failed", "3D 모델을 만들지 못했습니다: CUDA out of memory")
    for kind in ("render3d", "rig"):
        _end(ctx, sid, chain[kind], "failed", jobs.DEP_FAILED)
    assert _chat(sid) == [f"꼬마 마법사의 3D를 만들지 못했어요(3D 모델 단계에서 실패). {WHERE}"]


def test_a_card_started_chain_the_user_stopped_says_nothing(ctx):  # noqa: F811
    sid = _new_session()
    _hero(ctx, sid)
    _press(sid)
    chain = _jobs(ctx, sid)
    _end(ctx, sid, chain["apose"], "failed", jobs.CANCELED)
    for kind in ("mesh3d", "render3d", "rig"):
        _end(ctx, sid, chain[kind], "failed", jobs.DEP_FAILED)
    assert _chat(sid) == []


def test_a_held_game_whose_3d_was_started_from_the_card_hears_of_its_button(ctx):  # noqa: F811
    """The reply holds the game and sends the user to the card's 3D로 만들기."""
    sid = _new_session()
    _hero(ctx, sid)
    asked = store.put_message(ctx, sid, "user", "이 IP들로 30초 생존 게임 만들어줘", "done", ts="2026-11-16T15:01:00.000Z")
    store.update_message(ctx, sid, asked, gameHeld={"ipIds": ["ip_hero"]})
    _press(sid)
    for job in store.snapshot(ctx, sid)["jobs"]:
        _end(ctx, sid, job)
    _glb(ctx, sid, "ip_hero")
    _glb(ctx, sid, "ip_hero", "rigged_glb", "riggedGlbAssetId")
    assert _chat(sid) == [asked["text"], READY + " 요청해 둔 게임은 ‘게임 만들기’ 버튼으로 만들 수 있어요."]


def test_the_skeleton_put_in_again_from_the_cards_menu_says_it_too(ctx):  # noqa: F811
    sid = _new_session()
    _hero(ctx, sid)
    mesh = jobs.create_job(ctx, sid, "mesh3d", "img3d", {"ipId": "ip_hero"}, [])
    glb = store.put_asset(ctx, sid, {"kind": "glb", "key": f"sessions/{sid}/{mesh['jobId']}.glb", "jobId": mesh["jobId"],
                                     "ipId": "ip_hero", "contentType": "model/gltf-binary"})
    store.update_job(ctx, sid, mesh["jobId"], status="done", outputs=[glb["assetId"]])
    store.update_ip(ctx, sid, "ip_hero", glbAssetId=glb["assetId"])
    made = _press(sid, rig_only=True)
    _end(ctx, sid, {"jobId": made["rigJobId"]})
    assert _chat(sid) == [READY]


def test_a_trailer_cut_through_a_button_says_when_it_is_cut(ctx):  # noqa: F811
    sid = _new_session()
    shots = [jobs.create_job(ctx, sid, "shot", "mediagen_video", {"prompt": "orbit", "seconds": 5}, [])["jobId"] for _ in range(2)]
    status, body = call("POST", f"/api/sessions/{sid}/tools/cut_trailer",
                        {"shot_job_ids": shots, "title": "달빛 숲", "subtitle": "", "lut": "none", "make_shorts": True})
    assert status == 200, body
    for shot in shots:
        store.update_job(ctx, sid, shot, status="done")
    _end(ctx, sid, {"jobId": body["result"]["jobId"]})
    assert _chat(sid) == ["트레일러와 쇼츠가 완성됐어요. ‘영상’ 탭에서 볼 수 있어요."]


def test_a_button_that_was_refused_marks_nothing(ctx):  # noqa: F811
    sid = _new_session()
    status, _ = call("POST", f"/api/sessions/{sid}/tools/render_3d", {"ipId": "ip_none"})
    assert status == 404 and store.snapshot(ctx, sid)["jobs"] == [] and _chat(sid) == []


def test_a_genre_skills_plan_does_not_fill_the_chat_with_a_line_per_ip(ctx, monkeypatch):  # noqa: F811
    """장르 스킬 makes several IPs in a row and its drawer follows them: only a chain a button or a turn started for
    one IP (CHAINS) is told in the chat."""
    sid = _new_session()
    monkeypatch.setattr(tools.connections, "image_catalog", lambda c: {"models": [{"id": "krea", "label": "Krea 2 Turbo"}]})
    made = tools.run_tool(ctx, store.get_session(ctx, sid), "make_skill_asset",
                          {"kind": "prop", "name": "타이어 방벽", "description": "a stack of racing tyres"})
    assert "error" not in made
    for job in store.snapshot(ctx, sid)["jobs"]:
        _end(ctx, sid, job)
    assert _chat(sid) == []


def test_a_tool_run_that_is_neither_a_turn_nor_a_buttons_route_is_not_watched(ctx):  # noqa: F811
    sid = _new_session()
    _hero(ctx, sid)
    assert "error" not in tools.run_tool(ctx, store.get_session(ctx, sid), "render_3d", {"ipId": "ip_hero"})
    for job in store.snapshot(ctx, sid)["jobs"]:
        _end(ctx, sid, job)
    assert _chat(sid) == []


def test_the_agent_knows_a_card_started_chain_is_told_too():
    rule = next(line for line in prompts.SYSTEM.splitlines() if line.startswith("- 오래 걸리는 작업"))
    assert "3D와 트레일러는 채팅에서 요청했든 카드의 버튼으로 시작했든 끝났을 때 서버가 채팅에 한 줄로 알린다" in rule
