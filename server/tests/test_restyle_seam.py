"""A chunked restyle joins without a hard cut, stays on its source and comes back at the source's size.

Each piece is anchored on its own klein repaint (one seed); two repaints never match, so neighbouring pieces share
9 frames that the join dissolves across. The anchor prompt carries the style alone: scene words make klein paint
over the first frame, which fights the depth signal. The boxes snap a restyle down to their grid (LTX 128 px,
Wan 16 px) and center-crop the source to it, so the size nearest the source is asked for.

The fake GPUs run real ffmpeg and act like the real boxes where it matters:
- the restyle box snaps the asked size down to its grid and center-crops the source to it;
- the output keeps the source's motion and takes its look from the anchor: frame 0 becomes the anchor, and every
  frame carries the anchor's difference from the piece's first frame;
- LTX makes 8k+1 frames and its own soundtrack;
- klein tints every repaint differently, so two repaints never match."""
import os
import re
import shutil
import statistics
import subprocess

import pytest

from server import jobs, store, tools
from server.providers import mcp_client, mediagen_video as mv
from server.tests.test_restyle_anchor import _edit, _source_shot, ctx, mcps, session  # noqa: F401 (fixtures)
from server.tests.test_tools import _job

FFMPEG = shutil.which("ffmpeg")
pytestmark = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")
CDN = "https://cdn.example.com/"
STYLE = "hand-painted watercolor illustration, visible paper grain, soft bleeding pigment edges"
SCENE = "a silver-bob-haired girl in teal cyber armor sprinting through a space station corridor holding a blaster"
# two klein repaints of the same scene never match: each call tints its picture its own way
TINTS = ("colorchannelmixer=rr=.75:rg=.25:gg=.75:gb=.25:bb=.75:br=.25",
         "colorchannelmixer=rr=.75:rb=.25:gg=.75:gr=.25:bb=.75:bg=.25")


def _ffmpeg(*args) -> str:
    done = subprocess.run([FFMPEG, "-y", "-v", "error", *args], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    return done.stderr


def _info(path) -> tuple:
    """(container seconds, width, height) from ffmpeg's own header, as the Lambda reads it (no ffprobe there)."""
    err = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    h, m, s = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err).groups()
    w, hh = re.search(r"Video: [^\n]*?, (\d{2,5})x(\d{2,5})", err).groups()
    return int(h) * 3600 + int(m) * 60 + float(s), int(w), int(hh)


def make_clip(path, frames=193, size="320x176", tone=440):
    """A 24 fps testsrc clip (a scrolling gradient and a counter: steady motion) with a sine soundtrack."""
    _ffmpeg("-f", "lavfi", "-i", f"testsrc=size={size}:rate=24", "-f", "lavfi", "-i", f"sine=frequency={tone}",
            "-frames:v", str(frames), "-t", f"{frames / 24:.4f}", "-c:v", "libx264", "-preset", "ultrafast",
            "-pix_fmt", "yuv420p", "-c:a", "aac", str(path))
    return path.read_bytes()


class FakeGPUs:
    """klein on the image MCP and both restyle boxes on the video MCP. outputs: URL → bytes; restyles: the start
    calls' arguments; anchors: the anchor picture each restyle was given (PNG bytes)."""

    def __init__(self, ctx, mcps, monkeypatch, tmp_path, tints=TINTS):
        self.ctx, self.tints = ctx, tints
        self.outputs, self.klein, self.restyles, self.anchors = {}, [], [], []
        self.tmp = str(tmp_path / "gpus")
        os.makedirs(self.tmp)
        mcps.replies.update(start_image=self._klein, get_image_status=self._drawn,
                            ltx_restyle_start=self._box(128, 24), ltx_get_status=self._finished,
                            wan_restyle_start=self._box(16, 16), wan_restyle_get_status=self._finished)
        monkeypatch.setattr(mcp_client, "download", lambda url: self.outputs[url])

    def _fetch(self, url) -> bytes:
        if url in self.outputs:
            return self.outputs[url]
        assert url.startswith(CDN), url
        return self.ctx.s3._store[("test-assets", url[len(CDN):])]

    def _file(self, name, data):
        path = os.path.join(self.tmp, name)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def _klein(self, args):
        i = len(self.klein)
        self.klein.append(args)
        ref = self._file(f"ref{i}.png", self._fetch(args["reference_image_urls"][0]))
        out = os.path.join(self.tmp, f"img{i}.png")
        vf = self.tints[i % len(self.tints)] if self.tints else "null"
        _ffmpeg("-i", ref, "-vf", vf, out)
        with open(out, "rb") as f:
            self.outputs[f"https://img.example.com/img-{i + 1}.png"] = f.read()
        return {"job_id": f"img-{i + 1}", "status": "RUNNING"}

    def _drawn(self, args):
        return {"status": "SUCCEEDED", "url": f"https://img.example.com/{args['job_id']}.png"}

    def _finished(self, args):
        return {"status": "SUCCEEDED", "url": f"https://media.example.com/{args['job_id']}.mp4"}

    def _box(self, grid, fps):
        def start(args):
            i = len(self.restyles)
            self.restyles.append(args)
            src = self._file(f"src{i}.mp4", self._fetch(args["video_url"]))
            seconds, sw, sh = _info(src)
            default = (sw, sh) if grid == 128 else (832, 480)  # LTX defaults to the source's size, Wan to 832x480
            w = max(grid, int(args.get("width") or default[0]) // grid * grid)
            h = max(grid, int(args.get("height") or default[1]) // grid * grid)
            n = round(seconds * fps)
            n = max(9, round((n - 1) / 8) * 8 + 1) if grid == 128 else max(5, (n - 1) // 4 * 4 + 1)
            fit = f"fps={fps},scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1"
            inputs, graph = ["-i", src], f"[0:v]{fit},tpad=stop_mode=clone:stop_duration=2,format=gbrp10le"
            if args.get("reference_image_url"):
                anchor = self._fetch(args["reference_image_url"])
                self.anchors.append(anchor)
                inputs += ["-loop", "1", "-i", self._file(f"anchor{i}.png", anchor)]
                graph += (f",split[s][f0];[f0]trim=end_frame=1,loop=loop=-1:size=1[first];"
                          f"[1:v]{fit},format=gbrp10le[a];[a][first]blend=all_mode=grainextract[style];"
                          "[s][style]blend=all_mode=grainmerge:shortest=1")
            out = os.path.join(self.tmp, f"out{i}.mp4")
            sound = (["-f", "lavfi", "-i", "sine=frequency=880", "-map", f"{inputs.count('-i')}:a", "-c:a", "aac",
                      "-t", f"{n / fps:.4f}"] if grid == 128 else [])  # LTX makes its own soundtrack
            _ffmpeg(*inputs, *sound[:4], "-filter_complex", graph + ",format=yuv420p[v]", "-map", "[v]",
                    *sound[4:], "-frames:v", str(n), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12",
                    "-pix_fmt", "yuv420p", out)
            job = f"mg-{i + 1}"
            with open(out, "rb") as f:
                self.outputs[f"https://media.example.com/{job}.mp4"] = f.read()
            return {"job_id": job, "status": "RUNNING"}
        return start


def frame_changes(data: bytes, tmp_path) -> list:
    """Mean absolute RGB change (0-255) from each frame to the next, on 64x36 frames."""
    path = tmp_path / "measure.mp4"
    path.write_bytes(data)
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-vf", "scale=64:36,format=rgb24",
                          "-fps_mode", "passthrough",  # every frame once (rawvideo would pad to a constant rate)
                          "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    size = 64 * 36 * 3
    frames = [raw[i:i + size] for i in range(0, len(raw), size)]
    return [sum(abs(a - b) for a, b in zip(f0, f1)) / size for f0, f1 in zip(frames, frames[1:])]


def tone(data: bytes, tmp_path) -> float:
    """The soundtrack's pitch in Hz, from its zero crossings."""
    path = tmp_path / "tone.mp4"
    path.write_bytes(data)
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    samples = [int.from_bytes(raw[i:i + 2], "little", signed=True) for i in range(0, len(raw) - 1, 2)]
    crossings = sum(1 for a, b in zip(samples, samples[1:]) if (a < 0) != (b < 0))
    return crossings / 2 / (len(samples) / 8000) if samples else 0.0


def run_restyle(ctx, session, src_bytes, seconds, **args) -> tuple:
    """edit_video_shot(restyle) of a finished shot, through the job engine to the end → (result mp4, edit job id)."""
    sid = session["sessionId"]
    src, _ = _source_shot(ctx, sid, src_bytes, seconds=seconds, aspect=args.pop("aspect", "16:9"))
    edit = _edit(ctx, session, src, edit="restyle", **args)
    for _ in range(12):
        jobs.advance_jobs(ctx, sid)
        if _job(ctx, sid, edit)["status"] not in ("queued", "running"):
            break
    done = _job(ctx, sid, edit)
    assert done["status"] == "done", done
    [asset] = [a for a in store.snapshot(ctx, sid)["assets"] if a["assetId"] in done["outputs"]]
    return ctx.s3._store[("test-assets", asset["key"])], edit


# ── where the pieces join ──

def test_the_pieces_of_a_long_restyle_join_without_a_cut(ctx, session, mcps, monkeypatch, tmp_path):
    gpus = FakeGPUs(ctx, mcps, monkeypatch, tmp_path)
    src = make_clip(tmp_path / "src.mp4", frames=289)  # 12.04 s: three pieces, two joins
    out, edit = run_restyle(ctx, session, src, 12, style=STYLE, prompt=f"{STYLE}, {SCENE}")
    assert len(gpus.restyles) == 3 and len(gpus.klein) == 3  # every piece on its own repaint
    changes = frame_changes(out, tmp_path)
    base = statistics.median(changes)
    for first, _ in mv.plan_frames(289, 3)[1:]:  # the join: the shared frames first .. first + 8
        window = changes[first - 4:first + 14]
        jump = sum(c - base for c in window if c > base)
        print(f"\nM4 join at frame {first}: look change {jump:.1f}, largest step {max(window) - base:.1f} "
              f"(clip median {base:.2f})")
        assert max(window) - base < 0.2 * jump  # spread over the shared frames: no cut
    assert len(changes) + 1 == 289  # the source's frame count: the shared frames are laid once
    assert abs(tone(out, tmp_path) - 440) < 30  # the source's own sound, not generated soundtracks


def test_overlapping_polls_start_the_pieces_once(ctx, session, mcps, monkeypatch, tmp_path):
    gpus = FakeGPUs(ctx, mcps, monkeypatch, tmp_path)
    drawn = {"ready": False}
    mcps.replies["get_image_status"] = lambda a: (gpus._drawn(a) if drawn["ready"] else {"status": "RUNNING"})
    sid = session["sessionId"]
    src, _ = _source_shot(ctx, sid, make_clip(tmp_path / "src.mp4"), seconds=8)
    edit = _edit(ctx, session, src, edit="restyle", style=STYLE, prompt=STYLE)
    jobs.advance_jobs(ctx, sid)  # both pieces' first frames go to klein
    wait = " · 조각마다 ~6분, 전체 보통 ~14분"
    assert len(gpus.klein) == 2 and _job(ctx, sid, edit)["progress"] == "화풍 기준 프레임 그리는 중 (0/2)" + wait
    drawn["ready"] = True
    provider = mv.MediagenVideoProvider()
    first, second = (dict(store.get_job(ctx, sid, edit), pk=f"SESSION#{sid}") for _ in range(2))  # both loaded now
    assert provider.status(first, ctx) == ("running", "제출됨 (조각 0/2 완료)" + wait)  # starts both pieces
    assert provider.status(second, ctx) == ("running", "영상 편집 시작 중" + wait)  # the other poll claimed that start
    assert len(gpus.restyles) == 2 and len(gpus.anchors) == 2
    later = dict(store.get_job(ctx, sid, edit), pk=f"SESSION#{sid}")
    assert provider.status(later, ctx) == ("done", "")  # both pieces back: nothing starts again
    assert len(gpus.restyles) == 2


# ── settings, the anchor, the size ──

def test_the_anchor_repaints_the_first_frame_in_the_style_alone(ctx, session, mcps, monkeypatch, tmp_path):
    gpus = FakeGPUs(ctx, mcps, monkeypatch, tmp_path)
    run_restyle(ctx, session, make_clip(tmp_path / "src.mp4", frames=121), 5, style=STYLE, prompt=f"{STYLE}, {SCENE}")
    [klein] = gpus.klein
    assert klein["prompt"].startswith(STYLE + ".") and "background" in klein["prompt"]
    assert not any(word in klein["prompt"] for word in ("corridor", "blaster", "sprinting")), klein["prompt"]
    [restyle] = gpus.restyles
    # the video model still reads the scene, led and closed by the style
    assert restyle["prompt"] == f"{STYLE}, {SCENE}. The whole clip stays {STYLE}, every frame."
    # depth at full strength holds the source's layout and motion; the anchor alone brings the look
    assert (restyle["control"], restyle["strength"]) == ("depth", 1.0)


def test_a_restyle_without_a_style_is_sent_back_to_the_agent(ctx, session, mcps, tmp_path):
    src, _ = _source_shot(ctx, session["sessionId"], b"not read")
    out = tools.run_tool(ctx, session, "edit_video_shot", {"shot_job_id": src, "edit": "restyle",
                                                           "prompt": f"{STYLE}, {SCENE}"})
    assert out["error"] == "bad_args" and "style" in out["message"]


@pytest.mark.parametrize("model,aspect,size,asked,old", [
    # old = the box's default: it snaps a 320x176 source to 256x128 (2:1). 1152x640 is 1.8:1
    ("ltx", "16:9", "320x176", (1152, 640), (256, 128)),
    ("ltx", "9:16", "176x320", (640, 1152), (128, 256)),
    ("wan-animate", "16:9", "320x176", (880, 480), (832, 480)),  # 832x480 is 1.73:1
])
def test_a_restyle_asks_for_the_size_nearest_the_source_and_comes_back_at_the_source_size(
        ctx, session, mcps, monkeypatch, tmp_path, model, aspect, size, asked, old):
    gpus = FakeGPUs(ctx, mcps, monkeypatch, tmp_path, tints=None)  # klein returns the frame as it is: no style at all
    src = make_clip(tmp_path / "src.mp4", frames=121, size=size)
    out, _ = run_restyle(ctx, session, src, 5, model=model, aspect=aspect, style=STYLE, prompt=f"{STYLE}, {SCENE}")
    [restyle] = gpus.restyles
    assert (restyle["width"], restyle["height"]) == asked
    path = tmp_path / "out.mp4"
    path.write_bytes(out)
    assert _info(path)[1:] == tuple(int(v) for v in size.split("x"))
    # with no style the restyle is the source again: its whole picture, closer to it than the box's old crop was
    def first(p, crop="null"):
        return subprocess.run([FFMPEG, "-v", "error", "-i", str(p), "-frames:v", "1", "-vf",
                               f"{crop},scale=64:36,format=rgb24", "-f", "rawvideo", "-"],
                              capture_output=True, check=True).stdout

    def off(a, b):
        return sum(abs(x - y) for x, y in zip(a, b)) / len(a)
    source = first(tmp_path / "src.mp4")
    change = off(first(path), source)
    was = off(first(tmp_path / "src.mp4", f"scale={old[0]}:{old[1]}:force_original_aspect_ratio=increase,"
                                           f"crop={old[0]}:{old[1]}"), source)
    print(f"\nN6 size: asked {asked}, came back {size}; first frame off the source by {change:.2f} "
          f"(the box's default {old[0]}x{old[1]} crop: {was:.2f})")
    assert change < 0.8 * was
    assert abs(tone(out, tmp_path) - 440) < 30  # and the source's sound
