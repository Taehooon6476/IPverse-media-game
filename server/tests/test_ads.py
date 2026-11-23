"""Per-persona trailer ads on the one gameplay channel (server/ads.py and the ad-break functions of server/live.py).
Fakes only: IVS, Secrets Manager, S3 and DynamoDB. Named without "live" so `pytest -k 'not live'` runs it."""
import base64
import hashlib
import json
import time
import urllib.parse
import xml.etree.ElementTree as ET

import jwt
import pytest
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from server import ads, app, auth, live, store, streams
from server.tests.conftest import FakeCognito, FakeS3, FakeTable, make_ctx

CHANNEL_ARN = "arn:aws:ivs:us-east-1:087967639890:channel/ch1"
PLAYBACK = "https://abc.us-east-1.playback.live-video.net/api/video/v1/ch1.m3u8"


def _err(code, op="Op"):
    return ClientError({"Error": {"Code": code, "Message": code}}, op)


class FakeIvs:
    def __init__(self):
        self.calls, self.live = [], True

    def list_channels(self, filterByName):
        return {"channels": [{"arn": CHANNEL_ARN, "name": "ipverse-live-player"}]}

    def get_channel(self, arn):
        return {"channel": {"arn": arn, "playbackUrl": PLAYBACK, "authorized": True,
                            "adConfigurationArn": "arn:ivs:ad-configuration/ad1"}}

    def get_stream(self, channelArn):
        if not self.live:
            raise _err("ChannelNotBroadcasting", "GetStream")
        return {"stream": {"state": "LIVE"}}

    def insert_ad_break(self, channelArn, durationSeconds):
        self.calls.append(("break", durationSeconds))
        return {"adBreakId": f"ivs{len(self.calls)}"}

    def put_metadata(self, channelArn, metadata):
        self.calls.append(("meta", json.loads(metadata)))

    def stop_stream(self, channelArn):
        self.calls.append(("stop",))

    def breaks(self):
        return [c[1] for c in self.calls if c[0] == "break"]


class FakeSecrets:
    """Secrets Manager: one secret, counts reads."""

    def __init__(self, value=None):
        self.value, self.reads = value, 0

    def get_secret_value(self, SecretId):
        self.reads += 1
        if self.value is None:
            raise _err("ResourceNotFoundException", "GetSecretValue")
        return {"SecretString": self.value}


def _keypair():
    key = ec.generate_private_key(ec.SECP384R1())
    d = key.private_numbers().private_value
    pub = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    return d, pub


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(time, "time", c)
    return c


@pytest.fixture
def keys():
    return _keypair()


@pytest.fixture
def ctx(monkeypatch, clock, keys):
    for k, v in {"LIVE_BUCKET": "live-b", "WEB_STREAM_GROUP_ID": "sg-web"}.items():
        monkeypatch.setenv(k, v)
    live._chan.clear()
    live._stream_cache.clear()
    ads._cache.clear()
    monkeypatch.setattr(live.time, "sleep", lambda s: None)
    monkeypatch.setattr(streams, "client", lambda: pytest.fail("no GameLift Streams in a trailer broadcast"))
    c = make_ctx(table=FakeTable(), s3=FakeS3(), ivs=FakeIvs(), cdn_domain="d1.cloudfront.net")
    c.secretsmanager = FakeSecrets(json.dumps({"d": format(keys[0], "x"), "keyPairArn": "arn:ivs:playback-key/k1"}))
    return c


def _verify(token, pub):
    return jwt.decode(token, pub, algorithms=["ES384"])


# ── ES384 playback tokens ──────────────────────────────────────────────────────

def test_es384_signature_verifies_with_a_standard_library(keys):
    d, pub = keys
    header = ads._b64(json.dumps({"alg": "ES384", "typ": "JWT"}).encode())
    payload = ads._b64(json.dumps({"x": 1}).encode())
    sig = ads.sign_es384(d, f"{header}.{payload}".encode())
    assert len(sig) == 96
    assert _verify(f"{header}.{payload}.{ads._b64(sig)}", pub) == {"x": 1}


def test_a_persona_token_carries_the_channel_origin_expiry_and_ad_params(ctx, clock, keys):
    out = ads.playback(ctx, "racer")
    url = urllib.parse.urlsplit(out["playbackUrl"])
    assert out["playbackUrl"].startswith(PLAYBACK + "?token=")
    claims = _verify(urllib.parse.parse_qs(url.query)["token"][0], keys[1])
    assert claims["aws:channel-arn"] == CHANNEL_ARN
    assert claims["aws:access-control-allow-origin"] == "https://d1.cloudfront.net"
    assert claims["exp"] == int(clock.t) + ads.TOKEN_TTL_SEC == out["expiresAt"]
    assert claims["aws:ads-player-params"] == {"persona": "racer"}
    assert out["persona"] == "racer" and out["personaName"] == "레이서"


def test_the_default_token_sends_no_persona_so_the_ads_url_asks_for_p_dot_xml(ctx, keys):
    claims = _verify(ads.playback(ctx, "")["playbackUrl"].split("token=")[1], keys[1])
    assert "aws:ads-player-params" not in claims


def test_the_private_key_is_read_once_and_tokens_are_reused_until_near_expiry(ctx, clock):
    a = ads.playback(ctx, "action")["playbackUrl"]
    assert ads.playback(ctx, "action")["playbackUrl"] == a and ctx.secretsmanager.reads == 1
    clock.t += ads.TOKEN_TTL_SEC - ads.TOKEN_REUSE_SEC + 1  # too little left for a viewer: a new one
    assert ads.playback(ctx, "action")["playbackUrl"] != a and ctx.secretsmanager.reads == 1


def test_unknown_persona_and_a_missing_key_are_refused(ctx):
    with pytest.raises(ads.AdsError) as bad:
        ads.playback(ctx, "nobody")
    assert bad.value.status == 400
    ctx.secretsmanager = FakeSecrets(None)
    ads._cache.clear()
    with pytest.raises(ads.AdsError) as missing:
        ads.playback(ctx, "racer")
    assert missing.value.status == 503 and missing.value.code == "playback_key_missing"


def test_status_hands_the_owner_windows_a_default_token_and_falls_back_to_the_bare_url(ctx, keys):
    url = ads.playback_url(ctx, {"arn": CHANNEL_ARN, "playbackUrl": PLAYBACK})
    assert "aws:ads-player-params" not in _verify(url.split("token=")[1], keys[1])
    ctx.secretsmanager = FakeSecrets(None)
    ads._cache.clear()
    assert ads.playback_url(ctx, {"arn": CHANNEL_ARN, "playbackUrl": PLAYBACK}) == PLAYBACK


def test_no_aws_call_without_a_real_client():
    """Unit-test contexts (fake clients, no secretsmanager) never build a boto3 client."""
    ads._cache.clear()
    c = make_ctx(table=FakeTable(), s3=FakeS3(), ivs=FakeIvs())
    assert ads.playback_url(c, {"arn": CHANNEL_ARN, "playbackUrl": PLAYBACK}) == PLAYBACK


# ── personas ───────────────────────────────────────────────────────────────────

def test_three_personas_are_seeded_once_in_dynamodb(ctx):
    first = ads.personas(ctx)
    assert [p["personaId"] for p in first] == ["action", "racer", "explorer"]
    assert {p["name"] for p in first} == {"액션 마니아", "레이서", "도시 탐험가"}
    assert all(p["genre"] and p["profile"] and p["affinity"] for p in first)
    ads._cache.clear()
    ctx.table.items[("PERSONAS", "PERSONA#racer")]["name"] = "레이서 (수정)"  # an edit in the table is kept
    assert [p["name"] for p in ads.personas(ctx)][1] == "레이서 (수정)"
    assert len([k for k in ctx.table.items if k[0] == "PERSONAS"]) == 3


def _trailer(ctx, sid, name, title, prompt, seconds, created):
    shot = store.new_id("job")
    store.put_job(ctx, sid, {"jobId": shot, "kind": "shot", "input": {"prompt": prompt}, "createdAt": created})
    job = store.new_id("job")
    store.put_job(ctx, sid, {"jobId": job, "kind": "trailer", "input": {"title": title, "shot_job_ids": [shot]},
                             "createdAt": created})
    return store.put_asset(ctx, sid, {"kind": "trailer", "key": f"sessions/{sid}/{name}.mp4", "contentType": "video/mp4",
                                      "meta": {"seconds": seconds}, "jobId": job, "createdAt": created})


def _session(ctx):
    s = store.put_session(ctx, "user-1", "t", "rpg-quest")
    store.put_game(ctx, s["sessionId"], {"gameId": "gm_1", "title": "G", "genre": "rpg-quest", "specKey": "k",
                                         "previewUrl": "x"})
    return s


def _three_trailers(ctx, s):
    sid = s["sessionId"]
    _trailer(ctx, sid, "boss", "보스 레이드", "a knight fights a giant boss, sword combat", 30.0, "2026-11-08T01:00:00.000Z")
    _trailer(ctx, sid, "race", "네온 드리프트", "a car drifts through a race at night, speed", 20.0, "2026-11-08T02:00:00.000Z")
    _trailer(ctx, sid, "city", "도시의 밤", "walking an open world city street, skyline", 15.0, "2026-11-08T03:00:00.000Z")


def test_vast_has_a_stable_creative_id_and_a_real_impression_beacon(ctx):
    beacon = ads.beacon(ctx, "b_1", "racer", "cr_abc")
    assert beacon == "https://d1.cloudfront.net/api/ads/impression?b=b_1&p=racer&c=cr_abc"
    doc = ET.fromstring(ads.vast("A & B", "https://cdn/t.mp4", 24.54, "cr_abc", beacon))
    assert doc.find(".//Duration").text == "00:00:24.540" and doc.find(".//AdTitle").text == "A & B"
    assert doc.find(".//Creative").get("id") == "cr_abc" and doc.find(".//Ad").get("id") == "cr_abc"
    assert doc.find(".//Impression").text == beacon
    assert ads.creative_id("https://cdn/t.mp4") == ads.creative_id("https://cdn/t.mp4") != ads.creative_id("https://cdn/u.mp4")
    no_cdn = make_ctx(cdn_domain="")
    assert ads.beacon(no_cdn, "b_1", "", "cr") is None
    assert ET.fromstring(ads.vast("t", "https://cdn/t.mp4", 5, "cr", None)).find(".//Impression") is None


# ── the broadcast: one break, one VAST per persona ───────────────────────────

def _vast(ctx, persona):
    doc = ET.fromstring(ctx.s3._store[("live-b", ads.vast_key(persona))])
    return {"url": doc.find(".//MediaFile").text, "title": doc.find(".//AdTitle").text,
            "creative": doc.find(".//Creative").get("id"), "beacon": doc.find(".//Impression").text}


def _job(ctx):
    return json.loads(ctx.s3._store[("live-b", "broadcaster/job.json")])


def _warm_all(ctx, s, clock):
    """A viewer watches until every planned creative had its warm-up and MediaTailor transcoded it."""
    for _ in range(10):
        clock.t = max(clock.t, _job(ctx).get("breakUntil", 0)) + 1
        if not live.viewer(ctx, s)["warmed"]:
            break
    clock.t = max(clock.t, _job(ctx).get("breakUntil", 0)) + live.TRANSCODE_SEC + 1


def test_a_linear_highlight_break_goes_to_every_persona(ctx, clock):
    s = _session(ctx)
    _trailer(ctx, s["sessionId"], "boss", "보스 레이드", "boss fight", 30.0, "2026-11-08T01:00:00.000Z")
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 5})
    live._break(ctx, _job(ctx), "명장면", "https://cdn/hl.mp4", 5, "hl_1")
    assert {_vast(ctx, p)["url"] for p in ("", "action", "racer", "explorer")} == {"https://cdn/hl.mp4"}
    with pytest.raises(live.LiveError) as busy:  # the files still serve that break's ad requests
        live._break(ctx, _job(ctx), "다른", "https://cdn/hl2.mp4", 5, "hl_2")
    assert busy.value.code == "ad_busy"


def test_round_ends_are_logged_to_the_session_with_their_reason(ctx, clock):
    s = _session(ctx)
    _trailer(ctx, s["sessionId"], "boss", "보스 레이드", "boss fight", 30.0, "2026-11-08T01:00:00.000Z")
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 5})
    live.round_done(ctx, s, {"rounds": 1, "reason": "died", "won": False})
    live.round_done(ctx, s, {"rounds": 2})
    live.round_done(ctx, s, {"rounds": 2})  # reported twice: one record
    events = sorted((k[1], v) for k, v in ctx.table.items.items() if k[0] == f"SESSION#{s['sessionId']}"
                    and k[1].startswith("EVENT#"))
    assert len(events) == 2
    first, second = store.plain(events[0][1]), store.plain(events[1][1])
    assert (first["type"], first["rounds"], first["reason"], first["won"]) == ("round_end", 1, "died", False)
    assert second["rounds"] == 2 and "reason" not in second and first["jobId"] == _job(ctx)["jobId"]
    assert "events" not in store.snapshot(ctx, s["sessionId"])  # the studio snapshot is unchanged


# ── HTTP: personas, tokens (signed in), the impression beacon (public) ────────

TOKEN = "good-token"


@pytest.fixture
def api(ctx, monkeypatch):
    ctx.cognito = FakeCognito({TOKEN: ("user-1", "demo")})
    monkeypatch.setattr(app, "CTX", ctx)
    monkeypatch.setattr(auth, "_CACHE", {})
    return ctx


def call(method, path, body=None, token=TOKEN, query=None):
    event = {"requestContext": {"http": {"method": method}}, "rawPath": path,
             "headers": {"x-auth-token": token} if token else {}, "isBase64Encoded": False,
             "body": None if body is None else json.dumps(body),
             **({"queryStringParameters": query} if query is not None else {})}
    resp = app.handler(event, None)
    return resp["statusCode"], json.loads(resp["body"])


def test_routes_list_personas_and_sign_a_token_for_signed_in_users_only(api, keys):
    status, body = call("GET", "/api/live/personas")
    assert status == 200 and [p["personaId"] for p in body["personas"]] == ["action", "racer", "explorer"]
    # a token is the account's whose broadcast is on air (test_round20_channel_owner.py)
    assert call("POST", "/api/live/token", {"persona": "explorer"})[0] == 409
    s = _session(api)
    _three_trailers(api, s)
    live.start(api, s, {"gameId": "gm_1", "everyRounds": 5})
    status, body = call("POST", "/api/live/token", {"persona": "explorer"})
    assert status == 200
    assert _verify(body["playbackUrl"].split("token=")[1], keys[1])["aws:ads-player-params"] == {"persona": "explorer"}
    assert call("POST", "/api/live/token", {"persona": "x"})[0] == 400
    assert call("POST", "/api/live/token", {"persona": "racer"}, token=None)[0] == 401
    assert call("GET", "/api/live/personas", token=None)[0] == 401


def test_the_impression_beacon_is_public_and_logs_persona_break_and_creative(api):
    status, _ = call("GET", "/api/ads/impression", token=None, query={"b": "b_1", "p": "racer", "c": "cr_abc"})
    assert status == 200
    call("GET", "/api/ads/impression", token=None, query={"b": "b_1", "c": "cr_abc"})  # the default persona
    items = [store.plain(v) for k, v in api.table.items.items() if k[0] == "ADBREAK#b_1"]
    assert sorted((i["persona"], i["creative"]) for i in items) == [("", "cr_abc"), ("racer", "cr_abc")]
    assert call("GET", "/api/ads/impression", token=None, query={"b": "<x>", "c": "cr"})[0] == 400
    assert call("GET", "/api/ads/ad_nope", token=None)[0] == 404  # the playable namespace answers on its own
