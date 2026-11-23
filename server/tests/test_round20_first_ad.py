"""A new account's first broadcast: its one trailer is in nobody's warm registry. A creative is usable TRANSCODE_SEC
after a 1 s warm-up break, which goes out only while a viewer's player plays, and MediaTailor skips a creative it has
not transcoded. So an ad round with nothing ready sends each viewer's corner trailer, says so in the break log and
logs no full-screen break; warm-ups go on through such a round, so the next ad round can air. Walked on the fake
clock, fakes only. Named without "live" so `pytest -k 'not live'` runs it."""
import json

import pytest

from server import live, store, waits
from server.tests.test_ad_styles import _meta, ctx  # noqa: F401 — IVS, the table, the playback key
from server.tests.test_ads import clock, keys  # noqa: F401
from server.tests.test_viewer_ads import IDS, _trailer

ROUND = 35.0  # a 30-second survival round and its briefing
FIRST_END = 35.0  # 임무 시작 right after the start: round 1 ends 35 s in
POLL_SEC, BEAT_SEC = 4, 15


def _new_account(ctx, clock):  # noqa: F811
    """A new account: one session, one game, one trailer no broadcast has ever sent."""
    s = store.put_session(ctx, "user-new", "첫 방송", "sf-survival")
    sid = s["sessionId"]
    store.put_game(ctx, sid, {"gameId": "gm_new", "title": "첫 게임", "genre": "sf-survival", "specKey": "k",
                              "previewUrl": store.public_url(ctx, "games/gm_new/index.html")})
    _trailer(ctx, sid, "first", "첫 게임 트레일러", "survive the zombie horde wave", 20.0, "2026-11-16T00:00:00.000Z")
    # what other accounts' broadcasts warmed: nothing of this one's
    ctx.s3._store[("live-b", live.WARM_REGISTRY)] = json.dumps(
        {"https://d1.cloudfront.net/sessions/ses_demo/demo.mp4": clock.t - 86400}).encode()
    return s


def _log(ctx):  # noqa: F811
    return json.loads(ctx.s3._store[("live-b", live.STATUS_KEY)])["breaks"]


def _job(ctx):  # noqa: F811
    return json.loads(ctx.s3._store[("live-b", live.JOB_KEY)])


def walk(ctx, clock, s, rounds, tiles_from=None, eta=False, every=2):  # noqa: F811
    """Runs a broadcast half a fake second at a time: the console's status poll every 4 s, the round reports (eta:
    the play window also tells a round's end ahead) and, from tiles_from seconds in, the watch page's four tiles
    with their heartbeat every 15 s. → {"done": {round: answer}, "eta": {round: answer}, "warmups": [seconds in]}."""
    t0 = clock.t
    live.start(ctx, s, {"gameId": "gm_new", "everyRounds": every})
    lead = _job(ctx)["preCueLeadSec"]
    ends = [t0 + FIRST_END + k * ROUND for k in range(rounds)]
    out = {"done": {}, "eta": {}, "warmups": [], "t0": t0}
    step, t = 0.5, t0
    while t < ends[-1] + 1:
        t = round(t + step, 3)
        clock.t = t
        k = t - t0
        before = len(ctx.ivs.breaks())
        for r, end in enumerate(ends, 1):
            if eta and abs(t - (end - lead)) < step / 2:
                out["eta"][r] = live.round_eta(ctx, s, {"round": r, "endsInMs": lead * 1000, "sentAt": 0})
            if abs(t - end) < step / 2:
                out["done"][r] = live.round_done(ctx, s, {"rounds": r})
        full = len(ctx.ivs.breaks())
        if tiles_from is not None and k >= tiles_from and abs((k - tiles_from) % BEAT_SEC) < step / 2:
            live.viewer(ctx, s, {"viewers": IDS, "reports": True})
        if abs(k % POLL_SEC) < step / 2:
            live.status(ctx, s)
        if [b for b in ctx.ivs.breaks()[full:] if b == 1]:
            out["warmups"].append(round(k, 1))
        assert all(b > 1 for b in ctx.ivs.breaks()[before:full])  # a round's break is never a 1 s warm-up
    return out


def _full_screen(ctx):  # noqa: F811
    """The full-screen breaks IVS was asked for (a warm-up is 1 s)."""
    return [b for b in ctx.ivs.breaks() if b > 1]


def test_with_no_viewer_the_first_ad_round_sends_no_break_for_a_trailer_nobody_transcoded(ctx, clock):  # noqa: F811
    """No watch page is open, so no warm-up ever goes out."""
    out = walk(ctx, clock, _new_account(ctx, clock), rounds=2)
    assert out["warmups"] == [] and _job(ctx)["warmedAt"] == {}  # MediaTailor has never been shown the trailer
    assert out["done"][1]["cued"] is False and not out["done"][1]["corner"]
    second = out["done"][2]
    assert _full_screen(ctx) == [] and second["cued"] is False and second["corner"] is True
    assert "holdSec" not in second  # a corner lands on the round's end: nothing to hold the end screen for
    [entry] = _log(ctx)
    assert entry["kind"] == "corner" and entry["round"] == 2 and entry["instead"] == "trailer"
    assert not [b for b in _log(ctx) if b.get("kind") == "trailer"]
    # each viewer's corner trailer went out on the round's last frame
    [cue] = [m for m in _meta(ctx) if m["type"] == "corner"]
    assert cue["e"] == entry["eventId"] and {entry["picks"][v]["title"] for v in IDS} == {"첫 게임 트레일러"}
    assert _job(ctx)["trailerBreaks"] == 0 and _job(ctx)["cornerBreaks"] == 1 and "airCheck" not in _job(ctx)


def test_the_break_log_says_in_plain_korean_why_the_round_got_a_corner_trailer(ctx, clock):  # noqa: F811
    walk(ctx, clock, _new_account(ctx, clock), rounds=2)
    note = _log(ctx)[-1]["note"]
    assert note == live.AD_NOT_STARTED_NOTE and waits.TRAILER_PREP in note and "코너 트레일러" in note
    assert "시청 창" in note  # nothing is being prepared while no player plays: the line says what starts it
    for internal in ("MediaTailor", "IVS", "VAST", "transcod", "warm", "creative", "SSAI"):
        assert internal not in note


def test_with_the_watch_page_open_the_first_ad_round_is_a_corner_and_the_next_one_airs(ctx, clock):  # noqa: F811
    """Four tiles play from 20 s in: the warm-up goes at their first heartbeat and is 50 s old when round 2 ends
    (not yet usable), 120 s old when round 4 does."""
    out = walk(ctx, clock, _new_account(ctx, clock), rounds=4, tiles_from=20)
    assert out["warmups"] == [20.0]  # one trailer: one warm-up, at once
    second, fourth = out["done"][2], out["done"][4]
    assert (second["cued"], second["corner"]) == (False, True)
    log = _log(ctx)
    assert [(b["round"], b["kind"]) for b in log] == [(2, "corner"), (4, "trailer")]
    assert log[0]["instead"] == "trailer" and log[0]["note"] == live.AD_WARMING_NOTE
    assert "준비" in log[0]["note"] and waits.TRAILER_PREP in log[0]["note"] and "시청 창" not in log[0]["note"]
    # the full-screen break of round 4: the one trailer, as long as it is, for every viewer
    assert fourth["cued"] is True and _full_screen(ctx) == [20]
    assert {log[1]["picks"][v]["title"] for v in ["", *IDS]} == {"첫 게임 트레일러"} and "note" not in log[1]
    assert _job(ctx)["trailerBreaks"] == 1


def test_a_pre_cue_of_a_round_with_nothing_ready_is_declined_and_the_report_sends_the_corner(ctx, clock):  # noqa: F811
    """A corner rides on the round's last frame, so it cannot go out with the pre-cue seconds before the end."""
    out = walk(ctx, clock, _new_account(ctx, clock), rounds=2, tiles_from=20, eta=True)
    assert out["eta"][2] == {"preCued": False, "reason": "ad_warming"}
    assert "preCued" not in _job(ctx)  # the claim was given back: the report decides
    assert (out["done"][2]["cued"], out["done"][2]["preCued"], out["done"][2]["corner"]) == (False, False, True)
    assert _full_screen(ctx) == [] and [b["kind"] for b in _log(ctx)] == ["corner"]


def test_warm_ups_go_on_through_an_ad_round_while_nothing_is_ready(ctx, clock):  # noqa: F811
    """A warm-up is held back during an ad round whose cue would spoil it (_cue_due). With nothing ready that cue is
    a corner, which takes no files: a watch page opened during round 2 gets its warm-up at once, and round 4 airs."""
    out = walk(ctx, clock, _new_account(ctx, clock), rounds=4, tiles_from=40)
    assert out["warmups"] == [40.0]
    assert [(b["round"], b["kind"]) for b in _log(ctx)] == [(2, "corner"), (4, "trailer")]
    assert _full_screen(ctx) == [20]


def test_every_round_an_ad_round_still_gets_to_its_first_full_screen_break(ctx, clock):  # noqa: F811
    out = walk(ctx, clock, _new_account(ctx, clock), rounds=5, tiles_from=20, every=1)
    kinds = [(b["round"], b["kind"]) for b in _log(ctx)]
    # rounds 1-3 end 35, 70 and 105 s in (the warm-up of 20 s is 15, 50 and 85 s old): corners; round 4 airs
    assert kinds[:4] == [(1, "corner"), (2, "corner"), (3, "corner"), (4, "trailer")]
    assert all(out["done"][r]["corner"] and not out["done"][r]["cued"] for r in (1, 2, 3)) and out["done"][4]["cued"]


def test_a_trailer_that_was_sent_in_an_earlier_broadcast_airs_at_the_first_ad_round_as_before(ctx, clock):  # noqa: F811
    """The registry remembers the trailer (every account's second broadcast)."""
    s = _new_account(ctx, clock)
    url = store.public_url(ctx, f"sessions/{s['sessionId']}/first.mp4")
    ctx.s3._store[("live-b", live.WARM_REGISTRY)] = json.dumps({url: clock.t - 3600}).encode()
    out = walk(ctx, clock, s, rounds=2)
    assert out["done"][2]["cued"] is True and _full_screen(ctx) == [20]
    assert [b["kind"] for b in _log(ctx)] == ["trailer"] and "instead" not in _log(ctx)[0]


def test_a_stream_that_is_not_on_gets_neither_and_the_round_still_counts(ctx, clock):  # noqa: F811
    s = _new_account(ctx, clock)
    live.start(ctx, s, {"gameId": "gm_new", "everyRounds": 1})
    ctx.ivs.put_metadata = lambda **kw: (_ for _ in ()).throw(
        live.ClientError({"Error": {"Code": "ChannelNotBroadcasting", "Message": "x"}}, "PutMetadata"))
    r = live.round_done(ctx, s, {"rounds": 1})
    assert (r["cued"], r["corner"], r["rounds"]) == (False, False, 1) and _log(ctx) == []


@pytest.mark.parametrize("style", ["corner", "playable"])
def test_other_ad_styles_are_untouched(ctx, clock, style):  # noqa: F811
    s = _new_account(ctx, clock)
    live.start(ctx, s, {"gameId": "gm_new", "everyRounds": 1, "adType": style})
    r = live.round_done(ctx, s, {"rounds": 1})
    assert r["cued"] is True and "instead" not in _log(ctx)[-1] and "note" not in _log(ctx)[-1]
