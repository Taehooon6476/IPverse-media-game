from server.providers import apose, mcp_client
from server.tests.conftest import FakeS3, FakeTable, make_ctx

BUCKET = "test-assets"


def test_apose_submits_klein_with_the_ip_image_and_collects_a_cutout_at_the_fixed_key(monkeypatch):
    ctx = make_ctx(table=FakeTable(), s3=FakeS3())
    calls = []

    def call_tool(_ctx, endpoint, tool, args):
        calls.append((tool, args))
        if tool == "start_image":
            return {"job_id": "g1", "status": "RUNNING"}
        return {"status": "SUCCEEDED", "url": "https://gpu/out.png"}

    monkeypatch.setattr(mcp_client, "call_tool", call_tool)
    monkeypatch.setattr(mcp_client, "download", lambda url: b"RAW")
    monkeypatch.setattr(apose, "remove_background", lambda _ctx, raw: b"CUT:" + raw)
    job = {"jobId": "job_1", "pk": "SESSION#ses_1", "externalId": "",
           "input": {"ipId": "ip_1", "name": "제나", "imageKey": "sessions/ses_1/a.png"}}
    p = apose.AposeProvider()
    job["externalId"] = p.submit(job, ctx)
    tool, args = calls[0]
    assert job["externalId"] == "g1" and args["model"] == "klein9" and "A-pose" in args["prompt"]
    assert args["reference_image_urls"][0].endswith("sessions/ses_1/a.png")
    assert p.status(job, ctx) == ("done", "")
    [asset] = p.collect(job, ctx)
    assert asset["key"] == apose.pose_key("ses_1", "job_1") == "sessions/ses_1/job_1-apose.png"
    assert ctx.s3._store[(BUCKET, asset["key"])] == b"CUT:RAW"


def test_the_apose_cutout_sent_to_hunyuan3d_is_cleaned(monkeypatch):
    """Faint alpha and stray specks around the figure must not reach Hunyuan3D."""
    from server.tests.test_cutout import alpha_box, figure, png_rgba
    ctx = make_ctx(table=FakeTable(), s3=FakeS3())
    hazy = png_rgba(figure() + [(160, 0, 240, 160, 4), (10, 10, 12, 12, 255)])
    monkeypatch.setattr(mcp_client, "call_tool", lambda *a: {"status": "SUCCEEDED", "url": "https://gpu/out.png"})
    monkeypatch.setattr(mcp_client, "download", lambda url: b"RAW")
    monkeypatch.setattr(apose, "remove_background", lambda _ctx, raw: hazy)
    job = {"jobId": "job_1", "pk": "SESSION#ses_1", "externalId": "g1", "input": {"ipId": "ip_1", "imageKey": "k"}}
    [asset] = apose.AposeProvider().collect(job, ctx)
    assert alpha_box(hazy) == (10, 0, 239, 159)
    assert alpha_box(ctx.s3._store[(BUCKET, asset["key"])]) == alpha_box(png_rgba(figure())) == (85, 10, 154, 149)
