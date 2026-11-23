"""What the chat agent is told about time, progress and 3D, and how long a tool-event line may be."""
import json

from server import agent, jobs, prompts, store, tools
from server.tests.conftest import FakeBedrockRT, FakeS3, FakeTable, make_ctx


def _session(ctx):
    sid = store.put_session(ctx, "user-1", None, "arpg")["sessionId"]
    store.put_message(ctx, sid, "user", "포션 3D 있어?", "done", ts="2026-11-08T12:00:00.000Z")
    pending = store.put_message(ctx, sid, "assistant", "", "pending", ts="2026-11-08T12:00:00.001Z")
    return sid, pending


def _final(text):
    return {"stopReason": "end_turn", "output": {"message": {"role": "assistant", "content": [{"text": text}]}}}


# --- every time the agent reads is KST -------------------------------------------------------------------------

def test_state_times_are_kst_and_labelled(monkeypatch):
    ctx = make_ctx(table=FakeTable(), s3=FakeS3())
    sid, _ = _session(ctx)
    shot = jobs.create_job(ctx, sid, "shot", "mediagen_video", {"ipId": "ip_1", "model": "ltx"}, [])
    store.update_job(ctx, sid, shot["jobId"], status="done", updatedAt="2026-11-08T12:28:40.123Z")
    monkeypatch.setattr(store, "now", lambda offset_ms=0: "2026-11-08T15:30:00.000Z")

    state = json.loads(agent.state_summary(store.snapshot(ctx, sid)))

    assert state["now"] == "2026-11-09 00:30 KST"  # past midnight in Korea: the date moves too
    assert next(j for j in state["jobs"] if j["jobId"] == shot["jobId"])["finishedAt"] == "2026-11-08 21:28 KST"
    assert "Z" not in json.dumps({"now": state["now"], "jobs": state["jobs"]})


def test_the_prompt_says_times_are_kst():
    assert "KST" in prompts.SYSTEM and "UTC" in prompts.SYSTEM


# --- old progress in a long session must not win over the current state ----------------------------------------

def test_state_opens_with_what_is_running_now():
    ctx = make_ctx(table=FakeTable(), s3=FakeS3())
    sid, _ = _session(ctx)
    store.put_ip(ctx, sid, {"ipId": "ip_nova", "kind": "character", "name": "노바"})
    done = jobs.create_job(ctx, sid, "render3d", "blender", {"ipId": "ip_nova", "model": "relief"}, [])
    store.update_job(ctx, sid, done["jobId"], status="done")

    text = agent.state_summary(store.snapshot(ctx, sid))
    assert list(json.loads(text))[0] == "지금 진행 중"
    assert json.loads(text)["지금 진행 중"] == "없음"

    running = jobs.create_job(ctx, sid, "shot", "mediagen_video", {"ipId": "ip_nova", "model": "ltx"}, [])
    store.update_job(ctx, sid, running["jobId"], status="running")
    line = json.loads(agent.state_summary(store.snapshot(ctx, sid)))["지금 진행 중"]
    assert line.startswith("1개") and "노바" in line and "shot" in line and running["jobId"] in line


def test_the_latest_request_carries_a_now_note_and_the_reply_never_shows_it():
    """The newest user turn the model reads ends with what is running now, so an old answer's progress is not
    copied; an echo of the note is stripped from the reply."""
    note = "[서버 메모 · 2026-11-09 10:00 KST · 지금 진행 중인 작업: 없음. 대화 기록 속 예전 답변의 진행 상황은 그때의 것이다.]"
    east = FakeBedrockRT([_final(note + "\n지금 진행 중인 작업은 없어요.")])
    ctx = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=east)
    sid = store.put_session(ctx, "user-1", None, "arpg")["sessionId"]
    store.put_message(ctx, sid, "user", "트레일러 만들어줘", "done", ts="2026-11-08T03:00:00.000Z")
    store.put_message(ctx, sid, "assistant", "noir 트레일러는 노바의 relief 3D 렌더가 끝나기를 기다립니다.", "done",
                      ts="2026-11-08T03:00:01.000Z")
    store.put_message(ctx, sid, "user", "지금 뭐 돌아가?", "done", ts="2026-11-09T01:00:00.000Z")
    pending = store.put_message(ctx, sid, "assistant", "", "pending", ts="2026-11-09T01:00:00.001Z")

    agent.run_turn(ctx, sid, pending["messageId"])

    sent = east.calls[0]["messages"]
    last = sent[-1]["content"][0]["text"]
    assert sent[-1]["role"] == "user" and last.startswith("지금 뭐 돌아가?")
    assert "[서버 메모 · " in last and "KST" in last and "지금 진행 중인 작업: 없음" in last
    assert "예전 답변" in last
    assert "서버 메모" not in sent[0]["content"][0]["text"]  # only the newest request carries it
    reply = store.snapshot(ctx, sid)["messages"][-1]
    assert reply["text"] == "지금 진행 중인 작업은 없어요."
    assert "서버 메모" not in "".join(m["text"] for m in store.snapshot(ctx, sid)["messages"])  # never stored


# --- each IP's 3D status ---------------------------------------------------------------------------------------

def test_state_says_which_ips_have_3d():
    ctx = make_ctx(table=FakeTable(), s3=FakeS3())
    sid, _ = _session(ctx)
    store.put_asset(ctx, sid, {"assetId": "ast_glb", "kind": "glb", "ipId": "ip_potion", "key": "k.glb"})
    store.put_ip(ctx, sid, {"ipId": "ip_potion", "kind": "prop", "name": "포션", "glbAssetId": "ast_glb"})
    store.put_ip(ctx, sid, {"ipId": "ip_mage", "kind": "character", "name": "마법사 동료"})
    store.put_ip(ctx, sid, {"ipId": "ip_gone", "kind": "prop", "name": "방패", "glbAssetId": "ast_missing"})

    ips = {i["ipId"]: i for i in json.loads(agent.state_summary(store.snapshot(ctx, sid)))["ips"]}

    assert ips["ip_potion"]["has3d"] is True
    assert ips["ip_mage"]["has3d"] is False
    assert ips["ip_gone"]["has3d"] is False  # make_game only uses a GLB that exists


def test_the_prompt_says_to_read_has3d():
    assert "has3d" in prompts.SYSTEM


# --- a long failure reason is cut at a word, with an ellipsis --------------------------------------------------

LONG = "GameSpec 검증 실패: " + "; ".join(f"world.entities[{i}].width must be a number 0.3-20" for i in range(30))


def test_a_long_failure_reason_is_cut_at_a_word_with_an_ellipsis():
    line = tools.summarize("make_game", {}, {"error": "bad_spec", "message": LONG})
    assert line.startswith("게임 만들기 실패: GameSpec 검증 실패: world.entities[0].width must be a number 0.3-20")
    assert line.endswith("…")
    head = line[:-1]
    full = "게임 만들기 실패: " + LONG
    assert full.startswith(head) and full[len(head)] in " ;"  # the cut falls between words
    assert "world.entities[3].width must be a number 0.3-20" in line  # more than 200 characters are kept


def test_a_short_failure_reason_stays_whole():
    assert tools.summarize("make_game", {}, {"error": "x", "message": "짧은 이유"}) == "게임 만들기 실패: 짧은 이유"


def test_clip_never_cuts_a_word():
    assert tools.clip("alpha beta gamma", 12) == "alpha beta…"
    assert tools.clip("alpha beta", 12) == "alpha beta"
    assert len(tools.clip("x" * 50, 10)) == 10  # one long word: a hard cut, still marked
