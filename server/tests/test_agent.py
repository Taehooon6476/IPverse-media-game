import json
import re

from server import agent, jobs, prompts, store, tools
from server.tests.conftest import FakeBedrockRT, FakeS3, FakeTable, make_ctx

CONCEPT = {"title": "루나의 궤도 탈출", "logline": "고양이 탐험가의 탈출극", "style": "stylized 3D animation",
           "palette": ["#ffb86b", "#1b2a4a", "#5de6cf"], "genre": "sf-shooter"}


def _turn(ctx, text="컨셉 잡아줘"):
    session = store.put_session(ctx, "user-1", None, "sf-shooter")  # default title "새 세션"
    sid = session["sessionId"]
    store.put_message(ctx, sid, "user", text, "done", ts="2026-10-29T10:00:00.000Z")
    pending = store.put_message(ctx, sid, "assistant", "", "pending", ts="2026-10-29T10:00:00.001Z")
    return sid, pending


def _tool_use(name, args, tool_use_id="tu_1"):
    content = [{"text": "먼저 컨셉을 잡을게요."}, {"toolUse": {"toolUseId": tool_use_id, "name": name, "input": args}}]
    return {"stopReason": "tool_use", "output": {"message": {"role": "assistant", "content": content}}}


def _final(text):
    return {"stopReason": "end_turn", "output": {"message": {"role": "assistant", "content": [{"text": text}]}}}


def test_run_turn_calls_tool_and_finishes():
    east = FakeBedrockRT([_tool_use("set_concept", CONCEPT), _final("컨셉을 정했어요.")])
    ctx = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=east)
    sid, pending = _turn(ctx)

    agent.run_turn(ctx, sid, pending["messageId"])

    snap = store.snapshot(ctx, sid)
    msg = snap["messages"][-1]
    assert (msg["status"], msg["text"]) == ("done", "먼저 컨셉을 잡을게요.\n\n컨셉을 정했어요.")  # text before the tool call is kept
    assert [e["tool"] for e in msg["toolEvents"]] == ["set_concept"]
    assert "루나의 궤도 탈출" in msg["toolEvents"][0]["summary"]
    assert snap["session"]["concept"]["palette"] == CONCEPT["palette"]
    assert snap["session"]["title"] == "루나의 궤도 탈출"  # default title replaced by the concept

    first, second = east.calls
    assert first["modelId"] == "test-agent" and first["inferenceConfig"] == {"maxTokens": 32000}
    assert sid in first["system"][0]["text"]  # the state summary carries the real ids
    assert {t["toolSpec"]["name"] for t in first["toolConfig"]["tools"]} == set(tools.TOOLS) - tools.UI_ONLY_TOOLS
    [request] = first["messages"]  # the request, then the server's note of what runs now
    assert request["role"] == "user" and request["content"][0]["text"].startswith("컨셉 잡아줘\n\n[서버 메모 · ")
    [block] = second["messages"][-1]["content"]
    assert second["messages"][-1]["role"] == "user"
    assert block["toolResult"]["toolUseId"] == "tu_1" and block["toolResult"]["status"] == "success"


class ThrottledBedrock:
    def invoke_model(self, **kwargs):
        raise RuntimeError("ThrottlingException: Too many requests")


def test_run_turn_marks_failed_on_tool_error():
    east = FakeBedrockRT([_tool_use("create_ip_asset", {"kind": "character", "name": "Luna", "description": "cat",
                                                         "image_model": "stability-ultra"})])
    ctx = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=east, bedrock_rt_west=ThrottledBedrock())
    sid, pending = _turn(ctx, "루나 만들어줘")

    agent.run_turn(ctx, sid, pending["messageId"])

    msg = store.snapshot(ctx, sid)["messages"][-1]
    assert msg["status"] == "failed"
    assert msg["text"] == agent.FAILED_NOTE  # Korean, never left pending; the exception is in the log
    assert "Throttling" not in msg["text"] and re.search("[가-힣]", msg["text"])


def test_history_alternates_roles():
    messages = [
        {"messageId": "m1", "role": "user", "text": "첫 요청"},
        {"messageId": "m2", "role": "assistant", "text": ""},  # an old turn that never answered
        {"messageId": "m3", "role": "user", "text": "다시 요청"},
        {"messageId": "m4", "role": "assistant", "text": "", "status": "pending"},
    ]
    assert agent.history(messages, "m4") == [{"role": "user", "content": [{"text": "첫 요청\n\n다시 요청"}]}]


def test_stale_pending_turn_is_failed():
    ctx = make_ctx(table=FakeTable())
    sid, pending = _turn(ctx)  # ts in the past: the turn's Lambda is long gone
    fresh = store.put_message(ctx, sid, "assistant", "", "pending")

    snap = store.snapshot(ctx, sid)
    agent.fail_stale_turns(ctx, snap)

    stored = {m["messageId"]: m for m in store.snapshot(ctx, sid)["messages"]}
    assert stored[pending["messageId"]]["status"] == "failed" and stored[pending["messageId"]]["text"]
    assert stored[fresh["messageId"]]["status"] == "pending"
    assert {m["messageId"]: m["status"] for m in snap["messages"]} == {k: v["status"] for k, v in stored.items()}


def test_run_turn_fails_when_the_reply_is_cut_off():
    cut = {"stopReason": "max_tokens", "output": {"message": {"role": "assistant", "content": [
        {"text": "게임을 만들게요."},
        {"toolUse": {"toolUseId": "tu_1", "name": "make_game", "input": {"spec": {"version": 1}}}}]}}}
    east = FakeBedrockRT([cut])
    ctx = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=east)
    sid, pending = _turn(ctx, "게임 만들어줘")

    agent.run_turn(ctx, sid, pending["messageId"])

    snap = store.snapshot(ctx, sid)
    msg = snap["messages"][-1]
    assert (msg["status"], msg["text"]) == ("failed", agent.TRUNCATED)  # its words: test_round20_prompt.py
    assert msg["toolEvents"] == [] and snap["games"] == []  # the truncated tool call never ran


def test_duplicate_turn_invocation_is_a_noop():
    east = FakeBedrockRT([])  # any Converse call would fail the turn
    ctx = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=east)
    sid, pending = _turn(ctx)
    # the first async invocation already claimed the turn and is still working on it
    assert store.update_message(ctx, sid, pending, expect={"claimedAt": None}, claimedAt=store.now())
    assert not store.update_message(ctx, sid, pending, expect={"claimedAt": None}, claimedAt=store.now())

    agent.run_turn(ctx, sid, pending["messageId"])  # the duplicate

    assert east.calls == []
    assert store.snapshot(ctx, sid)["messages"][-1]["status"] == "pending"


def test_state_summary_lists_only_unfinished_jobs_as_in_flight():
    """A finished job must read as finished; what is still running is spelled out with its progress."""
    ctx = make_ctx(table=FakeTable(), s3=FakeS3())
    sid, _ = _turn(ctx)
    done = jobs.create_job(ctx, sid, "shot", "mediagen_video", {"ipId": "ip_1", "model": "ltx", "seconds": 8}, [])
    store.update_job(ctx, sid, done["jobId"], status="done", progress="", updatedAt="2026-10-29T10:05:00.000Z")
    running = jobs.create_job(ctx, sid, "shot", "mediagen_video", {"ipId": "ip_1", "model": "kandinsky"}, [])
    store.update_job(ctx, sid, running["jobId"], status="running", progress="denoising step 4/20")

    state = json.loads(agent.state_summary(store.snapshot(ctx, sid)))

    assert state["now"]
    by_id = {j["jobId"]: j for j in state["jobs"]}
    assert by_id[done["jobId"]]["status"] == "done"
    assert by_id[done["jobId"]]["finishedAt"] == "2026-10-29 19:05 KST"  # the user's clock
    assert "progress" not in by_id[done["jobId"]]
    assert by_id[running["jobId"]]["progress"] == "denoising step 4/20"
    assert state["jobsInFlight"] == [running["jobId"]]


def test_a_registered_job_result_says_what_it_waits_for():
    """The tool result the model reads carries the job's real deps and the turntable it will use."""
    east = FakeBedrockRT()
    ctx = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=east)
    sid, pending = _turn(ctx, "트레일러 잘라줘, 턴테이블도")
    store.put_ip(ctx, sid, {"ipId": "ip_1", "name": "노바", "turntableAssetId": "ast_old_tt"})
    shot = jobs.create_job(ctx, sid, "shot", "mediagen_video", {"ipId": "ip_1"}, [])
    store.update_job(ctx, sid, shot["jobId"], status="done")
    waiting_shot = jobs.create_job(ctx, sid, "shot", "mediagen_video", {"ipId": "ip_1"}, [])
    jobs.create_job(ctx, sid, "render3d", "deadline", {"ipId": "ip_1"}, [])  # a new relief render in flight
    east._responses = [_tool_use("cut_trailer", {"shot_job_ids": [shot["jobId"], waiting_shot["jobId"]],
                                                  "title": "노바", "include_turntable_ip_id": "ip_1"}),
                       _final("등록했어요.")]

    agent.run_turn(ctx, sid, pending["messageId"])

    result = east.calls[1]["messages"][-1]["content"][0]["toolResult"]["content"][0]["json"]
    assert result["job"]["status"] == "queued"
    # only the unfinished shot holds it back; the render in flight is not a dep
    assert result["job"]["waitsFor"] == [{"jobId": waiting_shot["jobId"], "kind": "shot", "status": "queued"}]
    assert result["job"]["usesAssetIds"] == ["ast_old_tt"]  # the existing turntable, not the one being rendered


def test_prompt_rules_on_job_state():
    for key in ("jobsInFlight", "finishedAt", "waitsFor", "usesAssetIds"):
        assert key in prompts.SYSTEM
