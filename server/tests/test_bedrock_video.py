import base64
import pytest
from server.tests.conftest import FakeS3, FakeBedrockRT, make_ctx


def _make_job(session_id="session-1", job_id="job-1", image_key=None):
    image_key = image_key or f"sessions/{session_id}/ip-1.jpg"
    return {
        "pk": f"SESSION#{session_id}",
        "sk": f"JOB#{job_id}",
        "jobId": job_id,
        "externalId": "arn:aws:bedrock:us-west-2::async-invoke/test-1",
        "input": {
            "imageKey": image_key,
            "prompt": "A robot spinning",
            "aspect_ratio": "16:9",
            "duration": "5s",
        },
        "outputs": ["asset-out-1"],
    }


def test_video_submit_uses_frame0_and_output_uri():
    fake_image = b"\xff\xd8\xff\xe0" + b"\x00" * 20  # minimal JPEG header
    s3 = FakeS3()
    s3._store[("test-assets", "sessions/session-1/ip-1.jpg")] = fake_image

    bedrock_west = FakeBedrockRT()
    ctx = make_ctx(s3=s3, bedrock_rt_west=bedrock_west)

    from server.providers.bedrock_video import BedrockVideoProvider
    provider = BedrockVideoProvider()
    job = _make_job()

    external_id = provider.submit(job, ctx)
    assert external_id == "arn:aws:bedrock:us-west-2::async-invoke/test-1"

    assert len(bedrock_west.calls) == 1
    call = bedrock_west.calls[0]
    assert call["method"] == "start_async_invoke"
    assert call["modelId"] == "luma.ray-v2:0"

    mi = call["modelInput"]
    assert mi["aspect_ratio"] == "16:9"
    assert mi["duration"] == "5s"
    assert mi["loop"] is False

    frame0 = mi["keyframes"]["frame0"]
    assert frame0["type"] == "image"
    assert frame0["source"]["type"] == "base64"
    assert frame0["source"]["media_type"] == "image/jpeg"
    assert base64.b64decode(frame0["source"]["data"]) == fake_image

    out_uri = call["outputDataConfig"]["s3OutputDataConfig"]["s3Uri"]
    assert out_uri == "s3://test-video/session-1/job-1/"


def test_video_status_maps_correctly():
    from server.providers.bedrock_video import BedrockVideoProvider
    provider = BedrockVideoProvider()
    ctx = make_ctx(bedrock_rt_west=FakeBedrockRT(responses=[{"status": "Completed"}]))
    job = _make_job()
    status, msg = provider.status(job, ctx)
    assert status == "done"
    assert msg == ""


def test_video_status_in_progress():
    from server.providers.bedrock_video import BedrockVideoProvider
    provider = BedrockVideoProvider()
    ctx = make_ctx(bedrock_rt_west=FakeBedrockRT(responses=[{"status": "InProgress"}]))
    job = _make_job()
    status, msg = provider.status(job, ctx)
    assert status == "running"


def test_video_status_failed():
    from server.providers.bedrock_video import BedrockVideoProvider
    provider = BedrockVideoProvider()
    ctx = make_ctx(bedrock_rt_west=FakeBedrockRT(responses=[{
        "status": "Failed",
        "failureMessage": "quota exceeded",
    }]))
    job = _make_job()
    status, msg = provider.status(job, ctx)
    assert status == "failed"
    assert "quota exceeded" in msg


def test_video_collect_copies_mp4():
    s3 = FakeS3()
    # Bedrock writes output.mp4 under {sessionId}/{jobId}/{invocationId}/
    s3._store[("test-video", "session-1/job-1/inv-abc/output.mp4")] = b"FAKEMP4DATA"

    ctx = make_ctx(s3=s3)

    from server.providers.bedrock_video import BedrockVideoProvider
    provider = BedrockVideoProvider()
    job = _make_job()

    assets = provider.collect(job, ctx)

    assert len(assets) == 1
    asset = assets[0]
    assert asset["kind"] == "shot"
    assert asset["key"].startswith("sessions/session-1/")
    assert asset["key"].endswith(".mp4")
    assert asset["contentType"] == "video/mp4"
    # Verify copy landed in assets bucket
    assert ("test-assets", asset["key"]) in s3._store
