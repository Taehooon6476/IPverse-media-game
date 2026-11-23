"""Edits of a covered head (a closed helm). klein opens the helm into a face, and the storyboard MCP's start_image
takes no mask, so a covered head's edit goes to a promoted i2i model when there is one, and a klein edit whose check
finds a covered head turned into a face is redrawn on it; the check stays on either way. The tool result says the new
version lands only if it passes, and a rejected edit posts its own chat message."""
import json

import pytest

from server import connections, jobs, prompts, store, tools
from server.providers import mcp_client, mediagen_image as mi
from server.tests.test_klein_edit_check import (_edit, _knight, _run, _snap, box, ctx, session,  # noqa: F401
                                                verdict, vision)

QWEN = "qwen-image-2-1-7b"
CATALOG = {"models": [{"id": "krea", "label": "Krea 2 Turbo", "kinds": ["t2i"]},
                      {"id": "klein9", "label": "FLUX.2 klein 9B", "kinds": ["t2i", "i2i"]},
                      {"id": QWEN, "label": "Qwen-Image 2.1", "kinds": ["t2i", "i2i"], "promoted": True}],
           "live": True}


class PromotedBox:
    """The videogen MCP's image_start / image_get_status for a promoted model, drawn by the same fake box."""

    def __init__(self, box, monkeypatch):
        self.box, self.starts = box, []
        monkeypatch.setattr(mcp_client, "_post", self)

    def __call__(self, url, body, key):
        tool, args = body["params"]["name"], body["params"]["arguments"]
        if tool == "image_start":
            self.starts.append(args)
            out = self.box._start(args)
        elif tool == "image_get_status":
            st = self.box._status(args["job_id"])
            out = {**st, "status": {"RUNNING": "running", "SUCCEEDED": "done", "FAILED": "failed"}[st["status"]]}
        else:
            return self.box(url, body, key)
        return {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": json.dumps(out)}]}}


@pytest.fixture
def qwen(box, monkeypatch):  # noqa: F811
    monkeypatch.setattr(connections, "image_catalog", lambda ctx: CATALOG)
    return PromotedBox(box, monkeypatch)


def _messages(ctx, session):  # noqa: F811
    return [m for m in _snap(ctx, session)["messages"] if m["role"] == "assistant"]


# ── a covered head's edit keeps the head ──

def test_item1_a_covered_heads_edit_goes_to_the_promoted_i2i_model_and_is_still_checked(ctx, session, box, vision, qwen):  # noqa: F811
    vision._responses[:] = [verdict()]
    ip_id = _knight(ctx, session)
    out = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": ip_id, "prompt": "wearing a thick winter cloak"})
    assert out["model"] == QWEN and "Qwen-Image 2.1" in out["message"] and "투구" in out["message"]
    _run(ctx, session, 6)
    snap = _snap(ctx, session)
    job = next(j for j in snap["jobs"] if j["jobId"] == out["jobId"])
    ip = next(i for i in snap["ips"] if i["ipId"] == ip_id)
    assets = {a["assetId"]: a for a in snap["assets"]}
    [sent] = qwen.starts
    assert sent["model"] == QWEN and sent["image_urls"] and "face" not in sent["prompt"].lower()
    assert job["input"]["model"] == QWEN and job["input"]["covered"] is True
    assert len(vision.calls) == 1  # the edit is still checked against its reference
    assert ip["version"] == 2 and assets[ip["imageAssetId"]]["meta"]["model"] == QWEN


def test_item1_the_user_s_own_model_choice_is_kept(ctx, session, box, vision, qwen):  # noqa: F811
    vision._responses[:] = [verdict()]
    ip_id = _knight(ctx, session)
    out = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": ip_id, "prompt": "a red cloak",
                                                           "image_model": "klein9"})
    job = next(j for j in _snap(ctx, session)["jobs"] if j["jobId"] == out["jobId"])
    assert job["input"]["model"] == "klein9" and "model" not in out


def test_item1_without_a_promoted_i2i_model_a_covered_head_stays_on_klein(ctx, session, box, vision):  # noqa: F811
    vision._responses[:] = [verdict()]
    ip_id = _knight(ctx, session)
    job, _, _ = _edit(ctx, session, ip_id)
    assert job["input"]["model"] == "klein9" and "headModel" not in job["input"]


def test_item1_a_klein_edit_whose_check_finds_a_covered_head_turned_face_is_redrawn_on_the_promoted_model(
        ctx, session, box, vision, qwen):  # noqa: F811
    # the name and description do not say the head is covered; the check sees it is
    vision._responses[:] = [verdict(face_appeared=True), verdict()]
    ip_id = _knight(ctx, session, "a knight in dark plate armor", "기사")
    job, ip, assets = _edit(ctx, session, ip_id)
    assert job["input"]["model"] == "klein9" and job["input"]["headModel"] == QWEN
    klein = [s for s in box.starts if s.get("model") == "klein9"]
    redraw = qwen.starts[-1]
    assert redraw["model"] == QWEN and mi.KEEP_HEAD in redraw["prompt"]
    assert len(klein) == 1 and job["redraws"] == 1 and not job.get("error")
    assert ip["version"] == 2 and assets[ip["imageAssetId"]]["meta"]["model"] == QWEN


# ── the rejection is said in chat ──

def test_item2_the_variant_result_never_promises_the_new_version(ctx, session, box, vision):  # noqa: F811
    vision._responses[:] = [verdict()]
    ip_id = _knight(ctx, session)
    out = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": ip_id, "prompt": "a red cloak"})
    assert "수정 검사" in out["message"] and "통과하면" in out["message"]
    assert "검사를 통과하면 vN으로 바뀐다" in prompts.SYSTEM


def test_item2_a_rejected_edit_posts_why_and_what_next_in_chat(ctx, session, box, vision):  # noqa: F811
    vision._responses[:] = [verdict(face_appeared=True), verdict(face_appeared=True, background_changed=True)]
    ip_id = _knight(ctx, session)
    before = len(_messages(ctx, session))
    job, ip, _ = _edit(ctx, session, ip_id)
    assert job["error"].startswith(mi.EDIT_FAILED) and ip["version"] == 1
    [said] = _messages(ctx, session)[before:]
    text = said["text"]
    assert said["status"] == "done"
    assert "붉은 눈의 기사" in text and "v2" in text and "v1" in text
    assert "사람 얼굴" in text and "배경" in text  # why
    assert "다시" in text  # what it offers next
    jobs.advance_jobs(ctx, session["sessionId"])  # later polls never post it again
    assert len(_messages(ctx, session)[before:]) == 1


def test_item2_a_rejected_klein_edit_offers_the_promoted_model_when_it_was_not_used(ctx, session, box, vision, qwen):  # noqa: F811
    vision._responses[:] = [verdict(covered=False, background_changed=True),
                            verdict(covered=False, background_changed=True)]
    ip_id = _knight(ctx, session, "a knight in dark plate armor", "기사")
    before = len(_messages(ctx, session))
    job, _, _ = _edit(ctx, session, ip_id)
    assert job["error"].startswith(mi.EDIT_FAILED)
    [said] = _messages(ctx, session)[before:]
    # the way on is a sentence to say, not a model's name to type; the agent picks the model
    assert "‘다른 모델로 다시 수정해줘’" in said["text"] and "Qwen" not in said["text"]
    assert "버전 기록" in said["text"] and "스카우트" not in said["text"] and "i2i" not in said["text"]


def test_item2_a_passing_edit_posts_nothing(ctx, session, box, vision):  # noqa: F811
    vision._responses[:] = [verdict()]
    ip_id = _knight(ctx, session)
    before = len(_messages(ctx, session))
    _edit(ctx, session, ip_id)
    assert _messages(ctx, session)[before:] == []
    assert store.snapshot(ctx, session["sessionId"])["ips"]
