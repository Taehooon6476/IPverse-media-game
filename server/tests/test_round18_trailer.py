"""Trailer ads on air: a pre-cued full-screen ad starts after the viewer saw the round end, a corner's break log
carries its wait, a round report says which ad the round got, a corner tap logs both its events, and a playable
play's time reads as it was. Fakes only. Named without the word the `-k` filter of the suites drops."""
import math

import pytest

from server import live, viewers
from server.tests.test_ad_styles import _breaks_log, _meta, _playable_start, _trailer_start, ctx  # noqa: F401
from server.tests.test_ads import clock, keys  # noqa: F401
from server.tests.test_viewer_ads import _job, _owner

# Seconds from the ivs:InsertAdBreak call (the break log's cuedAt) to the stitched break in the stream, on a tile
# that gets the first segment boundary (measured on air)
STREAM_DELAY = (3.0, 5.5)


def test_a_pre_cued_ad_starts_one_to_three_seconds_after_the_round_end_on_each_viewers_own_picture(ctx, clock):
    """A pre-cue sent too early takes the round's last seconds off the viewers' pictures. The call leaves at the
    lead itself (server/tests/test_round19_ad_timing.py)."""
    s = _trailer_start(ctx, clock, every=1)
    lead = _job(ctx)["preCueLeadSec"]  # the default: InsertAdBreak leaves when this much of the round is left
    end = clock.t + 40  # a 40 s survive stage
    clock.t = end - lead
    assert live.round_eta(ctx, s, {"round": 1, "endsInMs": lead * 1000, "sentAt": 0})["preCued"] is True
    cued = viewers.epoch(_breaks_log(ctx, s)[-1]["cuedAt"])
    earliest = cued + STREAM_DELAY[0] - end
    latest = cued + STREAM_DELAY[1] - end
    assert earliest >= 1, f"the ad takes the picture {1 - earliest:.1f} s sooner than a second after the round end"
    assert latest <= 3.5  # (a tile whose break slips a segment: 3–5.5 s, IVS's own)


def test_the_break_log_says_where_the_ad_sits_in_the_stream_and_the_files_are_held_for_the_screens(ctx, clock):
    """The log counts to the break's place in the stream (STREAM_LEAD_SEC), not to the delay to a viewer's screen
    (AD_LEAD_SEC)."""
    s = _trailer_start(ctx, clock, every=1)
    assert STREAM_DELAY[0] <= live.STREAM_LEAD_SEC <= STREAM_DELAY[1] < live.AD_LEAD_SEC
    lead = _job(ctx)["preCueLeadSec"]
    end = clock.t + 40
    clock.t = end - lead
    live.round_eta(ctx, s, {"round": 1, "endsInMs": lead * 1000, "sentAt": 0})
    brk = _breaks_log(ctx, s)[-1]
    assert brk["leadSec"] == lead and brk["endToAdSec"] == round(live.STREAM_LEAD_SEC - lead, 1)
    job = _job(ctx)
    assert job["airUntil"] == clock.t + live.STREAM_LEAD_SEC + math.ceil(brk["seconds"])  # on air, in stream time
    # the VAST files stay the break's while viewers behind the play window still ask for its ads
    assert job["breakUntil"] == clock.t + live.AD_LEAD_SEC + max(math.ceil(brk["seconds"]), live.BREAK_MARGIN_SEC)
    assert viewers.epoch(brk["at"]) == pytest.approx(clock.t + live.AD_LEAD_SEC, abs=1)  # when the screens show it
    clock.t = end + 0.5
    live.round_done(ctx, s, {"rounds": 1})
    assert _breaks_log(ctx, s)[-1]["endToAdSec"] == round(live.STREAM_LEAD_SEC - lead - 0.5, 1)  # against the real end


def test_the_corner_break_log_carries_the_cues_wait(ctx, clock):
    """A corner cued while a tile is in its full-screen ad never reaches that player (the ad replaces its frame):
    the page shows it afterwards from the log, which needs the wait."""
    s = _trailer_start(ctx, clock, every=2, corner=True)
    t = clock.t
    for n, at in ((1, 30), (2, 60), (3, 90)):
        clock.t = t + at
        live.status(ctx, s)
        live.round_done(ctx, s, {"rounds": n})
    brk = _breaks_log(ctx, s)[-1]
    meta = _meta(ctx)[-1]
    assert brk["kind"] == "corner" and meta["e"] == brk["eventId"]
    assert brk["wait"] == meta["wait"] > 0


def test_one_short_round_sends_three_corner_cues_with_wait_0(ctx, clock):
    """The wait is how long a tile may hold the corner behind a full-screen ad, from the shortest of the last three
    rounds: 0 for three cues after one short round (a corner not behind an ad shows whatever the wait says)."""
    s = _owner(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "corner"})
    for n, gap in enumerate((0, 35, 35, 8.5, 35, 35, 35), 1):
        clock.t += gap
        assert live.round_done(ctx, s, {"rounds": n})["cued"] is True
    assert [m["wait"] for m in _meta(ctx)] == [live.CORNER_WAIT_SEC, 21, 21, 0, 0, 0, 21]
    assert [b["wait"] for b in _breaks_log(ctx, s)] == [live.CORNER_WAIT_SEC, 21, 21, 0, 0, 0, 21]


def test_a_round_report_says_which_ad_its_round_got_and_carries_a_skip(ctx, clock):
    """The answer tells the play window's toast a corner (corner), a break sent ahead (preCued) and, in its break
    log, a trailer that was skipped."""
    s = _trailer_start(ctx, clock, every=2, corner=True)
    t = clock.t
    clock.t = t + 30
    r = live.round_done(ctx, s, {"rounds": 1})
    assert (r["cued"], r["preCued"], r["corner"]) == (False, False, True)
    lead = _job(ctx)["preCueLeadSec"]
    clock.t = t + 60 - lead
    assert live.round_eta(ctx, s, {"round": 2, "endsInMs": lead * 1000, "sentAt": 0})["preCued"] is True
    clock.t = t + 60
    r = live.round_done(ctx, s, {"rounds": 2})
    assert (r["cued"], r["preCued"], r["corner"]) == (False, True, False) and r["breaks"][-1]["kind"] == "trailer"
    on_air = _job(ctx)["airUntil"]
    clock.t = t + 70
    live.round_done(ctx, s, {"rounds": 3})
    clock.t = t + 80 - lead  # round 4 is short: its pre-cue finds round 2's ad still on air
    assert clock.t + live.STREAM_LEAD_SEC < on_air
    assert live.round_eta(ctx, s, {"round": 4, "endsInMs": lead * 1000, "sentAt": 0}) == {"preCued": True, "skipped": True}
    clock.t = t + 80
    r = live.round_done(ctx, s, {"rounds": 4})
    skip = r["breaks"][-1]
    assert (r["cued"], r["preCued"], r["corner"]) == (False, True, False)  # the claim stays with the round
    assert (skip["round"], skip["kind"], skip["of"], skip["reason"]) == (4, "skip", "trailer", "overlap")


def test_a_corner_tap_logs_both_its_expand_and_its_unmute(ctx, clock):
    """The tap's two beacons leave in one tick: the one that lands second must be recorded too."""
    s = _owner(ctx)
    live.start(ctx, s, {"gameId": "gm_1", "everyRounds": 1, "adType": "corner"})
    live.round_done(ctx, s, {"rounds": 1})
    eid = _breaks_log(ctx, s)[-1]["eventId"]

    def ev(action):
        return live.ad_event(ctx, s, {"viewerId": "v-junho", "eventId": eid, "kind": "corner", "action": action})
    assert ev("impression") == {"recorded": True}
    assert ev("unmute") == {"recorded": True}
    assert ev("expand") == {"recorded": True}
    assert [ev(a) for a in ("expand", "unmute", "impression")] == [{"recorded": False}] * 3  # once per break and action
    log = viewers.log(ctx, "v-junho", clock.t)
    engaged = [viewers.text(e).split(" · ")[0] for e in log if e["type"] == "corner_engage"]
    assert sorted(engaged) == ["코너 광고 소리 켬", "코너 광고 크게 보기"]
    assert [e["type"] for e in log].count("corner_impression") == 1


@pytest.mark.parametrize("seconds, said", [(90, "1분 30초"), (47, "47초"), (60, "1분"), (150, "2분 30초"), (59, "59초"),
                                           (0, "0초")])
def test_a_playable_plays_time_reads_as_it_was(seconds, said):
    """A 90 s play reads 1분 30초, not its minutes rounded up."""
    ev = {"type": "playable", "title": "해골 왕의 지하 묘지", "genre": "arpg", "seconds": seconds,
          "minutes": round(seconds / 60, 1)}
    assert viewers.text(ev) == f"플레이어블 광고 {said} · 해골 왕의 지하 묘지"


def test_a_seeded_playable_keeps_its_whole_minutes():
    assert viewers.text({"type": "playable", "title": "골목 탐험 일기", "genre": "explore", "minutes": 3}) == \
        "플레이어블 광고 3분 · 골목 탐험 일기"


def test_a_full_trial_reported_by_the_beacon_keeps_its_seconds(ctx, clock):
    s = _playable_start(ctx, clock)
    live.round_done(ctx, s, {"rounds": 1})
    eid = _breaks_log(ctx, s)[-1]["eventId"]
    assert live.ad_event(ctx, s, {"viewerId": "v-minji", "eventId": eid, "kind": "playable", "action": "end",
                                  "seconds": 90}) == {"recorded": True}
    last = viewers.log(ctx, "v-minji", clock.t)[-1]
    assert (last["seconds"], last["minutes"]) == (90, 1.5)  # the stored minutes still weigh the play (adserver)
    assert viewers.text(last).startswith("플레이어블 광고 1분 30초 · ")
