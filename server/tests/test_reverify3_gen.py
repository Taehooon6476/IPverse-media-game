"""A rejected reroll in the chat, on a fake image GPU box and a fake clock (no network): the queued reroll's chat line
claims no version, and the agent reads each version's own check and which picture the IP keeps.
"""
import json

from server import agent, app, prompts, store, tools
from server.tests.conftest import FakeS3, FakeTable, make_ctx
from server.tests.test_cutout import W, png_rgba, sword
from server.tests.test_image_jobs import ScriptedModel, _concept, _create, _ip, _poll, _snap, world  # noqa: F401

RIGHT = png_rgba([(20, 70, W, 90, 255)])  # v1: the blade runs off the right edge
BOTH = png_rgba([(0, 70, W, 90, 255)])  # v2: a tighter close-up, cut at both sides


def _rejected_reroll(w):
    """A katana whose first picture is cut at the right in both draws (kept, as a first picture), then a reroll run
    the way POST /tools/reroll_ip_image/async runs it, both draws cut at both sides.
    → (the IP, the reroll's chat message)."""
    _concept(w)
    w["cutouts"].update({b"\x89PNG-g1": RIGHT, b"\x89PNG-g2": RIGHT, b"\x89PNG-g3": BOTH, b"\x89PNG-g4": BOTH})
    store.put_message(w["ctx"], w["sid"], "user", "빛나는 플라즈마 카타나를 만들어줘", "done")
    store.put_message(w["ctx"], w["sid"], "assistant", "무기 이미지 작업을 등록했습니다.", "done", ts=store.now(offset_ms=1))
    made = _create(w, "플라즈마 카타나", kind="weapon")
    _poll(w)
    status = store.put_message(w["ctx"], w["sid"], "assistant", app.ASYNC_TOOLS["reroll_ip_image"], "pending")
    app.run_tool_turn(w["ctx"], w["sid"], "reroll_ip_image", {"ipId": made["ipId"]},
                      {"messageId": status["messageId"], "ts": status["ts"]})
    return made, status


def _text(w, message_id):
    return next(m for m in _snap(w)["messages"] if m["messageId"] == message_id)["text"]


def test_r1_a_queued_reroll_is_labelled_without_a_version_and_the_chat_never_claims_v2(world):
    made, status = _rejected_reroll(world)
    assert _text(world, status["messageId"]) == "다시 뽑기: 플라즈마 카타나"  # queued: v2 is not drawn yet

    _poll(world)  # both draws are cut at both sides: v2 is a version only, the IP keeps v1

    assert _ip(world, made["ipId"])["version"] == 1
    images = [a for a in _snap(world)["assets"] if a["kind"] == "image" and a.get("ipId") == made["ipId"]]
    assert sorted(int(a["meta"].get("version") or 1) for a in images) == [1, 2]  # v2 is in the version history
    assert not [m["text"] for m in _snap(world)["messages"] if "v2" in m["text"]]


def test_r1_a_stable_image_reroll_lands_at_once_so_its_line_keeps_the_version(monkeypatch):
    ctx = make_ctx(table=FakeTable(), s3=FakeS3())
    session = store.put_session(ctx, "user-1", None, "rpg-explore")
    monkeypatch.setattr(tools, "generate_image", lambda *a, **k: b"\xff\xd8JPEG")
    monkeypatch.setattr(tools, "remove_background", lambda ctx, image: png_rgba(sword()))
    made = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "prop", "name": "검", "description": "a sword",
                                                             "image_model": "stability-ultra"})
    sid = session["sessionId"]
    status = store.put_message(ctx, sid, "assistant", app.ASYNC_TOOLS["reroll_ip_image"], "pending")

    app.run_tool_turn(ctx, sid, "reroll_ip_image", {"ipId": made["ipId"]}, {"messageId": status["messageId"],
                                                                            "ts": status["ts"]})

    assert store.get_ip(ctx, sid, made["ipId"])["version"] == 2
    assert store.snapshot(ctx, sid)["messages"][0]["text"] == "다시 뽑기: 검 v2"  # it is the IP's picture already


def test_r1_the_next_turn_reads_no_v2_claim_and_each_versions_own_check(world):
    made, _ = _rejected_reroll(world)
    _poll(world)
    ctx, sid = world["ctx"], world["sid"]
    store.put_message(ctx, sid, "user", "장창 3D로 만들어줘", "done")
    reply = store.put_message(ctx, sid, "assistant", "", "pending", ts=store.now(offset_ms=1))
    end = {"stopReason": "end_turn", "output": {"message": {"role": "assistant", "content": [{"text": "네"}]}}}
    ctx.bedrock_rt_east = model = ScriptedModel(lambda messages: end)

    agent.run_turn(ctx, sid, reply["messageId"])

    [call] = model.calls
    history = json.dumps(call["messages"], ensure_ascii=False)
    assert "다시 뽑기: 플라즈마 카타나" in history and "v2" not in history  # the reroll's line claims no version
    state = agent.state_summary(_snap(world))
    assert state in call["system"][0]["text"]
    drew = {j["input"].get("version"): j["jobId"] for j in _snap(world)["jobs"] if j["kind"] == "image"}
    errors = {j["jobId"]: j.get("error", "") for j in json.loads(state)["jobs"]}
    first, again = errors[drew[1]], errors[drew[2]]
    assert "오른쪽이 프레임에 잘림" in first and "왼쪽" not in first and "첫 그림" in first  # v1's own cut
    assert "왼쪽·오른쪽이 프레임에 잘림" in again and "새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 써요" in again
    assert next(i for i in json.loads(state)["ips"] if i["ipId"] == made["ipId"])["image"] == "check_failed"


def test_r1_the_prompt_says_which_version_failed_and_why_which_one_stays_and_that_it_is_in_the_version_history():
    [rule] = [line for line in prompts.SYSTEM.splitlines() if "구도 검사 실패" in line]
    assert "그 작업이 새로 그린 그림의 것" in rule  # an error's cut belongs to that job's draw, not to the kept picture
    # how to read the error's ending, which the server writes for the IP's current version
    assert "실패한 것은 vN" in rule and "IP는 vM을 그대로 쓰고 있다" in rule
    assert "어느 버전이 무엇 때문에" in rule and "현재 그림으로 남는지" in rule and "카드의 버전 기록에 있다" in rule
    assert "다른 버전의 것처럼 말하지 않는다" in rule
    assert "아직 알리지 않았으면" in rule and "check_failed" in rule  # told once; a kept first picture is flagged
