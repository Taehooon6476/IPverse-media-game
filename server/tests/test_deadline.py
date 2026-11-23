import pytest
from server.tests.conftest import FakeS3, FakeDeadline, make_ctx


def _make_job(session_id="session-1", job_id="job-1", external_id="job-ext-1"):
    return {
        "pk": f"SESSION#{session_id}",
        "sk": f"JOB#{job_id}",
        "jobId": job_id,
        "externalId": external_id,
        "input": {
            "ipId": "ip-1",
            "cutoutKey": f"sessions/{session_id}/ip-1.png",
        },
    }


def test_deadline_submit_parameters_types():
    s3 = FakeS3()
    s3._store[("test-assets", "sessions/session-1/ip-1.png")] = b"CUTOUT"
    deadline = FakeDeadline()
    ctx = make_ctx(s3=s3, deadline=deadline)

    from server.providers.deadline import DeadlineProvider
    provider = DeadlineProvider(template_loader=lambda: {"name": "stub"})
    job = _make_job()

    external_id = provider.submit(job, ctx)
    assert external_id == "job-1"  # FakeDeadline returns jobId="job-1"

    assert len(deadline.calls) == 1
    call = deadline.calls[0]
    assert call["method"] == "create_job"

    params = call["parameters"]
    # INT parameters use {"int": "<str>"}; 48 frames at 16 spp keeps a render at ~2 min on 16 vCPU
    assert params["Frames"] == {"int": "48"}
    assert params["Width"] == {"int": "1280"}
    assert params["Height"] == {"int": "720"}
    assert params["Samples"] == {"int": "16"}
    # STRING parameters use {"string": "..."}; the queue role reads and writes only DeadlineCloud/* of the queue
    # bucket, so the cutout is staged there
    queue = "griptapenode-queue-087967639890-us-east-1-an"
    staged = "DeadlineCloud/ipverse/job-1/inputs/cutout.png"
    assert s3.copies == [{"CopySource": {"Bucket": "test-assets", "Key": "sessions/session-1/ip-1.png"},
                          "Bucket": queue, "Key": staged}]
    assert s3._store[(queue, staged)] == b"CUTOUT"
    assert params["InputUri"] == {"string": f"s3://{queue}/{staged}"}
    assert params["OutputPrefix"] == {"string": f"s3://{queue}/DeadlineCloud/ipverse/job-1"}
    assert params["Accent"]["string"] == "#5de6cf"

    assert call["templateType"] == "JSON"
    assert call["priority"] == 50
    assert call["maxRetriesPerTask"] == 1


@pytest.mark.parametrize("task_run,lifecycle,expected_status", [
    ("SUCCEEDED", "CREATE_COMPLETE", "done"),
    ("FAILED", "CREATE_COMPLETE", "failed"),
    ("CANCELED", "CREATE_COMPLETE", "failed"),
    ("RUNNING", "CREATE_COMPLETE", "running"),
    ("PENDING", "CREATE_COMPLETE", "running"),
    ("ASSIGNED", "CREATE_COMPLETE", "running"),
    ("STARTING", "CREATE_COMPLETE", "running"),
    ("RUNNING", "UPDATE_FAILED", "failed"),
    ("RUNNING", "CREATE_FAILED", "failed"),
])
def test_deadline_status_mapping(task_run, lifecycle, expected_status):
    deadline = FakeDeadline()
    deadline._job_responses["job-ext-1"] = {
        "taskRunStatus": task_run,
        "lifecycleStatus": lifecycle,
        "createdAt": "2026-01-01T00:00:00Z",
    }
    ctx = make_ctx(deadline=deadline)

    from server.providers.deadline import DeadlineProvider
    provider = DeadlineProvider(template_loader=lambda: {})
    job = _make_job()

    status, progress = provider.status(job, ctx)
    assert status == expected_status
    if status == "running":  # Korean, never the raw status, in the card's words
        assert task_run not in progress and progress.startswith(("렌더 서버", "3D 회전 영상 만드는 중"))
    if status == "failed":  # a sentence first; the farm's own word after the colon (the card shows the sentence)
        assert progress.startswith(("렌더 서버가 작업을 받지 못했습니다: ", "렌더 서버에서 작업이 "))


def test_deadline_status_progress_format():
    deadline = FakeDeadline()
    deadline._job_responses["job-ext-1"] = {
        "taskRunStatus": "RUNNING",
        "lifecycleStatus": "CREATE_COMPLETE",
        "createdAt": "2026-01-01T00:00:00Z",
    }
    ctx = make_ctx(deadline=deadline)

    from server.providers.deadline import DeadlineProvider
    provider = DeadlineProvider(template_loader=lambda: {})
    job = _make_job()

    status, progress = provider.status(job, ctx)
    assert status == "running"
    assert progress.startswith("3D 회전 영상 만드는 중 · ")
    # elapsed should include 초 (seconds) or 분 (minutes)
    assert "초" in progress or "분" in progress


def test_deadline_collect_copies_three_assets():
    s3 = FakeS3()
    qb = "griptapenode-queue-087967639890-us-east-1-an"
    prefix = "DeadlineCloud/ipverse"

    # submit() points OutputPrefix at our jobId (the Deadline id is unknown until create_job returns)
    s3._store[(qb, f"{prefix}/job-1/turntable.mp4")] = b"TURNTABLE"
    s3._store[(qb, f"{prefix}/job-1/model.glb")] = b"MODEL"
    s3._store[(qb, f"{prefix}/job-1/poster.png")] = b"POSTER"

    ctx = make_ctx(s3=s3)

    from server.providers.deadline import DeadlineProvider
    provider = DeadlineProvider(template_loader=lambda: {})
    job = _make_job()

    assets = provider.collect(job, ctx)

    assert len(assets) == 3
    kinds = {a["kind"] for a in assets}
    assert kinds == {"turntable", "glb", "poster"}

    # All copied to assets bucket
    for asset in assets:
        assert ("test-assets", asset["key"]) in s3._store, f"Missing {asset['key']}"

    # Correct content types
    by_kind = {a["kind"]: a for a in assets}
    # Copied from the prefix submit() wrote to (FakeS3 copies b"" from a missing source)
    assert s3._store[("test-assets", by_kind["turntable"]["key"])] == b"TURNTABLE"
    assert s3._store[("test-assets", by_kind["glb"]["key"])] == b"MODEL"
    assert by_kind["turntable"]["contentType"] == "video/mp4"
    assert by_kind["glb"]["contentType"] == "model/gltf-binary"
    assert by_kind["poster"]["contentType"] == "image/png"


def test_deadline_submit_uses_session_accent():
    deadline = FakeDeadline()
    ctx = make_ctx(s3=FakeS3(), deadline=deadline)

    from server.providers.deadline import DeadlineProvider
    job = _make_job()
    job["input"]["accent"] = "#ffb86b"
    DeadlineProvider(template_loader=lambda: {}).submit(job, ctx)

    params = deadline.calls[0]["parameters"]
    assert params["Accent"] == {"string": "#ffb86b"}
    assert params["OutputPrefix"]["string"].endswith("/DeadlineCloud/ipverse/job-1")


def test_deadline_collect_reads_where_submit_wrote():
    """Same job dict through submit then collect: outputs are found under OutputPrefix (our jobId)."""
    s3, deadline = FakeS3(), FakeDeadline()
    ctx = make_ctx(s3=s3, deadline=deadline)

    from server.providers.deadline import DeadlineProvider
    provider = DeadlineProvider(template_loader=lambda: {})
    job = {"pk": "SESSION#ses_1", "sk": "JOB#job_abc", "jobId": "job_abc",
           "input": {"ipId": "ip_1", "cutoutKey": "sessions/ses_1/cut.png"}}
    job["externalId"] = provider.submit(job, ctx)  # Deadline's own id ("job-1"), not ours
    staged = len(s3.copies)  # submit's input staging copy
    output_prefix = deadline.calls[0]["parameters"]["OutputPrefix"]["string"]
    bucket, prefix = output_prefix[len("s3://"):].split("/", 1)
    names = ("turntable.mp4", "model.glb", "poster.png")
    for name in names:  # what the worker uploads
        s3._store[(bucket, f"{prefix}/{name}")] = name.encode()

    assets = provider.collect(job, ctx)

    assert prefix == "DeadlineCloud/ipverse/job_abc"
    assert [c["CopySource"] for c in s3.copies[staged:]] == [{"Bucket": bucket, "Key": f"{prefix}/{n}"} for n in names]
    assert [s3._store[("test-assets", a["key"])] for a in assets] == [n.encode() for n in names]
