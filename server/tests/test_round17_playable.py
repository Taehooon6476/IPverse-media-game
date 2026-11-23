"""Playable launchers and trailer links: a card's hint loads its viewer's game ahead so the click only reveals it, a
waiting card frees the launcher whose page shows no card first, and a corner trailer links a published game of its
own session or nothing. Fakes only. Named without "live" so `pytest -k 'not live'` runs it."""
import json
import pathlib
import re

import pytest

from server import adserver, live, playable, store
from server.tests.test_ad_styles import (_breaks_log, _fill, _fetch, _game, _games, _launch_url, _launcher,  # noqa: F401
                                         _playable_start, _sid, ctx)
from server.tests.test_ads import api, call, clock, keys  # noqa: F401
from server.tests.test_viewer_ads import IDS, _owner, _trailer

ROOT = pathlib.Path(__file__).resolve().parents[2]


def _token_of(ctx, n=-1):
    return _launch_url(ctx, n).split("?t=")[1]


def _hint(s, launch_id, viewer, event_id):
    return call("POST", f"/api/sessions/{s['sessionId']}/live/launcher/{launch_id}/hint",
                {"viewerId": viewer, "eventId": event_id})


# ── 1. the click only swaps the game: hint, preload, quick poll ───────────────

def test_a_cards_hint_loads_its_viewers_game_ahead_and_the_click_opens_that_same_page(api, clock):
    ctx = api
    s = _playable_start(ctx, clock)
    got = _launcher(ctx, s)
    tok = _token_of(ctx)
    assert _fetch(tok) == (200, {"state": "wait", "next": playable.IDLE_POLL_MS, "preload": None})
    live.round_done(ctx, s, {"rounds": 1})
    eid = _breaks_log(ctx, s)[-1]["eventId"]
    status, out = _hint(s, got["launchId"], "v-junho", eid)  # junho's card is up on this page
    race = "https://d1.cloudfront.net/games/gm_race/index.html?noads=1&playable=60&standby=1"
    assert status == 200 and out["preload"] == race
    # the launcher loads it ahead and polls quickly while the card is up
    assert _fetch(tok) == (200, {"state": "wait", "next": playable.FAST_POLL_MS, "preload": race, "card": True})
    clock.t += 5
    live.play(ctx, s, {"viewerId": "v-junho", "eventId": eid, "launchId": got["launchId"]})
    status, body = _fetch(tok)
    assert status == 200 and body == {"state": "go", "url": race}  # the page it holds: the click only reveals it


def test_a_launcher_whose_page_named_its_viewer_loads_that_viewers_game_at_the_cue(api, clock):
    ctx = api
    s = _playable_start(ctx, clock)
    tok = {}
    for vid in ("v-seoyeon", None):  # a 1명 보기 window, and one that named nobody
        got = live.launcher_start(ctx, s, {"signalRequest": "offer", "standbyToken": live._token(ctx, _job_id(ctx)),
                                           **({"viewerId": vid} if vid else {})})
        tok[vid] = _token_of(ctx)
        ctx.gls.status[got["streamId"]] = "CONNECTED"
    with pytest.raises(live.LiveError) as e:
        live.launcher_start(ctx, s, {"signalRequest": "offer", "standbyToken": "x", "viewerId": "v-nobody"})
    assert e.value.status in (400, 409)
    live.round_done(ctx, s, {"rounds": 1})  # the cue: no page call needed
    sky = "https://d1.cloudfront.net/games/gm_sky/index.html?noads=1&playable=60&standby=1"
    assert _fetch(tok["v-seoyeon"]) == (200, {"state": "wait", "next": playable.FAST_POLL_MS, "preload": sky, "card": True})
    assert _fetch(tok[None])[1]["preload"] is None


def _job_id(ctx):
    return json.loads(ctx.s3._store[("live-b", live.JOB_KEY)])["jobId"]


def test_the_quick_poll_ends_with_the_card_and_a_hint_for_another_viewer_replaces_the_game(api, clock):
    ctx = api
    s = _playable_start(ctx, clock)
    got = _launcher(ctx, s)
    tok = _token_of(ctx)
    live.round_done(ctx, s, {"rounds": 1})
    eid = _breaks_log(ctx, s)[-1]["eventId"]
    _hint(s, got["launchId"], "v-junho", eid)
    # the card is long gone: the poll slows down. Its game stays loaded: junho's next card offers it again
    clock.t += playable.HINT_FAST_SEC + 1
    assert _fetch(tok)[1]["next"] == playable.IDLE_POLL_MS and "gm_race" in _fetch(tok)[1]["preload"]
    _hint(s, got["launchId"], "v-seoyeon", eid)
    assert "gm_sky" in _fetch(tok)[1]["preload"]
    live.play(ctx, s, {"viewerId": "v-minji", "eventId": eid, "launchId": got["launchId"]})  # someone else clicked
    assert "gm_boss" in _fetch(tok)[1]["url"]  # the launcher opens that game instead (engine cached)


def test_a_hint_leaves_a_launcher_already_opening_a_game_and_needs_a_real_pick(api, clock):
    ctx = api
    s = _playable_start(ctx, clock)
    got = _launcher(ctx, s)
    live.round_done(ctx, s, {"rounds": 1})
    eid = _breaks_log(ctx, s)[-1]["eventId"]
    assert _hint(s, got["launchId"], "v-junho", "nope")[0] == 404  # no such break
    assert _hint(s, "0" * 12, "v-junho", eid)[0] == 404  # no such launcher
    live.play(ctx, s, {"viewerId": "v-minji", "eventId": eid, "launchId": got["launchId"]})
    status, out = _hint(s, got["launchId"], "v-junho", eid)
    assert status == 200 and out["preload"] is None
    assert "preload" not in ctx.table.items[(f"LAUNCH#{got['launchId']}", "META")]


def test_a_waiting_card_frees_the_launcher_whose_page_shows_no_card_first(ctx, clock):
    s = _playable_start(ctx, clock)
    first = _launcher(ctx, s)  # the oldest: its page has a card up (a hint)
    _launcher(ctx, s)  # both seats are launchers now
    live.round_done(ctx, s, {"rounds": 1})
    eid = _breaks_log(ctx, s)[-1]["eventId"]
    live.launcher_hint(ctx, s, first["launchId"], {"viewerId": "v-junho", "eventId": eid})
    waiting = live.play(ctx, s, {"viewerId": "v-seoyeon", "eventId": eid})  # a third window, no launcher of its own
    assert waiting["mode"] == "queued" and ctx.gls.ended == ["s-2"]  # not the one about to be clicked
    assert ctx.table.items[(f"LAUNCH#{first['launchId']}", "META")]["state"] == "waiting"


def test_the_launcher_page_preloads_the_engine_the_games_import_and_follows_the_servers_poll():
    page = (ROOT / "server" / "launcher.html").read_text()
    imports = re.search(r'"three": "(https://cdn\.jsdelivr\.net/npm/three@[\d.]+/)build/three\.module\.js"',
                        (ROOT / "game3d" / "index.html").read_text())
    assert imports and f"'{imports.group(1)}'" in page  # the same version as the runtime's import map
    assert "'build/three.module.js'" in page and "loaders/GLTFLoader.js" in page
    assert "d.preload" in page and "d.next" in page and "iframe" in page and "location.replace(url)" in page


# ── 2. the corner trailer's 게임 보기: its own session's published game ─────────

def _dune(ctx):
    """A session with a published game casting the trailer's IPs, a newer published one without them, and an
    unpublished draft whose id sorts last."""
    s = store.put_session(ctx, "user-1", "사구의 유적", "rpg-explore")
    sid = s["sessionId"]
    store.put_ip(ctx, sid, {"ipId": "ip_kairo", "name": "카이로", "createdAt": "2026-11-01T00:00:00.000Z"})
    _game(ctx, sid, "gm_dune", "사구의 유적: 30초 생존", "rpg-explore", cast=["ip_kairo"])
    _game(ctx, sid, "gm_other", "사막 레이스", "rpg-explore")
    store.update_game(ctx, sid, "gm_other", publishedAt="2026-11-10T00:00:00.000Z")
    _game(ctx, sid, "gm_zzsky", "카이로의 하늘섬 오르기", "rpg-explore", published=False, cast=["ip_kairo"])
    _trailer(ctx, sid, "dune", "사구의 유적", "explorer in desert ruins", 20.0, "2026-11-08T07:00:00.000Z", ip="ip_kairo")
    _trailer(ctx, sid, "plain", "사막 풍경", "desert dunes at dawn", 12.0, "2026-11-08T08:00:00.000Z")
    return sid


def test_a_trailer_links_the_published_game_casting_its_ips_else_its_sessions_newest_published_else_none(ctx):
    _owner(ctx)
    _dune(ctx)
    trailers = {c["title"]: c for c in adserver.inventory(ctx, "user-1")}
    assert trailers["사구의 유적"]["gameUrl"].endswith("/games/gm_dune/index.html")  # not the draft casting 카이로 too
    assert trailers["사막 풍경"]["gameUrl"].endswith("/games/gm_other/index.html")  # no IP: the newest published
    assert trailers["좀비 생존 30"]["gameUrl"] == ""  # its session has no published game: no link


def test_every_inventory_trailer_links_a_published_game_of_its_own_session_or_nothing(ctx):
    _games(ctx)
    _dune(ctx)
    published = {}
    for sess in store.list_sessions(ctx, "user-1"):
        published[sess["sessionId"]] = {g["publishedUrl"] for g in store.snapshot(ctx, sess["sessionId"])["games"]
                                        if g.get("publishedUrl")}
    items = adserver.inventory(ctx, "user-1")
    assert len(items) >= 6
    for c in items:
        assert c["gameUrl"] == "" or c["gameUrl"] in published[c["sessionId"]], c["title"]
        if published[c["sessionId"]]:
            assert c["gameUrl"], c["title"]  # a session with a published game always links one


def test_corner_picks_carry_only_published_links_and_an_old_saved_inventory_is_read_again(ctx, clock):
    s = _owner(ctx)
    sid = _dune(ctx)
    published = {g["publishedUrl"] for g in store.snapshot(ctx, sid)["games"] if g.get("publishedUrl")}
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "corner"})
    doc = json.loads(ctx.s3._store[("live-b", live.INVENTORY_KEY)])
    assert doc["v"] == live.INVENTORY_VERSION
    for c in doc["items"]:  # a list saved by older code: the draft's link
        c["gameUrl"] = "https://d1.cloudfront.net/games/gm_zzsky/index.html"
    del doc["v"]
    ctx.s3._store[("live-b", live.INVENTORY_KEY)] = json.dumps(doc).encode()
    live.round_done(ctx, s, {"rounds": 1})
    picks = _breaks_log(ctx, s)[-1]["picks"]
    for v in IDS:
        assert "gm_zzsky" not in picks[v].get("gameUrl", ""), v
        if picks[v]["title"] in ("사구의 유적", "사막 풍경"):
            assert picks[v]["gameUrl"] in published
