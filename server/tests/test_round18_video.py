"""A v2v task that must keep the picture (upscale, deblur, decompress): ltx_v2v_start can draw the clip again, so
each piece is anchored on its own first source frame, the result is measured against the source, and a redrawn clip
is not delivered: an upscale becomes the source enlarged by ffmpeg, a deblur or a decompress fails saying why.

The measure reads the source through the box's crop (a same-size task asks for the next 128 px size up and the box
crops the source to that shape) and against each source frame's own contrast (a redraw moves a dark shot by fewer
levels)."""
import pytest

from server import jobs, store
from server.providers import mediagen_video as mv
from server.tests.test_restyle_anchor import _edit, _source_shot, ctx, mcps, session  # noqa: F401 (fixtures)
from server.tests.test_restyle_seam import CDN, FFMPEG, _ffmpeg, _info, make_clip, tone
from server.tests.test_round9_video import FakeV2V, _frame, _off, _run_edit
from server.tests.test_round12_media import RegeneratingV2V
from server.tests.test_tools import _job

pytestmark = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
SHOT = "640x352"  # the LTX 16:9 shot's shape (1280x704) at half the size: off the box's 128 px grid, as every shot is


class RedrawingV2V(RegeneratingV2V):
    """The real box draws the clip again, each piece on its own: here every piece comes back as another picture."""
    LOOKS = ("hue=h=140:s=1.6", "negate")


PATCH = "drawbox=x=iw*0.5:y=ih*0.1:w=iw*0.16:h=ih*0.1:color={}:t=fill"


class PatchingV2V(RegeneratingV2V):
    """... or keeps the scene and draws one thing anew (the knight's head): a patch a sixth of the frame wide."""
    LOOKS = (PATCH.format("white"),) * 2


class TonedV2V(RegeneratingV2V):
    """... or draws the whole clip again in another tone, about as far off its source as the real box's results are
    off a daylight shot (13-19 levels a frame)."""
    LOOKS = RegeneratingV2V.LOOKS[:1] * 2


def _moving_shot(ctx, sid, tmp_path, size="192x320", aspect="9:16", gain=1.0):  # noqa: F811
    """A finished 121-frame source shot whose picture moves (testsrc2), with a 440 Hz soundtrack → (job id, path).
    gain: every level times it (a night shot)."""
    path = tmp_path / "src.mp4"
    dark = "" if gain == 1 else f",lutrgb=r=val*{gain}:g=val*{gain}:b=val*{gain}"
    _ffmpeg("-f", "lavfi", "-i", f"testsrc2=size={size}:rate=24{dark}", "-f", "lavfi", "-i", "sine=frequency=440",
            "-frames:v", "121", "-af", "atrim=duration=5.01", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt",
            "yuv420p", "-c:a", "aac", str(path))
    return _source_shot(ctx, sid, path.read_bytes(), aspect=aspect)[0], path


def _asset(ctx, sid, job_id):  # noqa: F811
    done = _job(ctx, sid, job_id)
    [asset] = [a for a in store.snapshot(ctx, sid)["assets"] if a["assetId"] in done["outputs"]]
    return asset


def _off_the_source(out: bytes, src_path, tmp_path) -> float:
    """The delivered clip's worst frame against the source's frame of the same number (64x36, mean |RGB|)."""
    path = tmp_path / "delivered.mp4"
    path.write_bytes(out)
    made, source = mv._thumbs(FFMPEG, str(path)), mv._thumbs(FFMPEG, str(src_path))
    assert len(made) == len(source) == 121
    return max(_off(a, b) for a, b in zip(made, source))


def test_each_piece_of_an_upscale_is_anchored_on_its_own_first_source_frame(ctx, session, mcps, monkeypatch,  # noqa: F811
                                                                             tmp_path):
    box = FakeV2V(ctx, mcps, monkeypatch, tmp_path)
    monkeypatch.setattr(mv, "LTX_PASS_PIXEL_FRAMES", 384 * 640 * 66)  # two pieces, as 2560x1408 x 121 frames
    sid = session["sessionId"]
    src, src_path = _moving_shot(ctx, sid, tmp_path)
    edit = _edit(ctx, session, src, edit="v2v", task="upscale", prompt="a knight in a steel great helm and brown cloak")
    _run_edit(ctx, sid, edit)
    plan = mv.plan_v2v(121, (384, 640))
    assert [first for first, _ in plan] == [0, 56] and len(box.calls) == 2
    for i, (first, _) in enumerate(plan):
        key = f"sessions/{sid}/{edit}-p{i}.png"
        assert box.calls[i]["reference_image_url"] == CDN + key
        still = tmp_path / f"anchor{i}.png"
        still.write_bytes(ctx.s3._store[("test-assets", key)])
        # the source's frame where the piece starts (a frame 12 or 48 away is twice as far off)
        offs = [_off(_frame(still), _frame(src_path, n)) for n in (first, first + 12, abs(first - 12), first + 48)]
        assert offs[0] < 0.6 * min(offs[1:]), offs
    assert _asset(ctx, sid, edit)["meta"]["anchors"] == [f"{CDN}sessions/{sid}/{edit}-p{i}.png" for i in range(2)]


def test_an_upscale_the_box_drew_again_is_not_delivered_the_source_is_enlarged_instead(ctx, session, mcps,  # noqa: F811
                                                                                       monkeypatch, tmp_path):
    box = RedrawingV2V(ctx, mcps, monkeypatch, tmp_path)
    monkeypatch.setattr(mv, "LTX_PASS_PIXEL_FRAMES", 384 * 640 * 66)
    # pieces that are not delivered are not fitted either: the fit is most of the poll that collects an upscale
    # (about 30 s, against CloudFront's 60 s)
    monkeypatch.setattr(mv, "_fit", lambda *a, **k: pytest.fail("the redrawn pieces were fitted"))
    sid = session["sessionId"]
    store.put_ip(ctx, sid, {"ipId": "ip_hero", "kind": "character", "name": "바론", "version": 1})
    src, src_path = _moving_shot(ctx, sid, tmp_path)
    edit = _edit(ctx, session, src, edit="v2v", task="upscale", prompt="the same shot, sharper")
    said = len(store.snapshot(ctx, sid)["messages"])
    out = _run_edit(ctx, sid, edit)
    assert len(box.calls) == 2
    worst = _off_the_source(out, src_path, tmp_path)
    print(f"\n#23 delivered upscale, worst frame off its source frame: {worst:.1f}")
    assert worst < 5  # a redraw reads about 13 at this size, a plain 2x 0.15
    seconds, w, h = _info(tmp_path / "delivered.mp4")
    assert (w, h) == (384, 640) and abs(seconds - _info(src_path)[0]) < 0.05  # still exactly 2x, the source's length
    assert abs(tone(out, tmp_path) - 440) < 30  # and its sound
    done, meta = _job(ctx, sid, edit), _asset(ctx, sid, edit)["meta"]
    # the job's line says what was delivered and why; the asset names what made it
    assert done["error"].startswith("원본 보존 검사 실패: ") and "2배로 키운 영상으로 대신했습니다" in done["error"]
    assert meta["plain"] is True and meta["model"] == "ffmpeg" and meta["off"]["mean"] > mv.KEEP_MEAN
    # the chat hears it too, once: the reply had promised an upscale by the GPU, and a done job's line sits in a
    # folded group
    [told] = store.snapshot(ctx, sid)["messages"][said:]
    assert told["role"] == "assistant" and told["status"] == "done"
    assert told["text"].startswith("바론 샷의 2배 업스케일은 원본 보존 검사를 통과하지 못했어요.")
    assert "다시 그려" in told["text"] and "원본을 그대로 2배 크기로 키운 영상" in told["text"]
    jobs.advance_jobs(ctx, sid)
    assert len(store.snapshot(ctx, sid)["messages"]) == said + 1


@pytest.mark.parametrize("gain", [1.0, 0.3])
def test_a_redrawn_upscale_of_a_dark_shot_is_not_delivered_either(ctx, session, mcps, monkeypatch, tmp_path, gain):  # noqa: F811
    """The same redraw reads fewer levels on a darker shot: limits in plain levels would let it pass."""
    TonedV2V(ctx, mcps, monkeypatch, tmp_path)
    sid = session["sessionId"]
    src, src_path = _moving_shot(ctx, sid, tmp_path, gain=gain)
    edit = _edit(ctx, session, src, edit="v2v", task="upscale", prompt="the same shot, sharper")
    out = _run_edit(ctx, sid, edit)
    done, meta = _job(ctx, sid, edit), _asset(ctx, sid, edit)["meta"]
    print(f"\n#23 a redraw in another tone, source at {gain} of its levels: {meta.get('off')}")
    assert meta.get("plain") is True and meta["model"] == "ffmpeg", meta
    assert done["error"].startswith("원본 보존 검사 실패: ")
    assert _off_the_source(out, src_path, tmp_path) < 5 * gain
    assert 12 < meta["off"]["mean"] < 20  # read against the shot's own contrast: about the same figure, bright or dark


@pytest.mark.parametrize("patch,least", [("white", mv.KEEP_BLOCK), ("white@0.1", mv.KEEP_BLOCK_UPSCALE)])
def test_one_redrawn_part_is_enough_for_the_source_to_be_delivered(ctx, session, mcps, monkeypatch, tmp_path,  # noqa: F811
                                                                   patch, least):
    """A part under 1% of the frame (a head) hardly moves the frame's mean; the block it sits in does. The fainter
    patch here is about as far off as a real redrawn head on its weakest frame."""
    monkeypatch.setattr(PatchingV2V, "LOOKS", (PATCH.format(patch),) * 2)
    PatchingV2V(ctx, mcps, monkeypatch, tmp_path)
    sid = session["sessionId"]
    src, src_path = _moving_shot(ctx, sid, tmp_path)
    edit = _edit(ctx, session, src, edit="v2v", task="upscale", prompt="the same shot, sharper")
    out = _run_edit(ctx, sid, edit)
    meta = _asset(ctx, sid, edit)["meta"]
    print(f"\n#23 one part drawn again ({patch}): {meta['off']}")
    assert meta["off"]["mean"] < mv.KEEP_MEAN and least < meta["off"]["block"], meta["off"]
    assert meta["plain"] is True and _off_the_source(out, src_path, tmp_path) < 5
    assert "가장 달라진 곳" in _job(ctx, sid, edit)["error"]


def test_an_upscale_that_is_the_source_s_picture_is_delivered_as_the_box_made_it(ctx, session, mcps, monkeypatch,  # noqa: F811
                                                                                 tmp_path):
    FakeV2V(ctx, mcps, monkeypatch, tmp_path)
    monkeypatch.setattr(mv, "LTX_PASS_PIXEL_FRAMES", 384 * 640 * 66)
    sid = session["sessionId"]
    src, src_path = _moving_shot(ctx, sid, tmp_path)
    edit = _edit(ctx, session, src, edit="v2v", task="upscale", prompt="the same shot, sharper")
    out = _run_edit(ctx, sid, edit)
    done, meta = _job(ctx, sid, edit), _asset(ctx, sid, edit)["meta"]
    print(f"\n#23 the fake box's own 2x of the source measures {meta['off']}")
    assert meta["off"]["mean"] < mv.KEEP_MEAN and meta["off"]["block"] < mv.KEEP_BLOCK, meta["off"]
    assert "plain" not in meta and meta["model"] == "ltx" and meta["pieces"] == 2 and not done.get("error")
    assert _off_the_source(out, src_path, tmp_path) < 5


def test_a_deblur_the_box_drew_again_fails_saying_why(ctx, session, mcps, monkeypatch, tmp_path):  # noqa: F811
    """ffmpeg has no filter that removes a blur, so there is nothing to deliver in its place."""
    box = RedrawingV2V(ctx, mcps, monkeypatch, tmp_path)
    sid = session["sessionId"]
    src, _ = _source_shot(ctx, sid, make_clip(tmp_path / "src.mp4", frames=121, size=SHOT))
    edit = _edit(ctx, session, src, edit="v2v", task="deblur", prompt="the same shot, in focus")
    for _ in range(6):
        jobs.advance_jobs(ctx, sid)
    done = _job(ctx, sid, edit)
    assert box.calls[0]["reference_image_url"] == f"{CDN}sessions/{sid}/{edit}-p0.png"  # anchored like an upscale
    assert done["status"] == "failed" and done["outputs"] == [], done
    assert done["error"].startswith("원본 보존 검사 실패: ") and "쓰지 않았습니다" in done["error"]


def test_a_deblur_that_is_the_source_s_picture_is_delivered_with_the_source_s_sound(ctx, session, mcps, monkeypatch,  # noqa: F811
                                                                                    tmp_path):
    """The product's 16:9 shot is off the box's 128 px grid (1280x704, here halved): the box is asked for the next
    size up and crops the source to that shape, so the result is measured against the source through that crop."""
    box = FakeV2V(ctx, mcps, monkeypatch, tmp_path)  # keeps the picture; makes its own 880 Hz soundtrack
    sid = session["sessionId"]
    src, _ = _source_shot(ctx, sid, make_clip(tmp_path / "src.mp4", frames=121, size=SHOT))
    edit = _edit(ctx, session, src, edit="v2v", task="deblur", prompt="the same shot, in focus")
    out = _run_edit(ctx, sid, edit)
    assert (box.calls[0]["width"], box.calls[0]["height"]) == (640, 384)  # not the source's 640x352
    done, meta = _job(ctx, sid, edit), _asset(ctx, sid, edit)["meta"]
    print(f"\n#23 a deblur that kept the picture, through the box's crop: {meta['off']}")
    assert meta["off"]["mean"] < mv.KEEP_MEAN / 2 and meta["off"]["block"] < mv.KEEP_BLOCK / 2, meta["off"]
    assert "plain" not in meta and meta["model"] == "ltx" and not done.get("error")
    path = tmp_path / "out.mp4"
    path.write_bytes(out)
    assert _info(path)[1:] == (640, 352) and len(mv._thumbs(FFMPEG, str(path))) == 121
    assert abs(tone(out, tmp_path) - 440) < 30


def test_a_task_that_changes_the_picture_is_neither_anchored_nor_measured(ctx, session, mcps, monkeypatch, tmp_path):  # noqa: F811
    box = RedrawingV2V(ctx, mcps, monkeypatch, tmp_path)
    sid = session["sessionId"]
    src, _ = _source_shot(ctx, sid, make_clip(tmp_path / "src.mp4", frames=121, size="256x128"))
    edit = _edit(ctx, session, src, edit="v2v", task="day_to_night", prompt="the same street at night")
    out = _run_edit(ctx, sid, edit)  # the night it drew is the result
    assert "reference_image_url" not in box.calls[0]  # an anchor would pin frame 0 to the day
    meta = _asset(ctx, sid, edit)["meta"]
    assert "off" not in meta and "plain" not in meta and not _job(ctx, sid, edit).get("error")
    assert abs(tone(out, tmp_path) - 880) < 40  # with the night's own generated sound


def test_the_measure_tells_the_source_s_picture_from_one_drawn_again(ctx, tmp_path):  # noqa: F811
    src = tmp_path / "src.mp4"
    make_clip(src, frames=49)
    ctx.s3._store[("test-assets", "src.mp4")] = src.read_bytes()

    def off(*vf):
        out = tmp_path / "made.mp4"
        _ffmpeg("-i", str(src), "-vf", ",".join(("scale=iw*2:ih*2:flags=lanczos", *vf)), "-c:v", "libx264", "-preset",
                "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", str(out))
        return mv._off_source(ctx, out.read_bytes(), "src.mp4")

    def within(mean, block):
        return mean <= mv.KEEP_MEAN and block <= mv.KEEP_BLOCK
    plain, sharper, hue, late = off(), off("unsharp=5:5:1.5"), off("hue=h=140"), off("trim=start_frame=4,setpts=PTS-STARTPTS")
    patch = off("drawbox=x=iw*0.5:y=ih*0.1:w=iw*0.1:h=ih*0.15:color=white:t=fill")
    print(f"\n#23 measure (worst frame mean, worst block): plain 2x {plain}, sharpened {sharper}, another hue {hue}, "
          f"four frames late {late}, one patch {patch}")
    assert within(*plain) and within(*sharper)  # the same picture, bigger or crisper
    assert not within(*hue) and not within(*late)
    assert patch[0] < mv.KEEP_MEAN and patch[1] > mv.KEEP_BLOCK  # one part drawn again: only its block tells


BOX = "384:256:force_original_aspect_ratio=increase"  # a 320x176 source at the box's 384x256: covered, then cropped


def _made(src, out, vf="null", size="iw*2:ih*2"):
    """What a box could hand back for `src`: its frames at another size, through `vf`."""
    _ffmpeg("-i", str(src), "-vf", f"scale={size}:flags=lanczos,{vf}", "-c:v", "libx264", "-preset", "ultrafast", "-crf",
            "18", "-pix_fmt", "yuv420p", "-an", str(out))
    return out.read_bytes()


def test_the_measure_reads_the_source_through_the_box_s_crop(ctx, tmp_path):  # noqa: F811
    """The box covers the size it is asked for and crops the source to it."""
    src = tmp_path / "src.mp4"
    make_clip(src, frames=49)  # 320x176: the next 128 px size up is 384x256
    ctx.s3._store[("test-assets", "src.mp4")] = src.read_bytes()
    assert mv.v2v_dims((320, 176), 1) == (384, 256)
    kept = _made(src, tmp_path / "kept.mp4", "crop=384:256", BOX)
    late = _made(src, tmp_path / "late.mp4", "crop=384:256,trim=start_frame=4,setpts=PTS-STARTPTS", BOX)
    through, plainly = mv._off_source(ctx, kept, "src.mp4", shape=(384, 256)), mv._off_source(ctx, kept, "src.mp4")
    moved = mv._off_source(ctx, late, "src.mp4", shape=(384, 256))
    print(f"\n#23 the source's own picture at the box's 384x256: through its crop {through}, against the uncropped "
          f"source {plainly}; four frames late through the crop {moved}")
    assert through[0] < mv.KEEP_MEAN / 2 and through[1] < mv.KEEP_BLOCK / 2
    assert plainly[0] > mv.KEEP_MEAN and plainly[1] > mv.KEEP_BLOCK  # uncropped, the same picture reads as another
    assert moved[1] > mv.KEEP_BLOCK  # another picture is still another picture
    # a piece is read against the source frames it was cut from
    piece = _made(src, tmp_path / "piece.mp4", "trim=start_frame=24,setpts=PTS-STARTPTS")
    own, wrong = mv._off_source(ctx, piece, "src.mp4", first=24, count=25), mv._off_source(ctx, piece, "src.mp4")
    assert own[0] < mv.KEEP_MEAN / 2 and own[1] < mv.KEEP_BLOCK / 2 < mv.KEEP_BLOCK < wrong[1], (own, wrong)


def test_the_measure_reads_a_frame_against_its_own_contrast(ctx, tmp_path):  # noqa: F811
    """A redraw moves a dark shot by fewer levels than a bright one; it is no less another picture."""
    read = {}
    for gain in (1.0, 0.5, 0.3):
        src = tmp_path / f"src{gain}.mp4"
        dark = "" if gain == 1 else f",lutrgb=r=val*{gain}:g=val*{gain}:b=val*{gain}"
        _ffmpeg("-f", "lavfi", "-i", f"testsrc2=size=320x176:rate=24{dark}", "-frames:v", "25", "-c:v", "libx264",
                "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p", str(src))
        ctx.s3._store[("test-assets", f"src{gain}.mp4")] = src.read_bytes()
        read[gain] = (mv._off_source(ctx, _made(src, tmp_path / "toned.mp4", TonedV2V.LOOKS[0]), f"src{gain}.mp4"),
                      mv._off_source(ctx, _made(src, tmp_path / "same.mp4"), f"src{gain}.mp4"))
    print(f"\n#23 (redrawn in another tone, the same picture) by the source's gain: {read}")
    for gain, (toned, same) in read.items():
        assert toned[0] > 1.5 * mv.KEEP_MEAN, (gain, toned)  # in plain levels a x0.3 source would read inside the limit
        assert abs(toned[0] / read[1.0][0][0] - 1) < 0.2, (gain, toned)
        assert same[0] < mv.KEEP_MEAN / 2 and same[1] < mv.KEEP_BLOCK_UPSCALE, (gain, same)  # and the same is the same
