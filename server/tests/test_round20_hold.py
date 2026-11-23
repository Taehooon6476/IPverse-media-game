"""A reply cannot say a game request is on hold without the hold being on record. The model can skip
hold_game_request and still write the sentence, so the turn itself marks the request (gameHeld on the user's message,
with the heroes whose 3D is not ready) as the tool would, after a turn that made no game and marked nothing."""
import json

import pytest

from server import agent, jobs, prompts, store, tools
from server.tests.conftest import FakeBedrockRT, FakeS3, FakeTable, make_ctx
from server.tests.test_agent import _final
from server.tests.test_gamespec import minimal_sf
from server.tests.test_tools import BUCKET, RUNTIME3D, _add_ip, _glb, _session

ASK = "이 IP들로 30초 생존 게임 만들어줘"
# a reply that promises the hold and its button
PROMISED = ("꼬마 마법사의 3D가 아직 끝나지 않아서 게임은 아직 만들지 못했습니다. 게임 요청은 보류해 두었습니다.\n\n"
            "- 게임 반영: 3D가 끝나면 화면에 '게임에 반영' 버튼이 나타납니다. 누르면 이 요청대로 게임을 만듭니다.")


@pytest.fixture
def ctx():
    c = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=FakeBedrockRT())
    for name in RUNTIME3D:
        c.s3._store[(BUCKET, f"runtime3d/v1/{name}")] = name.encode()
    return c


@pytest.fixture
def session(ctx):
    return _session(ctx)


def _ask(ctx, sid, text=ASK, at="03:32:12"):
    asked = store.put_message(ctx, sid, "user", text, "done", ts=f"2026-11-16T{at}.214Z")
    return asked, store.put_message(ctx, sid, "assistant", "", "pending", ts=f"2026-11-16T{at}.221Z")


def _calls(*calls):
    content = [{"toolUse": {"toolUseId": f"tu_{i}", "name": name, "input": args}} for i, (name, args) in enumerate(calls)]
    return {"stopReason": "tool_use", "output": {"message": {"role": "assistant", "content": content}}}


def _running(ctx, sid, kind, ip_id):
    job = jobs.create_job(ctx, sid, kind, "img3d" if kind == "mesh3d" else "rig", {"ipId": ip_id}, [])
    store.update_job(ctx, sid, job["jobId"], status="running")
    return job


def _message(ctx, sid, message):
    return next(m for m in store.snapshot(ctx, sid)["messages"] if m["messageId"] == message["messageId"])


def _hero(ctx, sid, name="꼬마 마법사", ip_id="ip_hero"):
    _add_ip(ctx, sid, ip_id, b"HERO")
    store.update_ip(ctx, sid, ip_id, name=name)


def test_a_hold_the_reply_only_says_is_marked_by_the_turn(ctx, session):
    """The rig and the turntable run over a finished mesh; no tool call, the hold in words only."""
    sid = session["sessionId"]
    _hero(ctx, sid)
    _glb(ctx, sid, "ip_hero")  # the mesh is done
    _running(ctx, sid, "rig", "ip_hero")
    _running(ctx, sid, "render3d", "ip_hero")
    asked, pending = _ask(ctx, sid)
    ctx.bedrock_rt_east._responses = [_final(PROMISED)]

    agent.run_turn(ctx, sid, pending["messageId"])

    snap = store.snapshot(ctx, sid)
    reply = snap["messages"][-1]
    assert reply["status"] == "done" and reply["toolEvents"] == [] and reply["text"] == PROMISED
    assert _message(ctx, sid, asked)["gameHeld"] == {"ipIds": ["ip_hero"]}  # what hold_game_request would have left
    assert tools.held_game(snap)["messageId"] == asked["messageId"]
    # the next turn's state says so, and the page offers the request once the rig lands (web/src/api.ts heldGame)
    assert json.loads(agent.state_summary(snap))["heldGame"] == {"request": ASK, "ipIds": ["ip_hero"], "ready": False}


def test_the_button_named_alone_holds_the_request_in_a_session_without_a_game(ctx, session):
    sid = session["sessionId"]
    _hero(ctx, sid)
    asked, pending = _ask(ctx, sid)
    ctx.bedrock_rt_east._responses = [
        _calls(("render_3d", {"ipId": "ip_hero"})),
        _final("꼬마 마법사의 3D를 시작했어요. 3D가 끝나면 화면의 '게임에 반영' 버튼으로 게임을 만들 수 있어요.")]

    agent.run_turn(ctx, sid, pending["messageId"])

    assert _message(ctx, sid, asked)["gameHeld"] == {"ipIds": ["ip_hero"]}


def test_the_held_requests_own_button_is_a_promise_in_any_session(ctx, session):
    """A held request's button is 게임 만들기 (게임에 반영 takes new 3D into a game that exists). Named as a button it
    can mean nothing else, so it counts with a game in the session too."""
    sid = session["sessionId"]
    _hero(ctx, sid)
    store.put_game(ctx, sid, {"gameId": "gm_1", "title": "달빛 숲", "genre": "sf-shooter",
                              "createdAt": "2026-11-16T03:00:00.000Z"})
    asked, pending = _ask(ctx, sid, "이번에는 60초 보스전 게임을 새로 만들어줘")
    ctx.bedrock_rt_east._responses = [
        _calls(("render_3d", {"ipId": "ip_hero"})),
        _final("꼬마 마법사의 3D를 시작했어요. 3D가 끝나면 화면에 '게임 만들기' 버튼이 나타나요.")]

    agent.run_turn(ctx, sid, pending["messageId"])

    assert _message(ctx, sid, asked)["gameHeld"] == {"ipIds": ["ip_hero"]}
    assert tools.HELD_BUTTON == "게임 만들기" and tools.REMAKE_BUTTON == "게임에 반영"
    assert f"'{tools.HELD_BUTTON}'" in tools.HELD_GAME


@pytest.mark.parametrize("said", [
    # a game promised for later
    "세린 3D를 걸어 두었습니다. 3D가 끝나면 30초 생존 게임을 만들겠습니다.",
    "3D를 시작했어요. 3D가 완성되면 요청하신 게임을 만들어 드릴게요.",
    # a plain next step: the request asked for a game and its hero has no 3D, so the game is waiting whether the
    # reply says so or not
    "3D를 시작했어요. 3D가 끝나면 게임을 만들 수 있어요.",
    "게임 만들기 전에 3D가 먼저 필요해요. 3D를 시작했어요.",
])
def test_a_game_asked_for_before_its_heros_3d_is_held_whatever_words_the_reply_uses(ctx, session, said):
    sid = session["sessionId"]
    _hero(ctx, sid)
    asked, pending = _ask(ctx, sid)
    ctx.bedrock_rt_east._responses = [_calls(("render_3d", {"ipId": "ip_hero"})), _final(said)]

    agent.run_turn(ctx, sid, pending["messageId"])

    assert _message(ctx, sid, asked)["gameHeld"] == {"ipIds": ["ip_hero"]}


def test_words_about_a_later_game_mark_no_request_that_asks_for_none(ctx, session):
    """A mark on a 3D request would have the page offer that line as the held game, and send it again."""
    sid = session["sessionId"]
    _hero(ctx, sid)
    asked, pending = _ask(ctx, sid, "꼬마 마법사 3D 만들어줘")
    ctx.bedrock_rt_east._responses = [
        _calls(("render_3d", {"ipId": "ip_hero"})),
        _final("3D를 시작했어요. 3D가 끝나면 게임을 만들겠습니다. 그때 '게임에 반영'으로도 넣을 수 있어요.")]

    agent.run_turn(ctx, sid, pending["messageId"])

    assert "gameHeld" not in _message(ctx, sid, asked)


def test_the_tool_call_is_what_it_was_and_the_turn_adds_nothing(ctx, session):
    """Two characters without 3D: the agent names the hero, and the mark is the hero alone."""
    sid = session["sessionId"]
    _hero(ctx, sid)
    _hero(ctx, sid, "숲지기", "ip_npc")
    asked, pending = _ask(ctx, sid)
    ctx.bedrock_rt_east._responses = [
        _calls(("render_3d", {"ipId": "ip_hero"}), ("hold_game_request", {"ipId": "ip_hero"})), _final(PROMISED)]

    agent.run_turn(ctx, sid, pending["messageId"])

    assert _message(ctx, sid, asked)["gameHeld"] == {"ipIds": ["ip_hero"]}
    assert [e["tool"] for e in store.snapshot(ctx, sid)["messages"][-1]["toolEvents"]] == ["render_3d", "hold_game_request"]


def test_a_game_the_3d_gate_refuses_leaves_the_mark_whatever_the_reply_says(ctx, session):
    sid = session["sessionId"]
    _hero(ctx, sid)
    _running(ctx, sid, "rig", "ip_hero")
    spec = minimal_sf()
    spec["player"]["ipId"] = "ip_hero"
    asked, pending = _ask(ctx, sid)
    ctx.bedrock_rt_east._responses = [_calls(("make_game", {"spec": spec})), _final("3D가 아직이에요.")]

    agent.run_turn(ctx, sid, pending["messageId"])

    refused = ctx.bedrock_rt_east.calls[1]["messages"][-1]["content"][0]["toolResult"]
    assert refused["status"] == "error" and refused["content"][0]["json"]["error"] == "needs_3d"
    assert _message(ctx, sid, asked)["gameHeld"] == {"ipIds": ["ip_hero"]}
    assert store.snapshot(ctx, sid)["games"] == []


def test_a_turn_that_asks_for_no_game_is_not_marked(ctx, session):
    sid = session["sessionId"]
    _hero(ctx, sid)
    _add_ip(ctx, sid, "ip_can", b"CAN")
    store.update_ip(ctx, sid, "ip_can", kind="prop", name="등불")
    asked, pending = _ask(ctx, sid, "등불도 3D로 만들어줘")
    ctx.bedrock_rt_east._responses = [_calls(("render_3d", {"ipId": "ip_can"})),
                                      _final("등불의 3D를 시작했어요. 보통 6–15분 걸려요.")]

    agent.run_turn(ctx, sid, pending["messageId"])

    assert "gameHeld" not in _message(ctx, sid, asked)
    assert tools.held_game(store.snapshot(ctx, sid)) is None


def test_a_turn_that_made_the_game_is_not_marked(ctx, session):
    """The reply of a game that was made may name the button too (a later 3D goes into it by 게임에 반영)."""
    sid = session["sessionId"]
    _hero(ctx, sid)
    _glb(ctx, sid, "ip_hero")
    _hero(ctx, sid, "숲지기", "ip_npc")  # no 3D: it would be waited for if the turn were held
    spec = minimal_sf()
    spec["player"]["ipId"] = "ip_hero"
    asked, pending = _ask(ctx, sid)
    ctx.bedrock_rt_east._responses = [
        _calls(("make_game", {"spec": spec})),
        _final("게임을 만들었어요. 숲지기의 3D가 끝나면 '게임에 반영'으로 3D 모델로 바꿀 수 있어요. 보류한 것은 없어요.")]

    agent.run_turn(ctx, sid, pending["messageId"])

    assert len(store.snapshot(ctx, sid)["games"]) == 1
    assert "gameHeld" not in _message(ctx, sid, asked)


def test_a_reply_that_speaks_of_the_request_already_on_hold_moves_nothing(ctx, session):
    """A later reply that mentions the request already on hold does not move the mark to the new message."""
    sid = session["sessionId"]
    _hero(ctx, sid)
    _running(ctx, sid, "mesh3d", "ip_hero")
    asked, pending = _ask(ctx, sid)
    ctx.bedrock_rt_east._responses = [
        _final(PROMISED),
        _final("게임은 만들지 않았어요. 보류해 둔 \"30초 생존 게임\" 요청은 그대로 남아 있어요. 꼬마 마법사의 3D가 끝나면 "
               "'게임에 반영' 버튼이 나타나요.")]
    agent.run_turn(ctx, sid, pending["messageId"])
    later, pending = _ask(ctx, sid, "등불도 3D로 만들어줘. 게임은 아직 만들지 마.", at="03:33:40")
    agent.run_turn(ctx, sid, pending["messageId"])

    snap = store.snapshot(ctx, sid)
    assert [m["text"] for m in snap["messages"] if m.get("gameHeld")] == [ASK]
    assert "gameHeld" not in _message(ctx, sid, later)


def test_the_button_named_in_a_session_that_has_a_game_holds_nothing(ctx, session):
    """With a game in the session 게임에 반영 is the offer to re-make that game with a new 3D (web/src/api.ts
    rebuildRequest). A mark on this line would take that offer away: a newer held request silences it."""
    sid = session["sessionId"]
    _hero(ctx, sid)
    _glb(ctx, sid, "ip_hero")
    _hero(ctx, sid, "숲지기", "ip_npc")  # a second character without 3D
    store.put_game(ctx, sid, {"gameId": "gm_1", "title": "달빛 숲", "genre": "sf-shooter",
                              "createdAt": "2026-11-16T03:00:00.000Z"})
    asked, pending = _ask(ctx, sid, "늑대도 3D로 만들어줘")
    ctx.bedrock_rt_east._responses = [_final("늑대의 3D를 시작했어요. 끝나면 '게임에 반영' 버튼으로 게임에 넣을 수 있어요.")]

    agent.run_turn(ctx, sid, pending["messageId"])

    assert "gameHeld" not in _message(ctx, sid, asked)


def test_the_hero_the_reply_names_is_the_one_the_game_waits_for(ctx, session):
    sid = session["sessionId"]
    _hero(ctx, sid, "세린", "ip_serin")
    _hero(ctx, sid, "로완", "ip_rowan")
    _add_ip(ctx, sid, "ip_bug", b"BUG")
    store.update_ip(ctx, sid, "ip_bug", kind="enemy", name="가시 딱정벌레")
    asked, pending = _ask(ctx, sid, "로완을 주인공으로 하는 30초 생존 게임을 새로 만들어줘. 적은 가시 딱정벌레야.")
    ctx.bedrock_rt_east._responses = [_final("로완의 3D가 아직 끝나지 않아서 게임은 만들지 않고 요청을 보류해 뒀어요.")]

    agent.run_turn(ctx, sid, pending["messageId"])

    assert _message(ctx, sid, asked)["gameHeld"] == {"ipIds": ["ip_rowan"]}


def test_no_character_is_named_so_every_character_without_3d_is_waited_for(ctx, session):
    sid = session["sessionId"]
    _hero(ctx, sid, "세린", "ip_serin")
    _hero(ctx, sid, "로완", "ip_rowan")
    _glb(ctx, sid, "ip_serin")  # hers is ready
    assert tools.hold_heroes(store.snapshot(ctx, sid), {"text": ASK}, "게임 요청은 보류해 두었어요.") == ["ip_rowan"]
    # the design drawer's own hero wins over a name
    assert tools.hold_heroes(store.snapshot(ctx, sid), {"text": "[게임 설계] 로완", "gameDesign": {"playerIpId": "ip_serin"}},
                             "보류") == []
    # the IPs the user picked for the game, when the message carries them
    picked = {"text": "게임 만들어줘\n[출연 IP cast_ip_ids=ip_rowan]"}
    assert tools.hold_heroes(store.snapshot(ctx, sid), picked, "보류") == ["ip_rowan"]


def test_a_hold_said_when_every_hero_is_ready_marks_nothing(ctx, session):
    """Nothing to wait for (hold_game_request answers ready_3d): the request is made by asking again."""
    sid = session["sessionId"]
    _hero(ctx, sid)
    _glb(ctx, sid, "ip_hero")
    asked, pending = _ask(ctx, sid)
    ctx.bedrock_rt_east._responses = [_final(PROMISED)]

    agent.run_turn(ctx, sid, pending["messageId"])

    assert "gameHeld" not in _message(ctx, sid, asked)


def test_a_turn_cut_at_its_tool_limit_keeps_the_hold_it_said(ctx, session, monkeypatch):
    sid = session["sessionId"]
    _hero(ctx, sid)
    asked, pending = _ask(ctx, sid)
    monkeypatch.setattr(agent, "MAX_ROUNDS", 1)
    said = {"stopReason": "tool_use", "output": {"message": {"role": "assistant", "content": [
        {"text": "게임 요청은 보류해 두었어요."}, {"toolUse": {"toolUseId": "tu_0", "name": "render_3d", "input": {"ipId": "ip_hero"}}}]}}}
    ctx.bedrock_rt_east._responses = [said]

    agent.run_turn(ctx, sid, pending["messageId"])

    reply = store.snapshot(ctx, sid)["messages"][-1]
    assert reply["status"] == "done" and agent.LIMIT_NOTE in reply["text"]
    assert _message(ctx, sid, asked)["gameHeld"] == {"ipIds": ["ip_hero"]}


def test_the_prompt_says_a_hold_is_never_told_without_the_tool():
    rule = next(line for line in prompts.SYSTEM.splitlines() if line.startswith("- 3D 규칙:"))
    assert "hold_game_request를 부르지 않고" in rule and "보류했다" in rule
    [spec] = [s for s in tools.TOOL_SPECS if s["name"] == "hold_game_request"]
    assert "부르지 않고" in spec["description"]


# ── which turns mark a request, and which never do ─────────────────────────────
#
# The page offers a marked line as the held game and sends it again when the hero's 3D lands (web/src/api.ts heldGame,
# rebuildRequest), so a mark on a message that asked for no game costs a second 3D chain.
#
# The rule: only a game request can be held (it carries a 게임 설계, or speaks of a game and does not say to leave it
# unmade). For a message that asks to make a game, the session decides: the hero has no finished 3D, so the game the
# turn did not make is waiting, unless the reply says it was made or that something else is missing. The reply's
# own words decide only what the session cannot: a message that merely speaks of a game, and a hero that is ready
# while another cast member's 3D is not. There a hold counts when the reply tells it of this request, and one that
# its own sentence denies or asks about is none.

SPEAR_ASK = "꼬마 마법사가 달빛 창을 들고 싸우는 30초 생존 게임 만들어줘"
STARTED = "꼬마 마법사의 3D를 시작했어요. 보통 9–21분 걸려요."
# what a how-to answer reads like: the hold as a rule, not as something done to this message
EXPLAINED = ("3D가 끝나기 전에 게임을 요청하면 그 요청을 보류해 둬요. 3D가 끝나면 화면에 '게임 만들기' 버튼이 나타나고, "
             "누르면 요청한 대로 게임을 만들어요.")
HERO, SPEAR, NPC = ["ip_hero"], ["ip_spear"], ["ip_npc"]
RENDER = ("render_3d", {"ipId": "ip_hero"})


def _stage(ctx, sid, hero="none", spear=None, drawing=False, game=False, npc=False):
    """The session a probe runs in. hero: 꼬마 마법사's 3D is none | running (rig and turntable over a finished mesh)
    | ready. spear: 달빛 창, a weapon whose 3D is running | none. drawing: a new version of the hero's picture is
    being drawn. game: the session has a game. npc: a second character, 숲지기, without 3D."""
    _hero(ctx, sid)
    if hero in ("running", "ready"):
        _glb(ctx, sid, "ip_hero")
    if hero == "running":
        _running(ctx, sid, "rig", "ip_hero")
        _running(ctx, sid, "render3d", "ip_hero")
    if spear:
        _add_ip(ctx, sid, "ip_spear", b"SPEAR")
        store.update_ip(ctx, sid, "ip_spear", kind="weapon", name="달빛 창")
        if spear == "running":
            _running(ctx, sid, "mesh3d", "ip_spear")
    if npc:
        _hero(ctx, sid, "숲지기", "ip_npc")
    if drawing:
        job = jobs.create_job(ctx, sid, "image", "mediagen_image", {"ipId": "ip_hero"}, [])
        store.update_ip(ctx, sid, "ip_hero", imageJobId=job["jobId"])
    if game:
        store.put_game(ctx, sid, {"gameId": "gm_1", "title": "달빛 숲", "genre": "sf-shooter",
                                  "createdAt": "2026-11-16T03:00:00.000Z"})


def _probe(ctx, sid, text, calls, reply, design=None):
    asked, pending = _ask(ctx, sid, text)
    if design:
        store.update_message(ctx, sid, asked, gameDesign=design)
    ctx.bedrock_rt_east._responses = [*([_calls(*calls)] if calls else []), _final(reply)]
    agent.run_turn(ctx, sid, pending["messageId"])
    assert store.snapshot(ctx, sid)["messages"][-1]["status"] == "done"
    return _message(ctx, sid, asked).get("gameHeld", {}).get("ipIds")


# (the session, the user's message, the tools the turn calls, the reply) → the IPs the request waits for, or None
FALSE_MARKS = [
    # messages that ask for no game: no mark
    ("a 3D request answered with the held request's button", {},
     "꼬마 마법사 3D 만들어줘", [RENDER], "꼬마 마법사의 3D를 시작했어요. 3D가 끝나면 화면에 '게임 만들기' 버튼이 나타나요.", None),
    ("a 3D request that says to make no game, answered with a denial", {},
     "꼬마 마법사 3D 만들어줘. 게임은 아직 만들지 마.", [RENDER],
     "꼬마 마법사의 3D를 시작했어요. 게임은 만들지 않았고, 보류해 둔 게임 요청도 없어요.", None),
    ("a question about holds, answered no", {}, "지금 보류된 요청 있어?", [], "아니요, 지금 보류해 둔 게임 요청은 없어요.", None),
    ("a how-to question, answered with how a hold works", {}, "보류가 뭐야? 3D가 끝나기 전에 요청하면 어떻게 돼?", [], EXPLAINED, None),
    ("a drawing request answered with the design's button", {},
     "늑대 적을 하나 그려줘", [], "늑대 적을 그리고 있어요. 그림이 나오면 이 설계로 게임 만들기 버튼을 눌러 보세요.", None),
    # this one asks for a game, which cannot be made until the character it asks for has its 3D: on hold by the rule
    ("a game asked for together with its first character", {},
     "30초 생존 게임을 만들고 싶어. 먼저 캐릭터를 그려줘", [], "캐릭터를 그리고 있어요. 3D가 끝나면 게임을 만들게요.", HERO),
    # the same replies under messages that speak of a game and still ask for none
    ("no game, said in the message itself: the reply's button counts for nothing", {},
     "꼬마 마법사 3D 만들어줘. 게임은 아직 만들지 마.", [RENDER],
     "꼬마 마법사의 3D를 시작했어요. 게임은 만들지 않았어요. 3D가 끝나면 '게임 만들기' 버튼이 나타나요.", None),
    ("a question about held games", {}, "지금 보류된 게임 요청 있어?", [], "아니요, 지금 보류해 둔 게임 요청은 없어요.", None),
    ("how a game is made", {}, "게임은 어떻게 만들어?", [], EXPLAINED, None),
    ("what happens to a game asked for early", {}, "3D가 끝나기 전에 게임을 요청하면 어떻게 돼?", [], EXPLAINED, None),
    ("an enemy for the game", {}, "게임에 넣을 늑대 적을 하나 그려줘", [],
     "늑대를 그리고 있어요. 3D가 끝나면 화면에 '게임 만들기' 버튼이 나타나요.", None),
    ("a background for the game", {}, "게임 배경 만들어줘", [], "배경을 그리고 있어요. 3D가 끝나면 게임을 만들게요.", None),
    ("a trailer of the game", {"game": True}, "게임 트레일러 만들어줘", [], "샷이 끝나면 트레일러를 잘라 드려요.", None),
    ("the game published, with a second character still without 3D", {"hero": "ready", "game": True, "npc": True},
     "게임 게시해줘", [], "게임을 게시했어요. 맨 위 '게시하기'에서 공유 주소를 복사해 보세요.", None),
    ("whether a game can be made, answered not yet", {}, "게임 만들 수 있어?", [],
     "아직 꼬마 마법사의 3D가 없어서 만들 수 없어요. 카드의 '3D로 만들기'를 눌러 주세요.", None),
]
MISSES = [
    # a hold said without the word 보류 or the button's name
    ("put off", {}, ASK, [RENDER], "꼬마 마법사의 3D를 시작했어요. 게임은 잠시 미뤄 둘게요.", HERO),
    ("kept waiting", {"hero": "running"}, ASK, [], "3D가 아직 진행 중이에요. 게임 요청을 대기시켜 두었어요.", HERO),
    ("a button, not named", {}, ASK, [RENDER], "꼬마 마법사의 3D를 시작했어요. 3D가 끝나면 화면에 버튼이 나타나요.", HERO),
    # ... and the hold where the hero is ready and another cast member's 3D is not: the reply's words decide it
    ("the hero is ready, the weapon the request names is not", {"hero": "ready", "spear": "running"}, SPEAR_ASK, [],
     "달빛 창의 3D가 아직 끝나지 않아서 게임 요청은 보류해 두었어요. 3D가 끝나면 화면에 '게임 만들기' 버튼이 나타나요.", SPEAR),
    ("the hero is ready, a weapon nobody names is being made", {"hero": "ready", "spear": "running"}, ASK, [],
     "3D가 끝나면 화면에 '게임 만들기' 버튼이 나타나요.", SPEAR),
    ("the hero is ready, the weapon the reply names has no 3D yet", {"hero": "ready", "spear": "none"}, ASK, [],
     "달빛 창의 3D가 없어서 게임은 잠시 미뤄 둘게요. 카드의 '3D로 만들기'를 눌러 주세요.", SPEAR),
    ("the hero is ready, the weapon is not, and the reply holds nothing", {"hero": "ready", "spear": "running"}, ASK, [],
     "어떤 게임을 원하는지 조금만 더 알려 주세요.", None),
    ("one character is ready and the reply says which one the game waits for", {"hero": "ready", "npc": True}, ASK, [],
     "숲지기의 3D가 끝나면 화면에 '게임 만들기' 버튼이 나타나요.", NPC),
    ("one character is ready, nobody is named and nothing is said of a hold", {"hero": "ready", "npc": True}, ASK, [],
     "주인공을 누구로 할까요?", None),
]
OBSERVED = [
    ("the round's reply, as stored", {"hero": "running"}, ASK, [], PROMISED, HERO),
    # the words of a later game
    ("a game promised for when the 3D ends", {}, ASK, [RENDER], "세린 3D를 걸어 두었습니다. 3D가 끝나면 30초 생존 게임을 만들겠습니다.", HERO),
    ("... in other words", {}, ASK, [RENDER], "3D를 시작했어요. 3D가 완성되면 요청하신 게임을 만들어 드릴게요.", HERO),
    ("a plain next step", {}, ASK, [RENDER], "3D를 시작했어요. 3D가 끝나면 게임을 만들 수 있어요.", HERO),
    ("the bare words, no button", {}, ASK, [RENDER], "게임 만들기 전에 3D가 먼저 필요해요. 3D를 시작했어요.", HERO),
    ("the same words under a request that asks for no game", {}, "꼬마 마법사 3D 만들어줘", [RENDER],
     "3D를 시작했어요. 3D가 끝나면 게임을 만들겠습니다. 그때 '게임에 반영'으로도 넣을 수 있어요.", None),
]
RULE = [
    # a game request whose hero has no 3D is on hold with no word of it ...
    ("nothing said of the game at all", {}, ASK, [RENDER], STARTED, HERO),
    ("asked as a favour", {}, "30초 생존 게임 만들어 줄래?", [RENDER], STARTED, HERO),
    ("asked for after the 3D", {}, "3D가 끝나면 30초 생존 게임 만들어줘", [RENDER], "네, 3D를 시작했어요.", HERO),
    ("another game, in a session that has one", {"game": True}, "이번에는 60초 보스전 게임을 새로 만들어줘", [RENDER], STARTED, HERO),
    ("a first request, answered with the pictures being drawn", {"drawing": True}, ASK, [],
     "꼬마 마법사 그림을 그리고 있어요. 약 3분 뒤 '캐릭터' 탭에 나타나요. 그림이 나오면 카드의 '3D로 만들기'를 눌러 주세요.", HERO),
    # ... even under a reply that denies a hold or asks about one: those are its words, and the answer to "보류해
    # 둘까요?" is "응", a line that can carry no mark
    ("the reply says nothing is held", {}, ASK, [], "게임은 만들지 않았어요. 보류한 요청도 없어요.", HERO),
    ("the reply asks whether to hold it", {}, ASK, [], "3D가 끝날 때까지 게임 요청을 보류해 둘까요?", HERO),
    # ... unless the reply says the game was made, or that something else is missing
    ("the reply says the game was made", {}, ASK, [], "게임을 만들었어요. 오른쪽 '게임 시작'을 눌러 보세요.", None),
    ("the game was refused for its design", {}, ASK, [("make_game", {"spec": {"version": 9}})],
     "게임 설계에 문제가 있어 만들지 못했어요. 요청을 조금 바꿔 다시 보내 주세요.", None),
    ("the hero's picture is still being drawn", {"drawing": True}, ASK, [],
     "꼬마 마법사의 그림을 아직 그리는 중이에요(약 3분). 그림이 나오면 다시 요청해 주세요.", None),
    # a message that only speaks of a game: the reply's own word of a hold, and nothing less
    ("whether a game can be made, answered with a hold", {}, "게임 만들 수 있어?", [],
     "아직 꼬마 마법사의 3D가 끝나지 않았어요. 게임 요청은 보류해 두었어요.", HERO),
    ("whether a game can be made, answered that nothing is held", {}, "게임 만들 수 있어?", [],
     "아직 꼬마 마법사의 3D가 없어요. 보류한 요청은 없어요.", None),
    # where the reply decides, a hold it denies or asks about is none (the hero is ready, the weapon is not)
    ("a button named beside a denial", {"hero": "ready", "spear": "running"}, ASK, [],
     "보류한 요청은 없어요. 달빛 창의 3D가 끝나면 '게임 만들기' 버튼이 나타나요.", None),
    ("a hold asked about, not told", {"hero": "ready", "spear": "running"}, ASK, [],
     "달빛 창의 3D가 끝날 때까지 게임 요청을 보류해 둘까요?", None),
]


@pytest.mark.parametrize("stage,text,calls,reply,waits", [pytest.param(*case[1:], id=case[0])
                                                          for case in FALSE_MARKS + MISSES + OBSERVED + RULE])
def test_which_turns_mark_a_game_request(ctx, session, stage, text, calls, reply, waits):
    sid = session["sessionId"]
    _stage(ctx, sid, **stage)
    assert _probe(ctx, sid, text, calls, reply) == waits
    if waits is None:
        assert tools.held_game(store.snapshot(ctx, sid)) is None


def test_a_game_design_whose_hero_has_no_3d_is_held_with_no_word_of_it(ctx, session):
    """The design drawer's request carries its hero: the game waits for that one, whoever else has no 3D."""
    sid = session["sessionId"]
    _stage(ctx, sid, npc=True)
    design = {"prompt": "달빛 숲 생존", "castIpIds": ["ip_hero", "ip_npc"], "playerIpId": "ip_hero", "weaponIpId": None,
              "propIpIds": [], "enemyIpIds": [], "npcIpIds": ["ip_npc"]}
    assert _probe(ctx, sid, "달빛 숲 생존", [RENDER], STARTED, design) == HERO


def test_a_mark_the_page_would_send_again_never_sits_on_a_request_for_3d_or_a_picture(ctx, session):
    """Every reply of the tables above, under requests that start GPU work and ask for no game: the page would send a
    marked line again (web/src/api.ts rebuildRequest)."""
    sid = session["sessionId"]
    _stage(ctx, sid)
    replies = {case[4] for case in FALSE_MARKS + MISSES + OBSERVED + RULE}
    for n, reply in enumerate(sorted(replies)):
        for text in ("꼬마 마법사 3D 만들어줘", "늑대 적을 하나 그려줘", "꼬마 마법사 영상 샷 만들어줘"):
            asked, pending = _ask(ctx, sid, text, at=f"04:{n:02d}:00")
            ctx.bedrock_rt_east._responses = [_final(reply)]
            agent.run_turn(ctx, sid, pending["messageId"])
            assert "gameHeld" not in _message(ctx, sid, asked), (text, reply)


@pytest.mark.parametrize("text,asks", [
    # asks to make a game
    (ASK, True), ("30초 생존 게임을 새로 만들어줘", True), ("게임 만들어 줄래?", True), ("게임 만들어주세요", True),
    ("아니, 60초 보스전 게임으로 만들어줘", True), ("게임 빨리 만들어줘", True), ("30초 생존 게임을 만들고 싶어", True),
    ("이 IP들로 게임 하나 만들자", True), ("슈팅 게임 제작해줘", True), ("게임을 이 IP들로 만들어줘", True),
    ("3D가 끝나면 게임 만들어줘", True), ("게임은 3D 끝나면 만들어줘", True), ("게임 만들기", True),
    ("먼저 3D 만들고 그 다음에 게임 만들어줘", True), ("게임 만들어줘. 3D가 안 끝났으면 보류해줘", True),
    # speaks of one
    ("게임은 어떻게 만들어?", None), ("게임 만들 수 있어?", None), ("게임 만들려면 뭐가 필요해?", None),
    ("게임에 넣을 캐릭터를 만들어줘", None), ("게임 배경 만들어줘", None), ("게임 트레일러 만들어줘", None),
    ("게임 게시해줘", None), ("게임 만들기 전에 캐릭터부터 그려줘", None), ("[게임 수정 gameId=gm_1] 적을 더 빠르게 해줘", None),
    ("게임이 만들어졌어?", None), ("왜 게임 안 만들어줘?", None), ("게임은 나중에 만들어줘", None),
    ("게임 삭제해줘", None), ("게임 만들어도 돼?", None), ("[에셋 수정 ipId=ip_1] 리라: 게임에서 잘 보이게 밝게 해줘", None),
    ("[게임 수정 gameId=gm_1] 새 3D가 준비됐으니 '달빛 숲'을(를) 같은 설계와 출연 IP 그대로 다시 만들어 3D 모델로 바꿔줘. "
     "나머지는 그대로 둬.", None),
    # everyday phrasing that is easy to misread, in both directions
    ("꼬마 마법사를 게임 캐릭터로 만들어줘", None), ("이 고양이를 게임 캐릭터로 만들어줘", None),
    ("[에셋 수정 ipId=ip_1] 꼬마 마법사: 게임 캐릭터로 만들어줘", None), ("게임 만들어야 하니까 꼬마 마법사 3D 만들어줘", None),
    ("게임 만들어줘서 고마워", None), ("아까 게임 만들어줬잖아. 그거 보여줘", None), ("게임 만들어주셔서 감사해요", None),
    ("게임 하나 더 만들어줘", True), ("게임 한 번 만들어줘", True), ("게임도 같이 만들어줘", True), ("게임까지 만들어줘", True),
    ("게임 하나만 만들어줘", True), ("이 캐릭터들로 게임 만들어줘", True), ("게임을 이 캐릭터로 만들어줘", True),
    # asks for none
    ("꼬마 마법사 3D 만들어줘", False), ("꼬마 마법사 3D 만들어줘. 게임은 아직 만들지 마.", False),
    ("게임 만들지 말고 3D만 해줘", False), ("게임 말고 영상 만들어줘", False), ("게임 요청 취소해줘", False),
    ("이제 만들어줘", False), ("", False),
])
def test_what_a_game_request_is(text, asks):
    assert agent._asks_game({"text": text}) is asks


def test_a_message_with_a_game_design_asks_for_a_game_whatever_it_says():
    assert agent._asks_game({"text": "달빛 숲 생존", "gameDesign": {"playerIpId": "ip_hero"}}) is True


@pytest.mark.parametrize("reply,says", [
    # the request put aside, as something done or promised
    ("게임 요청은 보류해 두었습니다.", True), ("요청을 보류해 뒀어요.", True), ("게임 요청은 보류했어요.", True),
    ("게임은 잠시 미뤄 둘게요.", True), ("게임 요청을 대기시켜 두었어요.", True), ("요청은 3D가 끝날 때까지 보류해 둘게요.", True),
    ("지금은 게임을 미룰 수밖에 없어요.", True),
    # nothing is held, or the game exists
    ("보류해 둔 게임 요청은 없어요.", False), ("보류한 것은 없어요.", False), ("요청을 보류하지 않았어요.", False),
    ("게임 요청을 보류해 둘까요?", False), ("게임을 만들었어요.", False), ("이미 만든 게임이 있어요.", False),
    # the game by its title, or as a new version
    ("웨이브 서바이벌 게임 \"잿빛 이후: 지하철역 방어전\"을 만들었습니다.", False),
    ("두 번째 게임 「잿빛 이후: 안개 숲의 공터」를 만들었습니다.", False), ("더 어려운 30초 생존 게임을 새 버전으로 만들었습니다.", False),
    # neither: a rule, a hold that already stands, a 3D that was queued
    (EXPLAINED, None), ("보류해 둔 \"30초 생존 게임\" 요청은 그대로 남아 있어요.", None), ("세린 3D를 걸어 두었습니다.", None),
    ("게임에 쓸 늑대의 3D 작업이 대기 중이에요.", None), ("3D가 끝나면 게임을 만들 수 있어요.", None),
    # ... and what was made is not the game
    ("게임에 넣을 캐릭터를 먼저 만들었어요.", None), ("게임 설계를 만들었어요.", None), ("게임은 아직 만들지 못했습니다.", None),
])
def test_what_a_reply_says_of_a_hold(reply, says):
    assert agent._says_hold(reply, False) is says


def test_a_button_or_a_promise_counts_only_under_a_request_to_make_a_game():
    for reply in ("3D가 끝나면 화면에 '게임 만들기' 버튼이 나타나요.", "3D가 끝나면 화면에 버튼이 나타나요.",
                  "3D가 끝나면 30초 생존 게임을 만들겠습니다.", "게임은 달빛 창의 3D가 끝난 뒤에 만들게요."):
        assert agent._says_hold(reply, True) is True and agent._says_hold(reply, False) is None
    # ... and never over a reply that says nothing is held
    assert agent._says_hold("보류한 요청은 없어요. 3D가 끝나면 '게임 만들기' 버튼이 나타나요.", True) is False
