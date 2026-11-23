from server import jobs, store
from server.tests.conftest import FakeLambda, FakeProvider, FakeTable, make_ctx

SID = "ses_test"


def _status(ctx, job_id):
    return next(j for j in store.snapshot(ctx, SID)["jobs"] if j["jobId"] == job_id)


def test_retry_requeues_the_failed_job_and_its_dependents(monkeypatch):
    monkeypatch.setenv("SELF_FUNCTION_NAME", "ipverse-api")
    ctx = make_ctx(table=FakeTable(), lambda_=FakeLambda())
    pose = FakeProvider("apose", states=[("failed", "Bedrock 503")])
    mesh = FakeProvider("img3d", states=[("done", "")])
    for fake in (pose, mesh):
        monkeypatch.setitem(jobs.PROVIDERS, fake.name, fake)
    a = jobs.create_job(ctx, SID, "apose", "apose", {"ipId": "ip_1"}, [])["jobId"]
    b = jobs.create_job(ctx, SID, "mesh3d", "img3d", {"ipId": "ip_1"}, [a])["jobId"]
    jobs.advance_jobs(ctx, SID)
    jobs.advance_jobs(ctx, SID)
    assert (_status(ctx, a)["status"], _status(ctx, b)["error"]) == ("failed", jobs.DEP_FAILED)

    assert jobs.retry_job(ctx, SID, "job_nope") is None
    assert sorted(jobs.retry_job(ctx, SID, a)) == sorted([a, b])
    assert [_status(ctx, j)["status"] for j in (a, b)] == ["queued", "queued"]
    pose.states = [("done", "")]
    for _ in range(3):
        jobs.advance_jobs(ctx, SID)
    assert [_status(ctx, j)["status"] for j in (a, b)] == ["done", "done"]
    assert len(pose.submitted) == 2


def test_a_retry_records_when_it_started_and_keeps_createdAt(monkeypatch):
    """The retry stamps retriedAt on the job and the dependents it re-queues, so the card's elapsed time can count
    from the retry and not from createdAt."""
    ctx = make_ctx(table=FakeTable())
    pose = FakeProvider("apose", states=[("failed", "Bedrock 503")])
    mesh = FakeProvider("img3d", states=[("done", "")])
    for fake in (pose, mesh):
        monkeypatch.setitem(jobs.PROVIDERS, fake.name, fake)
    a = jobs.create_job(ctx, SID, "apose", "apose", {"ipId": "ip_1"}, [])["jobId"]
    b = jobs.create_job(ctx, SID, "mesh3d", "img3d", {"ipId": "ip_1"}, [a])["jobId"]
    jobs.advance_jobs(ctx, SID)
    jobs.advance_jobs(ctx, SID)
    made = {j: _status(ctx, j)["createdAt"] for j in (a, b)}
    assert [_status(ctx, j)["status"] for j in (a, b)] == ["failed", "failed"]
    assert not any(_status(ctx, j).get("retriedAt") for j in (a, b))  # never retried yet

    before = store.now()
    assert sorted(jobs.retry_job(ctx, SID, a)) == sorted([a, b])
    after = store.now()
    for j in (a, b):
        job = _status(ctx, j)
        assert job["createdAt"] == made[j]  # the job is still the one made then
        assert before <= job["retriedAt"] <= after  # ISO-8601 with Z sorts as text


def test_a_shot_lost_to_the_gpu_box_is_requeued_and_its_trailer_waits(monkeypatch):
    ctx = make_ctx(table=FakeTable())
    shot = FakeProvider("mediagen_video", states=[("failed", "the box was stopped while the job was running")])
    monkeypatch.setitem(jobs.PROVIDERS, "mediagen_video", shot)
    monkeypatch.setitem(jobs.PROVIDERS, "ffmpeg", FakeProvider("ffmpeg"))
    s = jobs.create_job(ctx, SID, "shot", "mediagen_video", {"ipId": "ip_1"}, [])["jobId"]
    t = jobs.create_job(ctx, SID, "trailer", "ffmpeg", {"shot_job_ids": [s]}, [s])["jobId"]
    seen = []
    for _ in range(8):  # the box keeps dropping it: re-queued twice, then the third failure is final
        jobs.advance_jobs(ctx, SID)
        job = _status(ctx, s)
        seen.append((job["status"], job.get("autoRetries", 0), _status(ctx, t)["status"]))
    assert ("queued", 1, "queued") in seen or ("running", 1, "queued") in seen  # retried while the trailer waited
    assert (_status(ctx, s)["status"], _status(ctx, s)["autoRetries"]) == ("failed", 2)
    assert shot.attempts == 3
    monkeypatch.setitem(jobs.PROVIDERS, "mediagen_video", FakeProvider("mediagen_video", states=[("failed", "prompt rejected")]))
    o = jobs.create_job(ctx, SID, "shot", "mediagen_video", {"ipId": "ip_1"}, [])["jobId"]
    jobs.advance_jobs(ctx, SID)
    jobs.advance_jobs(ctx, SID)
    assert _status(ctx, o)["status"] == "failed"  # not a box problem: no retry
