"""A chain of jobs asked for in chat says in the chat when it has ended: the turn marks the chain it registered
(render_3d, cut_trailer), and the session's poll says once, in one short line, what is ready and where to look."""
import re

import pytest

from server import agent, app, jobs, prompts, store, tools
from server.tests.conftest import FakeBedrockRT, FakeS3, FakeTable, make_ctx
from server.tests.test_agent import _final
from server.tests.test_round20_errors import plain
from server.tests.test_round20_hold import _ask, _calls, _hero
from server.tests.test_tools import BUCKET, RUNTIME3D, _glb, _session

READY = "꼬마 마법사의 3D가 준비됐어요. ‘3D’ 탭에서 돌려 볼 수 있어요."
WHERE = "‘작업 현황’ 탭에서 이유와 다음에 할 일을 볼 수 있어요."


@pytest.fixture
def ctx():
    c = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=FakeBedrockRT())
    for name in RUNTIME3D:
        c.s3._store[(BUCKET, f"runtime3d/v1/{name}")] = name.encode()
    return c


@pytest.fixture
def sid(ctx):
    return _session(ctx)["sessionId"]


def _turn(ctx, sid, text, *calls, reply="시작했어요."):
    """A chat turn that calls these tools and answers."""
    _, pending = _ask(ctx, sid, text)
    ctx.bedrock_rt_east._responses = [_calls(*calls), _final(reply)]
    agent.run_turn(ctx, sid, pending["messageId"])
    assert store.snapshot(ctx, sid)["messages"][-1]["status"] == "done"


def _chain(ctx, sid, name="꼬마 마법사"):
    """The hero's 3D asked for in chat → its jobs by kind."""
    _hero(ctx, sid, name)
    _turn(ctx, sid, f"{name} 3D로 만들어줘", ("render_3d", {"ipId": "ip_hero"}))
    return {j["kind"]: j for j in store.snapshot(ctx, sid)["jobs"]}


def _end(ctx, sid, job, status="done", error=None):
    store.update_job(ctx, sid, job["jobId"], status=status, **({"error": error} if error else {}))


def _said(ctx, sid):
    """The poll's part (app.get_session) → every chat line after it."""
    snap = store.snapshot(ctx, sid)
    agent.tell_finished(ctx, snap)
    stored = [m["text"] for m in store.snapshot(ctx, sid)["messages"]]
    assert [m["text"] for m in snap["messages"]] == stored  # the answer of this very poll carries the line
    return stored


def test_a_3d_chain_asked_for_in_chat_says_when_it_is_ready(ctx, sid):
    chain = _chain(ctx, sid)
    assert sorted(chain) == ["apose", "mesh3d", "render3d", "rig"]
    before = _said(ctx, sid)  # nothing has ended
    assert len(before) == 2

    for kind in ("apose", "mesh3d", "render3d"):
        _end(ctx, sid, chain[kind])
    assert _said(ctx, sid) == before  # the rig still runs: the hero is not ready

    _end(ctx, sid, chain["rig"])
    said = _said(ctx, sid)
    assert said == [*before, READY] and plain(READY)
    line = store.snapshot(ctx, sid)["messages"][-1]
    assert (line["role"], line["status"]) == ("assistant", "done")
    assert _said(ctx, sid) == said  # once


def test_two_polls_at_once_say_it_once(ctx, sid):
    chain = _chain(ctx, sid)
    for job in chain.values():
        _end(ctx, sid, job)
    first, second = store.snapshot(ctx, sid), store.snapshot(ctx, sid)  # both read before either wrote
    agent.tell_finished(ctx, first)
    agent.tell_finished(ctx, second)
    assert [m["text"] for m in store.snapshot(ctx, sid)["messages"]].count(READY) == 1


def test_a_chain_started_by_a_card_button_says_it_too(ctx, sid, monkeypatch):
    """The button's route marks its chain as a turn does: a toast alone needs the tab to be open
    (see test_round21_card_chain.py)."""
    _hero(ctx, sid)
    monkeypatch.setattr(app, "_own_session", lambda c, user, session_id: store.get_session(c, session_id))
    status, made = app.run_tool(ctx, {"sub": "user-1"}, {"ipId": "ip_hero"}, sid, "render_3d")
    for job in store.snapshot(ctx, sid)["jobs"]:
        _end(ctx, sid, job)
    assert status == 200 and "error" not in made["result"] and _said(ctx, sid) == [READY]


def test_a_prop_and_a_scene_say_it_after_their_own_steps(ctx, sid):
    _hero(ctx, sid, "빛나는 지팡이")
    store.update_ip(ctx, sid, "ip_hero", kind="prop")
    _turn(ctx, sid, "지팡이 3D로 만들어줘", ("render_3d", {"ipId": "ip_hero"}))
    chain = {j["kind"]: j for j in store.snapshot(ctx, sid)["jobs"]}
    assert sorted(chain) == ["mesh3d", "render3d"]
    _end(ctx, sid, chain["mesh3d"])
    assert len(_said(ctx, sid)) == 2
    _end(ctx, sid, chain["render3d"])
    assert _said(ctx, sid)[-1] == "빛나는 지팡이의 3D가 준비됐어요. ‘3D’ 탭에서 돌려 볼 수 있어요."


def test_a_held_game_is_named_with_its_button(ctx, sid):
    _hero(ctx, sid)
    _turn(ctx, sid, "이 IP들로 30초 생존 게임 만들어줘",
          ("render_3d", {"ipId": "ip_hero"}), ("hold_game_request", {"ipId": "ip_hero"}), reply="게임 요청은 보류해 두었어요.")
    assert tools.held_game(store.snapshot(ctx, sid))["gameHeld"] == {"ipIds": ["ip_hero"]}
    for job in store.snapshot(ctx, sid)["jobs"]:
        _end(ctx, sid, job)
    _glb(ctx, sid, "ip_hero")
    _glb(ctx, sid, "ip_hero", "rigged_glb", "riggedGlbAssetId")

    line = _said(ctx, sid)[-1]
    assert line == READY + " 요청해 둔 게임은 ‘게임 만들기’ 버튼으로 만들 수 있어요."
    assert f"‘{tools.HELD_BUTTON}’" in plain(line)


def test_a_chain_that_failed_says_what_is_there_and_where_to_look(ctx, sid):
    chain = _chain(ctx, sid)
    for kind in ("apose", "mesh3d", "render3d"):
        _end(ctx, sid, chain[kind])
    _end(ctx, sid, chain["rig"], "failed", "움직임 뼈대를 넣을 수 없는 모양입니다: 팔이 몸통에 붙어 있음")
    line = _said(ctx, sid)[-1]
    assert line == f"꼬마 마법사의 3D 모델은 준비됐지만 움직임 뼈대 단계가 실패했어요. {WHERE}"
    assert plain(line) and len(_said(ctx, sid)) == 3  # once


def test_a_chain_that_never_made_its_model_says_so(ctx, sid):
    chain = _chain(ctx, sid)
    _end(ctx, sid, chain["apose"])
    _end(ctx, sid, chain["mesh3d"], "failed", "3D 모델을 만들지 못했습니다: CUDA out of memory")
    assert len(_said(ctx, sid)) == 2  # its dependents have not settled yet
    for kind in ("render3d", "rig"):
        _end(ctx, sid, chain[kind], "failed", jobs.DEP_FAILED)
    line = _said(ctx, sid)[-1]
    assert line == f"꼬마 마법사의 3D를 만들지 못했어요(3D 모델 단계에서 실패). {WHERE}"
    assert "CUDA" not in plain(line)


def test_a_chain_whose_picture_never_came_says_so_without_a_step(ctx, sid):
    """render_3d on an IP whose picture is still being drawn: the picture's job is not one of the chain's steps."""
    chain = _chain(ctx, sid)
    for job in chain.values():
        _end(ctx, sid, job, "failed", jobs.DEP_FAILED)
    assert _said(ctx, sid)[-1] == f"꼬마 마법사의 3D를 만들지 못했어요. {WHERE}"


def test_a_chain_the_user_stopped_says_nothing(ctx, sid):
    chain = _chain(ctx, sid)
    _end(ctx, sid, chain["apose"])
    _end(ctx, sid, chain["mesh3d"], "failed", jobs.CANCELED)
    for kind in ("render3d", "rig"):
        _end(ctx, sid, chain[kind], "failed", jobs.DEP_FAILED)
    assert len(_said(ctx, sid)) == 2
    # ... and it is not looked at again: a retry later is the user's own, at the screen
    _end(ctx, sid, chain["mesh3d"])
    for kind in ("render3d", "rig"):
        _end(ctx, sid, chain[kind])
    assert len(_said(ctx, sid)) == 2


def _shots(ctx, sid, n=2):
    return [jobs.create_job(ctx, sid, "shot", "mediagen_video", {"prompt": "orbit", "seconds": 5}, [])["jobId"] for _ in range(n)]


@pytest.mark.parametrize("shorts,line", [
    (False, "트레일러가 완성됐어요. ‘영상’ 탭에서 볼 수 있어요."),
    (True, "트레일러와 쇼츠가 완성됐어요. ‘영상’ 탭에서 볼 수 있어요."),
])
def test_a_trailer_asked_for_in_chat_says_when_it_is_cut(ctx, sid, shorts, line):
    """Two shots and a cut that waits for them."""
    shots = _shots(ctx, sid)
    _turn(ctx, sid, "꼬마 마법사 트레일러 만들어줘", ("cut_trailer", {"shot_job_ids": shots, "make_shorts": shorts}),
          reply="두 샷이 끝나면 트레일러를 자동으로 잘라 줍니다.")
    trailer = next(j for j in store.snapshot(ctx, sid)["jobs"] if j["kind"] == "trailer")
    for shot in shots:
        store.update_job(ctx, sid, shot, status="done")
    assert len(_said(ctx, sid)) == 2  # the shots are in; the cut is not
    _end(ctx, sid, trailer)
    said = _said(ctx, sid)
    assert said[-1] == line and plain(line) and len(said) == 3
    assert len(_said(ctx, sid)) == 3


def test_a_trailer_that_could_not_be_cut_says_where_to_look(ctx, sid):
    shots = _shots(ctx, sid)
    _turn(ctx, sid, "트레일러 만들어줘", ("cut_trailer", {"shot_job_ids": shots}))
    trailer = next(j for j in store.snapshot(ctx, sid)["jobs"] if j["kind"] == "trailer")
    store.update_job(ctx, sid, shots[0], status="failed", error="영상 생성 실패: CUDA OOM")
    _end(ctx, sid, trailer, "failed", jobs.DEP_FAILED)
    assert _said(ctx, sid)[-1] == f"트레일러를 만들지 못했어요. {WHERE}"


def test_a_trailer_whose_shot_the_user_stopped_says_nothing(ctx, sid):
    shots = _shots(ctx, sid)
    _turn(ctx, sid, "트레일러 만들어줘", ("cut_trailer", {"shot_job_ids": shots}))
    trailer = next(j for j in store.snapshot(ctx, sid)["jobs"] if j["kind"] == "trailer")
    store.update_job(ctx, sid, shots[1], status="failed", error=jobs.CANCELED)
    _end(ctx, sid, trailer, "failed", jobs.DEP_FAILED)
    assert len(_said(ctx, sid)) == 2


def test_a_tool_that_registered_nothing_is_not_watched(ctx, sid):
    _hero(ctx, sid)
    _turn(ctx, sid, "없는 IP 3D로 만들어줘", ("render_3d", {"ipId": "ip_none"}), ("cut_trailer", {"shot_job_ids": ["job_none"]}))
    assert store.snapshot(ctx, sid)["jobs"] == [] and len(_said(ctx, sid)) == 2


def test_the_sessions_poll_is_what_says_it(ctx, sid, monkeypatch):
    chain = _chain(ctx, sid)
    for job in chain.values():
        _end(ctx, sid, job)
    monkeypatch.setattr(app, "_own_session", lambda c, user, session_id: store.get_session(c, session_id))
    status, snap = app.get_session(ctx, {"sub": "user-1"}, {}, sid)
    assert status == 200 and snap["messages"][-1]["text"] == READY
    assert app.get_session(ctx, {"sub": "user-1"}, {}, sid)[1]["messages"][-1]["text"] == READY
    assert [m["text"] for m in store.snapshot(ctx, sid)["messages"]].count(READY) == 1


def test_the_agent_knows_the_chat_hears_of_the_end():
    """... so a reply may say so, and writes no such line itself before the end."""
    assert "끝났을 때 서버가 채팅에 한 줄로 알린다" in prompts.SYSTEM  # (a card's chain too: test_round21_card_chain.py)


def test_the_words_are_the_screens(ctx):
    """The tabs the lines name are the page's tabs, and the steps the cards' (waits.STEP_LABEL)."""
    import pathlib
    pane = (pathlib.Path(__file__).resolve().parents[2] / "web/src/components/IpPane.tsx").read_text(encoding="utf-8")
    source = (pathlib.Path(__file__).resolve().parents[1] / "agent.py").read_text(encoding="utf-8")
    body = source[source.index("# ── a chain of jobs a turn or a card's button started"):]
    tabs = set(re.findall(r"‘([^’]+)’ 탭", body))
    assert tabs == {"3D", "영상", "작업 현황"}
    for tab in tabs:
        assert f"label: '{tab}'" in pane, tab
