"""A finished round's clip, cut from the player channel's IVS recording (RecordingConfiguration "ipverse-live-rec":
the assets bucket, all renditions). The play window does not upload clips itself: an upload beside the WebRTC send
sinks the send's bandwidth estimate.

IVS writes each recording session under (UTC, no zero padding)
  ivs/v1/<account>/<channel id>/<year>/<month>/<day>/<hour>/<minute>/<recording id>/
    events/recording-started.json, events/recording-ended.json (once it is over)
    media/hls/master.m3u8, media/hls/720p/playlist.m3u8 (EVENT, each segment's EXT-X-PROGRAM-DATE-TIME), .../N.ts
Each send restart (a new stream session) starts a new recording id in its own minute folder. Segments are up to ~12 s
and land ~3 s after they end, but a running recording's playlist lags them by up to ~40 s. A round is the segments,
across recordings, that overlap its wall-clock window [start, end + PAD_SEC]: the playlist's, then the N.ts in S3
past it, timed by their own durations; the cut waits (briefly) for the one that holds the end.
"""
from __future__ import annotations
import os
import re
import subprocess
import time
from datetime import datetime

from server.providers import ffmpeg as ff

WAIT_SEC = 45  # a segment is in S3 ~3 s after it ends (IVS writes each one whole; up to ~12 s long)
POLL_SEC = 3
PAD_SEC = 2.0  # after the reported end: the frames of the round's last moment reach IVS a little later
LOOKBACK_SEC = 50 * 60  # a recording that holds a round started at most a broadcast (45 min) before it
MIN_SIDE = 360  # Pegasus refuses smaller video ("The resolution of the video is too low")


class NoRecording(Exception):
    pass


def parse_playlist(text: str) -> list:
    """An HLS media playlist → [{"uri", "start" (epoch s, from EXT-X-PROGRAM-DATE-TIME), "seconds"}]. A segment
    without its own date follows on from the one before; one with no date at all before it is skipped."""
    out, start, dur = [], None, None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
            start = datetime.fromisoformat(line.split(":", 1)[1].replace("Z", "+00:00")).timestamp()
        elif line.startswith("#EXTINF:"):
            dur = float(line[8:].split(",")[0])
        elif line and not line.startswith("#") and dur is not None:
            if start is not None:
                out.append({"uri": line, "start": start, "seconds": dur})
                start += dur
            dur = None
    return out


def _list(ctx, prefix: str, delimiter: bool) -> list:
    """CommonPrefixes (delimiter) or keys under prefix, all pages."""
    out, token = [], None
    while True:
        page = ctx.s3.list_objects_v2(Bucket=ctx.assets_bucket, Prefix=prefix, **({"Delimiter": "/"} if delimiter else {}),
                                      **({"ContinuationToken": token} if token else {}))
        out += [p["Prefix"] for p in page.get("CommonPrefixes", [])] if delimiter else [o["Key"] for o in page.get("Contents", [])]
        token = page.get("NextContinuationToken")
        if not token:
            return out


def recordings(ctx, base: str, since: float, until: float) -> list:
    """The recording sessions under `base` (ivs/v1/<account>/<channel>/) that started between since and until
    (to the minute), newest first."""
    found = []
    for hour in range(int(since // 3600) * 3600, int(until) + 1, 3600):
        g = time.gmtime(hour)
        for minute in _list(ctx, f"{base}{g.tm_year}/{g.tm_mon}/{g.tm_mday}/{g.tm_hour}/", True):
            at = hour + 60 * int(minute.rstrip("/").rsplit("/", 1)[1])
            if since - 60 <= at <= until:
                found += [(at, rec) for rec in _list(ctx, minute, True)]
    return [rec for _, rec in sorted(found, reverse=True)]


def _rank(prefix: str) -> int:
    """The best rendition: the tallest (720p over 480p); "source" (unscaled) above all."""
    name = prefix.rstrip("/").rsplit("/", 1)[1]
    m = re.match(r"(\d+)p", name)
    return 10 ** 6 if name == "source" else int(m.group(1)) if m else 0


def _read(ctx, key: str) -> str:
    try:
        return ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=key)["Body"].read().decode()
    except Exception:  # noqa: BLE001 — not written yet: nothing to cut from it
        return ""


def _fetch(ctx, workdir: str, key: str) -> str:
    """The segment in workdir (downloaded once across polls)."""
    path = f"{workdir}/{key.replace('/', '_')}"
    if not os.path.exists(path):
        ctx.s3.download_file(ctx.assets_bucket, key, path + ".part")
        os.replace(path + ".part", path)
    return path


def _probe(ffmpeg_bin: str, path: str) -> str:
    return subprocess.run([ffmpeg_bin, "-hide_banner", "-i", path], capture_output=True, text=True,
                          errors="replace", timeout=60).stderr


def resolution(ffmpeg_bin: str, path: str) -> tuple:
    """(width, height) of the first video stream as ffmpeg reports it; (0, 0) if none."""
    m = re.search(r"Video:.*?\b(\d{2,5})x(\d{2,5})\b", _probe(ffmpeg_bin, path))
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def _segments(ctx, rdir: str, end: float, workdir, ffmpeg_bin: str) -> list:
    """The rendition's segments with their wall-clock times: the playlist's, then the N.ts already in S3 past its last
    one, which follow on from its last date by their own durations (ffmpeg reads each). The latter only when the
    playlist does not reach `end` and there is a workdir to fetch them into."""
    segs = [{**s, "key": rdir + s["uri"]} for s in parse_playlist(_read(ctx, f"{rdir}playlist.m3u8"))]
    if not segs or segs[-1]["start"] + segs[-1]["seconds"] >= end or not workdir:
        return segs
    names = {k[len(rdir):] for k in _list(ctx, rdir, False)}
    nums = [int(s["uri"][:-3]) for s in segs if re.fullmatch(r"\d+\.ts", s["uri"])]
    n, t = (max(nums) + 1 if nums else None), segs[-1]["start"] + segs[-1]["seconds"]
    while n is not None and f"{n}.ts" in names and t < end:
        key = rdir + f"{n}.ts"
        dur = ff.parse_ffmpeg_duration(_probe(ffmpeg_bin, _fetch(ctx, workdir, key)))
        segs.append({"uri": f"{n}.ts", "key": key, "start": t, "seconds": dur})
        n, t = n + 1, t + dur
    return segs


def find(ctx, base: str, t0: float, t1: float, workdir=None, ffmpeg_bin: str = "ffmpeg") -> dict | None:
    """Every recording's segments in [t0, t1 + PAD_SEC], oldest first → {"segments", "complete"}, else None.
    complete: they reach t1 + PAD_SEC, or the newest recording holding some of them is over (recording-ended.json)."""
    end = t1 + PAD_SEC
    hit, reach, over = [], 0.0, False
    for rec in reversed(recordings(ctx, base, t0 - LOOKBACK_SEC, t1)):
        renditions = _list(ctx, f"{rec}media/hls/", True)
        if not renditions:
            continue
        segs = _segments(ctx, max(renditions, key=_rank), end, workdir, ffmpeg_bin)
        mine = [s for s in segs if s["start"] + s["seconds"] > t0 and s["start"] < end]
        if mine:
            hit += mine
            reach = max(reach, segs[-1]["start"] + segs[-1]["seconds"])
            over = f"{rec}events/recording-ended.json" in _list(ctx, f"{rec}events/", False)
    if not hit:
        return None
    return {"segments": sorted(hit, key=lambda s: s["start"]), "complete": reach >= end or over}


def wait_for(ctx, base: str, t0: float, t1: float, workdir: str, ffmpeg_bin: str, wait: float = WAIT_SEC) -> dict:
    """find() until the recording holds the whole window, at most `wait` seconds; then what there is. Raises
    NoRecording when none of the window is recorded."""
    end = time.time() + wait
    while True:
        got = find(ctx, base, t0, t1, workdir, ffmpeg_bin)
        if (got and got["complete"]) or time.time() >= end:
            break
        time.sleep(POLL_SEC)
    if not got:
        raise NoRecording("IVS 녹화에서 이 판을 찾지 못했어요 (채널 녹화가 켜져 있는지 확인해 주세요)")
    return got


def _clip_time(segs: list, t: float) -> float:
    """A wall-clock time → seconds into the joined clip (a reconnect's gap is not in the clip)."""
    at = 0.0
    for s in segs:
        if t < s["start"]:
            return at
        if t < s["start"] + s["seconds"]:
            return at + t - s["start"]
        at += s["seconds"]
    return at


def cut(ctx, got: dict, workdir: str, dst: str, ffmpeg_bin: str, t0: float, t1: float) -> dict:
    """Joins the window's segments into one MP4 by stream copy (a 15-minute round takes seconds; the concat demuxer
    lines up the timestamps of segments from different recordings). A clip whose short side is under MIN_SIDE (the
    send had fallen) is scaled up to it. → {"seconds": the round's end + PAD_SEC in the clip, "offset": its start,
    "clipStart": epoch s, "recordingDirs", "upscaledFrom" if scaled}"""
    segs = got["segments"]
    listing = f"{workdir}/segments.txt"
    with open(listing, "w") as f:
        f.writelines(f"file '{_fetch(ctx, workdir, s['key'])}'\n" for s in segs)
    joined = f"{workdir}/joined.mp4"
    subprocess.run(ff.build_concat_cmd(ffmpeg_bin, listing, joined), check=True, capture_output=True, timeout=300)
    out = {"seconds": round(_clip_time(segs, t1 + PAD_SEC), 2), "offset": round(_clip_time(segs, t0), 2),
           "clipStart": segs[0]["start"], "recordingDirs": sorted({s["key"].rsplit("/", 1)[0] + "/" for s in segs})}
    w, h = resolution(ffmpeg_bin, joined)
    if 0 < min(w, h) < MIN_SIDE:
        subprocess.run(ff.build_upscale_cmd(ffmpeg_bin, joined, dst, MIN_SIDE), check=True, capture_output=True,
                       timeout=600)
        out["upscaledFrom"] = f"{w}x{h}"
    else:
        os.replace(joined, dst)
    return out
