"""UE5 over GameLift Streams: make_game engine=unreal, manifest, and the /stream routes."""
import json

import pytest

from server import app, auth, store, streams, tools
from server.tests.conftest import FakeCognito, FakeS3, FakeTable, make_ctx
from server.tests.test_gamespec import minimal_sf
from server.tests.test_tools import BUCKET, RUNTIME3D, _add_ip

TOKEN = "good-token"
ARN = "arn:aws:gameliftstreams:us-west-2:087967639890:streamsession/sg-awoQFa2Sf/ses-AbC123"


class FakeGls:
    def __init__(self):
        self.calls = []
        self.status = "ACTIVATING"

    def _log(self, name, kwargs):
        self.calls.append((name, kwargs))

    def get_stream_group(self, **kw):
        self._log("get_stream_group", kw)
        return {"DefaultApplication": {"Id": "a-Build7"}}

    def start_stream_session(self, **kw):
        self._log("start_stream_session", kw)
        return {"Arn": ARN, "Status": "ACTIVATING"}

    def get_stream_session(self, **kw):
        self._log("get_stream_session", kw)
        out = {"Status": self.status}
        if self.status == "ACTIVE":
            out["SignalResponse"] = "answer-sdp"
        return out

    def create_stream_session_connection(self, **kw):
        self._log("create_stream_session_connection", kw)
        return {"SignalResponse": "answer-2"}

    def terminate_stream_session(self, **kw):
        self._log("terminate_stream_session", kw)
        return {}


@pytest.fixture
def ctx(monkeypatch):
    c = make_ctx(table=FakeTable(), s3=FakeS3(),
                 cognito=FakeCognito({TOKEN: ("user-1", "demo"), "other-token": ("user-2", "other")}))
    c.assets_bucket = BUCKET
    monkeypatch.setattr(c.s3, "generate_presigned_url",
                        lambda op, Params, ExpiresIn: f"https://signed/{Params['Key']}?ttl={ExpiresIn}", raising=False)
    monkeypatch.setattr(app, "CTX", c)
    monkeypatch.setattr(auth, "_CACHE", {})
    monkeypatch.setattr(streams, "_app_cache", {})
    monkeypatch.setenv("STREAM_GROUP_ID", "sg-awoQFa2Sf")
    monkeypatch.delenv("STREAM_APPLICATION_ID", raising=False)
    monkeypatch.setenv("STREAM_LOCATIONS", "ap-northeast-2,us-west-2")
    return c


@pytest.fixture
def gls(monkeypatch):
    fake = FakeGls()
    monkeypatch.setattr(streams, "_client", fake)
    return fake


def call(method, path, body=None, token=TOKEN):
    event = {"requestContext": {"http": {"method": method}}, "rawPath": path,
             "headers": {"x-auth-token": token}, "isBase64Encoded": False,
             "body": None if body is None else json.dumps(body)}
    resp = app.handler(event, None)
    return resp["statusCode"], json.loads(resp["body"])


def _unreal_session(ctx, genre="sf-shooter"):
    session = store.put_session(ctx, "user-1", "카이", genre)
    sid = session["sessionId"]
    for name in RUNTIME3D:
        ctx.s3._store[(BUCKET, f"runtime3d/v1/{name}")] = b"3d"
    for ip_id in ("ip_kai", "ip_elder"):
        _add_ip(ctx, sid, ip_id, b"PNG")
        glb = store.put_asset(ctx, sid, {"kind": "glb", "key": f"sessions/{sid}/{ip_id}.glb",
                                         "contentType": "model/gltf-binary", "ipId": ip_id})
        ctx.s3._store[(BUCKET, glb["key"])] = b"glTF" + ip_id.encode()
        store.update_ip(ctx, sid, ip_id, glbAssetId=glb["assetId"])
    return session


def _make_unreal_game(ctx, session, genre="sf-shooter"):
    spec = minimal_sf()
    if genre.startswith("rpg-"):
        spec.update(genre=genre, objective={"type": "talk", "target": 1}, enemies=[])
    spec["player"]["ipId"] = "ip_kai"
    return tools.run_tool(ctx, session, "make_game", {"spec": spec, "engine": "unreal"})


def test_make_game_unreal_keeps_three_preview_and_writes_ue5_template(ctx):
    session = _unreal_session(ctx)
    out = _make_unreal_game(ctx, session)
    gid = out["gameId"]
    s3 = ctx.s3._store
    assert json.loads(s3[(BUCKET, f"games/{gid}/spec.json")])["engine"] == "three"  # browser fallback
    assert s3[(BUCKET, f"games/{gid}/assets/ip_kai.glb")] == b"glTFip_kai"
    ue5 = json.loads(s3[(BUCKET, f"games/{gid}/ue5.json")])
    assert ue5["spec"]["engine"] == "unreal"
    assert ue5["ips"] == {"ip_kai": {"role": "player", "glbKey": f"games/{gid}/assets/ip_kai.glb", "name": "ip_kai"}}
    [game] = store.snapshot(ctx, session["sessionId"])["games"]
    assert (game["engine"], game["ue5Key"]) == ("unreal", f"games/{gid}/ue5.json")


def test_make_game_unreal_rpg_casts_an_npc(ctx):
    session = _unreal_session(ctx, "rpg-quest")
    gid = _make_unreal_game(ctx, session, "rpg-quest")["gameId"]
    ue5 = json.loads(ctx.s3._store[(BUCKET, f"games/{gid}/ue5.json")])
    assert ue5["ips"]["ip_elder"]["role"] == "npc"
    assert ue5["ips"]["ip_elder"]["glbKey"] == f"sessions/{session['sessionId']}/ip_elder.glb"


def test_stream_start_writes_private_manifest_and_starts_session(ctx, gls):
    session = _unreal_session(ctx)
    sid = session["sessionId"]
    gid = _make_unreal_game(ctx, session)["gameId"]

    status, data = call("POST", f"/api/sessions/{sid}/stream", {"signalRequest": "offer-sdp"})

    assert status == 202
    assert data == {"streamId": "ses-AbC123", "status": "ACTIVATING", "gameId": gid}
    [(_, group), (_, start)] = gls.calls
    assert group == {"Identifier": "sg-awoQFa2Sf"}
    assert start["ApplicationIdentifier"] == "a-Build7" and start["SignalRequest"] == "offer-sdp"
    assert start["Protocol"] == "WebRTC" and start["UserId"] == "user-1"
    assert start["Locations"] == ["ap-northeast-2", "us-west-2"]
    url = start["AdditionalEnvironmentVariables"]["IPVERSE_SPEC_URL"]
    key = url.removeprefix("https://signed/").split("?")[0]
    assert key.startswith(f"streams/{sid}/") and key.endswith(".json")  # not under the CDN-served games/
    manifest = json.loads(ctx.s3._store[(BUCKET, key)])
    assert manifest["manifestVersion"] == 1 and manifest["spec"]["player"]["ipId"] == "ip_kai"
    assert manifest["ips"]["ip_kai"] == {"role": "player", "name": "ip_kai", "yaw": 0.0,
                                         "glbUrl": f"https://signed/games/{gid}/assets/ip_kai.glb?ttl=900"}
    assert store.get_session(ctx, sid)["stream"]["arn"] == ARN


def test_stream_poll_returns_signal_response_when_active(ctx, gls):
    session = _unreal_session(ctx)
    sid = session["sessionId"]
    _make_unreal_game(ctx, session)
    call("POST", f"/api/sessions/{sid}/stream", {"signalRequest": "offer"})

    assert call("GET", f"/api/sessions/{sid}/stream/ses-AbC123") == (200, {"streamId": "ses-AbC123", "status": "ACTIVATING"})
    gls.status = "ACTIVE"
    status, data = call("GET", f"/api/sessions/{sid}/stream/ses-AbC123")
    assert (status, data["signalResponse"]) == (200, "answer-sdp")
    assert gls.calls[-1] == ("get_stream_session", {"Identifier": "sg-awoQFa2Sf", "StreamSessionIdentifier": "ses-AbC123"})


def test_stream_reconnect_and_terminate(ctx, gls):
    session = _unreal_session(ctx)
    sid = session["sessionId"]
    _make_unreal_game(ctx, session)
    call("POST", f"/api/sessions/{sid}/stream", {"signalRequest": "offer"})

    assert call("POST", f"/api/sessions/{sid}/stream/ses-AbC123/reconnect", {"signalRequest": "offer-2"}) == (
        200, {"streamId": "ses-AbC123", "signalResponse": "answer-2"})
    assert call("DELETE", f"/api/sessions/{sid}/stream/ses-AbC123")[0] == 200
    assert gls.calls[-1][0] == "terminate_stream_session"
    assert store.get_session(ctx, sid).get("stream") is None
    assert call("GET", f"/api/sessions/{sid}/stream/ses-AbC123")[0] == 404  # gone from the session


def test_stream_second_start_terminates_the_first(ctx, gls):
    session = _unreal_session(ctx)
    sid = session["sessionId"]
    _make_unreal_game(ctx, session)
    call("POST", f"/api/sessions/{sid}/stream", {"signalRequest": "offer"})
    gls.status = "ACTIVE"  # placed (one still waiting is taken over instead: test_stream_sessions.py)
    call("POST", f"/api/sessions/{sid}/stream", {"signalRequest": "offer"})
    names = [n for n, _ in gls.calls]
    assert names.count("start_stream_session") == 2
    assert names.index("terminate_stream_session") > names.index("start_stream_session")


def test_stream_guards(ctx, gls, monkeypatch):
    session = _unreal_session(ctx)
    sid = session["sessionId"]
    assert call("POST", f"/api/sessions/{sid}/stream", {"signalRequest": "offer"})[1]["error"] == "no_game"  # nothing to stream yet
    _make_unreal_game(ctx, session)
    assert call("POST", f"/api/sessions/{sid}/stream", {})[0] == 400
    assert call("POST", f"/api/sessions/{sid}/stream", {"signalRequest": "offer"}, token="other-token")[0] == 404
    assert call("GET", f"/api/sessions/{sid}/stream/ses-other")[0] == 404
    monkeypatch.delenv("STREAM_GROUP_ID")
    assert call("POST", f"/api/sessions/{sid}/stream", {"signalRequest": "offer"}) == (
        503, {"error": "streams_disabled", "message": "Unreal 플레이가 아직 준비되지 않았어요. 관리자에게 문의해 주세요."})


def test_stream_aws_errors_become_503(ctx, gls, monkeypatch):
    session = _unreal_session(ctx)
    sid = session["sessionId"]
    _make_unreal_game(ctx, session)

    class Quota(Exception):
        response = {"Error": {"Code": "ServiceQuotaExceededException"}}

    def boom(**kw):
        raise Quota("no capacity")

    monkeypatch.setattr(gls, "start_stream_session", boom)
    status, data = call("POST", f"/api/sessions/{sid}/stream", {"signalRequest": "offer"})
    assert (status, data["error"]) == (503, "stream_ServiceQuotaExceededException")


def test_a_threejs_game_streams_through_the_web_player_group(ctx, gls, monkeypatch):
    monkeypatch.setenv("WEB_STREAM_GROUP_ID", "sg-web")
    session = _unreal_session(ctx)
    sid = session["sessionId"]
    spec = minimal_sf()
    spec["player"]["ipId"] = "ip_kai"
    gid = tools.run_tool(ctx, session, "make_game", {"spec": spec})["gameId"]  # three.js
    status, data = call("POST", f"/api/sessions/{sid}/stream", {"signalRequest": "offer", "gameId": gid})
    assert status == 202 and data["gameId"] == gid
    start = next(kw for name, kw in gls.calls if name == "start_stream_session")
    assert start["Identifier"] == "sg-web" and start["ApplicationIdentifier"] == "a-Build7"
    assert start["AdditionalEnvironmentVariables"]["IPVERSE_GAME_URL"].endswith(f"/games/{gid}/index.html?noads=1")
    call("GET", f"/api/sessions/{sid}/stream/{data['streamId']}")
    call("DELETE", f"/api/sessions/{sid}/stream/{data['streamId']}")
    later = [kw["Identifier"] for name, kw in gls.calls if name in ("get_stream_session", "terminate_stream_session")]
    assert later and set(later) == {"sg-web"}  # the session remembers its group


def test_playable_ad_public_stream_with_a_time_box(ctx, gls, monkeypatch):
    monkeypatch.setenv("WEB_STREAM_GROUP_ID", "sg-web")
    session = _unreal_session(ctx)
    sid = session["sessionId"]
    spec = minimal_sf()
    spec["player"]["ipId"] = "ip_kai"
    gid = tools.run_tool(ctx, session, "make_game", {"spec": spec})["gameId"]
    status, ad = call("POST", f"/api/sessions/{sid}/playable-ads", {"gameId": gid, "seconds": 60})
    assert status == 201 and ad["adId"].startswith("ad_") and ad["adPath"] == f"#ad={ad['adId']}"
    assert call("POST", f"/api/sessions/{sid}/playable-ads", {"gameId": gid, "seconds": 5})[0] == 400
    # anyone with the link: no token
    status, pub = call("GET", f"/api/ads/{ad['adId']}", token="")
    assert status == 200 and pub["seconds"] == 60 and "sessionId" not in pub
    status, started = call("POST", f"/api/ads/{ad['adId']}/stream", {"signalRequest": "offer"}, token="")
    assert status == 202
    start = [kw for name, kw in gls.calls if name == "start_stream_session"][-1]
    assert start["Identifier"] == "sg-web" and start["SessionLengthSeconds"] == 60 + 45
    assert start["AdditionalEnvironmentVariables"]["IPVERSE_GAME_URL"].endswith("?noads=1&playable=60")
    assert start["Description"] == f"ipverse ad {ad['adId']}"
    original = gls.get_stream_session
    gls.get_stream_session = lambda **kw: {**original(**kw), "Description": start["Description"]}
    assert call("GET", f"/api/ads/{ad['adId']}/stream/{started['streamId']}", token="")[0] == 200
    gls.get_stream_session = lambda **kw: {**original(**kw), "Description": "ipverse web gm_other"}
    assert call("GET", f"/api/ads/{ad['adId']}/stream/{started['streamId']}", token="")[0] == 404  # not this ad's
    assert call("GET", "/api/ads/ad_nope", token="")[0] == 404
