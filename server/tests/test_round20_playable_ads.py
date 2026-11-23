"""Playable ad records (AD#<adId>): an ad whose game is gone answers 404 in Korean and starts no paid stream;
delete_session takes the session's ads, leaving one small record that says the ad is gone (test_round21_ad_gone.py);
a playable broadcast reuses one ad per game and trial length. Fakes only. Named without "live" so
`pytest -k 'not live'` runs it."""
import json

import pytest

from server import app, auth, live, playable, store
from server.tests.conftest import FakeCognito
from server.tests.test_live import clock, ctx  # noqa: F401 — the live fixture: IVS, GameLift Streams, S3, the table

TOKEN = "good-token"
GONE = "이 광고의 게임이 삭제됐어요"


@pytest.fixture
def api(ctx, monkeypatch):  # noqa: F811
    ctx.cognito = FakeCognito({TOKEN: ("user-1", "demo")})
    monkeypatch.setattr(app, "CTX", ctx)
    monkeypatch.setattr(auth, "_CACHE", {})
    monkeypatch.setenv("SELF_FUNCTION_NAME", "ipverse-api")
    return ctx


def call(method, path, body=None, token=TOKEN):
    event = {"requestContext": {"http": {"method": method}}, "rawPath": path,
             "headers": {"x-auth-token": token} if token else {}, "isBase64Encoded": False,
             "body": None if body is None else json.dumps(body)}
    resp = app.handler(event, None)
    return resp["statusCode"], json.loads(resp["body"])


def _studio(ctx, game_id="gm_1", title="루나의 궤도 탈출", published=False):  # noqa: F811
    s = store.put_session(ctx, "user-1", "t", "sf-shooter")
    url = store.public_url(ctx, f"games/{game_id}/index.html")
    store.put_game(ctx, s["sessionId"], {"gameId": game_id, "title": title, "genre": "sf-shooter", "specKey": "k",
                                         "previewUrl": url, **({"publishedUrl": url} if published else {})})
    ctx.s3._store[(ctx.assets_bucket, f"games/{game_id}/index.html")] = b"<html>"
    ctx.s3._store[(ctx.assets_bucket, f"games/{game_id}/runtime3d.js")] = b"const standby = query.get('standby');"
    return s


def _ad_rows(ctx, ad_id=None):  # noqa: F811
    return sorted(k for k in ctx.table.items if k[0].startswith("AD#") and (ad_id is None or k[0] == f"AD#{ad_id}"))


def _buried(ctx, ad_id):  # noqa: F811
    """True when one row is left under the ad's key and it says only that the ad is gone (store.bury_ad)."""
    rows = _ad_rows(ctx, ad_id)
    left = {k for k in ctx.table.items[(f"AD#{ad_id}", "META")] if k not in ("pk", "sk")} if rows else set()
    return rows == [(f"AD#{ad_id}", "META")] and left == {"adId", "gone", "goneAt"}


# ── an ad whose game is gone ─────────────────────────────────────────────────────

def test_after_the_session_is_deleted_its_ad_link_answers_404_and_starts_nothing(api):
    s = _studio(api)
    sid = s["sessionId"]
    status, ad = call("POST", f"/api/sessions/{sid}/playable-ads", {"gameId": "gm_1", "seconds": 60})
    assert status == 201
    assert call("GET", f"/api/ads/{ad['adId']}", token=None)[0] == 200

    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200

    assert _buried(api, ad["adId"])  # the delete took what the session's ads held
    status, body = call("GET", f"/api/ads/{ad['adId']}", token=None)
    assert status == 404 and body["message"] == GONE
    status, body = call("POST", f"/api/ads/{ad['adId']}/stream", {"signalRequest": "offer"}, token=None)
    assert status == 404 and api.gls.sessions == []  # no paid session on a page that is gone


def test_an_ad_made_before_this_round_is_refused_and_dropped_at_its_first_visit(api):
    """A record with no pointer under its session is not found by the delete: its first visit says the game is gone,
    starts nothing, and removes what the record held."""
    s = _studio(api)
    sid = s["sessionId"]
    ad_id = "ad_0123456789ab"
    store._put(api, f"AD#{ad_id}", "META", {"adId": ad_id, "sessionId": sid, "gameId": "gm_1", "title": "루나", "seconds": 90,
                                           "trailerUrl": None, "ctaUrl": "x", "gameUrl": "x", "plays": 3})
    store._put(api, f"AD#{ad_id}", "START#st_0123456789ab", {"state": "ended"})
    assert call("GET", f"/api/ads/{ad_id}", token=None)[0] == 200
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200
    assert _ad_rows(api, ad_id)  # no pointer under the session: the delete could not know it

    status, body = call("POST", f"/api/ads/{ad_id}/stream", {"signalRequest": "offer"}, token=None)
    assert (status, body["error"], body["message"]) == (404, "ad_gone", GONE) and api.gls.sessions == []
    assert _buried(api, ad_id)  # what it held went with the answer
    status, body = call("GET", f"/api/ads/{ad_id}", token=None)
    assert (status, body["error"], body["message"]) == (404, "ad_gone", GONE)  # the same at every later visit


def test_an_ad_whose_game_alone_is_gone_is_refused_too(api):
    s = _studio(api)
    ad = playable.create(api, s, {"gameId": "gm_1", "seconds": 30})
    del api.table.items[(f"SESSION#{s['sessionId']}", "GAME#gm_1")]
    status, body = call("GET", f"/api/ads/{ad['adId']}", token=None)
    assert (status, body["error"], body["message"]) == (404, "ad_gone", GONE)


def test_a_trial_that_is_running_can_still_be_polled_and_ended_while_its_record_is_there(api):
    """Only a new start is refused: the page's poll and stop still reach the stream, so the seat is given back."""
    s = _studio(api)
    ad = playable.create(api, s, {"gameId": "gm_1", "seconds": 30})
    status, started = call("POST", f"/api/ads/{ad['adId']}/stream", {"signalRequest": "offer"}, token=None)
    assert status == 202
    del api.table.items[(f"SESSION#{s['sessionId']}", "GAME#gm_1")]
    assert call("GET", f"/api/ads/{ad['adId']}/stream/{started['streamId']}", token=None)[0] == 200
    ended = []
    api.gls.terminate_stream_session = lambda **kw: ended.append(kw["StreamSessionIdentifier"])
    assert call("DELETE", f"/api/ads/{ad['adId']}/stream/{started['streamId']}", token=None)[0] == 200
    assert ended == [started["streamId"]]


# ── delete_session ───────────────────────────────────────────────────────────────

def test_the_delete_takes_the_sessions_ads_with_their_start_rows_and_leaves_other_sessions_ads(api):
    mine, other = _studio(api), _studio(api, "gm_2", "남는 게임")
    a = playable.create(api, mine, {"gameId": "gm_1", "seconds": 30})["adId"]
    b = playable.for_game(api, mine["sessionId"], "gm_1", 90)["adId"]  # a live viewer's pick of this game
    kept = playable.create(api, other, {"gameId": "gm_2", "seconds": 30})["adId"]
    store._put(api, f"AD#{a}", "START#st_aaaaaaaaaaaa", {"state": "ended"})  # playable.stop's row of a named start

    assert call("DELETE", f"/api/sessions/{mine['sessionId']}")[0] == 200

    assert _buried(api, a) and _buried(api, b)  # (the START row of `a` went)
    assert _ad_rows(api, kept) == [(f"AD#{kept}", "META")]
    assert call("GET", f"/api/ads/{kept}", token=None)[0] == 200
    assert [k for k in api.table.items if k[0] == f"SESSION#{mine['sessionId']}"] == []


def test_a_delete_that_died_after_the_ads_is_finished_by_the_next_one(api, monkeypatch):
    s = _studio(api)
    ad = playable.create(api, s, {"gameId": "gm_1", "seconds": 30})["adId"]
    real, died = api.table.delete_item, []

    def flaky(Key, **kw):
        if Key["pk"].startswith("SESSION#") and not died:
            died.append(Key["sk"])
            raise RuntimeError("timeout")
        return real(Key=Key, **kw)
    monkeypatch.setattr(api.table, "delete_item", flaky)
    assert call("DELETE", f"/api/sessions/{s['sessionId']}")[0] == 500
    assert _buried(api, ad) and store.get_session(api, s["sessionId"]) is not None
    assert call("DELETE", f"/api/sessions/{s['sessionId']}")[0] == 200


# ── one ad per game and trial length ─────────────────────────────────────────────

def test_a_playable_broadcast_reuses_the_games_ad_instead_of_writing_a_new_one_each_start(ctx):  # noqa: F811
    s = _studio(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable", "playableSeconds": 60})
    first = json.loads(ctx.s3._store[("live-b", "broadcaster/job.json")])
    live.stop(ctx, s)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable", "playableSeconds": 60})
    again = json.loads(ctx.s3._store[("live-b", "broadcaster/job.json")])
    assert again["jobId"] != first["jobId"] and again["playableAdId"] == first["playableAdId"]
    assert again["playUrl"] == first["playUrl"] == f"https://cdn.example/#ad={first['playableAdId']}"
    assert _ad_rows(ctx) == [(f"AD#{first['playableAdId']}", "META")]
    # the ad a viewer's pick of the same game uses is that one too: its plays add up in one place
    assert playable.for_game(ctx, s["sessionId"], "gm_1", 60)["adId"] == first["playableAdId"]
    live.ad_settings(ctx, s, {"adType": "playable", "everyRounds": 1, "playableSeconds": 90})  # another trial length
    longer = json.loads(ctx.s3._store[("live-b", "broadcaster/job.json")])["playableAdId"]
    assert longer != first["playableAdId"] and len(_ad_rows(ctx)) == 2


def test_the_reused_ad_keeps_its_plays_and_shows_the_game_as_it_is_now(ctx):  # noqa: F811
    s = _studio(ctx)
    sid = s["sessionId"]
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable", "playableSeconds": 60})
    ad_id = json.loads(ctx.s3._store[("live-b", "broadcaster/job.json")])["playableAdId"]
    playable.start(ctx, ad_id, {"signalRequest": "sdp"})  # a visitor of the public link plays it
    before = playable.get(ctx, ad_id)
    assert before["plays"] == 1 and before["trailerUrl"] is None and before["ctaUrl"].endswith("/games/gm_1/index.html")
    live.stop(ctx, s)
    # since then: the game was published under its share address and the session got a trailer
    store.update_game(ctx, sid, "gm_1", publishedUrl="https://cdn.example.com/games/gm_1/index.html?shared=1", title="새 제목")
    trailer = store.put_asset(ctx, sid, {"kind": "trailer", "key": f"sessions/{sid}/t.mp4", "contentType": "video/mp4",
                                        "meta": {"seconds": 12}})
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable", "playableSeconds": 60})
    after = playable.get(ctx, ad_id)
    assert (after["plays"], after["createdAt"]) == (1, before["createdAt"])
    assert (after["title"], after["trailerUrl"]) == ("새 제목", trailer["url"]) and after["ctaUrl"].endswith("?shared=1")


def test_a_viewers_pick_never_offers_a_game_that_was_deleted(ctx):  # noqa: F811
    """for_game raises for a game that is gone; the caller (live._playable_picks) falls back to the broadcast's game."""
    s = _studio(ctx)
    ad = playable.for_game(ctx, s["sessionId"], "gm_1", 60)
    assert playable.for_game(ctx, s["sessionId"], "gm_1", 60)["adId"] == ad["adId"]
    del ctx.table.items[(f"SESSION#{s['sessionId']}", "GAME#gm_1")]
    with pytest.raises(playable.AdError):
        playable.for_game(ctx, s["sessionId"], "gm_1", 60)


def test_a_trial_length_out_of_range_is_refused_at_the_start_in_korean_and_writes_no_ad(api):
    """An AdError at the start is a 400 with its own message, not a 500."""
    s = _studio(api)
    status, body = call("POST", f"/api/sessions/{s['sessionId']}/live",
                        {"gameId": "gm_1", "everyRounds": 1, "adType": "playable", "playableSeconds": 5})
    assert status == 400 and "30–180초" in body["message"]
    assert _ad_rows(api) == [] and ("live-b", "broadcaster/job.json") not in api.s3._store
