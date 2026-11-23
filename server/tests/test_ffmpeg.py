import os
import shutil
import subprocess
import tempfile
import pytest


FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


def test_grade_filter_names():
    from server.providers.ffmpeg import grade_filter
    # teal-orange has colorbalance and eq
    f = grade_filter("teal-orange")
    assert f is not None
    assert "colorbalance" in f
    assert "eq" in f

    # warm: colorbalance + eq
    f = grade_filter("warm")
    assert f is not None
    assert "colorbalance" in f

    # noir: hue + eq
    f = grade_filter("noir")
    assert f is not None
    assert "hue" in f

    # none → None (null)
    assert grade_filter("none") is None


def test_grade_filter_exact_values():
    from server.providers.ffmpeg import grade_filter
    assert grade_filter("teal-orange") == (
        "colorbalance=rs=.08:bs=-.08:rm=.02:bm=-.02:rh=-.05:bh=.08,"
        "eq=contrast=1.08:saturation=1.15"
    )
    assert grade_filter("warm") == (
        "colorbalance=rs=.1:bs=-.1,"
        "eq=brightness=0.02:saturation=1.1"
    )
    assert grade_filter("noir") == "hue=s=0,eq=contrast=1.25:brightness=-0.03"


def test_build_shot_cmd_includes_grade():
    from server.providers.ffmpeg import build_shot_cmd
    cmd = build_shot_cmd("ffmpeg", "in.mp4", "out.mp4", "teal-orange")
    vf = cmd[cmd.index("-vf") + 1]
    assert "colorbalance" in vf
    assert "scale=1280:720" in vf
    assert "crop=1280:720" in vf
    assert "fps=24" in vf
    assert "-an" in cmd
    assert "libx264" in cmd


def test_build_shot_cmd_no_grade_for_none():
    from server.providers.ffmpeg import build_shot_cmd
    cmd = build_shot_cmd("ffmpeg", "in.mp4", "out.mp4", "none")
    vf = cmd[cmd.index("-vf") + 1]
    # No leading colorbalance for none
    assert not vf.startswith("colorbalance")
    assert "scale=1280:720" in vf


def test_build_concat_cmd():
    from server.providers.ffmpeg import build_concat_cmd
    cmd = build_concat_cmd("ffmpeg", "list.txt", "out.mp4")
    assert "-f" in cmd
    assert "concat" in cmd
    assert "-safe" in cmd
    assert "list.txt" in cmd
    assert "-c" in cmd and "copy" in cmd
    assert "+faststart" in " ".join(cmd)


def test_shorts_shots_keep_the_whole_frame_over_a_blurred_fill():
    """Each shorts shot is fitted whole into 720x1280 over a blurred copy of itself, never center-cropped."""
    from server.providers.ffmpeg import SHORTS, build_shot_cmd
    cmd = build_shot_cmd("ffmpeg", "in.mp4", "out.mp4", "teal-orange", SHORTS)
    vf = cmd[cmd.index("-vf") + 1]
    assert vf.startswith("colorbalance")  # graded like the trailer
    assert "force_original_aspect_ratio=decrease" in vf and "overlay=(W-w)/2:(H-h)/2" in vf
    assert "boxblur" in vf and "crop=ih*9/16" not in vf
    assert "fps=24" in vf and "-r" in cmd  # one timebase with the cards for the copy-concat


FONT_CANDIDATES = [os.environ.get("FONT_PATH", ""), "/opt/fonts/NotoSansKR-Bold.otf",
                   os.path.join(os.path.dirname(__file__), "..", "..", "build", "ffmpeg-layer", "fonts", "NotoSansKR-Bold.otf")]
LAYER_FONT = next((p for p in FONT_CANDIDATES if p and os.path.exists(p)), None)  # the Lambda layer's font


@pytest.mark.parametrize("size", [(1280, 720), (720, 1280)])
@pytest.mark.parametrize("title,subtitle", [
    ("아리: 스타 스카우트", "청록빛 정찰병의 첫 출동"),  # a title too wide at 72 px for a narrow frame
    ("그날 밤, 청록빛 정찰병 아리는 마지막 신호를 쫓아 폐허가 된 성계로 홀로 떠났다", ""),  # a 60-character story beat
    ("가" * 120, "부" * 80),  # no spaces at all
    ("WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW MMMMMMMMMMMMMMMM", "Ari's 100% run: \\ back"),
])
def test_card_text_fits_the_frame_for_any_title_length(size, title, subtitle):
    from server.providers.ffmpeg import CARD_MARGIN, card_lines, text_em
    w, h = size
    rows = card_lines(title, subtitle, size)
    assert 1 <= len(rows) <= 6
    assert "".join(t for t, _, _ in rows).replace(" ", "") == (title + subtitle).replace(" ", "")  # nothing dropped
    for text, px, y in rows:
        assert text_em(text) * px <= w * (1 - 2 * CARD_MARGIN), (text, px)
        assert px <= 72 and px / 2 < y < h - px / 2
    assert [y for _, _, y in rows] == sorted(y for _, _, y in rows)


def test_short_titles_keep_their_size():
    from server.providers.ffmpeg import card_lines
    assert card_lines("아리: 스타 스카우트", "청록빛 정찰병의 첫 출동", (1280, 720)) == [
        ("아리: 스타 스카우트", 72, 320), ("청록빛 정찰병의 첫 출동", 36, 400)]  # the old 16:9 layout
    assert [(t, px) for t, px, _ in card_lines("아리: 스타 스카우트", "", (720, 1280))] == [("아리: 스타 스카우트", 66)]


@pytest.mark.skipif(LAYER_FONT is None, reason="needs NotoSansKR-Bold.otf (FONT_PATH or build/ffmpeg-layer/fonts)")
def test_text_width_estimate_covers_the_layer_font():
    """text_em sizes card text without a font library at runtime: it must never under-count the real glyphs."""
    import string
    fontTools = pytest.importorskip("fontTools.ttLib")
    from server.providers.ffmpeg import text_em
    font = fontTools.TTFont(LAYER_FONT)
    cmap, hmtx, upm = font.getBestCmap(), font["hmtx"], font["head"].unitsPerEm
    for ch in string.printable.strip() + " 가힣아리스타카우트청록빛·…—“”’éÆ©×":
        if ord(ch) in cmap:
            assert text_em(ch) >= hmtx[cmap[ord(ch)]][0] / upm, ch


def test_card_text_is_read_from_files_as_typed(tmp_path):
    """Inline drawtext text lost apostrophes and backslashes and expanded %{...}; the card reads files instead."""
    from server.providers.ffmpeg import build_card_cmd
    dst = str(tmp_path / "card.mp4")
    cmd = build_card_cmd("ffmpeg", dst, "Ari's 100% %{localtime} \\ run", "부제", 2.0, "/tmp/no-such-font.otf", "black")
    vf = cmd[cmd.index("-vf") + 1]
    files = [part.split("textfile=")[1].split(":")[0] for part in vf.split(",") if "textfile=" in part]
    assert [open(f, encoding="utf-8").read() for f in files] == ["Ari's 100% %{localtime} \\ run", "부제"]
    assert vf.count("expansion=none") == 2 and "text='" not in vf
    assert "color=c=black:s=1280x720:r=24:d=2.0" in cmd


@pytest.mark.skipif(FFMPEG is None or LAYER_FONT is None, reason="needs ffmpeg and the layer's NotoSansKR font")
def test_rendered_shorts_and_trailer_cards_are_not_clipped(tmp_path):
    """REAL ffmpeg render with the Lambda layer's font: no card text touches a frame edge, the shorts are 720x1280
    and as long as the trailer."""
    from server.providers.ffmpeg import render_trailer
    wide, tall = str(tmp_path / "wide.mp4"), str(tmp_path / "tall.mp4")
    for path, size in ((wide, "1280x720"), (tall, "704x1280")):
        subprocess.run([FFMPEG, "-y", "-f", "lavfi", "-i", f"color=c=gray:s={size}:r=24:d=1", "-c:v", "libx264",
                        "-preset", "ultrafast", "-pix_fmt", "yuv420p", path], check=True, capture_output=True)
    beat = "그날 밤, 청록빛 정찰병 아리는 마지막 신호를 쫓아 폐허가 된 성계로 홀로 떠났다"
    res = render_trailer(FFMPEG, FFPROBE or "", LAYER_FONT, str(tmp_path), [wide, tall], "아리: 스타 스카우트",
                         "청록빛 정찰병의 첫 출동", "none", True, {1: beat})
    # title 0-2.5 s, wide shot 2.5-3.5, beat card 3.5-5.5, tall shot 5.5-6.5, end card 6.5-8.5
    for path, (w, h) in ((res["shorts"], (720, 1280)), (res["trailer"], (1280, 720))):
        for t in (1.2, 4.5, 7.5):
            left, right = _text_margins(path, t, w, h)
            assert left >= 0.05 * w and right >= 0.05 * w, (path, t, left, right)
    assert _probe_size(res["shorts"]) == (720, 1280)
    assert abs(_duration(res["shorts"]) - res["seconds"]) < 0.1


def _text_margins(path, t, w, h):
    """Columns left of the leftmost and right of the rightmost bright (text) pixel of the frame at t."""
    raw = subprocess.run([FFMPEG, "-v", "error", "-ss", str(t), "-i", path, "-frames:v", "1", "-f", "rawvideo",
                          "-pix_fmt", "gray", "-"], check=True, capture_output=True).stdout
    cols = [x for x in range(w) if any(raw[y * w + x] > 128 for y in range(0, h, 2))]
    assert cols, "no text on the card"
    return cols[0], w - 1 - cols[-1]


def _probe_size(path):
    import re
    out = subprocess.run([FFMPEG, "-hide_banner", "-i", path], capture_output=True, text=True).stderr
    w, h = re.search(r"Video: .*?, (\d+)x(\d+)", out).groups()
    return int(w), int(h)


def _duration(path):
    from server.providers.ffmpeg import parse_ffmpeg_duration
    return parse_ffmpeg_duration(subprocess.run([FFMPEG, "-hide_banner", "-i", path], capture_output=True, text=True).stderr)


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
@pytest.mark.parametrize("ffprobe_bin", [
    pytest.param(FFPROBE, id="ffprobe", marks=pytest.mark.skipif(FFPROBE is None, reason="ffprobe not on PATH")),
    pytest.param("", id="ffmpeg-only"),  # the Lambda layer ships no ffprobe
])
def test_trailer_pipeline_mixed_aspect_inputs(ffprobe_bin):
    """REAL ffmpeg run: two testsrc2 clips, mixed aspect ratios, 1 s each."""
    from server.providers.ffmpeg import render_trailer

    with tempfile.TemporaryDirectory() as tmpdir:
        clip1 = os.path.join(tmpdir, "shot1.mp4")
        clip2 = os.path.join(tmpdir, "shot2.mp4")

        # 1280×720 landscape clip
        subprocess.run(
            [FFMPEG, "-y", "-f", "lavfi",
             "-i", "testsrc2=size=1280x720:rate=24:duration=1",
             "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
             clip1],
            check=True, capture_output=True,
        )
        # 720×1280 portrait clip (mixed aspect)
        subprocess.run(
            [FFMPEG, "-y", "-f", "lavfi",
             "-i", "testsrc2=size=720x1280:rate=24:duration=1",
             "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
             clip2],
            check=True, capture_output=True,
        )

        result = render_trailer(
            ffmpeg_bin=FFMPEG,
            ffprobe_bin=ffprobe_bin,
            font_path="/tmp/no-such-font.otf",  # missing → default font
            workdir=tmpdir,
            shots=[clip1, clip2],
            title="테스트",
            subtitle="subtitle",
            lut="teal-orange",
            make_shorts=True,
        )

        assert os.path.exists(result["trailer"]), "trailer.mp4 must exist"
        assert result["shorts"] is not None
        assert os.path.exists(result["shorts"]), "shorts.mp4 must exist"

        # Duration: title card 2.5s + 2 shots × 1s + end card 2s = 6.5s ± 0.5
        dur = result["seconds"]
        expected = 2.5 + 2.0 + 2.0
        assert abs(dur - expected) <= 0.3, (
            f"Duration {dur:.2f}s not within ±0.3s of {expected}s"
        )

        # Cards and shots must share 24 fps and one timebase, or the copy-concat breaks dts at the joins
        if FFPROBE:
            for path in (result["trailer"], result["shorts"]):
                r_rate, avg_rate = _probe_rates(path)
                assert r_rate == "24/1", (path, r_rate)
                num, den = avg_rate.split("/")
                assert abs(int(num) / int(den) - 24) <= 0.1, (path, avg_rate)
        decode = subprocess.run([FFMPEG, "-v", "error", "-i", result["trailer"], "-f", "null", "-"],
                                capture_output=True, text=True)
        assert "non monotonically" not in decode.stderr, decode.stderr

        # a story beat before the second shot adds its 2 s card
        told = render_trailer(ffmpeg_bin=FFMPEG, ffprobe_bin=ffprobe_bin, font_path="/tmp/no-such-font.otf",
                              workdir=tmpdir, shots=[clip1, clip2], title="테스트", subtitle="", lut="none",
                              make_shorts=False, intertitles={1: "그날, 모든 것이 무너졌다"})
        assert abs(told["seconds"] - (expected + 2.0)) <= 0.3, told["seconds"]


def _probe_rates(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,avg_frame_rate",
         "-of", "default=noprint_wrappers=1", path],
        capture_output=True, text=True, check=True,
    ).stdout
    fields = dict(line.split("=", 1) for line in out.split())
    return fields["r_frame_rate"], fields["avg_frame_rate"]


def test_ffmpeg_submit_appends_extra_assets_after_shots(monkeypatch):
    """include_turntable_ip_id → extra_asset_ids: the turntable clip joins the cut after the shots."""
    from server.providers import ffmpeg
    from server.tests.conftest import FakeS3, FakeTable, make_ctx

    pk = "SESSION#ses_1"
    table, s3 = FakeTable(), FakeS3()
    table.put_item(Item={"pk": pk, "sk": "JOB#job_shot", "outputs": ["ast_shot"]})
    table.put_item(Item={"pk": pk, "sk": "ASSET#ast_shot", "kind": "shot", "key": "sessions/ses_1/shot.mp4"})
    table.put_item(Item={"pk": pk, "sk": "ASSET#ast_tt", "kind": "turntable", "key": "sessions/ses_1/tt.mp4"})
    s3._store[("test-assets", "sessions/ses_1/shot.mp4")] = b"SHOT"
    s3._store[("test-assets", "sessions/ses_1/tt.mp4")] = b"TURNTABLE"
    seen = {}

    def fake_render(ffmpeg_bin, ffprobe_bin, font_path, workdir, shots, *rest):
        seen["shots"] = [open(p, "rb").read() for p in shots]
        out = os.path.join(workdir, "trailer.mp4")
        with open(out, "wb") as f:
            f.write(b"TRAILER")
        return {"trailer": out, "shorts": None, "seconds": 9.5}

    monkeypatch.setattr(ffmpeg, "render_trailer", fake_render)
    job = {"pk": pk, "jobId": "job_tr", "input": {
        "shot_job_ids": ["job_shot"], "extra_asset_ids": ["ast_tt"],
        "title": "루나", "subtitle": "", "lut": "none", "make_shorts": False}}

    ffmpeg.FfmpegProvider().submit(job, make_ctx(s3=s3, table=table))

    assert seen["shots"] == [b"SHOT", b"TURNTABLE"]
    [trailer] = job["result"]
    assert trailer["kind"] == "trailer" and s3._store[("test-assets", trailer["key"])] == b"TRAILER"


# `ffmpeg -hide_banner -i trailer.mp4 -f null -` stderr, captured from a real 6.5 s trailer
FFMPEG_NULL_STDERR = """Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'trailer.mp4':
  Metadata:
    major_brand     : isom
    encoder         : Lavf61.7.100
  Duration: 00:00:06.50, start: 0.000000, bitrate: 6423 kb/s
  Stream #0:0[0x1](und): Video: h264 (Constrained Baseline) (avc1 / 0x31637661), yuv420p(progressive), 1280x720 [SAR 1:1 DAR 16:9], 6421 kb/s, 24 fps, 24 tbr, 12288 tbn (default)
Stream mapping:
  Stream #0:0 -> #0:0 (h264 (native) -> wrapped_avframe (native))
Output #0, null, to 'pipe:':
  Stream #0:0(und): Video: wrapped_avframe, yuv420p(progressive), 1280x720 [SAR 1:1 DAR 16:9], q=2-31, 200 kb/s, 24 fps, 24 tbn (default)
[out#0/null @ 0x79c820e40] video:67KiB audio:0KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
frame=  156 fps=0.0 q=-0.0 Lsize=N/A time=00:00:06.50 bitrate=N/A speed=81.6x
"""


def test_parse_ffmpeg_duration_from_stderr():
    from server.providers.ffmpeg import parse_ffmpeg_duration
    assert parse_ffmpeg_duration(FFMPEG_NULL_STDERR) == 6.5
    assert parse_ffmpeg_duration("  Duration: 01:02:03.25, start: 0.000000, bitrate: 1 kb/s") == 3723.25
    with pytest.raises(RuntimeError):
        parse_ffmpeg_duration("  Duration: N/A, start: 0.000000, bitrate: N/A")


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
def test_probe_duration_falls_back_to_ffmpeg_without_ffprobe(tmp_path):
    from server.providers.ffmpeg import _probe_duration
    clip = str(tmp_path / "clip.mp4")
    subprocess.run([FFMPEG, "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", clip],
                   check=True, capture_output=True)
    for missing in ("", "/opt/bin/no-such-ffprobe"):  # empty FFPROBE_BIN, or a path that is not there
        assert abs(_probe_duration(FFMPEG, missing, clip) - 2.0) < 0.05


def test_ctx_from_env_treats_empty_ffprobe_bin_as_none(monkeypatch):
    from server.providers.base import Ctx
    monkeypatch.setenv("FFPROBE_BIN", "")
    assert Ctx.from_env().ffprobe_bin == ""
    monkeypatch.setenv("FFPROBE_BIN", "  ")
    assert Ctx.from_env().ffprobe_bin == ""


def test_a_failed_ffmpeg_step_reads_as_a_short_korean_reason(monkeypatch, tmp_path):
    """str(CalledProcessError) is the whole command line (with the Korean title in it): the job error is a Korean
    sentence naming the step, never the command."""
    import re
    from server.providers import ffmpeg

    def fail(cmd, **kwargs):
        raise subprocess.CalledProcessError(8, cmd, stderr=b"Error opening output file")
    monkeypatch.setattr(ffmpeg.subprocess, "run", fail)

    with pytest.raises(RuntimeError) as err:
        ffmpeg.render_trailer("/opt/bin/ffmpeg", None, "/nope.ttf", str(tmp_path), [], "은하의 새벽을 지켜라",
                              "", "none", False)
    text = str(err.value)
    assert text == "트레일러 렌더 실패: 제목 카드를 만들지 못했습니다 (종료 코드 8)"
    assert not re.search(r"ffmpeg'|drawtext|/opt/|/tmp|-y", text)
