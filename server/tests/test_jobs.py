import copy
import json
import re

import pytest

from server import jobs, store
from server.tests.conftest import FakeLambda, FakeProvider, FakeTable, _client_error, make_ctx

SID = "ses_test"


@pytest.fixture
def ctx(monkeypatch):
    monkeypatch.setenv("SELF_FUNCTION_NAME", "ipverse-api")
    return make_ctx(table=FakeTable(), lambda_=FakeLambda())


def _job(ctx, job_id):
    return next(j for j in store.snapshot(ctx, SID)["jobs"] if j["jobId"] == job_id)


def _asset(kind, key):
    return {"kind": kind, "key": key, "contentType": "video/mp4", "meta": {}}


def _run_job_calls(ctx):
    return [json.loads(c["Payload"]) for c in ctx.lambda_.calls]


def test_create_job_queued_then_submit_on_advance(ctx, monkeypatch):
    deadline = FakeProvider("deadline", states=[("running", "RUNNING · 1분 2초")])
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", deadline)

    job = jobs.create_job(ctx, SID, "render3d", "deadline", {"ipId": "ip_1", "cutoutKey": "c.png"}, [])
    assert re.fullmatch(r"job_[0-9a-f]{10}", job["jobId"])
    assert _job(ctx, job["jobId"])["status"] == "queued"

    jobs.advance_jobs(ctx, SID)
    stored = _job(ctx, job["jobId"])
    assert [j["jobId"] for j in deadline.submitted] == [job["jobId"]]
    assert deadline.submitted[0]["pk"] == f"SESSION#{SID}"  # providers derive the session from pk
    assert stored["status"] == "running"
    assert stored["externalId"] == f"ext-{job['jobId']}"
    assert stored["progress"] == "RUNNING · 1분 2초"

    jobs.advance_jobs(ctx, SID)  # running: polls status, never resubmits
    assert len(deadline.submitted) == 1


def test_external_id_is_saved_before_the_first_status_call(ctx, monkeypatch):
    class StatusDown(FakeProvider):
        def status(self, job, ctx):
            raise RuntimeError("ThrottlingException on GetJob")

    monkeypatch.setitem(jobs.PROVIDERS, "deadline", StatusDown("deadline"))
    job = jobs.create_job(ctx, SID, "render3d", "deadline", {"ipId": "ip_1"}, [])

    jobs.advance_jobs(ctx, SID)

    stored = _job(ctx, job["jobId"])
    assert stored["externalId"] == f"ext-{job['jobId']}"  # the running Deadline render stays findable
    assert (stored["status"], stored["progress"]) == ("running", jobs.STATUS_RETRY)


class _FlakyStatus(FakeProvider):
    """status() raises `fail` times, then follows `states`."""

    def __init__(self, *args, fail=1, **kwargs):
        super().__init__(*args, **kwargs)
        self.fail = fail

    def status(self, job, ctx):
        if self.fail:
            self.fail -= 1
            raise RuntimeError("ThrottlingException on GetJob")
        return super().status(job, ctx)


def test_transient_status_error_is_retried_and_job_finishes(ctx, monkeypatch):
    flaky = _FlakyStatus("deadline", states=[("done", "")], assets=[_asset("turntable", "sessions/x/tt.mp4")])
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", flaky)
    render = _running_render(ctx)

    jobs.advance_jobs(ctx, SID)  # status() blips
    retrying = _job(ctx, render["jobId"])
    assert (retrying["status"], retrying["progress"]) == ("running", jobs.STATUS_RETRY)
    assert retrying["statusErrorSince"]
    rev = retrying["rev"]

    flaky.fail = 1
    jobs.advance_jobs(ctx, SID)  # another blip: no rev churn
    assert _job(ctx, render["jobId"])["rev"] == rev

    jobs.advance_jobs(ctx, SID)  # status() recovers
    done = _job(ctx, render["jobId"])
    assert done["status"] == "done" and len(done["outputs"]) == 1 and not done.get("statusErrorSince")


def test_status_error_fails_job_after_stale_window(ctx, monkeypatch):
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", _FlakyStatus("deadline", fail=99))
    render = _running_render(ctx)
    jobs.advance_jobs(ctx, SID)
    assert _job(ctx, render["jobId"])["status"] == "running"
    store.update_job(ctx, SID, render["jobId"], statusErrorSince="2026-01-01T00:00:00.000Z")  # failing since long ago

    jobs.advance_jobs(ctx, SID)

    failed = _job(ctx, render["jobId"])
    assert failed["status"] == "failed"
    assert failed["error"] == "상태 확인을 반복 실패했습니다: ThrottlingException on GetJob"


def test_collect_error_still_fails_job(ctx, monkeypatch):
    class CollectDown(FakeProvider):
        def collect(self, job, ctx):
            raise RuntimeError("AccessDenied on GetObject")

    monkeypatch.setitem(jobs.PROVIDERS, "deadline", CollectDown("deadline", states=[("done", "")]))
    render = _running_render(ctx)

    jobs.advance_jobs(ctx, SID)

    failed = _job(ctx, render["jobId"])
    assert failed["status"] == "failed" and "AccessDenied on GetObject" in failed["error"]


def test_trailer_waits_for_deps(ctx, monkeypatch):
    store.put_ip(ctx, SID, {"ipId": "ip_1", "name": "루나"})
    video = FakeProvider("bedrock_video", states=[("running", "InProgress")])
    deadline = FakeProvider("deadline", states=[("running", "STARTING · 12분 0초")])
    ffmpeg = FakeProvider("ffmpeg", states=[("done", "")], sync=True,
                          assets=[_asset("trailer", "sessions/x/trailer.mp4")])
    for fake in (video, deadline, ffmpeg):
        monkeypatch.setitem(jobs.PROVIDERS, fake.name, fake)

    shot = jobs.create_job(ctx, SID, "shot", "bedrock_video", {"ipId": "ip_1"}, [])
    render = jobs.create_job(ctx, SID, "render3d", "deadline", {"ipId": "ip_1"}, [])
    trailer = jobs.create_job(
        ctx, SID, "trailer", "ffmpeg",
        {"shot_job_ids": [shot["jobId"]], "include_turntable_ip_id": "ip_1"},
        [shot["jobId"], render["jobId"]],
    )

    jobs.advance_jobs(ctx, SID)
    assert _job(ctx, trailer["jobId"])["status"] == "queued" and ctx.lambda_.calls == []

    video.states, video.assets = [("done", "")], [_asset("shot", "sessions/x/shot.mp4")]
    jobs.advance_jobs(ctx, SID)  # shot done, Deadline still cold-starting
    assert _job(ctx, shot["jobId"])["status"] == "done"
    assert _job(ctx, trailer["jobId"])["status"] == "queued" and ctx.lambda_.calls == []

    deadline.states, deadline.assets = [("done", "")], [_asset("turntable", "sessions/x/tt.mp4")]
    jobs.advance_jobs(ctx, SID)  # render done → trailer claimed and handed to a run_job invocation
    dispatched = _job(ctx, trailer["jobId"])
    assert dispatched["status"] == "running" and not dispatched.get("externalId")
    assert _run_job_calls(ctx) == [{"action": "run_job", "sessionId": SID, "jobId": trailer["jobId"]}]
    assert ffmpeg.submitted == []  # never rendered inside the poll

    jobs.run_job(ctx, SID, trailer["jobId"])  # the async invocation
    [submitted] = ffmpeg.submitted
    assert submitted["input"]["extra_asset_ids"] == [store.get_ip(ctx, SID, "ip_1")["turntableAssetId"]]
    done = _job(ctx, trailer["jobId"])
    assert done["status"] == "done" and len(done["outputs"]) == 1  # collect saw submit's in-memory result


def test_run_job_dispatch_happens_once_and_run_job_is_idempotent(ctx, monkeypatch):
    ffmpeg = FakeProvider("ffmpeg", sync=True, assets=[_asset("trailer", "sessions/x/t.mp4")])
    monkeypatch.setitem(jobs.PROVIDERS, "ffmpeg", ffmpeg)
    trailer = jobs.create_job(ctx, SID, "trailer", "ffmpeg", {"shot_job_ids": []}, [])

    jobs.advance_jobs(ctx, SID)
    jobs.advance_jobs(ctx, SID)  # claimed and in flight: not dispatched again, never polled
    assert len(ctx.lambda_.calls) == 1 and ffmpeg.submitted == []

    jobs.run_job(ctx, SID, trailer["jobId"])
    jobs.run_job(ctx, SID, trailer["jobId"])  # duplicate async delivery: no-op
    jobs.advance_jobs(ctx, SID)
    assert len(ffmpeg.submitted) == 1 and len(store.snapshot(ctx, SID)["assets"]) == 1
    assert _job(ctx, trailer["jobId"])["status"] == "done"


def test_advance_marks_failed_dependency(ctx, monkeypatch):
    video = FakeProvider("bedrock_video", states=[("failed", "Luma: content filtered")])
    ffmpeg = FakeProvider("ffmpeg", sync=True)
    monkeypatch.setitem(jobs.PROVIDERS, "bedrock_video", video)
    monkeypatch.setitem(jobs.PROVIDERS, "ffmpeg", ffmpeg)
    shot = jobs.create_job(ctx, SID, "shot", "bedrock_video", {"ipId": "ip_1"}, [])
    trailer = jobs.create_job(ctx, SID, "trailer", "ffmpeg", {"shot_job_ids": [shot["jobId"]]}, [shot["jobId"]])
    # createdAt can tie (same ms, clock skew): the order must come from deps, not timestamps
    store.update_job(ctx, SID, trailer["jobId"], createdAt="2000-01-01T00:00:00.000Z")

    jobs.advance_jobs(ctx, SID)  # one pass: shot fails, then its dependent

    failed_shot, failed_trailer = _job(ctx, shot["jobId"]), _job(ctx, trailer["jobId"])
    assert (failed_shot["status"], failed_shot["error"]) == ("failed", "Luma: content filtered")
    assert (failed_trailer["status"], failed_trailer["error"]) == ("failed", "성공한 영상 샷이 없습니다")
    assert ffmpeg.submitted == [] and ctx.lambda_.calls == []


def test_trailer_never_runs_without_turntable(ctx, monkeypatch):
    store.put_ip(ctx, SID, {"ipId": "ip_1", "name": "루나"})
    deadline = FakeProvider("deadline", states=[("done", "")], assets=[])  # render produced no turntable
    ffmpeg = FakeProvider("ffmpeg", sync=True)
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", deadline)
    monkeypatch.setitem(jobs.PROVIDERS, "ffmpeg", ffmpeg)
    render = jobs.create_job(ctx, SID, "render3d", "deadline", {"ipId": "ip_1"}, [])
    trailer = jobs.create_job(ctx, SID, "trailer", "ffmpeg", {"shot_job_ids": [], "include_turntable_ip_id": "ip_1"},
                              [render["jobId"]])

    jobs.advance_jobs(ctx, SID)
    jobs.run_job(ctx, SID, trailer["jobId"])

    failed = _job(ctx, trailer["jobId"])
    assert failed["status"] == "failed" and "3D 회전 영상이 없습니다" in failed["error"]
    assert ffmpeg.submitted == []


def test_provider_exception_fails_job_with_error_text(ctx, monkeypatch):
    boom = FakeProvider("deadline", errors=[RuntimeError("AccessDeniedException: deadline:CreateJob")])
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", boom)
    job = jobs.create_job(ctx, SID, "render3d", "deadline", {"ipId": "ip_1"}, [])

    jobs.advance_jobs(ctx, SID)

    failed = _job(ctx, job["jobId"])
    assert failed["status"] == "failed"
    assert "AccessDeniedException: deadline:CreateJob" in failed["error"]


def test_collect_links_ip_fields(ctx, monkeypatch):
    store.put_ip(ctx, SID, {"ipId": "ip_1", "name": "루나", "version": 1})
    deadline = FakeProvider("deadline", states=[("done", "")], assets=[
        {"kind": "turntable", "key": f"sessions/{SID}/u1.mp4", "contentType": "video/mp4", "meta": {}},
        {"kind": "glb", "key": f"sessions/{SID}/u2.glb", "contentType": "model/gltf-binary", "meta": {}},
        {"kind": "poster", "key": f"sessions/{SID}/u3.png", "contentType": "image/png", "meta": {}},
    ])
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", deadline)
    job = jobs.create_job(ctx, SID, "render3d", "deadline", {"ipId": "ip_1", "cutoutKey": "c.png"}, [])

    jobs.advance_jobs(ctx, SID)

    snap = store.snapshot(ctx, SID)
    [done] = snap["jobs"]
    by_kind = {a["kind"]: a for a in snap["assets"]}
    assert done["status"] == "done"
    assert done["outputs"] == [by_kind[k]["assetId"] for k in ("turntable", "glb", "poster")]
    for asset in by_kind.values():
        assert asset["assetId"].startswith("ast_")
        assert (asset["jobId"], asset["ipId"]) == (job["jobId"], "ip_1")
        assert asset["url"] == f"https://cdn.example.com/{asset['key']}"
    [ip] = snap["ips"]
    assert ip["turntableAssetId"] == by_kind["turntable"]["assetId"]
    assert ip["glbAssetId"] == by_kind["glb"]["assetId"]
    assert ip["posterAssetId"] == by_kind["poster"]["assetId"]


def _running_render(ctx):
    render = jobs.create_job(ctx, SID, "render3d", "deadline", {"ipId": "ip_1"}, [])
    store.update_job(ctx, SID, render["jobId"], status="running", externalId="ext-1", rev=1)
    return render


def test_stale_poller_cannot_reopen_a_job_being_collected(ctx, monkeypatch):
    """B is collecting J when A, which loaded J before B's claim, writes its stale progress; then C polls.
    A's write must lose, so C sees J as claimed instead of collecting it a second time."""
    real_snapshot = store.snapshot

    class Racing(FakeProvider):
        view, collected = ("done", ""), 0

        def status(self, job, ctx):
            return self.view

        def collect(self, job, ctx):
            self.collected += 1
            if self.collected == 1:  # inside B's collect
                self.view = ("running", "RUNNING · 9분")
                monkeypatch.setattr(store, "snapshot", lambda c, s: copy.deepcopy(stale))
                jobs.advance_jobs(ctx, SID)  # poller A, from its stale load
                monkeypatch.setattr(store, "snapshot", real_snapshot)
                self.view = ("done", "")
                jobs.advance_jobs(ctx, SID)  # poller C
            return [_asset("turntable", "sessions/x/tt.mp4")]

    racing = Racing("deadline")
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", racing)
    render = _running_render(ctx)
    stale = real_snapshot(ctx, SID)  # what A loaded

    jobs.advance_jobs(ctx, SID)  # poller B

    done = _job(ctx, render["jobId"])
    assert racing.collected == 1 and len(store.snapshot(ctx, SID)["assets"]) == 1
    assert done["status"] == "done" and done["externalId"] == "ext-1" and len(done["outputs"]) == 1


def test_stale_poller_error_cannot_flip_done(ctx, monkeypatch):
    """A loads J, B finishes J (and starts its dependent), then A's status() raises: J stays done."""
    class Racing(FakeProvider):
        depth = 0

        def status(self, job, ctx):
            self.depth += 1
            try:
                if self.depth == 1:
                    jobs.advance_jobs(ctx, SID)  # poller B, start to finish
                    raise RuntimeError("ThrottlingException on GetJob")
                return ("done", "")
            finally:
                self.depth -= 1

    monkeypatch.setitem(jobs.PROVIDERS, "deadline", Racing("deadline", assets=[_asset("turntable", "k.mp4")]))
    monkeypatch.setitem(jobs.PROVIDERS, "bedrock_video", FakeProvider("bedrock_video"))
    render = _running_render(ctx)
    dependent = jobs.create_job(ctx, SID, "shot", "bedrock_video", {"ipId": "ip_1"}, [render["jobId"]])

    jobs.advance_jobs(ctx, SID)  # poller A

    assert _job(ctx, render["jobId"])["status"] == "done"
    assert _job(ctx, dependent["jobId"])["status"] == "running"  # B started it; A did not fail it


def test_claimed_job_is_left_alone_until_stale(ctx, monkeypatch):
    deadline = FakeProvider("deadline", states=[("done", "")])
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", deadline)
    job = jobs.create_job(ctx, SID, "render3d", "deadline", {"ipId": "ip_1"}, [])
    # Another poll claimed it (running, externalId not written yet): the claim is exclusive ...
    claim = {"rev": 1, "status": "running", "updatedAt": store.now()}
    assert store.update_job(ctx, SID, job["jobId"], expect={"rev": 0}, **claim)
    assert not store.update_job(ctx, SID, job["jobId"], expect={"rev": 0}, **claim)

    jobs.advance_jobs(ctx, SID)  # ... and this poll neither resubmits nor polls it
    assert _job(ctx, job["jobId"])["status"] == "running" and deadline.submitted == []

    store.update_job(ctx, SID, job["jobId"], updatedAt="2026-01-01T00:00:00.000Z")  # the claimer died
    jobs.advance_jobs(ctx, SID)
    stale = _job(ctx, job["jobId"])
    assert stale["status"] == "failed" and stale["error"]


def _throttle():
    return _client_error("ThrottlingException", "StartAsyncInvoke")


def _created_later(ctx, job):
    """Jobs made in the same millisecond tie on createdAt; pin the FIFO order these tests rely on."""
    store.update_job(ctx, SID, job["jobId"], createdAt="2999-01-01T00:00:00.000Z")
    return job


def test_throttled_submit_stays_queued_and_is_retried(ctx, monkeypatch):
    video = FakeProvider("bedrock_video", errors=[_throttle()])
    monkeypatch.setitem(jobs.PROVIDERS, "bedrock_video", video)
    shot = jobs.create_job(ctx, SID, "shot", "bedrock_video", {"ipId": "ip_1"}, [])
    other = _created_later(ctx, jobs.create_job(ctx, SID, "shot", "bedrock_video", {"ipId": "ip_1"}, []))
    trailer = jobs.create_job(ctx, SID, "trailer", "ffmpeg", {"shot_job_ids": [shot["jobId"]]}, [shot["jobId"]])

    jobs.advance_jobs(ctx, SID)  # Luma's async slot is taken: StartAsyncInvoke throttled

    waiting = _job(ctx, shot["jobId"])
    assert (waiting["status"], waiting["progress"]) == ("queued", "요청 한도 대기 중") and waiting["throttledAt"]
    assert video.attempts == 1  # one video submit per pass: `other` was not tried behind the throttle
    assert _job(ctx, trailer["jobId"])["status"] == "queued"  # the dependent waits, it does not fail

    jobs.advance_jobs(ctx, SID)  # next poll: retried and submitted
    assert _job(ctx, shot["jobId"])["status"] == "running" and [j["jobId"] for j in video.submitted] == [shot["jobId"]]
    assert _job(ctx, other["jobId"])["status"] == "queued"


def test_throttled_submit_gives_up_after_15_minutes(ctx, monkeypatch):
    monkeypatch.setitem(jobs.PROVIDERS, "bedrock_video", FakeProvider("bedrock_video", errors=[_throttle()] * 2))
    shot = jobs.create_job(ctx, SID, "shot", "bedrock_video", {"ipId": "ip_1"}, [])
    jobs.advance_jobs(ctx, SID)
    assert _job(ctx, shot["jobId"])["status"] == "queued"
    store.update_job(ctx, SID, shot["jobId"], throttledAt="2026-01-01T00:00:00.000Z")  # throttled since long ago

    jobs.advance_jobs(ctx, SID)

    failed = _job(ctx, shot["jobId"])
    assert (failed["status"], failed["error"]) == ("failed", "요청 한도로 제출을 반복 실패했습니다")


def test_video_submissions_are_serialized_per_session(ctx, monkeypatch):
    video = FakeProvider("bedrock_video", states=[("running", "InProgress")])
    monkeypatch.setitem(jobs.PROVIDERS, "bedrock_video", video)
    first = jobs.create_job(ctx, SID, "shot", "bedrock_video", {"ipId": "ip_1"}, [])
    second = _created_later(ctx, jobs.create_job(ctx, SID, "shot", "bedrock_video", {"ipId": "ip_1"}, []))

    jobs.advance_jobs(ctx, SID)
    jobs.advance_jobs(ctx, SID)  # the first is still rendering

    assert [j["jobId"] for j in video.submitted] == [first["jobId"]]
    assert _job(ctx, second["jobId"])["status"] == "queued"

    video.states, video.assets = [("done", ""), ("running", "InProgress")], [_asset("shot", "sessions/x/a.mp4")]
    jobs.advance_jobs(ctx, SID)  # the first finishes; the second goes out in the same pass

    assert _job(ctx, first["jobId"])["status"] == "done"
    assert [j["jobId"] for j in video.submitted] == [first["jobId"], second["jobId"]]
    assert _job(ctx, second["jobId"])["status"] == "running"


def test_run_job_requeues_when_a_dependency_is_not_done(ctx, monkeypatch):
    ffmpeg = FakeProvider("ffmpeg", sync=True)
    monkeypatch.setitem(jobs.PROVIDERS, "ffmpeg", ffmpeg)
    monkeypatch.setitem(jobs.PROVIDERS, "bedrock_video", FakeProvider("bedrock_video", states=[("done", "")]))
    shot = jobs.create_job(ctx, SID, "shot", "bedrock_video", {"ipId": "ip_1"}, [])
    trailer = jobs.create_job(ctx, SID, "trailer", "ffmpeg", {"shot_job_ids": [shot["jobId"]]}, [shot["jobId"]])
    jobs.advance_jobs(ctx, SID)  # shot done, trailer claimed and dispatched
    assert _job(ctx, trailer["jobId"])["status"] == "running"
    store.update_job(ctx, SID, shot["jobId"], status="queued")  # the dependency went back to queued

    jobs.run_job(ctx, SID, trailer["jobId"])

    requeued = _job(ctx, trailer["jobId"])
    assert (requeued["status"], requeued["progress"]) == ("queued", "선행 작업 대기 중")
    assert ffmpeg.submitted == []


MODERATION = {"status": "Failed", "failureMessage": "image moderation failed"}


def test_moderation_failure_resubmits_once_as_text_to_video(monkeypatch):
    from server.providers.bedrock_video import BedrockVideoProvider
    from server.tests.conftest import FakeBedrockRT, FakeS3
    monkeypatch.setenv("SELF_FUNCTION_NAME", "ipverse-api")
    west = FakeBedrockRT(responses=[MODERATION, MODERATION])
    ctx = make_ctx(table=FakeTable(), lambda_=FakeLambda(), s3=FakeS3(), bedrock_rt_west=west)
    monkeypatch.setitem(jobs.PROVIDERS, "bedrock_video", BedrockVideoProvider())
    store.put_ip(ctx, SID, {"ipId": "ip_1", "name": "엘라", "description": "an elf archer in a green cloak"})
    shot = jobs.create_job(ctx, SID, "shot", "bedrock_video", {
        "ipId": "ip_1", "imageKey": "sessions/x/ip.jpg", "prompt": "slow dolly in", "aspect_ratio": "16:9",
        "duration": "5s"}, [])

    jobs.advance_jobs(ctx, SID)  # submit with the keyframe, status: moderation failed → text resubmit

    first, retry = [c["modelInput"] for c in west.calls]
    assert "keyframes" in first and "keyframes" not in retry
    assert retry["prompt"] == "slow dolly in, an elf archer in a green cloak"
    resubmitted = _job(ctx, shot["jobId"])
    assert (resubmitted["status"], resubmitted["progress"]) == ("running", jobs.TEXT_FALLBACK)
    assert resubmitted["input"]["fallback"] == "text" and resubmitted["externalId"]

    jobs.advance_jobs(ctx, SID)  # the text-to-video attempt is moderated too: no second fallback

    failed = _job(ctx, shot["jobId"])
    assert (failed["status"], failed["error"]) == ("failed", "image moderation failed")
    assert len(west.calls) == 2


def _finished_shot(ctx, status):
    shot = jobs.create_job(ctx, SID, "shot", "bedrock_video", {"ipId": "ip_1"}, [])
    outputs = [store.put_asset(ctx, SID, _asset("shot", f"sessions/x/{shot['jobId']}.mp4"))["assetId"]] \
        if status == "done" else []
    store.update_job(ctx, SID, shot["jobId"], status=status, outputs=outputs)
    return shot["jobId"]


def test_trailer_cuts_the_done_shots_when_one_shot_failed(ctx, monkeypatch):
    ffmpeg = FakeProvider("ffmpeg", sync=True, assets=[_asset("trailer", "sessions/x/t.mp4")])
    monkeypatch.setitem(jobs.PROVIDERS, "ffmpeg", ffmpeg)
    monkeypatch.setitem(jobs.PROVIDERS, "bedrock_video", FakeProvider("bedrock_video"))
    good, bad, pending = _finished_shot(ctx, "done"), _finished_shot(ctx, "failed"), _finished_shot(ctx, "running")
    store.update_job(ctx, SID, pending, externalId="ext-p")
    trailer = jobs.create_job(ctx, SID, "trailer", "ffmpeg", {"shot_job_ids": [good, bad, pending]},
                              [good, bad, pending])

    jobs.advance_jobs(ctx, SID)  # one shot still rendering: wait, do not fail
    assert _job(ctx, trailer["jobId"])["status"] == "queued" and ctx.lambda_.calls == []

    store.update_job(ctx, SID, pending, status="failed")
    jobs.advance_jobs(ctx, SID)
    dispatched = _job(ctx, trailer["jobId"])
    assert dispatched["status"] == "running" and "실패한 샷 2개 제외" in dispatched["progress"]
    jobs.run_job(ctx, SID, trailer["jobId"])

    [submitted] = ffmpeg.submitted
    assert submitted["input"]["shot_job_ids"] == [good]
    assert _job(ctx, trailer["jobId"])["status"] == "done"


def test_trailer_runs_without_turntable_when_3d_render_failed(ctx, monkeypatch):
    ffmpeg = FakeProvider("ffmpeg", sync=True, assets=[_asset("trailer", "sessions/x/t.mp4")])
    monkeypatch.setitem(jobs.PROVIDERS, "ffmpeg", ffmpeg)
    store.put_ip(ctx, SID, {"ipId": "ip_1", "name": "루나"})
    shot = _finished_shot(ctx, "done")
    render = jobs.create_job(ctx, SID, "render3d", "deadline", {"ipId": "ip_1"}, [])
    store.update_job(ctx, SID, render["jobId"], status="failed", error="Blender crashed")
    trailer = jobs.create_job(ctx, SID, "trailer", "ffmpeg",
                              {"shot_job_ids": [shot], "include_turntable_ip_id": "ip_1"}, [shot, render["jobId"]])

    jobs.advance_jobs(ctx, SID)
    assert "3D 회전 영상이 실패해 빼고 만듦" in _job(ctx, trailer["jobId"])["progress"]
    jobs.run_job(ctx, SID, trailer["jobId"])

    [submitted] = ffmpeg.submitted
    assert "include_turntable_ip_id" not in submitted["input"] and not submitted["input"].get("extra_asset_ids")
    assert submitted["input"]["shot_job_ids"] == [shot]
    assert _job(ctx, trailer["jobId"])["status"] == "done"


def test_old_throttle_does_not_fail_a_later_throttled_fallback_resubmit(monkeypatch):
    from server.providers.bedrock_video import BedrockVideoProvider
    from server.tests.conftest import FakeBedrockRT, FakeS3

    class Throttling(FakeBedrockRT):
        submits = 0

        def start_async_invoke(self, **kwargs):
            self.submits += 1
            if self.submits in (1, 3):  # the first submit and the fallback resubmit
                raise _throttle()
            return super().start_async_invoke(**kwargs)

    monkeypatch.setenv("SELF_FUNCTION_NAME", "ipverse-api")
    ctx = make_ctx(table=FakeTable(), lambda_=FakeLambda(), s3=FakeS3(), bedrock_rt_west=Throttling([MODERATION]))
    monkeypatch.setitem(jobs.PROVIDERS, "bedrock_video", BedrockVideoProvider())
    shot = jobs.create_job(ctx, SID, "shot", "bedrock_video", {"ipId": "ip_1", "imageKey": "k.jpg", "prompt": "p"}, [])
    jobs.advance_jobs(ctx, SID)  # throttled
    store.update_job(ctx, SID, shot["jobId"], throttledAt="2026-01-01T00:00:00.000Z")  # long ago

    jobs.advance_jobs(ctx, SID)  # submitted, moderated, text resubmit throttled

    requeued = _job(ctx, shot["jobId"])
    assert (requeued["status"], requeued["progress"]) == ("queued", "요청 한도 대기 중")
    assert requeued["input"]["fallback"] == "text"
