"""A round's highlight is cut from the channel's IVS recording, not uploaded by the play window (a clip upload sinks
the WebRTC send's resolution)."""
import json
import shutil
import subprocess
import time as _time
from datetime import datetime, timezone

import pytest

from server import live, recording, store
from server.providers import ffmpeg as ff
from server.tests import hls_fixture as hls
from server.tests.conftest import FakeS3, FakeTable, make_ctx
from server.tests.test_live import Clock, FakeBedrock, FakeIvs

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(not FFMPEG, reason="needs a local ffmpeg")


class _ModuleClock:
    """live's and recording's `time`: the fake clock and sleep, everything else the real module. Patching the global
    time module would let any other thread's time.sleep land in `slept`."""

    def __init__(self, now, sleep):
        self.time, self.sleep = now, sleep

    def __getattr__(self, name):
        return getattr(_time, name)


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    c.slept = []

    def sleep(s):
        c.slept.append(s)
        c.t += s
        for hook in list(getattr(c, "on_sleep", [])):
            hook()
    fake = _ModuleClock(c, sleep)
    monkeypatch.setattr(live, "time", fake)
    monkeypatch.setattr(recording, "time", fake)
    return c


@pytest.fixture
def ctx(monkeypatch, clock):
    for k, v in {"LIVE_BUCKET": "live-b", "WEB_STREAM_GROUP_ID": "sg-web", "CDN_DOMAIN": "cdn.example",
                 "ACCOUNT_ID": hls.ACCOUNT}.items():
        monkeypatch.setenv(k, v)
    live._chan.clear()
    live._stream_cache.clear()
    return make_ctx(table=FakeTable(), s3=FakeS3(), ivs=FakeIvs())


SPEC = {"title": "네온 택배", "genre": "rpg-quest", "objective": {"type": "reach", "target": 3},
        "mission": {"title": "골목 택배 대작전", "stages": [{"label": "택배 상자 줍기"}, {"label": "고객 집 문 앞까지 운반"}]}}


def _session(ctx):
    s = store.put_session(ctx, "user-1", "t", "rpg-quest")
    sid = s["sessionId"]
    store.put_game(ctx, sid, {"gameId": "gm_1", "title": "네온 택배", "genre": "rpg-quest",
                              "specKey": "games/gm_1/spec.json", "previewUrl": "x"})
    ctx.s3._store[(ctx.assets_bucket, "games/gm_1/spec.json")] = json.dumps(SPEC).encode()
    store.put_asset(ctx, sid, {"kind": "trailer", "key": f"sessions/{sid}/t.mp4", "contentType": "video/mp4",
                               "meta": {"seconds": 12}})
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 9})
    live.highlight_settings(ctx, s, {"generate": True})
    return s


def _job(ctx):
    return json.loads(ctx.s3._store[("live-b", "broadcaster/job.json")])


def _hl(ctx, hid):
    return json.loads(ctx.s3._store[("live-b", live._hl_key(_job(ctx)["jobId"], hid))])


# ── the recording ────────────────────────────────────────────────────────────

def test_each_segment_gets_its_program_date_time():
    text = ("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-PROGRAM-DATE-TIME:2026-11-08T04:24:41.708Z\n#EXTINF:6.000,\n"
            "1.ts\n#EXTINF:5.5,\n2.ts\n#EXT-X-PROGRAM-DATE-TIME:2026-11-08T04:24:55.000Z\n#EXTINF:6.0,\n3.ts\n")
    t = datetime(2026, 11, 8, 4, 24, 41, 708000, tzinfo=timezone.utc).timestamp()
    segs = recording.parse_playlist(text)
    assert [s["uri"] for s in segs] == ["1.ts", "2.ts", "3.ts"]
    assert [round(s["start"], 3) for s in segs] == [t, t + 6, round(t + 13.292, 3)]
    assert [s["seconds"] for s in segs] == [6.0, 5.5, 6.0]
    assert recording.parse_playlist("#EXTM3U\n#EXTINF:6.0,\n1.ts\n") == []  # no date: nothing to map a round to


@needs_ffmpeg
def test_the_newest_recording_holding_the_round_its_best_rendition_and_only_the_round_segments(ctx, clock, tmp_path):
    text = hls.encode(FFMPEG, tmp_path / "enc", seconds=20)
    old, new = clock.t - 900, clock.t - 30  # an earlier broadcast's recording, then this one's
    hls.store(ctx.s3, ctx.assets_bucket, tmp_path / "enc", hls.redate(text, old), old, "recOld")
    d = hls.store(ctx.s3, ctx.assets_bucket, tmp_path / "enc", hls.redate(text, new), new, "recNew")
    ctx.s3._store[(ctx.assets_bucket, hls.rec_dir(new, "recNew", "160p30") + "playlist.m3u8")] = b"#EXTM3U\n"
    got = recording.find(ctx, hls.BASE, new + 6.5, new + 11)
    assert [s["key"] for s in got["segments"]] == [d + f"{n}.ts" for n in (3, 4, 5, 6)] and got["complete"]
    assert d.endswith("/recNew/media/hls/720p/")  # [6, 14): to the end + 2 s, from the tallest rendition
    assert recording.find(ctx, hls.BASE, old + 1, old + 5)["segments"][0]["key"].split("/")[-5] == "recOld"
    assert recording.find(ctx, hls.BASE, new + 40, new + 50) is None  # past what is recorded


@needs_ffmpeg
def test_a_playlist_lagging_its_segments_is_extended_from_the_segments_in_s3(ctx, clock, tmp_path):
    """A running recording's playlist lags the segments already in S3 (each lands ~3 s after it ends), and may even
    look finished: the cut is extended from the segments."""
    text = hls.encode(FFMPEG, tmp_path / "enc", seconds=30)
    rec = clock.t - 31
    # the playlist stops at 14 s (and even says ENDLIST); the segments up to 30 s are in S3; the recording runs on
    d = hls.store(ctx.s3, ctx.assets_bucket, tmp_path / "enc", hls.redate(text, rec, upto=14), rec, "r1", over=False)
    work = tmp_path / "w"
    work.mkdir()
    got = recording.wait_for(ctx, hls.BASE, rec + 4, rec + 25, str(work), FFMPEG)
    assert clock.slept == [] and got["complete"]
    assert [s["key"].rsplit("/", 1)[1] for s in got["segments"]] == [f"{n}.ts" for n in range(2, 14)]  # [4, 28)
    assert [round(s["start"] - rec, 2) for s in got["segments"]][-3:] == [22.0, 24.0, 26.0]
    clip = tmp_path / "clip.mp4"
    cut = recording.cut(ctx, got, str(work), str(clip), FFMPEG, rec + 4, rec + 25)
    assert cut["seconds"] == 23.0 and cut["offset"] == 0.0  # the round [4, 25] + 2 s, all of it
    assert abs(_duration(clip) - 24.0) < 0.2


@needs_ffmpeg
def test_late_segments_are_waited_for_until_the_round_end_plus_2_s(ctx, clock, tmp_path):
    text = hls.encode(FFMPEG, tmp_path / "enc", seconds=20)
    rec = clock.t - 12
    d = hls.store(ctx.s3, ctx.assets_bucket, tmp_path / "enc", hls.redate(text, rec, upto=6, ended=False), rec, "r1",
                  ts_upto=10, over=False)
    clock.on_sleep = [lambda: hls.land(ctx.s3, ctx.assets_bucket, tmp_path / "enc", d, 14)]
    work = tmp_path / "w"
    work.mkdir()
    got = recording.wait_for(ctx, hls.BASE, rec + 4, rec + 11, str(work), FFMPEG)
    assert clock.slept == [recording.POLL_SEC] and got["complete"]
    assert [s["key"].rsplit("/", 1)[1] for s in got["segments"]] == ["2.ts", "3.ts", "4.ts", "5.ts", "6.ts"]
    cut = recording.cut(ctx, got, str(work), str(tmp_path / "clip.mp4"), FFMPEG, rec + 4, rec + 11)
    assert cut["seconds"] == 9.0  # [4, 14): the round ends 2 s pad + 9 s in
    probe = subprocess.run([FFMPEG, "-hide_banner", "-i", str(tmp_path / "clip.mp4")], capture_output=True, text=True)
    assert "h264" in probe.stderr and "aac" in probe.stderr


@needs_ffmpeg
def test_a_round_split_by_a_reconnect_is_cut_across_both_recording_folders(ctx, clock, tmp_path):
    """A send restart ends the recording; the new stream session records into a new id in its own minute folder."""
    a_text = hls.encode(FFMPEG, tmp_path / "a", seconds=20)
    b_text = hls.encode(FFMPEG, tmp_path / "b", seconds=20)
    a, b = clock.t - 70, clock.t - 46  # 4 s gap between them (the restart); different minute folders
    hls.store(ctx.s3, ctx.assets_bucket, tmp_path / "a", hls.redate(a_text, a), a, "recA")
    db = hls.store(ctx.s3, ctx.assets_bucket, tmp_path / "b", hls.redate(b_text, b, ended=False), b, "recB", over=False)
    assert hls.rec_root(a, "recA").split("/")[-3] != hls.rec_root(b, "recB").split("/")[-3]
    work = tmp_path / "w"
    work.mkdir()
    got = recording.wait_for(ctx, hls.BASE, a + 10, b + 6, str(work), FFMPEG)  # the round: [a+10, a+30]
    names = [s["key"].split("/")[-5] + "/" + s["key"].rsplit("/", 1)[1] for s in got["segments"]]
    assert names == [f"recA/{n}.ts" for n in range(5, 10)] + [f"recB/{n}.ts" for n in range(0, 4)]
    clip = tmp_path / "clip.mp4"
    cut = recording.cut(ctx, got, str(work), str(clip), FFMPEG, a + 10, b + 6)
    assert cut["seconds"] == 18.0 and cut["offset"] == 0.0  # 10 s of A + 8 s of B (to the end + 2 s)
    assert abs(_duration(clip) - 18.0) < 0.3


@needs_ffmpeg
def test_a_clip_under_pegasus_minimum_resolution_is_scaled_up_keeping_its_aspect(ctx, clock, tmp_path):
    """Pegasus refuses a clip under its minimum resolution ("The resolution of the video is too low"), which would
    leave the title at its fallback."""
    text = hls.encode(FFMPEG, tmp_path / "enc", seconds=10, size="480x270")
    rec = clock.t - 20
    hls.store(ctx.s3, ctx.assets_bucket, tmp_path / "enc", hls.redate(text, rec), rec, "r1")
    work = tmp_path / "w"
    work.mkdir()
    got = recording.wait_for(ctx, hls.BASE, rec + 1, rec + 7, str(work), FFMPEG)
    clip = tmp_path / "clip.mp4"
    cut = recording.cut(ctx, got, str(work), str(clip), FFMPEG, rec + 1, rec + 7)
    assert cut["upscaledFrom"] == "480x270"
    probe = subprocess.run([FFMPEG, "-hide_banner", "-i", str(clip)], capture_output=True, text=True).stderr
    assert "640x360" in probe and "aac" in probe
    assert recording.resolution(FFMPEG, str(clip)) == (640, 360)


def test_no_recording_gives_up_after_the_wait(ctx, clock, tmp_path):
    with pytest.raises(recording.NoRecording):
        recording.wait_for(ctx, hls.BASE, clock.t - 20, clock.t - 5, str(tmp_path), FFMPEG or "ffmpeg")
    assert sum(clock.slept) <= recording.WAIT_SEC + recording.POLL_SEC


def _duration(path):
    return ff.parse_ffmpeg_duration(subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)], capture_output=True,
                                                   text=True).stderr)


# ── the highlight flow ─────────────────────────────────────────────────────────

def test_the_play_window_reports_the_round_window_on_its_clock_and_the_server_moves_it_to_its_own(ctx, clock):
    s = _session(ctx)
    skew = 3.0  # the browser's clock runs 3 s ahead of the server's
    ms = lambda t: int((t + skew) * 1000)  # noqa: E731
    made = live.highlight_create(ctx, s, {"round": 2, "startedAt": ms(clock.t - 40), "endedAt": ms(clock.t - 1),
                                          "sentAt": ms(clock.t)})
    assert "uploadUrl" not in made  # nothing to upload: the server cuts the clip
    hl = _hl(ctx, made["id"])
    assert hl["state"] == "analyzing" and hl["round"] == 2 and hl["gameId"] == "gm_1"
    assert hl["window"] == [clock.t - 40, clock.t - 1]
    assert hl["recording"] == f"ivs/v1/{hls.ACCOUNT}/ch1/"
    long = live.highlight_create(ctx, s, {"round": 3, "startedAt": ms(clock.t - 1000), "endedAt": ms(clock.t),
                                          "sentAt": ms(clock.t)})
    assert long["window"] == [clock.t - 900, clock.t]  # a 16-minute round: its last 15 minutes (Pegasus's limit is far)
    for bad in ({"round": 2, "startedAt": ms(clock.t), "endedAt": ms(clock.t - 5), "sentAt": ms(clock.t)},
                {"round": 2, "startedAt": ms(clock.t - 0.5), "endedAt": ms(clock.t), "sentAt": ms(clock.t)},
                {"round": 2, "startedAt": ms(clock.t - 9), "endedAt": ms(clock.t)}):
        with pytest.raises(live.LiveError) as e:
            live.highlight_create(ctx, s, bad)
        assert e.value.status == 400


@needs_ffmpeg
def test_the_highlight_is_cut_from_the_recording_and_pegasus_hears_the_game_title_genre_and_mission(ctx, clock, tmp_path):
    font = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
    if not __import__("os").path.exists(font):
        pytest.skip("needs a Korean font")
    s = _session(ctx)
    text = hls.encode(FFMPEG, tmp_path / "enc", seconds=20)
    rec = clock.t - 25
    hls.store(ctx.s3, ctx.assets_bucket, tmp_path / "enc", hls.redate(text, rec, ended=False), rec, "r1")
    made = live.highlight_create(ctx, s, {"round": 1, "startedAt": int((rec + 4) * 1000),
                                          "endedAt": int((rec + 13) * 1000), "sentAt": int(clock.t * 1000)})
    ctx.bedrock_rt_east = FakeBedrock([{"start_sec": 3, "end_sec": 5, "excitement": "high", "title": "문 앞 도착!"}])
    ctx.ffmpeg_bin, ctx.font_path = FFMPEG, font
    out = live.highlight_run(ctx, s["sessionId"], _job(ctx)["jobId"], made["id"])
    assert out["state"] == "ready", out.get("error")
    assert out["title"] == "문 앞 도착!" and (out["start"], out["end"]) == (2.0, 6.0)
    clip = ctx.s3._store[(ctx.assets_bucket, out["sourceKey"])]
    assert out["sourceKey"].endswith("/round.mp4") and clip[4:8] == b"ftyp"
    assert out["seconds"] == 11.0  # [4, 16): the round's end + 2 s pad, 11 s in
    base = out["sourceKey"].rsplit("/", 1)[0]
    assert ctx.s3._store[(ctx.assets_bucket, f"{base}/short.mp4")] and ctx.s3._store[(ctx.assets_bucket, f"{base}/wide.mp4")]
    _, body = ctx.bedrock_rt_east.bodies[0]
    assert body["mediaSource"]["s3Location"]["uri"].endswith(out["sourceKey"])
    seg = body["segment_definitions"][0]
    told = seg["description"] + seg["fields"][0]["description"]
    for word in ("네온 택배", "rpg-quest", "골목 택배 대작전", "택배 상자 줍기", "고객 집 문 앞까지 운반"):
        assert word in told
    assert "objectives captured" not in seg["description"]  # no shooter vocabulary forced on every game


def test_no_recording_fails_the_card_with_the_reason(ctx, clock):
    s = _session(ctx)
    made = live.highlight_create(ctx, s, {"round": 1, "startedAt": int((clock.t - 30) * 1000),
                                          "endedAt": int((clock.t - 1) * 1000), "sentAt": int(clock.t * 1000)})
    out = live.highlight_run(ctx, s["sessionId"], _job(ctx)["jobId"], made["id"])
    assert out["state"] == "failed" and "IVS 녹화" in out["error"]


def test_the_korean_rewrite_hears_the_game_too():
    seen = []

    class Conv:
        def converse(self, **kw):
            seen.append(kw["messages"][0]["content"][0]["text"])
            return {"output": {"message": {"content": [{"text": "문 앞 도착!"}]}}}
    assert live.korean_title(make_ctx(bedrock_rt_east=Conv()), "Package Dropped Off", "「네온 택배」 (rpg-quest)") == "문 앞 도착!"
    assert "네온 택배" in seen[0]


def test_the_round_report_starts_the_cut_in_a_self_invoke(ctx, monkeypatch):
    from server import app
    from server.tests.conftest import FakeLambda
    s = _session(ctx)
    ctx.lambda_ = FakeLambda()
    monkeypatch.setenv("SELF_FUNCTION_NAME", "ipverse-api")
    monkeypatch.setattr(app, "_own_session", lambda c, user, sid: s)
    now = int(live.time.time() * 1000)
    status, hl = app.highlight_create(ctx, {"sub": "user-1"}, {"round": 1, "startedAt": now - 30_000,
                                                               "endedAt": now - 500, "sentAt": now}, s["sessionId"])
    assert status == 202 and hl["state"] == "analyzing"
    [call] = ctx.lambda_.calls
    assert json.loads(call["Payload"]) == {"action": "highlight", "sessionId": s["sessionId"],
                                           "jobId": _job(ctx)["jobId"], "id": hl["id"], "lang": "ko"}
