from __future__ import annotations
import itertools
import json
import os
import pathlib
import re
import shutil
import subprocess


# ── Grade filters ─────────────────────────────────────────────────────────────

_GRADES: dict = {
    "teal-orange": (
        "colorbalance=rs=.08:bs=-.08:rm=.02:bm=-.02:rh=-.05:bh=.08,"
        "eq=contrast=1.08:saturation=1.15"
    ),
    "warm": "colorbalance=rs=.1:bs=-.1,eq=brightness=0.02:saturation=1.1",
    "noir": "hue=s=0,eq=contrast=1.25:brightness=-0.03",
    "none": None,
}


def grade_filter(lut: str):
    """Return ffmpeg vf string for the named LUT, or None for 'none'."""
    return _GRADES.get(lut)


# ── Command builders ───────────────────────────────────────────────────────────

# Every concat segment (shots, cards) is encoded identically, so the copy-concat keeps one 24 fps timebase.
ENCODE_24 = [
    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-profile:v", "high",
    "-pix_fmt", "yuv420p", "-r", "24", "-video_track_timescale", "12288",
]
TRAILER = (1280, 720)
SHORTS = (720, 1280)


def build_shot_cmd(ffmpeg_bin: str, src: str, dst: str, lut: str, size: tuple = TRAILER) -> list:
    """Grade + normalise a shot to size, 24 fps h264. The 16:9 trailer fills its frame (scale up, crop the
    overflow); the 9:16 shorts keep the whole shot over a blurred, darkened copy of itself."""
    w, h = size
    grade = grade_filter(lut)
    if w >= h:
        fit = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,fps=24"
    else:
        fit = (f"split[a][b];[a]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},boxblur=20:2,"
               f"eq=brightness=-0.12[bg];[b]scale={w}:{h}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg];"
               "[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=24")
    vf = f"{grade},{fit}" if grade else fit
    return [
        ffmpeg_bin, "-y", "-i", src,
        "-vf", vf,
        *ENCODE_24,
        dst,
    ]


# ── Card text: fitted to the frame width ─────────────────────────────────────────

TITLE_PX, SUBTITLE_PX = 72, 36
CARD_MARGIN = 0.075  # of the frame width, on each side
MAX_LINES = 3


def text_em(text: str) -> float:
    """Width of `text` in em in the layer font (NotoSansKR-Bold), rounded up per character so a fitted line never
    runs off the frame: Hangul 0.92 em, Latin 0.30-1.01, space 0.23 (a test checks it against the font file)."""
    def em(c):
        if c in " @":
            return 0.25 if c == " " else 1.05
        if ord(c) > 127 or c in "MWmw%":
            return 1.0
        return 0.8 if c.isupper() or c == "&" else 0.65
    return sum(em(c) for c in text)


def fit_lines(text: str, max_px: float, base_px: int) -> tuple:
    """→ (lines, font px): `text` on the fewest lines (up to MAX_LINES) that still get 3/4 of base_px, at the largest
    size ≤ base_px whose widest line fits max_px. Lines break at spaces, or between characters when there are too
    few words."""
    text = " ".join(text.split())
    if not text:
        return [], base_px
    best = None
    for n in range(1, MAX_LINES + 1):
        words = text.split(" ")
        units, sep = (words, " ") if len(words) >= n else (list(text), "")
        if len(units) < n:
            break
        acc, gap = list(itertools.accumulate(map(text_em, units), initial=0)), text_em(sep)

        def widest(cuts):
            edges = (0, *cuts, len(units))
            return max(acc[b] - acc[a] + gap * (b - a - 1) for a, b in zip(edges, edges[1:]))
        edges = (0, *min(itertools.combinations(range(1, len(units)), n - 1), key=widest), len(units))
        lines = [part for part in (sep.join(units[a:b]).strip() for a, b in zip(edges, edges[1:])) if part]
        px = min(base_px, int(max_px / max(map(text_em, lines))))
        if px >= base_px * 0.75:
            return lines, px
        if best is None or px > best[1]:
            best = (lines, px)
    return best


def card_lines(title: str, subtitle: str, size: tuple = TRAILER) -> list:
    """(text, font px, y of the line's center) for each line of a card: the title (and subtitle) fitted to the frame
    width, the block centered."""
    w, h = size
    max_px = w * (1 - 2 * CARD_MARGIN)
    rows = _sized(title, max_px, TITLE_PX)
    first_sub = len(rows)
    rows += _sized(subtitle, max_px, SUBTITLE_PX)
    centers, y = [], 0.0
    for i, (_, px) in enumerate(rows):
        if i:  # 1.25 line height, a little more between the title and the subtitle
            y += 1.25 * (rows[i - 1][1] + px) / 2 + (12 if i == first_sub else 0)
        centers.append(y)
    top = h / 2 - (centers[-1] if centers else 0) / 2
    return [(line, px, round(top + c)) for (line, px), c in zip(rows, centers)]


def _sized(text, max_px, base_px):
    lines, px = fit_lines(text or "", max_px, base_px)
    return [(line, px) for line in lines]


def build_card_cmd(ffmpeg_bin: str, dst: str, title: str, subtitle: str, seconds: float, font_path: str,
                   bg_hex: str, size: tuple = TRAILER) -> list:
    """A solid-colour card with the title (and subtitle) fitted to the frame. Each line is read from a text file
    written next to dst (expansion=none), so any title is drawn as typed; inline drawtext text loses apostrophes
    and backslashes and expands %{...}."""
    font_opt = f":fontfile={font_path}" if os.path.exists(font_path) else ""
    w, h = size
    filters = []
    for i, (line, px, y) in enumerate(card_lines(title, subtitle, size)):
        path = f"{dst}.{i}.txt"
        pathlib.Path(path).write_text(line, encoding="utf-8")
        filters.append(f"drawtext=textfile={path}{font_opt}:expansion=none:fontsize={px}:fontcolor=white"
                       f":x=(w-text_w)/2:y={y}-text_h/2")
    return [
        ffmpeg_bin, "-y",
        "-f", "lavfi", "-i", f"color=c={bg_hex}:s={w}x{h}:r=24:d={seconds}",
        *(["-vf", ",".join(filters)] if filters else []),
        *ENCODE_24,
        dst,
    ]


def build_concat_cmd(ffmpeg_bin: str, list_path: str, dst: str) -> list:
    """Concat demuxer: copy-mux segments listed in list_path."""
    return [
        ffmpeg_bin, "-y",
        "-f", "concat", "-safe", "0", "-i", list_path,
        "-c", "copy", "-movflags", "+faststart",
        dst,
    ]


def build_upscale_cmd(ffmpeg_bin: str, src: str, dst: str, min_side: int) -> list:
    """The video re-encoded with its short side scaled up to min_side, aspect kept (480x270 → 640x360); audio copied."""
    short = "lt(iw,ih)"
    return [ffmpeg_bin, "-y", "-i", src, "-vf",
            f"scale='if({short},{min_side},-2)':'if({short},-2,{min_side})',setsar=1",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "copy",
            "-movflags", "+faststart", dst]


# ── High-level trailer renderer ───────────────────────────────────────────────

def render_trailer(
    ffmpeg_bin: str,
    ffprobe_bin: str,
    font_path: str,
    workdir: str,
    shots: list,
    title: str,
    subtitle: str,
    lut: str,
    make_shorts: bool,
    intertitles: dict = None,
) -> dict:
    """A trailer from a list of shot paths, and the 9:16 shorts as its own cut of the same segments (not a crop).

    Structure: [title card 2.5s] + [(intertitle card 2s) + graded shot]... + [end card 2s]
    intertitles: {shot index: text}, a story beat shown just before that shot
    Returns dict(trailer=path, shorts=path|None, seconds=float).
    """
    wd = pathlib.Path(workdir)
    cut = (ffmpeg_bin, font_path, wd, shots, title, subtitle, lut, intertitles or {})
    trailer_path = _render_cut(*cut, "trailer", TRAILER)
    shorts_path = _render_cut(*cut, "shorts", SHORTS) if make_shorts else None
    try:
        seconds = _probe_duration(ffmpeg_bin, ffprobe_bin, trailer_path)
    except (subprocess.CalledProcessError, RuntimeError, ValueError, KeyError) as e:  # shown to the user: Korean
        print("trailer duration probe failed:", repr(e)[:2000])
        raise RuntimeError("트레일러 렌더 실패: 완성된 영상의 길이를 읽지 못했습니다") from None
    return {"trailer": trailer_path, "shorts": shorts_path, "seconds": seconds}


def _render_cut(ffmpeg_bin, font_path, wd, shots, title, subtitle, lut, intertitles, name, size) -> str:
    """Cards and graded shots at `size`, copy-concatenated → wd/<name>.mp4."""
    def run(cmd, what):
        try:
            subprocess.run(cmd, check=True, capture_output=True)
        except subprocess.CalledProcessError as e:
            # the job error is shown to the user: a Korean step name, never str(e); ffmpeg's own words go to the log
            print("ffmpeg failed:", cmd, (e.stderr or b"")[-2000:].decode("utf-8", "replace"))
            label = "쇼츠" if name == "shorts" else "트레일러"
            raise RuntimeError(f"{label} 렌더 실패: {what} 못했습니다 (종료 코드 {e.returncode})") from None

    def card(tag, text, sub, seconds, what):
        path = str(wd / f"{name}_card_{tag}.mp4")
        run(build_card_cmd(ffmpeg_bin, path, text, sub, seconds, font_path, "black", size), what)
        return path

    segments = [card("title", title, subtitle, 2.5, "제목 카드를 만들지")]
    for i, shot in enumerate(shots):
        if intertitles.get(i):
            segments.append(card(f"{i:02d}", intertitles[i], "", 2.0, f"{i + 1}번째 자막 카드를 만들지"))
        out = str(wd / f"{name}_shot_{i:02d}.mp4")
        run(build_shot_cmd(ffmpeg_bin, shot, out, lut, size), f"{i + 1}번째 샷을 색보정하지")
        segments.append(out)
    segments.append(card("end", title, "", 2.0, "엔드 카드를 만들지"))  # shorter, title only
    list_path = wd / f"{name}_concat.txt"
    list_path.write_text("".join(f"file '{seg}'\n" for seg in segments))
    out = str(wd / f"{name}.mp4")
    run(build_concat_cmd(ffmpeg_bin, str(list_path), out), "구간을 이어 붙이지")
    return out


_DURATION = re.compile(r"Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)")


def parse_ffmpeg_duration(stderr: str) -> float:
    """Seconds from the `Duration: HH:MM:SS.ss` line ffmpeg prints for its input."""
    match = _DURATION.search(stderr)
    if not match:
        raise RuntimeError("ffmpeg did not report a duration")
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def _probe_duration(ffmpeg_bin: str, ffprobe_bin: str, path: str) -> float:
    if ffprobe_bin and shutil.which(ffprobe_bin):
        result = subprocess.run(
            [ffprobe_bin, "-v", "quiet", "-print_format", "json",
             "-show_format", path],
            capture_output=True, text=True, check=True,
        )
        info = json.loads(result.stdout)
        return float(info["format"]["duration"])
    # No ffprobe (the Lambda layer has room for the drawtext-capable ffmpeg only): read ffmpeg's stderr.
    result = subprocess.run(
        [ffmpeg_bin, "-hide_banner", "-i", path, "-f", "null", "-"],
        capture_output=True, text=True, errors="replace", check=True,
    )
    return parse_ffmpeg_duration(result.stderr)


# ── FfmpegProvider (synchronous) ──────────────────────────────────────────────

class FfmpegProvider:
    name = "ffmpeg"

    def submit(self, job: dict, ctx) -> str:
        """Download the dep shot assets, render, upload; job["result"] holds the asset dicts for collect()."""
        import tempfile
        session_id = job["pk"].split("#")[1]
        job_id = job["jobId"]
        inp = job["input"]

        with tempfile.TemporaryDirectory() as tmpdir:
            shot_paths = []
            beats = {}  # shot index -> intertitle (cut_trailer intertitles, keyed by shot job)

            for dep_job_id in inp.get("shot_job_ids", []):
                if (inp.get("intertitles") or {}).get(dep_job_id):
                    beats[len(shot_paths)] = inp["intertitles"][dep_job_id]
                # ConsistentRead: the dep's outputs may have been written moments ago in this same poll
                dep_item = ctx.table.get_item(
                    Key={"pk": job["pk"], "sk": f"JOB#{dep_job_id}"}, ConsistentRead=True
                )["Item"]
                for asset_id in dep_item.get("outputs", []):
                    asset_item = ctx.table.get_item(
                        Key={"pk": job["pk"], "sk": f"ASSET#{asset_id}"}, ConsistentRead=True
                    )["Item"]
                    if asset_item.get("kind") == "shot":
                        local = os.path.join(tmpdir, f"{asset_id}.mp4")
                        ctx.s3.download_file(ctx.assets_bucket, asset_item["key"], local)
                        shot_paths.append(local)

            # e.g. the turntable clip (cut_trailer include_turntable_ip_id), appended after the shots
            for asset_id in inp.get("extra_asset_ids", []):
                asset_item = ctx.table.get_item(
                    Key={"pk": job["pk"], "sk": f"ASSET#{asset_id}"}, ConsistentRead=True
                )["Item"]
                local = os.path.join(tmpdir, f"{asset_id}.mp4")
                ctx.s3.download_file(ctx.assets_bucket, asset_item["key"], local)
                shot_paths.append(local)

            result = render_trailer(
                ctx.ffmpeg_bin,
                ctx.ffprobe_bin,
                ctx.font_path,
                tmpdir,
                shot_paths,
                inp.get("title", ""),
                inp.get("subtitle", ""),
                inp.get("lut", "none"),
                inp.get("make_shorts", False),
                beats,
            )

            trailer_key = f"sessions/{session_id}/{job_id}_trailer.mp4"
            ctx.s3.upload_file(result["trailer"], ctx.assets_bucket, trailer_key)
            assets = [
                {
                    "kind": "trailer",
                    "key": trailer_key,
                    "contentType": "video/mp4",
                    "meta": {"seconds": result["seconds"]},
                }
            ]

            if result["shorts"]:
                shorts_key = f"sessions/{session_id}/{job_id}_shorts.mp4"
                ctx.s3.upload_file(result["shorts"], ctx.assets_bucket, shorts_key)
                assets.append(
                    {"kind": "shorts", "key": shorts_key, "contentType": "video/mp4", "meta": {}}
                )

        job["result"] = assets
        return "local"

    def status(self, job: dict, ctx) -> tuple:
        # ponytail: synchronous provider — always done after submit
        return ("done", "")

    def collect(self, job: dict, ctx) -> list:
        return job.get("result", [])
