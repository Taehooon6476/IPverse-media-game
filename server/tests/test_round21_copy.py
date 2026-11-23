"""The server's own text in three places: a picture's versions are told in 해요체 and by the button's name (이 버전
쓰기; the endings are mirrored by web/src/types.ts jobNote), 작업 기록 keeps no argument or field name of a call the
agent got wrong, and a picture being drawn does not name its model."""
import pathlib
import re

import pytest

from server import agent, prompts, store, tools
from server.providers import mediagen_image as mi, mediagen_video as mv
from server.tests.conftest import FakeBedrockRT, FakeS3, FakeTable, make_ctx
from server.tests.fake_gpu import Clock, FakeImageBox
from server.tests.test_agent import _final, _tool_use, _turn
from server.tests.test_round20_errors import AGENT_ONLY, FIELD, plain
from server.tests.test_tools import _add_ip, _session

WEB_TYPES = (pathlib.Path(__file__).resolve().parents[2] / "web" / "src" / "types.ts").read_text(encoding="utf-8")
LATIN_WORD = re.compile("[A-Za-z]{2,}")


@pytest.fixture
def ctx():
    return make_ctx(table=FakeTable(), s3=FakeS3())


@pytest.fixture
def session(ctx):
    return _session(ctx)


# A picture's versions, in 해요체 and by the button's name

KEPT = "새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 써요."
USED = "이 그림(v2)을 ‘이 버전 쓰기’로 지금 그림으로 쓰고 있어요."
MOVED = "새 그림(v2)은 버전 기록에만 있고 지금 그림은 다른 버전(v4)이에요."


def test_a_check_note_ends_in_the_screens_speech_level():
    note = mi.check_note({"problem": "왼쪽이 프레임에 잘림"}, 2, 2, 1)
    assert note == f"구도 검사 실패: 왼쪽이 프레임에 잘림(2번 그려도 같음). {KEPT}"
    assert "니다" not in note
    first = mi.check_note({"problem": "위쪽이 프레임에 잘림"}, 2)
    assert first.endswith("첫 그림이라 그대로 두었으니 다시 뽑아 주세요.") and "니다" not in first


def test_a_check_note_says_which_picture_is_in_use_by_the_buttons_name():
    note = f"{mi.EDIT_FAILED}: 배경이 바뀜(2번 그려도 같음). {KEPT}"
    lead = note[:-len(KEPT)]
    assert mi.note_now(note, 1) == note  # the IP still uses the picture it kept
    assert mi.note_now(note, 2, drew_current=True) == lead + USED  # 이 버전 쓰기 on the version the check kept out
    assert mi.note_now(note, 4) == lead + MOVED  # a later draw landed
    for said in (USED, MOVED, KEPT):
        assert "니다" not in said and "되돌리기" not in said and re.search(r"요\.$", said)


def test_a_note_written_before_this_round_is_read_in_todays_words():
    """A stored note keeps its old 합니다체 sentence; what is read off it says the ending as it is said now."""
    old = f"{mi.EDIT_FAILED}: 배경이 바뀜(2번 그려도 같음). 새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 씁니다."
    lead = old[:old.index("새 그림")]
    assert mi.note_now(old, 1) == lead + KEPT
    assert mi.note_now(old, 2, drew_current=True) == lead + USED
    assert mi.note_now(old, 4) == lead + MOVED
    assert mi.note_now("GPU server busy", 3) == "GPU server busy" and mi.note_now("", 1) == ""  # any other line: as it is


def test_the_job_card_reads_and_says_the_same_sentences():
    """web/src/types.ts jobNote mirrors note_now: the same pattern for a note's ending, written either way, and the
    same two sentences for a note that has moved on."""
    todo = "web/src/types.ts (jobNote, KEPT) is to carry round 21's check-note sentences: "
    assert mi._KEPT.pattern.replace("\\", "") in WEB_TYPES.replace("\\", ""), todo + f"KEPT = /{mi._KEPT.pattern}/"
    assert "을 ‘이 버전 쓰기’로 지금 그림으로 쓰고 있어요." in WEB_TYPES, todo + mi.USED_END
    assert "은 버전 기록에만 있고 지금 그림은 다른 버전(v" in WEB_TYPES and ")이에요." in WEB_TYPES, todo + mi.MOVED_END


def _versions(ctx, sid, ip_id="ip_hero"):
    """바론 with a v2 that failed its edit check kept as a version only. → (v1's image, v2's image)."""
    _add_ip(ctx, sid, ip_id, b"HERO")
    store.update_ip(ctx, sid, ip_id, name="바론")
    v1 = next(a for a in store.snapshot(ctx, sid)["assets"] if a["kind"] == "image")
    v2 = store.put_asset(ctx, sid, {"kind": "image", "key": f"sessions/{sid}/v2.png", "contentType": "image/png",
                                    "ipId": ip_id, "meta": {"version": 2, "check": {
                                        "ok": False, "problem": "배경이 바뀜", "edit": {"ok": False}}}})
    store.put_asset(ctx, sid, {"kind": "cutout", "key": f"sessions/{sid}/v2-cut.png", "contentType": "image/png",
                               "ipId": ip_id, "meta": {"forAssetId": v2["assetId"]}})
    return v1, v2


def test_taking_a_version_says_so_by_the_buttons_name(ctx, session):
    sid = session["sessionId"]
    v1, v2 = _versions(ctx, sid)
    assert tools._LABELS["restore_ip_version"] == "이 버전 쓰기"

    def said():  # (as a set: two lines written in one millisecond have no order of their own)
        return {m["text"] for m in store.snapshot(ctx, sid)["messages"]}

    tools.run_tool(ctx, session, "restore_ip_version", {"ipId": "ip_hero", "imageAssetId": v2["assetId"]})
    failed_one = "이 버전 쓰기: 바론 v2. 이제 이 버전이 지금 그림이에요(수정 검사 실패: 배경이 바뀜)."
    assert said() == {failed_one}

    tools.run_tool(ctx, session, "restore_ip_version", {"ipId": "ip_hero", "imageAssetId": v1["assetId"]})
    assert said() == {failed_one, "이 버전 쓰기: 바론 v1. 이제 이 버전이 지금 그림이에요."}
    assert not any("니다" in line or "되돌리기" in line for line in said())


def test_a_version_that_cannot_be_taken_says_so_in_the_users_words(ctx, session):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    bare = store.put_asset(ctx, sid, {"kind": "image", "key": f"sessions/{sid}/bare.png", "contentType": "image/png",
                                      "ipId": "ip_hero", "meta": {"version": 2}, "createdAt": "2099-01-01T00:00:00.000Z"})
    out = tools.run_tool(ctx, session, "restore_ip_version", {"ipId": "ip_hero", "imageAssetId": bare["assetId"]})
    assert out["error"] == "bad_args"
    assert plain(tools.user_text(out)) == "이 버전은 배경을 지운 그림이 없어 지금 그림으로 쓸 수 없어요."


def test_the_prompt_names_the_button_and_the_endings_it_may_read():
    screen = next(line for line in prompts.SYSTEM.splitlines() if "버전 표시(vN" in line)
    assert "'이 버전 쓰기'" in screen and "되돌리기" not in screen
    [version] = [line for line in prompts.SYSTEM.splitlines() if line.startswith("- state.ips[].version은")]
    assert "'이 버전 쓰기'를 누르면" in version and "되돌리기" not in version
    [check] = [line for line in prompts.SYSTEM.splitlines() if "구도 검사 실패" in line]
    for ending in ('"새 그림(vN)은 버전 기록에만 두고 지금 그림(vM)을 그대로 써요"',
                   '"새 그림(vN)은 버전 기록에만 있고 지금 그림은 다른 버전(vK)이에요"',
                   '"이 그림(vN)을 ‘이 버전 쓰기’로 지금 그림으로 쓰고 있어요"'):
        assert ending in check, ending
    assert "되돌리기" not in check and "씁니다" not in check and "입니다\"" not in check
    assert "되돌리기" not in prompts.SYSTEM.replace("되돌려 달라면", "")  # the button has one name


# 작업 기록 keeps no argument or field name

ARGS = "입력값이 맞지 않았어요"


@pytest.mark.parametrize("tool,label,result", [
    ("create_ip_asset", "캐릭터 만들기", {"error": "bad_args", "message": "humanoid는 true(사람형 적) 또는 false(드론·짐승 같은 비사람형)여야 합니다"}),
    ("set_concept", "컨셉 정하기", {"error": "bad_args", "message": "palette는 #rrggbb 색 3개여야 합니다"}),
    ("publish_game", "게시하기", {"error": "bad_args", "message": "skip_after_sec는 0–30 사이 정수여야 합니다"}),
    ("make_game", "게임 만들기", {"error": "invalid_spec", "message": "GameSpec 검증 실패: " + "; ".join(
        f"world.entities[{i}].width must be a number 0.3-20" for i in range(3))}),
    ("make_game", "게임 만들기", {"error": "cast_mismatch", "message": "출연 IP 규칙 위반: player.ipId는 출연 IP 중 하나여야 합니다 (지금: 없음)"}),
    ("make_game", "게임 만들기", {"error": "cast_role_mismatch", "message": "player.ipId must match the user's selected playerIpId"}),
])
def test_a_call_wrong_in_its_own_arguments_says_so_in_one_plain_sentence(tool, label, result):
    line = tools.summarize(tool, {}, result)
    assert line == f"{label} 실패: {ARGS}"
    assert not FIELD.search(line) and not LATIN_WORD.search(line) and not AGENT_ONLY.search(line)


def test_the_work_log_of_a_turn_keeps_the_plain_sentence_and_the_log_keeps_the_refusal(capsys):
    model = FakeBedrockRT([_tool_use("set_concept", {"title": "달빛 숲", "logline": "모험", "style": "storybook",
                                                     "palette": "보라", "genre": "rpg-quest"}),
                           _final("컨셉을 다시 정할게요.")])
    c = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=model)
    sid, pending = _turn(c, "달빛 숲 컨셉 잡아줘")

    agent.run_turn(c, sid, pending["messageId"])

    [event] = store.snapshot(c, sid)["messages"][-1]["toolEvents"]
    assert event["summary"] == f"컨셉 정하기 실패: {ARGS}"
    # the model is still handed the whole refusal, and the log keeps what 작업 기록 no longer does
    told = model.calls[-1]["messages"][-1]["content"][0]["toolResult"]["content"][0]["json"]
    assert told["message"] == "palette는 #rrggbb 색 3개여야 합니다"
    assert "tool refused: set_concept bad_args: palette는 #rrggbb 색 3개여야 합니다" in capsys.readouterr().out


def test_a_refusal_about_the_session_keeps_what_happened_without_ids_or_the_agents_next_step():
    """Every other refusal keeps its first sentence (what happened) and loses an id in brackets, as a reply does
    (agent.BRACKETED)."""
    needs = ("주인공 꼬마 마법사(ip_98e2ca089d)의 3D가 아직 끝나지 않아 게임을 만들 수 없습니다. 3D가 없는 주인공은 납작한 그림 판으로 "
             "나오므로 그런 게임은 만들지 않습니다. 꼬마 마법사(ip_98e2ca089d): 3D 제작 중(3D 모델 단계, 약 14분). 3D가 진행 중이면 "
             "이 도구를 다시 부르지 말고 사용자에게 단계와 예상 시간을 알리세요. 이 게임 요청은 보류해 두었습니다.")
    line = tools.summarize("make_game", {}, {"error": "needs_3d", "message": needs})
    assert line == "게임 만들기 실패: 주인공 꼬마 마법사의 3D가 아직 끝나지 않아 게임을 만들 수 없습니다."
    assert not AGENT_ONLY.search(line) and "ip_" not in line
    assert tools.summarize("make_game", {}, {"error": "x", "message": "짧은 이유"}) == "게임 만들기 실패: 짧은 이유"
    # a check's note is the user's as a whole
    note = f"구도 검사 실패: 왼쪽이 프레임에 잘림(2번 그려도 같음). {KEPT}"
    assert tools.summarize("reroll_ip_image", {}, {"error": "check_failed", "message": note, "notice": note}) == "다시 뽑기 실패: " + note


# A picture being drawn says so, and its model stays on the job

def test_a_picture_being_drawn_says_so_without_the_models_name(ctx, monkeypatch):
    p = mi.MediagenImageProvider()
    monkeypatch.setattr(p, "_status", lambda job, ctx: {"status": "RUNNING"})
    for inp in ({"model": "krea", "modelLabel": "Krea 2 Turbo"}, {"model": "klein9"},
                {"model": "qwen-image-2-1-7b", "modelLabel": "Qwen-Image-2.1 (7B)"}):
        job = {"jobId": "job_1", "pk": "SESSION#s", "externalId": "j1", "input": {**inp, "prompt": "p"}}
        assert p.status(job, ctx) == ("running", "그림 그리는 중 (GPU 대기 포함)")
    # a promoted model's stopped box coming up: the wait, not the model
    monkeypatch.setattr(p, "_status", lambda job, ctx: {"status": "RUNNING", "booting": True})
    job = {"jobId": "job_1", "pk": "SESSION#s", "externalId": "j1",
           "input": {"model": "qwen-image-2-1-7b", "modelLabel": "Qwen-Image-2.1 (7B)", "prompt": "p", "etaMinutes": 12}}
    assert p.status(job, ctx) == ("running", "정지된 GPU 서버 켜는 중 · 보통 ~12분")


def test_the_model_stays_on_the_job_for_the_card_to_name(ctx, session, monkeypatch):
    """What draws is the job's own record (input.model, and its name as modelLabel), where the card's tooltip and the
    version's details read it (web/src/types.ts imageModelLabel), also when the catalog gives no name."""
    FakeImageBox(Clock(), gen_sec=0, swap_sec=0).install(monkeypatch)
    made = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "prop", "name": "등불", "description": "a lantern"})
    inp = store.get_job(ctx, session["sessionId"], made["jobId"])["input"]
    assert (inp["model"], inp["modelLabel"]) == ("krea", "Krea 2 Turbo")
    monkeypatch.setattr(tools, "_model_label", lambda c, model: "")  # the image catalog did not answer
    again = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "prop", "name": "밧줄", "description": "a rope"})
    inp = store.get_job(ctx, session["sessionId"], again["jobId"])["input"]
    assert (inp["model"], inp["modelLabel"]) == ("krea", "Krea 2 Turbo")


def test_a_restyles_first_frames_being_drawn_say_so_without_the_models_name():
    source = pathlib.Path(mv.__file__).read_text(encoding="utf-8")
    assert '"화풍 기준 프레임 그리는 중 ({len(urls)}/{len(drawn)})"' in source
    assert "그리는 중 ({len(urls)}/{len(drawn)}, FLUX" not in source


def test_no_running_line_of_an_image_job_names_a_model():
    source = pathlib.Path(mi.__file__).read_text(encoding="utf-8")
    running = re.findall(r'return \("running", f?"([^"]*)"', source)
    assert len(running) == 2 and not any("label" in line for line in running)
