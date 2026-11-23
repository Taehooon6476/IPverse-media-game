"""What the server says when it refuses or fails is written for the person at the screen: the web shows the `message`
of any answer of 400 or more as a toast, and a failed turn's or a card button's line as a chat bubble. Every such
text is Korean in 해요체, says what happened and what to do, and names no class, field, tool or service."""
import ast
import json
import pathlib
import re

import pytest
from botocore.exceptions import ClientError

from server import agent, ads, app, connections, game_design, jobs, live, playable, store, streams, tools
from server.tests.conftest import FakeBedrockRT, FakeS3, FakeTable, make_ctx
from server.tests.test_agent import _final, _tool_use, _turn
from server.tests.test_app import _new_session, call, ctx  # noqa: F401 (fixtures)
from server.tests.test_live import _session as _live_session, clock, ctx as live_ctx  # noqa: F401 (fixtures)
from server.tests.test_tools import _add_ip

SERVER = pathlib.Path(__file__).resolve().parents[1]
HANGUL = re.compile("[가-힣]")
# a field or tool name as the code writes it: lowerCamelCase, snake_case, or a bare lowercase word with a Korean
# particle right after it ("text는", "kind는", "on은", "genre는", "title이")
FIELD = re.compile(r"[a-z]+(?:[A-Z][a-z]+)+|[a-z]+_[a-z_]+|\b[a-z]{2,}(?=[은는이가을를](?:\s|$))")
RAW = re.compile(r"Error|Exception|Traceback|An error occurred|when calling|[{}<>]")
SERVICE = re.compile(r"IVS|MediaTailor|GameLift|SSAI|IpverseLive|Bedrock|Cognito|Lambda|EventBridge")
AGENT_ONLY = re.compile(r"안내하세요|알리고|부르지 말고|쓰세요|호출하세요|상태\(state\)|이 도구|하도록")


def plain(message: str) -> str:
    """A text a user can read: Korean in 해요체, no field, tool, class or AWS service name, nothing meant for the agent."""
    assert isinstance(message, str) and HANGUL.search(message), message
    for bad in (FIELD, RAW, SERVICE, AGENT_ONLY):
        assert not bad.search(message), (bad.search(message)[0], message)
    assert re.search(r"요[.)!]*$", message), message
    assert "니다" not in message, message
    return message


# ── a turn that fails ──────────────────────────────────────────────────────────

class Throttled:
    def converse(self, **kwargs):
        raise ClientError({"Error": {"Code": "ThrottlingException", "Message": "Too many requests"}}, "Converse")


def test_a_failed_turn_says_what_to_do_and_keeps_the_exception_in_the_log(capsys):
    c = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=Throttled())
    sid = store.put_session(c, "user-1", None, "sf-shooter")["sessionId"]
    store.put_message(c, sid, "user", "루나 만들어줘", "done")
    pending = store.put_message(c, sid, "assistant", "", "pending", ts=store.now(offset_ms=1))

    agent.run_turn(c, sid, pending["messageId"])

    reply = store.snapshot(c, sid)["messages"][-1]
    assert reply["status"] == "failed"
    assert reply["text"] == ("죄송해요, 요청을 처리하지 못했어요. 잠시 뒤 같은 요청을 다시 보내 주세요. "
                             "만들어 둔 그림과 작업은 그대로 있어요.")
    plain(reply["text"])
    assert "ThrottlingException" in capsys.readouterr().err  # the log keeps it


# ── the chat box ───────────────────────────────────────────────────────────────

def test_a_message_too_long_or_empty_is_refused_in_the_users_words(ctx):  # noqa: F811
    sid = _new_session()
    status, body = call("POST", f"/api/sessions/{sid}/chat", {"text": "가" * 4001})
    assert (status, body["error"]) == (400, "bad_request")
    assert body["message"] == "메시지가 너무 길어요. 4,000자 안으로 줄여 다시 보내 주세요."
    status, body = call("POST", f"/api/sessions/{sid}/chat", {"text": "  "})
    assert status == 400 and plain(body["message"]) == "보낼 내용을 적어 주세요."
    assert call("POST", f"/api/sessions/{sid}/chat", {"text": "가" * 4000})[0] == 202  # the limit itself is taken
    assert store.snapshot(ctx, sid)["messages"][0]["text"] == "가" * 4000


def test_the_session_routes_refuse_in_the_users_words(ctx):  # noqa: F811
    sid = _new_session(title="루나")
    said = [call("GET", "/api/sessions/ses_none"), call("PATCH", f"/api/sessions/{sid}", {"title": "  "}),
            call("PATCH", f"/api/sessions/{sid}", {"genre": "chess"}), call("POST", "/api/sessions", {"genre": "chess"}),
            call("POST", f"/api/sessions/{sid}/tools/make_game/async", {}),
            call("POST", f"/api/sessions/{sid}/jobs/job_none/cancel"), call("POST", f"/api/sessions/{sid}/jobs/job_none/retry"),
            call("GET", "/api/nothing-here"), call("POST", f"/api/sessions/{sid}/chat", None)]
    assert [status for status, _ in said] == [404, 400, 400, 400, 400, 400, 400, 404, 400]
    for _, body in said:
        plain(body["message"])
    assert "제목" in said[1][1]["message"] and "장르" in said[2][1]["message"] and "장르" in said[3][1]["message"]
    assert "GET" not in said[7][1]["message"] and "/api" not in said[7][1]["message"]


def test_a_body_that_is_no_json_object_is_refused_in_the_users_words(ctx):  # noqa: F811
    for raw in ("{not json", "[1, 2]"):
        resp = app.handler({"requestContext": {"http": {"method": "POST"}}, "rawPath": "/api/sessions",
                            "headers": {"x-auth-token": "good-token"}, "isBase64Encoded": False, "body": raw}, None)
        assert resp["statusCode"] == 400
        assert "JSON" not in plain(json.loads(resp["body"])["message"])


def test_a_crash_says_what_to_do(ctx, monkeypatch):  # noqa: F811
    def boom(*args, **kwargs):
        raise RuntimeError("AccessDeniedException: secret detail")
    monkeypatch.setattr(store, "list_sessions", boom)
    status, body = call("GET", "/api/sessions")
    assert (status, body["error"]) == (500, "internal")
    assert "secret detail" not in plain(body["message"]) and "다시" in body["message"]


# ── a card's button ────────────────────────────────────────────────────────────

def _hero(c, sid, name="테오"):
    _add_ip(c, sid, "ip_hero", b"HERO")
    store.update_ip(c, sid, "ip_hero", name=name)


def _drawing(c, sid, ip_id="ip_hero"):
    """A new version of the IP's picture is being drawn."""
    job = jobs.create_job(c, sid, "image", "mediagen_image", {"ipId": ip_id}, [])
    store.update_ip(c, sid, ip_id, imageJobId=job["jobId"])
    return job


def _button(c, sid, tool, args):
    """The card button's tool as POST /tools/<tool>/async runs it → its chat line (status, text)."""
    status = store.put_message(c, sid, "assistant", app.ASYNC_TOOLS[tool], "pending")
    app.run_tool_turn(c, sid, tool, args, {"messageId": status["messageId"], "ts": status["ts"]})
    line = next(m for m in store.snapshot(c, sid)["messages"] if m["messageId"] == status["messageId"])
    return line["status"], line["text"]


@pytest.mark.parametrize("tool,line", [
    ("make_action_shot", "액션 샷을 시작하지 못했어요. 잠시 뒤 다시 눌러 주세요."),
    ("reroll_ip_image", "다시 뽑기를 시작하지 못했어요. 잠시 뒤 다시 눌러 주세요."),
    ("make_skill_asset", "장르 스킬 IP 만들기를 시작하지 못했어요. 잠시 뒤 다시 눌러 주세요."),
])
def test_a_card_button_whose_tool_throws_says_so_without_the_exception(ctx, monkeypatch, capsys, tool, line):  # noqa: F811
    sid = _new_session()
    _hero(ctx, sid)

    def boom(*args, **kwargs):
        raise KeyError("imageAssetId")
    monkeypatch.setattr(tools, "run_tool", boom)

    assert _button(ctx, sid, tool, {"ipId": "ip_hero", "action": "runs"}) == ("failed", line)
    assert "KeyError" in capsys.readouterr().err  # the log keeps it


def test_a_card_button_that_is_refused_keeps_the_users_sentence_only(ctx):  # noqa: F811
    sid = _new_session()
    _hero(ctx, sid)
    _drawing(ctx, sid)

    status, line = _button(ctx, sid, "reroll_ip_image", {"ipId": "ip_hero"})
    assert status == "failed"
    assert line == "다시 뽑기를 시작하지 못했어요. 테오의 새 그림을 이미 그리는 중이니 끝난 뒤 다시 눌러 주세요."

    status, line = _button(ctx, sid, "make_action_shot", {"ipId": "ip_hero", "action": "runs forward"})
    assert status == "failed" and line.startswith("액션 샷을 시작하지 못했어요. 테오의 그림을 아직 그리는 중이니(약 ")
    assert line.endswith("분) 그림이 나온 뒤 다시 눌러 주세요.")
    plain(line)

    status, line = _button(ctx, sid, "make_action_shot", {"ipId": "ip_gone", "action": "runs forward"})
    assert status == "failed" and "ip_gone" not in plain(line) and "새로 고친 뒤" in line

    # a draw that ran and failed its check did start: its line is the check's own note, after the button's name
    note = "구도 검사 실패: 왼쪽이 프레임에 잘림(2번 그려도 같음). 새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 씁니다."
    assert tools.button_line("reroll_ip_image", {"error": "check_failed", "message": note, "notice": note}) == "다시 뽑기: " + note


def test_a_refusal_still_tells_the_agent_what_it_told_it(ctx):  # noqa: F811
    """The agent's own copy of a refusal is untouched: the user's sentence rides beside it (notice)."""
    sid = _new_session()
    _hero(ctx, sid)
    _drawing(ctx, sid)
    session = store.get_session(ctx, sid)
    refused = tools.run_tool(ctx, session, "make_video_shot", {"ipId": "ip_hero", "prompt": "orbit"})
    assert refused["error"] == "images_pending" and "이 도구를 다시 부르지 말고" in refused["message"]
    assert plain(refused["notice"]) == tools.user_text(refused)
    gone = tools.run_tool(ctx, session, "render_3d", {"ipId": "ip_gone"})
    assert "ip_gone" in gone["message"] and "ip_gone" not in plain(tools.user_text(gone))
    # a refusal that carries no sentence for the user, and a tool that is none, get the plain one
    for result in (tools.run_tool(ctx, session, "set_concept", {"palette": "red"}), tools.run_tool(ctx, session, "no_tool", {}),
                   tools.run_tool(ctx, session, "render_3d", [])):
        assert "error" in result and plain(tools.user_text(result)) == "요청을 처리하지 못했으니 화면을 새로 고친 뒤 다시 해 주세요."


def test_a_turns_work_log_keeps_what_happened_and_not_the_agents_next_step():
    """작업 기록 is the user's to read too: its line drops the sentence meant for the agent, while the model is still
    handed the whole refusal."""
    model = FakeBedrockRT([_tool_use("make_video_shot", {"ipId": "ip_hero", "prompt": "orbit"}),
                           _final("그림이 나오면 다시 요청해 주세요.")])
    c = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=model)
    sid, pending = _turn(c, "테오 영상 샷 만들어줘")
    _hero(c, sid)
    _drawing(c, sid)

    agent.run_turn(c, sid, pending["messageId"])

    [event] = store.snapshot(c, sid)["messages"][-1]["toolEvents"]
    assert event["summary"].startswith("영상 샷 실패: 테오의 이미지를 아직 그리는 중입니다(대기·진행 중인 이미지 1장, 약 ")
    assert event["summary"].endswith("분).") and not AGENT_ONLY.search(event["summary"])
    told = model.calls[-1]["messages"][-1]["content"][0]["toolResult"]["content"][0]["json"]
    assert "이 도구를 다시 부르지 말고" in told["message"]
    # a dot inside a name ends no sentence
    dotted = tools.summarize("make_video_shot", {}, {"error": "images_pending", "notice": "…", "message": (
        "Dr. Kim의 이미지를 아직 그리는 중입니다(대기·진행 중인 이미지 1장, 약 3분). 이 도구를 다시 부르지 말고 안내하세요.")})
    assert dotted == "영상 샷 실패: Dr. Kim의 이미지를 아직 그리는 중입니다(대기·진행 중인 이미지 1장, 약 3분)."
    # a short reason and a check's note stay whole; a validator's list, which names the spec's fields, becomes one
    # plain sentence (test_round21_copy.py)
    long = "GameSpec 검증 실패: " + "; ".join(f"world.entities[{i}].width must be a number 0.3-20" for i in range(3))
    assert tools.summarize("make_game", {}, {"error": "invalid_spec", "message": long}) == "게임 만들기 실패: 입력값이 맞지 않았어요"
    assert tools.summarize("make_game", {}, {"error": "x", "message": "짧은 이유"}) == "게임 만들기 실패: 짧은 이유"
    note = "구도 검사 실패: 왼쪽이 프레임에 잘림(2번 그려도 같음). 새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 씁니다."
    assert tools.summarize("reroll_ip_image", {}, {"error": "check_failed", "message": note, "notice": note}) == "다시 뽑기 실패: " + note


def test_a_card_buttons_toast_is_the_users_sentence(ctx):  # noqa: F811
    sid = _new_session()
    _hero(ctx, sid)
    store.put_ip(ctx, sid, {"ipId": "ip_crate", "kind": "prop", "name": "상자", "version": 1})
    failed = jobs.create_job(ctx, sid, "image", "mediagen_image", {"ipId": "ip_crate"}, [])
    store.update_job(ctx, sid, failed["jobId"], status="failed")
    store.update_ip(ctx, sid, "ip_crate", imageJobId=failed["jobId"])
    _add_ip(ctx, sid, "ip_box", b"BOX")
    store.update_ip(ctx, sid, "ip_box", name="궤짝", kind="prop")

    def toast(tool, args, code, status=400):
        got, body = call("POST", f"/api/sessions/{sid}/tools/{tool}", args)
        assert (got, body["error"]) == (status, code), body
        return plain(body["message"])

    assert toast("render_3d", {"ipId": "ip_gone"}, "not_found", 404) == "화면이 오래돼 IP를 찾지 못했으니 새로 고친 뒤 다시 해 주세요."
    said = toast("render_3d", {"ipId": "ip_crate"}, "image_failed")
    assert said == "상자의 그림을 만들지 못했으니 ‘작업 현황’에서 그림 작업을 다시 시도해 주세요."
    assert toast("render_3d", {"ipId": "ip_box", "rig_only": True}, "bad_args") == \
        "궤짝에는 움직임 뼈대를 넣지 않아요(캐릭터와 사람형 적에만 넣어요)."
    assert toast("render_3d", {"ipId": "ip_hero", "rig_only": True}, "bad_args") == \
        "테오의 3D 모델이 아직 없으니 ‘3D로 만들기’를 먼저 눌러 주세요."
    assert toast("restore_ip_version", {"ipId": "ip_hero", "imageAssetId": "ast_none"}, "not_found", 404).startswith("화면이 오래돼")
    _drawing(ctx, sid)
    said = toast("make_video_shot", {"ipId": "ip_hero", "prompt": "orbit", "aspect_ratio": "16:9"}, "images_pending")
    assert said.startswith("테오의 그림을 아직 그리는 중이니(약 ") and said.endswith("분) 그림이 나온 뒤 다시 눌러 주세요.")
    # one sentence each: the web's toast keeps a refusal's first sentence (web/src/components/Toasts.tsx toolNotice)
    assert toast("no_such_tool", {}, "unknown_tool", 404).count(". ") == 0 and said.count(". ") == 0


def test_publishing_refuses_in_the_dialogs_words(ctx):  # noqa: F811
    sid = _new_session()
    store.put_game(ctx, sid, {"gameId": "gm_1", "title": "G", "genre": "sf-shooter", "specKey": "k", "previewUrl": "x"})
    video = store.put_asset(ctx, sid, {"kind": "trailer", "key": f"sessions/{sid}/t.mp4", "contentType": "video/mp4"})
    picture = store.put_asset(ctx, sid, {"kind": "image", "key": f"sessions/{sid}/a.jpg", "contentType": "image/jpeg"})

    def toast(**body):
        status, answer = call("POST", f"/api/sessions/{sid}/publish", {"gameId": "gm_1", "adAssetId": video["assetId"], **body})
        assert status in (400, 404), answer
        return plain(answer["message"])

    assert toast(skipAfterSec=99) == "건너뛰기 버튼 표시까지의 시간은 0–30초 사이로 적어 주세요."
    assert toast(adEveryRounds=25) == "광고 다시 틀기는 0–20판 사이로 적어 주세요(0이면 시작할 때만 틀어요)."
    assert "영상" in toast(adAssetId=picture["assetId"])
    assert "게임" in toast(gameId="gm_none")


# ── the game design ────────────────────────────────────────────────────────────

IPS = {"hero": {"ipId": "hero", "kind": "character"}, "foe": {"ipId": "foe", "kind": "enemy"},
       "blade": {"ipId": "blade", "kind": "weapon"}, "crate": {"ipId": "crate", "kind": "prop"},
       "guide": {"ipId": "guide", "kind": "character"}, "sage": {"ipId": "sage", "kind": "character"},
       "forest": {"ipId": "forest", "kind": "prop", "usage": "background"}}
ASK = "제나와 코어로 게임 만들기"
DESIGN = {"prompt": ASK, "castIpIds": ["hero", "foe", "blade", "crate"], "playerIpId": "hero", "weaponIpId": "blade",
          "propIpIds": ["crate"], "enemyIpIds": ["foe"], "npcIpIds": []}


@pytest.mark.parametrize("patch,says", [
    ({"playerIpId": None, "castIpIds": ["foe", "blade", "crate"]}, "주인공을 하나 골라 주세요."),
    ({"castIpIds": ["hero", "foe", "blade", "crate", "guide"]}, "고른 IP마다 역할을 하나씩 정해 주세요."),
    ({"propIpIds": ["crate", "foe"]}, "한 IP에는 역할을 하나만 줄 수 있어요."),
    ({"castIpIds": []}, "역할을 준 IP를 출연 IP로도 골라 주세요."),
    # a prop may be the hero (test_round21_hero_rule.py); a whole scene never
    ({"playerIpId": "forest", "castIpIds": ["forest", "foe", "blade", "crate"]},
     "배경(장면 전체)은 주인공이 될 수 없어요. 다른 IP를 주인공으로 골라 주세요."),
    ({"weaponIpId": "crate", "propIpIds": [], "castIpIds": ["hero", "foe", "crate"]}, "주인공 무기는 무기 IP 중에서 골라 주세요."),
    ({"backgroundIpId": "foe", "enemyIpIds": []}, "배경·환경은 소품 IP 중에서 골라 주세요."),
    ({"setIpIds": ["foe"], "enemyIpIds": []}, "배경 사물은 소품 IP 중에서 골라 주세요."),
    ({"npcIpIds": ["guide", "sage"], "castIpIds": ["hero", "foe", "blade", "crate", "guide", "sage"]}, "NPC·동료는 1명까지 고를 수 있어요."),
    ({"enemyIpIds": ["foe", "ip_gone"]}, "고른 IP 중에 이 세션에 없는 것이 있어요. 게임 설계 창에서 출연 IP를 다시 골라 주세요."),
    ({"playerIpId": "ip_gone"}, "고른 IP 중에 이 세션에 없는 것이 있어요. 게임 설계 창에서 출연 IP를 다시 골라 주세요."),
    ({"enemyIpIds": ["foe", "foe"]}, "같은 IP가 한 역할에 두 번 들어 있어요. 출연 IP를 다시 골라 주세요."),
    ({"prompt": "다른 글"}, "게임 설계와 보낸 메시지가 서로 달라요. 게임 설계 창에서 다시 보내 주세요."),
    ({"prompt": ""}, "게임 아이디어를 4,000자 안으로 적어 주세요."),
])
def test_a_game_design_is_refused_in_korean(patch, says):
    value, errors = game_design.validate_design({**DESIGN, **patch}, IPS, ASK)
    assert value is None and says in errors, errors
    for message in errors:
        plain(message)
    assert len(errors) == len(set(errors))  # one sentence once, however many fields it is true of


def test_a_design_that_is_no_design_and_one_that_is_fine():
    value, errors = game_design.validate_design("제나", IPS, ASK)
    assert value is None and [plain(e) for e in errors]
    value, errors = game_design.validate_design(DESIGN, IPS, ASK)
    assert errors == [] and value["playerIpId"] == "hero"


def test_the_design_drawers_toast_is_those_sentences(ctx):  # noqa: F811
    sid = _new_session()
    _hero(ctx, sid)
    status, body = call("POST", f"/api/sessions/{sid}/chat", {"text": ASK, "gameDesign": {
        "prompt": ASK, "castIpIds": ["ip_hero"], "playerIpId": None, "weaponIpId": None, "propIpIds": [],
        "enemyIpIds": [], "npcIpIds": []}})
    assert (status, body["error"]) == (400, "invalid_game_design")
    assert body["message"] == "주인공을 하나 골라 주세요. 고른 IP마다 역할을 하나씩 정해 주세요."
    assert store.snapshot(ctx, sid)["messages"] == []  # nothing was sent


# ── the live console ───────────────────────────────────────────────────────────

def _refused(fn, *args):
    with pytest.raises(live.LiveError) as refused:
        fn(*args)
    return plain(refused.value.message)


def test_an_ad_interval_out_of_range_is_told_in_the_consoles_words(live_ctx):
    s = _live_session(live_ctx)
    assert _refused(live.start, live_ctx, s, {"gameId": "gm_1", "everyRounds": 25}) == "광고 간격은 1–20판 사이로 적어 주세요."
    live.start(live_ctx, s, {"gameId": "gm_1", "everyRounds": 2})
    assert _refused(live.ad_settings, live_ctx, s, {"everyRounds": 25}) == "광고 간격은 1–20판 사이로 적어 주세요."
    assert _refused(live.ad_settings, live_ctx, s, {"everyRounds": 0}) == "광고 간격은 1–20판 사이로 적어 주세요."


def test_what_the_live_routes_refuse_names_no_field(live_ctx):
    s = _live_session(live_ctx)
    for body in ({"adType": "banner"}, {"mode": "auto"}, {"corner": "yes"}, {"preCueLeadSec": 99}):
        _refused(live.start, live_ctx, s, {"gameId": "gm_1", **body})
    live.start(live_ctx, s, {"gameId": "gm_1", "everyRounds": 2})
    said = _refused(live.ad_settings, live_ctx, s, {"adType": "banner"})
    assert all(name in said for name in ("전체 화면 트레일러", "플레이어블 광고", "코너 트레일러"))
    for fn, body in ((live.ad_settings, {"corner": 1}), (live.round_done, {"rounds": 0}), (live.round_eta, {"round": 0}),
                     (live.round_eta, {"round": 1, "endsInMs": -5}), (live.ad_event, {"kind": "banner", "action": "shown"}),
                     (live.highlight_settings, {"generate": "yes"}), (live.highlight_settings, {"auto": "always"})):
        _refused(fn, live_ctx, s, body)
    assert _refused(live.highlight_send, live_ctx, s, "hl_1", {"kind": "banner"})
    live.highlight_settings(live_ctx, s, {"generate": True})
    for body in ({"round": 0}, {"round": 1, "startedAt": "now", "endedAt": 2, "sentAt": 3}):
        _refused(live.highlight_create, live_ctx, s, body)


def test_a_playable_server_that_cannot_be_reached_is_told_without_the_exception(live_ctx, monkeypatch, capsys):
    s = _live_session(live_ctx)
    live_ctx.gls.fail = 1  # the stream group is busy
    said = _refused(live.standby_set, live_ctx, s, {"on": True})
    assert said == "플레이어블 서버를 켜지 못했어요. 잠시 뒤 다시 눌러 주세요."

    def down(c):
        raise ClientError({"Error": {"Code": "AccessDeniedException", "Message": "not authorized"}}, "GetStreamGroup")
    monkeypatch.setattr(live, "_location", down)
    assert "AccessDenied" not in _refused(live.standby_status, live_ctx, s)
    assert "AccessDenied" in capsys.readouterr().out  # the log keeps it


def test_a_live_stack_that_is_not_there_is_told_without_its_name(live_ctx, monkeypatch):
    monkeypatch.delenv("LIVE_BUCKET")
    with pytest.raises(live.LiveError) as missing:
        live._env("LIVE_BUCKET")
    plain(missing.value.message)
    live_ctx.ivs.list_channels = lambda **kw: {"channels": []}
    with pytest.raises(live.LiveError) as missing:
        live._channel(live_ctx)
    plain(missing.value.message)
    with pytest.raises(live.LiveError) as big:
        live._meta(live_ctx, {"type": "overlay", "title": "가" * 400})
    plain(big.value.message)


# ── the other things a toast can show ──────────────────────────────────────────

def test_an_mcp_server_that_does_not_answer_is_told_without_the_exception(monkeypatch, capsys):
    c = make_ctx(table=FakeTable())
    monkeypatch.setattr(connections, "_safe_url", lambda url: url)

    def refuse(url, headers, budget=0):
        raise RuntimeError("HTTPSConnectionPool(host='mcp.example.com', port=443): Max retries exceeded")
    monkeypatch.setattr(connections, "list_tools", refuse)
    with pytest.raises(connections.ConnError) as failed:
        connections.add(c, {"sub": "sub-1"}, {"name": "My Notes", "url": "https://mcp.example.com/mcp"})
    assert failed.value.code == "connect_failed" and "HTTPSConnectionPool" not in plain(failed.value.message)
    assert failed.value.message == "MCP 서버에 연결하지 못했어요. 주소와 인증 값을 확인한 뒤 다시 해 주세요."
    assert "HTTPSConnectionPool" in capsys.readouterr().out  # the log keeps it

    # the module's own sentence for a refusal it understands is the user's already, and stays
    own = "인증이 필요하거나 거부됐어요 (HTTP 401). 인증 헤더와 값을 확인해 주세요."

    def denied(url, headers, budget=0):
        raise RuntimeError(own)
    monkeypatch.setattr(connections, "list_tools", denied)
    with pytest.raises(connections.ConnError) as failed:
        connections.add(c, {"sub": "sub-1"}, {"name": "My Notes", "url": "https://mcp.example.com/mcp"})
    assert plain(failed.value.message) == "MCP 서버에 연결하지 못했어요. " + own


def test_setup_that_is_missing_is_told_without_a_script_or_a_tool_name(monkeypatch, capsys):
    c = make_ctx(table=FakeTable())
    monkeypatch.setattr(ads, "_cache", {})
    monkeypatch.setattr(ads, "_sm", lambda ctx: None)  # no secret to read
    with pytest.raises(ads.AdsError) as missing:
        ads._private_key(c)
    assert missing.value.code == "playback_key_missing" and "scripts" not in plain(missing.value.message)
    assert "setup_ivs_playback_key.py" in capsys.readouterr().out  # what to run is in the log, for whoever deploys
    session = store.put_session(c, "user-1", None, "sf-shooter")
    with pytest.raises(streams.StreamError) as none:
        streams._unreal_game(c, session["sessionId"])
    assert "Unreal" in plain(none.value.message)
    monkeypatch.delenv("WEB_STREAM_GROUP_ID", raising=False)
    with pytest.raises(streams.StreamError) as off:
        streams._web_group()
    plain(off.value.message)


# ── every refusal the server can raise, as written ─────────────────────────────

RAISED = {"HttpError", "LiveError", "AgentError", "ConnError", "StreamError", "AdsError", "AdError"}
SWEPT = ("app.py", "live.py", "agents.py", "connections.py", "streams.py", "ads.py", "playable.py", "game_design.py")


def _said(node):
    """The message expression as text, what is formatted into it in ⟨⟩; None for a name (checked where it is set)."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(_said(v) or "" for v in node.values)
    if isinstance(node, ast.FormattedValue):
        return "⟨" + ast.unparse(node.value) + "⟩"
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _said(node.left), _said(node.right)
        if left is None and right is None:
            return None
        return (left or "⟨" + ast.unparse(node.left) + "⟩") + (right or "⟨" + ast.unparse(node.right) + "⟩")
    if isinstance(node, ast.IfExp):  # either sentence; a branch that is a name is checked where it is set
        return " / ".join(text for text in (_said(node.body), _said(node.orelse)) if text) or None
    return None


def _raised():
    for name in SWEPT:
        for node in ast.walk(ast.parse((SERVER / name).read_text(encoding="utf-8"))):
            called = getattr(node, "func", None)
            if isinstance(node, ast.Call) and getattr(called, "id", getattr(called, "attr", "")) in RAISED and len(node.args) >= 3:
                text = _said(node.args[2])
                if text:
                    yield f"{name}:{node.lineno}", text


def test_no_refusal_is_english_names_a_field_or_carries_an_exception():
    raised = list(_raised())
    assert len(raised) > 100  # the sweep reads what it means to
    bad = []
    for where, text in raised:
        words = re.sub(r"⟨[^⟩]*⟩", "", text)
        formatted = re.findall(r"⟨([^⟩]*)⟩", text)
        if (not HANGUL.search(words) or FIELD.search(words) or SERVICE.search(words) or RAW.search(words)
                or any(re.search(r"\b(?:e|err|exc|error)\b|__name__", f) for f in formatted)):
            bad.append((where, text))
    assert bad == []


def test_every_refusal_is_said_in_haeyo_style():
    """해요체, like the screens they are shown on: no 합니다체, and a sentence that ends."""
    bad = []
    for where, text in _raised():
        for said in re.sub(r"⟨[^⟩]*⟩", "", text).split(" / "):  # (either sentence of a conditional)
            if "니다" in said or not re.search(r"요[.)!]*\s*$", said):
                bad.append((where, said))
    assert bad == []


def test_the_refusals_that_are_named_texts_read_the_same_way():
    """The sweep reads the sentences written where they are raised; these are set once and raised by name."""
    for said in (app.BAD_REQUEST, live.BUSY_TEXT, live.OTHER_SESSION_TEXT, live.SWITCH_BUSY_TEXT, live.NO_TOKEN_TEXT,
                 live.STARTING_TEXT, live.AD_WARMING_NOTE, live.AD_NOT_STARTED_NOTE, streams.REPLACED_TEXT,
                 streams.CAPACITY_TEXT.format(n=2), playable.FULL_TEXT.format(n=2), playable.GAME_GONE,
                 playable.GONE_TEXT, tools.REFUSED):
        plain(said)


# ── texts raised by name or outside the sweep ──────────────────────────────────

def test_a_trial_length_out_of_range_names_the_consoles_own_word(live_ctx):
    """The console's select is 체험 길이: the refusal uses that word, not the field's name."""
    s = _live_session(live_ctx)
    asked = "체험 길이는 30–180초 사이에서 골라 주세요."
    assert _refused(live.start, live_ctx, s, {"gameId": "gm_1", "adType": "playable", "playableSeconds": 400}) == asked
    live.start(live_ctx, s, {"gameId": "gm_1", "everyRounds": 2})
    assert _refused(live.ad_settings, live_ctx, s, {"adType": "playable", "playableSeconds": 5}) == asked
    with pytest.raises(playable.AdError) as refused:
        playable.create(live_ctx, s, {"gameId": "gm_1", "seconds": "90"})
    assert plain(refused.value.message) == asked
    with pytest.raises(playable.AdError) as refused:
        playable.create(live_ctx, s, {"gameId": "gm_none"})
    assert "gameId" not in plain(refused.value.message) and "게임" in refused.value.message


def test_a_highlight_that_is_not_ready_to_air_names_no_service(live_ctx, clock):
    s = _live_session(live_ctx)
    live.start(live_ctx, s, {"gameId": "gm_1", "everyRounds": 2})
    job = live._get_json(live_ctx, live.JOB_KEY)
    hl = {"id": "hl_1", "round": 1, "state": "ready", "title": "명장면", "clipSeconds": 5.0, "createdAt": "2026-11-16T00:00:00.000Z",
          "wideUrl": "https://cdn/wide.mp4", "shortUrl": "https://cdn/short.mp4"}
    live._put(live_ctx, live._hl_key(job["jobId"], "hl_1"), json.dumps(hl), "application/json")
    said = _refused(live.highlight_send, live_ctx, s, "hl_1", {"kind": "linear"})
    assert "뒤에 보내 주세요" in said and "준비" in said


def test_the_last_three_of_the_live_routes_and_the_beacon_name_no_field(live_ctx):
    s = _live_session(live_ctx)
    assert "플레이어블 서버" in _refused(live.standby_set, live_ctx, s, {"on": "yes"})
    live.start(live_ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "corner"})
    live.round_done(live_ctx, s, {"rounds": 1})
    shown = live.status(live_ctx, s)["stream"]["breaks"][-1]
    _refused(live.ad_event, live_ctx, s, {"viewerId": "v-minji", "eventId": shown["eventId"], "kind": "corner",
                                          "action": "impression", "seconds": "12"})
    with pytest.raises(ads.AdsError) as refused:
        ads.impression(live_ctx, {"b": "!!", "c": "x", "p": "v-minji"})
    plain(refused.value.message)


def test_an_ad_address_that_is_no_ad_is_told_in_the_same_words(ctx):  # noqa: F811
    status, body = call("GET", "/api/ads/not-an-ad", token=None)
    assert status == 404 and body["error"] == "not_found" and "광고" in plain(body["message"])


def test_a_cloud_stream_that_fails_is_told_without_the_services_word(ctx):  # noqa: F811
    source = (SERVER / "app.py").read_text(encoding="utf-8")
    busy = re.findall(r'_client_error\(e, "([^"]+)"\)', source)  # what each of its two callers says of a full house
    assert len(busy) == 2 and "클라우드 플레이" in busy[0] and "체험" in busy[1]
    for full in busy:
        for code, status in (("ValidationException", 400), ("ResourceNotFoundException", 404),
                             ("ServiceQuotaExceededException", 503), ("InternalServerException", 502)):
            err = app._client_error(ClientError({"Error": {"Code": code, "Message": "x"}}, "StartStreamSession"), full)
            assert err.status == status and plain(err.message)


def test_the_design_check_holds_no_english_sentence():
    source = (SERVER / "game_design.py").read_text(encoding="utf-8")
    body = source[source.index("def validate_design"):source.index("def for_turn")]
    said = [node.value for node in ast.walk(ast.parse(body)) if isinstance(node, ast.Constant)
            and isinstance(node.value, str) and " " in node.value]
    assert said and all(HANGUL.search(text) and not FIELD.search(text) for text in said), said
