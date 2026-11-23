"""An IVS recording session for tests: ffmpeg's own HLS of a test pattern (H.264 + AAC in N.ts segments, with
EXT-X-PROGRAM-DATE-TIME), its dates moved to the test's clock and laid out in the fake S3 as IVS writes it:
  ivs/v1/<account>/<channel>/<year>/<month>/<day>/<hour>/<minute>/<recording id>/
    events/recording-started.json, events/recording-ended.json (once the recording is over)
    media/hls/master.m3u8, media/hls/720p/playlist.m3u8 (EVENT, Twitch tags, SCTE-35 DATERANGEs), media/hls/720p/N.ts
A reconnect of the send starts a new recording id in its own minute folder. While the recording runs, its playlist can
lag the segments already in S3."""
import pathlib
import subprocess
import time

ACCOUNT, CHANNEL = "123", "ch1"
BASE = f"ivs/v1/{ACCOUNT}/{CHANNEL}/"


def _iso(t: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int(round(t % 1 * 1000)) % 1000:03d}Z"


def encode(ffmpeg: str, out: pathlib.Path, seconds: int = 20, seg: int = 2, size: str = "1280x720") -> str:
    """ffmpeg's HLS (program_date_time on) of `seconds` of a pattern in `seg`-second segments → its playlist"""
    out.mkdir(parents=True, exist_ok=True)
    subprocess.run([ffmpeg, "-y", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=30:duration={seconds}",
                    "-f", "lavfi", "-t", str(seconds), "-i", "anullsrc=r=48000:cl=stereo",
                    "-c:v", "libx264", "-preset", "ultrafast", "-g", str(30 * seg), "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-f", "hls", "-hls_time", str(seg), "-hls_list_size", "0",
                    "-hls_flags", "program_date_time", "-hls_segment_filename", str(out / "%d.ts"),
                    str(out / "playlist.m3u8")], check=True, capture_output=True)
    return (out / "playlist.m3u8").read_text()


def redate(text: str, started: float, upto: float | None = None, ended: bool = True) -> str:
    """ffmpeg's playlist as IVS writes it: Twitch header tags, each segment's PROGRAM-DATE-TIME from `started` (UTC,
    Z), an ad break's SCTE-35 DATERANGE on the second segment; upto: only the segments that start before that many
    seconds; ended: ENDLIST."""
    lines, t, dur, keep, n = [], started, None, True, 0
    for line in text.splitlines():
        if line.startswith("#EXT-X-PROGRAM-DATE-TIME:") or line == "#EXT-X-ENDLIST":
            continue
        if line.startswith("#EXT-X-MEDIA-SEQUENCE"):
            lines += ["#EXT-X-PLAYLIST-TYPE:EVENT", line, "#EXT-X-TWITCH-ELAPSED-SECS:0.000"]
            continue
        if line.startswith("#EXTINF:"):
            dur = float(line[8:].split(",")[0])
            keep = upto is None or t - started < upto
            if keep:
                if n == 1:
                    lines.append(f'#EXT-X-DATERANGE:ID="brk",START-DATE="{_iso(t)}",PLANNED-DURATION=1.000,SCTE35-OUT=0xFC30')
                lines += [f"#EXT-X-PROGRAM-DATE-TIME:{_iso(t)}", line]
            continue
        if line and not line.startswith("#") and dur is not None:
            if keep:
                lines.append(line)
            t, dur, n = t + dur, None, n + 1
            continue
        lines.append(line)
    return "\n".join(lines + (["#EXT-X-ENDLIST"] if ended else [])) + "\n"


def rec_root(started: float, rec_id: str) -> str:
    g = time.gmtime(started)
    return f"{BASE}{g.tm_year}/{g.tm_mon}/{g.tm_mday}/{g.tm_hour}/{g.tm_min}/{rec_id}/"


def rec_dir(started: float, rec_id: str, rendition: str = "720p") -> str:
    return f"{rec_root(started, rec_id)}media/hls/{rendition}/"


def store(s3, bucket: str, src: pathlib.Path, playlist: str, started: float, rec_id: str,
          ts_upto: float | None = None, over: bool = True, seg: float = 2.0) -> str:
    """The playlist, the segments (ts_upto: only those that start before that many seconds have landed), the events
    (over: recording-ended.json too) and the master playlist in the fake S3 → the rendition dir"""
    d = rec_dir(started, rec_id)
    for ts in src.glob("*.ts"):
        if ts_upto is None or int(ts.stem) * seg < ts_upto:
            s3._store[(bucket, d + ts.name)] = ts.read_bytes()
    s3._store[(bucket, d + "playlist.m3u8")] = playlist.encode()
    root = rec_root(started, rec_id)
    s3._store[(bucket, root + "media/hls/master.m3u8")] = b"#EXTM3U\n720p/playlist.m3u8\n"
    s3._store[(bucket, root + "events/recording-started.json")] = b'{"recording_status":"RECORDING_STARTED"}'
    if over:
        s3._store[(bucket, root + "events/recording-ended.json")] = b'{"recording_status":"RECORDING_ENDED"}'
    return d


def land(s3, bucket: str, src: pathlib.Path, d: str, upto: float, seg: float = 2.0):
    """More segments land (those that start before `upto` seconds)."""
    for ts in src.glob("*.ts"):
        if int(ts.stem) * seg < upto:
            s3._store[(bucket, d + ts.name)] = ts.read_bytes()
