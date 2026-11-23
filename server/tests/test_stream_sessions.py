"""GameLift Streams sessions end on every path that replaces or abandons them, and a start past the group's
MaximumCapacity is refused in Korean.

The fake behaves like the service: a session waits ACTIVATING for a host, TerminateStreamSession refuses it then
(ValidationException), and StartStreamSession accepts anything (a start past capacity just queues)."""
import json

import pytest
from botocore.exceptions import ClientError

from server import app, auth, live, playable, store, streams
from server.tests.conftest import FakeCognito, FakeLambda, FakeS3, FakeTable, make_ctx
from server.tests.test_live import FakeIvs, _job

TOKENS = {"tok-1": ("user-1", "one"), "tok-2": ("user-2", "two"), "tok-3": ("user-3", "three")}
HOLDS = ("ACTIVATING", "ACTIVE", "CONNECTED")


def _err(code, op):
    return ClientError({"Error": {"Code": code, "Message": code}}, op)


class Gls:
    def __init__(self, maximum=2):
        self.loc = {"LocationName": "us-west-2", "AlwaysOnCapacity": 0, "OnDemandCapacity": maximum,
                    "MaximumCapacity": maximum, "TargetIdleCapacity": 0}
        self.sessions: dict = {}
        self.starts: list = []
        self.terminates: list = []
        self.connections: list = []
        self.refuse_connections = False

    def get_stream_group(self, Identifier):
        return {"DefaultApplication": {"Id": "a-1"}, "LocationStates": [dict(self.loc)]}

    def update_stream_group(self, Identifier, LocationConfigurations):
        self.loc.update(LocationConfigurations[0])

    def start_stream_session(self, Identifier, **kw):
        sid = f"s{len(self.sessions) + 1}"
        self.sessions[sid] = {"Status": "ACTIVATING", "UserId": kw["UserId"], "Description": kw["Description"],
                              "group": Identifier, "kw": kw}
        self.starts.append(sid)
        return {"Arn": f"arn:aws:gameliftstreams:us-west-2:1:streamsession/{Identifier}/{sid}", "Status": "ACTIVATING"}

    def get_stream_session(self, Identifier, StreamSessionIdentifier):
        s = self.sessions.get(StreamSessionIdentifier)
        if not s or s["group"] != Identifier:
            raise _err("ResourceNotFoundException", "GetStreamSession")
        out = {k: s[k] for k in ("Status", "UserId", "Description")}
        if s["Status"] == "ACTIVE":
            out["SignalResponse"] = "answer"
        return out

    def terminate_stream_session(self, Identifier, StreamSessionIdentifier):
        s = self.sessions.get(StreamSessionIdentifier)
        if not s or s["group"] != Identifier:
            raise _err("ResourceNotFoundException", "TerminateStreamSession")
        if s["Status"] == "ACTIVATING":
            raise _err("ValidationException", "TerminateStreamSession")
        self.terminates.append(StreamSessionIdentifier)
        if s["Status"] not in ("TERMINATING", "TERMINATED"):
            s["Status"] = "TERMINATING"
        return {}

    def create_stream_session_connection(self, Identifier, StreamSessionIdentifier, SignalRequest):
        if self.refuse_connections:
            raise _err("ValidationException", "CreateStreamSessionConnection")
        s = self.sessions.get(StreamSessionIdentifier)
        if not s or s["group"] != Identifier:
            raise _err("ResourceNotFoundException", "CreateStreamSessionConnection")
        if s["Status"] not in ("ACTIVE", "PENDING_CLIENT_RECONNECTION"):  # as documented
            raise _err("ValidationException", "CreateStreamSessionConnection")
        self.connections.append((StreamSessionIdentifier, SignalRequest))
        return {"SignalResponse": f"answer to {SignalRequest}"}

    def place(self, *ids):
        for sid in ids or [k for k, v in self.sessions.items() if v["Status"] == "ACTIVATING"]:
            self.sessions[sid]["Status"] = "ACTIVE"

    def holding(self):
        return sorted(k for k, v in self.sessions.items() if v["Status"] in HOLDS)


@pytest.fixture
def gls(monkeypatch):
    fake = Gls()
    monkeypatch.setattr(streams, "_client", fake)
    monkeypatch.setattr(streams, "_app_cache", {})
    return fake


@pytest.fixture
def ctx(monkeypatch, gls):
    for k, v in {"WEB_STREAM_GROUP_ID": "sg-web", "STREAM_GROUP_ID": "sg-ue", "SELF_FUNCTION_NAME": "ipverse-api",
                 "LIVE_BUCKET": "live-b", "CDN_DOMAIN": "cdn.example"}.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("STREAM_APPLICATION_ID", raising=False)
    c = make_ctx(table=FakeTable(), s3=FakeS3(), lambda_=FakeLambda(), ivs=FakeIvs(), cognito=FakeCognito(TOKENS))
    monkeypatch.setattr(app, "CTX", c)
    monkeypatch.setattr(auth, "_CACHE", {})
    live._chan.clear()
    live._stream_cache.clear()
    return c


def call(method, path, body=None, token="tok-1"):
    event = {"requestContext": {"http": {"method": method}}, "rawPath": path,
             "headers": {"x-auth-token": token} if token else {}, "isBase64Encoded": False,
             "body": None if body is None else json.dumps(body)}
    resp = app.handler(event, None)
    return resp["statusCode"], json.loads(resp["body"])


def reapers(ctx, gls, place=True, monkeypatch=None):
    """Runs the queued stream_end self-invokes (GameLift places the waiting sessions first, when `place`)."""
    if place:
        gls.place()
    pending, ctx.lambda_.calls = ctx.lambda_.calls, []
    return [app.handler(json.loads(c["Payload"]), None) for c in pending]


def _studio(ctx, sub="user-1", runtime=b"const standby = query.get('standby');"):
    s = store.put_session(ctx, sub, "t", "sf-shooter")
    store.put_game(ctx, s["sessionId"], {"gameId": "gm_1", "title": "G", "genre": "sf-shooter", "specKey": "k",
                                         "previewUrl": "https://cdn.example/games/gm_1/index.html"})
    ctx.s3._store[(ctx.assets_bucket, "games/gm_1/runtime3d.js")] = runtime
    return s


def _cloud(sid, token="tok-1", offer="offer", game_id="gm_1"):
    return call("POST", f"/api/sessions/{sid}/stream", {"signalRequest": offer, "gameId": game_id, "kind": "web"}, token)


# 취소 on a queued cloud stream

def test_cancel_while_waiting_for_a_host_ends_the_session_once_it_is_placed(ctx, gls):
    sid = _studio(ctx)["sessionId"]
    status, started = _cloud(sid)
    assert status == 202 and gls.sessions[started["streamId"]]["Status"] == "ACTIVATING"

    assert call("DELETE", f"/api/sessions/{sid}/stream/{started['streamId']}")[0] == 200  # 취소
    assert gls.terminates == []  # refused while ACTIVATING: a waiter ends it once placed
    assert [json.loads(c["Payload"])["action"] for c in ctx.lambda_.calls] == ["stream_end"]
    call("DELETE", f"/api/sessions/{sid}/stream/{started['streamId']}")  # pagehide sends it again
    assert len(ctx.lambda_.calls) == 1  # idempotent: one waiter per session

    reapers(ctx, gls)  # placed: it would hold the host until connectionTimeout
    assert gls.terminates == [started["streamId"]] and gls.holding() == []
    assert (len(gls.starts), len(gls.terminates)) == (1, 1)


def test_the_waiter_hands_over_while_placement_takes_long_and_gives_up_in_the_end(ctx, gls, monkeypatch):
    clock = {"t": 0.0}
    monkeypatch.setattr(streams.time, "monotonic", lambda: clock["t"])
    monkeypatch.setattr(streams.time, "sleep", lambda s: clock.__setitem__("t", clock["t"] + s))
    sid = _studio(ctx)["sessionId"]
    stream_id = _cloud(sid)[1]["streamId"]
    call("DELETE", f"/api/sessions/{sid}/stream/{stream_id}")
    rounds = 0
    while ctx.lambda_.calls:
        out = reapers(ctx, gls, place=False)
        rounds += 1
        assert out[0]["status"] == "ACTIVATING"
    assert rounds == streams.END_ROUNDS  # ~32 min of waiting, then GameLift's own timeouts take over

    call("DELETE", f"/api/sessions/{sid}/stream/{stream_id}")  # asked again later: a new waiter
    assert len(ctx.lambda_.calls) == 1
    reapers(ctx, gls)
    assert gls.terminates == [stream_id] and gls.holding() == []


def test_cancel_of_an_active_session_ends_it_at_once(ctx, gls):
    sid = _studio(ctx)["sessionId"]
    stream_id = _cloud(sid)[1]["streamId"]
    gls.place()
    assert call("GET", f"/api/sessions/{sid}/stream/{stream_id}")[1]["signalResponse"] == "answer"
    assert call("DELETE", f"/api/sessions/{sid}/stream/{stream_id}")[0] == 200
    assert gls.terminates == [stream_id] and ctx.lambda_.calls == []


# Several pages cloud-playing one studio session

def test_a_window_that_replaces_one_still_waiting_for_a_host_takes_its_place_in_the_queue(ctx, gls):
    """Three pages on one studio session: the newest takes over the waiting session (one start in all, so it does
    not queue behind replaced ones that cannot be terminated while ACTIVATING), and its own offer is answered through
    a connection once that session is placed."""
    sid = _studio(ctx)["sessionId"]
    a = _cloud(sid, offer="offer-1")[1]
    b = _cloud(sid, offer="offer-2")[1]
    c = _cloud(sid, offer="offer-3")[1]
    assert len(gls.starts) == 1 and gls.terminates == [] and ctx.lambda_.calls == []
    assert len({a["streamId"], b["streamId"], c["streamId"]}) == 3 and c["status"] == "ACTIVATING"

    for old in (a, b):  # pages 1 and 2: told why, and their teardown ends nothing
        status, err = call("GET", f"/api/sessions/{sid}/stream/{old['streamId']}")
        assert (status, err["error"]) == (409, "stream_replaced") and "다른 창" in err["message"]
        assert call("DELETE", f"/api/sessions/{sid}/stream/{old['streamId']}")[0] == 200
    assert gls.terminates == [] and ctx.lambda_.calls == []

    assert call("GET", f"/api/sessions/{sid}/stream/{c['streamId']}")[1]["status"] == "ACTIVATING"
    gls.place()  # the first (and only) session gets the host
    polled = call("GET", f"/api/sessions/{sid}/stream/{c['streamId']}")[1]
    assert (polled["status"], polled["signalResponse"]) == ("ACTIVE", "answer to offer-3")
    assert call("GET", f"/api/sessions/{sid}/stream/{c['streamId']}")[1]["signalResponse"] == "answer to offer-3"
    assert gls.connections == [(gls.starts[0], "offer-3")]  # one connection, for the winning page's offer
    assert gls.holding() == [gls.starts[0]]

    assert call("DELETE", f"/api/sessions/{sid}/stream/{c['streamId']}")[0] == 200  # the winner closes
    assert gls.terminates == [gls.starts[0]] and gls.holding() == []
    assert (len(gls.starts), len(gls.terminates)) == (1, 1)


def test_a_window_that_replaces_a_placed_session_or_another_game_starts_its_own(ctx, gls):
    sid = _studio(ctx)["sessionId"]
    store.put_game(ctx, sid, {"gameId": "gm_2", "title": "H", "genre": "sf-shooter", "specKey": "k",
                              "previewUrl": "https://cdn.example/games/gm_2/index.html"})
    a = _cloud(sid)[1]["streamId"]
    b = _cloud(sid, game_id="gm_2")[1]["streamId"]  # another game: the waiting session cannot be reused
    assert len(gls.starts) == 2
    assert gls.sessions[b]["kw"]["AdditionalEnvironmentVariables"]["IPVERSE_GAME_URL"].startswith("https://cdn.example/games/gm_2/")
    gls.place()
    c = _cloud(sid, game_id="gm_2")[1]["streamId"]  # b is placed (another page plays it): it ends now
    assert len(gls.starts) == 3 and b in gls.terminates
    reapers(ctx, gls)
    assert gls.holding() == [c] and sorted(gls.terminates) == sorted([a, b])
    assert call("GET", f"/api/sessions/{sid}/stream/{c}")[1]["signalResponse"] == "answer"
    assert gls.connections == []


def test_a_taken_over_session_that_cannot_be_connected_says_so_instead_of_waiting_forever(ctx, gls):
    sid = _studio(ctx)["sessionId"]
    _cloud(sid, offer="offer-1")
    c = _cloud(sid, offer="offer-2")[1]["streamId"]
    gls.place()
    gls.refuse_connections = True
    for _ in range(streams.ADOPT_TRIES - 1):  # a passing error: the page keeps polling
        polled = call("GET", f"/api/sessions/{sid}/stream/{c}")[1]
        assert polled["status"] == "ACTIVE" and "signalResponse" not in polled
    polled = call("GET", f"/api/sessions/{sid}/stream/{c}")[1]
    assert polled["status"] == "ERROR" and "signalResponse" not in polled  # the page shows 다시 시도
    assert call("DELETE", f"/api/sessions/{sid}/stream/{c}")[0] == 200  # its teardown ends the session
    assert gls.terminates == [gls.starts[0]] and gls.holding() == []


def test_two_starts_that_raced_past_each_other_leave_one_session(ctx, gls):
    session = _studio(ctx)
    stale = dict(session)  # both requests read the session before either stored its stream
    user = {"sub": "user-1"}
    a = streams.start(ctx, user, dict(stale), {"signalRequest": "o", "gameId": "gm_1", "kind": "web"})[1]["streamId"]
    b = streams.start(ctx, user, dict(stale), {"signalRequest": "o", "gameId": "gm_1", "kind": "web"})[1]["streamId"]
    sid = session["sessionId"]
    assert store.get_session(ctx, sid)["stream"]["arn"].endswith(b)
    status, err = call("GET", f"/api/sessions/{sid}/stream/{a}")  # the one not stored
    assert status == 409 and err["error"] == "stream_replaced"
    reapers(ctx, gls)
    assert gls.holding() == [b] and gls.terminates == [a]


def test_someone_elses_stream_is_not_found_and_not_ended(ctx, gls):
    mine = _studio(ctx)["sessionId"]
    theirs = _studio(ctx, "user-2")["sessionId"]
    other = _cloud(theirs, "tok-2")[1]["streamId"]
    gls.place()
    assert call("GET", f"/api/sessions/{mine}/stream/{other}")[0] == 404
    assert call("DELETE", f"/api/sessions/{mine}/stream/{other}")[0] == 404
    assert gls.terminates == [] and gls.holding() == [other]


# A start past MaximumCapacity

def test_a_third_cloud_session_on_a_group_of_two_is_refused_with_a_korean_message(ctx, gls):
    sids = [_studio(ctx, f"user-{n}")["sessionId"] for n in (1, 2, 3)]
    assert _cloud(sids[0], "tok-1")[0] == 202
    assert _cloud(sids[1], "tok-2")[0] == 202
    status, err = _cloud(sids[2], "tok-3")
    assert (status, err["error"]) == (503, "stream_capacity")
    assert "2대" in err["message"] and "다시 시도" in err["message"]
    assert len(gls.starts) == 2  # nothing queued behind the two

    gls.place()
    first = gls.starts[0]
    assert call("DELETE", f"/api/sessions/{sids[0]}/stream/{first}")[0] == 200  # one ends: room again
    assert _cloud(sids[2], "tok-3")[0] == 202 and len(gls.starts) == 3


def test_starts_in_flight_count_so_three_at_once_admit_two(ctx, gls, monkeypatch):
    """Three Lambdas at once: each reserves its place before it counts, so the latest of three is refused even
    though no StartStreamSession had returned yet when it counted."""
    sids = [_studio(ctx, f"user-{n}")["sessionId"] for n in (1, 2, 3)]
    for n in (1, 2):  # two starts reserved their place and are still inside StartStreamSession
        store._put(ctx, "GLS#sg-web", f"rsv#early{n}", {"at": int(streams.time.time() * 1000) - 10})
    assert _cloud(sids[2], "tok-3")[0] == 503 and gls.starts == []
    for n in (1, 2):  # a reservation that never turned into a session stops counting
        store._put(ctx, "GLS#sg-web", f"rsv#early{n}", {"at": int(streams.time.time() * 1000) - 60_000})
    assert _cloud(sids[2], "tok-3")[0] == 202


def test_the_public_ad_page_is_refused_when_the_group_is_full(ctx, gls):
    s = _studio(ctx)
    ad = playable.create(ctx, s, {"gameId": "gm_1", "seconds": 30})
    for n in (1, 2):
        assert _cloud(_studio(ctx, f"user-{n}")["sessionId"], f"tok-{n}")[0] == 202
    status, err = call("POST", f"/api/ads/{ad['adId']}/stream", {"signalRequest": "offer"}, token="")
    assert (status, err["error"]) == (503, "stream_capacity") and "자리가 모두 찼어요" in err["message"]
    assert len(gls.starts) == 2


# Playable ads (the public page, the live viewer's hidden session)

def test_the_ad_page_cancel_while_waiting_ends_the_session_once_placed(ctx, gls):
    ad = playable.create(ctx, _studio(ctx), {"gameId": "gm_1", "seconds": 30})
    stream_id = call("POST", f"/api/ads/{ad['adId']}/stream", {"signalRequest": "offer"}, token="")[1]["streamId"]
    assert call("DELETE", f"/api/ads/{ad['adId']}/stream/{stream_id}", token="")[0] == 200
    assert gls.terminates == []
    reapers(ctx, gls)
    assert gls.terminates == [stream_id] and gls.holding() == []


def _broadcast(ctx, s, seconds=30):
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable", "playableSeconds": seconds})
    return _job(ctx)["playableAdId"], live.status(ctx, s)["job"]["standbyToken"]


def _hidden(ctx, ad_id, token):
    return playable.start(ctx, ad_id, {"signalRequest": "sdp", "standby": True, "standbyToken": token})["streamId"]


def test_switching_the_ad_to_trailer_ends_the_hidden_sessions_on_the_server(ctx, gls):
    s = _studio(ctx)
    store.put_asset(ctx, s["sessionId"], {"kind": "trailer", "key": "t.mp4", "contentType": "video/mp4", "meta": {"seconds": 12}})
    ad_id, token = _broadcast(ctx, s)
    first = _hidden(ctx, ad_id, token)  # the watch window's hidden session, still waiting for a host
    live.ad_settings(ctx, s, {"adType": "trailer", "everyRounds": 1})  # 변경 적용 → 트레일러
    reapers(ctx, gls)
    assert gls.terminates == [first] and gls.holding() == []

    live.ad_settings(ctx, s, {"adType": "playable", "everyRounds": 1, "playableSeconds": 30})  # → 플레이어블 again
    second = _hidden(ctx, ad_id, token)
    gls.place()
    live.ad_settings(ctx, s, {"adType": "playable", "everyRounds": 1, "playableSeconds": 60})  # a new ad
    assert second in gls.terminates and gls.holding() == []
    assert (len(gls.starts), len(gls.terminates)) == (2, 2)


def test_ending_the_broadcast_ends_hidden_sessions_but_lets_a_revealed_trial_finish(ctx, gls):
    s = _studio(ctx)
    ad_id, token = _broadcast(ctx, s)
    playing = _hidden(ctx, ad_id, token)
    gls.place()
    playable.played(ctx, ad_id, playing)  # a viewer pressed ▶ 지금 플레이
    hidden = _hidden(ctx, ad_id, token)  # the next one warming for the next break
    live.stop(ctx, s)  # 라이브 끄기 (or the 5-minute reap of a closed play window)
    reapers(ctx, gls)
    assert gls.terminates == [hidden] and gls.holding() == [playing]


def test_switching_the_playable_server_off_ends_the_hidden_sessions(ctx, gls):
    s = _studio(ctx)
    ad_id, token = _broadcast(ctx, s)
    hidden = _hidden(ctx, ad_id, token)
    gls.place()
    live.standby_set(ctx, s, {"on": False})
    assert gls.terminates == [hidden]


# The trial starts on the viewer's first input

def test_the_ad_page_session_holds_the_round_until_the_first_input(ctx, gls):
    ad = playable.create(ctx, _studio(ctx), {"gameId": "gm_1", "seconds": 30})
    assert call("POST", f"/api/ads/{ad['adId']}/stream", {"signalRequest": "offer"}, token="")[1]["waitsForInput"] is True
    kw = gls.sessions[gls.starts[-1]]["kw"]
    assert kw["AdditionalEnvironmentVariables"]["IPVERSE_GAME_URL"].endswith("?noads=1&playable=30&standby=1")
    assert kw["Description"] == f"ipverse ad {ad['adId']}"  # still a normal (counted, short) session
    assert kw["SessionLengthSeconds"] == 30 + playable.GRACE_SEC

    old = playable.create(ctx, _studio(ctx, runtime=b"an old runtime"), {"gameId": "gm_1", "seconds": 30})
    assert call("POST", f"/api/ads/{old['adId']}/stream", {"signalRequest": "offer"},
                token="")[1]["waitsForInput"] is False  # an old runtime cannot wait: the page's clock starts at once
    assert gls.sessions[gls.starts[-1]]["kw"]["AdditionalEnvironmentVariables"]["IPVERSE_GAME_URL"].endswith("?noads=1&playable=30")
