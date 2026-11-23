"""A restyle is anchored on a klein9 repaint of the clip's first frame (the MCP's recipe for a strong art style); a clip
longer than ~5 s runs in ~5 s pieces, each on its own anchor, and an inpaint longer than 15 s in pieces too.

The fake MCPs answer tools/list with the real input schemas (mcp_schemas.json) and reject any call that does not fit
them. ffmpeg runs for real on small generated clips."""
import json
import os
import shutil
import subprocess

import pytest

from server import jobs, store, tools
from server.providers import ffmpeg, mcp_client, mediagen_video as mv
from server.tests.conftest import FakeS3, FakeTable, make_ctx
from server.tests.test_tools import _add_ip, _job, _session
from server.tests.test_video_edit import MODELS, TASKS

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
with open(os.path.join(os.path.dirname(__file__), "mcp_schemas.json")) as f:
    SCHEMAS = json.load(f)
_TYPES = {"string": str, "number": (int, float), "integer": int, "array": list, "boolean": bool, "null": type(None)}


def fits(schema: dict, args: dict) -> None:
    """The call matches the tool's real input schema: required present, no unknown names, JSON types right."""
    props = schema.get("properties", {})
    missing = set(schema.get("required", [])) - set(args)
    assert not missing, f"missing {missing} in {args}"
    for name, value in args.items():
        assert name in props, f"{name!r} is not a parameter ({sorted(props)})"
        kinds = [o.get("type") for o in props[name].get("anyOf", [props[name]])]
        assert any(isinstance(value, _TYPES[k]) and not (isinstance(value, bool) and k in ("number", "integer"))
                   for k in kinds), f"{name}={value!r} is not {kinds}"


class FakeMCPs:
    """mcp_client._post for both proxies. Every tools/call is checked against the real schema. replies: tool name →
    a result dict or a callable(args) → result dict. calls / image_calls: (tool, arguments) in order."""

    def __init__(self):
        self.replies, self.calls, self.image_calls = {}, [], []

    def __call__(self, url, body, key):
        image = url == mcp_client.IMAGE.url
        assert image or url == mcp_client.VIDEO.url
        schemas = SCHEMAS["image" if image else "video"]
        if body["method"] == "tools/list":
            return {"jsonrpc": "2.0", "id": 1, "result": {"tools": [{"name": n, "inputSchema": s} for n, s in schemas.items()]}}
        name, args = body["params"]["name"], body["params"]["arguments"]
        fits(schemas[name], args)
        (self.image_calls if image else self.calls).append((name, args))
        if name == "list_video_models":
            out = {"models": MODELS}
        elif name == "ltx_list_tasks":
            out = {"tasks": TASKS}
        else:
            reply = self.replies[name]
            out = reply(args) if callable(reply) else reply
        return {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": json.dumps(out)}]}}

    def starts(self, tool=None):
        return [(n, a) for n, a in self.calls if n not in ("list_video_models", "ltx_list_tasks")
                and not n.endswith("get_status") and (tool is None or n == tool)]


@pytest.fixture
def mcps(monkeypatch):
    monkeypatch.setattr(mv, "_catalog", {})
    fake = FakeMCPs()
    monkeypatch.setattr(mcp_client, "_post", fake)
    return fake


@pytest.fixture
def ctx():
    return make_ctx(table=FakeTable(), s3=FakeS3())


@pytest.fixture
def session(ctx):
    return _session(ctx)


@pytest.fixture(scope="module")
def clip(tmp_path_factory):
    """clip(seconds, size) → a real mp4 whose frames differ over time (testsrc draws a running counter), with audio.
    Made once per module: every ffmpeg start costs ~0.7 s."""
    made = {}

    def make(seconds, size="320x176"):
        if (seconds, size) not in made:
            path = tmp_path_factory.mktemp("clips") / f"{seconds}-{size}.mp4"
            subprocess.run([FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=24:duration={seconds}",
                            "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-c:v", "libx264", "-preset",
                            "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)], check=True)
            made[(seconds, size)] = path.read_bytes()
        return made[(seconds, size)]
    return make


def _seconds(data: bytes, tmp_path) -> float:
    path = tmp_path / "probe.mp4"
    path.write_bytes(data)
    return ffmpeg.parse_ffmpeg_duration(subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)],
                                                       capture_output=True, text=True).stderr)


def _source_shot(ctx, sid, video: bytes, seconds=5, aspect="16:9", ip_id="ip_hero"):
    """A finished source shot whose mp4 is in the (fake) bucket."""
    job = jobs.create_job(ctx, sid, "shot", "mediagen_video", {"ipId": ip_id, "imageKey": f"sessions/{sid}/{ip_id}.jpg",
                                                               "prompt": "sprinting with a blaster", "model": "ltx",
                                                               "aspect_ratio": aspect, "seconds": seconds}, [])
    key = f"sessions/{sid}/src-{job['jobId']}.mp4"
    ctx.s3._store[("test-assets", key)] = video
    asset = store.put_asset(ctx, sid, {"kind": "shot", "key": key, "contentType": "video/mp4", "ipId": ip_id,
                                       "jobId": job["jobId"]})
    store.update_job(ctx, sid, job["jobId"], status="done", outputs=[asset["assetId"]])
    return job["jobId"], key


def _edit(ctx, session, src, **args):
    out = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src, **args})
    assert "jobId" in out, out
    return out["jobId"]


def _drawn(job_id):
    return {"status": "SUCCEEDED", "url": f"https://img.example.com/{job_id}.png"}


def _image_mcp(mcps, outcome=_drawn):
    """klein9 on the image MCP: every start gets its own job; get_image_status answers `outcome(job_id)`."""
    started = []

    def start(args):
        started.append(args)
        return {"job_id": f"img-{len(started)}", "status": "RUNNING"}
    mcps.replies["start_image"] = start
    mcps.replies["get_image_status"] = lambda args: outcome(args["job_id"])
    return started


class Drawing:
    """An anchor outcome the test flips: RUNNING until `ready`."""

    def __init__(self):
        self.ready = False

    def __call__(self, job_id):
        return _drawn(job_id) if self.ready else {"status": "RUNNING"}


def _gpu(mcps, tool, results):
    """An edit tool whose jobs finish at once; results: MCP job id → mp4 URL."""
    def start(args):
        job_id = f"mg-{len(results) + 1}"
        results[job_id] = f"https://media.example.com/{job_id}.mp4"
        return {"job_id": job_id, "status": "RUNNING"}
    mcps.replies[tool] = start
    status = "wan_restyle_get_status" if tool == "wan_restyle_start" else "ltx_get_status"
    mcps.replies[status] = lambda args: {"status": "SUCCEEDED", "url": results[args["job_id"]]}


# ── the style anchor ──

@needs_ffmpeg
def test_a_restyle_starts_from_a_klein_repaint_of_the_shots_first_frame(ctx, session, mcps, clip, tmp_path,
                                                                        monkeypatch):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    src, src_key = _source_shot(ctx, sid, clip(5))
    edit = _edit(ctx, session, src, edit="restyle", style="watercolor painting, soft paper texture",
                 prompt="watercolor painting, soft paper texture, a girl sprinting")
    drawing = Drawing()
    klein = _image_mcp(mcps, drawing)
    results = {}
    _gpu(mcps, "ltx_restyle_start", results)
    monkeypatch.setattr(mcp_client, "download", lambda url: clip(5))

    jobs.advance_jobs(ctx, sid)  # submit: the first frame goes up, klein9 repaints it; no GPU video work yet
    [anchor] = klein
    frame_key = f"sessions/{sid}/{edit}-p0.png"
    assert anchor["model"] == "klein9" and anchor["reference_image_urls"] == [f"https://cdn.example.com/{frame_key}"]
    assert anchor["prompt"].startswith("watercolor painting, soft paper texture") and "composition" in anchor["prompt"]
    assert ctx.s3._store[("test-assets", frame_key)].startswith(b"\x89PNG")
    assert mcps.starts("ltx_restyle_start") == []
    job = _job(ctx, sid, edit)
    assert job["status"] == "running" and job["progress"] == "화풍 기준 프레임 그리는 중 (0/1)"

    drawing.ready = True
    jobs.advance_jobs(ctx, sid)  # the anchor is done: the restyle starts on the whole 5 s clip, anchored on it
    [(_, restyle)] = mcps.starts("ltx_restyle_start")
    assert restyle == {"video_url": f"https://cdn.example.com/{src_key}", "prompt": "watercolor painting, soft paper "
                       "texture, a girl sprinting. The whole clip stays watercolor painting, soft paper texture, every "
                       "frame.", "width": 1152, "height": 640, "control": "depth", "strength": 1.0,
                       "seed": anchor["seed"], "reference_image_url": "https://img.example.com/img-1.png"}
    assert (_job(ctx, sid, edit)["status"], _job(ctx, sid, edit)["progress"]) == ("running", "제출됨")

    jobs.advance_jobs(ctx, sid)  # the restyle lands as a shot of the same IP
    done = _job(ctx, sid, edit)
    assert done["status"] == "done", done
    [asset] = [a for a in store.snapshot(ctx, sid)["assets"] if a["assetId"] in done["outputs"]]
    assert (asset["kind"], asset["ipId"]) == ("shot", "ip_hero")
    assert asset["meta"]["anchors"] == ["https://img.example.com/img-1.png"]
    assert abs(_seconds(ctx.s3._store[("test-assets", asset["key"])], tmp_path) - 5) < 0.2  # fitted to the source
    assert len(klein) == 1 and len(mcps.starts("ltx_restyle_start")) == 1  # nothing ran twice


@needs_ffmpeg
def test_a_restyle_longer_than_5_s_runs_in_5_s_pieces_each_on_its_own_anchor_and_comes_back_whole(
        ctx, session, mcps, clip, tmp_path, monkeypatch):
    """Every piece is anchored on a klein repaint of its own first frame (the previous piece's last frame fades to
    photoreal), and all pieces start together."""
    sid = session["sessionId"]
    src, _ = _source_shot(ctx, sid, clip(12), seconds=12)
    edit = _edit(ctx, session, src, edit="restyle", style="watercolor painting", prompt="watercolor painting")
    klein = _image_mcp(mcps)
    pieces = {}  # MCP job id → the piece it was given: the fake box gives it back as it is

    def start(args):
        job_id = f"mg-{len(pieces) + 1}"
        pieces[job_id] = args["video_url"][len("https://cdn.example.com/"):]
        return {"job_id": job_id, "status": "RUNNING"}
    mcps.replies["ltx_restyle_start"] = start
    mcps.replies["ltx_get_status"] = lambda a: {"status": "SUCCEEDED", "url": f"https://media.example.com/{a['job_id']}"}
    monkeypatch.setattr(mcp_client, "download", lambda url: ctx.s3._store[("test-assets", pieces[url.rsplit("/", 1)[1]])])

    jobs.advance_jobs(ctx, sid)  # three repaints (drawn at once here), then all three pieces start in the same pass
    # 288 frames: 0-104, 96-192 and 184 to the end; neighbours share 9 frames, dissolved at the join
    assert mv.plan_frames(288, 3) == [(0, 105), (96, 97), (184, None)]
    base = f"https://cdn.example.com/sessions/{sid}/{edit}"
    assert [k["reference_image_urls"] for k in klein] == [[f"{base}-p{i}.png"] for i in range(3)]
    assert len({k["seed"] for k in klein}) == 1
    cut = [ctx.s3._store[("test-assets", f"sessions/{sid}/{edit}-p{i}.mp4")] for i in range(3)]
    assert [round(_seconds(c, tmp_path), 2) for c in cut] == [4.38, 4.04, 4.33]  # 105, 97 and 104 frames
    starts = [a for _, a in mcps.starts("ltx_restyle_start")]
    assert [(a["video_url"], a["reference_image_url"]) for a in starts] == [
        (f"{base}-p{i}.mp4", f"https://img.example.com/img-{i + 1}.png") for i in range(3)]

    jobs.advance_jobs(ctx, sid)  # all three landed: joined into one 12 s shot
    done = _job(ctx, sid, edit)
    assert done["status"] == "done", done
    [asset] = [a for a in store.snapshot(ctx, sid)["assets"] if a["assetId"] in done["outputs"]]
    assert abs(_seconds(ctx.s3._store[("test-assets", asset["key"])], tmp_path) - 12) < 0.2
    assert (len(asset["meta"]["anchors"]), asset["meta"]["pieces"]) == (3, 3)
    assert len(klein) == 3 and len(starts) == 3  # nothing ran twice


@needs_ffmpeg
def test_the_wan_restyle_is_anchored_too_in_one_windowed_call(ctx, session, mcps, clip, tmp_path, monkeypatch):
    sid = session["sessionId"]
    src, src_key = _source_shot(ctx, sid, clip(12), seconds=12)
    edit = _edit(ctx, session, src, edit="restyle", model="wan-animate", style="hand-painted watercolor",
                 prompt="hand-painted watercolor")
    klein = _image_mcp(mcps)
    _gpu(mcps, "wan_restyle_start", {})
    monkeypatch.setattr(mcp_client, "download", lambda url: clip(12))
    jobs.advance_jobs(ctx, sid)  # the anchor (drawn at once here), then the restyle starts
    jobs.advance_jobs(ctx, sid)  # it lands
    assert len(klein) == 1  # Wan windows the clip itself: one call, anchored on the clip's first frame
    [(_, wan)] = mcps.starts("wan_restyle_start")
    assert wan == {"video_url": f"https://cdn.example.com/{src_key}", "prompt": mv.restyle_prompt(
                       {"prompt": "hand-painted watercolor", "style": "hand-painted watercolor"}),
                   "width": 880, "height": 480, "control": "depth", "strength": 1.0, "seed": klein[0]["seed"],
                   "reference_image_url": "https://img.example.com/img-1.png"}
    done = _job(ctx, sid, edit)
    assert done["status"] == "done", done
    assert abs(_seconds(ctx.s3._store[("test-assets", f"sessions/{sid}/{done['outputs'][0]}.mp4")], tmp_path) - 12) < 0.2


@needs_ffmpeg
def test_overlapping_polls_start_the_anchored_restyle_once(ctx, session, mcps, clip):
    sid = session["sessionId"]
    src, _ = _source_shot(ctx, sid, clip(5))
    edit = _edit(ctx, session, src, edit="restyle", style="watercolor painting", prompt="watercolor painting")
    drawing = Drawing()
    _image_mcp(mcps, drawing)
    _gpu(mcps, "ltx_restyle_start", {})
    mcps.replies["ltx_get_status"] = {"status": "RUNNING", "phase": "denoising"}
    jobs.advance_jobs(ctx, sid)  # anchors requested
    drawing.ready = True
    provider = mv.MediagenVideoProvider()
    first, second = (dict(store.get_job(ctx, sid, edit), pk=f"SESSION#{sid}") for _ in range(2))  # both loaded now
    assert provider.status(first, ctx)[0] == "running"
    assert provider.status(second, ctx) == ("running", "영상 편집 시작 중")  # the other poll claimed the start
    assert len(mcps.starts("ltx_restyle_start")) == 1
    later = dict(store.get_job(ctx, sid, edit), pk=f"SESSION#{sid}")
    assert provider.status(later, ctx) == ("running", "영상 생성 중")  # polls the started restyle, starts nothing new
    assert len(mcps.starts("ltx_restyle_start")) == 1


@needs_ffmpeg
def test_a_style_anchor_that_could_not_be_drawn_fails_the_restyle_with_its_reason(ctx, session, mcps, clip):
    sid = session["sessionId"]
    src, _ = _source_shot(ctx, sid, clip(5))
    edit = _edit(ctx, session, src, edit="restyle", style="watercolor painting", prompt="watercolor painting")
    _image_mcp(mcps, lambda j: {"status": "FAILED", "error": "RuntimeError: GPU server busy with other jobs for 10 "
                                                              "minutes; try again later"})
    jobs.advance_jobs(ctx, sid)
    jobs.advance_jobs(ctx, sid)
    job = _job(ctx, sid, edit)
    assert job["status"] == "failed" and job["error"].startswith("화풍 기준 프레임(FLUX.2 klein)을 그리지 못했습니다")
    assert "GPU server busy" in job["error"] and mcps.starts("ltx_restyle_start") == []


@needs_ffmpeg
def test_a_vertical_restyle_runs_without_an_anchor(ctx, session, mcps, clip):
    """ponytail: the image MCP draws 1216x688 only, so a 9:16 clip has no matching anchor (prompt only)."""
    sid = session["sessionId"]
    src, src_key = _source_shot(ctx, sid, clip(5, "176x320"), aspect="9:16")
    _edit(ctx, session, src, edit="restyle", style="watercolor painting", prompt="watercolor painting")
    klein = _image_mcp(mcps)
    _gpu(mcps, "ltx_restyle_start", {})
    jobs.advance_jobs(ctx, sid)
    assert klein == [] and mcps.starts("ltx_restyle_start") == [
        ("ltx_restyle_start", {"video_url": f"https://cdn.example.com/{src_key}", "prompt": "watercolor painting. The "
                               "whole clip stays watercolor painting, every frame.", "width": 640, "height": 1152,
                               "control": "depth", "strength": 1.0})]


# ── inpaint (and every other start) against the real schema ──

@needs_ffmpeg
def test_inpaint_of_a_clip_longer_than_15_s_runs_in_pieces_and_is_joined(ctx, session, mcps, clip, tmp_path,
                                                                          monkeypatch):
    sid = session["sessionId"]
    src, _ = _source_shot(ctx, sid, clip(20), seconds=20)
    edit = _edit(ctx, session, src, edit="inpaint", task="water", keep_level=0.3, prompt="heavy rain, the same girl")
    _gpu(mcps, "ltx_inpaint_start", {})
    monkeypatch.setattr(mcp_client, "download", lambda url: clip(10))  # each piece comes back as a 10 s clip
    jobs.advance_jobs(ctx, sid)  # two 10 s pieces start at once (no anchor for inpaint)
    starts = [a for _, a in mcps.starts("ltx_inpaint_start")]
    assert [a["video_url"] for a in starts] == [f"https://cdn.example.com/sessions/{sid}/{edit}-p{i}.mp4" for i in range(2)]
    assert all((a["task"], a["keep_level"], a["prompt"]) == ("water", 0.3, "heavy rain, the same girl") for a in starts)
    jobs.advance_jobs(ctx, sid)
    done = _job(ctx, sid, edit)
    assert done["status"] == "done", done
    [asset] = [a for a in store.snapshot(ctx, sid)["assets"] if a["assetId"] in done["outputs"]]
    assert abs(_seconds(ctx.s3._store[("test-assets", asset["key"])], tmp_path) - 20) < 0.2
    assert asset["meta"]["pieces"] == 2 and "anchors" not in asset["meta"]


@pytest.mark.parametrize("args", [
    {"edit": "inpaint", "prompt": "heavy rain"},  # the MCP's default task (water)
    {"edit": "inpaint", "prompt": "winter", "task": "relight", "keep_level": 0.55},
    # a v2v reads its source for the size first: test_round9_video.py runs it on real clips
])
def test_short_inpaint_and_v2v_are_one_call_that_fits_the_real_schema(ctx, session, mcps, args):
    sid = session["sessionId"]
    src, src_key = _source_shot(ctx, sid, b"not read: no ffmpeg work for these")
    tool = "ltx_inpaint_start" if args["edit"] == "inpaint" else "ltx_v2v_start"
    mcps.replies[tool] = {"job_id": "mg-1", "status": "RUNNING"}
    _edit(ctx, session, src, **args)
    jobs.advance_jobs(ctx, sid)
    [(_, sent)] = mcps.starts(tool)  # fits() already checked it against the MCP's own schema
    assert sent == {"video_url": f"https://cdn.example.com/{src_key}", "prompt": args["prompt"],
                    **{k: args[k] for k in ("task", "keep_level") if k in args}}


def test_every_shot_start_fits_the_real_schema(ctx, session, mcps):
    sid = session["sessionId"]
    _add_ip(ctx, sid, "ip_hero", b"HERO")
    _add_ip(ctx, sid, "ip_rival", b"RIVAL")
    for tool in ("ltx_start_video", "minimax_h3_start_video", "video_start"):
        mcps.replies[tool] = {"job_id": "mg-1", "status": "RUNNING"}
    for args in ({"prompt": "a neon skyline"}, {"ipId": "ip_hero", "prompt": "sprinting", "duration": 12},
                 {"ipId": "ip_hero", "last_ip_id": "ip_rival", "model": "minimax-h3", "prompt": "she turns into him"},
                 {"ipId": "ip_hero", "model": "kandinsky-6-0-video-pro", "prompt": "waving"}):
        assert "jobId" in tools.run_tool(ctx, session, "make_video_shot", {"aspect_ratio": "16:9", **args})
    jobs.advance_jobs(ctx, sid)
    assert sorted(n for n, _ in mcps.starts()) == ["ltx_start_video", "ltx_start_video", "minimax_h3_start_video",
                                                   "video_start"]
