"""A playable card's launcher: the next card's game is decided and loaded ahead of its cue (a load takes 7–14.5 s
on the stream host), a game that cannot hold for the first input is not loaded ahead, and a launcher start in flight
when its window closes is ended. Fakes only. Named without "live" so `pytest -k 'not live'` runs it."""
import json
import pathlib

import pytest

from server import live, playable, streams
from server.tests.test_ad_styles import _breaks_log, _fetch, _launch_url, _launcher, _playable_start, ctx  # noqa: F401
from server.tests.test_ads import api, call, clock, keys  # noqa: F401

ROOT = pathlib.Path(__file__).resolve().parents[2]
CDN = "https://d1.cloudfront.net/games"


def _url(game_id, holds=True):
    return f"{CDN}/{game_id}/index.html?noads=1&playable=60" + ("&standby=1" if holds else "")


def _job_id(ctx):
    return json.loads(ctx.s3._store[("live-b", live.JOB_KEY)])["jobId"]


def _token_of(ctx, n=-1):
    return _launch_url(ctx, n).split("?t=")[1]


def _start(ctx, s, **body):
    """A watch page's launcher (connected); → (its start answer, its page's token)."""
    got = live.launcher_start(ctx, s, {"signalRequest": "offer", "standbyToken": live._token(ctx, _job_id(ctx)), **body})
    ctx.gls.status[got["streamId"]] = "CONNECTED"
    return got, _token_of(ctx)


def _hint(s, launch_id, body):
    return call("POST", f"/api/sessions/{s['sessionId']}/live/launcher/{launch_id}/hint", body)


def _shown(ctx, s, viewer, event_id):
    """The viewer's card showed on a watch page (its impression: the frequency cap moves the next card on)."""
    live.ad_event(ctx, s, {"viewerId": viewer, "eventId": event_id, "kind": "playable", "action": "impression"})


def test_a_named_launcher_loads_its_viewers_next_game_before_the_cue(api, clock):
    ctx = api
    s = _playable_start(ctx, clock, every=2)
    _, tok = _start(ctx, s, viewerId="v-seoyeon")
    # no cue yet: the game the next card will offer this page's viewer loads now, on the slow poll
    assert _fetch(tok) == (200, {"state": "wait", "next": playable.IDLE_POLL_MS, "preload": _url("gm_sky")})
    clock.t += 35
    live.round_done(ctx, s, {"rounds": 1})  # not a cue round
    assert _fetch(tok)[1]["preload"] == _url("gm_sky")
    clock.t += 35
    live.round_done(ctx, s, {"rounds": 2})  # the cue names the same page: nothing reloads, the poll turns quick
    assert _breaks_log(ctx, s)[-1]["picks"]["v-seoyeon"]["gameId"] == "gm_sky"
    assert _fetch(tok) == (200, {"state": "wait", "next": playable.FAST_POLL_MS, "preload": _url("gm_sky"), "card": True})


def test_once_the_card_is_gone_the_launcher_holds_the_game_the_next_cue_will_offer(api, clock):
    ctx = api
    s = _playable_start(ctx, clock, every=2)
    _, tok = _start(ctx, s, viewerId="v-seoyeon")
    for n in (1, 2):
        clock.t += 35
        live.round_done(ctx, s, {"rounds": n})
    first = _breaks_log(ctx, s)[-1]
    _shown(ctx, s, "v-seoyeon", first["eventId"])
    clock.t += playable.CARD_UP_SEC - 1  # the card may still be up: its game stays
    assert _fetch(tok)[1] == {"state": "wait", "next": playable.FAST_POLL_MS, "preload": _url("gm_sky"), "card": True}
    clock.t += 2
    after = _fetch(tok)[1]
    assert after["preload"] and after["preload"] != _url("gm_sky") and "card" not in after  # her next card's game
    for n in (3, 4):
        clock.t += 35
        live.round_done(ctx, s, {"rounds": n})
    second = _breaks_log(ctx, s)[-1]
    assert second["eventId"] != first["eventId"]
    assert f"/{second['picks']['v-seoyeon']['gameId']}/" in after["preload"]  # decided ahead as the cue decided it
    assert _fetch(tok)[1] == {"state": "wait", "next": playable.FAST_POLL_MS, "preload": after["preload"], "card": True}


def test_the_next_cards_games_are_decided_once_per_ahead_sec_not_at_every_poll(api, clock, monkeypatch):
    ctx = api
    s = _playable_start(ctx, clock, every=2)
    _, tok = _start(ctx, s, viewerId="v-seoyeon")
    calls = []
    real = live.launcher_ahead
    monkeypatch.setattr(live, "launcher_ahead", lambda *a: calls.append(a[2]) or real(*a))
    for _ in range(4):  # the launcher's idle poll, every 1.5 s
        assert _fetch(tok)[1]["preload"] == _url("gm_sky")
        clock.t += playable.IDLE_POLL_MS / 1000
    assert calls == [["v-seoyeon"]]
    clock.t += playable.AHEAD_SEC
    _fetch(tok)
    assert len(calls) == 2  # the logs may have grown: asked again
    job_id = _job_id(ctx)
    assert real(ctx, "another-job", ["v-seoyeon"]) is None
    live.stop(ctx, s)
    assert real(ctx, job_id, ["v-seoyeon"]) is None  # a stopped broadcast has no next card


def test_a_grid_pages_launcher_holds_every_tiles_game_its_likely_viewers_first(api, clock):
    ctx = api
    s = _playable_start(ctx, clock, every=2)
    got, tok = _start(ctx, s, viewerId="v-junho", grid=True)
    doc = ctx.table.items[(f"LAUNCH#{tok.split('.')[0]}", "META")]
    assert doc["viewerIds"] == ["v-junho", "v-minji", "v-seoyeon", "v-hyunwoo"]  # the named one, then seed order
    others = [_url("gm_boss"), _url("gm_sky"), _url("gm_space")]
    # no round length is known yet: no word on when the next card is due (calm), so only the first game loads
    assert _fetch(tok)[1] == {"state": "wait", "next": playable.IDLE_POLL_MS, "preload": _url("gm_race"), "also": others}
    for n in (1, 2):
        clock.t += 35
        live.round_done(ctx, s, {"rounds": n})
    card = _fetch(tok)[1]  # the cue: the same four pages, and a card is up
    assert card == {"state": "wait", "next": playable.FAST_POLL_MS, "preload": _url("gm_race"), "also": others, "card": True}
    eid = _breaks_log(ctx, s)[-1]["eventId"]
    status, out = _hint(s, got["launchId"], {"viewerId": "v-junho", "eventId": eid, "grid": True})  # the page's own hint
    assert status == 200 and out["preload"] == _url("gm_race") and _fetch(tok)[1] == card
    clock.t += playable.CARD_UP_SEC + 1
    idle = _fetch(tok)[1]
    assert "card" not in idle and len([idle["preload"], *idle["also"]]) == playable.PRELOAD_MAX == 4
    # the next card is due two 35 s rounds after the last round end: 70 - 31 s from now
    assert idle["calm"] == pytest.approx(70 - playable.CARD_UP_SEC - 1, abs=1)
    clock.t += 35
    live.round_done(ctx, s, {"rounds": 3})
    clock.t += playable.AHEAD_SEC
    assert _fetch(tok)[1]["calm"] == pytest.approx(35 - playable.AHEAD_SEC, abs=1)  # one round to go
    clock.t += 60  # the round runs longer than the last ones: the card may come any moment
    assert "calm" not in _fetch(tok)[1]


def test_the_next_card_is_due_at_the_next_cue_rounds_end_by_the_shortest_recent_round(clock):
    job = {"everyRounds": 2, "roundBase": 0, "roundsDone": 2, "roundEndAt": clock.t - 10, "roundDurs": [41.0, 35.0]}
    assert live._card_due_in(job) == pytest.approx(2 * 35 - 10)  # rounds 3 and 4 are still to come
    assert live._card_due_in({**job, "roundsDone": 3}) == pytest.approx(35 - 10)
    assert live._card_due_in({**job, "playableDue": 2}) == pytest.approx(35 - 10)  # a held card goes at the next round end
    assert live._card_due_in({**job, "roundDurs": []}) is None  # one round end is no round length
    assert live._card_due_in({"everyRounds": 2}) is None


def test_a_page_names_its_viewers_after_its_launcher_started_and_a_card_hint_brings_its_tiles(api, clock):
    ctx = api
    s = _playable_start(ctx, clock, every=2)
    got, tok = _start(ctx, s)  # its viewer list had not loaded yet: nobody named
    assert _fetch(tok)[1]["preload"] is None
    status, out = _hint(s, got["launchId"], {"viewerId": "v-hyunwoo"})  # 1명 보기: one viewer
    assert status == 200 and out == {"launchId": got["launchId"], "preload": None}
    assert _fetch(tok)[1] == {"state": "wait", "next": playable.IDLE_POLL_MS, "preload": _url("gm_space")}
    _hint(s, got["launchId"], {"viewerId": "v-minji", "grid": True})  # switched to the grid
    assert _fetch(tok)[1]["also"] == [_url("gm_race"), _url("gm_sky"), _url("gm_space")]
    assert _hint(s, got["launchId"], {"viewerId": "v-nobody"})[0] == 400
    for n in (1, 2):
        clock.t += 35
        live.round_done(ctx, s, {"rounds": n})
    eid = _breaks_log(ctx, s)[-1]["eventId"]
    clock.t += 4
    status, out = _hint(s, got["launchId"], {"viewerId": "v-seoyeon", "eventId": eid})  # back to 1명 보기, her card is up
    assert status == 200 and out["preload"] == _url("gm_sky")
    assert _fetch(tok)[1] == {"state": "wait", "next": playable.FAST_POLL_MS, "preload": _url("gm_sky"), "card": True}
    # the card went up at its cue, not at the page's hint: it is gone CARD_UP_SEC after the cue
    clock.t += playable.CARD_UP_SEC - 4
    assert "card" not in _fetch(tok)[1]


def test_a_game_that_cannot_hold_for_the_first_input_is_not_loaded_ahead(api, clock):
    ctx = api
    s = _playable_start(ctx, clock)
    # junho's pick keeps an older runtime copy (no "standby"): its round starts on load
    ctx.s3._store[(ctx.assets_bucket, "games/gm_race/runtime3d.js")] = b"const autoplay = query.get('autoplay') === '1';"
    got, tok = _start(ctx, s, viewerId="v-junho")
    assert _fetch(tok)[1]["preload"] is None  # not ahead of the cue
    live.round_done(ctx, s, {"rounds": 1})  # nor at the cue
    eid = _breaks_log(ctx, s)[-1]["eventId"]
    assert _breaks_log(ctx, s)[-1]["picks"]["v-junho"]["gameId"] == "gm_race"
    assert _fetch(tok)[1]["preload"] is None
    assert _fetch(tok) == (200, {"state": "wait", "next": playable.FAST_POLL_MS, "preload": None, "card": True})
    status, out = _hint(s, got["launchId"], {"viewerId": "v-junho", "eventId": eid})  # nor at the page's hint
    assert status == 200 and out["preload"] is None and _fetch(tok)[1]["preload"] is None
    out = live.play(ctx, s, {"viewerId": "v-junho", "eventId": eid, "launchId": got["launchId"]})
    assert out["waitsForInput"] is False
    assert _fetch(tok) == (200, {"state": "go", "url": _url("gm_race", holds=False)})  # it starts in front of the viewer


def test_a_grid_launcher_leaves_out_the_tile_whose_game_cannot_hold(api, clock):
    ctx = api
    s = _playable_start(ctx, clock)
    ctx.s3._store[(ctx.assets_bucket, "games/gm_sky/runtime3d.js")] = b"// an older copy"
    _, tok = _start(ctx, s, viewerId="v-minji", grid=True)
    assert _fetch(tok)[1] == {"state": "wait", "next": playable.IDLE_POLL_MS, "preload": _url("gm_boss"),
                              "also": [_url("gm_race"), _url("gm_space")]}
    live.round_done(ctx, s, {"rounds": 1})
    assert _fetch(tok)[1]["also"] == [_url("gm_race"), _url("gm_space")]


def test_the_launcher_page_only_loads_a_holding_game_ahead_and_one_game_at_a_time():
    page = (ROOT / "server" / "launcher.html").read_text()
    assert "standby=1" in page  # its own guard, whatever the server names
    assert "d.also" in page and "d.card" in page and "d.calm" in page


def test_a_page_names_its_launcher_so_it_can_end_a_start_still_in_flight(api, clock):
    ctx = api
    s = _playable_start(ctx, clock)
    other = _launcher(ctx, s)  # another window's launcher holds the other seat
    sid = s["sessionId"]
    tok = live._token(ctx, _job_id(ctx))
    # (a) the page's own id is the launcher's, so a stop that follows the start ends it
    status, got = call("POST", f"/api/sessions/{sid}/live/launcher", {"signalRequest": "o", "standbyToken": tok,
                                                                       "launchId": "29b7f338c46b"})
    assert status == 202 and got["launchId"] == "29b7f338c46b"
    assert call("DELETE", f"/api/sessions/{sid}/live/launcher/29b7f338c46b")[0] == 200
    assert ctx.gls.ended == [got["streamId"]]
    # (b) the window closed before the start reached the server: nothing starts
    assert call("DELETE", f"/api/sessions/{sid}/live/launcher/aaaaaaaaaaaa")[0] == 200
    n = len(ctx.gls.sessions)
    status, body = call("POST", f"/api/sessions/{sid}/live/launcher", {"signalRequest": "o", "standbyToken": tok,
                                                                        "launchId": "aaaaaaaaaaaa"})
    assert status == 410 and len(ctx.gls.sessions) == n
    # (c) the window closed while GameLift Streams was starting the session: the start ends what it started
    real = streams.open_session

    def slow(*a, **kw):
        resp = real(*a, **kw)
        live.launcher_stop(ctx, s, "bbbbbbbbbbbb")  # the page's keepalive DELETE lands now
        return resp
    with pytest.MonkeyPatch.context() as m:
        m.setattr(streams, "open_session", slow)
        with pytest.raises(live.LiveError) as e:
            live.launcher_start(ctx, s, {"signalRequest": "o", "standbyToken": tok, "launchId": "bbbbbbbbbbbb"})
    assert e.value.status == 410 and ctx.gls.ended[-1] == f"s-{len(ctx.gls.sessions)}"
    # the seat is free again: only the other window's launcher is left, and the next start gets one
    assert [i["streamId"] for i in streams.ledger(ctx, "sg-web")] == [other["streamId"]]
    assert _launcher(ctx, s)["launchId"]
    assert call("DELETE", f"/api/sessions/{sid}/live/launcher/abc")[0] == 404  # not a launcher id
