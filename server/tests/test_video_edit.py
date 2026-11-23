"""The attached video MCP's capabilities: its models, tools and LTX tasks are read from the MCP
(tools/list, list_video_models, ltx_list_tasks; cached), and restyle / v2v / inpaint of an existing shot,
text-to-video, MiniMax H3 last frame and models promoted on the MCP (video_start) all run as mediagen_video jobs.
Everything goes through a fake MCP transport (mcp_client._post): no network."""
import json
import os

import pytest

from server import connections, jobs, prompts, store, tools, video_edit
from server.providers import mcp_client, mediagen_video as mv
from server.tests.conftest import FakeS3, FakeTable, make_ctx
from server.tests.test_tools import _add_ip, _job, _session

# the real tool schemas' parameter names (a saved tools/list of the mediagen proxy: mcp_schemas.json)
with open(os.path.join(os.path.dirname(__file__), "mcp_schemas.json")) as f:
    TOOLS = {name: sorted((schema.get("properties") or {})) for name, schema in json.load(f)["video"].items()}
# the image MCP's list_models
IMAGE_MODELS = [{"id": "klein9", "label": "FLUX.2 klein 9B", "swap_wait_s": 119},
                {"id": "krea", "label": "Krea 2 Turbo", "swap_wait_s": 123}]
MODELS = [
    {"id": "ltx", "label": "LTX 22B (2.5 + 2.3, all IC-LoRAs)", "kinds": ["i2v", "t2v", "v2v", "restyle"], "status": "ready"},
    {"id": "wan-animate", "label": "Wan2.2-Animate-14B + Wan2.1-VACE-14B (GGUF Q8)", "kinds": ["animate", "restyle"],
     "status": "ready"},
    {"id": "minimax-h3", "label": "MiniMax H3 (Hailuo 3.0) FL2VA 33B", "kinds": ["t2v", "i2v"], "status": "stopped"},
    {"id": "kandinsky-6-0-video-pro", "label": "Kandinsky 6.0 Video Pro", "kinds": ["t2v", "i2v"], "status": "stopped",
     "promoted": True, "tool": "video_start"},
    # promoted on the MCP after the platform was written: no code knows this id
    {"id": "hunyuan-video-2", "label": "HunyuanVideo 2", "kinds": ["t2v"], "status": "ready", "promoted": True,
     "tool": "video_start"},
    {"id": "old-model", "label": "Old Model", "kinds": ["t2v", "i2v"], "status": "disabled", "promoted": True},
]
TASKS = [{"task": t, "description": f"{t} task", "base": "2.5"} for t in ("upscale", "deblur", "colorize",
                                                                          "day_to_night", "water", "relight")]
START = {"job_id": "mg-1", "status": "RUNNING"}


class FakeVideoMCP:
    """Stands in for mcp_client._post: tools/list from `tools`, list_video_models / ltx_list_tasks from `models` /
    `tasks`, any other tools/call from `replies` (tool name → result dict). The image MCP answers list_models from
    `image_models` only."""

    def __init__(self, models=MODELS, tool_names=TOOLS, tasks=TASKS, replies=None):
        self.models, self.tools, self.tasks, self.replies = models, tool_names, tasks, dict(replies or {})
        self.image_models = IMAGE_MODELS
        self.calls = []  # (tool name or "tools/list", arguments)

    def __call__(self, url, body, key):
        if url == mcp_client.IMAGE.url:
            assert body["params"]["name"] == "list_models"
            self.calls.append(("image:list_models", None))
            text = json.dumps({"loaded": "krea", "models": self.image_models})
            return {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": text}]}}
        assert url == mcp_client.VIDEO.url and body["jsonrpc"] == "2.0"
        if body["method"] == "tools/list":
            self.calls.append(("tools/list", None))
            return {"jsonrpc": "2.0", "id": 1, "result": {"tools": [
                {"name": n, "inputSchema": {"type": "object", "properties": {p: {"type": "string"} for p in ps}}}
                for n, ps in self.tools.items()]}}
        assert body["method"] == "tools/call"
        name, args = body["params"]["name"], body["params"]["arguments"]
        self.calls.append((name, args))
        out = ({"models": self.models} if name == "list_video_models" else {"tasks": self.tasks} if name == "ltx_list_tasks"
               else self.replies[name])
        return {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": json.dumps(out)}]}}

    def starts(self):
        return [(n, a) for n, a in self.calls if n not in ("tools/list", "list_video_models", "ltx_list_tasks",
                                                           "image:list_models")]


@pytest.fixture
def mcp(monkeypatch):
    monkeypatch.setattr(mv, "_catalog", {})  # every test reads the catalogs afresh
    monkeypatch.setattr(connections, "_image_catalog", {}, raising=False)
    fake = FakeVideoMCP()
    monkeypatch.setattr(mcp_client, "_post", fake)
    return fake


@pytest.fixture
def ctx():
    return make_ctx(table=FakeTable(), s3=FakeS3())


@pytest.fixture
def session(ctx):
    return _session(ctx)


def _done_shot(ctx, sid, ip_id="ip_hero", aspect="16:9", seconds=5):
    job = jobs.create_job(ctx, sid, "shot", "mediagen_video", {"ipId": ip_id, "imageKey": f"sessions/{sid}/{ip_id}.jpg",
                                                                 "prompt": "running with a blaster", "model": "ltx",
                                                                 "aspect_ratio": aspect, "seconds": seconds}, [])
    asset = store.put_asset(ctx, sid, {"kind": "shot", "key": f"sessions/{sid}/src.mp4", "contentType": "video/mp4",
                                       "ipId": ip_id, "jobId": job["jobId"]})
    store.update_job(ctx, sid, job["jobId"], status="done", outputs=[asset["assetId"]])
    return job["jobId"]


# ── the catalog ──

def test_catalog_reads_models_tools_and_tasks_from_the_mcp_once(ctx, mcp):
    cat = mv.catalog(ctx)
    assert cat["live"] is True
    assert [m["id"] for m in cat["models"]] == [m["id"] for m in MODELS]
    assert cat["models"][4] == {"id": "hunyuan-video-2", "label": "HunyuanVideo 2", "kinds": ["t2v"], "status": "ready",
                                "promoted": True}
    assert "ltx_restyle_start" in cat["tools"] and "last_image_url" in cat["tools"]["minimax_h3_start_video"]
    assert [t["task"] for t in cat["tasks"]] == [t["task"] for t in TASKS]
    assert sorted(n for n, _ in mcp.calls) == ["list_video_models", "ltx_list_tasks", "tools/list"]
    mv.catalog(ctx)
    assert len(mcp.calls) == 3  # cached
    mv.catalog(ctx, fresh=True)
    assert len(mcp.calls) == 6


def test_catalog_keeps_the_last_good_answer_when_the_mcp_fails(ctx, mcp, monkeypatch):
    mv.catalog(ctx)

    def down(*a, **k):
        raise RuntimeError("MCP HTTP 502")
    monkeypatch.setattr(mcp_client, "_post", down)
    cat = mv.catalog(ctx, fresh=True)
    assert cat["live"] is False and "hunyuan-video-2" in [m["id"] for m in cat["models"]]
    monkeypatch.setattr(mv, "_catalog", {})
    assert [m["id"] for m in mv.catalog(ctx)["models"]] == [m["id"] for m in mv.DEFAULT_CATALOG["models"]]


def test_a_hanging_mcp_costs_the_caller_at_most_the_catalog_wait(ctx, mcp, monkeypatch):
    import threading
    import time
    release = threading.Event()

    def hangs(*a, **k):
        release.wait(5)
        raise RuntimeError("timed out")
    monkeypatch.setattr(mcp_client, "_post", hangs)
    monkeypatch.setattr(mv, "CATALOG_WAIT_SEC", 0.3)
    started = time.monotonic()
    cat = mv.catalog(ctx)
    took = time.monotonic() - started
    release.set()
    assert cat["live"] is False and took < 2, took  # the defaults, not a 60 s wait on mcp_client's timeout


# ── the provider: start calls ──

def _job_dict(**inp):
    return {"jobId": "job_x", "pk": "SESSION#sess-1", "externalId": "mg-1", "input": inp}


def test_a_model_promoted_on_the_mcp_runs_through_video_start(ctx, mcp):
    mcp.replies.update(video_start=START, video_get_status={"status": "RUNNING", "phase": "loading"})
    provider = mv.MediagenVideoProvider()
    assert provider.submit(_job_dict(model="hunyuan-video-2", prompt="a neon city at night", seconds=5,
                                     aspect_ratio="16:9"), ctx) == "mg-1"
    assert mcp.starts() == [("video_start", {"model": "hunyuan-video-2", "prompt": "a neon city at night", "seconds": 5})]
    assert provider.status(_job_dict(model="hunyuan-video-2"), ctx) == ("running", "GPU 서버에 모델 불러오는 중 (~1–3분)")
    assert mcp.starts()[-1] == ("video_get_status", {"job_id": "mg-1"})


def test_minimax_h3_gets_the_last_frame(ctx, mcp):
    mcp.replies["minimax_h3_start_video"] = START
    mv.MediagenVideoProvider().submit(_job_dict(model="minimax-h3", prompt="she turns into her rival", seconds=5,
                                                imageKey="sessions/sess-1/a.jpg", lastImageKey="sessions/sess-1/b.jpg"), ctx)
    [(tool, args)] = mcp.starts()
    assert tool == "minimax_h3_start_video"
    assert (args["image_url"], args["last_image_url"]) == ("https://cdn.example.com/sessions/sess-1/a.jpg",
                                                           "https://cdn.example.com/sessions/sess-1/b.jpg")


@pytest.mark.parametrize("edit,model,extra,tool,args", [
    # a restyle asks for the size on the box's grid nearest the shot's shape, at full depth control
    ("restyle", "ltx", {}, "ltx_restyle_start", {"width": 640, "height": 1152, "control": "depth", "strength": 1.0}),
    ("restyle", "wan-animate", {}, "wan_restyle_start", {"width": 480, "height": 880, "control": "depth",
                                                          "strength": 1.0}),
    # v2v reads the source for its size first: test_round9_video.py
    ("inpaint", "ltx", {"task": "water", "keep_level": 0.3}, "ltx_inpaint_start", {"task": "water", "keep_level": 0.3}),
    ("inpaint", "ltx", {}, "ltx_inpaint_start", {}),  # the MCP's default task (water)
])
def test_edits_send_the_source_shot_to_the_right_tool(ctx, mcp, edit, model, extra, tool, args):
    sid = "sess-1"
    src = _done_shot(ctx, sid, aspect="9:16")
    mcp.replies[tool] = START
    mv.MediagenVideoProvider().submit({"jobId": "job_e", "pk": f"SESSION#{sid}", "input": {
        "edit": edit, "model": model, "prompt": "watercolor painting", "sourceShotJobId": src, "aspect_ratio": "9:16",
        **extra}}, ctx)
    assert mcp.starts() == [(tool, {"video_url": f"https://cdn.example.com/sessions/{sid}/src.mp4",
                                    "prompt": "watercolor painting", **args})]
    assert mv.status_tool({"edit": edit, "model": model}) == ("wan_restyle_get_status" if model == "wan-animate"
                                                              else "ltx_get_status")


# ── the agent tools ──

def test_edit_video_shot_registers_a_shot_job_on_the_source(ctx, session, mcp):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    src = _done_shot(ctx, sid)
    out = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src, "edit": "restyle",
                                                           "style": " watercolor painting ",
                                                           "prompt": " watercolor painting, the same run "})
    job = _job(ctx, sid, out["jobId"])
    assert (job["kind"], job["provider"], job["deps"], job["status"]) == ("shot", "mediagen_video", [src], "queued")
    assert job["input"] == {"edit": "restyle", "model": "ltx", "prompt": "watercolor painting, the same run",
                            "style": "watercolor painting", "sourceShotJobId": src, "sourceIpId": "ip_hero",
                            "aspect_ratio": "16:9", "seconds": 5, "etaMinutes": 8}  # the card's wait until a line states one
    # an edit of an edit keeps the IP; its output is a shot, so a trailer can cut it
    again = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": out["jobId"], "edit": "v2v", "task": "upscale",
                                                             "prompt": "sharper"})
    assert _job(ctx, sid, again["jobId"])["input"]["sourceIpId"] == "ip_hero"
    trailer = tools.run_tool(ctx, session, "cut_trailer", {"shot_job_ids": [out["jobId"], again["jobId"]], "title": "t",
                                                           "subtitle": "", "lut": "none", "make_shorts": True})
    assert "jobId" in trailer
    assert tools.summarize("edit_video_shot", {}, out) == f"영상 수정: {out['jobId']}"


@pytest.mark.parametrize("args,code", [
    ({"shot_job_id": "job_nope", "edit": "restyle", "prompt": "x"}, "not_found"),
    ({"shot_job_id": None, "edit": "restyle", "prompt": "x"}, "not_found"),
    ({"edit": "mirror", "prompt": "x"}, "bad_args"),
    ({"edit": "restyle", "prompt": " "}, "bad_args"),
    ({"edit": "restyle", "model": "minimax-h3", "prompt": "x"}, "bad_args"),  # H3 does not restyle
    ({"edit": "v2v", "prompt": "x"}, "bad_args"),  # v2v needs a task
    ({"edit": "v2v", "task": "teleport", "prompt": "x"}, "bad_args"),
    ({"edit": "inpaint", "keep_level": 3, "prompt": "x"}, "bad_args"),
])
def test_edit_video_shot_rejects_what_it_cannot_do(ctx, session, mcp, args, code):
    src = _done_shot(ctx, session["sessionId"])
    out = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src, **args})
    assert out["error"] == code and out["message"]


def test_edit_video_shot_knows_what_the_mcp_offers(ctx, session, mcp):
    sid = session["sessionId"]
    src = _done_shot(ctx, sid)
    combo = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src, "edit": "v2v",
                                                             "task": "water+day_to_night", "prompt": "a stormy night"})
    assert _job(ctx, sid, combo["jobId"])["input"]["task"] == "water+day_to_night"
    rain = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src, "edit": "inpaint", "task": "water",
                                                            "keep_level": 0.3, "prompt": "heavy rain, same girl"})
    assert {k: _job(ctx, sid, rain["jobId"])["input"][k] for k in ("task", "keep_level")} == {"task": "water", "keep_level": 0.3}
    bad = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src, "edit": "v2v", "task": "hdr", "prompt": "x"})
    assert "upscale|deblur|colorize|day_to_night|water|relight" in bad["message"]  # the MCP's own list
    store.update_job(ctx, sid, src, status="failed")
    assert tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src, "edit": "restyle",
                                                            "prompt": "x"})["error"] == "bad_args"
    # a tool the attached MCP no longer offers is refused, not sent
    mcp.tools = {k: v for k, v in TOOLS.items() if k != "wan_restyle_start"}
    mv.catalog(ctx, fresh=True)
    src = _done_shot(ctx, sid)
    out = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src, "edit": "restyle", "model": "wan-animate",
                                                           "prompt": "x"})
    assert out["error"] == "unavailable" and "wan_restyle_start" in out["message"]


def test_an_edit_runs_end_to_end_through_the_job_engine(ctx, session, mcp, monkeypatch):
    """An inpaint; the anchored restyle's own run through the engine is in test_restyle_anchor.py."""
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    src = tools.run_tool(ctx, session, "make_video_shot", {"ipId": "ip_hero", "prompt": "sprinting", "aspect_ratio": "16:9"})
    edit = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src["jobId"], "edit": "inpaint", "task": "water",
                                                            "prompt": "the same run in heavy rain"})
    statuses = iter([{"status": "RUNNING", "phase": "denoising"}, {"status": "SUCCEEDED", "url": "https://media/src.mp4"},
                     {"status": "SUCCEEDED", "url": "https://media/edit.mp4"}])
    mcp.replies.update(ltx_start_video={"job_id": "mg-src"}, ltx_inpaint_start={"job_id": "mg-edit"})
    monkeypatch.setattr(mv, "call_tool", _wrap(mv.call_tool, {"ltx_get_status": lambda args: next(statuses)}))
    monkeypatch.setattr(mcp_client, "download", lambda url: b"MP4:" + url.encode())

    jobs.advance_jobs(ctx, sid)  # the source submits and runs; the edit waits for it
    assert (_job(ctx, sid, src["jobId"])["status"], _job(ctx, sid, edit["jobId"])["status"]) == ("running", "queued")
    jobs.advance_jobs(ctx, sid)  # the source lands, then (same pass) the edit starts from its mp4 and lands
    done = _job(ctx, sid, edit["jobId"])
    assert (done["status"], done["externalId"]) == ("done", "mg-edit")
    [(_, v2v)] = [s for s in mcp.starts() if s[0] == "ltx_inpaint_start"]
    src_asset = _job(ctx, sid, src["jobId"])["outputs"][0]
    assert v2v["video_url"] == f"https://cdn.example.com/sessions/{sid}/{src_asset}.mp4"
    [asset] = [a for a in store.snapshot(ctx, sid)["assets"] if a["assetId"] in done["outputs"]]
    assert (asset["kind"], asset["ipId"]) == ("shot", "ip_hero")
    assert asset["meta"] == {"model": "ltx", "prompt": "the same run in heavy rain", "aspect_ratio": "16:9",
                             "edit": "inpaint", "task": "water", "sourceShotJobId": src["jobId"]}
    assert ctx.s3._store[("test-assets", asset["key"])] == b"MP4:https://media/edit.mp4"


def _wrap(real, fakes):
    def call(ctx, tool, args):
        return fakes[tool](args) if tool in fakes else real(ctx, tool, args)
    return call


def test_make_video_shot_text_to_video_last_frame_and_mcp_models(ctx, session, mcp):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _add_ip(ctx, sid, "ip_rival", b"RIVAL")

    def shot(**args):
        out = tools.run_tool(ctx, session, "make_video_shot", {"prompt": "a neon skyline", "aspect_ratio": "16:9", **args})
        return out if "error" in out else _job(ctx, sid, out["jobId"])["input"]

    assert shot() == {"prompt": "a neon skyline", "aspect_ratio": "16:9", "seconds": 5, "model": "ltx"}  # text → video
    assert shot(model="hunyuan-video-2")["model"] == "hunyuan-video-2"  # newly promoted on the MCP
    assert "이미지로" in shot(ipId="ip_hero", model="hunyuan-video-2")["message"]  # t2v only
    assert "disabled" in shot(model="old-model")["message"]
    unknown = shot(model="luma")
    assert unknown["error"] == "bad_args" and "ltx|minimax-h3|kandinsky-6-0-video-pro|hunyuan-video-2" in unknown["message"]
    h3 = shot(ipId="ip_hero", last_ip_id="ip_rival", model="minimax-h3")
    assert (h3["imageKey"], h3["lastIpId"], h3["lastImageKey"]) == (f"sessions/{sid}/ip_hero.jpg", "ip_rival",
                                                                    f"sessions/{sid}/ip_rival.jpg")
    assert shot(ipId="ip_hero", last_ip_id="ip_rival")["error"] == "bad_args"  # LTX takes no last frame
    assert shot(last_ip_id="ip_rival", model="minimax-h3")["error"] == "bad_args"  # a last frame needs a first one
    assert shot(ipId="ip_hero", last_ip_id="ip_nope", model="minimax-h3")["error"] == "not_found"
    assert shot(ipId="ip_nope")["error"] == "not_found"


def test_the_agent_state_shows_what_an_edit_or_a_last_frame_shot_was_made_from(ctx, session, mcp):
    from server import agent
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _add_ip(ctx, sid, "ip_rival", b"RIVAL")
    src = _done_shot(ctx, sid)
    h3 = tools.run_tool(ctx, session, "make_video_shot", {"ipId": "ip_hero", "last_ip_id": "ip_rival", "model": "minimax-h3",
                                                          "prompt": "she turns into her rival", "aspect_ratio": "16:9"})
    up = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src, "edit": "v2v", "task": "upscale", "prompt": "sharper"})
    state = {j["jobId"]: j for j in json.loads(agent.state_summary(store.snapshot(ctx, sid)))["jobs"]}
    assert state[h3["jobId"]]["lastIpId"] == "ip_rival"  # "[영상 수정]" keeps the last frame
    assert {k: state[up["jobId"]][k] for k in ("edit", "task", "sourceShotJobId")} == {"edit": "v2v", "task": "upscale",
                                                                                       "sourceShotJobId": src}


def test_the_agent_sees_the_new_capabilities():
    names = [s["name"] for s in tools.TOOL_SPECS]
    assert "edit_video_shot" in names and "edit_video_shot" in tools.TOOLS
    assert next(s for s in tools.TOOL_SPECS if s["name"] == "edit_video_shot") is video_edit.SPEC
    make = next(s for s in tools.TOOL_SPECS if s["name"] == "make_video_shot")["inputSchema"]["json"]
    assert make["required"] == ["prompt", "aspect_ratio"] and "enum" not in make["properties"]["model"]
    assert "last_ip_id" in make["properties"]
    for rule in ("edit_video_shot", "restyle", "inpaint", "last_ip_id", "텍스트-투-비디오"):
        assert rule in prompts.SYSTEM, rule


def test_connections_list_the_video_models_from_the_mcp(ctx, mcp, monkeypatch):
    monkeypatch.setattr(connections, "list_tools", lambda url, headers, budget=None: [{"name": n} for n in TOOLS])
    video = next(c for c in connections.listing(ctx, {"sub": "user-1"})["platform"] if c["id"] == "videogen")
    assert video["status"] == "connected"
    assert [m["id"] for m in video["models"]] == [m["id"] for m in MODELS]
    assert video["models"][3] == {"id": "kandinsky-6-0-video-pro", "label": "Kandinsky 6.0 Video Pro",
                                  "kinds": ["t2v", "i2v"], "status": "stopped", "promoted": True}


# A stopped GPU box that EC2 cannot start (no GPU capacity in its zone)

CAPACITY_ERROR = ("ClientError: An error occurred (InsufficientInstanceCapacity) when calling the StartInstances "
                  "operation (reached max retries: 4): Insufficient capacity.")


def test_no_gpu_capacity_reads_as_a_korean_message_that_offers_ltx(ctx, mcp):
    mcp.replies["minimax_h3_get_status"] = {"status": "FAILED", "error": CAPACITY_ERROR}
    state, error = mv.MediagenVideoProvider().status(_job_dict(model="minimax-h3"), ctx)
    assert state == "failed" and error.startswith("GPU 용량 부족") and "MiniMax H3" in error
    assert "잠시 뒤 다시 시도" in error and "LTX로" in error and "An error occurred" not in error
    assert any(t in error.lower() for t in jobs.TRANSIENT)  # still a box problem to jobs.py: it is retried
    mcp.replies["minimax_h3_get_status"] = {"status": "FAILED", "error": "prompt rejected"}
    assert mv.MediagenVideoProvider().status(_job_dict(model="minimax-h3"), ctx) == ("failed", "prompt rejected")
    # the LTX box itself (a shot or an edit on it): "make it with LTX" would be no way out
    mcp.replies["ltx_get_status"] = {"status": "FAILED", "error": CAPACITY_ERROR}
    for inp in ({"model": "ltx"}, {"model": "ltx", "edit": "restyle"}):
        state, error = mv.MediagenVideoProvider().status(_job_dict(**inp), ctx)
        assert error.startswith("GPU 용량 부족") and "LTX 22B" in error and "잠시 뒤 다시 시도" in error, error
        assert "LTX로" not in error


def test_a_shot_without_gpu_capacity_retries_after_a_backoff_then_fails_in_korean(ctx, session, mcp):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _add_ip(ctx, sid, "ip_rival", b"RIVAL")
    shot = tools.run_tool(ctx, session, "make_video_shot", {"ipId": "ip_hero", "last_ip_id": "ip_rival", "model": "minimax-h3",
                                                            "prompt": "she turns into her rival", "aspect_ratio": "16:9"})["jobId"]
    mcp.replies.update(minimax_h3_start_video=START, minimax_h3_get_status={"status": "FAILED", "error": CAPACITY_ERROR})

    def started():
        return len([n for n, _ in mcp.starts() if n == "minimax_h3_start_video"])
    waits = []
    for attempt in (1, 2):
        jobs.advance_jobs(ctx, sid)  # it starts, the box cannot boot: back in the queue after a wait, not at once
        job = _job(ctx, sid, shot)
        assert (job["status"], job["autoRetries"], started()) == ("queued", attempt, attempt)
        assert job["progress"].startswith("GPU 용량 부족") and f"({attempt}/2)" in job["progress"], job["progress"]
        waits.append(-store.age_sec(job["retryAt"]))
        jobs.advance_jobs(ctx, sid)
        assert started() == attempt  # nothing starts while it waits
        store.update_job(ctx, sid, shot, retryAt="")  # the wait is over
    assert waits[0] > 100 and waits[1] > 200  # ~2 min, then ~4 min
    jobs.advance_jobs(ctx, sid)
    job = _job(ctx, sid, shot)
    assert (job["status"], started()) == ("failed", 3)
    assert job["error"].startswith("GPU 용량 부족") and "LTX로" in job["error"]


def test_the_agent_offers_ltx_when_a_gpu_box_has_no_capacity():
    [rule] = [line for line in prompts.SYSTEM.splitlines() if "GPU 용량 부족" in line]
    assert "LTX" in rule and "last_ip_id" in rule and "묻" in rule


def test_boot_phases_read_in_korean(ctx, mcp):
    mcp.replies["minimax_h3_get_status"] = {"status": "RUNNING", "phase": "starting_instance"}
    assert mv.MediagenVideoProvider().status(_job_dict(model="minimax-h3"), ctx) == ("running", "정지된 GPU 서버 켜는 중 (~2분)")


# No hard-coded model lists: the tools take what the MCPs list

def test_an_action_shot_takes_any_image_to_video_model_the_mcp_lists(ctx, session, mcp):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    mcp.models = MODELS + [{"id": "wan-i2v-3", "label": "Wan 3 I2V", "kinds": ["i2v"], "status": "ready", "promoted": True}]
    out = tools.run_tool(ctx, session, "make_action_shot", {"ipId": "ip_hero", "action": "sprinting", "model": "wan-i2v-3"})
    assert _job(ctx, sid, out["jobId"])["input"]["model"] == "wan-i2v-3"
    t2v_only = tools.run_tool(ctx, session, "make_action_shot", {"ipId": "ip_hero", "action": "x", "model": "hunyuan-video-2"})
    assert t2v_only["error"] == "bad_args" and "이미지로" in t2v_only["message"]
    spec = next(s for s in tools.TOOL_SPECS if s["name"] == "make_action_shot")["inputSchema"]["json"]
    assert "enum" not in spec["properties"]["model"]


def test_the_image_models_are_the_image_mcps_plus_bedrock(ctx, session, mcp, monkeypatch):
    sid = session["sessionId"]
    mcp.image_models = IMAGE_MODELS + [{"id": "flux2-dev", "label": "FLUX.2 dev"}]  # added on the image MCP later
    out = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "character", "name": "Luna", "description": "a cat",
                                                           "image_model": "flux2-dev"})
    assert out["imageModel"] == "flux2-dev" and _job(ctx, sid, out["jobId"])["input"]["model"] == "flux2-dev"
    bad = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "character", "name": "Luna", "description": "a cat",
                                                           "image_model": "midjourney"})
    assert bad["error"] == "bad_args" and "klein9|krea|flux2-dev|stability-ultra" in bad["message"]
    spec = next(s for s in tools.TOOL_SPECS if s["name"] == "create_ip_asset")["inputSchema"]["json"]
    assert "enum" not in spec["properties"]["image_model"]
    # GET /connections hands the same list to the image dropdown
    monkeypatch.setattr(connections, "list_tools", lambda url, headers, budget=None: [{"name": "list_models"}])
    image = next(c for c in connections.listing(ctx, {"sub": "user-1"})["platform"] if c["id"] == "imagegen")
    assert image["models"] == [{"id": "klein9", "label": "FLUX.2 klein 9B"}, {"id": "krea", "label": "Krea 2 Turbo"},
                               {"id": "flux2-dev", "label": "FLUX.2 dev"}]
    assert len([c for c in mcp.calls if c[0] == "image:list_models"]) == 1  # cached


def test_an_unreadable_image_mcp_keeps_krea_and_klein(ctx, session, mcp, monkeypatch):
    def down(url, body, key):
        if url == mcp_client.IMAGE.url:
            raise RuntimeError("MCP HTTP 502")
        return mcp(url, body, key)
    monkeypatch.setattr(mcp_client, "_post", down)
    out = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "character", "name": "Luna", "description": "a cat",
                                                           "image_model": "klein9"})
    assert out["imageModel"] == "klein9"
    monkeypatch.setattr(connections, "list_tools", lambda url, headers, budget=None: [{"name": "list_models"}])
    image = next(c for c in connections.listing(ctx, {"sub": "user-1"})["platform"] if c["id"] == "imagegen")
    assert "models" not in image  # the dropdown keeps its own fallback until the MCP answers
