"""GPU images as background jobs, end to end on a fake image GPU box and a fake clock: a slow image never times a
turn out or queues a duplicate, one request for many assets settles without follow-up turns, a busy box does not take
a 3D chain down, a bad composition is drawn once more, and the paid finish (download, background removal) runs once,
after the claim.
"""
import copy
import socket
import urllib.error

import pytest
from botocore.exceptions import ClientError

from server import agent, jobs, store, tools
from server.providers import apose, mcp_client, mediagen_image as mi
from server.tests.conftest import FakeProvider, FakeS3, FakeTable, make_ctx
from server.tests.fake_gpu import BUSY_TEXT, Clock, FakeImageBox, fake_time
from server.tests.test_cutout import figure, png_rgba

GOOD = png_rgba(figure())
TWO = png_rgba(figure(-60) + figure(60))
HIPS = png_rgba([(90, 20, 150, 160, 255), (60, 30, 90, 100, 255), (150, 30, 180, 100, 255), (105, 0, 135, 20, 255)])
CONCEPT = {"title": "철맹세", "logline": "기사단의 마지막 전투", "style": "dark fantasy concept art",
           "palette": ["#c0392b", "#1b1b1b", "#d4af37"], "genre": "rpg-explore"}
ASSETS = [("character", "기사"), ("character", "마법사"), ("enemy", "해골 왕"), ("weapon", "마법검"), ("prop", "포션"),
          ("prop", "방패"), ("prop", "폐허 성채"), ("prop", "용암 동굴")]


class Log(FakeProvider):
    """A mesh / Blender / rig step that finishes on its first poll and logs when it was submitted."""

    def __init__(self, name, log, clock):
        super().__init__(name, states=[("done", "")])
        self.log, self.clock = log, clock

    def submit(self, job, ctx):
        self.log.append((self.clock.now(), job["kind"], job["input"].get("ipId")))
        return super().submit(job, ctx)


@pytest.fixture
def world(monkeypatch):
    clock = Clock()
    fake_time(monkeypatch, clock, agent, jobs)
    box = FakeImageBox(clock).install(monkeypatch)
    cutouts = {}  # downloaded picture → what background removal returns for it (GOOD by default)
    monkeypatch.setattr(mi, "remove_background", lambda ctx, image: cutouts.get(image, GOOD))
    monkeypatch.setattr(apose, "remove_background", lambda ctx, image: GOOD)
    log = []
    for name in ("img3d", "deadline", "rig"):
        monkeypatch.setitem(jobs.PROVIDERS, name, Log(name, log, clock))
    ctx = make_ctx(table=FakeTable(), s3=FakeS3())
    session = store.put_session(ctx, "user-1", None, "rpg-explore")
    return {"clock": clock, "box": box, "cutouts": cutouts, "log": log, "ctx": ctx, "session": session,
            "sid": session["sessionId"]}


def _concept(w):
    store.update_session(w["ctx"], w["session"], concept=CONCEPT)


def _poll(w, until_sec=3600):
    """The studio page polls every 3 s: advance the job engine until nothing is queued or running."""
    start = w["clock"].now()
    while w["clock"].now() - start < until_sec:
        jobs.advance_jobs(w["ctx"], w["sid"])
        if all(j["status"] in ("done", "failed") for j in _snap(w)["jobs"]):
            return w["clock"].now() - start
        w["clock"].sleep(3)
    raise AssertionError("jobs never settled")


def _snap(w):
    return store.snapshot(w["ctx"], w["sid"])


def _job(w, job_id):
    return next(j for j in _snap(w)["jobs"] if j["jobId"] == job_id)


def _ip(w, ip_id):
    return store.get_ip(w["ctx"], w["sid"], ip_id)


def _create(w, name="볼트", kind="character", **extra):
    return tools.run_tool(w["ctx"], w["session"], "create_ip_asset",
                          {"kind": kind, "name": name, "description": f"{name} description", **extra})


def _backlog(box, n):
    """Other studio sessions' jobs already on the shared box, alternating models (a swap each: ~135 s apiece)."""
    for i in range(n):
        box._start({"prompt": f"other {i}", "model": ("krea", "klein9")[i % 2]})
    box.starts.clear()


# ── 21: no wait in the call, no duplicate on the box ───────────────────────────


def test_defect21_a_slow_shared_box_costs_no_turn_time_and_no_duplicate_gpu_job(world):
    _concept(world)
    _backlog(world["box"], 4)  # ~9 min of other work ahead: the old call timed out at 210 s, twice
    t0 = world["clock"].now()
    out = _create(world, image_model="klein9")
    assert world["clock"].now() == t0 and out["status"] == "queued" and world["box"].starts == []

    took = _poll(world)

    assert len(world["box"].starts) == 1  # one GPU job for one image, however long the box took
    ip = _ip(world, out["ipId"])
    assert ip["imageAssetId"] and ip["cutoutAssetId"] and _job(world, out["jobId"])["status"] == "done"
    assert 540 < took < 600  # it simply waited its turn on the box


# ── 1, 16, 12: one turn registers everything, the jobs finish it ───────────────


class ScriptedModel:
    """Bedrock Converse that answers from callables (they see the conversation, so they can use real ipIds)."""

    def __init__(self, *steps):
        self.steps, self.calls = list(steps), []

    def converse(self, **kwargs):
        self.calls.append(kwargs)
        return self.steps.pop(0)(kwargs["messages"])


def _uses(*uses):
    content = [{"toolUse": {"toolUseId": f"tu_{i}_{name}", "name": name, "input": args}} for i, (name, args) in enumerate(uses)]
    return {"stopReason": "tool_use", "output": {"message": {"role": "assistant", "content": content}}}


def _results(messages):
    return [b["toolResult"]["content"][0]["json"] for b in messages[-1]["content"] if "toolResult" in b]


def test_defects1_16_12_one_turn_registers_8_assets_and_3d_and_the_jobs_finish_in_dependency_order(world):
    images = [("create_ip_asset", {"kind": k, "name": n, "description": f"{n}, detailed",
                                   **({"usage": "background"} if n in ("폐허 성채", "용암 동굴") else {})})
              for k, n in ASSETS]
    model = ScriptedModel(
        lambda m: _uses(("set_concept", CONCEPT)),
        lambda m: _uses(*images),
        lambda m: _uses(("render_3d", {"ipId": _results(m)[0]["ipId"]})),  # the hero, while its image is still drawn
        lambda m: {"stopReason": "end_turn", "output": {"message": {"role": "assistant", "content": [
            {"text": "8개 이미지를 그리는 중이에요."}]}}})
    ctx, sid = world["ctx"], world["sid"]
    ctx.bedrock_rt_east = model
    store.put_message(ctx, sid, "user", "캐릭터 3·소품 3·배경 2 만들어줘. 그리고 기사는 3D로", "done")
    pending = store.put_message(ctx, sid, "assistant", "", "pending", ts=store.now(1))
    t0 = world["clock"].now()

    agent.run_turn(ctx, sid, pending["messageId"])

    turn_sec = world["clock"].now() - t0
    msg = next(m for m in _snap(world)["messages"] if m["messageId"] == pending["messageId"])
    snap = _snap(world)
    assert turn_sec < 60 and msg["status"] == "done"  # no image wait inside the turn
    assert len(msg["toolEvents"]) == 10 and not [e for e in msg["toolEvents"] if "실패" in e["summary"]]
    assert len(snap["ips"]) == 8 and all(ip.get("imageJobId") for ip in snap["ips"])
    hero = next(ip for ip in snap["ips"] if ip["name"] == "기사")
    pose = next(j for j in snap["jobs"] if j["kind"] == "apose")
    assert pose["deps"] == [hero["imageJobId"]]  # the 3D chain waits for the hero's picture
    assert "pending" in agent.state_summary(snap)

    settled = _poll(world)

    snap = _snap(world)
    assert all(j["status"] == "done" for j in snap["jobs"]), [(j["kind"], j.get("error")) for j in snap["jobs"]]
    assert all(ip.get("imageAssetId") and ip.get("cutoutAssetId") for ip in snap["ips"])
    starts = world["box"].starts
    assert [s["model"] for s in starts] == ["krea"] * 8 + ["klein9"]  # no duplicates; the A-pose after the images
    by_id = {j["jobId"]: j for j in snap["jobs"]}
    hero_done = by_id[hero["imageJobId"]]["updatedAt"]
    assert hero_done <= pose["createdAt"] or by_id[pose["jobId"]]["updatedAt"] > hero_done
    assert [kind for _, kind, _ in world["log"]] == ["mesh3d", "render3d", "rig"] or \
        [kind for _, kind, _ in world["log"]] == ["mesh3d", "rig", "render3d"]  # after the A-pose, in order
    assert settled < 15 * 60  # everything in ~7 min of box time, no follow-up turn


# ── 15: a busy box is retried, the chain waits ─────────────────────────────────


def _hero_with_image(w):
    ctx, sid = w["ctx"], w["sid"]
    image = store.put_asset(ctx, sid, {"kind": "image", "key": f"sessions/{sid}/boss.png", "contentType": "image/png",
                                       "ipId": "ip_boss", "meta": {"model": "krea", "prompt": "a boss"}})
    cut = store.put_asset(ctx, sid, {"kind": "cutout", "key": f"sessions/{sid}/boss-cut.png", "contentType": "image/png",
                                     "ipId": "ip_boss", "meta": {"forAssetId": image["assetId"]}})
    return store.put_ip(ctx, sid, {"ipId": "ip_boss", "kind": "enemy", "humanoid": True, "name": "거대 보스 괴물",
                                   "version": 1, "imageAssetId": image["assetId"], "cutoutAssetId": cut["assetId"]})


def test_defect15_a_busy_apose_is_retried_and_its_mesh_render_rig_chain_waits(world):
    _hero_with_image(world)
    _backlog(world["box"], 5)  # ~11 min ahead: the proxy gives up on the A-pose after 10
    out = tools.run_tool(world["ctx"], world["session"], "render_3d", {"ipId": "ip_boss"})
    chain = [out["meshJobId"], out["jobId"], out["rigJobId"]]
    seen = []
    while world["clock"].now() < 1000 + 3600:
        jobs.advance_jobs(world["ctx"], world["sid"])
        pose = _job(world, out["poseJobId"])
        seen.append((pose["status"], pose.get("autoRetries") or 0, tuple(_job(world, j)["status"] for j in chain)))
        if pose["status"] == "done" and all(_job(world, j)["status"] == "done" for j in chain):
            break
        world["clock"].sleep(3)
    retried = [s for s in seen if s[1] == 1 and s[0] == "queued"]
    assert retried and all(statuses == ("queued",) * 3 for _, _, statuses in retried)  # the chain waited, no 선행 작업 실패
    assert _job(world, out["poseJobId"])["autoRetries"] == 1 and len(world["box"].starts) == 2
    assert all(_job(world, j)["status"] == "done" for j in chain)


def test_busy_or_flaky_image_jobs_retry_with_backoff_and_give_up_after_three_tries(world):
    _concept(world)
    world["box"].busy_sec = -1  # every job is refused at once, as if the box stayed busy
    world["box"].fail_next = ["MCP HTTP 502: Bad Gateway"]  # and the first submit blips
    out = _create(world)
    tries, waits = [], []
    for _ in range(200):
        jobs.advance_jobs(world["ctx"], world["sid"])
        job = _job(world, out["jobId"])
        if job.get("retryAt") and (not waits or waits[-1][0] != job["retryAt"]):
            waits.append((job["retryAt"], job["progress"]))
        if job["status"] == "failed":
            break
        world["clock"].sleep(3)
    job = _job(world, out["jobId"])
    assert (job["status"], job["autoRetries"]) == ("failed", 2) and BUSY_TEXT in job["error"]
    assert len(world["box"].starts) == 2  # the 502 never reached the box; then 2 busy refusals... and no more
    assert [p for _, p in waits] == ["이미지 GPU가 바빠 30초 뒤 다시 시도 (1/2)", "이미지 GPU가 바빠 60초 뒤 다시 시도 (2/2)"]
    assert tools.image_state(_ip(world, out["ipId"]), {job["jobId"]: job}) == "failed"

    world["box"].busy_sec = 600  # the box is free again: 다시 시도 runs it with fresh retries
    assert jobs.retry_job(world["ctx"], world["sid"], out["jobId"]) == [out["jobId"]]
    _poll(world)
    assert _ip(world, out["ipId"])["imageAssetId"] and _job(world, out["jobId"])["autoRetries"] == 0


# ── a bad composition is drawn once more ────────────────────────────────


@pytest.mark.parametrize("bad,problem", [(TWO, "피사체 2개"), (HIPS, "아래쪽이 프레임에 잘림")])
def test_defects6_13_a_two_figure_or_cut_off_draw_is_redrawn_once_with_a_new_seed(world, bad, problem):
    _concept(world)
    world["cutouts"][b"\x89PNG-g1"] = bad  # the first draw: two Vipers / a king cut at the hips
    out = _create(world, "바이퍼")
    redraws = []
    for _ in range(100):
        jobs.advance_jobs(world["ctx"], world["sid"])
        job = _job(world, out["jobId"])
        if job["progress"].startswith("구도를 다시 그리는 중"):
            redraws.append(job["progress"])
        if job["status"] == "done":
            break
        world["clock"].sleep(3)
    first, second = world["box"].starts
    assert first["seed"] != second["seed"]  # and another framing (test_reverify_gen.py)
    assert second["prompt"] == f"{first['prompt']}. {mi.REFRAME['figure']}"
    assert redraws[0] == f"구도를 다시 그리는 중: {problem}"
    ip = _ip(world, out["ipId"])
    image = next(a for a in _snap(world)["assets"] if a["assetId"] == ip["imageAssetId"])
    assert world["ctx"].s3._store[("test-assets", image["key"])] == b"\x89PNG-g2"  # the redraw is the IP's picture
    assert image["meta"]["check"] == {"ok": True, "subjects": 1, "cut": [], "problem": "", "redraws": 1}
    assert len([a for a in _snap(world)["assets"] if a["kind"] == "image"]) == 1  # the bad draw is not a version


def test_a_second_bad_draw_is_kept_with_its_check_recorded(world):
    _concept(world)
    world["cutouts"].update({b"\x89PNG-g1": TWO, b"\x89PNG-g2": TWO})
    out = _create(world, "기사")
    _poll(world)
    assert len(world["box"].starts) == 2  # one redraw only
    image = next(a for a in _snap(world)["assets"] if a["assetId"] == _ip(world, out["ipId"])["imageAssetId"])
    assert image["meta"]["check"] == {"ok": False, "subjects": 2, "cut": [], "problem": "피사체 2개", "redraws": 1}


# ── the paid finish runs once, after the claim; a finished result is never drawn again ──


def _remove_bg(world, monkeypatch, *codes):
    """Background removal for image jobs that raises these Bedrock error codes first (one per call), then cuts GOOD.
    → the fake-clock time of every call."""
    calls, codes = [], list(codes)

    def remove_background(ctx, image):
        calls.append(world["clock"].now())
        if codes:
            raise ClientError({"Error": {"Code": codes.pop(0), "Message": "refused"}}, "InvokeModel")
        return GOOD
    monkeypatch.setattr(mi, "remove_background", remove_background)
    return calls


def test_a_fixed_background_removal_refusal_keeps_the_picture_uncut_after_one_call(world, monkeypatch):
    """A picture remove-bg refuses (ValidationException, moderation) is kept uncut after one call, not paid for again
    on every poll."""
    _concept(world)
    calls = _remove_bg(world, monkeypatch, *["ValidationException"] * 400)
    out = _create(world)

    took = _poll(world)

    ip, s3 = _ip(world, out["ipId"]), world["ctx"].s3._store
    assets = {a["assetId"]: a for a in _snap(world)["assets"]}
    image, cut = assets[ip["imageAssetId"]], assets[ip["cutoutAssetId"]]
    assert (len(calls), _job(world, out["jobId"])["status"]) == (1, "done") and took < 200
    assert s3[("test-assets", cut["key"])] == s3[("test-assets", image["key"])]  # the whole picture, background kept
    assert "check" not in image["meta"] and len(world["box"].starts) == 1  # nothing to judge: no redraw


@pytest.mark.parametrize("throttles,status,calls_made", [(1, "done", 2), (3, "done", 4), (400, "failed", 5)])
def test_a_throttled_background_removal_backs_off_and_is_bounded(world, monkeypatch, throttles, status, calls_made):
    """A throttled remove-bg backs off between tries and is bounded: 5 tries over ~7.5 min outlast a short outage."""
    _concept(world)
    calls = _remove_bg(world, monkeypatch, *["ThrottlingException"] * throttles)
    out = _create(world)

    _poll(world)

    job = _job(world, out["jobId"])
    assert (job["status"], len(calls)) == (status, calls_made)
    assert [b - a >= wait for a, b, wait in zip(calls, calls[1:], (30, 60, 120, 240))] == [True] * (calls_made - 1)
    assert len(world["box"].starts) == 1  # the same GPU picture every time, never a new draw
    if status == "done":  # the throttle passed: a real cutout and its composition check
        image = next(a for a in _snap(world)["assets"] if a["assetId"] == _ip(world, out["ipId"])["imageAssetId"])
        assert image["meta"]["check"]["ok"] is True
    else:  # in Korean, not boto3's text
        assert job["error"] == f"결과 저장을 반복 실패했습니다: {mi.REMOVER_DOWN}"


def test_overlapping_polls_pay_for_one_background_removal_per_image(world, monkeypatch):
    """Two polls that load the finished job before either claims it run remove-bg once between them."""
    _concept(world)
    out = _create(world)
    jobs.advance_jobs(world["ctx"], world["sid"])  # submitted; the box draws it in ~135 s
    world["clock"].sleep(300)
    stale = store.snapshot(world["ctx"], world["sid"])  # what the overlapping poll B loaded
    calls, real_snapshot = [], store.snapshot

    def remove_background(ctx, image):  # inside poll A's background removal, poll B runs from its old load
        calls.append(image)
        if len(calls) == 1:
            monkeypatch.setattr(store, "snapshot", lambda c, s: copy.deepcopy(stale))
            jobs.advance_jobs(world["ctx"], world["sid"])
            monkeypatch.setattr(store, "snapshot", real_snapshot)
        return GOOD
    monkeypatch.setattr(mi, "remove_background", remove_background)

    jobs.advance_jobs(world["ctx"], world["sid"])  # poll A

    assert len(calls) == 1 and _job(world, out["jobId"])["status"] == "done"
    assert len([a for a in _snap(world)["assets"] if a["kind"] == "image"]) == 1


@pytest.mark.parametrize("blip", ["download timed out", "status 502"])
def test_a_blip_while_saving_a_finished_apose_collects_it_again_instead_of_drawing_a_new_one(world, monkeypatch, blip):
    """An A-pose done and claimed whose download times out once (or get_image_status answers MCP HTTP 502) is
    collected again: the busy/blip retry must not reset the job and draw a different A-pose."""
    _hero_with_image(world)
    out = tools.run_tool(world["ctx"], world["session"], "render_3d", {"ipId": "ip_boss"})
    box, failed = world["box"], []
    if blip == "download timed out":
        def download(url):
            if not failed:
                failed.append(url)
                raise urllib.error.URLError(socket.timeout("timed out"))  # "<urlopen error timed out>"
            return box.download(url)
        monkeypatch.setattr(mcp_client, "download", download)
    else:
        real_status = box._status

        def status(job_id):  # apose.collect asks once more after the claim: that call blips
            st = real_status(job_id)
            if st["status"] == "SUCCEEDED" and len(failed) < 2:
                failed.append(job_id)
                if len(failed) == 2:
                    raise RuntimeError("MCP HTTP 502: Bad Gateway")
            return st
        monkeypatch.setattr(box, "_status", status)

    _poll(world)

    pose = _job(world, out["poseJobId"])
    assert [s["model"] for s in box.starts] == ["klein9"] and failed  # one A-pose draw, and the blip happened
    assert (pose["status"], pose.get("autoRetries") or 0, pose["collectRetries"]) == ("done", 0, 1)
    assert all(_job(world, j)["status"] == "done" for j in (out["meshJobId"], out["jobId"], out["rigJobId"]))


# ── pending images: what waits, what chains ────────────────────────────────────


def test_a_pending_image_makes_make_game_and_shots_answer_images_pending(world):
    from server.tests.test_gamespec import minimal_sf
    _concept(world)
    hero, gun = _create(world, "레이"), _create(world, "블래스터", kind="weapon")
    spec = minimal_sf()
    spec["player"].update(ipId=hero["ipId"], weaponIpId=gun["ipId"])
    ctx, session = world["ctx"], world["session"]

    game = tools.run_tool(ctx, session, "make_game", {"spec": spec, "engine": "phaser"})
    assert game["error"] == "images_pending"
    assert "레이, 블래스터" in game["message"] and "이미지 2장" in game["message"] and "분" in game["message"]
    shot = tools.run_tool(ctx, session, "make_video_shot", {"ipId": hero["ipId"], "prompt": "orbit", "aspect_ratio": "16:9"})
    action = tools.run_tool(ctx, session, "make_action_shot", {"ipId": hero["ipId"], "action": "runs"})
    assert shot["error"] == action["error"] == "images_pending"
    assert _snap(world)["games"] == [] and [j["kind"] for j in _snap(world)["jobs"]] == ["image", "image"]

    _poll(world)

    assert "gameId" in tools.run_tool(ctx, session, "make_game", {"spec": spec, "engine": "phaser"})
    assert "jobId" in tools.run_tool(ctx, session, "make_video_shot", {"ipId": hero["ipId"], "prompt": "orbit",
                                                                        "aspect_ratio": "16:9"})


def test_a_failed_image_is_reported_and_3d_refuses_it(world):
    _concept(world)
    out = _create(world, "드론", kind="enemy", humanoid=False)
    store.update_job(world["ctx"], world["sid"], out["jobId"], status="failed", error=BUSY_TEXT)
    assert tools.run_tool(world["ctx"], world["session"], "render_3d", {"ipId": out["ipId"]})["error"] == "image_failed"
    assert tools.run_tool(world["ctx"], world["session"], "make_video_shot",
                          {"ipId": out["ipId"], "prompt": "x", "aspect_ratio": "16:9"})["error"] == "image_failed"
    reroll = tools.run_tool(world["ctx"], world["session"], "reroll_ip_image", {"ipId": out["ipId"]})
    assert reroll["error"] == "image_failed" and "다시 시도" in reroll["message"]
    assert '"image": "failed"' in agent.state_summary(_snap(world))


def test_3d_and_variants_registered_on_a_pending_image_chain_on_its_job(world):
    _concept(world)
    sid = world["sid"]
    hero, crate = _create(world, "레이"), _create(world, "화물 상자", kind="prop")
    ctx, session = world["ctx"], world["session"]
    hero3d = tools.run_tool(ctx, session, "render_3d", {"ipId": hero["ipId"]})
    crate3d = tools.run_tool(ctx, session, "render_3d", {"ipId": crate["ipId"]})
    relief = tools.run_tool(ctx, session, "render_3d", {"ipId": crate["ipId"], "model": "relief"})
    variant = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": hero["ipId"], "prompt": "red jacket"})
    pose = _job(world, hero3d["poseJobId"])
    assert (pose["deps"], pose["input"]["imageKey"]) == ([hero["jobId"]], mi.image_key(sid, hero["jobId"]))
    mesh = _job(world, crate3d["meshJobId"])
    assert (mesh["deps"], mesh["input"]["cutoutKey"]) == ([crate["jobId"]], mi.cutout_key(sid, crate["jobId"]))
    assert _job(world, relief["jobId"])["deps"] == [crate["jobId"]] and crate3d["imageJobId"] == crate["jobId"]
    assert _job(world, variant["jobId"])["deps"] == [hero["jobId"]] and variant["version"] == 2

    jobs.advance_jobs(ctx, sid)  # the images go out; everything that reads them waits
    assert _job(world, hero3d["poseJobId"])["status"] == "queued" and _job(world, variant["jobId"])["status"] == "queued"
    _poll(world)
    assert all(j["status"] == "done" for j in _snap(world)["jobs"])
    assert _ip(world, hero["ipId"])["version"] == 2


def test_state_summary_tells_the_agent_which_pictures_are_still_coming(world):
    _concept(world)
    out = _create(world, "루나")
    ip_of = lambda s: next(i for i in agent.json.loads(agent.state_summary(s))["ips"] if i["ipId"] == out["ipId"])  # noqa: E731
    assert ip_of(_snap(world))["image"] == "pending"
    _poll(world)
    assert "image" not in ip_of(_snap(world))
    tools.run_tool(world["ctx"], world["session"], "make_ip_variant", {"ipId": out["ipId"], "prompt": "a hat"})
    assert ip_of(_snap(world))["image"] == "updating"


def test_existing_ips_with_pictures_and_old_jobs_keep_working(world):
    ip = _hero_with_image(world)  # made before image jobs: imageAssetId, no imageJobId
    ctx, session, sid = world["ctx"], world["session"], world["sid"]
    assert tools.image_state(ip, {}) is None
    out = tools.run_tool(ctx, session, "render_3d", {"ipId": "ip_boss"})
    assert _job(world, out["poseJobId"])["deps"] == [] and "imageJobId" not in out
    assert "jobId" in tools.run_tool(ctx, session, "make_video_shot", {"ipId": "ip_boss", "prompt": "x", "aspect_ratio": "16:9"})
    variant = _job(world, tools.run_tool(ctx, session, "make_ip_variant", {"ipId": "ip_boss", "prompt": "a scar"})["jobId"])
    assert (variant["deps"], variant["input"]["references"]) == ([], [f"sessions/{sid}/boss.png"])
    old = jobs.create_job(ctx, sid, "mesh3d", "img3d", {"ipId": "ip_boss", "cutoutKey": "k.png"}, [])  # no new fields
    store.update_job(ctx, sid, old["jobId"], status="running", externalId="ext-old", rev=1)
    jobs.advance_jobs(ctx, sid)
    assert _job(world, old["jobId"])["status"] == "done"


def test_the_prompt_drops_the_per_turn_image_cap_and_says_what_to_do_while_images_are_pending():
    from server import prompts
    for gone in ("2–3번까지", "image_timeout", "turn_budget", "다음 턴에 이어서 만들고"):
        assert gone not in prompts.SYSTEM
    assert "개수와 관계없이 같은 턴에 모두 등록" in prompts.SYSTEM and "images_pending" in prompts.SYSTEM
    described = " ".join(s["description"] for s in tools.TOOL_SPECS if s["name"] in
                         ("create_ip_asset", "make_ip_variant", "make_action_shot"))
    assert "동기" not in described and described.count("바로 돌아온다") == 3
