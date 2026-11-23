"""미리 켜기 after the playable server was taken down, and who may flip its switch.

미리 켜기 is a button with its price on it, so it is the user's newer word over an earlier OFF (their own or another
account's). The switch of the shared GPU server (paid by the hour, sign-up is open) is for an account that could use
the server now: its session has a game, or it is on air."""
import json

import pytest

from server import live, store
from server.tests.test_ad_styles import _playable_start, ctx  # noqa: F401
from server.tests.test_ads import clock, keys  # noqa: F401
from server.tests.test_round20_channel_owner import B_TOKEN, _quiet, _studio, call
from server.tests.test_round20_channel_owner import api as owners_api  # noqa: F401
from server.tests.test_round20_errors import plain
from server.tests.test_viewer_ads import _job, _owner

PREWARM = {"on": True, "prewarm": True}


def _switch(ctx):  # noqa: F811
    raw = ctx.s3._store.get(("live-b", live.STANDBY_KEY))
    return json.loads(raw) if raw else None


def _held(ctx):  # noqa: F811
    return ctx.gls.loc["TargetIdleCapacity"]


# ── 미리 켜기 after 지금 내리기 ────────────────────────────────────────────────────

def test_a_prewarm_after_the_server_was_taken_down_starts_it_again(ctx, clock):  # noqa: F811
    """Three presses: 미리 켜기, 지금 내리기, 미리 켜기."""
    s = _owner(ctx)
    first = live.standby_set(ctx, s, PREWARM)
    assert (first["on"], first["state"], first["prewarm"]) == (True, "warming", True) and _held(ctx) == 1
    down = live.standby_set(ctx, s, {"on": False})
    assert (down["on"], down["mode"]) == (False, "off") and _held(ctx) == 0

    clock.t += 30
    again = live.standby_set(ctx, s, PREWARM)

    assert _held(ctx) == 1
    assert (again["on"], again["state"], again["mode"], again["prewarm"]) == (True, "warming", "on", True)
    assert again["until"] == pytest.approx(clock.t + live.PREWARM_SEC)  # its own ten minutes, from this press
    assert _switch(ctx)["by"] == s["sessionId"]


def test_one_accounts_off_does_not_silence_another_accounts_prewarm(ctx, clock):  # noqa: F811
    """A second account's OFF, then the first account's 미리 켜기 16 minutes later."""
    a, b = _owner(ctx), _studio(ctx, "user-2", "gm_b", "두 번째 계정의 게임")
    assert live.standby_set(ctx, b, {"on": False})["mode"] == "off"
    clock.t += 16 * 60
    st = live.standby_set(ctx, a, PREWARM)
    assert (st["on"], st["prewarm"]) == (True, True) and _held(ctx) == 1


def test_the_route_answers_with_the_server_on(owners_api, clock):  # noqa: F811
    s = _owner(owners_api)
    path = f"/api/sessions/{s['sessionId']}/live/standby"
    assert call("POST", path, {"on": False})[1]["on"] is False
    status, st = call("POST", path, PREWARM)
    assert status == 200 and (st["on"], st["prewarm"], st["state"]) == (True, True, "warming")


def test_the_status_says_how_long_a_prewarm_is_held_before_it_is_pressed(ctx, clock):  # noqa: F811
    """prewarmSec is in every answer, so the button's line can say the hold's length ahead and types none of its own."""
    s = _owner(ctx)
    off = live.standby_status(ctx, s)
    assert (off["on"], off["until"]) == (False, None) and off["prewarmSec"] == live.PREWARM_SEC == 600
    held = live.standby_set(ctx, s, PREWARM)
    assert held["prewarmSec"] == 600 and held["until"] == pytest.approx(clock.t + held["prewarmSec"])


def test_a_prewarm_adds_nothing_to_a_host_held_by_hand(ctx, clock):  # noqa: F811
    """Held for its hour already: the pre-warm's ten minutes would cut that short."""
    s = _owner(ctx)
    live.standby_set(ctx, s, {"on": True})
    clock.t += 5
    doc = _switch(ctx)
    st = live.standby_set(ctx, s, PREWARM)
    assert _switch(ctx) == doc and (st["on"], st["mode"], st["prewarm"]) == (True, "on", False) and _held(ctx) == 1


def test_a_prewarm_adds_nothing_to_a_host_a_playable_broadcast_holds(ctx, clock):  # noqa: F811
    s = _playable_start(ctx, clock)
    doc = _switch(ctx)
    st = live.standby_set(ctx, s, PREWARM)
    assert _switch(ctx) == doc and (st["on"], st["prewarm"]) == (True, False) and _held(ctx) == 1


def test_a_prewarm_brings_the_server_back_under_a_broadcast_that_took_it_down(ctx, clock):  # noqa: F811
    """Taken down by hand during a playable broadcast: 미리 켜기 is the newer word there too, and once its ten minutes
    are over the broadcast holds the host again."""
    s = _playable_start(ctx, clock)
    live.standby_set(ctx, s, {"on": False})
    assert _held(ctx) == 0
    st = live.standby_set(ctx, s, PREWARM)
    assert (st["on"], st["prewarm"]) == (True, True) and _held(ctx) == 1
    clock.t += live.PREWARM_SEC + 1
    st = live.standby_status(ctx, s)
    assert (st["on"], st["mode"]) == (True, "auto") and _held(ctx) == 1


# ── who may flip the switch ───────────────────────────────────────────────────

NO_GAME = "게임이 있는 세션에서만 플레이어블 서버를 켜거나 내릴 수 있어요. 먼저 게임을 만들어 주세요."


@pytest.mark.parametrize("body", [PREWARM, {"on": True}, {"on": False}])
def test_an_account_with_no_game_cannot_flip_the_switch(ctx, clock, body):  # noqa: F811
    """A new account with one empty session, the channel idle."""
    a = _owner(ctx)
    live.standby_set(ctx, a, PREWARM)  # the owner's own hold
    doc = _switch(ctx)
    fresh = store.put_session(ctx, "user-9", "새 세션", "sf-shooter")

    with pytest.raises(live.LiveError) as refused:
        live.standby_set(ctx, fresh, body)

    assert (refused.value.status, refused.value.code, refused.value.message) == (400, "no_game", NO_GAME)
    assert plain(NO_GAME) and _switch(ctx) == doc and _held(ctx) == 1  # nothing of the owner's hold moved
    assert live.standby_status(ctx, fresh)["on"] is True  # reading the shared server's state stays everyone's


@pytest.mark.parametrize("body,held", [({"on": False}, 0), (PREWARM, 1), ({"on": True}, 1)])
def test_the_owner_on_air_flips_the_switch_from_any_of_their_sessions(ctx, clock, body, held):  # noqa: F811
    """The account that is on air can use the server now, whichever of its sessions the console is in (also an empty
    one)."""
    a = _playable_start(ctx, clock)
    empty = store.put_session(ctx, a["userSub"], "새 세션", "sf-shooter")
    live.standby_set(ctx, a, {"on": False})  # the broadcast's host taken down by hand, from its own session
    assert _held(ctx) == 0

    st = live.standby_set(ctx, empty, body)

    assert _held(ctx) == held and st["on"] is bool(held)


def test_an_account_off_air_is_still_refused_in_its_empty_session(ctx, clock):  # noqa: F811
    """Off air the rule is the session's own: an empty one has nothing to hold a host for, whatever the account's
    other sessions hold."""
    a = _playable_start(ctx, clock)
    empty = store.put_session(ctx, a["userSub"], "새 세션", "sf-shooter")
    live.stop(ctx, a)
    with pytest.raises(live.LiveError) as refused:
        live.standby_set(ctx, empty, PREWARM)
    assert (refused.value.code, refused.value.message) == ("no_game", NO_GAME)


def test_the_refusal_reaches_the_page_as_a_sentence(owners_api, clock):  # noqa: F811
    fresh = store.put_session(owners_api, "user-2", "새 세션", "sf-shooter")
    status, body = call("POST", f"/api/sessions/{fresh['sessionId']}/live/standby", PREWARM, token=B_TOKEN)
    assert (status, body["error"], body["message"]) == (400, "no_game", NO_GAME)
    assert owners_api.gls.loc["TargetIdleCapacity"] == 0
    assert call("GET", f"/api/sessions/{fresh['sessionId']}/live/standby", token=B_TOKEN)[0] == 200


def test_an_account_with_a_game_may_still_hold_a_host_when_nobody_is_on_air(ctx, clock):  # noqa: F811
    b = _studio(ctx, "user-2", "gm_b", "두 번째 계정의 게임")
    assert live.standby_set(ctx, b, PREWARM)["on"] is True and _held(ctx) == 1


def test_an_off_from_another_account_never_reaches_a_running_broadcasts_switch(ctx, clock):  # noqa: F811
    """Refused while that broadcast is alive, whoever asks; once its window is gone the channel and the switch are
    free."""
    a, b = _owner(ctx), _studio(ctx, "user-2", "gm_b", "두 번째 계정의 게임")
    fresh = store.put_session(ctx, "user-9", "새 세션", "sf-shooter")
    live.start(ctx, a, {"gameId": "gm_1", "everyRounds": 1, "adType": "playable"})
    doc = _switch(ctx)
    for who in (b, fresh):
        with pytest.raises(live.LiveError) as refused:
            live.standby_set(ctx, who, {"on": False})
        assert (refused.value.status, refused.value.code) == (409, "live_busy")
        assert plain(refused.value.message) == live.SWITCH_BUSY_TEXT
    assert _switch(ctx) == doc and _held(ctx) == 1 and _job(ctx)["standby"] is True
    live.beat(ctx, a)
    _quiet(ctx, clock)
    assert live.standby_set(ctx, b, {"on": False})["on"] is False
