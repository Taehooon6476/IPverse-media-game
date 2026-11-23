"""A chained restyle's clock and its reported wait, on fake GPU boxes that run real ffmpeg (test_restyle_seam.FakeGPUs)
and the fake MCPs that check every call against the real schemas.

- The join keeps every frame on the source's 24 fps clock: concat wants each piece to start at 0, so a piece whose
  first frame was trimmed must be re-based. Frame times are read with ffprobe (a passthrough frame count misses a gap).
- The wait: the anchors together (~2 min), then ~6 min a piece; the job carries the estimate for its card.
"""
import shutil
import subprocess

import pytest

from server import jobs, prompts, tools, video_edit
from server.providers import mediagen_video as mv
from server.tests.test_restyle_anchor import (Drawing, _edit, _gpu, _image_mcp, _source_shot, ctx, mcps,  # noqa: F401
                                              session)
from server.tests.test_restyle_seam import FFMPEG, STYLE, FakeGPUs, make_clip, run_restyle
from server.tests.test_tools import _job

FFPROBE = shutil.which("ffprobe")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None or FFPROBE is None, reason="ffmpeg/ffprobe not on PATH")


def frame_times(data: bytes, tmp_path) -> tuple:
    """(each video frame's time in s, the video stream's duration in s), from ffprobe."""
    path = tmp_path / "times.mp4"
    path.write_bytes(data)

    def probe(entries):
        out = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", entries, "-of",
                              "csv=p=0", str(path)], capture_output=True, text=True, check=True).stdout
        return [float(v.strip(",")) for v in out.split()]
    return probe("frame=best_effort_timestamp_time"), probe("stream=duration")[0]


# ── the join keeps the source's clock ──

@needs_ffmpeg
@pytest.mark.parametrize("frames,pieces", [(193, 2), (289, 3)])  # 8.04 s and 12.04 s
def test_a_chained_restyle_keeps_every_frame_on_the_sources_24_fps_clock(ctx, session, mcps, monkeypatch, tmp_path,
                                                                         frames, pieces):
    gpus = FakeGPUs(ctx, mcps, monkeypatch, tmp_path)
    src = make_clip(tmp_path / "src.mp4", frames=frames)
    out, _ = run_restyle(ctx, session, src, round(frames / 24), style=STYLE, prompt=STYLE)
    assert len(gpus.restyles) == pieces
    times, seconds = frame_times(out, tmp_path)
    source, source_seconds = frame_times(src, tmp_path)
    off = max(range(len(times)), key=lambda k: abs(times[k] - k / 24))
    print(f"\nR5 {pieces} pieces: {len(times)} frames, {seconds:.6f} s (source {len(source)}, {source_seconds:.6f} s); "
          f"furthest off the 24 fps clock: frame {off} at {times[off]:.6f} s")
    assert len(times) == len(source) == frames  # each join drops exactly its one repeated frame
    assert abs(seconds - source_seconds) < 0.001  # no extra frame's length at a join
    assert abs(times[off] - off / 24) < 0.001, (off, times[off])  # frame k at k/24 s: no held frame at a join


# ── the wait a chained restyle reports ──

@pytest.mark.parametrize("seconds,pieces,eta", [(5, 1, 8), (8, 2, 14), (12, 3, 20)])
def test_the_restyle_result_gives_the_anchor_and_its_pieces_in_turn_as_etaMinutes(ctx, session, mcps, seconds, pieces,
                                                                                    eta):
    src, _ = _source_shot(ctx, session["sessionId"], b"not read", seconds=seconds)
    out = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src, "edit": "restyle", "style": STYLE,
                                                           "prompt": STYLE})
    assert len(mv.plan_pieces(seconds, mv.CHUNK_SEC["ltx_restyle_start"])) == pieces
    # the anchors together (2), then a piece (6) for each piece
    assert out["etaMinutes"] == eta == mv.ANCHOR_MIN + mv.PIECE_MIN * pieces, out


def test_the_restyle_job_carries_its_etaMinutes_for_the_card_before_its_first_running_line(ctx, session, mcps):
    """The queued and submitting lines state no wait, so the job's input keeps the estimate for the web."""
    sid = session["sessionId"]
    src, _ = _source_shot(ctx, sid, b"not read", seconds=8)
    out = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src, "edit": "restyle", "style": STYLE,
                                                           "prompt": STYLE})
    job = _job(ctx, sid, out["jobId"])
    assert job["input"]["etaMinutes"] == out["etaMinutes"] == 14, job["input"]
    assert "etaMinutes" not in mv._edit_args(ctx, job["input"], "videos/src.mp4")  # never sent to the GPU tool


@pytest.mark.parametrize("args,aspect", [
    ({"edit": "restyle", "model": "wan-animate", "style": STYLE}, "16:9"),  # one windowed call: not measured
    ({"edit": "restyle", "style": STYLE}, "9:16"),  # no anchor, one call
])
def test_other_edits_give_no_eta_of_their_own(ctx, session, mcps, args, aspect):
    src, _ = _source_shot(ctx, session["sessionId"], b"not read", seconds=8, aspect=aspect)
    out = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src, "prompt": STYLE, **args})
    assert "jobId" in out and "etaMinutes" not in out, out


@needs_ffmpeg
def test_a_chained_restyles_progress_gives_its_own_wait_on_the_job_card(ctx, session, mcps, tmp_path):
    """The card's own '보통 5–10분' is the web's figure for any shot; the progress line under it is the server's."""
    sid = session["sessionId"]
    src, _ = _source_shot(ctx, sid, make_clip(tmp_path / "src.mp4"), seconds=8)
    edit = _edit(ctx, session, src, edit="restyle", style=STYLE, prompt=STYLE)
    drawing = Drawing()
    _image_mcp(mcps, drawing)
    _gpu(mcps, "ltx_restyle_start", {})
    mcps.replies["ltx_get_status"] = {"status": "RUNNING", "phase": "denoising"}
    wait = " · 조각마다 ~6분, 전체 보통 ~14분"
    jobs.advance_jobs(ctx, sid)
    assert _job(ctx, sid, edit)["progress"] == "화풍 기준 프레임 그리는 중 (0/2)" + wait
    drawing.ready = True
    jobs.advance_jobs(ctx, sid)  # both pieces start
    jobs.advance_jobs(ctx, sid)
    assert _job(ctx, sid, edit)["progress"] == "영상 생성 중 (조각 0/2 완료)" + wait


def test_the_agent_tells_an_anchor_and_a_piece_each_from_etaMinutes():
    """Every piece has its own anchor, and the pieces do not chain on the one before."""
    [rule] = [line for line in prompts.SYSTEM.splitlines() if line.lstrip().startswith("- restyle:")]
    spec = video_edit.SPEC["description"]
    for text in (rule, spec):
        assert "etaMinutes" in text and ("앞선" in text or "먼저 올라간" in text), text
        assert f"모두 ~{mv.ANCHOR_MIN}분" in text and f"조각마다 ~{mv.PIECE_MIN}분" in text, text
        assert "마지막 프레임에 이어" not in text and "1–3분" not in text, text
