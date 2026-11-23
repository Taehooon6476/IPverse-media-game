"""The link of a playable ad whose game was deleted says so at every visit: everything the ad held goes, and a small
record stays in its place so the address is not mistaken for one that never was an ad."""
from server import playable, store
from server.tests.test_live import clock, ctx  # noqa: F401 — the live fixture: IVS, GameLift Streams, S3, the table
from server.tests.test_round20_errors import plain
from server.tests.test_round20_playable_ads import GONE, _ad_rows, _studio, api, call  # noqa: F401

NOT_AN_AD = "광고를 찾지 못했어요. 주소를 다시 확인해 주세요."


def _visits(ad_id, n=3):
    """The public page's first request, n times → [(status, error, message)]."""
    seen = []
    for _ in range(n):
        status, body = call("GET", f"/api/ads/{ad_id}", token=None)
        seen.append((status, body["error"], body["message"]))
    return seen


def _record(ctx, ad_id):  # noqa: F811
    return {k: v for k, v in ctx.table.items[(f"AD#{ad_id}", "META")].items() if k not in ("pk", "sk")}


def test_the_ad_of_a_deleted_session_says_it_was_deleted_at_every_visit(api):  # noqa: F811
    s = _studio(api)
    status, ad = call("POST", f"/api/sessions/{s['sessionId']}/playable-ads", {"gameId": "gm_1", "seconds": 60})
    assert status == 201 and call("GET", f"/api/ads/{ad['adId']}", token=None)[0] == 200

    assert call("DELETE", f"/api/sessions/{s['sessionId']}")[0] == 200

    assert _visits(ad["adId"]) == [(404, "ad_gone", GONE)] * 3 and plain(GONE + ".")
    status, body = call("POST", f"/api/ads/{ad['adId']}/stream", {"signalRequest": "offer"}, token=None)
    assert (status, body["error"], body["message"]) == (404, "ad_gone", GONE) and api.gls.sessions == []  # nothing paid


def test_what_stays_of_a_deleted_ad_holds_nothing_of_the_game(api):  # noqa: F811
    """One small record under the ad's own key: no title, no address, no session, no play count, no start rows."""
    s = _studio(api)
    ad = playable.create(api, s, {"gameId": "gm_1", "seconds": 30})["adId"]
    store._put(api, f"AD#{ad}", "START#st_aaaaaaaaaaaa", {"state": "ended"})
    assert call("DELETE", f"/api/sessions/{s['sessionId']}")[0] == 200
    assert _ad_rows(api, ad) == [(f"AD#{ad}", "META")]
    left = _record(api, ad)
    assert set(left) == {"adId", "gone", "goneAt"} and left["adId"] == ad and left["gone"] is True
    assert [k for k in api.table.items if k[0] == f"SESSION#{s['sessionId']}"] == []  # the session's pointer went too


def test_an_ad_whose_game_alone_is_gone_says_so_at_every_visit(api):  # noqa: F811
    """An ad the session holds no pointer to, or a game removed by itself: the first visit finds the game gone."""
    s = _studio(api)
    ad = playable.create(api, s, {"gameId": "gm_1", "seconds": 30})["adId"]
    del api.table.items[(f"SESSION#{s['sessionId']}", "GAME#gm_1")]
    assert _visits(ad) == [(404, "ad_gone", GONE)] * 3
    assert set(_record(api, ad)) == {"adId", "gone", "goneAt"}


def test_an_address_that_never_was_an_ad_still_says_to_check_it(api):  # noqa: F811
    assert _visits("ad_0123456789ab", 2) == [(404, "not_found", NOT_AN_AD)] * 2  # well formed, never made
    status, body = call("GET", "/api/ads/ad_3a67", token=None)
    assert (status, body["message"]) == (404, NOT_AN_AD)
    assert _ad_rows(api) == []  # asking leaves nothing behind


def test_a_trial_of_a_deleted_ad_is_told_the_same(api):  # noqa: F811
    s = _studio(api)
    ad = playable.create(api, s, {"gameId": "gm_1", "seconds": 30})["adId"]
    assert call("DELETE", f"/api/sessions/{s['sessionId']}")[0] == 200
    for method, path in (("GET", f"/api/ads/{ad}/stream/s-1"), ("DELETE", f"/api/ads/{ad}/stream/s-1"),
                         ("POST", f"/api/ads/{ad}/stream/s-1/play")):
        status, body = call(method, path, {} if method == "POST" else None, token=None)
        assert (status, body["error"], body["message"]) == (404, "ad_gone", GONE), (method, path)


def test_a_game_that_takes_a_buried_ads_id_gets_a_record_of_its_own(api):  # noqa: F811
    """A game's own ad has one id per game and trial length (for_game): a new ad on a buried id must not read as
    deleted."""
    s = _studio(api)
    ad = playable.for_game(api, s["sessionId"], "gm_1", 90)["adId"]
    store.bury_ad(api, ad)
    assert _visits(ad, 1) == [(404, "ad_gone", GONE)]
    again = playable.for_game(api, s["sessionId"], "gm_1", 90)
    assert again["adId"] == ad and "gone" not in again and again["plays"] == 0
    assert call("GET", f"/api/ads/{ad}", token=None)[0] == 200


def test_a_delete_that_died_part_way_leaves_ads_that_already_say_so(api, monkeypatch):  # noqa: F811
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
    assert _visits(ad, 1) == [(404, "ad_gone", GONE)]
    assert call("DELETE", f"/api/sessions/{s['sessionId']}")[0] == 200  # finished by the next one
    assert _visits(ad, 2) == [(404, "ad_gone", GONE)] * 2
