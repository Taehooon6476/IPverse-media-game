"""Pre-cue timing on the server's clock: the call leaves at the lead before the end the play window names (not
counted from the request's arrival), the lead follows the tiles' readings, and a break no tile played is not logged
as shown. Fakes only."""
import pytest

from server import live, viewers
from server.tests.test_ad_styles import _breaks_log, _trailer_start, ctx  # noqa: F401
from server.tests.test_ads import clock, keys  # noqa: F401
from server.tests.test_round19_ad_timing import TILES, _pre_cue, _shown, _watch, waits  # noqa: F401
from server.tests.test_viewer_ads import _job

TRANSIT = 1.2  # seconds from the play window's request to the handler (auth, transit)
PLACE = (4.1, 5.7)  # seconds from the call to the ad on a tile's picture


def test_the_call_leaves_at_the_lead_before_the_end_the_play_window_names_on_the_servers_clock(ctx, clock, waits):
    s = _trailer_start(ctx, clock, every=1)
    lead = _job(ctx)["preCueLeadSec"]
    assert live.status(ctx, s)["now"] == clock.t  # the play window learns the server's clock from its status polls
    end = clock.t + 40
    send = live.status(ctx, s)["job"]["preCueSendSec"]
    assert send >= lead + TRANSIT + 1.9  # the request's way and the picks (0.9–1.9 s) fit before the call
    clock.t = end - send + TRANSIT  # the handler gets it 1.2 s after it was sent
    r = live.round_eta(ctx, s, {"round": 1, "endsInMs": send * 1000, "endsAtMs": end * 1000})
    assert r["preCued"] is True
    brk = _breaks_log(ctx, s)[-1]
    assert viewers.epoch(brk["cuedAt"]) == pytest.approx(end - lead, abs=0.01)
    assert viewers.epoch(brk["expectedEndAt"]) == pytest.approx(end, abs=0.01)


@pytest.mark.parametrize("off, why", [(0.4, "later than the request allows"), (-4.0, "sooner than any transit"),
                                      ("x", "not a number")])
def test_an_end_instant_the_request_cannot_have_meant_falls_back_to_the_seconds_left(ctx, clock, waits, off, why):
    """A page clock that jumped, a wrong offset: the end is never taken earlier than 3 s before, nor later than, the
    one counted from the handler (which is late by the transit: the safe side)."""
    s = _trailer_start(ctx, clock, every=1)
    lead = _job(ctx)["preCueLeadSec"]
    counted = clock.t + 4
    at = off if isinstance(off, str) else (counted + off) * 1000
    live.round_eta(ctx, s, {"round": 1, "endsInMs": 4000, "endsAtMs": at})
    assert viewers.epoch(_breaks_log(ctx, s)[-1]["cuedAt"]) == pytest.approx(counted - lead, abs=0.01), why


def test_the_wait_never_sleeps_a_negative_time_when_reading_the_job_takes_the_rest_of_it(ctx, clock, monkeypatch):
    """Reading the job can use up the wait's remainder: a negative sleep would fail the pre-cue with the round
    claimed, and that round would get no ad."""
    s = _trailer_start(ctx, clock, every=1)
    slept = []
    monkeypatch.setattr(live.time, "sleep", lambda d: (slept.append(d), setattr(clock, "t", clock.t + d)))
    real = live._get_json

    def slow(c, key):  # each read of the job takes 0.3 s
        if key == live.JOB_KEY and slept:
            clock.t += 0.3
        return real(c, key)
    monkeypatch.setattr(live, "_get_json", slow)
    assert _pre_cue(ctx, s, clock, 1, clock.t + 40)["preCued"] is True
    assert slept and min(slept) >= 0


def test_the_lead_follows_what_this_broadcasts_tiles_measured_in_both_directions(ctx, clock, waits):
    """A tile's reading is the place plus about 1.1 s. The lead is the earliest place of the last breaks less 1 s,
    once two breaks were measured, and never more than PRECUE_LEAD_MAX_SEC."""
    s = _trailer_start(ctx, clock, every=1)
    lead = _job(ctx)["preCueLeadSec"]
    readings = [(5.2, 5.9, 6.8, 5.4), (5.6, 5.3, 6.1, 7.0)]  # place 4.1–5.7 + 1.1
    for n, tiles in enumerate(readings, 1):
        end = clock.t + 40
        assert _pre_cue(ctx, s, clock, n, end)["leadSec"] == lead  # one break measured: not yet longer
        clock.t = end + 0.3
        live.round_done(ctx, s, {"rounds": n})
        clock.t = end + 6
        for vid, sec in zip(TILES, tiles):
            _shown(ctx, s, vid, sec * 1000)
        clock.t = _job(ctx)["breakUntil"] + 1
    brk = _breaks_log(ctx, s)[-1]
    mark = brk["markLeadSec"]  # the mark left that long before the call
    # the log's 판 끝 → 광고: the tiles' median less the mark's head start and the least the readings are over
    assert brk["endToAdSec"] == round(5.85 - mark - live.TILE_LEAD_LOG_BIAS_SEC - lead - 0.3, 1)
    # the lead follows the breaks only up to PRECUE_LEAD_MAX_SEC (a break can sit as soon as 2.4 s after its call)
    want = live.PRECUE_LEAD_MAX_SEC
    assert live._lead_now(_job(ctx)) == want > lead
    assert live.status(ctx, s)["job"]["preCueSendSec"] == want + live.PRECUE_PREP_SEC
    end = clock.t + 40
    assert _pre_cue(ctx, s, clock, 3, end)["leadSec"] == want
    called = viewers.epoch(_breaks_log(ctx, s)[-1]["cuedAt"])
    assert 1.0 <= called + PLACE[0] - end and called + PLACE[1] - end <= 3.6  # the ad 1.9–3.5 s after the end
    clock.t = end + 6
    _shown(ctx, s, "v-minji", 3300)  # a break that sat sooner than the lead allows: the next lead is shorter at once
    assert live._lead_now(_job(ctx)) == round(3.3 - mark - live.TILE_LEAD_BIAS_SEC - live.PRECUE_MARGIN_SEC, 2) < lead
    job = _job(ctx)
    job["leadSeen"] = {"a": 9.0, "b": 9.5}
    assert live._lead_now(job) == live.PRECUE_LEAD_MAX_SEC  # readings that long are not followed all the way


def test_a_break_during_which_no_tile_played_is_not_said_to_have_been_shown(ctx, clock, waits):
    """The page beats only for tiles that play. An open page whose players all stalled cannot tell a lost break
    from its own stall, so there is no make-up; the log says the break was not confirmed."""
    s = _trailer_start(ctx, clock, every=1)
    end = clock.t + 40
    _pre_cue(ctx, s, clock, 1, end)
    cued = viewers.epoch(_breaks_log(ctx, s)[-1]["cuedAt"])
    clock.t = end
    live.round_done(ctx, s, {"rounds": 1})
    clock.t = cued + live.LOST_AFTER_SEC + 1
    brk = _breaks_log(ctx, s)[-1]
    assert brk["unseen"] is True and not brk.get("lost") and "makeup" not in _job(ctx)
    clock.t += 5
    _watch(ctx, s)
    assert _shown(ctx, s, "v-junho", 5000) == {"recorded": True}  # a tile far behind shows it after all
    brk = _breaks_log(ctx, s)[-1]
    assert "unseen" not in brk and brk["measured"] == 1
