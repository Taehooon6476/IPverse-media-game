"""A klein 9B edit changes only what was asked. A covered head (a closed helm, a visor) is kept as "the same helmet /
head covering": the keep clause never says face, since naming one invites one. An edit's composition redraw names the
background and style to keep. Every landed klein edit is shown with its reference to Haiku (one Bedrock vision call
per draw): a face that appeared, a background or style that changed, or anything beyond the change fails it; it is
redrawn once with a stronger keep clause, and a second failure is kept as a version only, the job saying
"수정 검사 실패: ...".
"""
import json

import pytest

from server import agent, jobs, prompts, store, tools
from server.providers import bedrock_image, mediagen_image as mi
from server.tests.conftest import FakeBedrockRT, FakeS3, FakeTable, make_ctx
from server.tests.fake_gpu import Clock, FakeImageBox
from server.tests.test_mediagen_image import CUT

PNG = b"\x89PNG\r\n\x1a\n"
KNIGHT = ("dark fantasy knight, full body, fully enclosed great helm with no face visible, glowing red eyes shining "
          "through the narrow eye slit, battered blackened steel plate armor")
ASTRO = ("Astro, a sleek silver robot knight in polished metallic armor, full body, A-pose, glowing visor eyes, "
         "wearing a flowing purple cape")


def verdict(**bad):
    """A Converse reply with the JSON verdict; everything passes unless named."""
    body = {"reference_head_covered": bad.pop("covered", True), "face_appeared": False, "background_changed": False,
            "style_changed": False, "other_changes": "", **bad}
    return {"output": {"message": {"role": "assistant", "content": [{"text": json.dumps(body)}]}},
            "stopReason": "end_turn"}


@pytest.fixture
def box(monkeypatch):
    b = FakeImageBox(Clock(), gen_sec=0, swap_sec=0, png=lambda job: PNG + job["id"].encode()).install(monkeypatch)
    monkeypatch.setattr(mi, "remove_background", lambda ctx, image: CUT)
    return b


@pytest.fixture
def vision():
    return FakeBedrockRT([])


@pytest.fixture
def ctx(box, vision):
    return make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_quick=vision)


@pytest.fixture
def session(ctx):
    s = store.put_session(ctx, "user-1", "기사", "rpg")
    store.update_session(ctx, s, concept={"title": "t", "logline": "", "palette": [],
                                          "style": "dark fantasy concept art, painterly, moody lighting"})
    return s


def _run(ctx, session, passes=4):
    for _ in range(passes):
        jobs.advance_jobs(ctx, session["sessionId"])


def _snap(ctx, session):
    return store.snapshot(ctx, session["sessionId"])


def _knight(ctx, session, description=KNIGHT, name="붉은 눈의 기사"):
    made = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "character", "name": name,
                                                            "description": description})
    _run(ctx, session)
    return made["ipId"]


def _edit(ctx, session, ip_id, change="wearing a thick winter cloak over the armor"):
    out = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": ip_id, "prompt": change})
    _run(ctx, session, 6)
    snap = _snap(ctx, session)
    job = next(j for j in snap["jobs"] if j["jobId"] == out["jobId"])
    ip = next(i for i in snap["ips"] if i["ipId"] == ip_id)
    return job, ip, {a["assetId"]: a for a in snap["assets"]}


# ── 1. the prompt never names a face for a covered head ────────────────────────


@pytest.mark.parametrize("name,description", [("붉은 눈의 기사", KNIGHT), ("아스트로", ASTRO),
                                              ("가면 도적", "a thief in a black porcelain mask"),
                                              ("로봇 경비", "a security guard unit"), ("투구 병사", "a soldier")])
def test_a_covered_head_is_kept_as_the_same_helmet_and_never_named_a_face(name, description):
    ip = {"kind": "character", "name": name, "description": description}
    assert tools._covered(ip)
    prompt = tools.edit_prompt(name, "wearing a thick winter cloak", "figure", "painterly", covered=True)
    assert "face" not in prompt.lower()
    assert "the same helmet or head covering" in prompt and "closed" in prompt
    # the background kept is the reference's own, not a "plain background" (test_round20_edit.py)
    for kept in ("armor", "colors", "lighting", "pose", "framing", "reference image's own background",
                 "art style (painterly)"):
        assert kept in prompt, kept


def test_an_uncovered_head_still_keeps_its_face():
    assert not tools._covered({"kind": "character", "name": "Luna", "description": "a cat astronaut girl"})
    assert "the same head and face as shown" in tools.edit_prompt("Luna", "a red scarf")


def test_m1_the_variant_job_sent_to_the_box_has_no_face_and_is_marked_for_the_check(ctx, session, box, vision):
    vision._responses[:] = [verdict()]
    ip_id = _knight(ctx, session)
    job, _, _ = _edit(ctx, session, ip_id)
    sent = box.starts[-1]
    assert sent["model"] == "klein9" and "face" not in sent["prompt"].lower()
    assert sent["prompt"].startswith("wearing a thick winter cloak over the armor. Change only that")
    assert job["input"]["edit"] == "wearing a thick winter cloak over the armor" and job["input"]["covered"] is True


# ── 2. the vision check ────────────────────────────────────────────────────────


def test_a_passing_edit_lands_as_the_current_picture_after_one_vision_call(ctx, session, box, vision):
    vision._responses[:] = [verdict()]
    ip_id = _knight(ctx, session)
    reference = ctx.s3._store[("test-assets", mi.image_key(session["sessionId"], _snap(ctx, session)["jobs"][0]["jobId"]))]
    job, ip, assets = _edit(ctx, session, ip_id)
    assert len(vision.calls) == 1 and len(box.starts) == 2  # the krea first draw is not an edit: not checked
    call = vision.calls[0]
    assert (call["method"], call["modelId"]) == ("converse", bedrock_image.GRIP_MODEL_ID)
    assert call["additionalModelRequestFields"] == {"thinking": {"type": "disabled"}}
    first, second, question = call["messages"][0]["content"]
    assert first["image"]["source"]["bytes"] == reference  # the reference first, then the edit
    assert second["image"]["source"]["bytes"] == PNG + b"g2"
    text = question["text"]
    assert "wearing a thick winter cloak over the armor" in text and "JSON" in text
    for asked in ("face_appeared", "background_changed", "style_changed", "other_changes"):
        assert asked in text
    image = assets[ip["imageAssetId"]]
    assert ip["version"] == 2 and job["status"] == "done" and not job.get("error")
    assert image["meta"]["check"]["ok"] is True and image["meta"]["check"]["edit"]["ok"] is True
    assert image["meta"]["edit"] == "wearing a thick winter cloak over the armor"


def test_a_face_that_appeared_is_redrawn_once_with_a_stronger_keep_clause_and_then_passes(ctx, session, box, vision):
    vision._responses[:] = [verdict(face_appeared=True), verdict()]
    ip_id = _knight(ctx, session, ASTRO, "아스트로")
    job, ip, assets = _edit(ctx, session, ip_id, "the cape is crimson red instead of purple")
    assert len(vision.calls) == 2 and len(box.starts) == 3  # one vision call per landed draw
    first, redraw = box.starts[1], box.starts[2]
    assert redraw["seed"] != first["seed"] and redraw["reference_image_urls"] == first["reference_image_urls"]
    assert redraw["prompt"].startswith(first["prompt"].rstrip(" .") + ". ")  # the edit and its keep clause stay
    extra = redraw["prompt"][len(first["prompt"]):]
    assert mi.KEEP_HEAD in extra and mi.KEEP_HARDER in extra and "face" not in redraw["prompt"].lower()
    assert mi.REFRAME_EDIT["figure"] not in extra  # the composition passed: the camera stays
    assert job["redraws"] == 1 and not job.get("error") and ip["version"] == 2
    assert assets[ip["imageAssetId"]]["meta"]["check"]["ok"] is True


def test_a_second_failure_keeps_the_draw_as_a_version_and_says_so_in_korean(ctx, session, box, vision):
    vision._responses[:] = [verdict(face_appeared=True), verdict(face_appeared=True, background_changed=True,
                                                                  other_changes="망토 무늬가 바뀜")]
    ip_id = _knight(ctx, session)
    before = next(i for i in _snap(ctx, session)["ips"] if i["ipId"] == ip_id)
    job, ip, assets = _edit(ctx, session, ip_id)
    assert len(vision.calls) == 2 and len(box.starts) == 3
    assert ip["imageAssetId"] == before["imageAssetId"] and ip["version"] == 1  # the IP keeps its picture
    error = job["error"]
    assert error.startswith(f"{mi.EDIT_FAILED}: ") and "사람 얼굴" in error and "배경" in error and "망토 무늬가 바뀜" in error
    assert "2번 그려도 같음" in error and "새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 써요" in error
    [v2] = [a for a in assets.values() if a.get("kind") == "image" and a["meta"].get("version") == 2]
    check = v2["meta"]["check"]
    assert check["ok"] is False and check["edit"]["faceAppeared"] is True and check["edit"]["backgroundChanged"] is True
    assert check["redraws"] == 1 and "사람 얼굴" in check["problem"]
    assert agent._check(job, assets) == "failed"
    snap_jobs = {j["jobId"]: j for j in _snap(ctx, session)["jobs"]}
    # restored later: still flagged, the line as it holds then
    restored = tools._check_note({"imageAssetId": v2["assetId"], "version": 2}, snap_jobs)
    assert restored == error[:error.index("새 그림")] + "이 그림(v2)을 ‘이 버전 쓰기’로 지금 그림으로 쓰고 있어요."


def test_a_vision_call_that_fails_lets_the_edit_land_unchecked(ctx, session, box, vision):
    vision._responses[:] = [{"output": {"message": {"content": [{"text": "I cannot compare these."}]}}}]
    ip_id = _knight(ctx, session)
    job, ip, assets = _edit(ctx, session, ip_id)
    assert len(vision.calls) == 1 and ip["version"] == 2 and not job.get("error")
    assert assets[ip["imageAssetId"]]["meta"]["check"]["edit"] == {"checked": False}


def test_a_reroll_of_an_edit_is_checked_again(ctx, session, box, vision):
    vision._responses[:] = [verdict(), verdict()]
    ip_id = _knight(ctx, session)
    _edit(ctx, session, ip_id)
    out = tools.run_tool(ctx, session, "reroll_ip_image", {"ipId": ip_id})
    _run(ctx, session, 6)
    job = next(j for j in _snap(ctx, session)["jobs"] if j["jobId"] == out["jobId"])
    assert job["input"]["edit"] and job["input"]["covered"] is True and len(vision.calls) == 2


# ── the composition redraw of an edit keeps the reference, background and style ─


def test_m1_retry_a_composition_redraw_of_an_edit_names_the_background_and_style():
    p = mi.MediagenImageProvider()
    calls = []
    edit = tools.edit_prompt("붉은 눈의 기사", "wearing a thick winter cloak", covered=True)
    job = {"jobId": "job_1", "pk": "SESSION#ses_1", "redraws": 1, "redrawFor": ["composition"],
           "input": {"model": "klein9", "prompt": edit, "references": ["sessions/ses_1/v1.png"], "subject": "figure",
                     "edit": "wearing a thick winter cloak", "covered": True}}
    from server.providers import mcp_client
    real_call, real_url = mcp_client.call_tool, mcp_client.public_input_url
    try:
        mcp_client.call_tool = lambda ctx, server, tool, args: calls.append(args) or {"job_id": "g1"}
        mcp_client.public_input_url = lambda ctx, key: f"https://cdn/{key}"
        p.submit(job, None)
    finally:
        mcp_client.call_tool, mcp_client.public_input_url = real_call, real_url
    [sent] = calls
    assert sent["reference_image_urls"] == ["https://cdn/sessions/ses_1/v1.png"]  # the reference stays
    assert sent["prompt"].startswith(edit.rstrip(" .") + ". ")  # and the keep clause
    assert mi.REFRAME_EDIT["figure"] in sent["prompt"]
    assert "same background as in the reference image" in mi.REFRAME_EDIT["figure"]
    assert mi.KEEP_HARDER in sent["prompt"] and "nothing added to it" in mi.KEEP_HARDER and "signature" in mi.KEEP_HARDER


# ── the vision question itself ─────────────────────────────────────────────────


def test_edit_check_reads_fenced_json_and_says_what_failed_in_korean():
    fenced = {"output": {"message": {"content": [{"text": "```json\n" + json.dumps(
        {"reference_head_covered": True, "face_appeared": True, "background_changed": False, "style_changed": True,
         "other_changes": ""}) + "\n```"}]}}}
    ctx = make_ctx(bedrock_rt_quick=FakeBedrockRT([fenced]))
    out = bedrock_image.edit_check(ctx, PNG + b"a", PNG + b"b", "a red cape")
    assert out["ok"] is False and out["headCovered"] is True and out["faceAppeared"] is True
    assert out["styleChanged"] is True and "사람 얼굴" in out["problem"] and "화풍" in out["problem"]
    assert bedrock_image.edit_check(make_ctx(), PNG, PNG, "x") is None  # no quick client: not asked
    assert bedrock_image.edit_check(ctx, b"GIF89a", PNG, "x") is None


def test_the_agent_rules_name_the_edit_check():
    s = prompts.SYSTEM
    assert "수정 검사 실패" in s and "사람 얼굴" in s
