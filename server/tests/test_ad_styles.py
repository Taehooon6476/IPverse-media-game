"""The three per-viewer ad styles of a broadcast: the full-screen MediaTailor trailer (with the pre-cue), the playable
ad over GameLift Streams (each viewer its own game, the game-agnostic warm launcher, the capacity queue) and the corner
trailer the player draws. Fakes only. Named without "live" so `pytest -k 'not live'` runs it."""
import json
import re

import pytest

from server import ads, adserver, live, playable, store, streams, viewers
from server.tests.conftest import FakeLambda, FakeS3, FakeTable, make_ctx
from server.tests.test_ads import FakeIvs, FakeSecrets, api, call, clock, keys  # noqa: F401
from server.tests.test_viewer_ads import IDS, _beat, _job, _owner, _trailer, _warm_all

SHELL_ALLOWED = re.compile(r"^https://[^/]+/games/gm_[A-Za-z0-9_-]+/index\.html(\?[\w=&.%-]*)?$")  # workers/stream-shell


class FakeGls:
    """The web stream group (max 2 seats, as deployed) and its sessions."""

    def __init__(self):
        self.loc = {"LocationName": "us-west-2", "AlwaysOnCapacity": 0, "MaximumCapacity": 2, "TargetIdleCapacity": 0}
        self.sessions, self.status, self.ended = [], {}, []

    def get_stream_group(self, Identifier):
        return {"LocationStates": [dict(self.loc)], "DefaultApplication": {"Id": "a-1"}}

    def update_stream_group(self, Identifier, LocationConfigurations):
        self.loc.update(LocationConfigurations[0])

    def start_stream_session(self, **kw):
        self.sessions.append(kw)
        sid = f"s-{len(self.sessions)}"
        self.status[sid] = "ACTIVE"
        return {"Arn": f"arn:gls:stream/{sid}", "Status": "ACTIVATING"}

    def get_stream_session(self, Identifier, StreamSessionIdentifier):
        kw = self.sessions[int(StreamSessionIdentifier.split("-")[1]) - 1]
        return {"Status": self.status[StreamSessionIdentifier], "Description": kw["Description"], "SignalResponse": "answer"}

    def terminate_stream_session(self, Identifier, StreamSessionIdentifier):
        self.status[StreamSessionIdentifier] = "TERMINATED"
        self.ended.append(StreamSessionIdentifier)


@pytest.fixture
def ctx(monkeypatch, clock, keys):
    for k, v in {"LIVE_BUCKET": "live-b", "WEB_STREAM_GROUP_ID": "sg-web", "CDN_DOMAIN": "d1.cloudfront.net",
                 "SELF_FUNCTION_NAME": "api"}.items():
        monkeypatch.setenv(k, v)
    live._chan.clear()
    live._stream_cache.clear()
    ads._cache.clear()
    streams._app_cache.clear()
    playable._cache.clear()
    gls = FakeGls()
    monkeypatch.setattr(streams, "client", lambda: gls)
    monkeypatch.setattr(live.time, "sleep", lambda s: None)
    c = make_ctx(table=FakeTable(), s3=FakeS3(), ivs=FakeIvs(), cdn_domain="d1.cloudfront.net", lambda_=FakeLambda())
    c.secretsmanager = FakeSecrets(json.dumps({"d": format(keys[0], "x"), "keyPairArn": "arn:ivs:playback-key/k1"}))
    c.gls = gls
    yield c
    # the playback key this fixture's Secrets Manager gave stays in the container's cache: clear it for modules with
    # their own ctx and no key
    ads._cache.clear()


def _sid(ctx, title):
    return next(x["sessionId"] for x in store.list_sessions(ctx, "user-1") if x["title"] == title)


def _game(ctx, sid, gid, title, genre, published=True, engine="three", cast=()):
    store.put_game(ctx, sid, {"gameId": gid, "title": title, "genre": genre, "engine": engine, "specKey": "k",
                              "previewUrl": store.public_url(ctx, f"games/{gid}/index.html"),
                              **({"publishedUrl": store.public_url(ctx, f"games/{gid}/index.html"),
                                  "publishedAt": "2026-11-09T00:00:00.000Z"} if published else {}),
                              **({"castIpIds": list(cast)} if cast else {})})
    ctx.s3._store[(ctx.assets_bucket, f"games/{gid}/runtime3d.js")] = b"const standby = query.get('standby');"


def _games(ctx):
    """The owner's sessions with their trailers (test_viewer_ads._owner) and a published 3D game in four of them, plus
    games that are not playable ads: a draft, a 2D one, the broadcast's own (no engine recorded)."""
    main = _owner(ctx)
    _game(ctx, _sid(ctx, "보스"), "gm_boss", "강철 기사: 보스 레이드", "rpg-quest", cast=["ip_k"])
    _game(ctx, _sid(ctx, "레이스"), "gm_race", "드리프트 레이스: 자동차 추격", "sf-shooter")
    _game(ctx, _sid(ctx, "레이스"), "gm_draft", "드래프트 레이스", "sf-shooter", published=False)
    _game(ctx, _sid(ctx, "하늘섬"), "gm_sky", "구름섬 보물 수집", "rpg-explore")
    _game(ctx, _sid(ctx, "하늘섬"), "gm_2d", "2D 슈팅", "sf-shooter", engine="phaser")
    space = store.put_session(ctx, "user-1", "우주", "sf-shooter")
    _game(ctx, space["sessionId"], "gm_space", "스타 워든: 외계인 침공", "sf-shooter")
    return main


def _meta(ctx):
    return [c[1] for c in ctx.ivs.calls if c[0] == "meta"]


def _breaks_log(ctx, s):
    return live.status(ctx, s)["stream"]["breaks"]


# ── 2. the playable ad: inventory and per-viewer picks ────────────────────────

def test_the_playable_inventory_is_the_owners_published_3d_games_with_genre_tags_and_ips(ctx):
    _games(ctx)
    items = adserver.playable_inventory(ctx, "user-1")
    assert sorted(c["gameId"] for c in items) == ["gm_boss", "gm_race", "gm_sky", "gm_space"]  # no draft, 2D, unrecorded
    by = {c["gameId"]: c for c in items}
    assert {g: c["genre"] for g, c in by.items()} == {"gm_boss": "arpg", "gm_race": "racing", "gm_sky": "explore",
                                                      "gm_space": "shooter"}
    assert by["gm_boss"]["ips"] == ["강철 기사"] and "boss" in by["gm_boss"]["tags"]
    assert by["gm_race"]["creative"] == "pg_gm_race" and by["gm_race"]["url"].endswith("/games/gm_race/index.html")
    trailers, games = adserver.inventories(ctx, "user-1")
    assert games == items and all(not c["creative"].startswith("pg_") for c in trailers)


def _playable_start(ctx, clock, every=1):
    s = _games(ctx)
    _game(ctx, s["sessionId"], "gm_1", "좀비 생존 30", "sf-survival", published=False)
    store.put_game(ctx, s["sessionId"], {"gameId": "gm_1", "title": "좀비 생존 30", "genre": "sf-survival", "specKey": "k",
                                         "previewUrl": store.public_url(ctx, "games/gm_1/index.html")})
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": every, "adType": "playable", "playableSeconds": 60})
    return s


def test_each_viewer_gets_its_own_game_on_the_playable_card_with_korean_reasons(ctx, clock):
    s = _playable_start(ctx, clock)
    r = live.round_done(ctx, s, {"rounds": 1})
    assert r["cued"] is True and not ctx.ivs.breaks()  # no video break: the card is the ad
    [meta] = _meta(ctx)
    brk = _breaks_log(ctx, s)[-1]
    assert meta["type"] == "playable" and meta["e"] == brk["eventId"] and len(json.dumps(meta).encode()) <= 1024
    picks = brk["picks"]
    assert {v: picks[v]["gameId"] for v in IDS} == {"v-minji": "gm_boss", "v-junho": "gm_race", "v-seoyeon": "gm_sky",
                                                    "v-hyunwoo": "gm_space"}
    assert len({picks[v]["adId"] for v in IDS}) == 4 and picks[""]["adId"] == _job(ctx)["playableAdId"]
    assert "최근 7일 레이싱" in picks["v-junho"]["reason"] and picks["v-junho"]["seconds"] == 60
    assert "아직 안 해 본 게임" in picks["v-hyunwoo"]["reasons"] or picks["v-hyunwoo"]["reasons"]
    assert picks["racer"] == picks["v-junho"]  # an old persona window reads its viewer's
    ad = playable.get(ctx, picks["v-junho"]["adId"])  # one ad per game and length, made on first use
    assert ad["gameId"] == "gm_race" and ad["seconds"] == 60 and ad["ctaUrl"].endswith("/games/gm_race/index.html")
    live.round_done(ctx, s, {"rounds": 2})
    again = _breaks_log(ctx, s)[-1]["picks"]
    assert again["v-junho"]["adId"] == picks["v-junho"]["adId"]  # the same game's ad id: its plays add up


def test_no_published_game_means_everyone_gets_the_broadcasts_own(ctx, clock):
    s = _owner(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable"})
    live.round_done(ctx, s, {"rounds": 1})
    picks = _breaks_log(ctx, s)[-1]["picks"]
    assert {picks[v]["adId"] for v in ["", *IDS]} == {_job(ctx)["playableAdId"]}
    assert picks["v-minji"]["reason"] == "추천할 게임이 없어 이 방송의 게임"


# ── 2. the game-agnostic warm host: the launcher ──────────────────────────────

def _token(ctx, s):
    return live.status(ctx, s)["job"]["standbyToken"]


def _launcher(ctx, s, connected=True):
    """The watch page's hidden launcher; connected: its WebRTC client is on it (GameLift Streams CONNECTED)."""
    got = live.launcher_start(ctx, s, {"signalRequest": "offer", "standbyToken": _token(ctx, s)})
    ctx.gls.status[got["streamId"]] = "CONNECTED" if connected else "ACTIVATING"
    return got


def _launch_url(ctx, n=-1):
    return ctx.gls.sessions[n]["AdditionalEnvironmentVariables"]["IPVERSE_GAME_URL"]


def _fetch(tok):
    return call("GET", f"/api/ads/launch/{tok}", token=None)


def test_the_warm_host_opens_the_launcher_and_a_click_opens_that_viewers_game_once(api, clock):
    ctx = api
    s = _playable_start(ctx, clock)
    with pytest.raises(live.LiveError):  # only the owner's windows (its standby token)
        live.launcher_start(ctx, s, {"signalRequest": "offer", "standbyToken": "nope"})
    got = _launcher(ctx, s)
    kw = ctx.gls.sessions[-1]
    url = _launch_url(ctx)
    # the stream shell's own allow-list takes it: no new build of the GameLift application
    assert SHELL_ALLOWED.match(url) and url.startswith("https://d1.cloudfront.net/games/gm_launcher/index.html?t=")
    assert kw["Description"] == f"ipverse launcher {_job(ctx)['jobId']} {got['launchId']}"
    assert b"/api/ads/launch/" in ctx.s3._store[(ctx.assets_bucket, playable.LAUNCHER_KEY)]  # the page is uploaded
    tok = url.split("?t=")[1]
    assert _fetch(tok) == (200, {"state": "wait", "next": playable.IDLE_POLL_MS, "preload": None})
    live.round_done(ctx, s, {"rounds": 1})
    brk = _breaks_log(ctx, s)[-1]
    out = live.play(ctx, s, {"viewerId": "v-junho", "eventId": brk["eventId"], "launchId": got["launchId"]})
    assert out["mode"] == "launch" and out["adId"] == brk["picks"]["v-junho"]["adId"] and out["waitsForInput"] is True
    status, body = _fetch(tok)
    assert status == 200 and body["state"] == "go"
    assert body["url"] == "https://d1.cloudfront.net/games/gm_race/index.html?noads=1&playable=60&standby=1"
    assert SHELL_ALLOWED.match(body["url"])
    assert _fetch(tok)[0] == 410  # single use
    with pytest.raises(live.LiveError) as e:  # a launcher opens one game
        live.play(ctx, s, {"viewerId": "v-minji", "eventId": brk["eventId"], "launchId": got["launchId"]})
    assert e.value.status == 409
    assert playable.get(ctx, out["adId"])["plays"] == 1
    assert [e["type"] for e in viewers.log(ctx, "v-junho", clock.t)][-1] == "playable_play"


def test_a_tampered_token_or_instruction_and_an_expired_one_are_refused(api, clock):
    ctx = api
    s = _playable_start(ctx, clock)
    got = _launcher(ctx, s)
    tok = _launch_url(ctx).split("?t=")[1]
    lid, exp, mac = tok.split(".")
    assert _fetch(f"{lid}.{int(exp) + 999}.{mac}")[0] == 403  # a longer life is not signed
    assert _fetch(f"{lid}.{exp}.{'0' * 32}")[0] == 403
    live.round_done(ctx, s, {"rounds": 1})
    eid = _breaks_log(ctx, s)[-1]["eventId"]
    live.play(ctx, s, {"viewerId": "v-minji", "eventId": eid, "launchId": got["launchId"]})
    item = ctx.table.items[(f"LAUNCH#{lid}", "META")]
    real = item["go"]["url"]
    item["go"]["url"] = "https://d1.cloudfront.net/games/gm_other/index.html"  # someone edits the instruction
    assert _fetch(tok)[0] == 403
    item["go"]["url"] = real
    clock.t += playable.GO_TTL_SEC + 1  # nobody fetched it in time: void
    assert _fetch(tok)[0] == 410
    clock.t += playable.LAUNCH_TTL_SEC
    assert _fetch(tok)[0] == 410  # the token itself has expired


# ── 2. capacity: "대기 n번째" ─────────────────────────────────────────────────

def _fill(ctx, n=2):
    """n sessions of other windows hold the group's seats."""
    gls = streams.client()
    for i in range(n):
        streams.open_session(ctx, gls, "sg-web", "full {n}", Description=f"ipverse ad ad_other{i}", UserId="x")


def test_a_card_waits_in_line_when_every_seat_is_taken_and_starts_when_one_frees(ctx, clock):
    s = _playable_start(ctx, clock)
    live.round_done(ctx, s, {"rounds": 1})
    eid = _breaks_log(ctx, s)[-1]["eventId"]
    _fill(ctx)
    first = live.play(ctx, s, {"viewerId": "v-minji", "eventId": eid})
    second = live.play(ctx, s, {"viewerId": "v-junho", "eventId": eid})
    assert (first["mode"], first["position"], second["position"]) == ("queued", 1, 2)
    with pytest.raises(live.LiveError) as e:  # a hidden launcher never takes a seat while someone waits
        _launcher(ctx, s)
    assert e.value.status == 503
    with pytest.raises(playable.AdError) as e:  # nor does a start that jumps the line
        playable.start(ctx, second["adId"], {"signalRequest": "offer", "ticket": second["ticket"]})
    assert e.value.code == "stream_queued"
    clock.t += 3
    assert live.play(ctx, s, {"viewerId": "v-junho", "eventId": eid, "ticket": second["ticket"]})["position"] == 2
    streams.end(ctx, "sg-web", "s-1")  # a seat frees
    go = live.play(ctx, s, {"viewerId": "v-minji", "eventId": eid, "ticket": first["ticket"]})
    assert go["mode"] == "start" and go["adId"] == first["adId"]
    started = playable.start(ctx, go["adId"], {"signalRequest": "offer", "ticket": go["ticket"]})
    assert started["streamId"] and "gm_boss" in ctx.gls.sessions[-1]["AdditionalEnvironmentVariables"]["IPVERSE_GAME_URL"]
    assert live.play(ctx, s, {"viewerId": "v-junho", "eventId": eid, "ticket": second["ticket"]})["position"] == 1
    clock.t += playable.QUEUE_ALIVE_SEC + 1  # a card that stopped asking leaves the line
    assert playable._queue(ctx, "sg-web") == []


def test_the_first_in_line_takes_the_seat_of_a_hidden_launcher_nobody_plays(ctx, clock):
    s = _playable_start(ctx, clock)
    _launcher(ctx, s)
    _fill(ctx, 1)
    live.round_done(ctx, s, {"rounds": 1})
    eid = _breaks_log(ctx, s)[-1]["eventId"]
    waiting = live.play(ctx, s, {"viewerId": "v-seoyeon", "eventId": eid})
    assert waiting["mode"] == "queued" and ctx.gls.ended == ["s-1"]  # the idle launcher gave its seat up
    assert live.play(ctx, s, {"viewerId": "v-seoyeon", "eventId": eid, "ticket": waiting["ticket"]})["mode"] == "start"


def test_stopping_the_broadcast_ends_its_idle_launchers(ctx, clock):
    s = _playable_start(ctx, clock)
    _launcher(ctx, s)
    live.stop(ctx, s)
    assert ctx.gls.ended == ["s-1"]


# ── 1. the full-screen trailer: warm-ups and the pre-cue ──────────────────────

def _trailer_start(ctx, clock, every=2, **extra):
    s = _owner(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": every, **extra})
    _warm_all(ctx, s, clock)
    return s


def _after(ctx, clock, plus=1):
    clock.t = max(clock.t, _job(ctx).get("breakUntil", 0)) + plus


def test_defect_a_no_warm_up_runs_into_the_end_of_a_trailer_round(ctx, clock):
    """A warm-up sent just before a trailer round's end would hold the VAST files and delay the cue: none goes out
    then."""
    s = _trailer_start(ctx, clock)
    for n in (1, 2):
        clock.t += 30
        live.round_done(ctx, s, {"rounds": n})
    assert len(ctx.ivs.breaks()) and ctx.ivs.breaks()[-1] > 1  # break 1 on round 2
    assert _breaks_log(ctx, s)[-1]["picks"][""]["url"].endswith(".mp4")  # the console previews the trailer
    for vid in IDS:  # the beacons: each viewer saw its ad, the cap moves them on
        brk = _breaks_log(ctx, s)[-1]
        ads.impression(ctx, {"b": brk["breakId"], "p": vid, "c": brk["picks"][vid]["creative"]})
    # a new racing trailer made on air: the racer's next pick, which MediaTailor has not seen yet
    _trailer(ctx, _sid(ctx, "레이스"), "race2", "서킷 킹", "race cars speed on a track, drift, drift", 20.0,
             "2026-11-09T00:00:00.000Z")
    _after(ctx, clock)
    live.status(ctx, s)  # the break is over: the next picks, and warm-ups for them
    clock.t += 30
    live.round_done(ctx, s, {"rounds": 3})  # round 4 (a trailer round) starts
    assert _job(ctx)["warm"]
    clock.t += 14  # the tiles beat 16 s before round 4 ends
    assert _beat(ctx, s) == {"warmed": False}
    clock.t += 16
    r = live.round_done(ctx, s, {"rounds": 4})
    assert r["cued"] is True and not r["deferred"]  # at once
    assert _breaks_log(ctx, s)[-1]["endToAdSec"] == live.STREAM_LEAD_SEC
    clock.t += 5
    assert _beat(ctx, s)["warmed"] is False  # still the break's (not the warm-up's) files
    _after(ctx, clock)
    live.status(ctx, s)
    clock.t += 1
    assert _beat(ctx, s)["warmed"] is True  # round 5 is not a trailer round: warm-ups go again


def test_defect_a_a_trailer_cue_takes_the_files_from_a_warm_up_after_its_short_hold(ctx, clock):
    s = _trailer_start(ctx, clock, every=1)
    job = _job(ctx)
    job["warm"] = [{"url": "https://cdn/new.mp4", "title": "new", "seconds": 20, "adId": "x"}]
    ctx.s3._store[("live-b", live.JOB_KEY)] = json.dumps(job).encode()
    assert _beat(ctx, s)["warmed"] is True  # nothing is known of round 1's end yet: allowed
    hold = _job(ctx)["breakUntil"] - clock.t
    clock.t += live.WARM_HOLD_SEC + 0.5
    assert clock.t < _job(ctx)["breakUntil"] and hold == live.AD_LEAD_SEC + live.BREAK_MARGIN_SEC
    assert live.round_done(ctx, s, {"rounds": 1})["cued"] is True  # not 10 s more for the margin
    assert "https://cdn/new.mp4" in _job(ctx)["warmedAt"]  # its ad requests had come: it stays warmed


def test_a_cue_never_waits_for_a_warm_up_it_takes_the_files_and_the_warm_up_goes_again(ctx, clock):
    """A cue takes the VAST files from a pending warm-up at once; that warm-up's creatives are not warm after all and
    go back to the queue's front, out of the registry."""
    s = _trailer_start(ctx, clock, every=1)
    job = _job(ctx)
    job["warm"] = [{"url": "https://cdn/new.mp4", "title": "new", "seconds": 20, "adId": "x"}]
    ctx.s3._store[("live-b", live.JOB_KEY)] = json.dumps(job).encode()
    assert _beat(ctx, s)["warmed"] is True
    clock.t += 3
    r = live.round_done(ctx, s, {"rounds": 1})
    assert r["cued"] is True and not r["deferred"] and ctx.ivs.breaks()[-1] > 1  # at once
    job = _job(ctx)
    assert "https://cdn/new.mp4" not in job["warmedAt"] and job["warm"][0]["url"] == "https://cdn/new.mp4"
    assert "https://cdn/new.mp4" not in json.loads(ctx.s3._store[("live-b", live.WARM_REGISTRY)])
    assert _breaks_log(ctx, s)[-1]["endToAdSec"] == live.STREAM_LEAD_SEC


def test_pre_cue_sends_the_break_lead_seconds_before_a_known_round_end(ctx, clock):
    """The fake clock's numbers: without the pre-cue the stitched ad starts STREAM_LEAD_SEC (4.5 s) after the round's end
    on each viewer's own picture; with it 2.5 s after (STREAM_LEAD_SEC less the lead)."""
    s = _trailer_start(ctx, clock, every=1)
    warmups = len(ctx.ivs.breaks())
    lead = live.PRECUE_LEAD_SEC
    end = clock.t + 40  # a 40 s survive stage started
    early = live.round_eta(ctx, s, {"round": 1, "endsInMs": 40_000, "sentAt": 0})
    assert early == {"preCued": False, "reason": "early", "sendInMs": round((40 - lead - live.PRECUE_PREP_SEC) * 1000)}
    assert len(ctx.ivs.breaks()) == warmups
    clock.t = end - lead
    assert live.round_eta(ctx, s, {"round": 1, "endsInMs": lead * 1000, "sentAt": 0})["preCued"] is True
    assert len(ctx.ivs.breaks()) == warmups + 1
    brk = _breaks_log(ctx, s)[-1]
    assert brk["preCue"] is True and brk["leadSec"] == lead and brk["endToAdSec"] == live.STREAM_LEAD_SEC - lead == 2.5
    assert live.round_eta(ctx, s, {"round": 1, "endsInMs": 2_000, "sentAt": 0})["reason"] == "done"  # once
    clock.t = end + 0.4  # the round report comes
    r = live.round_done(ctx, s, {"rounds": 1})
    assert r["preCued"] is True and not r["cued"] and len(ctx.ivs.breaks()) == warmups + 1  # no second break
    assert _breaks_log(ctx, s)[-1]["endToAdSec"] == 2.1  # against the real end
    # the next round has no known end (a clear or a death): the cue stays at the round end
    _after(ctx, clock)
    live.status(ctx, s)
    clock.t += 30
    live.round_done(ctx, s, {"rounds": 2})
    brk = _breaks_log(ctx, s)[-1]
    assert brk["round"] == 2 and not brk.get("preCue") and brk["endToAdSec"] == live.STREAM_LEAD_SEC


def test_pre_cue_lead_is_configurable_and_off_for_other_rounds_and_styles(ctx, clock):
    s = _trailer_start(ctx, clock, every=2, preCueLeadSec=8)
    assert _job(ctx)["preCueLeadSec"] == 8
    assert live.round_eta(ctx, s, {"round": 1, "endsInMs": 8_000, "sentAt": 0})["reason"] == "no_trailer_round"
    clock.t += 8
    live.round_done(ctx, s, {"rounds": 1})
    assert live.round_eta(ctx, s, {"round": 2, "endsInMs": 15_000, "sentAt": 0})["reason"] == "early"  # 8 s lead + the time the picks take
    assert live.round_eta(ctx, s, {"round": 2, "endsInMs": 8_000, "sentAt": 0})["preCued"] is True
    assert _breaks_log(ctx, s)[-1]["leadSec"] == 8
    with pytest.raises(live.LiveError):
        live.start(ctx, s, {"gameId": "gm_1", "preCueLeadSec": 30})
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "preCueLeadSec": 0})  # 0 = off
    assert live.round_eta(ctx, s, {"round": 1, "endsInMs": 1_000, "sentAt": 0})["preCued"] is False


# ── 3. the corner trailer ─────────────────────────────────────────────────────

def test_the_corner_trailer_is_timed_metadata_with_each_viewers_own_trailer(ctx, clock):
    s = _owner(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "corner"})
    r = live.round_done(ctx, s, {"rounds": 1})
    assert r["cued"] is True and ctx.ivs.breaks() == []  # no ad break, no MediaTailor: at the round end exactly
    [meta] = _meta(ctx)
    brk = _breaks_log(ctx, s)[-1]
    # wait: how long a tile showing a full-screen ad may hold it (the round length is not known yet: the default)
    assert meta == {"type": "corner", "e": brk["eventId"], "round": 1, "seconds": live.CORNER_SEC,
                    "wait": live.CORNER_WAIT_SEC}
    assert brk["kind"] == "corner" and 10 <= brk["seconds"] <= 15
    picks = brk["picks"]
    assert len({picks[v]["creative"] for v in IDS}) == 4 and all(picks[v]["url"].endswith(".mp4") for v in IDS)
    assert picks["v-junho"]["title"] == "네온 드리프트" and picks["v-junho"]["reason"]
    assert picks[""]["gameUrl"].endswith("/games/gm_1/index.html")


def test_corner_impressions_join_the_log_and_the_frequency_cap_moves_the_next_corner_on(ctx, clock):
    s = _owner(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "corner"})
    live.round_done(ctx, s, {"rounds": 1})
    brk = _breaks_log(ctx, s)[-1]
    first = brk["picks"]["v-junho"]["creative"]
    body = {"viewerId": "v-junho", "eventId": brk["eventId"], "kind": "corner", "action": "impression"}
    assert live.ad_event(ctx, s, body) == {"recorded": True}
    assert live.ad_event(ctx, s, body) == {"recorded": False}  # once per break (two tabs, a re-render)
    last = viewers.log(ctx, "v-junho", clock.t)[-1]
    assert last["type"] == "corner_impression" and last["creative"] == first and last["genre"] == "racing"
    assert viewers.text(last) == "코너 광고 노출 · 네온 드리프트 (레이싱)"
    clock.t += 30
    live.round_done(ctx, s, {"rounds": 2})
    assert _breaks_log(ctx, s)[-1]["picks"]["v-junho"]["creative"] != first  # within the cap: another one


def test_corner_every_round_and_full_screen_every_n(ctx, clock):
    s = _trailer_start(ctx, clock, every=2, corner=True)
    clock.t += 30
    assert live.round_done(ctx, s, {"rounds": 1})["corner"] is True and ctx.ivs.breaks()[-1] == 1  # warm-ups only
    clock.t += 30
    r = live.round_done(ctx, s, {"rounds": 2})
    assert r["cued"] is True and r["corner"] is False  # the full-screen round: no corner on top
    assert [b["kind"] for b in _breaks_log(ctx, s)] == ["corner", "trailer"]


def test_no_cascade_a_cue_while_the_last_ad_is_on_air_skips_its_round_and_the_schedule_stays(ctx, clock):
    """IVS cannot end or shorten a running break, so a cue that would overlap the ad on air is skipped: no wait, and
    the next N-th round cues on time."""
    s = _trailer_start(ctx, clock, every=2)
    t = clock.t
    for n, at in ((1, 30), (2, 60)):
        clock.t = t + at
        live.round_done(ctx, s, {"rounds": n})
    brk = _breaks_log(ctx, s)[-1]
    on_air = clock.t + live.STREAM_LEAD_SEC + brk["seconds"]
    assert _job(ctx)["airUntil"] == pytest.approx(on_air, abs=1)
    breaks = len(ctx.ivs.breaks())
    for n, at in ((3, 70), (4, 80)):  # two short rounds: round 4's ad would land while round 2's is on air
        clock.t = t + at
        r = live.round_done(ctx, s, {"rounds": n})
    assert r["cued"] is False and not r["deferred"] and len(ctx.ivs.breaks()) == breaks
    skip = _breaks_log(ctx, s)[-1]
    assert skip["kind"] == "skip" and skip["of"] == "trailer" and skip["reason"] == "overlap" and skip["round"] == 4
    assert "pendingCue" not in _job(ctx)
    for n, at in ((5, 110), (6, 140)):
        clock.t = t + at
        live.status(ctx, s)
        r = live.round_done(ctx, s, {"rounds": n})
    assert r["cued"] is True and _breaks_log(ctx, s)[-1]["endToAdSec"] == live.STREAM_LEAD_SEC  # on time


def test_a_break_fits_the_room_before_the_next_rounds_ad(ctx, clock):
    """With 30 s rounds and a corner between, a break cued at a round report must end CORNER_GAP_SEC before the next
    round's corner (at most 30 - 4.5 - 2 = 23.5 s): each viewer gets its best warmed trailer that fits."""
    s = _trailer_start(ctx, clock, every=2, corner=True)
    t = clock.t
    for n, at in ((1, 30), (2, 60)):
        clock.t = t + at
        live.round_done(ctx, s, {"rounds": n})
    brk = _breaks_log(ctx, s)[-1]
    assert brk["kind"] == "trailer" and brk["roomSec"] == pytest.approx(30 - live.STREAM_LEAD_SEC - live.CORNER_GAP_SEC)
    assert brk["seconds"] <= brk["roomSec"] and ctx.ivs.breaks()[-1] <= 22
    assert all(brk["picks"][v]["seconds"] <= 22 for v in IDS)
    clock.t = t + 90
    live.status(ctx, s)
    assert live.round_done(ctx, s, {"rounds": 3})["corner"] is True
    # a tile may hold it behind a late ad until it would run into round 4's (pre-cued: 2.5 s after that round's end)
    corner = _meta(ctx)[-1]
    next_ad = 30 + live.STREAM_LEAD_SEC - live.PRECUE_LEAD_SEC
    assert corner["wait"] == int(next_ad - live.CORNER_GAP_SEC - live.CORNER_SEC) == 18


# ── activity-log events from the watch page's beacon ──────────────────────────

def test_playable_card_events_and_play_time_join_the_viewers_log(ctx, clock):
    s = _playable_start(ctx, clock)
    live.round_done(ctx, s, {"rounds": 1})
    eid = _breaks_log(ctx, s)[-1]["eventId"]

    def ev(action, **kw):
        return live.ad_event(ctx, s, {"viewerId": "v-seoyeon", "eventId": eid, "kind": "playable", "action": action, **kw})
    assert ev("impression") == {"recorded": True}
    clock.t += 50
    assert ev("end", seconds=47) == {"recorded": True}
    log = viewers.log(ctx, "v-seoyeon", clock.t)
    assert [e["type"] for e in log[-2:]] == ["playable_impression", "playable"]
    assert log[-1]["seconds"] == 47 and log[-1]["gameId"] == "gm_sky"
    assert viewers.text(log[-1]) == "플레이어블 광고 47초 · 구름섬 보물 수집"
    assert live.ad_event(ctx, s, {"viewerId": "", "eventId": eid, "kind": "playable", "action": "impression"}) == {
        "recorded": False}  # 기본 has no log
    with pytest.raises(live.LiveError) as e:
        live.ad_event(ctx, s, {"viewerId": "v-seoyeon", "eventId": "nope", "kind": "playable", "action": "impression"})
    assert e.value.status == 404
    with pytest.raises(live.LiveError):
        live.ad_event(ctx, s, {"viewerId": "v-seoyeon", "eventId": eid, "kind": "corner", "action": "play"})
    # the offered game is capped for the next card
    live.round_done(ctx, s, {"rounds": 2})
    assert _breaks_log(ctx, s)[-1]["picks"]["v-seoyeon"]["gameId"] != "gm_sky"


def test_the_routes(api, clock):
    ctx = api
    s = _playable_start(ctx, clock)
    sid = s["sessionId"]
    status, got = call("POST", f"/api/sessions/{sid}/live/launcher", {"signalRequest": "o", "standbyToken": _token(ctx, s)})
    assert status == 202 and got["launchId"]
    status, polled = call("GET", f"/api/sessions/{sid}/live/launcher/{got['launchId']}")
    assert status == 200 and polled["status"] == "ACTIVE" and polled["signalResponse"] == "answer"
    ctx.gls.status[got["streamId"]] = "CONNECTED"  # the page's client is on it (the first card waits for that)
    live.round_done(ctx, s, {"rounds": 1})
    eid = _breaks_log(ctx, s)[-1]["eventId"]
    status, out = call("POST", f"/api/sessions/{sid}/live/play", {"viewerId": "v-minji", "eventId": eid,
                                                                  "launchId": got["launchId"]})
    assert status == 200 and out["mode"] == "launch"
    status, _ = call("POST", f"/api/sessions/{sid}/live/ad-event", {"viewerId": "v-minji", "eventId": eid,
                                                                    "kind": "playable", "action": "end", "seconds": 30})
    assert status == 200
    assert call("DELETE", f"/api/sessions/{sid}/live/launcher/{got['launchId']}")[0] == 200
    assert call("POST", f"/api/sessions/{sid}/live/round-eta", {"round": 2, "endsInMs": 1000})[0] == 200
    assert call("GET", "/api/ads/launch/not.a.token", token=None)[0] == 403
