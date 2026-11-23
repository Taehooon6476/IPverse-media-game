"""One channel, one broadcast job, one playable-server switch and one set of viewer logs serve every account, and
sign-up is open. The channel belongs to the owner on air while its play window beats: another account's start is
refused, the same owner's other session must say takeover, and the playback token, the switch and the viewers'
activity lines are the owner's alone. Fakes only. Named without "live" so `pytest -k 'not live'` runs it."""
import json

import pytest

from server import ads, app, auth, live, playable, store, viewers
from server.tests.conftest import FakeCognito
from server.tests.test_ad_styles import _breaks_log, _game, ctx  # noqa: F401 — IVS, GameLift Streams, the playback key
from server.tests.test_ads import clock, keys  # noqa: F401
from server.tests.test_viewer_ads import IDS, _job, _owner, _trailer, _warm_all

A_TOKEN, B_TOKEN = "token-a", "token-b"
BUSY = "다른 사용자가 방송 중이에요. 끝난 뒤(최대 45분) 다시 시도해 주세요."


@pytest.fixture
def api(ctx, monkeypatch):  # noqa: F811
    ctx.cognito = FakeCognito({A_TOKEN: ("user-1", "demo"), B_TOKEN: ("user-2", "second")})
    monkeypatch.setattr(app, "CTX", ctx)
    monkeypatch.setattr(auth, "_CACHE", {})
    return ctx


def call(method, path, body=None, token=A_TOKEN):
    event = {"requestContext": {"http": {"method": method}}, "rawPath": path,
             "headers": {"x-auth-token": token} if token else {}, "isBase64Encoded": False,
             "body": None if body is None else json.dumps(body)}
    resp = app.handler(event, None)
    return resp["statusCode"], json.loads(resp["body"])


def _studio(ctx, sub, game_id, title):  # noqa: F811
    """A session of this account with a game and a trailer of its own."""
    s = store.put_session(ctx, sub, title, "sf-shooter")
    sid = s["sessionId"]
    store.put_game(ctx, sid, {"gameId": game_id, "title": title, "genre": "sf-shooter", "specKey": "k",
                              "previewUrl": store.public_url(ctx, f"games/{game_id}/index.html")})
    ctx.s3._store[(ctx.assets_bucket, f"games/{game_id}/runtime3d.js")] = b"const standby = query.get('standby');"
    _trailer(ctx, sid, f"t_{game_id}", f"{title} 트레일러", "space scout with a laser gun", 15.0, "2026-11-09T00:00:00.000Z")
    return s


def _stops(ctx):  # noqa: F811
    return [c for c in ctx.ivs.calls if c[0] == "stop"]


def _quiet(ctx, clock):  # noqa: F811
    """Makes the broadcast's last beat older than the reap allows: its play window went away."""
    job = _job(ctx)
    job["beatAt"] = clock.t - live.BEAT_TIMEOUT_SEC - 5
    ctx.s3._store[("live-b", "broadcaster/job.json")] = json.dumps(job).encode()


# ── 라이브 켜기 ──────────────────────────────────────────────────────────────────

def test_another_accounts_start_is_refused_while_a_broadcast_is_on_air(ctx, clock):  # noqa: F811
    a, b = _owner(ctx), _studio(ctx, "user-2", "gm_b", "두 번째 계정의 게임")
    live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1})
    on_air = _job(ctx)

    with pytest.raises(live.LiveError) as refused:
        live.start(ctx, b, {"gameId": "gm_b", "everyRounds": 1})
    assert (refused.value.status, refused.value.code, refused.value.message) == (409, "live_busy", BUSY)

    assert _job(ctx) == on_air and _stops(ctx) == []  # nothing of A's broadcast was touched
    assert live.status(ctx, a)["active"] is True and live.status(ctx, b)["active"] is False
    with pytest.raises(live.LiveError):  # and saying takeover does not open another account's channel
        live.start(ctx, b, {"gameId": "gm_b", "everyRounds": 1, "takeover": True})
    live.beat(ctx, a)
    clock.t += live.BEAT_TIMEOUT_SEC - 5  # still beating a moment ago
    with pytest.raises(live.LiveError):
        live.start(ctx, b, {"gameId": "gm_b", "everyRounds": 1})
    assert _job(ctx)["jobId"] == on_air["jobId"]


def test_a_refused_start_leaves_the_owners_playable_server_and_ads_alone(ctx, clock):  # noqa: F811
    a, b = _owner(ctx), _studio(ctx, "user-2", "gm_b", "두 번째 계정의 게임")
    live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable"})
    assert ctx.gls.loc["TargetIdleCapacity"] == 1
    before = dict(ctx.table.items)
    for style in ("trailer", "playable"):
        with pytest.raises(live.LiveError):
            live.start(ctx, b, {"gameId": "gm_b", "everyRounds": 1, "adType": style})
    assert ctx.gls.loc["TargetIdleCapacity"] == 1 and _job(ctx)["standby"] is True  # A's idle host stays
    assert dict(ctx.table.items) == before  # no ad record, nothing written for the refused start


def test_once_the_broadcast_is_over_or_its_window_is_gone_another_account_may_start(ctx, clock):  # noqa: F811
    a, b = _owner(ctx), _studio(ctx, "user-2", "gm_b", "두 번째 계정의 게임")
    live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1})
    live.beat(ctx, a)
    _quiet(ctx, clock)  # A closed the tab: nothing beats (the reap has not come yet)
    out = live.start(ctx, b, {"gameId": "gm_b", "everyRounds": 1})
    assert out["active"] is True and _job(ctx)["sessionId"] == b["sessionId"] and _job(ctx)["ownerSub"] == "user-2"
    assert _stops(ctx)  # the dead publish is ended
    assert a["sessionId"] not in json.dumps(out)  # B's pages learn nothing of A's session, not even its id
    assert "endedBy" not in live.status(ctx, a)  # (a takeover is the same account's own doing)
    live.stop(ctx, b)
    assert live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1})["active"] is True  # a stopped one is free at once


def test_the_same_owners_other_session_must_say_takeover(ctx, clock):  # noqa: F811
    a, other = _owner(ctx), _studio(ctx, "user-1", "gm_2", "같은 계정의 다른 게임")
    live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1})
    first = _job(ctx)

    with pytest.raises(live.LiveError) as asked:
        live.start(ctx, other, {"gameId": "gm_2", "everyRounds": 1})
    assert (asked.value.status, asked.value.code) == (409, "live_other_session")
    assert "다른 세션" in asked.value.message and _job(ctx) == first and _stops(ctx) == []
    with pytest.raises(live.LiveError):  # only the flag itself
        live.start(ctx, other, {"gameId": "gm_2", "everyRounds": 1, "takeover": "yes"})

    out = live.start(ctx, other, {"gameId": "gm_2", "everyRounds": 1, "takeover": True})
    assert out["active"] is True and _job(ctx)["sessionId"] == other["sessionId"] and _stops(ctx)
    # the window that was cut off is told why (not only that the broadcast is over)
    cut = live.status(ctx, a)
    assert cut["active"] is False and cut["endedBy"] == "takeover"
    assert "endedBy" not in live.status(ctx, other)


def test_the_same_session_starts_again_without_being_asked(ctx, clock):  # noqa: F811
    a = _owner(ctx)
    live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1})
    first = _job(ctx)["jobId"]
    out = live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 2})
    assert out["active"] is True and _job(ctx)["jobId"] != first and "endedBy" not in out


def test_the_refusal_reaches_the_page_as_a_409_with_its_sentence(api, clock):
    a, b = _owner(api), _studio(api, "user-2", "gm_b", "두 번째 계정의 게임")
    assert call("POST", f"/api/sessions/{a['sessionId']}/live", {"gameId": "gm_1", "everyRounds": 1})[0] == 200
    status, body = call("POST", f"/api/sessions/{b['sessionId']}/live", {"gameId": "gm_b", "everyRounds": 1}, token=B_TOKEN)
    assert (status, body) == (409, {"error": "live_busy", "message": BUSY})


# ── the stream key, the ingest endpoint and the playback token ───────────────────

def test_only_the_session_on_air_gets_the_stream_key_the_ingest_endpoint_and_a_playback_token(api, clock, monkeypatch):
    monkeypatch.setenv("LIVE_IVS_KEY", "sk_us-east-1_SECRETKEY")
    monkeypatch.setenv("LIVE_IVS_INGEST", "abc123.global-contribute.live-video.net")
    a, mine_too, b = _owner(api), _studio(api, "user-1", "gm_2", "같은 계정의 다른 게임"), _studio(api, "user-2", "gm_b", "남")
    status, started = call("POST", f"/api/sessions/{a['sessionId']}/live", {"gameId": "gm_1", "everyRounds": 1})
    assert status == 200 and started["ingest"] == {"endpoint": "abc123.global-contribute.live-video.net",
                                                   "streamKey": "sk_us-east-1_SECRETKEY"}
    assert "token=" in started["playbackUrl"]

    for sid, token in ((b["sessionId"], B_TOKEN), (mine_too["sessionId"], A_TOKEN)):
        status, seen = call("GET", f"/api/sessions/{sid}/live", token=token)
        text = json.dumps(seen)
        assert status == 200 and seen["active"] is False and seen["ingest"] is None and seen["job"] is None
        assert "SECRETKEY" not in text and "global-contribute" not in text
        assert seen["playbackUrl"] == "" and "token=" not in text  # no signed URL of the private channel
    # another account cannot read A's session at all
    assert call("GET", f"/api/sessions/{a['sessionId']}/live", token=B_TOKEN)[0] == 404
    # and once A's broadcast is off, its own status carries neither
    call("DELETE", f"/api/sessions/{a['sessionId']}/live")
    off = call("GET", f"/api/sessions/{a['sessionId']}/live")[1]
    assert off["ingest"] is None and off["playbackUrl"] == ""


def test_a_viewer_token_is_signed_only_for_the_owner_on_air(api, clock, keys):
    a = _owner(api)
    for token in (A_TOKEN, B_TOKEN):  # nobody is on air: no address of the private channel for anyone
        status, body = call("POST", "/api/live/token", {"persona": "v-junho"}, token=token)
        assert (status, body["error"]) == (409, "not_live") and "playbackUrl" not in body
    call("POST", f"/api/sessions/{a['sessionId']}/live", {"gameId": "gm_1", "everyRounds": 1})
    status, body = call("POST", "/api/live/token", {"persona": "v-junho"})
    assert status == 200 and "token=" in body["playbackUrl"]
    status, body = call("POST", "/api/live/token", {"persona": "v-junho"}, token=B_TOKEN)
    assert (status, body["error"]) == (409, "not_live") and "token=" not in json.dumps(body)
    assert call("POST", "/api/live/token", {"persona": ""}, token=B_TOKEN)[0] == 409  # the default viewer's too
    call("DELETE", f"/api/sessions/{a['sessionId']}/live")
    assert call("POST", "/api/live/token", {"persona": "v-junho"})[0] == 409


def test_a_token_refused_before_the_broadcast_says_when_to_ask_again(api, clock, keys, monkeypatch):
    """A watch page opened before the broadcast is refused its tokens; the refusal says when to ask again (3 s, 1 s
    while this account's own start is under way) so the tiles attach soon after air. No channel address is in it."""
    a = _owner(api)
    refused = {"error": "not_live", "message": live.NO_TOKEN_TEXT}
    for token in (A_TOKEN, B_TOKEN):
        assert call("POST", "/api/live/token", {"persona": "v-junho"}, token=token) == (409, {**refused, "retryAfterSec": 3})
    seen = {}

    def ask():  # A's start has the channel and is reading its inventory
        seen["mine"] = call("POST", "/api/live/token", {"persona": "v-junho"})
        seen["other"] = call("POST", "/api/live/token", {"persona": "v-junho"}, token=B_TOKEN)
    during, ran = live._plan_ads, []

    def slow(*args, **kwargs):
        if not ran:
            ran.append(True)
            ask()
        return during(*args, **kwargs)
    monkeypatch.setattr(live, "_plan_ads", slow)
    assert call("POST", f"/api/sessions/{a['sessionId']}/live", {"gameId": "gm_1", "everyRounds": 1})[0] == 200

    assert seen["mine"] == (409, {**refused, "retryAfterSec": 1})
    assert seen["other"] == (409, {**refused, "retryAfterSec": 3})  # another account learns nothing of the start
    status, body = call("POST", "/api/live/token", {"persona": "v-junho"})
    assert status == 200 and "token=" in body["playbackUrl"] and "retryAfterSec" not in body
    status, body = call("POST", "/api/live/token", {"persona": "v-junho"}, token=B_TOKEN)
    assert (status, body) == (409, {**refused, "retryAfterSec": 3})
    call("DELETE", f"/api/sessions/{a['sessionId']}/live")
    assert call("POST", "/api/live/token", {"persona": "v-junho"}) == (409, {**refused, "retryAfterSec": 3})
    # and no other refusal grew a field: the hint is this answer's alone
    assert call("GET", "/api/sessions/ses_none/live")[1].keys() == {"error", "message"}


# ── the viewers' activity ────────────────────────────────────────────────────────

def _lines(token):
    status, body = call("GET", "/api/live/viewers", token=token)
    assert status == 200 and [v["viewerId"] for v in body["viewers"]] == IDS
    return {v["viewerId"]: [r["text"] for r in v["recent"]] for v in body["viewers"]}, body["viewers"]


def test_one_accounts_titles_never_reach_another_accounts_viewer_lines(api, clock):
    """A's broadcast leaves ad impressions, a corner tap, a playable play and watch time in the four viewers' logs,
    each naming A's games and trailers: /api/live/viewers shows them to A alone."""
    seeded, _ = _lines(B_TOKEN)  # before any broadcast: the seeded history, the same for everyone
    assert all(len(lines) == 5 for lines in seeded.values()) and _lines(A_TOKEN)[0] == seeded
    a = _owner(api)
    _game(api, a["sessionId"], "gm_pub", "A의 비밀 게임", "sf-survival")  # published: a playable pick
    live.start(api, a, {"gameId": "gm_1", "everyRounds": 1})
    _warm_all(api, a, clock)
    for _ in range(6):  # the tiles' heartbeat: over a minute of watch time
        clock.t += 15
        live.viewer(api, a, {"viewers": IDS})
    clock.t = max(clock.t, _job(api).get("breakUntil", 0)) + 1
    assert live.round_done(api, a, {"rounds": 1})["cued"] is True
    brk = _breaks_log(api, a)[-1]
    for vid in IDS:  # MediaTailor's beacon: each viewer saw A's trailer
        ads.impression(api, {"b": brk["breakId"], "p": vid, "c": brk["picks"][vid]["creative"]})
    clock.t = _job(api)["breakUntil"] + 1
    live.ad_settings(api, a, {"adType": "corner", "everyRounds": 1})
    live.round_done(api, a, {"rounds": 2})
    corner = _breaks_log(api, a)[-1]
    live.ad_event(api, a, {"viewerId": "v-minji", "eventId": corner["eventId"], "kind": "corner", "action": "impression"})
    live.ad_settings(api, a, {"adType": "playable", "everyRounds": 1, "playableSeconds": 60})
    live.round_done(api, a, {"rounds": 3})
    card = _breaks_log(api, a)[-1]
    live.ad_event(api, a, {"viewerId": "v-junho", "eventId": card["eventId"], "kind": "playable", "action": "impression"})
    live.ad_event(api, a, {"viewerId": "v-junho", "eventId": card["eventId"], "kind": "playable", "action": "end", "seconds": 40})
    live.stop(api, a)
    # A's game and trailer titles (but "네온 드리프트": the seeded history has a "네온 드리프트 X" of its own)
    titles = {"A의 비밀 게임", "좀비 생존 30", "보스 레이드", "구름섬 이야기", "스타 워든"}
    assert titles <= {c["title"] for c in json.loads(api.s3._store[("live-b", live.INVENTORY_KEY)])["items"]} | {
        "A의 비밀 게임"}

    mine, _ = _lines(A_TOKEN)
    assert any(t in line for lines in mine.values() for line in lines for t in titles)  # A reads its own broadcast
    assert any(line.startswith("방송 시청") for line in mine["v-minji"])
    assert any(line.startswith("플레이어블 광고 40초") for line in mine["v-junho"])

    theirs, people = _lines(B_TOKEN)
    assert theirs == seeded  # B reads the seeded history, as before A went on air
    leaked = [line for lines in theirs.values() for line in lines if any(t in line for t in titles)]
    assert leaked == [] and not any(t in json.dumps(people, ensure_ascii=False) for t in titles)

    # B's own broadcast then shows in B's lines, still not in A's
    b = _studio(api, "user-2", "gm_b", "두 번째 계정의 게임")
    live.start(api, b, {"gameId": "gm_b", "everyRounds": 1, "adType": "corner"})
    live.round_done(api, b, {"rounds": 1})
    shown = _breaks_log(api, b)[-1]
    live.ad_event(api, b, {"viewerId": "v-minji", "eventId": shown["eventId"], "kind": "corner", "action": "impression"})
    assert any("두 번째 계정의 게임 트레일러" in line for line in _lines(B_TOKEN)[0]["v-minji"])
    assert not any("두 번째 계정의 게임" in line for lines in _lines(A_TOKEN)[0].values() for line in lines)


def _before_owners(api, clock):
    """Writes a viewer's ad impression and watch time with no owner on them (events older than the owner field)."""
    viewers.ensure(api)
    viewers.append(api, "v-junho", {"type": "ad_impression", "title": "누군가의 게임", "genre": "racing"}, clock.t - 30)
    store._put(api, "VIEWER#v-junho", "WATCH#oldjob", {"first": viewers._iso(clock.t - 600), "last": clock.t - 300,
                                                      "sec": 300, "jobId": "oldjob", "title": "누군가의 방송"})


class DemoSecret:
    """Secrets Manager with the shared demo account's secret beside the playback key the fixture holds."""

    def __init__(self, inner, username="demo", fail=None):
        self.inner, self.username, self.fail, self.reads = inner, username, fail, 0

    def get_secret_value(self, SecretId):
        if SecretId != "ipverse/demo-user":
            return self.inner.get_secret_value(SecretId=SecretId)
        self.reads += 1
        if self.fail:
            raise self.fail
        return {"SecretString": json.dumps({"username": self.username, "password": "Never-leaves-the-secret-1!"})}


@pytest.fixture
def demo(api, monkeypatch):
    monkeypatch.setattr(app, "_demo", {}, raising=False)  # (what a container remembers of the demo account)
    api.secretsmanager = DemoSecret(api.secretsmanager)
    return api.secretsmanager


def test_activity_recorded_before_owners_were_marked_is_shown_to_nobody_when_the_demo_account_is_not_known(api, clock, monkeypatch):
    """Events with no owner, and no demo account to give them to (no secret: a test stack): shown to nobody."""
    monkeypatch.setattr(app, "_demo", {}, raising=False)
    _before_owners(api, clock)
    for token in (A_TOKEN, B_TOKEN):
        lines, _ = _lines(token)
        assert not any("누군가" in line for line in lines["v-junho"]) and len(lines["v-junho"]) == 5
    # the ad decision still reads the whole log (the viewer is one person across broadcasts)
    assert any(e.get("title") == "누군가의 게임" for e in viewers.log(api, "v-junho", clock.t))


def test_activity_recorded_before_owners_were_marked_is_the_demo_accounts(api, clock, demo):
    """An event with no owner is read as the demo account's (the account older broadcasts were made with) and
    reaches nobody else. Which account that is comes from the demo secret's username."""
    _before_owners(api, clock)

    mine, people = _lines(A_TOKEN)  # (the token of the account whose username the secret names)
    assert mine["v-junho"][0] == "광고 노출 · 누군가의 게임 (레이싱)" and "방송 시청 5분 · 누군가의 방송" in mine["v-junho"]
    theirs, others = _lines(B_TOKEN)
    assert not any("누군가" in line for line in theirs["v-junho"]) and len(theirs["v-junho"]) == 5
    assert theirs == {vid: lines for vid, lines in _lines(B_TOKEN)[0].items()}
    for answer in (people, others):  # the secret's other half is never read into an answer
        assert "Never-leaves" not in json.dumps(answer, ensure_ascii=False)
    for _ in range(5):  # the watch page asks every 15 s: the secret is read once
        _lines(A_TOKEN)
    assert demo.reads == 1


def test_only_the_account_the_secret_names_reads_the_unowned_activity(api, clock, demo):
    _before_owners(api, clock)
    api.cognito = FakeCognito({A_TOKEN: ("user-1", "Demo"), B_TOKEN: ("user-2", "demo2"), "token-c": ("user-3", "")})
    for token in (A_TOKEN, B_TOKEN, "token-c"):  # a name that only looks like it, and an account with none
        assert not any("누군가" in line for line in _lines(token)[0]["v-junho"]), token
    # an event that has an owner is its owner's, the demo account included
    api.cognito = FakeCognito({A_TOKEN: ("user-1", "demo"), B_TOKEN: ("user-2", "second")})
    app.auth._CACHE.clear()
    viewers.append(api, "v-junho", {"type": "ad_impression", "title": "두 번째 계정의 것", "genre": "racing", "owner": "user-2"},
                   clock.t - 10)
    assert not any("두 번째 계정의 것" in line for line in _lines(A_TOKEN)[0]["v-junho"])
    assert any("두 번째 계정의 것" in line for line in _lines(B_TOKEN)[0]["v-junho"])


@pytest.mark.parametrize("broken", ["missing", "denied", "no_name", "not_json"])
def test_a_demo_secret_that_cannot_be_read_gives_the_unowned_activity_to_nobody(api, clock, demo, broken, capsys):
    from botocore.exceptions import ClientError
    _before_owners(api, clock)
    if broken in ("missing", "denied"):
        code = "ResourceNotFoundException" if broken == "missing" else "AccessDeniedException"
        demo.fail = ClientError({"Error": {"Code": code, "Message": "secret detail"}}, "GetSecretValue")
    elif broken == "no_name":
        demo.username = None
    else:
        demo.get_secret_value = lambda SecretId: {"SecretString": "not json"}
    for token in (A_TOKEN, B_TOKEN):
        lines, _ = _lines(token)  # the page is still answered
        assert not any("누군가" in line for line in lines["v-junho"])
    assert "secret detail" not in capsys.readouterr().out
    clock.t += 30
    _lines(A_TOKEN)
    assert demo.reads <= 1  # and the secret is not asked for at every poll


# ── the playable-server switch ───────────────────────────────────────────────────

def test_another_account_cannot_flip_the_playable_server_under_the_broadcast_on_air(ctx, clock):  # noqa: F811
    a, b = _owner(ctx), _studio(ctx, "user-2", "gm_b", "두 번째 계정의 게임")
    ctx.s3._store[(ctx.assets_bucket, "games/gm_1/runtime3d.js")] = b"const standby = query.get('standby');"
    live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable"})
    token = live.status(ctx, a)["job"]["standbyToken"]
    hidden = playable.start(ctx, _job(ctx)["playableAdId"], {"signalRequest": "sdp", "standby": True, "standbyToken": token})
    switch = ctx.s3._store.get(("live-b", live.STANDBY_KEY))

    for body in ({"on": False}, {"on": True}, {"on": True, "prewarm": True}):
        with pytest.raises(live.LiveError) as refused:
            live.standby_set(ctx, b, body)
        assert (refused.value.status, refused.value.code) == (409, "live_busy")
    assert ctx.gls.loc["TargetIdleCapacity"] == 1 and ctx.gls.ended == []  # the host and A's hidden session stay
    assert ctx.s3._store.get(("live-b", live.STANDBY_KEY)) == switch and _job(ctx)["standby"] is True
    assert live.standby_status(ctx, b)["on"] is True  # reading the shared host's state is still everyone's

    other = _studio(ctx, "user-1", "gm_2", "같은 계정의 다른 게임")  # the owner's own account, from any of its sessions
    assert live.standby_set(ctx, other, {"on": False})["on"] is False
    assert ctx.gls.ended == [hidden["streamId"]]


def test_with_nobody_on_air_any_account_may_hold_a_host_for_its_own_broadcast(ctx, clock):  # noqa: F811
    a, b = _owner(ctx), _studio(ctx, "user-2", "gm_b", "두 번째 계정의 게임")
    live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1})
    live.stop(ctx, a)
    assert live.standby_set(ctx, b, {"on": True, "prewarm": True})["on"] is True
    live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1})
    live.beat(ctx, a)
    _quiet(ctx, clock)  # A's window is gone: the switch is free again
    assert live.standby_set(ctx, b, {"on": False})["on"] is False


# ── two starts at once ───────────────────────────────────────────────────────────
# start() takes seconds between reading the job file and writing its own job (the inventory, the stream group and IVS
# calls come in between). Its owner check is a claim written into the job file under S3's conditional write, and the
# job is written only over that claim, so two accounts pressing 라이브 켜기 together cannot both pass.

def _during(monkeypatch, then):
    """Run `then` once, in the middle of the next start: after its claim, before its job is written."""
    plan, ran = live._plan_ads, []

    def slow(*args, **kwargs):
        if not ran:
            ran.append(True)
            then()
        return plan(*args, **kwargs)
    monkeypatch.setattr(live, "_plan_ads", slow)


def test_another_accounts_start_in_the_middle_of_a_start_is_refused(ctx, clock, monkeypatch):  # noqa: F811
    a, b = _owner(ctx), _studio(ctx, "user-2", "gm_b", "두 번째 계정의 게임")
    seen = {}

    def press():  # A's start is reading its inventory: B presses 라이브 켜기
        before = dict(ctx.table.items)
        for body in ({}, {"takeover": True}, {"adType": "playable"}):
            with pytest.raises(live.LiveError) as refused:
                live.start(ctx, b, {"gameId": "gm_b", "everyRounds": 1, **body})
            seen[json.dumps(body)] = (refused.value.status, refused.value.code, refused.value.message)
        seen["untouched"] = dict(ctx.table.items) == before and ctx.gls.loc["TargetIdleCapacity"] == 0
        seen["b"] = live.status(ctx, b)
    _during(monkeypatch, press)

    out = live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1})

    refusals = [seen[k] for k in seen if k.startswith("{")]
    assert len(refusals) == 3 and set(refusals) == {(409, "live_busy", BUSY)}
    assert seen["untouched"] and seen["b"]["active"] is False and seen["b"]["job"] is None
    assert out["active"] is True and (_job(ctx)["sessionId"], _job(ctx)["ownerSub"]) == (a["sessionId"], "user-1")
    assert "starting" not in _job(ctx) and live.status(ctx, b)["active"] is False


@pytest.mark.parametrize("earlier", ["none", "stopped"])
def test_a_start_that_read_the_job_file_before_another_one_landed_does_not_overwrite_it(ctx, clock, earlier):  # noqa: F811
    """Both read the same file, B's whole start lands, then A writes. With no file the write is "only if there is
    none"; with one it is "only if it is the one that was read"."""
    a, b = _owner(ctx), _studio(ctx, "user-2", "gm_b", "두 번째 계정의 게임")
    if earlier == "stopped":
        live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1})
        live.stop(ctx, a)
    read, landed, stops = ctx.s3.get_object, [], len(_stops(ctx))

    def get_object(Bucket, Key):
        got = read(Bucket=Bucket, Key=Key)
        if Key == live.JOB_KEY and not landed:  # A has the file as it was; B starts and goes on air before A writes
            landed.append(True)
            ctx.s3.get_object = read
            assert live.start(ctx, b, {"gameId": "gm_b", "everyRounds": 1})["active"] is True
        return got
    ctx.s3.get_object = get_object
    on_air = None

    with pytest.raises(live.LiveError) as refused:
        try:
            live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1})
        finally:
            on_air = _job(ctx)
    assert landed and (refused.value.status, refused.value.code, refused.value.message) == (409, "live_busy", BUSY)
    assert (on_air["sessionId"], on_air["ownerSub"]) == (b["sessionId"], "user-2") and not on_air.get("stop")
    assert live.status(ctx, b)["active"] is True and len(_stops(ctx)) == stops  # B's broadcast was not touched


def test_another_account_cannot_flip_the_playable_server_under_a_start_either(ctx, clock, monkeypatch):  # noqa: F811
    """The seconds of a start are the broadcast's already: the switch is refused as it is under a broadcast on air."""
    a, b = _owner(ctx), _studio(ctx, "user-2", "gm_b", "두 번째 계정의 게임")
    ctx.s3._store[(ctx.assets_bucket, "games/gm_1/runtime3d.js")] = b"const standby = query.get('standby');"
    seen = []

    def flip():
        for body in ({"on": False}, {"on": True}, {"on": True, "prewarm": True}):
            with pytest.raises(live.LiveError) as refused:
                live.standby_set(ctx, b, body)
            seen.append((refused.value.status, refused.value.code, refused.value.message))
    _during(monkeypatch, flip)

    assert live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable"})["active"] is True
    assert seen == [(409, "live_busy", live.SWITCH_BUSY_TEXT)] * 3
    assert ctx.gls.loc["TargetIdleCapacity"] == 1 and ("live-b", live.STANDBY_KEY) not in ctx.s3._store


def test_a_start_that_fails_gives_the_channel_back_at_once(ctx, clock, monkeypatch):  # noqa: F811
    a, b = _owner(ctx), _studio(ctx, "user-2", "gm_b", "두 번째 계정의 게임")

    def broken(*args, **kwargs):
        raise RuntimeError("inventory read failed")
    with monkeypatch.context() as patched:
        patched.setattr(live, "_plan_ads", broken)
        with pytest.raises(RuntimeError):
            live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1})

    assert "starting" not in json.loads(ctx.s3._store.get(("live-b", live.JOB_KEY), b"{}"))
    assert live.start(ctx, b, {"gameId": "gm_b", "everyRounds": 1})["active"] is True


def test_a_start_that_died_holds_the_channel_for_a_minute_at_most(ctx, clock):  # noqa: F811
    """Its claim was never given back (the handler was killed): other accounts wait it out, its own session need not."""
    a, b = _owner(ctx), _studio(ctx, "user-2", "gm_b", "두 번째 계정의 게임")
    ctx.s3._store[("live-b", live.JOB_KEY)] = json.dumps({"starting": {
        "token": "dead", "sub": "user-1", "sessionId": a["sessionId"], "at": clock.t}}).encode()

    with pytest.raises(live.LiveError) as refused:
        live.start(ctx, b, {"gameId": "gm_b", "everyRounds": 1})
    assert refused.value.code == "live_busy"
    clock.t += live.START_CLAIM_SEC + 1
    assert live.start(ctx, b, {"gameId": "gm_b", "everyRounds": 1})["active"] is True
    live.stop(ctx, b)

    ctx.s3._store[("live-b", live.JOB_KEY)] = json.dumps({"starting": {
        "token": "dead", "sub": "user-1", "sessionId": a["sessionId"], "at": clock.t}}).encode()
    assert live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1})["active"] is True  # the same session, at once


def test_the_owners_other_session_takes_a_start_over_only_when_it_says_so(ctx, clock, monkeypatch):  # noqa: F811
    a, other = _owner(ctx), _studio(ctx, "user-1", "gm_2", "같은 계정의 다른 게임")
    seen = {}

    def press():
        with pytest.raises(live.LiveError) as asked:
            live.start(ctx, other, {"gameId": "gm_2", "everyRounds": 1})
        seen["asked"] = asked.value.code
        seen["took"] = live.start(ctx, other, {"gameId": "gm_2", "everyRounds": 1, "takeover": True})["active"]
    _during(monkeypatch, press)

    with pytest.raises(live.LiveError) as lost:  # the start that was taken over writes nothing
        live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1})
    assert seen == {"asked": "live_other_session", "took": True}
    assert (lost.value.status, lost.value.code) == (409, "busy") and "니다" not in lost.value.message
    assert _job(ctx)["sessionId"] == other["sessionId"] and not _job(ctx).get("stop")
    assert _stops(ctx) == []  # and stops nothing of the broadcast that won
    assert live.status(ctx, other)["active"] is True and live.status(ctx, a)["active"] is False


def test_a_start_over_another_accounts_dead_broadcast_tells_its_pages_nothing_of_the_new_owner(ctx, clock, monkeypatch):  # noqa: F811
    """The claim sits in the job file while the dead broadcast's own page may still poll it: no id of the account
    that is starting reaches that page."""
    a, b = _owner(ctx), _studio(ctx, "user-2", "gm_b", "두 번째 계정의 게임")
    live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1})
    live.beat(ctx, a)
    _quiet(ctx, clock)  # A closed the tab; the reap has not come yet
    seen = {}

    def poll():
        seen["a"] = json.dumps(live.status(ctx, a))
        seen["claim"] = _job(ctx)["starting"]
    _during(monkeypatch, poll)

    assert live.start(ctx, b, {"gameId": "gm_b", "everyRounds": 1})["active"] is True
    assert seen["claim"]["sessionId"] == b["sessionId"]
    for secret in (b["sessionId"], "user-2", seen["claim"]["token"], "starting"):
        assert secret not in seen["a"], secret
