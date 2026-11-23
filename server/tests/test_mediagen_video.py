"""MediagenVideoProvider against a fake MCP transport (no network). LIVE=1 adds one real list_video_models call."""
import json
import os

import pytest

from server import jobs, store
from server.providers import mcp_client, mediagen_video as mv
from server.tests.conftest import FakeS3, FakeTable, make_ctx

SID = "sess-1"
REAL_POST = mcp_client._post  # imported before the autouse network guard replaces it


class FakeMCP:
    """Stands in for mcp_client._post: records tools/call requests and answers from `replies` (tool name → result dict,
    or a callable, or a raw JSON-RPC response under the key "raw:<tool>")."""

    def __init__(self, replies):
        self.replies = replies
        self.calls = []  # (tool, arguments)
        self.keys = []
        self.urls = []

    def __call__(self, url, body, key):
        self.urls.append(url)
        assert body["jsonrpc"] == "2.0" and body["method"] == "tools/call"
        tool, args = body["params"]["name"], body["params"]["arguments"]
        self.calls.append((tool, args))
        self.keys.append(key)
        if "raw:" + tool in self.replies:
            return self.replies["raw:" + tool]
        out = self.replies[tool]
        out = out(args) if callable(out) else out
        return {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": json.dumps(out)}]}}


class FakeSSM:
    def __init__(self):
        self.calls = 0

    def get_parameter(self, Name, WithDecryption):
        self.calls += 1
        assert (Name, WithDecryption) == ("/mediagen/mcp-api-key", True)
        return {"Parameter": {"Value": "secret-key\n"}}


@pytest.fixture
def ctx(monkeypatch):
    monkeypatch.setattr(mcp_client, "_key_cache", {})
    return make_ctx(table=FakeTable(), s3=FakeS3(), ssm=FakeSSM())


def _fake(monkeypatch, replies):
    fake = FakeMCP(replies)
    monkeypatch.setattr(mcp_client, "_post", fake)
    return fake


def _job(model, **inp):
    return {"jobId": "job_1", "pk": f"SESSION#{SID}", "externalId": "mg-1",
            "input": {"model": model, "prompt": "slow dolly in", "imageKey": f"sessions/{SID}/ip.jpg", **inp}}


START = {"job_id": "mg-1", "status": "RUNNING", "phase": "starting"}


@pytest.mark.parametrize("model,aspect,tool,dims", [
    ("ltx", "16:9", "ltx_start_video", {"width": 1280, "height": 704}),
    ("ltx", "9:16", "ltx_start_video", {"width": 704, "height": 1280}),
    ("minimax-h3", "16:9", "minimax_h3_start_video", {"width": 1344, "height": 768}),
    ("minimax-h3", "9:16", "minimax_h3_start_video", {"width": 768, "height": 1344}),
    ("kandinsky-6-0-video-pro", "16:9", "video_start", {"model": "kandinsky-6-0-video-pro"}),
])
def test_submit_builds_the_start_call_per_model(ctx, monkeypatch, model, aspect, tool, dims):
    fake = _fake(monkeypatch, {tool: START})
    ext = mv.MediagenVideoProvider().submit(_job(model, aspect_ratio=aspect, seconds=5), ctx)
    assert ext == "mg-1"
    assert fake.calls == [(tool, {"prompt": "slow dolly in", "seconds": 5,
                                  "image_url": f"https://cdn.example.com/sessions/{SID}/ip.jpg", **dims})]
    assert fake.keys == ["secret-key"] and fake.urls == [mcp_client.VIDEO.url]


def test_ltx_past_8_seconds_is_one_pass_at_the_long_size(ctx, monkeypatch):
    fake = _fake(monkeypatch, {"ltx_start_video": START})
    mv.MediagenVideoProvider().submit(_job("ltx", aspect_ratio="16:9", seconds=20), ctx)
    mv.MediagenVideoProvider().submit(_job("ltx", aspect_ratio="9:16", seconds=8), ctx)
    assert [(a["seconds"], a["width"], a["height"]) for _, a in fake.calls] == [(20, 960, 512), (8, 704, 1280)]


def test_submit_without_image_is_text_to_video_and_key_is_cached(ctx, monkeypatch):
    fake = _fake(monkeypatch, {"ltx_start_video": START})
    provider = mv.MediagenVideoProvider()
    provider.submit(_job("ltx", imageKey="", seconds=3), ctx)
    provider.submit(_job("ltx", imageKey="", seconds=3), ctx)
    assert "image_url" not in fake.calls[0][1]
    assert ctx.ssm.calls == 1


def test_submit_presigns_when_there_is_no_cdn(ctx, monkeypatch):
    fake = _fake(monkeypatch, {"ltx_start_video": START})
    ctx.cdn_domain = ""
    ctx.s3.generate_presigned_url = lambda op, Params, ExpiresIn: f"https://s3/{Params['Key']}?ttl={ExpiresIn}"
    mv.MediagenVideoProvider().submit(_job("ltx"), ctx)
    assert fake.calls[0][1]["image_url"] == f"https://s3/sessions/{SID}/ip.jpg?ttl=3600"


def test_wan_animate_uses_the_driving_shot_output(ctx, monkeypatch):
    shot = jobs.create_job(ctx, SID, "shot", "mediagen_video", {"model": "ltx", "aspect_ratio": "9:16"}, [])
    asset = store.put_asset(ctx, SID, {"kind": "shot", "key": f"sessions/{SID}/drive.mp4", "contentType": "video/mp4"})
    store.update_job(ctx, SID, shot["jobId"], status="done", outputs=[asset["assetId"]])
    fake = _fake(monkeypatch, {"wan_animate_start": START})
    mv.MediagenVideoProvider().submit(_job("wan-animate", driving_shot_job_id=shot["jobId"], seconds=4,
                                           aspect_ratio="9:16", prompt=""), ctx)
    assert fake.calls == [("wan_animate_start", {
        "reference_image_url": f"https://cdn.example.com/sessions/{SID}/ip.jpg",
        "driving_video_url": f"https://cdn.example.com/sessions/{SID}/drive.mp4",
        "prompt": "", "seconds": 4, "width": 480, "height": 832})]


@pytest.mark.parametrize("model,tool", [*mv.STATUS_TOOL.items(), ("kandinsky-6-0-video-pro", "video_get_status")])
def test_status_maps_states(ctx, monkeypatch, model, tool):  # a promoted model (no own tool) polls video_get_status
    replies = iter([
        {"status": "RUNNING", "phase": "starting_instance"},
        {"status": "RUNNING", "phase": "denoising", "step": 15, "steps": 30},
        {"status": "RUNNING", "phase": "decoding", "progress": 0.9},
        {"status": "SUCCEEDED", "url": "https://media/x.mp4"},
        {"status": "FAILED", "error": "CUDA out of memory"},
        {"status": "SUCCEEDED"},
    ])
    fake = _fake(monkeypatch, {tool: lambda args: next(replies)})
    provider, job = mv.MediagenVideoProvider(), _job(model)
    assert [provider.status(job, ctx) for _ in range(6)] == [  # the MCP's boot phases read in Korean
        ("running", "정지된 GPU 서버 켜는 중 (~2분)"), ("running", "영상 생성 중 50%"), ("running", "영상 마무리 중 (디코딩) 90%"),
        ("done", ""), ("failed", "CUDA out of memory"), ("failed", "결과 영상 URL이 없습니다")]
    assert fake.calls[0] == (tool, {"job_id": "mg-1"})


def test_collect_downloads_and_uploads_the_mp4(ctx, monkeypatch):
    _fake(monkeypatch, {"minimax_h3_get_status": {"status": "SUCCEEDED", "url": "https://media/x.mp4"}})
    monkeypatch.setattr(mcp_client, "download", lambda url: b"MP4:" + url.encode())
    [asset] = mv.MediagenVideoProvider().collect(_job("minimax-h3"), ctx)
    assert asset["kind"] == "shot" and asset["contentType"] == "video/mp4"
    assert asset["key"] == f"sessions/{SID}/{asset['assetId']}.mp4"
    assert asset["meta"] == {"model": "minimax-h3", "prompt": "slow dolly in", "aspect_ratio": "16:9"}
    assert ctx.s3._store[("test-assets", asset["key"])] == b"MP4:https://media/x.mp4"
    assert ctx.s3.put_kwargs[("test-assets", asset["key"])] == {"ContentType": "video/mp4"}


def test_tool_error_and_rpc_error_surface_their_text(ctx, monkeypatch):
    _fake(monkeypatch, {
        "raw:ltx_start_video": {"jsonrpc": "2.0", "id": 1, "result": {
            "isError": True, "content": [{"type": "text", "text": "seconds must be 2-8"}]}},
        "raw:ltx_get_status": {"jsonrpc": "2.0", "id": 1, "error": {"code": -32602, "message": "Unknown tool"}},
    })
    provider = mv.MediagenVideoProvider()
    with pytest.raises(RuntimeError, match="seconds must be 2-8"):
        provider.submit(_job("ltx"), ctx)
    with pytest.raises(RuntimeError, match="Unknown tool"):
        provider.status(_job("ltx"), ctx)


def test_failed_start_reply_raises(ctx, monkeypatch):
    _fake(monkeypatch, {"ltx_start_video": {"status": "FAILED", "error": "box disabled"}})
    with pytest.raises(RuntimeError, match="box disabled"):
        mv.MediagenVideoProvider().submit(_job("ltx"), ctx)


def test_mediagen_jobs_are_not_serialized(ctx, monkeypatch):
    _fake(monkeypatch, {"ltx_start_video": START, "ltx_get_status": {"status": "RUNNING", "phase": "queued"}})
    a = jobs.create_job(ctx, SID, "shot", "mediagen_video", _job("ltx")["input"], [])
    b = jobs.create_job(ctx, SID, "shot", "mediagen_video", _job("ltx")["input"], [])
    jobs.advance_jobs(ctx, SID)
    assert {store.get_job(ctx, SID, j["jobId"])["status"] for j in (a, b)} == {"running"}


def test_finished_shot_is_collected_through_the_real_job_engine(ctx, monkeypatch):
    """_settle blanks externalId to claim the collection; collect must still find the result."""
    fake = _fake(monkeypatch, {"ltx_start_video": START,
                               "ltx_get_status": {"status": "SUCCEEDED", "url": "https://media/shot.mp4"}})
    monkeypatch.setattr(mcp_client, "download", lambda url: b"MP4:" + url.encode())
    shot = jobs.create_job(ctx, SID, "shot", "mediagen_video", _job("ltx", aspect_ratio="9:16")["input"], [])

    jobs.advance_jobs(ctx, SID)  # submit → externalId mg-1
    assert store.get_job(ctx, SID, shot["jobId"])["externalId"] == "mg-1"
    jobs.advance_jobs(ctx, SID)  # status SUCCEEDED → claim → collect → done

    done = store.get_job(ctx, SID, shot["jobId"])
    assert (done["status"], done.get("error"), done["externalId"]) == ("done", None, "mg-1")
    [asset] = [a for a in store.snapshot(ctx, SID)["assets"] if a["assetId"] in done["outputs"]]
    assert asset["kind"] == "shot" and ctx.s3._store[("test-assets", asset["key"])] == b"MP4:https://media/shot.mp4"
    assert all(args.get("job_id") != "" for tool, args in fake.calls)


def test_collect_repolls_with_the_restored_id_when_no_url_was_stashed(ctx, monkeypatch):
    fake = _fake(monkeypatch, {"ltx_get_status": {"status": "SUCCEEDED", "url": "https://media/again.mp4"}})
    monkeypatch.setattr(mcp_client, "download", lambda url: url.encode())
    [asset] = mv.MediagenVideoProvider().collect(_job("ltx"), ctx)  # a fresh dict: no _resultUrl
    assert fake.calls == [("ltx_get_status", {"job_id": "mg-1"})]
    assert ctx.s3._store[("test-assets", asset["key"])] == b"https://media/again.mp4"
    with pytest.raises(RuntimeError, match="URL"):
        mv.MediagenVideoProvider().collect({**_job("ltx"), "externalId": ""}, ctx)  # never polls with ""


def test_post_reads_an_sse_reply(monkeypatch):
    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'

    monkeypatch.setattr(mcp_client.urllib.request, "urlopen", lambda req, timeout: Resp())
    assert REAL_POST("https://x/mcp", {"x": 1}, "k") == {"jsonrpc": "2.0", "id": 1, "result": {}}


@pytest.mark.skipif(os.environ.get("LIVE") != "1", reason="Set LIVE=1 to call the real mediagen MCP proxy")
def test_live_list_video_models_includes_ltx():
    from server.providers.base import Ctx
    out = mv.call_tool(Ctx.from_env(), "list_video_models", {})
    print(json.dumps(out, ensure_ascii=False)[:1500])
    assert "ltx" in [m.get("id") for m in out["models"]]
