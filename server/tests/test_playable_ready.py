"""Playable ads on air: the first card waits for a connected launcher, each viewer gets a different game, and a queued
click keeps the game it was clicked for. Fakes only. Named without "live" so `pytest -k 'not live'` runs it."""
import json

import pytest  # noqa: F401

from server import adserver, live, playable, store
from server.tests.test_ad_styles import (FakeGls, _breaks_log, _fill, _game, _launcher, _meta, _playable_start,  # noqa: F401
                                         _sid, ctx)
from server.tests.test_ads import api, call, clock, keys  # noqa: F401
from server.tests.test_viewer_ads import IDS, _job


def _kinds(ctx, s):
    return [(b["round"], b["kind"], b.get("reason")) for b in _breaks_log(ctx, s)]


# ── 1. the first playable card waits for a connected launcher ─────────────────

def test_the_first_playable_cue_waits_until_a_launcher_is_connected_with_corner_trailers_meanwhile(ctx, clock):
    s = _playable_start(ctx, clock, every=2)
    lau = _launcher(ctx, s, connected=False)  # the watch page's launcher, still on a cold host
    live.round_done(ctx, s, {"rounds": 1})
    clock.t += 30
    r = live.round_done(ctx, s, {"rounds": 2})
    assert r["cued"] is False and r["deferred"] is True
    assert not [m for m in _meta(ctx) if m["type"] == "playable"]  # no card nobody can open at once
    assert r["corner"] is True and _meta(ctx)[-1]["type"] == "corner"  # each viewer's corner trailer instead
    assert (2, "skip", "launcher_warming") in _kinds(ctx, s)
    clock.t += 30
    ctx.gls.status[lau["streamId"]] = "CONNECTED"  # the page's client is on it
    r = live.round_done(ctx, s, {"rounds": 3})  # not an N-th round: the held card goes now
    assert r["cued"] is True and _meta(ctx)[-1]["type"] == "playable"
    assert _job(ctx)["launcherReadyAt"] and "playableDue" not in _job(ctx)
    ctx.gls.status[lau["streamId"]] = "ACTIVATING"  # (in use or gone: the gate stays open for good)
    clock.t += 30
    live.round_done(ctx, s, {"rounds": 4})
    assert _breaks_log(ctx, s)[-1]["kind"] == "playable"  # the schedule stays: every 2nd round


def test_the_gate_gives_up_after_its_cap_and_never_waits_without_a_launcher(ctx, clock):
    s = _playable_start(ctx, clock, every=1)
    assert live.round_done(ctx, s, {"rounds": 1})["cued"] is True  # no launcher at all: nobody to wait for
    _launcher(ctx, s, connected=False)
    clock.t += live.LAUNCHER_GATE_SEC + 1  # a host that never comes does not cost the broadcast its ads
    assert live.round_done(ctx, s, {"rounds": 2})["cued"] is True


def test_the_playable_tab_prewarms_the_idle_host_and_the_broadcast_takes_it_over(ctx, clock):
    s = _playable_start(ctx, clock)
    live.stop(ctx, s)
    assert ctx.gls.loc["TargetIdleCapacity"] == 0
    st = live.standby_set(ctx, s, {"on": True, "prewarm": True})  # the console's playable tab, before a broadcast
    assert ctx.gls.loc["TargetIdleCapacity"] == 1 and st["prewarm"] is True and st["mode"] == "on"
    assert st["until"] == pytest.approx(clock.t + live.PREWARM_SEC)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 2, "adType": "playable", "playableSeconds": 60})
    assert json.loads(ctx.s3._store[("live-b", live.STANDBY_KEY)])["mode"] == "auto"  # the broadcast holds it now
    live.stop(ctx, s)
    assert ctx.gls.loc["TargetIdleCapacity"] == 0  # and lets it go at its stop
    # taken down by hand: the pre-warm button starts it again
    live.standby_set(ctx, s, {"on": False})
    assert live.standby_set(ctx, s, {"on": True, "prewarm": True})["on"] is True
    live.standby_set(ctx, s, {"on": True})
    clock.t += 5
    doc = json.loads(ctx.s3._store[("live-b", live.STANDBY_KEY)])
    live.standby_set(ctx, s, {"on": True, "prewarm": True})  # a hold set by hand stays as it is
    assert json.loads(ctx.s3._store[("live-b", live.STANDBY_KEY)]) == doc


def test_an_unused_prewarm_goes_when_its_time_is_up_or_a_trailer_broadcast_starts(ctx, clock):
    s = _playable_start(ctx, clock)
    live.stop(ctx, s)
    live.standby_set(ctx, s, {"on": True, "prewarm": True})
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 2})  # a trailer broadcast: no playable server needed
    assert ctx.gls.loc["TargetIdleCapacity"] == 0
    live.stop(ctx, s)
    live.standby_set(ctx, s, {"on": True, "prewarm": True})
    clock.t += live.PREWARM_SEC + 1
    live.reap(ctx)
    assert ctx.gls.loc["TargetIdleCapacity"] == 0


# ── 2. distinct playable picks, a game's versions as that game ────────────────

def _viewer(vid, genre):
    return {"viewerId": vid, "profile": {"genres": [genre]}}


def _item(gid, title, genre, family=None):
    return {"campaignId": "pg_" + gid, "creative": "pg_" + gid, "gameId": gid, "title": title, "genre": genre, "tags": [],
            "ips": [], "url": f"https://cdn/games/{gid}/index.html", "seconds": 0.0,
            "createdAt": "2026-11-09T00:00:00.000Z", "family": family or f"ses/{gid}"}


def test_four_viewers_get_four_games_even_when_two_love_the_same_one(clock):
    people = [_viewer("v-minji", "arpg"), _viewer("v-junho", "explore"), _viewer("v-seoyeon", "explore"),
              _viewer("v-hyunwoo", "shooter")]
    items = [_item("gm_sky", "루미의 하늘섬 우편 배달", "explore"), _item("gm_boss", "해골 왕의 지하 묘지", "arpg"),
             _item("gm_neon", "네온 프런티어: 테오", "shooter"), _item("gm_race", "사막 협곡 고속도로 레이스", "racing")]
    dec = adserver.decide(people, {}, items, clock.t, 0, kind="playable")
    picks = {v: d["pick"]["campaign"]["gameId"] for v, d in dec.items()}
    assert len(set(picks.values())) == 4 and picks["v-junho"] == "gm_sky"


def test_versions_of_one_game_count_as_that_game(clock):
    people = [_viewer("v-junho", "explore"), _viewer("v-seoyeon", "explore")]
    items = [_item("gm_sky", "루미의 하늘섬 우편 배달", "explore", "ses_a/gm_sky"),
             _item("gm_sky2", "루미의 하늘섬 우편 배달 리마스터", "explore", "ses_a/gm_sky"),  # its revision
             _item("gm_boss", "해골 왕의 지하 묘지", "arpg")]
    dec = adserver.decide(people, {}, items, clock.t, 0, kind="playable")
    got = sorted(d["pick"]["campaign"]["gameId"] for d in dec.values())
    assert got in (["gm_boss", "gm_sky"], ["gm_boss", "gm_sky2"])
    same_title = [_item("gm_a", "구름섬", "explore"), _item("gm_b", "구름섬", "explore"), _item("gm_boss", "보스", "arpg")]
    got = {d["pick"]["campaign"]["gameId"] for d in adserver.decide(people, {}, same_title, clock.t, kind="playable").values()}
    assert "gm_boss" in got  # two games of one title are one game too


def test_a_revision_is_in_the_family_of_the_game_it_was_made_from(ctx):
    sid = store.put_session(ctx, "user-1", "하늘섬", "rpg-explore")["sessionId"]
    _game(ctx, sid, "gm_sky", "구름섬 보물 수집", "rpg-explore")
    _game(ctx, sid, "gm_other", "보스 탑", "rpg-explore")
    store.put_game(ctx, sid, {**store.snapshot(ctx, sid)["games"][0], "gameId": "gm_sky2", "title": "구름섬 보물 수집 2",
                              "baseGameId": "gm_sky"})
    store.put_game(ctx, sid, {**store.snapshot(ctx, sid)["games"][0], "gameId": "gm_sky3", "title": "구름섬 3",
                              "baseGameId": "gm_sky2"})
    fam = {c["gameId"]: c["family"] for c in adserver.games(store.snapshot(ctx, sid))}
    assert fam["gm_sky"] == fam["gm_sky2"] == fam["gm_sky3"] == f"{sid}/gm_sky" != fam["gm_other"]


def test_a_broadcasts_playable_break_gives_each_viewer_a_different_game_and_one_version_at_most(ctx, clock):
    s = _playable_start(ctx, clock)
    sky = _sid(ctx, "하늘섬")
    _game(ctx, sky, "gm_sky2", "구름섬 보물 수집 리마스터", "rpg-explore")
    store.put_game(ctx, sky, {**next(g for g in store.snapshot(ctx, sky)["games"] if g["gameId"] == "gm_sky2"),
                              "baseGameId": "gm_sky"})
    live._inventories(ctx, _job(ctx), fresh=True)
    for n in (1, 2, 3):
        live.round_done(ctx, s, {"rounds": n})
        clock.t += 30
        picks = _breaks_log(ctx, s)[-1]["picks"]
        games = [picks[v]["gameId"] for v in IDS]
        assert len(set(games)) == 4 and not {"gm_sky", "gm_sky2"} <= set(games), games


# ── 3. a queued card keeps the game it was clicked for ────────────────────────

def test_a_queued_click_plays_the_game_it_was_clicked_for_after_a_new_cue(ctx, clock):
    s = _playable_start(ctx, clock)
    live.round_done(ctx, s, {"rounds": 1})
    first = _breaks_log(ctx, s)[-1]
    live.ad_event(ctx, s, {"viewerId": "v-seoyeon", "eventId": first["eventId"], "kind": "playable",
                           "action": "impression"})  # her card showed: the frequency cap moves her next one on
    _fill(ctx)
    waiting = live.play(ctx, s, {"viewerId": "v-seoyeon", "eventId": first["eventId"]})
    assert waiting["mode"] == "queued"
    clock.t += 30
    live.round_done(ctx, s, {"rounds": 2})  # the next card offers seoyeon another game
    second = _breaks_log(ctx, s)[-1]
    assert second["picks"]["v-seoyeon"]["adId"] != first["picks"]["v-seoyeon"]["adId"]
    from server import streams
    streams.end(ctx, "sg-web", "s-1")  # a seat frees
    go = live.play(ctx, s, {"viewerId": "v-seoyeon", "eventId": first["eventId"], "ticket": waiting["ticket"]})
    assert go["mode"] == "start" and go["adId"] == first["picks"]["v-seoyeon"]["adId"]
    assert playable.get(ctx, go["adId"])["gameId"] == first["picks"]["v-seoyeon"]["gameId"]
