"""What the server itself says to a person, in the request's language: refusals, a card button's toast, 작업 기록, the
lines the server writes into the chat, the watch window's viewers and ad reasons, the agents' pages. Korean is the
default and is what every other test file holds; these hold the English, and that work which goes on after its
request is written in the language of the request that started it."""
import json
import re

import pytest

from server import adserver, agent, agents, app, connections, game_design, i18n, live, playable, store, streams, tools, viewers
from server.providers import mediagen_image, rig
from server.tests.test_agents import DEMO, DEMO_USER
from server.tests.test_agents import ctx as agents_ctx  # noqa: F401 (fixture)
from server.tests.test_agents import mcp  # noqa: F401 (fixture)
from server.tests.test_app import TOKEN, _new_session, ctx  # noqa: F401 (fixture)
from server.tests.test_round20_hold import _hero
from server.tests.test_viewer_ads import NOW, _at, _c, _racer

HANGUL = re.compile(r"[가-힣]")


@pytest.fixture(autouse=True)
def korean_after():
    yield
    i18n.use("ko")


def call(method, path, body=None, lang="en", token=TOKEN):
    """A request as the page sends it: X-Lang beside the token (the function URL lower-cases header names)."""
    event = {"requestContext": {"http": {"method": method}}, "rawPath": path, "isBase64Encoded": False,
             "headers": {"x-auth-token": token, **({"x-lang": lang} if lang else {})},
             "body": None if body is None else json.dumps(body)}
    resp = app.handler(event, None)
    return resp["statusCode"], (json.loads(resp["body"]) if resp["body"] else None)


def english(text) -> str:
    assert isinstance(text, str) and text and not HANGUL.search(text), text
    assert not text.endswith("!")
    return text


# ── the request's language, and the session's memory of it ─────────────────────

def test_a_refusal_is_in_the_requests_language(ctx):  # noqa: F811
    assert call("GET", "/api/sessions/ses_none")[1] == {
        "error": "not_found", "message": "That session was not found. Pick it again from the list."}
    assert call("GET", "/api/sessions/ses_none", lang="ko")[1]["message"] == "세션을 찾지 못했어요. 목록에서 다시 골라 주세요."
    assert call("GET", "/api/sessions/ses_none", lang=None)[1]["message"].startswith("세션을")  # no header: Korean
    assert call("GET", "/api/sessions/ses_none", lang="ja")[1]["message"].startswith("세션을")  # anything else too
    sid = _new_session()
    assert call("POST", f"/api/sessions/{sid}/chat", {"text": "x" * 4001})[1]["message"] == (
        "That message is too long. Shorten it to 4,000 characters and send it again.")
    assert english(call("POST", f"/api/sessions/{sid}/chat", {"text": " "})[1]["message"])
    assert english(call("PATCH", f"/api/sessions/{sid}", {"title": " "})[1]["message"])
    assert english(call("POST", f"/api/sessions/{sid}/jobs/job_none/retry")[1]["message"])
    assert english(call("POST", f"/api/sessions/{sid}/tools/nothing/async", {})[1]["message"])
    assert english(call("GET", "/api/nothing")[1]["message"])
    assert english(call("POST", f"/api/sessions/{sid}/chat", {"text": "make a game", "gameDesign": "x"})[1]["message"])


def test_an_event_that_is_no_request_starts_in_korean(ctx):  # noqa: F811
    call("GET", "/api/sessions")
    assert i18n.lang() == "en"
    app.handler({"action": "jobs_tick"}, None)
    assert i18n.lang() == "ko"  # a warm container does not carry the last request's language into the tick


def _writes(ctx, monkeypatch):  # noqa: F811
    """Every write to the table from here on, as a list of the methods called."""
    seen = []
    for name in ("put_item", "update_item", "delete_item"):
        real = getattr(ctx.table, name)
        monkeypatch.setattr(ctx.table, name,
                            lambda *a, _real=real, _name=name, **k: (seen.append(_name), _real(*a, **k))[1])
    return seen


def _payload(ctx, action):  # noqa: F811
    """The latest self-invoke of one action, as the Lambda gets it."""
    return next(p for p in (json.loads(c["Payload"]) for c in reversed(ctx.lambda_.calls)) if p["action"] == action)


def test_a_poll_writes_nothing_and_only_a_post_that_starts_work_keeps_the_language(ctx, monkeypatch):  # noqa: F811
    """Only a POST that starts work writes session.lang: two pages in two languages on one session (a shared account)
    must not flip it on every poll."""
    sid = _new_session()
    writes = _writes(ctx, monkeypatch)
    for lang in ("en", "ko", "en", "ko"):
        assert call("GET", f"/api/sessions/{sid}", lang=lang)[0] == 200
    assert writes == [] and "lang" not in store.get_session(ctx, sid)
    # the POSTs that start work keep it (for what is written outside a request)
    updated = store.get_session(ctx, sid)["updatedAt"]
    assert call("POST", f"/api/sessions/{sid}/chat", {"text": "make a character"})[0] == 202
    assert store.get_session(ctx, sid)["lang"] == "en"
    assert store.get_session(ctx, sid)["updatedAt"] == updated  # a language is no edit of the session
    del writes[:]
    for lang in ("ko", "en"):
        call("GET", f"/api/sessions/{sid}", lang=lang)
        call("PATCH", f"/api/sessions/{sid}", {}, lang=lang)  # nor a request that starts no work
        call("POST", f"/api/sessions/{sid}/jobs/job_none/cancel", lang=lang)
    assert writes == [] and store.get_session(ctx, sid)["lang"] == "en"
    _hero(ctx, sid)
    call("POST", f"/api/sessions/{sid}/tools/render_3d", {"ipId": "ip_none"}, lang="ko")  # a card's button, Korean page
    assert store.get_session(ctx, sid)["lang"] == "ko"
    call("POST", f"/api/sessions/{sid}/tools/reroll_ip_image/async", {"ipId": "ip_none"})
    assert store.get_session(ctx, sid)["lang"] == "en"
    call("POST", f"/api/sessions/{sid}/live", {}, lang="ko")  # a broadcast start (refused here: no game)
    assert store.get_session(ctx, sid)["lang"] == "ko"


def test_the_async_payloads_carry_the_language_of_the_request_that_started_the_work(ctx):  # noqa: F811
    sid = _new_session()
    call("POST", f"/api/sessions/{sid}/chat", {"text": "make a character"})
    assert _payload(ctx, "agent_turn")["lang"] == "en"
    call("POST", f"/api/sessions/{sid}/chat", {"text": "캐릭터 만들어줘"}, lang="ko")
    assert _payload(ctx, "agent_turn")["lang"] == "ko"
    call("POST", f"/api/sessions/{sid}/tools/reroll_ip_image/async", {"ipId": "ip_none"})
    assert _payload(ctx, "run_tool")["lang"] == "en"
    # the handler: the header of a request, else the payload's own word, else Korean
    assert i18n.from_event({"headers": {"x-lang": "en"}, "lang": "ko"}) == "en"
    assert i18n.from_event({"headers": {"x-lang": "ko"}, "lang": "en"}) == "ko"
    assert i18n.from_event({"action": "agent_turn", "lang": "en"}) == "en"
    assert i18n.from_event({"action": "agent_turn"}) == "ko" and i18n.from_event({"action": "x", "lang": "fr"}) == "ko"


def test_two_pages_in_two_languages_never_change_what_a_turn_answers_in(ctx):  # noqa: F811
    """The turn started from the English page answers in English whatever the other page polls or presses between
    the POST and the turn, and a Korean page's turn answers in Korean beside an English page."""
    sid = _new_session()
    _hero(ctx, sid)

    class Says:
        def __init__(self):
            self.systems = []

        def converse(self, **kwargs):
            self.systems.append(kwargs["system"][0]["text"])
            raise RuntimeError("ThrottlingException")
    ctx.bedrock_rt_east = Says()
    status, sent = call("POST", f"/api/sessions/{sid}/chat", {"text": "make a character"})
    turn = _payload(ctx, "agent_turn")
    for _ in range(3):  # both pages poll
        call("GET", f"/api/sessions/{sid}", lang="ko")
        call("GET", f"/api/sessions/{sid}")
    call("POST", f"/api/sessions/{sid}/tools/render_3d", {"ipId": "ip_none"}, lang="ko")  # the Korean page's button
    call("GET", f"/api/sessions/{sid}", lang="ko")
    assert store.get_session(ctx, sid).get("lang") == "ko"  # the session's own word is the Korean page's by now
    app.handler(turn, None)
    reply = next(m for m in store.snapshot(ctx, sid)["messages"] if m["messageId"] == sent["messageId"])
    assert "## Language: English" in ctx.bedrock_rt_east.systems[-1]
    assert reply["status"] == "failed" and reply["text"].startswith("Sorry, the request could not be ")
    # the other way round
    status, sent = call("POST", f"/api/sessions/{sid}/chat", {"text": "캐릭터 만들어줘"}, lang="ko")
    turn = _payload(ctx, "agent_turn")
    call("GET", f"/api/sessions/{sid}")
    call("POST", f"/api/sessions/{sid}/tools/render_3d", {"ipId": "ip_none"})  # the English page's button
    assert store.get_session(ctx, sid).get("lang") == "en"
    app.handler(turn, None)
    reply = next(m for m in store.snapshot(ctx, sid)["messages"] if m["messageId"] == sent["messageId"])
    assert "## Language: English" not in ctx.bedrock_rt_east.systems[-1] and reply["text"].startswith("죄송해요")
    # a card's background tool: its line is in the language of the page that pressed it
    call("POST", f"/api/sessions/{sid}/tools/reroll_ip_image/async", {"ipId": "ip_none"})
    pressed = _payload(ctx, "run_tool")
    call("POST", f"/api/sessions/{sid}/tools/render_3d", {"ipId": "ip_none"}, lang="ko")
    app.handler(pressed, None)
    line = next(m for m in store.snapshot(ctx, sid)["messages"] if m["messageId"] == pressed["message"]["messageId"])
    assert line["text"] == "Redraw could not be started. This screen is out of date. Reload and try again."


def test_a_chains_end_is_told_in_the_language_of_the_request_that_started_it(ctx):  # noqa: F811
    """The line is written by whichever poll sees the chain end (or by none: the minute tick settles the jobs), so
    it is not in that poll's language: the chain's mark keeps the language of the request that started it."""
    sid = _new_session()
    _hero(ctx, sid, "Theo")
    for job_id in ("job_a", "job_b"):
        store.put_job(ctx, sid, {"jobId": job_id, "kind": "render3d", "provider": "deadline", "status": "done",
                                 "deps": [], "input": {"ipId": "ip_hero"}, "outputs": []})
    i18n.use("en")  # the English page's button started the first chain
    agent.watch(ctx, sid, "render_3d", {"jobId": "job_a"})
    i18n.use("ko")  # the Korean page's the second
    agent.watch(ctx, sid, "render_3d", {"jobId": "job_b"})
    status, snap = call("GET", f"/api/sessions/{sid}", lang="ko")  # the Korean page's poll writes both lines
    assert sorted(m["text"] for m in snap["messages"][-2:]) == sorted([
        "Theo's 3D is ready. Turn it around in the ‘3D’ tab.", "Theo의 3D가 준비됐어요. ‘3D’ 탭에서 돌려 볼 수 있어요."])
    assert i18n.lang() == "ko"  # the poll's own language is unchanged
    store.put_job(ctx, sid, {"jobId": "job_c", "kind": "render3d", "provider": "deadline", "status": "done",
                             "deps": [], "input": {"ipId": "ip_hero"}, "outputs": []})
    agent.watch(ctx, sid, "render_3d", {"jobId": "job_c"})  # Korean
    status, snap = call("GET", f"/api/sessions/{sid}")  # ... and the English page's poll writes it in Korean
    assert snap["messages"][-1]["text"] == "Theo의 3D가 준비됐어요. ‘3D’ 탭에서 돌려 볼 수 있어요."


def test_the_turn_and_a_buttons_tool_answer_in_the_language_of_their_payload(ctx):  # noqa: F811
    """Both run in a self-invoke with no header: the payload says the language of the page that asked."""
    sid = _new_session()
    status, sent = call("POST", f"/api/sessions/{sid}/chat", {"text": "make a character"})
    assert status == 202

    class Down:
        def converse(self, **kwargs):
            raise RuntimeError("ThrottlingException")
    ctx.bedrock_rt_east = Down()
    app.handler(_payload(ctx, "agent_turn"), None)
    failed = store.snapshot(ctx, sid)["messages"][-1]
    assert failed["status"] == "failed" and failed["text"] == (
        "Sorry, the request could not be completed. Send the same request again in a moment. The pictures and jobs "
        "made so far are still there.")
    # a card's button whose tool runs in the background: its waiting line, then its refusal
    _hero(ctx, sid)
    status, pressed = call("POST", f"/api/sessions/{sid}/tools/reroll_ip_image/async", {"ipId": "ip_none"})
    def line():  # (by its id: the turn's reply above sorts a millisecond after its request)
        return next(m for m in store.snapshot(ctx, sid)["messages"] if m["messageId"] == pressed["messageId"])
    assert status == 202 and line()["text"] == "Redrawing…"
    app.handler(_payload(ctx, "run_tool"), None)
    line = line()
    assert line["status"] == "failed" and line["text"] == (
        "Redraw could not be started. This screen is out of date. Reload and try again.")


def test_a_stale_turn_is_failed_in_the_language_of_the_page_that_polls(ctx, monkeypatch):  # noqa: F811
    sid = _new_session()
    store.put_message(ctx, sid, "assistant", "", "pending", ts="2026-01-01T00:00:00.000Z")
    status, snap = call("GET", f"/api/sessions/{sid}")
    assert snap["messages"][-1]["text"] == "The reply took too long and was stopped. Ask again."


# ── a card button's toast, 작업 기록, a button's chat line ──────────────────────

def test_a_buttons_refusal_is_a_sentence_in_english(ctx):  # noqa: F811
    sid = _new_session()
    _hero(ctx, sid, "Theo")
    status, body = call("POST", f"/api/sessions/{sid}/tools/render_3d", {"ipId": "ip_hero", "rig_only": True})
    assert status == 400 and body["message"] == "Theo has no 3D model yet. Press ‘Make 3D’ first."
    status, body = call("POST", f"/api/sessions/{sid}/tools/render_3d", {"ipId": "ip_gone"})
    assert status == 404 and body["message"] == "This screen is out of date. Reload and try again."
    status, body = call("POST", f"/api/sessions/{sid}/publish", {"gameId": "gm_none"})
    assert status == 404 and english(body["message"])
    # ... and the same press from a Korean page says what it said
    status, body = call("POST", f"/api/sessions/{sid}/tools/render_3d", {"ipId": "ip_hero", "rig_only": True}, lang="ko")
    assert body["message"] == "Theo의 3D 모델이 아직 없으니 ‘3D로 만들기’를 먼저 눌러 주세요."


@pytest.mark.parametrize("name, args, result, line", [
    ("render_3d", {"ipId": "ip_1"}, {"jobId": "job_1"}, "Make 3D: job_1"),
    ("create_ip_asset", {"kind": "character", "name": "Theo"}, {"ipId": "ip_1"}, "Make character: Theo"),
    ("create_ip_asset", {"kind": "weapon", "name": "Moonlit Spear"}, {"ipId": "ip_2"}, "Make weapon: Moonlit Spear"),
    ("make_game", {"spec": {"title": "Moonlit Run"}}, {"gameId": "gm_1"}, "Make game: Moonlit Run"),
    ("hold_game_request", {"ipId": "ip_1"}, {"waiting3d": []}, "Hold game request"),
    ("publish_game", {}, {"publishedUrl": "https://x"}, "Publish"),
    # a refusal: the reason by its code, or the refusal's own sentence for the user, never the agent's Korean copy
    ("make_game", {}, {"error": "needs_3d", "message": "주인공 테오(ip_1)의 3D가 아직 끝나지 않아 게임을 만들 수 없습니다."},
     "Make game failed: The hero's 3D is not finished yet"),
    ("make_video_shot", {}, {"error": "images_pending", "message": "테오의 이미지를 아직 그리는 중입니다.",
                             "notice": "The picture of Theo is still being drawn (about 3 min). Press again when it is in."},
     "Video shot failed: The picture of Theo is still being drawn (about 3 min)"),
    ("set_concept", {}, {"error": "bad_args", "message": "palette는 #rrggbb 색 3개여야 합니다"}, "Set concept failed: The input was not valid"),
    ("reroll_ip_image", {}, {"error": "check_failed", "message": "구도 검사 실패: 피사체 2개.", "notice": "구도 검사 실패"},
     "Redraw failed: The picture did not pass its check"),
    ("make_game", {}, {"error": "city_world_required", "message": "도시·오픈월드 요청은 …"}, "Make game failed: The request could not be completed"),
])
def test_a_work_log_line_in_english(name, args, result, line):
    i18n.use("en")
    assert tools.summarize(name, args, result) == line and english(line)


def test_a_work_log_line_in_korean_is_as_it_was():
    assert tools.summarize("render_3d", {"ipId": "ip_1"}, {"jobId": "job_1"}) == "3D로 만들기: job_1"
    assert tools.summarize("make_game", {}, {"error": "needs_3d", "message": "주인공의 3D가 아직 끝나지 않았습니다. 다시 부르지 마세요."}) == (
        "게임 만들기 실패: 주인공의 3D가 아직 끝나지 않았습니다.")
    assert tools.tool_label("create_ip_asset", "enemy") == "적 만들기" and tools.tool_label("unknown_tool") == "unknown_tool"


def test_every_tool_and_every_refusal_code_of_the_table_has_an_english_name():
    for label in (*tools._LABELS.values(), *tools._KIND_LABELS.values(), *agent.TOOL_LABELS.values(),
                  *agent.STATE_LABELS.values(), *agent.WORD_LABELS.values(), *agent._STEP.values(),
                  tools.HELD_BUTTON, tools.REMAKE_BUTTON):
        assert label in i18n.LABELS, label
    for sentence in (*tools._WHY.values(), tools.WHY_OTHER, tools.ARGS_REFUSED, tools.REFUSED):
        assert sentence in i18n.EN


def test_restoring_a_version_writes_its_chat_line_in_english(ctx):  # noqa: F811
    sid = _new_session()
    _hero(ctx, sid, "Theo")
    snap = store.snapshot(ctx, sid)
    image = next(a for a in snap["assets"] if a["kind"] == "image")
    status, body = call("POST", f"/api/sessions/{sid}/tools/restore_ip_version",
                        {"ipId": "ip_hero", "imageAssetId": image["assetId"]})
    assert status == 200, body
    assert store.snapshot(ctx, sid)["messages"][-1]["text"] == "Use this version: Theo v1. This version is the current picture now."


# ── the lines the server writes into the chat ──────────────────────────────────

def _chain(kind, status="done", **more):
    return {"jobId": f"job_{kind}", "kind": kind, "status": status, "input": {"ipId": "ip_hero"}, "deps": [], **more}


def _snap(jobs, messages=(), ip=None):
    return {"session": {"sessionId": "ses_1"}, "messages": list(messages), "games": [], "jobs": jobs, "assets": [],
            "ips": [ip or {"ipId": "ip_hero", "name": "Theo", "kind": "character"}]}


def test_a_chains_end_is_told_in_english():
    i18n.use("en")
    done = [_chain("apose"), _chain("mesh3d"), _chain("render3d"), _chain("rig")]
    assert agent._finished(_snap(done), done) == "Theo's 3D is ready. Turn it around in the ‘3D’ tab."
    failed = [_chain("apose"), _chain("mesh3d"), _chain("render3d", "failed", error="Blender 작업 실패")]
    assert agent._finished(_snap(failed), failed) == (
        "Theo's 3D model is ready, but the Turntable video step failed. The ‘Jobs’ tab shows the reason and what to do next.")
    early = [_chain("apose", "failed", error="그림 실패")]
    assert agent._finished(_snap(early), early) == (
        "Theo's 3D could not be made (the 3D pose image step failed). The ‘Jobs’ tab shows the reason and what to do next.")
    refused = [_chain("mesh3d"), _chain("rig", "failed", outcome="refused", reason=rig.REASONS[0][1], error="x")]
    assert agent._finished(_snap(refused), refused) == (
        "Theo's 3D model is ready, but the Rig could not be added: the legs are not in view or are too short. "
        "A game made with it as it is plays without walking motions. For walking motions, redraw it as a picture "
        "that shows the figure from head to toe, standing with both legs in view, then make the 3D again.")
    trailer = [{"jobId": "job_t", "kind": "trailer", "status": "done", "input": {"make_shorts": True}, "deps": []}]
    assert agent._finished(_snap(trailer), trailer) == "The trailer and shorts are ready. Watch them in the ‘Video’ tab."
    trailer[0]["status"] = "failed"
    assert english(agent._finished(_snap(trailer), trailer))


def test_a_chains_end_in_korean_is_as_it_was():
    done = [_chain("mesh3d"), _chain("render3d")]
    assert agent._finished(_snap(done), done) == "Theo의 3D가 준비됐어요. ‘3D’ 탭에서 돌려 볼 수 있어요."
    refused = [_chain("mesh3d"), _chain("rig", "failed", outcome="refused", reason=rig.REASONS[0][1], error="x")]
    assert agent._finished(_snap(refused), refused) == (
        f"Theo의 3D 모델은 준비됐지만 움직임 뼈대는 넣지 못했어요: {rig.REASONS[0][1]}. 이대로 게임을 만들면 {rig.NO_MOTION}. {rig.REDRAW}")


def test_the_turns_own_notes_have_english():
    i18n.use("en")
    for note in (agent.LIMIT_NOTE, agent.TIME_NOTE, agent.TRUNCATED, agent.FAILED_NOTE, agent.FAILED_WHERE):
        assert english(i18n.tr(note))
    assert "‘continue’" in i18n.tr(agent.LIMIT_NOTE)


def test_a_rejected_edit_is_told_in_the_sessions_language():
    """The job settles on a poll or on the minute tick: the line is in the language the session's page last had."""
    job = {"input": {"model": "klein9", "edit": "a red cape"}}
    ip, check = {"name": "Theo", "version": 1}, {"problem": "요청하지 않은 배경 변경, 요청 밖 변경: 장갑 모양이 달라짐"}
    ko = mediagen_image.rejected_message(job, ip, 2, check)
    assert ko.startswith("Theo의 수정한 그림(v2)은 수정 검사를 통과하지 못해 쓰지 않았어요. 이유: 요청하지 않은 배경 변경")
    en = mediagen_image.rejected_message(job, ip, 2, check, "en")
    assert en.startswith("The edited picture of Theo (v2) did not pass the edit check and was not used. Reason: the "
                         "background changed without being asked, a change that was not asked for: ")
    assert "The current picture (v1) is as it was." in en and en.endswith(
        "Ask again with a narrower change (for example ‘keep the background and make only the cape red’).")
    assert "‘retry with another model’" in mediagen_image.rejected_message(
        {"input": {"model": "klein9", "edit": "x", "headModel": "qwen"}}, ip, 2, check, "en")


@pytest.mark.parametrize("problem, said", [
    ("피사체 2개", "2 subjects in the picture"), ("피사체가 없음", "no subject in the picture"),
    ("위쪽·왼쪽이 프레임에 잘림", "cut off at the top, left"),
    ("피사체 2개, 아래쪽이 프레임에 잘림", "2 subjects in the picture, cut off at the bottom"),
    ("투구·가면으로 가려진 머리가 사람 얼굴로 바뀜", "a head covered by a helmet or mask became a human face"),
    ("화풍이 바뀜(또는 서명·글자가 생김)", "the art style changed (or a signature or text appeared)"),
])
def test_a_checks_problem_in_english(problem, said):
    assert i18n.problem(problem, "en") == said and i18n.problem(problem) == problem


# ── waits and tables ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("ko, en", [
    ("보통 4–7분", "usually 4–7 min"), ("약 3분", "about 3 min"), ("20초–3분", "20 s–3 min"), ("1–2분", "1–2 min"),
    ("3시간 20분", "3 h 20 min"), ("1분 30초", "1 min 30 s"), ("~10분", "~10 min"),
])
def test_a_wait_is_said_in_english_with_its_numbers(ko, en):
    assert i18n.span(ko, "en") == en and i18n.span(ko) == ko


def test_the_game_design_drawers_refusals_have_english():
    i18n.use("en")
    design, errors = game_design.validate_design({"prompt": "x", "castIpIds": ["ip_gone"], "playerIpId": None,
                                                  "weaponIpId": None, "propIpIds": [], "enemyIpIds": [], "npcIpIds": []},
                                                 {}, "y")
    assert design is None and errors and all(english(e) for e in errors)
    assert game_design.validate_design("x", {}, "y") == (None, ["The game design could not be read. Close Game design and open it again."])


def test_the_named_refusals_have_english():
    """Set once and raised by name (test_round20_errors.py reads their Korean)."""
    i18n.use("en")
    for said in (i18n.tr(app.BAD_REQUEST), i18n.tr(live.BUSY, minutes=live.MAX_MINUTES), i18n.tr(live.OTHER_SESSION_TEXT),
                 i18n.tr(live.SWITCH_BUSY_TEXT), i18n.tr(live.NO_GAME_SWITCH_TEXT), i18n.tr(live.NO_TOKEN_TEXT),
                 i18n.tr(live.STARTING_TEXT), i18n.tr(live.NOT_ON_TEXT), i18n.tr(live.REPLACED_TEXT),
                 i18n.tr(live.AD_WARMING, wait=i18n.span("1–2분")), i18n.tr(live.AD_NOT_STARTED, wait=i18n.span("1–2분")),
                 i18n.tr(streams.REPLACED_TEXT), i18n.tr(streams.CAPACITY_TEXT).format(n=2), i18n.tr(streams.NO_STREAM_TEXT),
                 playable._full_text().format(n=2), i18n.tr(playable.GAME_GONE), i18n.tr(playable.GONE_TEXT),
                 i18n.tr(playable.NO_AD), i18n.tr(playable.NO_TRIAL), i18n.tr(tools.REFUSED),
                 i18n.tr(connections.NO_ANSWER), i18n.tr(agents.CAN_DO)):
        english(said)
    assert i18n.tr(live.BUSY, minutes=30) == "Another user is live. Try again when they are done (at most 30 min)."
    assert i18n.said(live.AD_WARMING_NOTE, "en") == (  # the note as its constant writes it, said as raised
        "The full-screen trailer is being prepared (1–2 min). This round got a corner trailer.")
    assert playable._full_text().format(n=2).startswith("Every trial seat is taken right now (cloud GPUs in use: 2). Press again in ")
    i18n.use("ko")
    assert playable._full_text() == playable.FULL_TEXT and i18n.tr(live.BUSY, minutes=live.MAX_MINUTES) == live.BUSY_TEXT


# ── the watch window: the four simulated viewers and why each got its ad ────────

def test_the_four_simulated_viewers_have_english_profiles():
    i18n.use("en")
    for seeded in viewers.SEED_VIEWERS:
        shown = viewers._shown(seeded)
        assert shown["viewerId"] == seeded["viewerId"] and shown["color"] == seeded["color"]
        for field in ("name", "initials", "bio"):
            english(shown[field])
        english(shown["profile"]["region"])
        assert shown["profile"]["genres"] == seeded["profile"]["genres"]  # ids, not text
    assert viewers._shown(viewers.SEED_VIEWERS[0])["name"] == "Minji Kim"
    i18n.use("ko")
    assert viewers._shown(viewers.SEED_VIEWERS[0]) == {k: viewers.SEED_VIEWERS[0][k] for k in viewers._PUBLIC}


def test_a_viewers_activity_lines_in_english():
    i18n.use("en")
    lines = [viewers.text(e) for e in (
        {"type": "play", "genre": "arpg", "title": "그림자 군주: 보스 러시", "minutes": 45, "win": True},
        {"type": "play", "genre": "racing", "title": "서킷 레전드", "minutes": 20, "win": False},
        {"type": "watch", "minutes": 3, "title": "Moonlit Run"},
        {"type": "playable", "seconds": 90, "title": "Moonlit Run", "genre": "survival"},
        {"type": "corner_engage", "action": "expand", "title": "Moonlit Run", "genre": "shooter"},
        {"type": "corner_engage", "action": "unmute", "title": "Moonlit Run"},
        *({"type": t, "title": "Moonlit Run", "genre": "shooter"} for t in viewers._ACTIVITY))]
    assert lines[:4] == ["Action RPG · played Shadow Lord: Boss Rush for 45 min (won)",
                         "Racing · played Circuit Legends for 20 min (lost)",
                         "Watched the broadcast for 3 min · Moonlit Run", "Playable ad 1 min 30 s · Moonlit Run"]
    assert lines[4] == "Corner ad expanded · Moonlit Run (Sci-fi shooter)"
    assert all(english(line) for line in lines)
    for title, *_ in viewers.CATALOG:  # every seeded title has an English one
        english(i18n.data(title))


def test_ad_reasons_are_written_in_the_language_of_the_break():
    log = [{"type": "play", "genre": "racing", "minutes": 90, "win": True, "at": _at(1)},
           {"type": "play", "genre": "racing", "minutes": 90, "win": False, "at": _at(2)},
           {"type": "ad_click", "genre": "racing", "at": _at(1)}, {"type": "ad_click", "genre": "racing", "at": _at(3)},
           {"type": "purchase", "genre": "racing", "at": _at(2)}, {"type": "wishlist", "genre": "racing", "at": _at(2)},
           {"type": "watch", "genre": "racing", "minutes": 30, "at": _at(2)}]
    i18n.use("en")
    [best] = adserver.rank(_racer(), log, [_c("cr_r", "racing", tags=("drift",))], NOW)
    assert best["reasons"][0] == "Racing for 3 h in the last 7 days (wins: 1)"
    every = [text for _, text in adserver._reasons(_c("cr_r", "racing", tags=("drift",), ips=("Theo",)), [
        *log, {"type": "ad_skip", "genre": "racing", "at": _at(1)}, {"type": "playable_play", "genre": "racing", "at": _at(1)}],
        {"genres": ["racing"]}, {"t:drift": 0.9, "ip:Theo": 0.5}, NOW, True, "playable")]
    assert every == ["Racing for 3 h in the last 7 days (wins: 1)", "Racing ad clicks: 2", "Racing purchases: 1",
                     "Racing wishlists: 1", "Watched Racing broadcasts for 30 min", "Likes the genre Racing",
                     "Likes 'drifting'", "Reacted to the IP 'Theo'", "Racing playable trials: 1", "A game not tried yet",
                     "Racing ad skips: 1 (penalty)"]
    # a count that can be 1 is said "things: n", never "1 times" or "(1 wins)"
    assert not [r for r in every if " 1 " in r and r.endswith(("times", "wins)"))]
    [cold] = adserver.rank(_racer(), [], [_c("cr_a", "arpg")], NOW)
    assert cold["reasons"] == ["An ad not seen before"]
    fallback = adserver.served({"pick": best, "best": {"campaign": {"title": "Neon Drift"}}, "fallback": True})
    assert fallback["reasons"][0] == "Second choice · first choice 'Neon Drift' preparing"
    assert fallback["reason"] == " · ".join(fallback["reasons"]) and english(fallback["reason"])
    for _, label, _ in adserver.TAGS.values():  # every tag a reason can name
        english(i18n.data(label))
    for label in adserver.GENRE_LABEL.values():
        english(i18n.label(label))
    i18n.use("ko")
    [best] = adserver.rank(_racer(), log[:4], [_c("cr_r", "racing")], NOW)
    assert best["reasons"] == ["최근 7일 레이싱 3시간 (1승)", "레이싱 광고 클릭 2회", "처음 보는 광고"]  # the Korean is unchanged


def test_the_personas_and_the_platforms_services_have_english(ctx):  # noqa: F811
    status, body = call("GET", "/api/live/personas")
    assert status == 200 and [p["personaId"] for p in body["personas"]] == ["action", "racer", "explorer"]
    assert all(english(p[k]) for p in body["personas"] for k in ("name", "genre", "profile"))
    assert call("GET", "/api/live/personas", lang="ko")[1]["personas"][0]["name"] == "액션 마니아"
    i18n.use("en")
    for service in connections._platform():
        english(i18n.data(service["name"]))


# ── the agents' pages: the list, the dialog, the scout's notes ─────────────────

def test_the_agents_list_is_english_and_the_account_remembers_the_language(agents_ctx):  # noqa: F811
    c = agents_ctx
    status, body = call("GET", "/api/agents", token=DEMO)
    [scout] = body["agents"]
    assert status == 200 and scout["name"] == "Open-weight model scout" and scout["scheduleLabel"] == "Every day 08:00 KST"
    assert english(scout["instructions"])
    assert agents.account_lang(c, "sub-demo") == "en"
    assert agents.validate_cron(scout["scheduleLabel"]) == scout["cron"]  # the field takes its own label back
    status, body = call("PATCH", f"/api/agents/{scout['agentId']}", {"cron": "whenever"}, token=DEMO)
    assert status == 400 and body["error"] == "bad_schedule" and english(body["message"])
    status, body = call("DELETE", f"/api/agents/{scout['agentId']}", token=DEMO)
    assert status == 409 and body["message"] == "The built-in agent cannot be deleted. Turn it off to stop it."
    status, body = call("POST", "/api/agents", {"description": " "}, token=DEMO)
    assert status == 400 and body["message"] == "Describe the job in a sentence."
    # a Korean page again: the list is Korean and so is what the account keeps
    [scout] = call("GET", "/api/agents", lang="ko", token=DEMO)[1]["agents"]
    assert scout["name"] == agents.SCOUT_NAME and scout["scheduleLabel"] == "매일 08:00 KST"
    assert agents.account_lang(c, "sub-demo") == "ko" and agents.account_lang(c, "sub-nobody") == "ko"


def test_the_sweep_writes_each_trial_in_its_accounts_language_and_leaves_none_behind(agents_ctx, monkeypatch):  # noqa: F811
    """One invocation settles the trials of several accounts: each in its account's language, and what the sweep
    does after them (the baselines, the default scouts) in none of theirs."""
    c = agents_ctx
    for tid, owner in (("tr_1", "sub-en"), ("tr_2", "sub-ko"), ("tr_3", "sub-en")):
        agents._save_trial(c, {"trialId": tid, "sub": owner, "status": "running"})
    monkeypatch.setattr(agents, "account_lang", lambda ctx, owner: "en" if owner == "sub-en" else "ko")
    seen = []
    monkeypatch.setattr(agents, "advance_trial", lambda ctx, t: seen.append((t["trialId"], i18n.lang())))
    monkeypatch.setattr(agents, "ensure_baselines", lambda ctx: seen.append(("baselines", i18n.lang())))
    monkeypatch.setattr(agents, "ensure_default_scouts", lambda ctx: seen.append(("scouts", i18n.lang())))
    app.handler({"action": "agents_sweep"}, None)
    assert seen == [("tr_1", "en"), ("tr_2", "ko"), ("tr_3", "en"), ("baselines", "ko"), ("scouts", "ko")]
    assert i18n.lang() == "ko"


def test_the_dialogs_refusal_of_a_job_an_agent_cannot_do_is_english(agents_ctx):  # noqa: F811
    c = agents_ctx
    c.bedrock_rt_east.spec = {"name": "Session counter", "instructions": "Count sessions", "cron": None,
                              "cannot": "It cannot see the studio's session list."}
    status, body = call("POST", "/api/agents", {"description": "tell me my session count every morning"}, token=DEMO)
    assert status == 422 and body["message"] == (
        "An agent cannot do this right now: It cannot see the studio's session list. An agent can only look up Hugging "
        "Face models, read public web pages, search the web and post to the Inbox. Change the job and write it again.")
    assert "The user reads English" in c.bedrock_rt_east.calls[-1]["system"][0]["text"]  # the draft is asked for in it
    c.bedrock_rt_east.calls.clear()
    call("POST", "/api/agents", {"description": "매일 아침 내 세션 수를 알려줘"}, lang="ko", token=DEMO)
    assert "The user reads English" not in c.bedrock_rt_east.calls[-1]["system"][0]["text"]


def test_the_scout_writes_its_notes_in_the_accounts_language(agents_ctx):  # noqa: F811
    """The scout runs on its schedule, not in a request: its notes are in the language of the account's latest
    request to the agents' pages."""
    c = agents_ctx
    agents.ensure_scout(c, DEMO_USER)
    call("GET", "/api/agents", token=DEMO)  # the account's page is English
    i18n.use("ko")  # the run is no request
    c.bedrock_rt_east.proposals = [{"hfRepo": "acme/Pixel-Image-2", "label": "Pixel Image 2",
                                    "why": "Follows prompts better than Krea", "risks": "Speed unknown", "editCapable": True}]
    out = app.handler({"action": "agents_run", "sub": "sub-demo", "agentId": agents.SCOUT_ID}, None)
    assert out["status"] == "succeeded" and out["summary"].startswith("Proposals: 1. Models checked on Hugging Face: ")
    assert "The user reads English" in c.bedrock_rt_east.calls[-1]["messages"][0]["content"][0]["text"]  # the ranking too
    [note] = call("GET", "/api/agents/inbox", token=DEMO)[1]["notes"]
    assert note["title"] == "Model proposal: Pixel Image 2 (image)" and note["agentName"] == "Open-weight model scout"
    assert english(note["body"]) and "about 28 GB" in note["body"] and "commercial use allowed" in note["body"]
    assert "**Test** installs the model on g6e.2xlarge" in note["body"] and "**Approve**" in note["body"]
    # the same run for an account whose page is Korean (or that never opened the page) is in Korean
    call("GET", "/api/agents", lang="ko", token=DEMO)
    out = app.handler({"action": "agents_run", "sub": "sub-demo", "agentId": agents.SCOUT_ID}, None)
    assert out["summary"].startswith("제안 0건. Hugging Face에서 ")  # (the repo it proposed is no candidate now)
    assert call("GET", "/api/agents/inbox", lang="ko", token=DEMO)[1]["notes"][0]["title"].startswith("조사 완료")


def test_a_trials_note_is_written_in_english_for_an_english_account():
    i18n.use("en")
    written = {}
    original = agents.put_note
    agents.put_note = lambda ctx, sub, agent_, title, body, pid=None: written.update(title=title, body=body, name=agent_["name"])
    try:
        agents._trial_note(None, {"status": "passed", "label": "Pixel Image 2", "hfRepo": "acme/Pixel-Image-2",
                                  "instanceType": "g6e.2xlarge", "kinds": ["t2i", "i2i"], "sub": "sub-demo",
                                  "proposalId": "prop_1", "startedAt": "2026-11-23T00:00:00.000Z",
                                  "finishedAt": "2026-11-23T01:30:00.000Z"})
    finally:
        agents.put_note = original
    assert written["title"] == "GPU test passed: Pixel Image 2" and written["name"] == "Open-weight model scout"
    assert english(written["body"]) and "**Approve**" in written["body"] and "about 1.5 h" in written["body"]


def test_a_highlights_headline_and_footer_are_in_the_language_of_the_sessions_page(monkeypatch):
    """A highlight is cut in a self-invoke: Pegasus is asked for the headline in the language the session's page
    last had, and a Korean page's headline is still rewritten into Korean when it came back in English."""
    from server.tests.conftest import make_ctx
    from server.tests.test_live import FakeBedrock
    monkeypatch.setenv("ACCOUNT_ID", "123")
    c = make_ctx(bedrock_rt_east=FakeBedrock([]))

    def asked():
        live._pegasus(c, "sessions/s/round.mp4", "Moonlit Run")
        return c.bedrock_rt_east.bodies[-1][1]["segment_definitions"][0]["fields"][0]["description"]
    assert "written in Korean (한국어), under 18 characters" in asked()
    i18n.use("en")
    assert "written in English, under 28 characters" in asked() and not HANGUL.search(asked())
    assert i18n.tr("{round}판 명장면", round=3) == "Round 3 highlight"
    assert i18n.tr("IPverse 하이라이트 · {round}판", round=3) == "IPverse highlight · round 3"


# ── the agents' schedule field, in English words (the Korean table: test_round20_agents.py) ──

@pytest.mark.parametrize("phrase, expression", [
    ("every day 09:00", "cron(0 9 * * ? *)"), ("Every day 08:00 KST", "cron(0 8 * * ? *)"), ("daily at 9am", "cron(0 9 * * ? *)"),
    ("daily 9:30 pm", "cron(30 21 * * ? *)"), ("weekdays 9am", "cron(0 9 ? * MON-FRI *)"),
    ("Weekdays 08:00 KST", "cron(0 8 ? * MON-FRI *)"), ("every weekday at 7 p.m.", "cron(0 19 ? * MON-FRI *)"),
    ("weekends 10:30", "cron(30 10 ? * SAT,SUN *)"), ("every Monday 09:00", "cron(0 9 ? * MON *)"),
    ("Every Monday 08:00 KST", "cron(0 8 ? * MON *)"), ("every Mon, Wed and Fri 9am", "cron(0 9 ? * MON,WED,FRI *)"),
    ("Every Mon·Wed 08:00 KST", "cron(0 8 ? * MON,WED *)"), ("Tuesdays at noon", "cron(0 12 ? * TUE *)"),
    ("monthly on day 1 09:00", "cron(0 9 1 * ? *)"), ("every month on the 15th at 6pm", "cron(0 18 15 * ? *)"),
    ("every day at midnight", "cron(0 0 * * ? *)"), ("every day 12am", "cron(0 0 * * ? *)"),
    ("every day 12pm", "cron(0 12 * * ? *)"), ("every 3 hours", "rate(3 hours)"), ("every hour", "rate(1 hour)"),
    ("hourly", "rate(1 hour)"), ("every 90 minutes", "rate(90 minutes)"), ("Every 2 days", "rate(2 days)"),
    ("manual", None), ("Manual", None), ("none", None), ("", None),
    # the Korean forms read the same on an English page
    ("매일 09:00", "cron(0 9 * * ? *)"), ("평일 오전 9시", "cron(0 9 ? * MON-FRI *)"), ("3시간마다", "rate(3 hours)"),
    ("수동 실행", None), ("0 9 * * *", "cron(0 9 * * ? *)"),
])
def test_a_schedule_in_english_words(phrase, expression):
    for lang in ("ko", "en"):  # whichever page wrote it
        i18n.use(lang)
        assert agents.validate_cron(phrase) == expression


@pytest.mark.parametrize("phrase, expression", [
    # a bare hour after "at", and the time before the days
    ("every day at 9", "cron(0 9 * * ? *)"), ("weekdays at 9", "cron(0 9 ? * MON-FRI *)"),
    ("every Monday at 9", "cron(0 9 ? * MON *)"), ("Daily at 18", "cron(0 18 * * ? *)"),
    ("weekends at 0", "cron(0 0 ? * SAT,SUN *)"), ("monthly on the 1st at 7", "cron(0 7 1 * ? *)"),
    ("9am daily", "cron(0 9 * * ? *)"), ("at 9:30 every day", "cron(30 9 * * ? *)"),
    ("9:30 pm on weekdays", "cron(30 21 ? * MON-FRI *)"), ("at 9 every Monday", "cron(0 9 ? * MON *)"),
    ("noon every day", "cron(0 12 * * ? *)"), ("08:00 every Mon and Thu", "cron(0 8 ? * MON,THU *)"),
    ("every morning at 9", "cron(0 9 * * ? *)"), ("every evening at 7", "cron(0 19 * * ? *)"),
    ("every night at 11", "cron(0 23 * * ? *)"), ("every morning at 9am", "cron(0 9 * * ? *)"),
    ("every evening 19:00", "cron(0 19 * * ? *)"), ("every evening at 7:30", "cron(30 19 * * ? *)"),
    ("every night at 12", "cron(0 0 * * ? *)"), ("every night 23:30", "cron(30 23 * * ? *)"),
    ("every morning 06:30", "cron(30 6 * * ? *)"),
])
def test_a_schedule_with_a_bare_hour_after_at_or_the_time_first(phrase, expression):
    for lang in ("ko", "en"):
        i18n.use(lang)
        assert agents.validate_cron(phrase) == expression


@pytest.mark.parametrize("phrase", ["every 5 minutes", "every Monday", "every day 25:00", "every day 13pm", "sometimes",
                                    "monthly on day 40 09:00", "every Funday 9am", "every Monday 9", "every day at 24",
                                    "every morning", "twice a day", "9 daily", "every morning at 13", "every evening at 0", "at 9"])
def test_a_schedule_that_is_none_is_refused_with_the_english_forms(phrase):
    i18n.use("en")
    with pytest.raises(agents.AgentError) as refused:
        agents.validate_cron(phrase)
    assert refused.value.code == "bad_schedule" and not HANGUL.search(refused.value.message)
    assert "‘every day 09:00’" in refused.value.message and "‘manual’" in refused.value.message
    i18n.use("ko")
    with pytest.raises(agents.AgentError) as refused:
        agents.validate_cron(phrase)
    assert "‘매일 09:00’" in refused.value.message  # a Korean page is told the Korean forms


@pytest.mark.parametrize("expression", [
    "cron(0 8 * * ? *)", "cron(30 8 ? * MON-FRI *)", "cron(0 10 ? * SAT,SUN *)", "cron(0 9 ? * MON *)",
    "cron(0 9 ? * MON,WED *)", "cron(0 9 1 * ? *)", "rate(3 hours)", "rate(1 hour)", "rate(2 days)", None,
])
def test_every_schedule_label_is_english_on_an_english_page_and_is_taken_back(expression):
    i18n.use("en")
    label = agents.schedule_label(expression)
    assert not HANGUL.search(label) and agents.validate_cron(label) == expression
    i18n.use("ko")
    assert agents.validate_cron(agents.schedule_label(expression)) == expression
