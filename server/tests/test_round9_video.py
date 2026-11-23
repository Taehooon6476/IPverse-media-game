"""Video rules of the LTX box and the shot tools.

- A long restyle runs in ~5 s pieces, each anchored on a stylised copy of its own first frame (same style prompt, same
  image seed: the MCP's ltx_restyle_start recipe); the frames two pieces share are dissolved.
- A v2v upscale asks for twice the source on the box's 128 px grid, in pieces that fit one pass, and keeps the
  source's sound.
- A model whose start tool takes no size (Kandinsky) is refused 9:16.
- The boot lines and a restyle's estimate (it waits behind the box's other LTX jobs).
- The MCP has no cancel tool, so 다시 시도 after 중지 takes over the GPU job that kept running."""
import shutil
import statistics
import subprocess

import pytest

from server import jobs, store, tools
from server.providers import mcp_client, mediagen_video as mv
from server.tests.test_restyle_anchor import _edit, _source_shot, ctx, mcps, session  # noqa: F401 (fixtures)
from server.tests.test_restyle_seam import (CDN, SCENE, STYLE, FakeGPUs, _ffmpeg, _info, frame_changes, make_clip,
                                            run_restyle, tone)
from server.tests.test_tools import _job

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")


def _frame(path, n=None) -> bytes:
    """One frame (frame n of a clip, or a still) as 64x36 RGB."""
    vf = (f"select=eq(n\\,{n})," if n is not None else "") + "scale=64:36,format=rgb24"
    return subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-vf", vf, "-frames:v", "1", "-f", "rawvideo", "-"],
                          capture_output=True, check=True).stdout


def _off(a: bytes, b: bytes) -> float:
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


# Every piece of a long restyle is anchored on a repaint of its own first frame

@needs_ffmpeg
def test_each_piece_of_a_long_restyle_is_anchored_on_a_repaint_of_its_own_first_frame(ctx, session, mcps, monkeypatch,
                                                                                       tmp_path):
    gpus = FakeGPUs(ctx, mcps, monkeypatch, tmp_path)
    src_path = tmp_path / "src.mp4"
    src = make_clip(src_path)  # 193 frames, 8.04 s
    out, edit = run_restyle(ctx, session, src, 8, style=STYLE, prompt=f"{STYLE}, {SCENE}")
    sid = session["sessionId"]
    plan = mv.plan_frames(193, 2)
    assert [first for first, _ in plan] == [0, 96]
    # one klein repaint per piece, of that piece's own first frame, same words and same seed
    assert len(gpus.klein) == 2 and len(gpus.restyles) == 2
    assert len({k["seed"] for k in gpus.klein}) == 1 and len({k["prompt"] for k in gpus.klein}) == 1
    for i, (first, _) in enumerate(plan):
        assert gpus.klein[i]["reference_image_urls"] == [f"{CDN}sessions/{sid}/{edit}-p{i}.png"]
        still = tmp_path / f"ref{i}.png"
        still.write_bytes(ctx.s3._store[("test-assets", f"sessions/{sid}/{edit}-p{i}.png")])
        # the source's frame where the piece starts (a frame 12 or 48 away is twice as far off)
        offs = [_off(_frame(still), _frame(src_path, n)) for n in (first, first + 12, abs(first - 12), first + 48)]
        assert offs[0] < 0.6 * min(offs[1:]), offs
        # the piece is anchored on that repaint, not on the faded last frame of the piece before
        assert gpus.restyles[i]["reference_image_url"] == f"https://img.example.com/img-{i + 1}.png"
    # the style leads the restyle prompt and closes it; both pieces share one seed
    for r in gpus.restyles:
        assert r["prompt"].startswith(f"{STYLE}, {SCENE}") and r["prompt"].rstrip(". ").endswith(STYLE + ", every frame")
    assert len({r["seed"] for r in gpus.restyles}) == 1
    # the two repaints differ (the fake tints each its own way): the shared frames dissolve instead of cutting. The
    # whole look change at the join is spread over its 9 frames: no frame carries more than a fifth of it (a cut: all)
    changes = frame_changes(out, tmp_path)
    base = statistics.median(changes)
    window = changes[90:112]
    jump = sum(c - base for c in window if c > base)
    print(f"\nM12 seam: look change {jump:.1f} over the join, largest step {max(window) - base:.1f} "
          f"(clip median {base:.2f}): {[round(c, 1) for c in window]}")
    assert jump > 10 * base  # the repaints do differ, so there is a change to spread
    assert max(window) - base < 0.2 * jump
    assert len(changes) + 1 == 193  # frame for frame the source's length
    assert abs(tone(out, tmp_path) - 440) < 30  # the source's own sound


@needs_ffmpeg
def test_the_pieces_start_together_once_their_anchors_are_drawn(ctx, session, mcps, monkeypatch, tmp_path):
    gpus = FakeGPUs(ctx, mcps, monkeypatch, tmp_path)
    sid = session["sessionId"]
    src, _ = _source_shot(ctx, sid, make_clip(tmp_path / "src.mp4"), seconds=8)
    edit = _edit(ctx, session, src, edit="restyle", style=STYLE, prompt=STYLE)
    jobs.advance_jobs(ctx, sid)  # submit: two klein repaints at once (drawn at once here), then both pieces
    assert len(gpus.klein) == 2 and len(gpus.restyles) == 2  # no piece waits for the one before: one box queue entry each
    provider = mv.MediagenVideoProvider()
    first, second = (dict(store.get_job(ctx, sid, edit), pk=f"SESSION#{sid}") for _ in range(2))
    assert provider.status(first, ctx)[0] == "done" and provider.status(second, ctx)[0] == "done"
    assert len(gpus.restyles) == 2  # nothing started twice


# An upscale makes the clip twice as big and keeps it

class FakeV2V:
    """ltx_v2v_start on the LTX box: snaps the asked size (default: the source's) down to 128 px and center-crops the
    source to it, makes 8k+1 frames and its own soundtrack."""

    def __init__(self, ctx, mcps, monkeypatch, tmp_path):
        self.ctx, self.tmp, self.calls, self.outputs = ctx, tmp_path, [], {}
        mcps.replies.update(ltx_v2v_start=self.start,
                            ltx_get_status=lambda a: {"status": "SUCCEEDED", "url": f"https://media.example.com/{a['job_id']}.mp4"})
        monkeypatch.setattr(mcp_client, "download", lambda url: self.outputs[url])

    def start(self, args):
        i = len(self.calls)
        self.calls.append(args)
        src = self.tmp / f"v2v-src{i}.mp4"
        src.write_bytes(self.ctx.s3._store[("test-assets", args["video_url"][len(CDN):])])
        seconds, sw, sh = _info(src)
        w = max(128, int(args.get("width") or sw) // 128 * 128)
        h = max(128, int(args.get("height") or sh) // 128 * 128)
        n = max(9, round((round(seconds * 24) - 1) / 8) * 8 + 1)
        out = self.tmp / f"v2v-out{i}.mp4"
        _ffmpeg("-i", str(src), "-f", "lavfi", "-i", "sine=frequency=880", "-filter_complex",
                # in RGB, so the crop is the middle (a 4:2:0 crop starts on an even pixel: up to a pixel off it)
                f"[0:v]fps=24,scale={w}:{h}:force_original_aspect_ratio=increase,format=gbrp,crop={w}:{h},setsar=1,"
                "tpad=stop_mode=clone:stop_duration=1[v]", "-map", "[v]", "-map", "1:a", "-frames:v", str(n),
                "-t", f"{n / 24:.4f}", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
                str(out))
        self.outputs[f"https://media.example.com/v2v-{i + 1}.mp4"] = out.read_bytes()
        return {"job_id": f"v2v-{i + 1}", "status": "RUNNING"}


def _run_edit(ctx, sid, edit):
    for _ in range(6):
        jobs.advance_jobs(ctx, sid)
        if _job(ctx, sid, edit)["status"] not in ("queued", "running"):
            break
    done = _job(ctx, sid, edit)
    assert done["status"] == "done", done
    [asset] = [a for a in store.snapshot(ctx, sid)["assets"] if a["assetId"] in done["outputs"]]
    return ctx.s3._store[("test-assets", asset["key"])]


def test_upscale_asks_the_box_for_twice_the_source_on_its_grid():
    assert mv.v2v_dims((704, 1280), 2) == (1408, 2560)
    assert mv.v2v_dims((1280, 704), 1) == (1280, 768)  # nearest the shape on 128 px, not the 640 the box snaps to
    assert mv.v2v_dims((832, 480), 2) == (1664, 1024)


@needs_ffmpeg
def test_an_upscale_comes_back_twice_the_size_with_the_source_s_sound(ctx, session, mcps, monkeypatch, tmp_path):
    box = FakeV2V(ctx, mcps, monkeypatch, tmp_path)
    sid = session["sessionId"]
    src, _ = _source_shot(ctx, sid, make_clip(tmp_path / "src.mp4", frames=121, size="192x320"), aspect="9:16")  # 2x is on the grid, as 704x1280 is
    edit = _edit(ctx, session, src, edit="v2v", task="upscale", prompt="the same shot, sharper")
    out = _run_edit(ctx, sid, edit)
    [call] = box.calls
    assert (call["width"], call["height"]) == mv.v2v_dims((192, 320), 2) == (384, 640)
    assert call["task"] == "upscale" and call["strength"] == 1.0  # the source conditions the output fully
    path = tmp_path / "out.mp4"
    path.write_bytes(out)
    seconds, w, h = _info(path)
    assert (w, h) == (384, 640) and abs(seconds - 121 / 24) < 0.1  # exactly 2x, the source's length
    assert abs(tone(out, tmp_path) - 440) < 30  # an upscale keeps the source's sound
    # the same picture, bigger: against the source scaled 2x it is much closer than what the box made with no size
    # (192x320 snapped down to 128x256 and center-cropped, as 704x1280 became 640x1280)
    big, old = tmp_path / "big.mp4", tmp_path / "old.mp4"
    _ffmpeg("-i", str(tmp_path / "src.mp4"), "-vf", "scale=384:640", "-c:v", "libx264", "-preset", "ultrafast", str(big))
    _ffmpeg("-i", str(tmp_path / "src.mp4"), "-vf", "scale=128:256:force_original_aspect_ratio=increase,crop=128:256",
            "-c:v", "libx264", "-preset", "ultrafast", str(old))
    now, was = _off(_frame(path, 60), _frame(big, 60)), _off(_frame(old, 60), _frame(big, 60))
    print(f"\nM13 frame 60 off the source x2: {now:.1f} (no size asked: {was:.1f})")
    assert now < 0.7 * was


@needs_ffmpeg
def test_an_upscale_larger_than_one_pass_runs_in_pieces(ctx, session, mcps, monkeypatch, tmp_path):
    box = FakeV2V(ctx, mcps, monkeypatch, tmp_path)
    monkeypatch.setattr(mv, "LTX_PASS_PIXEL_FRAMES", 384 * 640 * 70)  # one pass fits ~2.9 s of the 2x clip here
    sid = session["sessionId"]
    # 2x is off the box's grid (as a Wan or Kandinsky shot's is): asked for 384x640, the box crops the source to that
    src, _ = _source_shot(ctx, sid, make_clip(tmp_path / "src.mp4", frames=121, size="176x320"), aspect="9:16")
    edit = _edit(ctx, session, src, edit="v2v", task="upscale", prompt="the same shot, sharper")
    out = _run_edit(ctx, sid, edit)
    assert len(box.calls) == 2 and (box.calls[0]["width"], box.calls[0]["height"]) == (384, 640)
    path = tmp_path / "out.mp4"
    path.write_bytes(out)
    seconds, w, h = _info(path)
    assert (w, h) == (352, 640) and abs(seconds - 121 / 24) < 0.15
    # the box's own two pieces, fitted: its crop of the source is not read as a redraw (which delivers a plain 2x)
    [asset] = [a for a in store.snapshot(ctx, sid)["assets"] if a["assetId"] in _job(ctx, sid, edit)["outputs"]]
    assert asset["meta"].get("pieces") == 2 and "plain" not in asset["meta"], asset["meta"]


@needs_ffmpeg
def test_other_v2v_tasks_come_back_at_the_source_size_with_the_box_s_sound(ctx, session, mcps, monkeypatch, tmp_path):
    box = FakeV2V(ctx, mcps, monkeypatch, tmp_path)
    sid = session["sessionId"]
    src, _ = _source_shot(ctx, sid, make_clip(tmp_path / "src.mp4", frames=121, size="320x176"))
    edit = _edit(ctx, session, src, edit="v2v", task="day_to_night", prompt="the same street at night")
    out = _run_edit(ctx, sid, edit)
    [call] = box.calls
    assert (call["width"], call["height"]) == (384, 256)
    path = tmp_path / "out.mp4"
    path.write_bytes(out)
    assert _info(path)[1:] == (320, 176)
    assert abs(tone(out, tmp_path) - 880) < 40  # the night shot's own generated sound


# A model that takes no size is not asked for 9:16

def test_a_vertical_shot_is_refused_for_a_model_that_takes_no_size(ctx, session, mcps):
    for tool in ("ltx_start_video", "video_start"):
        mcps.replies[tool] = {"job_id": "mg-1", "status": "RUNNING"}
    out = tools.run_tool(ctx, session, "make_video_shot", {"prompt": "snow in a station garden", "aspect_ratio": "9:16",
                                                           "model": "kandinsky-6-0-video-pro"})
    assert out["error"] == "bad_args" and "9:16" in out["message"] and "Kandinsky" in out["message"]
    assert "ltx" in out["message"]  # what can make it
    assert "jobId" in tools.run_tool(ctx, session, "make_video_shot", {
        "prompt": "snow in a station garden", "aspect_ratio": "16:9", "model": "kandinsky-6-0-video-pro"})
    assert "jobId" in tools.run_tool(ctx, session, "make_video_shot", {
        "prompt": "snow in a station garden", "aspect_ratio": "9:16", "model": "ltx"})


# The wait figures

def test_boot_lines_state_the_measured_boot():
    # measured: Kandinsky cold ~1.5 min to its model load and ~2.5 min more to denoising; MiniMax H3 ~1.5 min
    assert mv.PHASES["starting_instance"] == "정지된 GPU 서버 켜는 중 (~2분)"
    assert mv.PHASES["model_loading"] == "GPU 서버에 모델 불러오는 중 (~1–3분)"
    assert not any("10분" in line for line in mv.PHASES.values())


@needs_ffmpeg
def test_a_restyle_s_estimate_counts_the_ltx_jobs_ahead_of_it(ctx, session, mcps, tmp_path):
    sid = session["sessionId"]
    src, _ = _source_shot(ctx, sid, b"not read", seconds=8)
    ahead = jobs.create_job(ctx, sid, "shot", "mediagen_video", {"model": "ltx", "prompt": "x", "aspect_ratio": "9:16",
                                                                 "seconds": 5}, [])
    store.update_job(ctx, sid, ahead["jobId"], status="running", externalId="mg-9")
    jobs.create_job(ctx, sid, "shot", "mediagen_video", {"model": "minimax-h3", "prompt": "x", "seconds": 5}, [])
    out = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src, "edit": "restyle", "style": STYLE,
                                                           "prompt": STYLE})
    # the anchors (~2 min together) and two pieces (~6 min each), then one LTX clip ahead on the box (MiniMax is its own)
    assert out["etaMinutes"] == 2 + 6 * 2 + 6, out


# 다시 시도 after 중지 takes over the GPU job that kept running

def _ltx_shot(ctx, sid):
    return jobs.create_job(ctx, sid, "shot", "mediagen_video", {"model": "ltx", "prompt": "a fox raises a lantern",
                                                                "aspect_ratio": "16:9", "seconds": 5}, [])["jobId"]


def test_a_retry_after_stop_takes_over_the_still_running_gpu_job(ctx, session, mcps, monkeypatch):
    sid = session["sessionId"]
    started = []
    mcps.replies["ltx_start_video"] = lambda a: started.append(a) or {"job_id": f"mg-{len(started)}", "status": "RUNNING"}
    gpu = {"mg-1": {"status": "RUNNING", "phase": "denoising"}}
    mcps.replies["ltx_get_status"] = lambda a: gpu[a["job_id"]]
    monkeypatch.setattr(mcp_client, "download", lambda url: b"MP4")
    job = _ltx_shot(ctx, sid)
    jobs.advance_jobs(ctx, sid)
    assert _job(ctx, sid, job)["externalId"] == "mg-1"
    assert jobs.cancel_job(ctx, sid, job) is True
    assert jobs.retry_job(ctx, sid, job) == [job]
    again = _job(ctx, sid, job)
    assert (again["status"], again["externalId"]) == ("running", "mg-1")  # not queued behind its own first run
    jobs.advance_jobs(ctx, sid)
    # the taken-over run keeps its marker
    assert (_job(ctx, sid, job)["status"], _job(ctx, sid, job)["progress"]) == ("running", "이어받음 · 영상 생성 중")
    gpu["mg-1"] = {"status": "SUCCEEDED", "url": "https://media.example.com/mg-1.mp4"}
    jobs.advance_jobs(ctx, sid)
    assert _job(ctx, sid, job)["status"] == "done" and len(started) == 1  # one GPU run for both tries


def test_a_retry_whose_taken_over_gpu_job_failed_starts_a_fresh_one(ctx, session, mcps):
    sid = session["sessionId"]
    started = []
    mcps.replies["ltx_start_video"] = lambda a: started.append(a) or {"job_id": f"mg-{len(started)}", "status": "RUNNING"}
    gpu = {"mg-1": {"status": "RUNNING"}, "mg-2": {"status": "RUNNING"}}
    mcps.replies["ltx_get_status"] = lambda a: gpu[a["job_id"]]
    job = _ltx_shot(ctx, sid)
    jobs.advance_jobs(ctx, sid)
    jobs.cancel_job(ctx, sid, job)
    jobs.retry_job(ctx, sid, job)
    gpu["mg-1"] = {"status": "FAILED", "error": "CUDA out of memory"}
    jobs.advance_jobs(ctx, sid)  # the stopped run failed after all: the retry is a fresh submit
    jobs.advance_jobs(ctx, sid)
    assert len(started) == 2 and _job(ctx, sid, job)["externalId"] == "mg-2"
    assert _job(ctx, sid, job)["status"] == "running"


def test_a_retry_long_after_stop_starts_a_fresh_gpu_job(ctx, session, mcps):
    sid = session["sessionId"]
    mcps.replies["ltx_start_video"] = {"job_id": "mg-1", "status": "RUNNING"}
    mcps.replies["ltx_get_status"] = {"status": "RUNNING"}
    job = _ltx_shot(ctx, sid)
    jobs.advance_jobs(ctx, sid)
    jobs.cancel_job(ctx, sid, job)
    store.update_job(ctx, sid, job, updatedAt="2020-01-01T00:00:00.000Z")  # stopped long ago: its result may be gone
    jobs.retry_job(ctx, sid, job)
    again = _job(ctx, sid, job)
    assert (again["status"], again["externalId"]) == ("queued", "")
