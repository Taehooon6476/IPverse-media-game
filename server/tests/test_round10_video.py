"""Video edits in pieces.

- Restyle: an anchor only conditions frame 0, and what it does not show comes back photoreal. An i2v source opens
  on its start image and dissolves into the scene, so a piece also starts where the picture leaves its anchor's,
  and a later piece's colours are matched to the piece before over the frames they share.
- Upscale: the box makes 8k+1 frames with made-up ones at the end, so pieces are cut at 8k+1 frames and trimmed to
  the frames they were cut with, the whole to the source's frame count. The estimate is ~9 min a piece.
- A run taken over after a stop keeps its marker while it runs."""
import shutil
import subprocess

import pytest

from server import jobs, prompts, store, tools, video_edit
from server.providers import mcp_client, mediagen_video as mv
from server.tests.test_restyle_anchor import _edit, _source_shot, ctx, mcps, session  # noqa: F401 (fixtures)
from server.tests.test_restyle_seam import CDN, STYLE, FakeGPUs, _ffmpeg, _info, run_restyle
from server.tests.test_round9_video import FakeV2V, _frame, _ltx_shot, _off, _run_edit
from server.tests.test_tools import _job

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")


def opening_on_white(path, frames=193, size="320x176"):
    """A figure on white for 1 s that dissolves over 1 s into a busy scene (testsrc), 24 fps, with a sine soundtrack:
    an i2v shot's opening."""
    w, h = size.split("x")
    _ffmpeg("-f", "lavfi", "-i", f"color=white:size={size}:rate=24:d=3", "-f", "lavfi",
            "-i", f"testsrc=size={size}:rate=24:d=10", "-f", "lavfi", "-i", "sine=frequency=440",
            "-filter_complex", f"[0:v]drawbox=x={int(w) // 3}:y=10:w={int(w) // 4}:h={int(h) - 20}:color=orange:t=fill,"
            "format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]xfade=transition=fade:duration=1:offset=1[v]",
            "-map", "[v]", "-map", "2:a", "-frames:v", str(frames), "-t", f"{frames / 24:.4f}", "-c:v", "libx264",
            "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", str(path))
    return path.read_bytes()


def _hists(path):
    return [mv._hist(t) for t in mv._thumbs(FFMPEG, str(path))]


def _covers(hists, pieces) -> float:
    """The furthest any frame of a piece (up to where the next one starts) is from that piece's first frame."""
    starts = [first for first, _ in pieces] + [len(hists)]
    return max(mv._hist_off(hists[f], hists[a]) for a, b in zip(starts, starts[1:]) for f in range(a, b))


# ── a piece starts where the picture leaves its anchor's ──

@needs_ffmpeg
def test_a_restyle_starts_a_piece_where_the_opening_frame_dissolves_into_the_scene(tmp_path):
    src = tmp_path / "src.mp4"
    opening_on_white(src)
    hists = _hists(src)
    old = mv.plan_frames(193, 2)  # cut by length alone: two ~4 s pieces, piece 0 anchored on the white frame
    cuts = mv.scene_cuts(mv._thumbs(FFMPEG, str(src)))
    pieces = mv.plan_restyle(193, cuts, mv.CHUNK_SEC["ltx_restyle_start"])
    print(f"\nM12 cuts {cuts}, pieces {pieces}, furthest from an anchor {_covers(hists, pieces):.2f} "
          f"(round 9: {_covers(hists, old):.2f})")
    assert len(cuts) == 1 and 44 <= cuts[0] <= 56  # once the 24-48 dissolve has settled, on the 8-frame grid
    # every piece after the dissolve is anchored on a frame that shows what the piece shows
    assert _covers(hists, pieces[1:]) < mv.SCENE_LEAVE < min(mv._hist_off(hists[f], hists[0]) for f in range(48, 96))
    # still frame for frame: neighbours share SEAM frames, every piece but the last is 8k+1 frames long
    for (first, count), (after, _) in zip(pieces, pieces[1:]):
        assert first + count - mv.SEAM == after and count % 8 == 1
    assert pieces[-1][1] is None


@needs_ffmpeg
def test_a_steady_scene_is_cut_as_before(tmp_path):
    src = tmp_path / "src.mp4"
    _ffmpeg("-f", "lavfi", "-i", "testsrc=size=320x176:rate=24", "-frames:v", "193", "-c:v", "libx264", "-preset",
            "ultrafast", "-pix_fmt", "yuv420p", str(src))
    cuts = mv.scene_cuts(mv._thumbs(FFMPEG, str(src)))
    assert cuts == [] and mv.plan_restyle(193, cuts, 5) == mv.plan_frames(193, 2)
    assert mv.plan_restyle(121, [], 5) == [(0, None)]


@needs_ffmpeg
def test_a_restyle_anchors_the_scene_after_the_dissolve_on_its_own_repaint(ctx, session, mcps, monkeypatch, tmp_path):
    gpus = FakeGPUs(ctx, mcps, monkeypatch, tmp_path)
    src_path = tmp_path / "src.mp4"
    out, edit = run_restyle(ctx, session, opening_on_white(src_path), 8, style=STYLE, prompt=STYLE)
    sid = session["sessionId"]
    stage = mv._stage(_job(ctx, sid, edit)) or {}
    assert len(gpus.klein) == len(gpus.restyles) == 3  # the white opening, then the scene in two ~3 s pieces
    # one seed and one style text for every anchor and every piece
    assert len({k["seed"] for k in gpus.klein}) == 1 and len({k["prompt"] for k in gpus.klein}) == 1
    assert len({r["seed"] for r in gpus.restyles}) == 1 and len({r["prompt"] for r in gpus.restyles}) == 1
    hists = _hists(src_path)
    for i in (1, 2):  # the scene's anchors are repaints of scene frames, not of the white opening
        still = tmp_path / f"ref{i}.png"
        still.write_bytes(ctx.s3._store[("test-assets", f"sessions/{sid}/{edit}-p{i}.png")])
        assert mv._hist_off(mv._hist(_frame(still)), hists[150]) < 0.3
        assert mv._hist_off(mv._hist(_frame(still)), hists[0]) > mv.SCENE_LEAVE
    path = tmp_path / "out.mp4"
    path.write_bytes(out)
    assert len(mv._thumbs(FFMPEG, str(path))) == 193 and stage.get("total") in (None, 193)


def _tone_off(out_path, src_path, frames) -> list:
    """Per channel, the result's mean minus the source's over some frames."""
    got, want = mv._thumbs(FFMPEG, str(out_path)), mv._thumbs(FFMPEG, str(src_path))
    a, b = mv._stats([got[f] for f in frames]), mv._stats([want[f] for f in frames])
    return [x[0] - y[0] for x, y in zip(a, b)]


@needs_ffmpeg
def test_the_later_piece_takes_the_earlier_piece_s_colours_at_the_join(ctx, session, mcps, monkeypatch, tmp_path):
    # klein tints each repaint its own way (FakeGPUs): piece 1 comes back in other colours than piece 0
    tints = ("colorchannelmixer=rr=1:gg=.8:bb=.8", "colorchannelmixer=rr=.8:gg=.8:bb=1")
    gpus = FakeGPUs(ctx, mcps, monkeypatch, tmp_path, tints=tints)
    src_path = tmp_path / "src.mp4"
    _ffmpeg("-f", "lavfi", "-i", "testsrc=size=320x176:rate=24", "-f", "lavfi", "-i", "sine=frequency=440",
            "-frames:v", "193", "-t", f"{193 / 24:.4f}", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt",
            "yuv420p", "-c:a", "aac", str(src_path))
    out, _ = run_restyle(ctx, session, src_path.read_bytes(), 8, style=STYLE, prompt=STYLE)
    assert len(gpus.restyles) == 2
    raw = tmp_path / "raw1.mp4"  # what the box made of piece 1, before the join
    raw.write_bytes(gpus.outputs["https://media.example.com/mg-2.mp4"])
    path = tmp_path / "out.mp4"
    path.write_bytes(out)
    before = _tone_off(path, src_path, range(84, 96))  # piece 0 alone
    after = _tone_off(path, src_path, range(106, 118))  # piece 1 alone, past the shared frames
    _ffmpeg("-i", str(src_path), "-vf", "trim=start_frame=96,setpts=PTS-STARTPTS", "-an", "-c:v", "libx264",
            "-preset", "ultrafast", str(tmp_path / "src1.mp4"))
    raw_after = _tone_off(raw, tmp_path / "src1.mp4", range(10, 22))
    gap = sum(abs(x - y) for x, y in zip(before, after))
    raw_gap = sum(abs(x - y) for x, y in zip(before, raw_after))
    print(f"\nM12 tone off the source: piece 0 {[round(v, 1) for v in before]}, piece 1 {[round(v, 1) for v in after]} "
          f"(unmatched {[round(v, 1) for v in raw_after]})")
    assert raw_gap > 20  # the two repaints really differ
    assert gap < 0.25 * raw_gap


# ── an upscale in pieces has the source's frames and timing ──

class PaddingV2V(FakeV2V):
    """Like the real box: a clip of n frames comes back ceil to 8k+1 frames, the extra ones made up (a flat grey
    here) at the end."""

    def start(self, args):
        i = len(self.calls)
        self.calls.append(args)
        src = self.tmp / f"v2v-src{i}.mp4"
        src.write_bytes(self.ctx.s3._store[("test-assets", args["video_url"][len(CDN):])])
        n_in = len(mv._thumbs(FFMPEG, str(src)))
        n = -(-(n_in - 1) // 8) * 8 + 1
        w, h = int(args["width"]) // 128 * 128, int(args["height"]) // 128 * 128
        out = self.tmp / f"v2v-out{i}.mp4"
        _ffmpeg("-i", str(src), "-f", "lavfi", "-i", "sine=frequency=880", "-filter_complex",
                f"[0:v]fps=24,scale={w}:{h},setsar=1,tpad=stop={n - n_in}:color=gray[v]", "-map", "[v]", "-map",
                "1:a", "-frames:v", str(n), "-t", f"{n / 24:.4f}", "-c:v", "libx264", "-preset", "ultrafast",
                "-pix_fmt", "yuv420p", "-c:a", "aac", str(out))
        self.outputs[f"https://media.example.com/v2v-{i + 1}.mp4"] = out.read_bytes()
        return {"job_id": f"v2v-{i + 1}", "status": "RUNNING"}


def test_an_upscale_s_pieces_are_8k_plus_1_frames_and_fit_one_pass():
    ask = mv.v2v_dims((704, 1280), 2)
    # 65 frames at 1408x2560 fit one pass on the box; neighbours share SEAM frames for the join
    assert mv.plan_v2v(121, ask) == [(0, 65), (56, None)]
    assert mv.plan_v2v(193, ask) == [(0, 57), (48, 57), (96, 57), (144, None)]
    assert mv.plan_v2v(121, mv.v2v_dims((1280, 704), 1)) == [(0, None)]  # a same-size task: one pass


@needs_ffmpeg
def test_an_upscale_in_pieces_keeps_the_source_s_frames_and_timing(ctx, session, mcps, monkeypatch, tmp_path):
    box = PaddingV2V(ctx, mcps, monkeypatch, tmp_path)
    monkeypatch.setattr(mv, "LTX_PASS_PIXEL_FRAMES", 384 * 640 * 66)  # two pieces, as 1408x2560 x 121 frames
    sid = session["sessionId"]
    src_path = tmp_path / "src.mp4"
    _ffmpeg("-f", "lavfi", "-i", "testsrc=size=192x320:rate=24", "-f", "lavfi", "-i", "sine=frequency=440",
            "-frames:v", "121", "-af", "atrim=duration=5.01", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt",
            "yuv420p", "-c:a", "aac", str(src_path))  # 121 frames and 5.01 s of sound
    src, _ = _source_shot(ctx, sid, src_path.read_bytes(), aspect="9:16")
    edit = _edit(ctx, session, src, edit="v2v", task="upscale", prompt="the same shot, sharper")
    out = _run_edit(ctx, sid, edit)
    assert len(box.calls) == 2
    path = tmp_path / "out.mp4"
    path.write_bytes(out)
    seconds, w, h = _info(path)
    frames = mv._thumbs(FFMPEG, str(path))
    print(f"\nM13 upscale: {len(frames)} frames, {seconds:.3f} s (source 121, {_info(src_path)[0]:.3f} s)")
    assert (w, h) == (384, 640) and len(frames) == 121  # no padded frames
    assert abs(seconds - _info(src_path)[0]) < 0.05
    big = tmp_path / "big.mp4"
    _ffmpeg("-i", str(src_path), "-vf", "scale=384:640", "-c:v", "libx264", "-preset", "ultrafast", str(big))
    for f in (0, 60, 64, 65, 66, 100, 120):  # every frame is the source's frame at that time: no made-up frame, no lag
        here = _off(_frame(path, f), _frame(big, f))
        assert here < min(_off(_frame(path, f), _frame(big, g)) for g in (f - 4, f + 4) if 0 <= g < 121), f


# ── an upscale's estimate scales with its pieces ──

@pytest.mark.parametrize("aspect,seconds,task,eta", [("9:16", 5, "upscale", 18), ("16:9", 5, "upscale", 18),
                                                     ("16:9", 8, "upscale", 36), ("16:9", 5, "day_to_night", 6)])
def test_a_v2v_s_estimate_counts_its_pieces(ctx, session, mcps, aspect, seconds, task, eta):
    src, _ = _source_shot(ctx, session["sessionId"], b"not read", seconds=seconds, aspect=aspect)
    out = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src, "edit": "v2v", "task": task,
                                                           "prompt": "the same shot"})
    assert out["etaMinutes"] == eta, out  # ~9 min an upscale piece
    assert _job(ctx, session["sessionId"], out["jobId"])["input"]["etaMinutes"] == eta


def test_a_v2v_in_pieces_states_its_own_wait(ctx, session, mcps):
    sid = session["sessionId"]
    src, _ = _source_shot(ctx, sid, b"not read", aspect="9:16")
    job = jobs.create_job(ctx, sid, "shot", "mediagen_video", {"edit": "v2v", "task": "upscale", "model": "ltx",
                                                               "sourceShotJobId": src, "etaMinutes": 18}, [src])
    stage = {"videos": ["a.mp4", "b.mp4"], "size": [1408, 2560], "ask": [1408, 2560], "jobs": ["g1", "g2"]}
    store.update_job(ctx, sid, job["jobId"], status="running", externalId=mv.STAGED + __import__("json").dumps(stage))
    mcps.replies["ltx_get_status"] = lambda a: ({"status": "SUCCEEDED", "url": "https://x/1.mp4"} if a["job_id"] == "g1"
                                                else {"status": "RUNNING", "phase": "denoising"})
    state, text = mv.MediagenVideoProvider().status(dict(_job(ctx, sid, job["jobId"]), pk=f"SESSION#{sid}"), ctx)
    assert (state, text) == ("running", "영상 생성 중 (조각 1/2 완료) · 조각마다 ~9분, 전체 보통 ~18분")


def test_the_agent_hears_an_upscale_takes_about_9_minutes_a_piece():
    for text in (prompts.SYSTEM, video_edit.SPEC["description"]):
        assert f"~{mv.UPSCALE_PIECE_MIN}분" in text and "etaMinutes" in text


# ── a taken-over run keeps saying so ──

def test_a_taken_over_run_keeps_its_marker_while_it_runs(ctx, session, mcps, monkeypatch):
    sid = session["sessionId"]
    mcps.replies["ltx_start_video"] = {"job_id": "mg-1", "status": "RUNNING"}
    gpu = {"status": "RUNNING", "phase": "denoising", "progress": 0.4}
    mcps.replies["ltx_get_status"] = lambda a: gpu
    monkeypatch.setattr(mcp_client, "download", lambda url: b"MP4")
    job = _ltx_shot(ctx, sid)
    jobs.advance_jobs(ctx, sid)
    assert _job(ctx, sid, job)["progress"] == "영상 생성 중 40%"  # an ordinary run: no marker
    jobs.cancel_job(ctx, sid, job)
    jobs.retry_job(ctx, sid, job)
    assert _job(ctx, sid, job)["progress"] == jobs.TAKEN_OVER
    for _ in range(2):
        jobs.advance_jobs(ctx, sid)
        assert _job(ctx, sid, job)["progress"] == "이어받음 · 영상 생성 중 40%"
    gpu.clear()
    gpu.update(status="SUCCEEDED", url="https://media.example.com/mg-1.mp4")
    jobs.advance_jobs(ctx, sid)
    assert _job(ctx, sid, job)["status"] == "done"
