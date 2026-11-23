"""Image edits and their copy, on a closed-helm knight whose brown cloak is asked navy on a promoted model.

#25: a redrawn picture's small differences (other_minor) do not fail the edit check.
#24: after a rejected edit is taken with 이 버전 쓰기, the job's note, the state and the chat say which picture the
     IP uses now, and a shot carries the look it was drawn with.
#26: a promoted model's cold box has one ETA, kept on the job too.
#27: progress lines and messages never show a model's id.
#30: replies say the studio's words for state values (genre ids, check_failed).
"""
import json
import pathlib

from server import agent, gamespec, jobs, prompts, store, tools, waits
from server.providers import bedrock_image, mediagen_image as mi
from server.tests.conftest import FakeBedrockRT, FakeS3, FakeTable, make_ctx
from server.tests.test_klein_edit_check import PNG, _run, _snap, box, ctx, session, verdict, vision  # noqa: F401
from server.tests.test_round12_klein import QWEN, qwen  # noqa: F401

BARON = ("A humanoid wandering knight wearing a full-coverage steel great helm that completely hides the entire head "
         "and face, only a narrow dark visor slit, no skin visible, worn steel plate armor over chainmail, a long brown "
         "traveler's cloak draped over the shoulders, leather belt and boots")
NAVY = BARON.replace("brown", "navy blue")
CHANGE = "a navy blue cloak instead of brown"
SLIGHT = "망토 색상 외에 장갑 및 부츠 모양이 약간 달라짐"  # a real verdict's remark, every typed flag false
QWEN_LABEL = "Qwen-Image 2.1"
WEB_TYPES = (pathlib.Path(__file__).resolve().parents[2] / "web" / "src" / "types.ts").read_text(encoding="utf-8")


def _reply(**answer):
    return {"output": {"message": {"content": [{"text": json.dumps(
        {"reference_head_covered": True, "face_appeared": False, "background_changed": False, "style_changed": False,
         "other_changes": "", **answer}, ensure_ascii=False)}]}}}


def _check(**answer):
    return bedrock_image.edit_check(make_ctx(bedrock_rt_quick=FakeBedrockRT([_reply(**answer)])), PNG + b"a", PNG + b"b",
                                    CHANGE)


def _baron(ctx, session):  # noqa: F811
    made = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "character", "name": "바론", "description": BARON})
    _run(ctx, session)
    return made["ipId"]


def _navy(ctx, session, ip_id):  # noqa: F811
    """The navy edit as the agent registers it. → (the edit job, the IP, the assets by id)."""
    out = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": ip_id, "prompt": CHANGE, "description": NAVY})
    _run(ctx, session, 6)
    snap = _snap(ctx, session)
    return (next(j for j in snap["jobs"] if j["jobId"] == out["jobId"]),
            next(i for i in snap["ips"] if i["ipId"] == ip_id), {a["assetId"]: a for a in snap["assets"]})


def _version(assets, n):
    [image] = [a for a in assets.values() if a.get("kind") == "image" and a["meta"].get("version") == n]
    return image


def _state(ctx, session):  # noqa: F811
    return json.loads(agent.state_summary(_snap(ctx, session)))


def _rejected_v2(ctx, session, vision):  # noqa: F811
    """바론 with the navy edit rejected on both draws. → (ipId, the edit job, the assets by id)."""
    vision._responses[:] = [verdict(other_changes=SLIGHT), verdict(other_changes=SLIGHT)]  # answers without other_minor
    ip_id = _baron(ctx, session)
    job, ip, assets = _navy(ctx, session, ip_id)
    assert ip["version"] == 1 and "새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 써요." in job["error"]
    return ip_id, job, assets


def test_25_a_slight_redraw_difference_alone_does_not_fail_the_edit_check():
    out = _check(other_changes=SLIGHT, other_minor=True)
    assert out["ok"] is True and out["problem"] == ""
    assert out["other"] == SLIGHT and out["otherMinor"] is True  # the remark stays on the record


def test_25_a_real_change_beyond_the_request_still_fails_it():
    armor = "갑옷 디자인과 체형이 다른 인물로 바뀜"
    out = _check(other_changes=armor, other_minor=False)
    assert out["ok"] is False and out["problem"] == f"요청 밖 변경: {armor}"
    assert _check(other_changes=armor)["ok"] is False  # an answer that does not say how small it is
    assert _check(other_changes=armor, other_minor="false")["ok"] is False
    face = _check(face_appeared=True, other_changes=SLIGHT, other_minor=True)  # a small remark excuses no typed flag
    assert face["ok"] is False and "사람 얼굴" in face["problem"] and SLIGHT not in face["problem"]
    assert _check(other_changes="", other_minor=False)["ok"] is True


def test_25_the_question_says_an_edit_redraws_the_whole_picture_and_what_a_real_change_is():
    asked = bedrock_image.EDIT_QUESTION.format(change=CHANGE)
    assert CHANGE in asked and "other_changes" in asked and "other_minor" in asked
    for said in ("draws the whole picture again", "pixel size", "shape", "texture"):  # what a redraw brings anyway
        assert said in asked, said
    for real in ("different character", "pose", "added", "removed"):  # what is never small
        assert real in asked, real


def test_25_the_clean_colour_only_edit_lands_as_v2(ctx, session, box, vision, qwen):  # noqa: F811
    vision._responses[:] = [verdict(other_changes=SLIGHT, other_minor=True)]
    ip_id = _baron(ctx, session)
    job, ip, assets = _navy(ctx, session, ip_id)
    assert job["input"]["model"] == QWEN and len(vision.calls) == 1  # one draw, one check
    # room for the whole answer: other_minor is its last key, and an answer cut before it lands the edit unchecked
    assert vision.calls[0]["inferenceConfig"]["maxTokens"] >= 400
    assert ip["version"] == 2 and not job.get("error") and not job.get("redraws")
    edit = assets[ip["imageAssetId"]]["meta"]["check"]["edit"]
    assert edit["ok"] is True and edit["other"] == SLIGHT


def test_24_restoring_the_rejected_edit_leaves_nothing_that_says_the_ip_keeps_v1(ctx, session, box, vision, qwen):  # noqa: F811
    ip_id, job, assets = _rejected_v2(ctx, session, vision)
    v1, v2 = _version(assets, 1), _version(assets, 2)

    out = tools.run_tool(ctx, session, "restore_ip_version", {"ipId": ip_id, "imageAssetId": v2["assetId"]})

    assert out == {"ipId": ip_id, "version": 2}
    state = _state(ctx, session)
    hero = next(i for i in state["ips"] if i["ipId"] == ip_id)
    assert (hero["version"], hero["image"], hero["description"]) == (2, "check_failed", NAVY)
    note = next(j for j in state["jobs"] if j["jobId"] == job["jobId"])["error"]
    assert note.startswith(f"{mi.EDIT_FAILED}: 요청 밖 변경: {SLIGHT}(2번 그려도 같음). ")
    assert "지금 그림(v1)" not in json.dumps(state, ensure_ascii=False)
    assert note.endswith("이 그림(v2)을 ‘이 버전 쓰기’로 지금 그림으로 쓰고 있어요.")
    said = _snap(ctx, session)["messages"][-1]
    assert (said["role"], said["status"]) == ("assistant", "done")
    assert said["text"].startswith("이 버전 쓰기: 바론 v2. 이제 이 버전이 지금 그림이에요")
    assert f"{mi.EDIT_FAILED}: 요청 밖 변경: {SLIGHT}" in said["text"]  # the picture now used is the one that failed

    tools.run_tool(ctx, session, "restore_ip_version", {"ipId": ip_id, "imageAssetId": v1["assetId"]})

    state = _state(ctx, session)
    hero = next(i for i in state["ips"] if i["ipId"] == ip_id)
    assert hero["version"] == 1 and "image" not in hero and hero["description"] == BARON
    assert next(j for j in state["jobs"] if j["jobId"] == job["jobId"])["error"] == job["error"]  # as it was written
    assert _snap(ctx, session)["messages"][-1]["text"] == "이 버전 쓰기: 바론 v1. 이제 이 버전이 지금 그림이에요."


def test_24_a_check_note_says_which_picture_the_ip_uses_now():
    kept = "새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 써요."
    note = f"{mi.EDIT_FAILED}: 요청 밖 변경: {SLIGHT}(2번 그려도 같음). {kept}"
    lead = note[:-len(kept)]
    assert mi.note_now(note, 1) == note  # the IP still uses the picture it kept
    assert mi.note_now(note, 2, drew_current=True) == lead + "이 그림(v2)을 ‘이 버전 쓰기’로 지금 그림으로 쓰고 있어요."
    assert mi.note_now(note, 4) == lead + "새 그림(v2)은 버전 기록에만 있고 지금 그림은 다른 버전(v4)이에요."  # a later draw landed
    first = mi.check_note({"problem": "위쪽이 프레임에 잘림"}, 2)
    assert mi.note_now(first, 1, drew_current=True) == first  # a kept first picture's note names no other version
    assert mi.note_now("GPU server busy", 3) == "GPU server busy" and mi.note_now("", 1) == ""
    # the job card says the same sentences (web/src/types.ts jobNote): locked by test_round21_copy.py
    # test_the_job_card_reads_and_says_the_same_sentences
    assert "jobNote" in WEB_TYPES


def test_24_the_3d_warning_of_a_restored_picture_does_not_say_v1_is_kept(ctx, session, box, vision, qwen):  # noqa: F811
    ip_id, _, assets = _rejected_v2(ctx, session, vision)
    tools.run_tool(ctx, session, "restore_ip_version", {"ipId": ip_id, "imageAssetId": _version(assets, 2)["assetId"]})
    snap = _snap(ctx, session)
    ip = next(i for i in snap["ips"] if i["ipId"] == ip_id)
    note = tools._check_note(ip, {j["jobId"]: j for j in snap["jobs"]})
    assert note.startswith(mi.EDIT_FAILED) and "지금 그림(v1)" not in note and "이 그림(v2)" in note


def test_28_the_3d_warning_of_a_restored_edit_failed_picture_names_the_edit_check(ctx, session, box, vision, qwen):  # noqa: F811
    """A picture that failed the edit check has one subject and nothing cut: its 3D warning must not speak of the
    composition check or of a cut shape."""
    ip_id, _, assets = _rejected_v2(ctx, session, vision)
    tools.run_tool(ctx, session, "restore_ip_version", {"ipId": ip_id, "imageAssetId": _version(assets, 2)["assetId"]})
    out = tools.run_tool(ctx, session, "render_3d", {"ipId": ip_id})
    assert "jobId" in out and out["warning"].startswith(f"{mi.EDIT_FAILED}: 요청 밖 변경: {SLIGHT}")
    assert "잘린" not in out["warning"] and "다시 뽑기를 권하세요" in out["warning"]  # what the agent tells the user
    assert out["notice"] == tools.NOTICE_EDIT_FAILED_3D  # what the card shows
    assert "수정 검사" in out["notice"] and "구도" not in out["notice"] and "다시 뽑" in out["notice"]
    assert len(out["notice"]) <= 60 and out["notice"].count(".") == 1
    assert "구도 검사" in tools.NOTICE_CHECK_FAILED_3D  # a cut picture's notice keeps its own check
    [rule] = [line for line in prompts.SYSTEM.splitlines() if "구도 검사 실패" in line]
    assert "check_failed인 그림으로 만든 3D·게임 무기도 잘린 모양 그대로 나온다" not in rule  # not every such picture is cut
    assert "구도 검사에 실패한 그림이면 잘린 모양 그대로" in rule


def test_24_the_rules_read_the_current_picture_off_the_ip_never_off_an_old_sentence():
    [version] = [line for line in prompts.SYSTEM.splitlines() if line.startswith("- state.ips[].version은")]
    assert "'이 버전 쓰기'" in version and "description" in version  # taking a version moves both
    assert "그때의 것" in version  # a job note or an older chat line says what held when it was written
    [check] = [line for line in prompts.SYSTEM.splitlines() if "구도 검사 실패" in line]
    assert "현재 그림은 vM이다" not in check
    assert "‘이 버전 쓰기’로 지금 그림으로 쓰고 있어요" in check and "지금 그림은 다른 버전(vK)이에요" in check  # the endings it may read
    [edit] = [line for line in prompts.SYSTEM.splitlines() if line.startswith("- make_ip_variant(과 그 수정의 다시 뽑기)")]
    assert "지금 그림 vM을 그대로 쓴다" not in edit


def test_24_a_shot_carries_the_look_it_was_drawn_with(ctx, session, box, vision, qwen):  # noqa: F811
    ip_id, _, assets = _rejected_v2(ctx, session, vision)
    tools.run_tool(ctx, session, "restore_ip_version", {"ipId": ip_id, "imageAssetId": _version(assets, 2)["assetId"]})
    shot = tools.run_tool(ctx, session, "make_action_shot", {"ipId": ip_id, "action": "running across a wasteland"})
    sid = session["sessionId"]
    upscale = jobs.create_job(ctx, sid, "shot", "mediagen_video", {
        "edit": "v2v", "task": "upscale", "model": "ltx", "prompt": "p", "sourceShotJobId": shot["jobId"]}, [shot["jobId"]])
    plain = tools.run_tool(ctx, session, "make_video_shot", {"ipId": ip_id, "prompt": "slow orbit"})
    scene = tools.run_tool(ctx, session, "make_video_shot", {"prompt": "a wasteland at dusk"})  # no IP: no look

    def looks():
        by_id = {j["jobId"]: j for j in _state(ctx, session)["jobs"]}
        return [by_id[j].get("look") for j in (shot["jobId"], upscale["jobId"], plain["jobId"], scene["jobId"])]

    assert looks() == [NAVY, NAVY, NAVY, None]
    tools.run_tool(ctx, session, "restore_ip_version", {"ipId": ip_id, "imageAssetId": _version(assets, 1)["assetId"]})
    assert looks() == [NAVY, NAVY, NAVY, None]  # the shots still show the navy cloak they were drawn with
    [rule] = [line for line in prompts.SYSTEM.splitlines() if line.startswith("- edit_video_shot:")]
    assert "look" in rule  # the edit's prompt names what the shot shows


def test_26_a_promoted_models_job_keeps_the_eta_the_chat_gives(ctx, session, box, vision, qwen):  # noqa: F811
    vision._responses[:] = [verdict(), verdict()]
    eta = waits.PROMOTED_BOOT_MIN + 1
    ip_id = _baron(ctx, session)
    sid = session["sessionId"]
    out = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": ip_id, "prompt": CHANGE})
    assert store.get_job(ctx, sid, out["jobId"])["input"]["model"] == QWEN
    assert store.get_job(ctx, sid, out["jobId"])["input"].get("etaMinutes") == out["etaMinutes"] == eta
    _run(ctx, session, 6)
    again = tools.run_tool(ctx, session, "reroll_ip_image", {"ipId": ip_id})  # the same edit again, on the same box
    assert store.get_job(ctx, sid, again["jobId"])["input"].get("etaMinutes") == again["etaMinutes"] == eta
    for name in ("등불", "밧줄"):  # two more draws behind it on the same box
        new = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "prop", "name": name, "description": "a prop",
                                                               "image_model": QWEN})
    assert new["queuedImages"] == 3 and new["etaMinutes"] == waits.promoted_image_eta(3, tools.IMAGE_SEC) == eta + 1
    assert store.get_job(ctx, sid, new["jobId"])["input"].get("etaMinutes") == new["etaMinutes"]
    krea = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "prop", "name": "방패", "description": "a shield"})
    assert "etaMinutes" not in store.get_job(ctx, sid, krea["jobId"])["input"]  # the shared box: its card's usual time


def test_26_the_booting_line_states_that_one_eta(ctx, monkeypatch):  # noqa: F811
    p = mi.MediagenImageProvider()
    monkeypatch.setattr(p, "_status", lambda job, ctx: {"status": "RUNNING", "booting": True})
    job = {"jobId": "job_1", "pk": "SESSION#s", "externalId": "j1",
           "input": {"model": QWEN, "modelLabel": QWEN_LABEL, "prompt": "p", "etaMinutes": 12}}
    assert p.status(job, ctx) == ("running", "정지된 GPU 서버 켜는 중 · 보통 ~12분")
    del job["input"]["etaMinutes"]  # queued before the job kept it, or a klein edit's head redraw on the cold box
    line = p.status(job, ctx)[1]
    assert line.endswith(f"· 보통 ~{waits.PROMOTED_BOOT_MIN + 1}분") and "(~10분)" not in line
    assert waits.promoted_image_eta() == waits.promoted_image_eta(1, tools.IMAGE_SEC)


def test_27_a_promoted_models_progress_lines_never_show_its_id(ctx, monkeypatch):  # noqa: F811
    """A running line names no model at all: the label stays on the job (input.modelLabel, headLabel), where the
    card's tooltip reads it."""
    p = mi.MediagenImageProvider()
    job = {"jobId": "job_1", "pk": "SESSION#s", "externalId": "j1",
           "input": {"model": QWEN, "modelLabel": "Qwen-Image-2.1 (7B)", "prompt": "p", "etaMinutes": 11}}
    monkeypatch.setattr(p, "_status", lambda job, ctx: {"status": "RUNNING", "booting": True})
    assert p.status(job, ctx)[1] == "정지된 GPU 서버 켜는 중 · 보통 ~11분"
    monkeypatch.setattr(p, "_status", lambda job, ctx: {"status": "RUNNING"})
    assert p.status(job, ctx) == ("running", "그림 그리는 중 (GPU 대기 포함)")
    klein = {"jobId": "job_2", "pk": "SESSION#s", "externalId": "j2", "input": {
        "model": "klein9", "modelLabel": "FLUX.2 klein 9B", "headModel": QWEN, "headLabel": QWEN_LABEL, "prompt": "p"}}
    for job in (klein, {**klein, "redraws": 1, "redrawFor": ["edit", "head"]},
                {"jobId": "job_3", "pk": "SESSION#s", "externalId": "j3", "input": {"model": QWEN, "prompt": "p"}}):
        assert p.status(job, ctx)[1] == "그림 그리는 중 (GPU 대기 포함)" and QWEN not in p.status(job, ctx)[1]


def test_27_the_queue_message_names_the_label_whichever_tool_queued_the_draw(ctx, session, box, qwen):  # noqa: F811
    new = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "prop", "name": "등불", "description": "a lantern",
                                                           "image_model": QWEN})
    assert f"{QWEN_LABEL}의 GPU 서버" in new["message"] and QWEN not in new["message"]
    _run(ctx, session)
    again = tools.run_tool(ctx, session, "reroll_ip_image", {"ipId": new["ipId"]})
    assert f"{QWEN_LABEL}의 GPU 서버" in again["message"] and QWEN not in again["message"]


def test_30_the_reply_says_the_studios_words_for_state_values():
    assert agent._strip_marker("장르는 기본값인 sf-shooter를 그대로 썼고") == "장르는 기본값인 SF 슈터를 그대로 썼고"
    assert agent._strip_marker("이미지 상태가 check_failed로 표시됩니다.") == "이미지 상태가 검사 실패로 표시됩니다."
    assert agent.humanize_tools("`rpg-explore`이 아니라 sf-survival은") == "RPG 탐험이 아니라 SF 서바이벌은"
    assert agent.humanize_tools("rpg-quest와 render_3d가") == "RPG 퀘스트와 3D로 만들기가"
    assert set(gamespec.GENRES) == set(gamespec.GENRE_LABELS) <= set(agent.STATE_LABELS)  # a new genre gets its word
    for genre, label in gamespec.GENRE_LABELS.items():  # the words the studio's own screens use
        assert f"{{ value: '{genre}', label: '{label}' }}" in WEB_TYPES, genre


def test_30_the_copula_after_a_word_is_no_subject_particle():
    """An id in "sf-shooter이고" must not become "SF 슈터가고": 이 before Hangul is a copula, not a particle."""
    for said in ("장르는 sf-shooter이고 화풍은 stylized 3D animation입니다.",
                 "장르는 sf-shooter이고, 팔레트는 #4f8cff, #0b1033, #c9d3e6입니다.",
                 "장르는 기본값인 sf-shooter이고, 강조색은 붉은색, 나머지는 어두운 남색과 아이보리입니다."):
        assert agent._strip_marker(said) == said.replace("sf-shooter", "SF 슈터"), said
    assert agent._strip_marker("이미지 상태가 check_failed이면 다시 뽑아 주세요.") == "이미지 상태가 검사 실패이면 다시 뽑아 주세요."
    for ending in ("이며", "이라서", "이라고", "이지만", "이므로", "이나", "입니다", "인데"):  # 이 + Hangul: a copula
        assert agent.humanize_tools(f"rpg-quest{ending}") == f"RPG 퀘스트{ending}", ending
        assert agent.humanize_tools(f"`render_3d`{ending}") == f"3D로 만들기{ending}", ending  # a tool's name too
    # the subject particle, which a space, a mark or the end follows, is still fixed
    assert agent.humanize_tools("sf-shooter이 기본이고 check_failed이, rpg-explore가") == "SF 슈터가 기본이고 검사 실패가, RPG 탐험이"
    assert agent.humanize_tools("기본값은 sf-shooter이") == "기본값은 SF 슈터가"
    # 이에요 | 예요 goes by the word's last sound like a particle (the id reads as a vowel, RPG 탐험 ends in ㅁ)
    assert agent.humanize_tools("장르는 rpg-explore예요. sf-shooter이에요.") == "장르는 RPG 탐험이에요. SF 슈터예요."


def test_30_a_word_said_both_ways_is_said_once():
    """The state holds both genre and genreLabel: "SF 슈터(sf-shooter)" would read "SF 슈터(SF 슈터)"."""
    assert agent.humanize_tools("장르는 SF 슈터(sf-shooter)이고 상태는 검사 실패(`check_failed`)입니다.") == \
        "장르는 SF 슈터이고 상태는 검사 실패입니다."
    assert agent.humanize_tools("rpg-explore(RPG 탐험)를 고르면 RPG 탐험 (rpg-explore)로") == "RPG 탐험을 고르면 RPG 탐험으로"
    assert agent.humanize_tools("3D로 만들기(render_3d)가") == "3D로 만들기가"
    assert agent.humanize_tools("SF 슈터(기본 장르)와 RPG 탐험(SF 슈터)") == "SF 슈터(기본 장르)와 RPG 탐험(SF 슈터)"  # no pair


def test_30_the_agent_is_given_the_words(ctx):  # noqa: F811
    for genre, label in gamespec.GENRE_LABELS.items():
        made = store.put_session(ctx, "user-1", None, genre)
        assert _state(ctx, made)["session"]["genreLabel"] == label and _state(ctx, made)["session"]["genre"] == genre
    [rule] = [line for line in prompts.SYSTEM.splitlines() if "도구 이름 대신" in line]
    assert "genreLabel" in rule and "check_failed" in rule and "검사 실패" in rule


def test_30_a_turns_stored_reply_has_neither_word():
    said = "장르는 기본값인 sf-shooter를 그대로 썼고, 이미지 상태가 check_failed로 표시됩니다. 장르는 sf-shooter이고 화풍은 3D입니다."
    east = FakeBedrockRT([{"stopReason": "end_turn", "output": {"message": {"role": "assistant",
                                                                             "content": [{"text": said}]}}}])
    ctx = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=east)  # noqa: F811
    sid = store.put_session(ctx, "user-1", None, "sf-shooter")["sessionId"]
    store.put_message(ctx, sid, "user", "주인공 하나 만들어줘", "done")
    pending = store.put_message(ctx, sid, "assistant", "", "pending", ts=store.now(offset_ms=1))
    agent.run_turn(ctx, sid, pending["messageId"])
    text = store.snapshot(ctx, sid)["messages"][-1]["text"]
    assert text == "장르는 기본값인 SF 슈터를 그대로 썼고, 이미지 상태가 검사 실패로 표시됩니다. 장르는 SF 슈터이고 화풍은 3D입니다."
    assert '"genreLabel": "SF 슈터"' in east.calls[0]["system"][0]["text"]


def test_30_a_turn_cut_at_the_round_limit_is_read_the_same_way(monkeypatch):
    monkeypatch.setattr(agent, "MAX_ROUNDS", 1)
    use = {"stopReason": "tool_use", "output": {"message": {"role": "assistant", "content": [
        {"text": "장르는 sf-shooter로 두고 render_3d를 겁니다."},
        {"toolUse": {"toolUseId": "tu_1", "name": "get_game_spec", "input": {"gameId": "gm_none"}}}]}}}
    ctx = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=FakeBedrockRT([use]))  # noqa: F811
    sid = store.put_session(ctx, "user-1", None, "sf-shooter")["sessionId"]
    store.put_message(ctx, sid, "user", "게임 설정 보여줘", "done")
    pending = store.put_message(ctx, sid, "assistant", "", "pending", ts=store.now(offset_ms=1))
    agent.run_turn(ctx, sid, pending["messageId"])
    text = store.snapshot(ctx, sid)["messages"][-1]["text"]
    assert text == f"장르는 SF 슈터로 두고 3D로 만들기를 겁니다.\n\n{agent.LIMIT_NOTE}"
