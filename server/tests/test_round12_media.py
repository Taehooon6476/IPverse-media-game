"""Wait copy and joins of media jobs: the agent's 3D times come from server/waits.py and match the job cards
(web/src/types.ts); a restyle's estimate is one figure for the chat, the job and the card; an upscale's pieces share
seam frames and join without a cut. The 3D progress lines are in test_round12_img3d.py."""
import pathlib
import re

import pytest

from server import jobs, prompts, tools, waits
from server.providers import mediagen_video as mv
from server.tests.test_restyle_anchor import _edit, _source_shot, ctx, mcps, session  # noqa: F401 (fixtures)
from server.tests.test_restyle_seam import FFMPEG, STYLE, FakeGPUs, _ffmpeg, _info
from server.tests.test_round9_video import FakeV2V, _off, _run_edit
from server.tests.test_round10_video import opening_on_white
from server.tests.test_tools import _job

needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
WEB_TYPES = pathlib.Path(__file__).resolve().parents[2] / "web" / "src" / "types.ts"


# ── the 3D wait copy, one source ──

def _agent_copy() -> list:
    return [prompts.SYSTEM, *(json_desc for spec in tools.TOOL_SPECS for json_desc in _descs(spec))]


def _descs(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "description" and isinstance(v, str):
                yield v
            else:
                yield from _descs(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _descs(v)


def test_item4_no_agent_copy_says_the_old_3d_or_boot_times():
    for text in _agent_copy():
        assert "부팅 ~10분" not in text and "부팅에 ~10분" not in text and "15–25분" not in text, text[:200]
    render = next(t for t in _agent_copy() if t.startswith("IP의 배경을 지운 그림으로 3D 모델"))
    assert waits.RENDER_3D in render
    assert waits.RENDER_3D in prompts.SYSTEM
    # the chain without an A-pose and a rig has its own total, said first; the steps go by waits.STEP_LABEL
    assert waits.RENDER_3D == ("3D 모델 보통 2–8분(GPU 서버가 꺼져 있으면 켜는 데 ~1분, 준비에 ~3–5분 포함), 3D 회전 영상까지 "
                               "전체 보통 6–15분, 3D용 자세 그림과 움직임 뼈대가 붙는 캐릭터·사람형 적은 9–21분")


def test_item4_the_cards_say_the_same_3d_minutes_as_the_agent():
    """web/src/types.ts JOB_TYPICAL is what the job cards show; the agent's copy is built from waits.THREE_D_TYPICAL."""
    web = WEB_TYPES.read_text(encoding="utf-8")
    for kind, (lo, hi) in waits.THREE_D_TYPICAL.items():
        assert re.search(rf"\b{kind}: '보통 {lo}–{hi}분'", web), kind


def test_item4_the_needs_3d_answer_gives_the_new_total():
    out = tools._needs_3d({"player": {"ipId": "ip_1"}}, {"ip_1": {"ipId": "ip_1", "name": "기사"}}, set(), {})
    assert out["error"] == "needs_3d" and f"전체 보통 {waits.TOTAL}" in out["message"], out
    assert "15–25분" not in out["message"]


# ── the restyle's estimate, one figure for the chat, the job and the card ──

@needs_ffmpeg
def test_item4_a_restyle_whose_scene_change_adds_a_piece_says_the_same_minutes_in_chat_job_and_card(
        ctx, session, mcps, monkeypatch, tmp_path):  # noqa: F811
    """An 8 s shot that opens on white and dissolves into its scene runs as 3 pieces, not the 2 its length gives:
    the estimate counts the pieces it will really run."""
    gpus = FakeGPUs(ctx, mcps, monkeypatch, tmp_path)
    mcps.replies["get_image_status"] = lambda a: {"status": "RUNNING"}
    sid = session["sessionId"]
    src, _ = _source_shot(ctx, sid, opening_on_white(tmp_path / "src.mp4"), seconds=8)
    out = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src, "edit": "restyle", "style": STYLE,
                                                           "prompt": STYLE})
    assert out["etaMinutes"] == mv.ANCHOR_MIN + 3 * mv.PIECE_MIN == 20, out
    assert _job(ctx, sid, out["jobId"])["input"]["etaMinutes"] == 20
    jobs.advance_jobs(ctx, sid)
    assert len(gpus.klein) == 3
    assert _job(ctx, sid, out["jobId"])["progress"].endswith("조각마다 ~6분, 전체 보통 ~20분")


def test_item3_an_upscale_s_pieces_share_seam_frames_and_each_fits_one_pass():
    ask = mv.v2v_dims((704, 1280), 2)  # 1408x2560: at most 65 frames a pass
    assert mv.plan_v2v(121, ask) == [(0, 65), (56, None)]  # 56..64 shared; the last runs 65 frames to the end
    for frames in (121, 193, 241):
        plan = mv.plan_v2v(frames, ask)
        lengths = [count or frames - first for first, count in plan]
        assert max(lengths) <= mv.LTX_PASS_PIXEL_FRAMES / (ask[0] * ask[1]), plan
        for (first, count), (after, _) in zip(plan, plan[1:]):
            assert first + count - mv.SEAM == after and count % 8 == 1, plan
    assert mv.plan_v2v(121, mv.v2v_dims((1280, 704), 1)) == [(0, None)]  # a same-size task: one pass


class RegeneratingV2V(FakeV2V):
    """The real box regenerates each piece on its own, so details change at the join: here every piece comes back
    in its own tint and hue."""
    LOOKS = ("colorchannelmixer=rr=1:gg=.8:bb=.8", "colorchannelmixer=rr=.75:gg=.85:bb=1,hue=h=25")

    def start(self, args):
        out = super().start(args)
        i = len(self.calls) - 1
        url = f"https://media.example.com/v2v-{i + 1}.mp4"
        raw, looked = self.tmp / f"raw{i}.mp4", self.tmp / f"looked{i}.mp4"
        raw.write_bytes(self.outputs[url])
        _ffmpeg("-i", str(raw), "-vf", self.LOOKS[i % 2], "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt",
                "yuv420p", "-c:a", "copy", str(looked))
        self.outputs[url] = looked.read_bytes()
        return out


@needs_ffmpeg
def test_item3_an_upscale_s_join_dissolves_and_matches_colours_and_keeps_the_source_s_frames(
        ctx, session, mcps, monkeypatch, tmp_path):  # noqa: F811
    box = RegeneratingV2V(ctx, mcps, monkeypatch, tmp_path)
    monkeypatch.setattr(mv, "LTX_PASS_PIXEL_FRAMES", 384 * 640 * 66)  # two pieces, as 1408x2560 x 121 frames
    # pieces this far from the source are not delivered (test_round18_video.py): that measure is switched off here,
    # so the join of two pieces that differ is what is delivered and tested
    monkeypatch.setattr(mv, "KEEP_MEAN", float("inf"))
    monkeypatch.setattr(mv, "KEEP_BLOCK_UPSCALE", float("inf"))
    sid = session["sessionId"]
    src_path = tmp_path / "src.mp4"
    _ffmpeg("-f", "lavfi", "-i", "testsrc2=size=192x320:rate=24", "-f", "lavfi", "-i", "sine=frequency=440",
            "-frames:v", "121", "-af", "atrim=duration=5.01", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt",
            "yuv420p", "-c:a", "aac", str(src_path))
    src, _ = _source_shot(ctx, sid, src_path.read_bytes(), aspect="9:16")
    edit = _edit(ctx, session, src, edit="v2v", task="upscale", prompt="the same shot, sharper")
    out = _run_edit(ctx, sid, edit)
    assert len(box.calls) == 2
    path = tmp_path / "out.mp4"
    path.write_bytes(out)
    seconds, w, h = _info(path)
    thumbs = mv._thumbs(FFMPEG, str(path))
    assert (w, h) == (384, 640) and len(thumbs) == 121  # frame-exact: as many frames as the source
    assert abs(seconds - _info(src_path)[0]) < 0.05
    diffs = [_off(a, b) for a, b in zip(thumbs, thumbs[1:])]
    base = sorted(diffs)[len(diffs) // 2]
    seam = max(diffs[54:68])  # around the shared frames 56..64
    # the jump an unblended cut makes: piece 0's last frame against piece 1's next one
    p0, p1 = (mv._thumbs(FFMPEG, str(box.tmp / f"looked{i}.mp4")) for i in (0, 1))
    jump = _off(p0[64], p1[65 - 56])
    print(f"\nitem 3 upscale join: median frame diff {base:.1f}, at the seam {seam:.1f}, an unblended cut {jump:.1f}")
    assert jump > 3 * base  # the two pieces really differ
    assert seam < base + 0.25 * jump, (base, seam, jump)


def test_item4_a_source_that_cannot_be_read_is_estimated_by_its_length(ctx, session, mcps):  # noqa: F811
    src, _ = _source_shot(ctx, session["sessionId"], b"not a video", seconds=8)
    out = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src, "edit": "restyle", "style": STYLE,
                                                           "prompt": STYLE})
    assert out["etaMinutes"] == mv.ANCHOR_MIN + 2 * mv.PIECE_MIN, out
