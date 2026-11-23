"""DELETE /api/sessions/{id}/publish/{gameId} takes a game out of the published state: no address and no ad on its
item, release.json as make_game first wrote it. The game's folder stays, since the studio's preview plays the same
files."""
import json

from server import store
from server.tests.test_app import _new_session, call, ctx  # noqa: F401 — ctx is the fixture

GAME = {"gameId": "gm_1", "title": "달빛 숲의 별조각", "genre": "rpg-quest", "specKey": "games/gm_1/spec.json",
        "previewUrl": "https://cdn.example.com/games/gm_1/index.html"}


def _published(ctx, sid):  # noqa: F811
    store.put_game(ctx, sid, dict(GAME))
    ad = store.put_asset(ctx, sid, {"kind": "trailer", "key": "sessions/s/t.mp4", "contentType": "video/mp4"})
    status, data = call("POST", f"/api/sessions/{sid}/publish",
                        {"gameId": "gm_1", "adAssetId": ad["assetId"], "skipAfterSec": 3, "adEveryRounds": 2})
    assert (status, data) == (200, {"publishedUrl": GAME["previewUrl"]})
    return ad


def _game(ctx, sid):  # noqa: F811
    [game] = store.snapshot(ctx, sid)["games"]
    return game


def test_unpublish_clears_the_address_and_the_ad(ctx):  # noqa: F811
    sid = _new_session()
    ad = _published(ctx, sid)
    game = _game(ctx, sid)
    assert game["publishedUrl"] == GAME["previewUrl"] and game["adAssetId"] == ad["assetId"] and game["publishedAt"]
    assert json.loads(ctx.s3._store[("test-assets", "games/gm_1/release.json")])["ad"]["everyRounds"] == 2

    assert call("DELETE", f"/api/sessions/{sid}/publish/gm_1") == (200, {"unpublished": "gm_1"})

    game = _game(ctx, sid)
    assert not game.get("publishedUrl") and not game.get("publishedAt") and not game.get("adAssetId")
    assert game["previewUrl"] == GAME["previewUrl"] and game["title"] == GAME["title"]  # the game itself stays
    # the page reads its ad from release.json: none, so the runtime plays no ad
    assert json.loads(ctx.s3._store[("test-assets", "games/gm_1/release.json")]) == {"publishedAt": None, "ad": None}
    # idempotent
    assert call("DELETE", f"/api/sessions/{sid}/publish/gm_1") == (200, {"unpublished": "gm_1"})


def test_unpublish_then_publish_again_starts_from_what_is_sent(ctx):  # noqa: F811
    sid = _new_session()
    _published(ctx, sid)
    call("DELETE", f"/api/sessions/{sid}/publish/gm_1")
    status, data = call("POST", f"/api/sessions/{sid}/publish", {"gameId": "gm_1"})  # 광고 없음
    assert (status, data) == (200, {"publishedUrl": GAME["previewUrl"]})
    assert _game(ctx, sid)["publishedUrl"] == GAME["previewUrl"] and not _game(ctx, sid).get("adAssetId")
    assert json.loads(ctx.s3._store[("test-assets", "games/gm_1/release.json")])["ad"] is None


def test_unpublish_is_the_owners_and_names_a_game_of_the_session(ctx):  # noqa: F811
    sid = _new_session()
    _published(ctx, sid)
    status, data = call("DELETE", f"/api/sessions/{sid}/publish/gm_missing")
    assert status == 404 and data["error"] == "not_found"
    assert data["message"] == "게임을 찾지 못했어요. 화면을 새로 고친 뒤 다시 해 주세요."
    assert call("DELETE", f"/api/sessions/{sid}/publish/gm_1", token="other-token")[0] == 404  # not the owner's session
    assert call("DELETE", f"/api/sessions/{sid}/publish/gm_1", token=None)[0] == 401
    assert _game(ctx, sid)["publishedUrl"] == GAME["previewUrl"]  # untouched by all three
