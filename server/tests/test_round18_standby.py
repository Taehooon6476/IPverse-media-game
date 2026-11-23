"""The playable server's holds: a pre-warm or a hand hold whose time is up ends at the console's standby poll (not
only at the 5-minute reap), with the races around it. Also: a corner tap's two events weigh as one tap, and a card
click's own session can be ended while its start is in flight. Fakes only. Named without the word the `-k` filter of
the suites drops."""
import json

import pytest
from botocore.exceptions import ClientError

from server import adserver, live, playable, streams, viewers
from server.tests.test_ad_styles import _breaks_log, _playable_start, ctx  # noqa: F401
from server.tests.test_ads import api, call, clock, keys  # noqa: F401
from server.tests.test_viewer_ads import _job, _owner


def _switch(ctx):
    return json.loads(ctx.s3._store[("live-b", live.STANDBY_KEY)])


def _prewarmed(ctx, clock):
    """A stopped broadcast's session with the console's playable tab open: the pre-warm is armed. → (session, answer)."""
    s = _playable_start(ctx, clock)
    live.stop(ctx, s)
    assert ctx.gls.loc["TargetIdleCapacity"] == 0
    return s, live.standby_set(ctx, s, {"on": True, "prewarm": True})


def test_an_unused_prewarm_goes_at_the_first_standby_poll_after_its_ten_minutes(api, clock):
    ctx = api
    s, armed = _prewarmed(ctx, clock)
    assert armed["until"] == pytest.approx(clock.t + live.PREWARM_SEC)

    def poll():  # GET /live/standby, the control room's 5 s poll
        status, st = call("GET", f"/api/sessions/{s['sessionId']}/live/standby")
        assert status == 200
        return st
    clock.t += live.PREWARM_SEC - 1
    st = poll()  # inside its time: held
    assert (st["on"], st["mode"], st["prewarm"], st["until"]) == (True, "on", True, armed["until"])
    assert ctx.gls.loc["TargetIdleCapacity"] == 1
    clock.t += 2
    st = poll()  # no reap in between: the poll itself releases the host
    assert ctx.gls.loc["TargetIdleCapacity"] == 0
    assert (st["on"], st["state"], st["mode"], st["prewarm"], st["until"]) == (False, "off", "auto", False, None)
    assert _switch(ctx)["mode"] == "auto"


def test_a_host_held_by_hand_goes_at_the_first_standby_poll_after_its_hour(ctx, clock):
    s = _playable_start(ctx, clock)
    live.stop(ctx, s)
    live.standby_set(ctx, s, {"on": True})
    clock.t += live.MANUAL_HOLD_SEC - 1
    assert live.standby_status(ctx, s)["on"] is True
    clock.t += 2
    st = live.standby_status(ctx, s)
    assert ctx.gls.loc["TargetIdleCapacity"] == 0 and (st["on"], st["mode"]) == (False, "auto")


def test_a_prewarm_opened_again_is_held_from_that_opening(ctx, clock):
    s, _ = _prewarmed(ctx, clock)
    clock.t += live.PREWARM_SEC - 30
    again = live.standby_set(ctx, s, {"on": True, "prewarm": True})  # the tab is opened once more
    clock.t += 60  # the first opening's time is up
    st = live.standby_status(ctx, s)
    assert ctx.gls.loc["TargetIdleCapacity"] == 1
    assert st["until"] == again["until"] == pytest.approx(clock.t + live.PREWARM_SEC - 60)


def test_a_prewarm_opened_again_while_a_poll_ends_the_old_one_stays(ctx, clock, monkeypatch):
    s, _ = _prewarmed(ctx, clock)
    clock.t += live.PREWARM_SEC + 1
    real = live._put

    def racing(c, key, body, content_type, **kw):
        if key == live.STANDBY_KEY and kw.get("IfMatch"):  # the poll is about to write the switch back to automatic
            monkeypatch.setattr(live, "_put", real)
            live.standby_set(c, s, {"on": True, "prewarm": True})  # the tab is opened again right now
        return real(c, key, body, content_type, **kw)
    monkeypatch.setattr(live, "_put", racing)
    st = live.standby_status(ctx, s)
    assert ctx.gls.loc["TargetIdleCapacity"] == 1
    assert (st["mode"], st["prewarm"]) == ("on", True) and st["until"] == pytest.approx(clock.t + live.PREWARM_SEC)


def _unattended(ctx, clock):
    """A pre-warm that ran out with no control room open and the reap not yet come: the switch still reads as the
    old hold and its host is still up. → the session."""
    s, _ = _prewarmed(ctx, clock)
    clock.t += live.PREWARM_SEC + 60
    assert ctx.gls.loc["TargetIdleCapacity"] == 1
    return s


def test_a_console_opened_on_the_playable_tab_after_an_unattended_hold_has_its_prewarm(ctx, clock, monkeypatch):
    """Its first standby poll ends the old hold while its pre-warm arms the new one: the pre-warm finds the host still
    held and asks for nothing, then the poll releases it."""
    s = _unattended(ctx, clock)
    real = live._standby

    def racing(c, on):
        if not on:  # the poll is about to release the host: the pre-warm lands first
            monkeypatch.setattr(live, "_standby", real)
            live.standby_set(c, s, {"on": True, "prewarm": True})
        return real(c, on)
    monkeypatch.setattr(live, "_standby", racing)
    st = live.standby_status(ctx, s)
    assert ctx.gls.loc["TargetIdleCapacity"] == 1 and (st["on"], st["mode"], st["prewarm"]) == (True, "on", True)


def test_a_prewarm_that_found_the_old_holds_host_up_has_one_after_a_poll_ended_that_hold(ctx, clock, monkeypatch):
    s = _unattended(ctx, clock)
    real = live._put

    def racing(c, key, body, content_type, **kw):
        if key == live.STANDBY_KEY and json.loads(body).get("prewarm"):  # the pre-warm is about to write its hold
            monkeypatch.setattr(live, "_put", real)
            live.standby_status(c, s)  # a poll ends the old hold first: the host goes
            assert c.gls.loc["TargetIdleCapacity"] == 0
        return real(c, key, body, content_type, **kw)
    monkeypatch.setattr(live, "_put", racing)
    st = live.standby_set(ctx, s, {"on": True, "prewarm": True})
    assert ctx.gls.loc["TargetIdleCapacity"] == 1 and (st["on"], st["mode"], st["prewarm"]) == (True, "on", True)


def test_a_hold_that_runs_out_under_a_broadcast_that_needs_the_host_leaves_it(ctx, clock):
    s = _playable_start(ctx, clock)
    live.standby_set(ctx, s, {"on": True})  # held by hand as well
    clock.t += live.MANUAL_HOLD_SEC + 1
    st = live.standby_status(ctx, s)
    assert ctx.gls.loc["TargetIdleCapacity"] == 1 and (st["on"], st["mode"]) == (True, "auto")  # the broadcast's now
    live.stop(ctx, s)
    assert ctx.gls.loc["TargetIdleCapacity"] == 0  # and it goes with the broadcast

    live.standby_set(ctx, s, {"on": True})
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable", "playableSeconds": 60})
    clock.t += live.MANUAL_HOLD_SEC - 100
    live.ad_settings(ctx, s, {"adType": "trailer", "everyRounds": 1})  # the grace period of a switch to trailer
    clock.t += 101  # the hand hold is over, the grace period is not
    assert live.standby_status(ctx, s)["on"] is True and ctx.gls.loc["TargetIdleCapacity"] == 1
    clock.t += live.STANDBY_GRACE_SEC
    live.status(ctx, s)
    assert ctx.gls.loc["TargetIdleCapacity"] == 0


def test_a_standby_poll_inside_a_prewarmed_start_leaves_the_host(ctx, clock, monkeypatch):
    """A start makes the pre-warm the job's: it rewrites the switch before it writes the job. A poll in between sees a
    held host, no switch and the old job stopped."""
    s, _ = _prewarmed(ctx, clock)
    real = live._new_token  # runs between the switch's rewrite and the job's write
    monkeypatch.setattr(live, "_new_token", lambda c, j: (real(c, j), live.standby_status(c, s))[0])
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 2, "adType": "playable", "playableSeconds": 60})
    assert ctx.gls.loc["TargetIdleCapacity"] == 1 and _job(ctx)["standby"] is True


def test_a_start_that_found_an_old_holds_host_up_has_one_after_a_poll_or_the_reap_let_it_go(ctx, clock, monkeypatch):
    """The start asks for the host before it writes its job: held, so it asks for nothing. Whatever looks in between
    sees no job that needs the host: a poll that ends a hold run out unattended, or the reap after a pre-warm the
    start took over (the tick every 5 minutes)."""
    body = {"gameId": "gm_1", "everyRounds": 2, "adType": "playable", "playableSeconds": 60}
    real = live._new_token  # runs between the start's look at the host and its job's write
    s = _unattended(ctx, clock)
    monkeypatch.setattr(live, "_new_token", lambda c, j: (real(c, j), live.standby_status(c, s))[0])
    live.start(ctx, s, body)
    assert ctx.gls.loc["TargetIdleCapacity"] == 1 and _job(ctx)["standby"] is True

    live.stop(ctx, s)
    live.standby_set(ctx, s, {"on": True, "prewarm": True})
    monkeypatch.setattr(live, "_new_token", lambda c, j: (real(c, j), live.reap(c))[0])
    live.start(ctx, s, body)
    assert ctx.gls.loc["TargetIdleCapacity"] == 1 and _job(ctx)["standby"] is True


def test_a_hold_ends_once_and_a_release_that_failed_is_left_to_the_reap(ctx, clock, monkeypatch):
    s, _ = _prewarmed(ctx, clock)
    asked = []

    def busy(**kw):
        asked.append(kw)
        raise ClientError({"Error": {"Code": "ConflictException", "Message": "busy"}}, "UpdateStreamGroup")
    real = ctx.gls.update_stream_group
    monkeypatch.setattr(ctx.gls, "update_stream_group", busy)
    clock.t += live.PREWARM_SEC + 1
    st = live.standby_status(ctx, s)  # the poll still answers
    assert asked and (st["on"], st["mode"]) == (True, "auto") and _switch(ctx)["mode"] == "auto"
    tried = len(asked)
    live.standby_status(ctx, s)
    assert len(asked) == tried  # the hold is over: a later poll (one inside a start, too) releases nothing
    monkeypatch.setattr(ctx.gls, "update_stream_group", real)
    live.reap(ctx)
    assert ctx.gls.loc["TargetIdleCapacity"] == 0


def test_a_tap_on_a_corner_adds_what_it_added_before_both_its_events_were_logged(ctx, clock):
    """A tap logs two events (expand, unmute) and still adds 0.2 to the genre's interest, as one corner_engage."""
    s = _owner(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "corner"})
    live.round_done(ctx, s, {"rounds": 1})
    brk = _breaks_log(ctx, s)[-1]
    genre = "g:" + brk["picks"]["v-junho"]["genre"]

    def ev(action):
        return live.ad_event(ctx, s, {"viewerId": "v-junho", "eventId": brk["eventId"], "kind": "corner",
                                      "action": action})

    def interest():
        return adserver.affinity(viewers.log(ctx, "v-junho", clock.t), clock.t)[genre]
    ev("impression")
    before = interest()
    assert ev("expand") == ev("unmute") == {"recorded": True}  # one tap: 크게 보기 and 소리 켬
    assert [e["type"] for e in viewers.log(ctx, "v-junho", clock.t)].count("corner_engage") == 2
    assert interest() - before == pytest.approx(0.2)


def test_a_page_names_its_clicks_own_session_so_it_can_end_a_start_still_in_flight(api, clock):
    ctx = api
    s = _playable_start(ctx, clock)
    live.round_done(ctx, s, {"rounds": 1})
    eid = _breaks_log(ctx, s)[-1]["eventId"]

    def click(viewer):  # a card clicked on a page with no warm launcher: a seat, then the game's own session
        go = live.play(ctx, s, {"viewerId": viewer, "eventId": eid})
        assert go["mode"] == "start"
        return go["adId"], {"signalRequest": "o", "ticket": go["ticket"]}

    # (a) the page's own name ends a session whose answer never reached it
    ad_id, body = click("v-junho")
    status, got = call("POST", f"/api/ads/{ad_id}/stream", {**body, "startId": "st_29b7f338c46b"}, token=None)
    assert status == 202 and got["streamId"] == "s-1"
    assert call("DELETE", f"/api/ads/{ad_id}/stream/st_29b7f338c46b", token=None) == (
        200, {"streamId": "st_29b7f338c46b", "status": "TERMINATING"})
    assert ctx.gls.ended == ["s-1"]
    # (b) the window closed before the start reached the server: nothing starts, and its place in line is free
    ad_id, body = click("v-minji")
    assert call("DELETE", f"/api/ads/{ad_id}/stream/st_aaaaaaaaaaaa", token=None)[0] == 200
    plays = playable.get(ctx, ad_id)["plays"]
    status, _ = call("POST", f"/api/ads/{ad_id}/stream", {**body, "startId": "st_aaaaaaaaaaaa"}, token=None)
    assert status == 410 and len(ctx.gls.sessions) == 1 and playable.get(ctx, ad_id)["plays"] == plays
    assert playable._queue(ctx, "sg-web") == []
    # (c) the window closed while GameLift Streams was starting the session: the start ends what it started
    ad_id, body = click("v-seoyeon")
    real = streams.open_session

    def slow(*a, **kw):
        resp = real(*a, **kw)
        playable.stop(ctx, ad_id, "st_bbbbbbbbbbbb")  # the page's keepalive DELETE lands now
        return resp
    with pytest.MonkeyPatch.context() as m:
        m.setattr(streams, "open_session", slow)
        with pytest.raises(playable.AdError) as e:
            playable.start(ctx, ad_id, {**body, "startId": "st_bbbbbbbbbbbb"})
    assert e.value.status == 410 and ctx.gls.ended == ["s-1", "s-2"] and playable.get(ctx, ad_id)["plays"] == 0
    # no seat and no place in line is held: the next click starts at once
    assert streams.ledger(ctx, "sg-web") == [] and playable._queue(ctx, "sg-web") == []
    ad_id, body = click("v-hyunwoo")
    assert call("POST", f"/api/ads/{ad_id}/stream", body, token=None)[0] == 202  # a start with no name
    # a name is its own ad's: under another ad it ends nothing; neither a name nor a stream, or no such ad: not found
    assert call("DELETE", f"/api/ads/{ad_id}/stream/st_29b7f338c46b", token=None)[0] == 200
    assert ctx.gls.ended == ["s-1", "s-2"]
    assert call("DELETE", f"/api/ads/{ad_id}/stream/st_nope", token=None)[0] == 404
    assert call("DELETE", "/api/ads/ad_000000000000/stream/st_29b7f338c46b", token=None)[0] == 404
