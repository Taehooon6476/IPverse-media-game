import io
import json
import os
import shutil
import subprocess
import xml.etree.ElementTree as ET

import pytest
from botocore.exceptions import ClientError

from server import live, playable, store, streams
from server.tests import hls_fixture
from server.tests.conftest import FakeS3, FakeTable, make_ctx


def _err(code, op="Op"):
    return ClientError({"Error": {"Code": code, "Message": code}}, op)


class FakeIvs:
    """The player channel: ad breaks, timed metadata, stream state."""

    def __init__(self):
        self.calls, self.live, self.conflicts, self.fail = [], True, 0, None

    def list_channels(self, filterByName):
        return {"channels": [{"arn": "arn:ivs:channel/ch1", "name": "ipverse-live-player"},
                             {"arn": "arn:ivs:channel/other", "name": "ipverse-live-player-old"}]}

    def get_channel(self, arn):
        return {"channel": {"arn": arn, "playbackUrl": "https://abc.us-east-1.playback.live-video.net/api/video/v1/ch1.m3u8",
                            "adConfigurationArn": "arn:ivs:ad-configuration/ad1"}}

    def get_stream(self, channelArn):
        if not self.live:
            raise _err("ChannelNotBroadcasting", "GetStream")
        return {"stream": {"state": "LIVE"}}

    def insert_ad_break(self, channelArn, durationSeconds):
        if self.fail:
            raise _err(self.fail, "InsertAdBreak")
        if self.conflicts:
            self.conflicts -= 1
            raise _err("ConflictException", "InsertAdBreak")
        self.calls.append(("break", channelArn, durationSeconds))
        return {"adBreakId": f"brk{len(self.calls)}"}

    def put_metadata(self, channelArn, metadata):
        if not self.live:
            raise _err("ChannelNotBroadcasting", "PutMetadata")
        assert len(metadata.encode()) <= 1024
        self.calls.append(("meta", channelArn, json.loads(metadata)))

    def stop_stream(self, channelArn):
        if not self.live:
            raise _err("ChannelNotBroadcasting", "StopStream")
        self.calls.append(("stop", channelArn))

    def breaks(self):
        return [c[2] for c in self.calls if c[0] == "break"]


class FakeGls:
    """The web stream group (its one location) and the stream sessions playable.start opens."""

    def __init__(self):
        self.loc = {"LocationName": "us-west-2", "AlwaysOnCapacity": 0, "OnDemandCapacity": 3, "MaximumCapacity": 3,
                    "TargetIdleCapacity": 0}
        self.updates, self.sessions, self.fail = [], [], 0

    def get_stream_group(self, Identifier):
        return {"LocationStates": [dict(self.loc)], "DefaultApplication": {"Id": "a-1"}}

    def update_stream_group(self, Identifier, LocationConfigurations):
        if self.fail:
            self.fail -= 1
            raise _err("ConflictException", "UpdateStreamGroup")
        cfg = LocationConfigurations[0]
        assert "OnDemandCapacity" not in cfg  # cannot be sent with TargetIdleCapacity
        self.updates.append(cfg)
        self.loc.update(cfg)

    def start_stream_session(self, **kw):
        self.sessions.append(kw)
        return {"Arn": f"arn:gls:stream/s-{len(self.sessions)}", "Status": "ACTIVATING"}

    def get_stream_session(self, Identifier, StreamSessionIdentifier):
        kw = self.sessions[int(StreamSessionIdentifier.split("-")[1]) - 1]
        return {"Status": "ACTIVE", "Description": kw["Description"]}

    def idle(self):
        return [u["TargetIdleCapacity"] for u in self.updates]


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(live.time, "time", c)
    return c


@pytest.fixture
def ctx(monkeypatch, clock):
    for k, v in {"LIVE_BUCKET": "live-b", "WEB_STREAM_GROUP_ID": "sg-web", "CDN_DOMAIN": "cdn.example"}.items():
        monkeypatch.setenv(k, v)
    live._chan.clear()
    live._stream_cache.clear()
    streams._app_cache.clear()
    gls = FakeGls()
    monkeypatch.setattr(streams, "client", lambda: gls)
    monkeypatch.setattr(live.time, "sleep", lambda s: None)
    c = make_ctx(table=FakeTable(), s3=FakeS3(), ivs=FakeIvs())
    c.gls = gls
    return c


def _session(ctx, trailer=12.0):
    s = store.put_session(ctx, "user-1", "t", "sf-shooter")
    sid = s["sessionId"]
    store.put_game(ctx, sid, {"gameId": "gm_1", "title": "G", "genre": "sf-shooter", "specKey": "k", "previewUrl": "x"})
    ctx.s3._store[(ctx.assets_bucket, "games/gm_1/runtime3d.js")] = b"const standby = query.get('standby');"
    if trailer:
        store.put_asset(ctx, sid, {"kind": "trailer", "key": f"sessions/{sid}/t.mp4", "contentType": "video/mp4",
                                   "meta": {"seconds": trailer}})
    return s


def _job(ctx):
    return json.loads(ctx.s3._store[("live-b", "broadcaster/job.json")])


def _known_trailer(ctx, s, clock):
    """MediaTailor transcoded this trailer in an earlier broadcast (the registry remembers it)."""
    url = store.public_url(ctx, f"sessions/{s['sessionId']}/t.mp4")
    ctx.s3._store[("live-b", live.WARM_REGISTRY)] = json.dumps({url: clock.t - 3600}).encode()


def _edit_job(ctx, **fields):
    job = _job(ctx)
    job.update(fields)
    ctx.s3._store[("live-b", "broadcaster/job.json")] = json.dumps(job).encode()


def _vast_url(ctx):
    return ET.fromstring(ctx.s3._store[("live-b", live.VAST_KEY)]).find(".//MediaFile").text


def _after_break(ctx, clock):
    """Time passes until the last break no longer owns the VAST file."""
    clock.t = max(clock.t, _job(ctx).get("breakUntil", 0)) + 1


def test_vast_points_at_the_trailer_with_its_duration():
    doc = ET.fromstring(live.vast("제나 & 친구", "https://cdn/t.mp4", 24.54))
    assert doc.find(".//Duration").text == "00:00:24.540"
    assert doc.find(".//MediaFile").text == "https://cdn/t.mp4"
    assert doc.find(".//AdTitle").text == "제나 & 친구"


def test_start_queues_the_trailer_warm_up_and_status_follows_the_ivs_stream(ctx):
    s = _session(ctx, trailer=35.63)
    ctx.ivs.live = False
    out = live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 2})
    job = _job(ctx)
    assert (job["mode"], job["input"], job["adType"], job["everyRounds"]) == ("player", "ivs", "trailer", 2)
    assert job["warm"][0]["url"].endswith("/t.mp4")  # MediaTailor sees the trailer in a warm-up first
    assert out["active"] and out["channelState"] == "STARTING"  # on air, the play window has not published yet
    assert out["playbackUrl"].endswith("ch1.m3u8") and out["adInsertion"] == "ivs" and out["ingest"]
    ctx.ivs.live = True
    live._stream_cache.clear()
    assert live.status(ctx, s)["channelState"] == "RUNNING"
    assert ctx.gls.updates == []  # a trailer broadcast holds no GameLift Streams host
    with pytest.raises(live.LiveError):
        live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 0})
    with pytest.raises(live.LiveError):
        live.start(ctx, s, {"gameId": "gm_1", "mode": "bot"})
    live.stop(ctx, s)
    assert _job(ctx)["stop"] is True and ("stop", "arn:ivs:channel/ch1") in ctx.ivs.calls
    assert not live.status(ctx, s)["active"]


def test_status_of_other_sessions_does_not_call_get_stream(ctx):
    s = _session(ctx)
    other = store.put_session(ctx, "user-2", "t", "sf-shooter")
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 2})
    ctx.ivs.get_stream = lambda **kw: pytest.fail("GetStream for a window that is not on air")
    out = live.status(ctx, other)
    assert not out["active"] and out["channelState"] == "IDLE"


def test_every_n_rounds_insert_an_ad_break_as_long_as_the_trailer(ctx, clock):
    s = _session(ctx, trailer=35.63)
    _known_trailer(ctx, s, clock)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 2})
    assert _job(ctx)["warm"] == []  # nothing to warm
    assert live.round_done(ctx, s, {"rounds": 1})["cued"] is False
    r = live.round_done(ctx, s, {"rounds": 2})
    assert r["cued"] is True and r["breaks"][0]["kind"] == "trailer" and r["breaks"][0]["eventId"] == "brk2"  # the fake numbers its calls: the break follows its mark
    assert ctx.ivs.breaks() == [36]  # rounded up: a shorter break leaves it empty
    assert _vast_url(ctx).endswith("/t.mp4")
    # the files: until it is on the screens plus the longer of its length and the late viewers' margin; on air (in
    # the stream): its length from its place
    assert _job(ctx)["breakUntil"] == clock.t + live.AD_LEAD_SEC + 36
    assert _job(ctx)["airUntil"] == clock.t + live.STREAM_LEAD_SEC + 36
    assert live.round_done(ctx, s, {"rounds": 2})["cued"] is False  # the same round reported twice
    _after_break(ctx, clock)
    ctx.ivs.conflicts = 1  # a break IVS still runs: retried
    assert live.round_done(ctx, s, {"rounds": 4})["cued"] is True
    _after_break(ctx, clock)
    ctx.ivs.fail = "ChannelNotBroadcasting"
    r = live.round_done(ctx, s, {"rounds": 6})
    assert r["cued"] is False and r["rounds"] == 6 and len(r["breaks"]) == 2  # counted, no phantom break
    live.stop(ctx, s)
    with pytest.raises(live.LiveError):
        live.round_done(ctx, s, {"rounds": 8})


def test_a_new_trailer_never_holds_its_round_a_corner_goes_at_once_and_the_break_once_it_is_ready(ctx, clock):
    """A round's ad never waits for a warm-up's files or a transcode: the round's end gets each viewer's corner
    trailer at once (no break that no viewer would get, test_round20_first_ad.py), the warm-up keeps its files, and
    the break goes at the first ad round after the transcode time."""
    s = _session(ctx, trailer=35.63)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1})
    assert live.viewer(ctx, s) == {"warmed": True}  # the trailer's 1 s warm-up now owns the VAST file
    warmed = _job(ctx)["warmedAt"][_job(ctx)["adUrl"]]
    assert ctx.ivs.breaks() == [1]
    r = live.round_done(ctx, s, {"rounds": 1})
    assert (r["cued"], r["corner"], r["deferred"]) == (False, True, False)
    assert ctx.ivs.breaks() == [1] and "pendingCue" not in _job(ctx)
    assert _job(ctx)["warmedAt"][_job(ctx)["adUrl"]] == warmed  # not spoiled: a corner takes no files
    clock.t = warmed + live.TRANSCODE_SEC + 1
    r = live.round_done(ctx, s, {"rounds": 2})
    assert r["cued"] is True and ctx.ivs.breaks() == [1, 36]
    assert _vast_url(ctx).endswith("/t.mp4")
    live.status(ctx, s)
    live.status(ctx, s)
    assert ctx.ivs.breaks() == [1, 36]  # once
    assert [b["kind"] for b in live.status(ctx, s)["stream"]["breaks"]] == ["corner", "trailer"]


def test_concurrent_job_writes_keep_each_others_fields(ctx):
    s = _session(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1})
    job_id = _job(ctx)["jobId"]
    sneaked = []

    def change(job):  # another handler writes between this read and its conditional write
        if not sneaked:
            sneaked.append(1)
            other = _job(ctx)
            other["stop"] = True
            ctx.s3._store[("live-b", "broadcaster/job.json")] = json.dumps(other).encode()
        job["beatAt"] = 123
    live._update_job(ctx, job_id, change)
    assert _job(ctx)["stop"] is True and _job(ctx)["beatAt"] == 123  # re-read and re-applied, nothing lost


def test_playable_breaks_are_timed_metadata_and_an_idle_host_is_held_until_stop(ctx):
    s = _session(ctx, trailer=0)
    with pytest.raises(live.LiveError):  # a trailer break needs a trailer
        live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 2})
    with pytest.raises(live.LiveError):
        live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "banner"})
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 2, "adType": "playable", "playableSeconds": 60})
    job = _job(ctx)
    assert job["standby"] is True and job["playUrl"].startswith("https://cdn.example/#ad=ad_")
    # only the idle host changes: the group's maximum (3 here) and always-on capacity stay as deployed
    assert ctx.gls.updates == [{"LocationName": "us-west-2", "AlwaysOnCapacity": 0, "MaximumCapacity": 3, "TargetIdleCapacity": 1}]
    assert live.round_done(ctx, s, {"rounds": 9})["cued"] is False  # the page played 8 rounds before going live
    r = live.round_done(ctx, s, {"rounds": 10})
    assert r["cued"] is True and r["breaks"][0]["playable"] is True and r["breaks"][0]["adId"] == job["playableAdId"]
    [(_, _, meta)] = [c for c in ctx.ivs.calls if c[0] == "meta"]
    assert meta == {"type": "playable", "e": r["breaks"][0]["eventId"], "adId": job["playableAdId"], "seconds": 60, "round": 10, "title": "G"}
    assert not ctx.ivs.breaks()  # no video ad: the card is the ad
    ctx.ivs.live = False
    assert live.round_done(ctx, s, {"rounds": 12})["cued"] is False  # not live: counted, no card
    live.stop(ctx, s)
    assert ctx.gls.idle() == [1, 0] and _job(ctx)["standby"] is False  # the held host is released


def test_a_failed_release_is_retried_by_reap_until_the_host_is_gone(ctx):
    s = _session(ctx, trailer=0)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 2, "adType": "playable"})
    ctx.gls.fail = 1
    live.stop(ctx, s)
    assert ctx.gls.loc["TargetIdleCapacity"] == 1 and _job(ctx)["standby"] is True and _job(ctx)["standbyError"]
    live.reap(ctx)
    assert ctx.gls.loc["TargetIdleCapacity"] == 0 and _job(ctx)["standby"] is False
    ctx.gls.loc["TargetIdleCapacity"] = 1  # held by something no broadcast tracks
    live.reap(ctx)
    assert ctx.gls.loc["TargetIdleCapacity"] == 0


def test_a_viewer_warms_each_new_creative_once_while_no_break_owns_the_vast(ctx, clock):
    s = _session(ctx, trailer=35.63)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1})
    ctx.ivs.live = False
    live._stream_cache.clear()
    assert live.viewer(ctx, s) == {"warmed": False}  # nothing to warm until the stream is live
    ctx.ivs.live = True
    live._stream_cache.clear()
    assert live.viewer(ctx, s) == {"warmed": True}
    assert ctx.ivs.breaks() == [1]  # 1 s: too short to show the trailer
    _after_break(ctx, clock)
    assert live.viewer(ctx, s) == {"warmed": False} and list(_job(ctx)["warmedAt"]) == [_job(ctx)["adUrl"]]
    job = _job(ctx)
    live._want_warm(job, "https://cdn/hl.mp4", "역전!", 5.0, "hl_1")
    _edit_job(ctx, warm=job["warm"], breakUntil=clock.t + 30, breakKind="break")  # a real break owns the file
    assert live.viewer(ctx, s) == {"warmed": False}
    clock.t += 31
    assert live.viewer(ctx, s) == {"warmed": True} and _vast_url(ctx) == "https://cdn/hl.mp4"


def test_a_closed_window_is_reaped_and_its_stream_ended(ctx):
    s = _session(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable"})
    assert live.reap(ctx) == {"reaped": False}  # just started: no beat needed yet
    live.beat(ctx, s)
    assert live.reap(ctx) == {"reaped": False}
    _edit_job(ctx, beatAt=_job(ctx)["beatAt"] - live.BEAT_TIMEOUT_SEC - 5)  # the play window went away
    assert live.reap(ctx) == {"reaped": True}
    assert _job(ctx)["stop"] is True and ("stop", "arn:ivs:channel/ch1") in ctx.ivs.calls
    assert ctx.gls.loc["TargetIdleCapacity"] == 0


def test_stop_from_another_session_leaves_the_broadcast_alone(ctx):
    s = _session(ctx)
    other = store.put_session(ctx, "user-2", "t", "sf-shooter")
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable"})
    live.stop(ctx, other)
    assert "stop" not in _job(ctx) and not [c for c in ctx.ivs.calls if c[0] == "stop"]
    assert ctx.gls.loc["TargetIdleCapacity"] == 1


def test_ad_spec_changes_on_air_and_the_count_restarts(ctx, clock):
    s = _session(ctx)
    _known_trailer(ctx, s, clock)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 2})
    live.ad_settings(ctx, s, {"everyRounds": 3})  # before the first report: that report still sets the base
    assert "roundBase" not in _job(ctx)
    assert live.round_done(ctx, s, {"rounds": 9})["cued"] is False  # 8 rounds before going live
    live.ad_settings(ctx, s, {"adType": "playable", "everyRounds": 3, "playableSeconds": 60})
    job = _job(ctx)
    assert (job["adType"], job["everyRounds"], job["playableSeconds"], job["roundBase"], job["standby"]) == ("playable", 3, 60, 9, True)
    assert not live.round_done(ctx, s, {"rounds": 11})["cued"]
    assert live.round_done(ctx, s, {"rounds": 12})["breaks"][-1]["playable"] is True  # 3 rounds after the change
    live.ad_settings(ctx, s, {"adType": "trailer", "everyRounds": 1})
    assert _job(ctx)["standby"] is True and ctx.gls.loc["TargetIdleCapacity"] == 1  # warm for a switch back a while
    clock.t += live.STANDBY_GRACE_SEC + 1
    live.reap(ctx)
    assert _job(ctx)["standby"] is False and ctx.gls.loc["TargetIdleCapacity"] == 0
    assert live.round_done(ctx, s, {"rounds": 13})["breaks"][-1]["kind"] == "trailer"
    with pytest.raises(live.LiveError):
        live.ad_settings(ctx, s, {"everyRounds": 0})


def test_standby_sessions_only_for_the_running_playable_broadcast(ctx):
    s = _session(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable", "playableSeconds": 60})
    ad_id = _job(ctx)["playableAdId"]
    other = playable.create(ctx, s, {"gameId": "gm_1", "seconds": 60})["adId"]
    assert "standbyToken" not in _job(ctx)  # job.json is readable through the live CDN: the token is not in it
    token = live.status(ctx, s)["job"]["standbyToken"]  # only the owner's status carries it
    assert token and live.status(ctx, store.put_session(ctx, "user-2", "t", "sf-shooter"))["job"] is None
    with pytest.raises(playable.AdError) as refused:  # no token: nothing starts
        playable.start(ctx, ad_id, {"signalRequest": "sdp", "standby": True})
    assert refused.value.status == 409 and ctx.gls.sessions == []
    out = playable.start(ctx, ad_id, {"signalRequest": "sdp", "standby": True, "standbyToken": token})
    assert out["standby"] is True
    kw = ctx.gls.sessions[-1]
    assert "&standby=1" in kw["AdditionalEnvironmentVariables"]["IPVERSE_GAME_URL"]
    assert kw["SessionLengthSeconds"] >= live.MAX_MINUTES * 60  # outlives the broadcast cap
    assert playable.get(ctx, ad_id).get("plays", 0) == 0  # counted when played
    assert playable.played(ctx, ad_id, "s-1")["plays"] == 1 and playable.played(ctx, ad_id, "s-1")["plays"] == 1
    out = playable.start(ctx, other, {"signalRequest": "sdp"})  # the public ad page: a normal, counted session
    assert out["standby"] is False and ctx.gls.sessions[-1]["SessionLengthSeconds"] == 60 + playable.GRACE_SEC
    assert playable.played(ctx, other, "s-2")["plays"] == 1  # counted at its start, not again
    live.stop(ctx, s)
    with pytest.raises(playable.AdError):  # the broadcast is over
        playable.start(ctx, ad_id, {"signalRequest": "sdp", "standby": True, "standbyToken": token})
    ctx.s3._store[(ctx.assets_bucket, "games/gm_1/runtime3d.js")] = b"an old runtime"  # starts its round on load
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable"})
    assert _job(ctx)["standbyCapable"] is False
    with pytest.raises(playable.AdError):
        playable.start(ctx, _job(ctx)["playableAdId"], {"signalRequest": "sdp", "standby": True,
                                                         "standbyToken": live.status(ctx, s)["job"]["standbyToken"]})


def test_pick_moment_prefers_the_most_exciting_and_clamps_to_4_to_6_seconds():
    segs = [{"start_sec": 3, "end_sec": 5, "excitement": "medium", "title": "a"},
            {"start_sec": 40, "end_sec": 41, "excitement": "high", "title": "보스 격파"},
            {"start_sec": 50, "end_sec": 70, "excitement": "high", "title": "late"}]
    m = live.pick_moment(segs, 60)
    assert m["title"] == "late" and (m["start"], m["end"]) == (54.0, 60.0)  # 6 s max, kept inside the video
    m = live.pick_moment(segs[:2], 60)
    assert m["title"] == "보스 격파" and (m["start"], m["end"]) == (38.5, 42.5)  # widened to 4 s around the moment
    m = live.pick_moment([{"start_sec": "x"}], 30)
    assert (m["start"], m["end"], m["title"]) == (24.5, 29.5, None)  # no usable segment: the round's last seconds


class FakeBedrock:
    def __init__(self, segments):
        self.segments, self.bodies = segments, []

    def invoke_model(self, modelId, body):
        self.bodies.append((modelId, json.loads(body)))
        return {"body": io.BytesIO(json.dumps({"segments": self.segments}).encode())}


def test_highlight_pipeline_then_overlay_metadata_and_a_linear_break_only_after_its_warm_up(ctx, clock, monkeypatch, tmp_path):
    ffmpeg = shutil.which("ffmpeg")
    font = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
    if not ffmpeg or not os.path.exists(font):
        pytest.skip("needs a local ffmpeg with drawtext and a Korean font")
    monkeypatch.setenv("ACCOUNT_ID", "123")
    s = _session(ctx)
    sid = s["sessionId"]
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 2})
    job_id = _job(ctx)["jobId"]
    # the round, 12 s, in the channel's IVS recording (server/recording.py cuts it out)
    text = hls_fixture.encode(ffmpeg, tmp_path / "rec", seconds=16)
    rec = clock.t - 20
    hls_fixture.store(ctx.s3, ctx.assets_bucket, tmp_path / "rec", hls_fixture.redate(text, rec), rec, "r1")
    window = {"round": 1, "startedAt": int(rec * 1000), "endedAt": int((rec + 12) * 1000), "sentAt": int(clock.t * 1000)}
    with pytest.raises(live.LiveError) as off:  # generation is off until the toggle turns it on
        live.highlight_create(ctx, s, window)
    assert off.value.code == "highlights_off"
    assert live.highlight_settings(ctx, s, {"generate": True, "auto": "linear"}) == {"auto": "linear", "generate": True}
    made = live.highlight_create(ctx, s, window)
    hl = json.loads(ctx.s3._store[("live-b", f"broadcaster/highlights/{job_id}/{made['id']}.json")])
    assert made["jobId"] == job_id and hl["state"] == "analyzing"
    ctx.bedrock_rt_east = FakeBedrock([{"start_sec": 6, "end_sec": 8, "excitement": "high", "title": "역전승!"}])
    ctx.ffmpeg_bin, ctx.font_path = ffmpeg, font
    out = live.highlight_run(ctx, sid, job_id, made["id"])
    assert out["state"] == "ready", out.get("error")
    assert (out["start"], out["end"], out["title"]) == (5.0, 9.0, "역전승!")
    model, body = ctx.bedrock_rt_east.bodies[0]
    assert model == live.PEGASUS and body["analysis_mode"] == "time_based_metadata"
    base = hl["sourceKey"].rsplit("/", 1)[0]
    assert ctx.s3._store[(ctx.assets_bucket, f"{base}/short.mp4")] and ctx.s3._store[(ctx.assets_bucket, f"{base}/wide.mp4")]
    # automatic linear: not sent with a creative MediaTailor has never seen
    assert ctx.ivs.breaks() == [] and _job(ctx)["autoLinear"] == [made["id"]]
    with pytest.raises(live.LiveError) as warming:
        live.highlight_send(ctx, s, made["id"], {"kind": "linear"})
    assert warming.value.code == "warming"
    live.viewer(ctx, s)  # the trailer's warm-up first
    _after_break(ctx, clock)
    live.viewer(ctx, s)  # then the cut's
    assert ctx.ivs.breaks() == [1, 1] and _vast_url(ctx) == out["wideUrl"]
    live.status(ctx, s)
    assert ctx.ivs.breaks() == [1, 1]  # still transcoding
    clock.t += live.TRANSCODE_SEC + 30
    live.status(ctx, s)
    assert ctx.ivs.breaks() == [1, 1, 4] and _job(ctx)["autoLinear"] == []  # now the real break, once
    live.status(ctx, s)
    assert ctx.ivs.breaks() == [1, 1, 4]
    assert live.status(ctx, s)["highlights"][0]["id"] == made["id"]

    live.highlight_send(ctx, s, made["id"], {"kind": "overlay"})
    meta = [c for c in ctx.ivs.calls if c[0] == "meta"][-1][2]
    assert meta["type"] == "overlay" and meta["url"].endswith("/short.mp4") and meta["seconds"] == 4.0
    with pytest.raises(live.LiveError) as busy:  # the auto break still owns the VAST file
        live.highlight_send(ctx, s, made["id"], {"kind": "linear"})
    assert busy.value.code == "ad_busy"
    _after_break(ctx, clock)
    ev = live.highlight_send(ctx, s, made["id"], {"kind": "linear"})["eventId"]
    assert ctx.ivs.breaks()[-1] == 4 and ev.startswith("brk")
    assert [b["kind"] for b in live.status(ctx, s)["stream"]["breaks"]] == ["linear", "overlay", "linear"]
    with pytest.raises(live.LiveError):
        live.highlight_send(ctx, s, made["id"], {"kind": "banner"})
    live.highlight_delete(ctx, s, made["id"])
    assert live.status(ctx, s)["highlights"] == []
    with pytest.raises(live.LiveError):
        live.highlight_send(ctx, s, made["id"], {"kind": "overlay"})  # a deleted highlight is not sent
    live.highlight_delete(ctx, s, made["id"], restore=True)  # the toast's 되돌리기
    assert [h["id"] for h in live.status(ctx, s)["highlights"]] == [made["id"]]


def test_korean_title_rewrites_an_english_headline_and_keeps_a_korean_one():
    class Conv:
        def converse(self, **kw):
            return {"output": {"message": {"content": [{"text": "“마지막 거점 확보!”\n"}]}}}
    ctx = make_ctx(bedrock_rt_east=Conv())
    assert live.korean_title(ctx, "Final Objective Captured") == "마지막 거점 확보!"
    assert live.korean_title(ctx, "역전승!") == "역전승!"
    assert live.korean_title(make_ctx(bedrock_rt_east=object()), "Boss Down") == live.FALLBACK_TITLE  # model error: a Korean title, never cut-off English


def test_metadata_over_1kb_is_refused(ctx):
    _session(ctx)
    with pytest.raises(live.LiveError):
        live._meta(ctx, {"type": "overlay", "title": "가" * 400})


def test_a_break_claims_the_vast_before_writing_it(ctx, clock, monkeypatch):
    s = _session(ctx, trailer=35.63)
    _known_trailer(ctx, s, clock)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1})
    job = _job(ctx)
    ctx.s3._store[("live-b", live.VAST_KEY)] = b"<VAST>other break</VAST>"
    _edit_job(ctx, breakUntil=clock.t + 20, breakOwner="someone")  # another handler's break claimed it just now
    with pytest.raises(live.LiveError) as busy:
        live._break(ctx, job, "G", "https://cdn/hl.mp4", 5, "hl_1")  # this caller's snapshot still looked free
    assert busy.value.code == "ad_busy" and ctx.s3._store[("live-b", live.VAST_KEY)] == b"<VAST>other break</VAST>"
    assert ctx.ivs.breaks() == []
    clock.t += 21
    ctx.ivs.fail = "ConflictException"
    with pytest.raises(live.LiveError):
        live._break(ctx, _job(ctx), "G", "https://cdn/hl.mp4", 5, "hl_1")
    assert _job(ctx)["breakUntil"] == 0  # nothing went out: the claim is given back


def test_queued_linear_highlights_follow_the_auto_setting(ctx, clock):
    s = _session(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 9})
    job_id = _job(ctx)["jobId"]
    live.highlight_settings(ctx, s, {"generate": True, "auto": "linear"})
    hl = {"id": "hl_1", "round": 1, "state": "ready", "title": "역전!", "clipSeconds": 5.0, "wideUrl": "https://cdn/w.mp4",
          "shortUrl": "https://cdn/s.mp4", "createdAt": "x"}
    ctx.s3._store[("live-b", live._hl_key(job_id, "hl_1"))] = json.dumps(hl).encode()
    _edit_job(ctx, autoLinear=["hl_1"], warmedAt={"https://cdn/w.mp4": clock.t - 1000})
    live.highlight_settings(ctx, s, {"auto": "off"})
    assert _job(ctx)["autoLinear"] == []
    _edit_job(ctx, autoLinear=["hl_1"], highlightAuto="overlay")  # one that slipped in before the switch
    live.status(ctx, s)
    assert ctx.ivs.breaks() == [] and _job(ctx)["autoLinear"] == []  # dropped, not sent as linear


def test_a_replaced_job_is_left_to_its_new_owner(ctx):
    a = _session(ctx)
    # the owner's other session, saying takeover (another account's start is refused: test_round20_channel_owner.py)
    b = store.put_session(ctx, "user-1", "t", "sf-shooter")
    store.put_game(ctx, b["sessionId"], {"gameId": "gm_1", "title": "G", "genre": "sf-shooter", "specKey": "k", "previewUrl": "x"})
    live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1})
    a_job = _job(ctx)
    live.start(ctx, b, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable", "takeover": True})  # B takes the channel over
    assert live._update_job(ctx, a_job["jobId"], lambda j: j.update(stop=True)) is None
    live.stop(ctx, a)
    assert _job(ctx)["sessionId"] == b["sessionId"] and "stop" not in _job(ctx)
    assert ctx.gls.loc["TargetIdleCapacity"] == 1  # B's idle host stays


def test_reap_ends_a_dead_publish_and_an_orphan_stream(ctx, clock):
    s = _session(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable"})
    live.status(ctx, s)  # live: liveAt recorded
    live.beat(ctx, s)
    ctx.ivs.live = False  # the publish died, the window still beats
    clock.t += live.DEAD_PUBLISH_SEC + 1
    live.beat(ctx, s)
    assert live.reap(ctx) == {"reaped": True} and _job(ctx)["stop"] is True
    assert ctx.gls.loc["TargetIdleCapacity"] == 0
    ctx.ivs.live = True  # someone publishes with the key while nobody is on air
    live.reap(ctx)
    assert ctx.ivs.calls[-1] == ("stop", "arn:ivs:channel/ch1")


def test_the_control_room_switch_prewarms_and_takes_the_server_down(ctx, clock):
    s = _session(ctx)
    out = live.standby_status(ctx, s)
    assert (out["on"], out["state"], out["mode"]) == (False, "off", "auto") and out["hourlyUsd"] > 0
    out = live.standby_set(ctx, s, {"on": True})  # before any broadcast: a pre-warm
    assert out["on"] and out["state"] == "warming" and out["mode"] == "on" and ctx.gls.loc["TargetIdleCapacity"] == 1
    ctx.gls.loc["IdleCapacity"] = 1
    assert live.standby_status(ctx, s)["state"] == "ready"
    live.reap(ctx)  # nobody broadcasts, but the switch holds it
    assert ctx.gls.loc["TargetIdleCapacity"] == 1
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable"})
    live.stop(ctx, s)
    assert ctx.gls.loc["TargetIdleCapacity"] == 1  # a broadcast's stop leaves the switch's host
    clock.t += live.MANUAL_HOLD_SEC + 1  # forgotten: it goes away on its own
    live.reap(ctx)
    assert ctx.gls.loc["TargetIdleCapacity"] == 0
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable"})
    assert ctx.gls.loc["TargetIdleCapacity"] == 1 and _job(ctx)["standby"] is True
    out = live.standby_set(ctx, s, {"on": False})  # taken down during a playable broadcast
    assert not out["on"] and out["mode"] == "off" and _job(ctx)["standby"] is False
    live.reap(ctx)
    assert ctx.gls.loc["TargetIdleCapacity"] == 0  # stays down while that broadcast runs
    live.ad_settings(ctx, s, {"adType": "playable", "everyRounds": 2})
    assert ctx.gls.loc["TargetIdleCapacity"] == 0  # a spec change is not a new intent
    live.stop(ctx, s)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable"})  # a new playable broadcast is
    assert ctx.gls.loc["TargetIdleCapacity"] == 1 and live.standby_status(ctx, s)["mode"] == "auto"
    with pytest.raises(live.LiveError):
        live.standby_set(ctx, s, {"on": "yes"})


def test_a_round_before_any_viewer_gets_a_corner_and_the_trailer_is_warmed_once_a_viewer_plays(ctx, clock):
    """With no viewer MediaTailor is never asked for the trailer, so a break then would warm nothing: the round gets
    a corner, and the warm-up waits for a viewer."""
    s = _session(ctx, trailer=35.63)  # a trailer MediaTailor has never seen
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1})
    first = live.round_done(ctx, s, {"rounds": 1})  # no viewer yet: nothing is warmed, so no break
    assert (first["cued"], first["corner"], first["deferred"]) == (False, True, False)
    assert ctx.ivs.breaks() == [] and "pendingCue" not in _job(ctx)
    job = _job(ctx)
    assert job["warmedAt"] == {} and [w["url"] for w in job["warm"]] == [job["adUrl"]]  # its warm-up is still due
    clock.t += 10
    assert live.viewer(ctx, s) == {"warmed": True} and ctx.ivs.breaks() == [1]  # a viewer plays: it goes, mid-round
    _after_break(ctx, clock)
    clock.t += live.TRANSCODE_SEC
    assert live.round_done(ctx, s, {"rounds": 2})["cued"] is True and ctx.ivs.breaks() == [1, 36]


def test_a_cue_that_races_a_warm_up_takes_the_files_one_that_races_a_full_screen_ad_skips(ctx, clock):
    s = _session(ctx, trailer=35.63)
    _known_trailer(ctx, s, clock)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1})
    real = live._update_job
    racer = {}

    def racing(ctx_, job_id, change):  # another break claims the file right before this cue's claim
        if getattr(change, "__name__", "") == "claim" and not _job(ctx).get("breakOwner"):
            _edit_job(ctx, **racer, breakOwner="other", lastBreakAt=clock.t)
        return real(ctx_, job_id, change)
    live._update_job = racing
    try:
        racer.update(breakUntil=clock.t + 26, breakKind="warm", warmSent=[])
        r = live.round_done(ctx, s, {"rounds": 1})
        assert r["cued"] is True and ctx.ivs.breaks() == [36]  # a warm-up: taken over
        _after_break(ctx, clock)
        _edit_job(ctx, breakOwner=None)
        racer.update(breakUntil=clock.t + 40, breakKind="break", airUntil=clock.t + 40)
        clock.t += 1
        r = live.round_done(ctx, s, {"rounds": 2})
    finally:
        live._update_job = real
    assert r["cued"] is False and not r["deferred"] and ctx.ivs.breaks() == [36]  # an ad on air: none this round
    assert live.status(ctx, s)["stream"]["breaks"][-1]["reason"] == "overlap"


def test_status_never_hands_one_session_another_job(ctx):
    a = _session(ctx)
    b = store.put_session(ctx, "user-1", "t", "sf-shooter")  # (the owner's other session: see the test above)
    store.put_game(ctx, b["sessionId"], {"gameId": "gm_1", "title": "G", "genre": "sf-shooter", "specKey": "k", "previewUrl": "x"})
    live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1})
    real = live._tick

    def takeover(ctx_, job):
        live._tick = real  # once: B's own start polls status too
        live.start(ctx, b, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable", "takeover": True})  # B starts mid-poll
    live._tick = takeover
    try:
        out = live.status(ctx, a)
    finally:
        live._tick = real
    assert out["active"] is False and out["job"] is None
    assert ("stop", "arn:ivs:channel/ch1") in ctx.ivs.calls  # A's publisher was ended by the takeover


def test_reap_reasserts_the_idle_host_and_survives_ivs_errors(ctx):
    s = _session(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable"})
    ctx.gls.loc["TargetIdleCapacity"] = 0  # lost to a race or a failed call
    live.reap(ctx)
    assert ctx.gls.loc["TargetIdleCapacity"] == 1 and _job(ctx)["standby"] is True
    live.beat(ctx, s)
    _edit_job(ctx, beatAt=_job(ctx)["beatAt"] - live.BEAT_TIMEOUT_SEC - 5)

    def broken(**kw):
        raise RuntimeError("endpoint down")
    ctx.ivs.get_stream = broken
    live._stream_cache.clear()
    assert live.reap(ctx)["reaped"] is True  # a quiet window is reaped without asking IVS
    assert ctx.gls.loc["TargetIdleCapacity"] == 0


def test_switch_off_refuses_hidden_sessions_and_a_failed_on_leaves_nothing(ctx):
    s = _session(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable"})
    ad_id = _job(ctx)["playableAdId"]
    token = live.status(ctx, s)["job"]["standbyToken"]
    assert live.status(ctx, s)["job"]["standbyOff"] is False
    live.standby_set(ctx, s, {"on": False})
    assert live.status(ctx, s)["job"]["standbyOff"] is True  # the owner's watch window drops its hidden session
    with pytest.raises(playable.AdError):  # and no new one is granted while it is off
        playable.start(ctx, ad_id, {"signalRequest": "sdp", "standby": True, "standbyToken": token})
    live.stop(ctx, s)
    ctx.gls.fail = 1  # the group is busy: ON fails
    with pytest.raises(live.LiveError):
        live.standby_set(ctx, s, {"on": True})
    assert live.standby_status(ctx, s)["mode"] != "on"
    live.reap(ctx)
    assert ctx.gls.loc["TargetIdleCapacity"] == 0  # a failed ON never takes effect later


# ── the 45-minute cap is announced; a switch to trailer keeps the host warm a while ─────────

def test_status_tells_the_owner_how_long_the_broadcast_has_left(ctx):
    s = _session(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1})
    assert live.status(ctx, s)["job"]["secondsLeft"] == pytest.approx(live.MAX_MINUTES * 60, abs=2)
    _edit_job(ctx, startedAt=store.now(-(live.MAX_MINUTES - 4) * 60_000))  # 41 minutes on air
    assert live.status(ctx, s)["job"]["secondsLeft"] == pytest.approx(240, abs=2)
    other = store.put_session(ctx, "user-2", "t", "sf-shooter")
    assert live.status(ctx, other)["job"] is None  # nobody else's status carries it
    _edit_job(ctx, startedAt=store.now(-(live.MAX_MINUTES * 60 + 1) * 1000))
    assert live.status(ctx, s)["active"] is False  # the cap itself is unchanged: 45 minutes, then it stops


def _playable_then_trailer(ctx, s, **start):
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable", "playableSeconds": 30, **start})
    live.ad_settings(ctx, s, {"adType": "trailer", "everyRounds": 1})


def test_a_switch_to_trailer_keeps_the_idle_host_for_a_grace_period_so_a_switch_back_is_warm(ctx, clock):
    s = _session(ctx)
    _playable_then_trailer(ctx, s)
    assert ctx.gls.idle() == [1]  # not released: the host stays warm
    assert _job(ctx)["standby"] is True and _job(ctx)["standbyGraceUntil"] == clock.t + live.STANDBY_GRACE_SEC
    clock.t += live.STANDBY_GRACE_SEC - 10
    live.status(ctx, s)
    live.reap(ctx)
    assert ctx.gls.idle() == [1]  # still inside the grace period: neither the poll nor the reap drops it
    live.ad_settings(ctx, s, {"adType": "playable", "everyRounds": 1, "playableSeconds": 30})  # back to 플레이어블
    job = _job(ctx)
    assert ctx.gls.idle() == [1] and job["standby"] is True and "standbyGraceUntil" not in job
    # the watch window's hidden session is granted again at once, on the host that never went away
    token = live.status(ctx, s)["job"]["standbyToken"]
    assert playable.start(ctx, job["playableAdId"], {"signalRequest": "sdp", "standby": True, "standbyToken": token})["standby"]
    clock.t += live.STANDBY_GRACE_SEC + 60
    live.reap(ctx)
    assert ctx.gls.idle() == [1]  # a playable broadcast holds it with no deadline


def test_after_the_grace_period_the_host_goes_by_the_next_status_poll_or_reap(ctx, clock):
    s = _session(ctx)
    _playable_then_trailer(ctx, s)
    clock.t += live.STANDBY_GRACE_SEC + 1
    live.status(ctx, s)  # the control room's poll (every 4 s)
    assert ctx.gls.idle() == [1, 0] and _job(ctx)["standby"] is False
    live.status(ctx, s)
    assert ctx.gls.idle() == [1, 0]  # once
    live.ad_settings(ctx, s, {"adType": "playable", "everyRounds": 1, "playableSeconds": 30})
    assert ctx.gls.idle() == [1, 0, 1]  # a later switch back asks for it again (cold)

    s2 = _session(ctx)  # no control room open: the 5-minute reap releases it
    _playable_then_trailer(ctx, s2, takeover=True)  # the owner's other session says takeover
    ctx.gls.updates.clear()
    clock.t += live.STANDBY_GRACE_SEC + 1
    live.reap(ctx)
    assert ctx.gls.idle() == [0] and _job(ctx)["standby"] is False


def test_stop_or_the_switch_off_during_the_grace_period_release_the_host_at_once(ctx, clock):
    s = _session(ctx)
    _playable_then_trailer(ctx, s)
    live.stop(ctx, s)
    assert ctx.gls.idle() == [1, 0] and _job(ctx)["standby"] is False
    live.reap(ctx)
    assert ctx.gls.loc["TargetIdleCapacity"] == 0

    _playable_then_trailer(ctx, s)
    ctx.gls.updates.clear()
    live.standby_set(ctx, s, {"on": False})  # 플레이어블 서버 OFF
    assert ctx.gls.idle() == [0] and _job(ctx)["standby"] is False
    live.reap(ctx)
    live.status(ctx, s)
    assert ctx.gls.loc["TargetIdleCapacity"] == 0
