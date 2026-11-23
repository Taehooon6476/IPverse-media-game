"""Deleting a session leaves one small page at each published game's address ("이 게임은 삭제됐어요", a link to the
studio) and removes the rest: the bucket behind the origin access control would answer a missing key with a raw 403.
Fakes only."""
import re

import pytest

from server import store
from server.tests.test_app import call, ctx  # noqa: F401 — the app fixture
from server.tests.test_session_delete import BUCKET, DIST, HIT, MISS, GONE, PARAM, FakeCloudFront, FakeSsm

GAME_FILES = ("index.html", "spec.json", "release.json", "runtime3d.js", "ui.css", "assets/ip_1.glb")


@pytest.fixture
def edge(ctx, monkeypatch):  # noqa: F811
    monkeypatch.setenv("CDN_DISTRIBUTION_PARAM", PARAM)
    monkeypatch.setattr(store, "_distribution", {})
    ctx.ssm, ctx.cloudfront = FakeSsm({PARAM: DIST}), FakeCloudFront(ctx.s3)
    return ctx.cloudfront


def _session():
    status, data = call("POST", "/api/sessions", {"title": "지울 세션"})
    assert status == 201
    return data["session"]["sessionId"]


def _game(ctx, sid, game_id, published):  # noqa: F811
    url = store.public_url(ctx, f"games/{game_id}/index.html")
    store.put_game(ctx, sid, {"gameId": game_id, "title": "루나의 궤도 탈출", "previewUrl": url,
                              **({"publishedUrl": url, "publishedAt": store.now()} if published else {})})
    for name in GAME_FILES:
        ctx.s3.put_object(Bucket=BUCKET, Key=f"games/{game_id}/{name}", Body=b"the game")


def _folder(ctx, game_id):  # noqa: F811
    return sorted(k for (b, k) in ctx.s3._store if b == BUCKET and k.startswith(f"games/{game_id}/"))


def test_a_deleted_sessions_published_game_keeps_one_page_that_says_so(ctx):  # noqa: F811
    sid = _session()
    _game(ctx, sid, "gm_pub", published=True)
    _game(ctx, sid, "gm_draft", published=False)

    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200

    assert _folder(ctx, "gm_pub") == ["games/gm_pub/index.html"]  # the page alone: the game's files are gone
    assert _folder(ctx, "gm_draft") == []  # a game that was never shared leaves nothing
    page = ctx.s3._store[(BUCKET, "games/gm_pub/index.html")].decode("utf-8")
    assert page == store.TOMBSTONE and "이 게임은 삭제됐어요" in page
    assert re.search(r'<a href="/"[^>]*>[^<]*IPverse Studio[^<]*</a>', page)  # the way to the studio, on this CDN
    sent = ctx.s3.put_kwargs[(BUCKET, "games/gm_pub/index.html")]
    assert sent == {"ContentType": "text/html; charset=utf-8", "CacheControl": "no-cache"}
    assert call("GET", f"/api/sessions/{sid}")[0] == 404


def test_the_page_is_whole_by_itself_and_reads_as_korean():
    page = store.TOMBSTONE
    assert page.startswith("<!doctype html>") and '<html lang="ko">' in page and '<meta charset="utf-8">' in page
    assert 'name="viewport"' in page and "<title>" in page
    # nothing to fetch: the folder's stylesheet and scripts are gone, and no other host is asked
    assert not re.search(r"<script|<link|<img|src=|url\(|https?://", page)
    assert "noindex" in page  # a deleted game's address is not for search results
    assert len(page.encode("utf-8")) < 2048
    for internal in ("S3", "AccessDenied", "session", "세션", "403", "404"):
        assert internal not in page


def test_the_share_link_answers_the_page_from_the_edge_after_the_delete(ctx, edge):  # noqa: F811
    """The delete's invalidation names the game's folder, so the edge serves the tombstone and the other files as gone."""
    sid = _session()
    _game(ctx, sid, "gm_pub", published=True)
    seen = ["/games/gm_pub/index.html", "/games/gm_pub/spec.json", "/games/gm_pub/assets/ip_1.glb"]
    assert [edge.get(p) for p in seen] == [MISS] * 3 and edge.get(seen[0]) == HIT

    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200

    assert edge.get("/games/gm_pub/index.html") == MISS  # fetched again from the bucket: the tombstone
    assert [edge.get(p) for p in seen[1:]] == [GONE, GONE]
    assert [batch["paths"] for batch in edge.batches] == [[f"/sessions/{sid}/*", "/games/gm_pub/*"]]


def test_a_delete_that_died_part_way_leaves_the_page_once_it_is_finished(ctx, monkeypatch):  # noqa: F811
    sid = _session()
    _game(ctx, sid, "gm_pub", published=True)
    real, died = ctx.s3.list_objects_v2, []

    def flaky(**kw):
        if kw["Prefix"] == f"sessions/{sid}/" and not died:
            died.append(kw["Prefix"])
            raise RuntimeError("SlowDown")
        return real(**kw)

    monkeypatch.setattr(ctx.s3, "list_objects_v2", flaky)
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 500
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200  # the game item was still there to name the folder
    assert _folder(ctx, "gm_pub") == ["games/gm_pub/index.html"]
    assert ctx.s3._store[(BUCKET, "games/gm_pub/index.html")].decode("utf-8") == store.TOMBSTONE


def test_another_sessions_published_game_is_untouched(ctx):  # noqa: F811
    sid, keep = _session(), _session()
    _game(ctx, sid, "gm_pub", published=True)
    _game(ctx, keep, "gm_keep", published=True)
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200
    assert _folder(ctx, "gm_keep") == sorted(f"games/gm_keep/{name}" for name in GAME_FILES)
    assert ctx.s3._store[(BUCKET, "games/gm_keep/index.html")] == b"the game"
