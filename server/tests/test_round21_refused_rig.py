"""A skeleton the render farm refuses is the figure's cause, not a failure to retry.

A job that ended as a refusal carries outcome "refused" and a short Korean reason (the web reads the field, never the
sentence). A hero with a finished model and a refused skeleton is ready for a game: the 3D gate lets make_game through,
a held request is offered, and every line the server writes says that the game comes without walking motions and that
a new full-body picture is what brings them."""
import json
import re

import pytest

from server import agent, jobs, prompts, store, tools
from server.providers import rig
from server.tests.conftest import FakeBedrockRT, FakeDeadline, FakeS3, FakeTable, make_ctx
from server.tests.test_agent import _final
from server.tests.test_gamespec import minimal_sf
from server.tests.test_round20_errors import plain
from server.tests.test_round20_hold import _ask, _calls, _hero, _message
from server.tests.test_round20_notice import _chain, _end, _said, _turn
from server.tests.test_tools import BUCKET, RUNTIME3D, _glb, _session

QUEUE = "griptapenode-queue-087967639890-us-east-1-an"
# the worker's own words (workers/rig/blender_rig.py PARTIAL, UNEVEN)
NOT_FULL = "not a full body: legs are missing or cut off (hips at 30% of the height)"
UNEVEN = "legs of uneven length (28%) after pose estimator failed"
LEAD = "움직임 뼈대를 넣을 수 없는 모양입니다"
LATIN = re.compile("[A-Za-z]")


@pytest.fixture
def ctx():
    c = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=FakeBedrockRT(), deadline=FakeDeadline())
    for name in RUNTIME3D:
        c.s3._store[(BUCKET, f"runtime3d/v1/{name}")] = name.encode()
    return c


@pytest.fixture
def sid(ctx):
    return _session(ctx)["sessionId"]


def _rig_on_the_farm(ctx, sid, ip_id="ip_hero"):
    """A 움직임 뼈대 job the farm is working on."""
    job = jobs.create_job(ctx, sid, "rig", "rig", {"ipId": ip_id, "glbKey": f"sessions/{sid}/m.glb"}, [])
    store.update_job(ctx, sid, job["jobId"], status="running", externalId="dl-1")
    return job["jobId"]


def _farm_ends(ctx, job_id, meta=None):
    """The farm's job failed; meta: what the worker left in meta.json (None: it never got that far)."""
    ctx.deadline._job_responses["dl-1"] = {"taskRunStatus": "FAILED", "lifecycleStatus": "CREATE_COMPLETE"}
    if meta is not None:
        ctx.s3._store[(QUEUE, f"DeadlineCloud/ipverse/{job_id}/meta.json")] = json.dumps(meta).encode()


def _refused(ctx, sid, name="꼬마 마법사", reason=NOT_FULL):
    """A hero with a finished 3D model and a 움직임 뼈대 job that ended as a refusal."""
    _hero(ctx, sid, name)
    _glb(ctx, sid, "ip_hero")
    job_id = _rig_on_the_farm(ctx, sid)
    _farm_ends(ctx, job_id, {"method": "refused", "fallbackReason": reason})
    jobs.advance_jobs(ctx, sid)
    return store.get_job(ctx, sid, job_id)


# ── (a) the record says it ─────────────────────────────────────────────────────

def test_a_skeleton_the_farm_refused_ends_as_a_refusal_with_a_korean_reason(ctx, sid):
    job = _refused(ctx, sid)
    assert (job["status"], job["outcome"]) == ("failed", "refused") == ("failed", jobs.REFUSED)
    assert job["reason"] == "다리가 보이지 않거나 너무 짧아요" and not LATIN.search(job["reason"])
    assert job["error"] == f"{LEAD}: {NOT_FULL}"  # the worker's own words stay on the record, for the log and a hover


@pytest.mark.parametrize("worker,reason", [
    (UNEVEN, "두 다리의 길이가 다르게 보여요(꼬리나 긴 옷자락이 다리처럼 보일 수 있어요)"),
    ("arms fused to the torso", "뼈대를 맞출 수 없는 모양이에요"),  # a reason a later worker may give
])
def test_each_refusal_has_a_reason_a_person_can_read(ctx, sid, worker, reason):
    job = _refused(ctx, sid, reason=worker)
    assert (job["outcome"], job["reason"]) == ("refused", reason)
    assert not LATIN.search(reason) and re.search(r"요\)?$", reason) and "니다" not in reason  # 해요체, no closing mark


@pytest.mark.parametrize("meta", [
    None,  # Blender never got as far as a meta.json
    # the worker fell back to proportions and failed later (the upload, the preview): no refusal, a retry may pass
    {"method": "proportions", "fallbackReason": "pose estimator failed"},
])
def test_a_skeleton_that_failed_for_another_reason_is_no_refusal(ctx, sid, meta):
    _hero(ctx, sid)
    job_id = _rig_on_the_farm(ctx, sid)
    _farm_ends(ctx, job_id, meta)
    jobs.advance_jobs(ctx, sid)
    job = store.get_job(ctx, sid, job_id)
    assert job["status"] == "failed" and not job.get("outcome") and not job.get("reason")
    assert job["error"] == "렌더 서버에서 작업이 실패했습니다: FAILED"  # never "넣을 수 없는 모양": this model can be rigged


@pytest.mark.parametrize("line,reason", [
    # the oldest wording of a stored refusal
    ("리깅 불가: not a full body: legs are missing or cut off (hips at 25% of the height)", "다리가 보이지 않거나 너무 짧아요"),
    # the current lead, stored without the outcome field
    (f"{LEAD}: {NOT_FULL}", "다리가 보이지 않거나 너무 짧아요"),
    (f"{LEAD}: {UNEVEN}", "두 다리의 길이가 다르게 보여요(꼬리나 긴 옷자락이 다리처럼 보일 수 있어요)"),
])
def test_a_refusal_recorded_before_the_field_gets_it_at_the_sessions_next_poll(ctx, sid, line, reason):
    _hero(ctx, sid)
    old = jobs.create_job(ctx, sid, "rig", "rig", {"ipId": "ip_hero"}, [])
    store.update_job(ctx, sid, old["jobId"], status="failed", error=line, updatedAt="2026-11-16T15:17:12.000Z")

    jobs.advance_jobs(ctx, sid)  # what every GET of the session runs first

    job = store.get_job(ctx, sid, old["jobId"])
    assert (job["status"], job["outcome"], job["reason"], job["error"]) == ("failed", "refused", reason, line)
    assert job["updatedAt"] == "2026-11-16T15:17:12.000Z"  # the card's 작업 time still ends where the job ended


@pytest.mark.parametrize("line", [
    "리깅 불가: pose estimator failed",  # a retry can pass
    f"{LEAD}: no pose estimator",
    "렌더 서버에서 작업이 실패했습니다: FAILED",
    jobs.DEP_FAILED,
    jobs.CANCELED,
    # the worker's detection giving up (blender_rig.py implausible) before a fallback that failed for another cause:
    # a real refusal for uneven legs is the fallback's own and always says what it came after ("… (28%) after …")
    f"{LEAD}: legs of uneven length (40%)",
    "리깅 불가: legs of uneven length (40%)",
])
def test_an_older_failure_that_was_no_refusal_stays_as_it_is(ctx, sid, line):
    _hero(ctx, sid)
    old = jobs.create_job(ctx, sid, "rig", "rig", {"ipId": "ip_hero"}, [])
    store.update_job(ctx, sid, old["jobId"], status="failed", error=line)
    jobs.advance_jobs(ctx, sid)
    job = store.get_job(ctx, sid, old["jobId"])
    assert not job.get("outcome") and not job.get("reason")


def test_only_a_skeleton_job_is_read_for_a_refusal(ctx, sid):
    """Another kind of job whose line happens to start the same way is not the rig's."""
    shot = jobs.create_job(ctx, sid, "shot", "mediagen_video", {"prompt": "orbit"}, [])
    store.update_job(ctx, sid, shot["jobId"], status="failed", error=f"{LEAD}: {NOT_FULL}")
    jobs.advance_jobs(ctx, sid)
    assert not store.get_job(ctx, sid, shot["jobId"]).get("outcome")


def test_a_retry_takes_the_refusal_off_the_record(ctx, sid):
    """다시 시도 through the API still works: while it runs again the job is no refusal."""
    job = _refused(ctx, sid)
    assert jobs.retry_job(ctx, sid, job["jobId"]) == [job["jobId"]]
    again = store.get_job(ctx, sid, job["jobId"])
    assert again["status"] == "queued" and not again.get("outcome") and not again.get("reason")


def _runs_again(ctx, sid, job_id, external):
    """다시 시도, and the farm's new run fails."""
    assert jobs.retry_job(ctx, sid, job_id) == [job_id]
    store.update_job(ctx, sid, job_id, status="running", externalId=external, startedAt=store.now())
    ctx.deadline._job_responses[external] = {"taskRunStatus": "FAILED", "lifecycleStatus": "CREATE_COMPLETE"}


def test_a_retry_that_dies_before_the_rig_tool_runs_is_not_refused_by_the_run_before_it(ctx, sid):
    """A run keeps its files under the job's own id, so the refused run's meta.json is still there when its retry
    fails before Blender starts: a file older than the run's start is not this run's refusal."""
    from datetime import datetime, timedelta, timezone
    job = _refused(ctx, sid)
    meta = (QUEUE, f"DeadlineCloud/ipverse/{job['jobId']}/meta.json")
    ctx.s3.modified = {meta: datetime.now(timezone.utc) - timedelta(minutes=3)}  # written by the refused run

    _runs_again(ctx, sid, job["jobId"], "dl-2")
    jobs.advance_jobs(ctx, sid)

    died = store.get_job(ctx, sid, job["jobId"])
    assert died["status"] == "failed" and not died.get("outcome") and not died.get("reason")
    assert died["error"] == "렌더 서버에서 작업이 실패했습니다: FAILED"
    # a run that is refused itself leaves its own file, after its start
    _runs_again(ctx, sid, job["jobId"], "dl-3")
    ctx.s3.modified[meta] = datetime.now(timezone.utc) + timedelta(seconds=40)
    jobs.advance_jobs(ctx, sid)
    refused = store.get_job(ctx, sid, job["jobId"])
    assert (refused["outcome"], refused["reason"]) == ("refused", "다리가 보이지 않거나 너무 짧아요")


# ── (b) a model with a refused skeleton is ready for a game ───────────────────

def _lookup(ctx, sid):
    snap = store.snapshot(ctx, sid)
    ips = {i["ipId"]: i for i in snap["ips"]}
    return snap, ips, {a["assetId"]: a for a in snap["assets"]}, {j["jobId"]: j for j in snap["jobs"]}


def test_the_3d_gate_takes_the_model_as_it_is(ctx, sid):
    _refused(ctx, sid)
    snap, ips, assets, by_id = _lookup(ctx, sid)
    hero = ips["ip_hero"]
    assert tools.ready_3d_for_game(hero, assets, by_id) is True
    assert tools.game_3d_state(hero, assets, by_id) == "ready"
    assert tools.refused_skeleton(hero, assets, by_id) == "다리가 보이지 않거나 너무 짧아요"

    spec = minimal_sf()
    spec["player"]["ipId"] = "ip_hero"
    made = tools.run_tool(ctx, store.get_session(ctx, sid), "make_game", {"spec": spec})
    assert "error" not in made and made["gameId"].startswith("gm_")
    written = json.loads(ctx.s3._store[(BUCKET, f"games/{made['gameId']}/spec.json")])
    assert written["player"]["modelUrl"] == "assets/ip_hero.glb" and "animUrl" not in written  # the model, no clips
    # what the agent is handed to say: no walking motions, a new picture brings them, never 다시 시도
    assert made["noSkeleton"] == ["꼬마 마법사"]
    told = made["message"]
    assert "꼬마 마법사" in told and "걷고 공격하는 동작 없이" in told and "다리가 보이지 않거나 너무 짧아요" in told
    assert "머리부터 발끝까지 보이고 두 다리가 드러나게 서 있는 그림" in told
    assert "'다시 시도'" in told and "권하지" in told


def test_a_model_whose_skeleton_is_in_says_nothing_of_it(ctx, sid):
    _hero(ctx, sid)
    _glb(ctx, sid, "ip_hero")
    _glb(ctx, sid, "ip_hero", "rigged_glb", "riggedGlbAssetId")
    spec = minimal_sf()
    spec["player"]["ipId"] = "ip_hero"
    made = tools.run_tool(ctx, store.get_session(ctx, sid), "make_game", {"spec": spec})
    assert "error" not in made and "noSkeleton" not in made and "message" not in made


def test_an_earlier_skeleton_still_in_use_is_not_a_missing_one(ctx, sid):
    """A refused skeleton on a newer try, while the IP still plays its earlier rigged model: the game has its motions."""
    _refused(ctx, sid)
    _glb(ctx, sid, "ip_hero", "rigged_glb", "riggedGlbAssetId")
    _, ips, assets, by_id = _lookup(ctx, sid)
    assert tools.refused_skeleton(ips["ip_hero"], assets, by_id) == ""


def test_a_skeleton_being_put_in_again_is_not_refused_yet(ctx, sid):
    """A new 3D of the same IP (or 다시 시도): its newest skeleton job decides, and that one still runs."""
    _refused(ctx, sid)
    newer = jobs.create_job(ctx, sid, "rig", "rig", {"ipId": "ip_hero"}, [])
    _, ips, assets, by_id = _lookup(ctx, sid)
    assert by_id[newer["jobId"]]["status"] == "queued"
    assert tools.refused_skeleton(ips["ip_hero"], assets, by_id) == ""
    assert tools.ready_3d_for_game(ips["ip_hero"], assets, by_id) is False  # that skeleton is still coming


def test_the_hold_tool_does_not_hold_a_game_that_can_be_made(ctx, sid):
    _refused(ctx, sid)
    out = tools.run_tool(ctx, store.get_session(ctx, sid), "hold_game_request", {"ipId": "ip_hero"})
    assert out["error"] == "ready_3d" and "make_game" in out["message"]
    assert "걷고 공격하는 동작 없이" in out["message"] and "'다시 시도'" in out["message"]


def test_a_game_asked_for_after_the_refusal_is_not_put_on_hold(ctx, sid):
    """agent._keep_hold reads the same gate: nothing waits, so nothing is marked, whatever the reply says."""
    _refused(ctx, sid)
    asked, pending = _ask(ctx, sid)
    ctx.bedrock_rt_east._responses = [_final("3D가 끝나면 화면에 '게임 만들기' 버튼이 나타나요.")]
    agent.run_turn(ctx, sid, pending["messageId"])
    assert "gameHeld" not in _message(ctx, sid, asked)


# ── the chat line at the chain's end ──────────────────────────────────────────

REDRAW = "걷는 동작을 넣으려면 머리부터 발끝까지 보이고 두 다리가 드러나게 서 있는 그림으로 다시 뽑은 뒤 3D를 다시 만들어 주세요."


def _chain_refused(ctx, sid, chain, reason=NOT_FULL):
    """The chain's other steps are done and its 움직임 뼈대 ends as the farm's refusal."""
    for kind in ("apose", "mesh3d", "render3d"):
        _end(ctx, sid, chain[kind])
    _glb(ctx, sid, "ip_hero")
    store.update_job(ctx, sid, chain["rig"]["jobId"], status="running", externalId="dl-1")
    _farm_ends(ctx, chain["rig"]["jobId"], {"method": "refused", "fallbackReason": reason})
    jobs.advance_jobs(ctx, sid)


def test_a_chain_whose_skeleton_was_refused_says_what_can_be_done(ctx, sid):
    chain = _chain(ctx, sid)
    _chain_refused(ctx, sid, chain)
    line = _said(ctx, sid)[-1]
    assert line == ("꼬마 마법사의 3D 모델은 준비됐지만 움직임 뼈대는 넣지 못했어요: 다리가 보이지 않거나 너무 짧아요. "
                    f"이대로 게임을 만들면 걷는 동작 없이 나와요. {REDRAW}")
    assert plain(line) and "다시 시도" not in line and "작업 현황" not in line
    assert len(_said(ctx, sid)) == 3  # once


def test_a_held_game_is_offered_as_it_is_when_its_heros_skeleton_was_refused(ctx, sid):
    """The game was asked for while the chain ran, then the skeleton was refused."""
    _hero(ctx, sid)
    _turn(ctx, sid, "이 IP들로 30초 생존 게임 만들어줘",
          ("render_3d", {"ipId": "ip_hero"}), ("hold_game_request", {"ipId": "ip_hero"}), reply="게임 요청은 보류해 두었어요.")
    assert tools.held_game(store.snapshot(ctx, sid))["gameHeld"] == {"ipIds": ["ip_hero"]}
    chain = {j["kind"]: j for j in store.snapshot(ctx, sid)["jobs"]}
    _chain_refused(ctx, sid, chain)

    line = _said(ctx, sid)[-1]
    assert line == ("꼬마 마법사의 3D 모델은 준비됐지만 움직임 뼈대는 넣지 못했어요: 다리가 보이지 않거나 너무 짧아요. "
                    f"요청해 둔 게임은 ‘게임 만들기’ 버튼으로 지금 만들 수 있고, 걷는 동작 없이 나와요. {REDRAW}")
    assert plain(line) and f"‘{tools.HELD_BUTTON}’" in line and "다시 시도" not in line
    # ... and the next turn's state says the held request can be made now
    state = json.loads(agent.state_summary(store.snapshot(ctx, sid)))
    assert state["heldGame"]["ready"] is True


def test_a_held_game_whose_skeleton_failed_for_a_passing_reason_is_not_said_to_be_on_offer(ctx, sid):
    """The page keeps 다시 시도 for a failure that is no refusal and shows no 게임 만들기 until the skeleton lands
    (web/src/api.ts readyIp): the state must not tell the agent of a button that is not on the screen."""
    _hero(ctx, sid)
    _turn(ctx, sid, "이 IP들로 30초 생존 게임 만들어줘",
          ("render_3d", {"ipId": "ip_hero"}), ("hold_game_request", {"ipId": "ip_hero"}), reply="게임 요청은 보류해 두었어요.")
    chain = {j["kind"]: j for j in store.snapshot(ctx, sid)["jobs"]}
    for kind in ("apose", "mesh3d", "render3d"):
        _end(ctx, sid, chain[kind])
    _glb(ctx, sid, "ip_hero")
    _end(ctx, sid, chain["rig"], "failed", "렌더 서버에서 작업이 실패했습니다: FAILED")

    snap = store.snapshot(ctx, sid)
    state = json.loads(agent.state_summary(snap))
    assert state["ips"][0]["game3d"] == "ready" and "skeleton" not in state["ips"][0]
    assert state["heldGame"]["ready"] is False
    line = _said(ctx, sid)[-1]
    assert line == "꼬마 마법사의 3D 모델은 준비됐지만 움직임 뼈대 단계가 실패했어요. ‘작업 현황’ 탭에서 이유와 다음에 할 일을 볼 수 있어요."
    # once the skeleton is in, the request is on offer
    _glb(ctx, sid, "ip_hero", "rigged_glb", "riggedGlbAssetId")
    assert json.loads(agent.state_summary(store.snapshot(ctx, sid)))["heldGame"]["ready"] is True


def test_a_skeleton_put_in_again_alone_and_refused_says_the_same(ctx, sid):
    """움직임 뼈대만 다시 넣기 (render_3d rig_only) on the model there is: its chain is that one job."""
    _hero(ctx, sid)
    mesh = jobs.create_job(ctx, sid, "mesh3d", "img3d", {"ipId": "ip_hero"}, [])
    glb = store.put_asset(ctx, sid, {"kind": "glb", "key": f"sessions/{sid}/{mesh['jobId']}.glb", "jobId": mesh["jobId"],
                                     "ipId": "ip_hero", "contentType": "model/gltf-binary"})
    store.update_job(ctx, sid, mesh["jobId"], status="done", outputs=[glb["assetId"]])
    store.update_ip(ctx, sid, "ip_hero", glbAssetId=glb["assetId"])
    _turn(ctx, sid, "꼬마 마법사 움직임 뼈대만 다시 넣어줘", ("render_3d", {"ipId": "ip_hero", "rig_only": True}))
    again = next(j for j in store.snapshot(ctx, sid)["jobs"] if j["kind"] == "rig")
    store.update_job(ctx, sid, again["jobId"], status="running", externalId="dl-1")
    _farm_ends(ctx, again["jobId"], {"method": "refused", "fallbackReason": UNEVEN})
    jobs.advance_jobs(ctx, sid)
    line = _said(ctx, sid)[-1]
    assert line.startswith("꼬마 마법사의 3D 모델은 준비됐지만 움직임 뼈대는 넣지 못했어요: 두 다리의 길이가 다르게 보여요")
    assert line.endswith(REDRAW) and plain(line)


# ── (c) what the agent reads and is told ──────────────────────────────────────

def test_the_agents_state_names_the_refusal(ctx, sid):
    job = _refused(ctx, sid)
    state = json.loads(agent.state_summary(store.snapshot(ctx, sid)))
    [hero] = state["ips"]
    assert (hero["game3d"], hero["has3d"]) == ("ready", True)
    assert (hero["skeleton"], hero["skeletonReason"]) == ("refused", "다리가 보이지 않거나 너무 짧아요")
    row = next(j for j in state["jobs"] if j["jobId"] == job["jobId"])
    assert (row["status"], row["outcome"], row["reason"]) == ("failed", "refused", "다리가 보이지 않거나 너무 짧아요")


def test_an_ip_with_its_skeleton_or_without_a_refusal_carries_no_such_word(ctx, sid):
    _hero(ctx, sid)
    _glb(ctx, sid, "ip_hero")
    state = json.loads(agent.state_summary(store.snapshot(ctx, sid)))
    assert "skeleton" not in state["ips"][0] and "skeletonReason" not in state["ips"][0]


def _rule(lead: str) -> str:
    """The prompt's line that starts with these words."""
    return next(line for line in prompts.SYSTEM.splitlines() if line.lstrip("- ").startswith(lead))


def test_the_prompt_never_sends_a_refused_skeleton_to_a_retry():
    rule = _rule("움직임 뼈대를 넣을 수 없는 모양")
    assert "state.ips[].skeleton이 refused" in rule and "skeletonReason" in rule
    # a retry fails the same way: neither 다시 시도 nor the skeleton alone again
    assert "'다시 시도'" in rule and "권하지 않는다" in rule and "rig_only" in rule
    # the two ways on: the game as it is, or a new picture with what it needs
    assert "'게임 만들기'" in rule and "걷고 공격하는 동작 없이" in rule and "game3d는 ready" in rule
    assert "'그림 다시 뽑기'" in rule and "머리부터 발끝까지" in rule and "두 다리가 드러나게" in rule and "서 있는" in rule
    assert "reroll_ip_image" in rule and "description" in rule
    # the reply rule that names 다시 시도 for a failed job points at this exception
    assert "움직임 뼈대를 넣을 수 없는 모양으로 끝난 작업은 '다시 시도'를 권하지 않는다" in _rule("작업 상태는 state에 적힌 대로")
    # and the screen section knows the row's button
    assert "'그림 다시 뽑기'" in _rule("'작업 현황' 탭")
    # the held request's readiness is the state's word, a refused skeleton included
    assert "state.heldGame.ready가 true면 그 요청을 지금 만들 수 있다" in _rule("3D 규칙")


def test_the_prompt_answers_a_question_before_acting():
    """A question such as "이대로 게임을 만들 수 있어?" is answered, not carried out."""
    rule = _rule("할 수 있는지 묻는 말")
    assert "먼저 답한다" in rule and "만들 수 있어?" in rule and "해 달라고 하면" in rule
