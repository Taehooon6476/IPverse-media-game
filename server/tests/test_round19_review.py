"""Pre-cue edge cases: a round that ends while the server waits for the pre-cue's moment, a job without a timed
lead, a watch page that went away before the verdict, a tile's short reading, and a tile's report that names its
break. Fakes only."""
import json

import pytest

from server import live, viewers
from server.tests.test_ad_styles import _breaks_log, _trailer_start, ctx  # noqa: F401
from server.tests.test_ads import clock, keys  # noqa: F401
from server.tests.test_round19_ad_timing import LATEST_PLACE, _pre_cue, _shown, _watch, waits  # noqa: F401
from server.tests.test_viewer_ads import _job


def _put_job(ctx, job):
    ctx.s3._store[("live-b", live.JOB_KEY)] = json.dumps(job).encode()


def _during_the_wait(monkeypatch, clock, at, then):
    """The server's sleeps pass on the fake clock, and `then` runs once, when the clock first reaches `at`."""
    done = []

    def sleep(d):
        clock.t += d
        if not done and clock.t >= at - 1e-6:
            done.append(True)
            then()
    monkeypatch.setattr(live.time, "sleep", sleep)


@pytest.mark.parametrize("estimated", [False, True])
def test_a_round_that_ends_during_the_pre_cues_wait_gets_its_break_at_once_and_its_end_screen_held(
        ctx, clock, monkeypatch, estimated):
    """A death during the wait, before the told end: the call leaves at once, the report carries holdSec, and the
    log counts from the end that came."""
    s = _trailer_start(ctx, clock, every=1)
    lead = _job(ctx)["preCueLeadSec"]
    end = clock.t + 40
    died = end - lead - live.PRECUE_PREP_SEC + 3 * live.PRECUE_POLL_SEC  # 1.2 s into the wait
    answers = []
    _during_the_wait(monkeypatch, clock, died, lambda: answers.append(live.round_done(ctx, s, {"rounds": 1})))
    assert _pre_cue(ctx, s, clock, 1, end, **({"estimated": True} if estimated else {}))["preCued"] is True
    r = answers[0]
    assert r["preCued"] is True and not r["cued"]
    brk = _breaks_log(ctx, s)[-1]
    called, ended = viewers.epoch(brk["cuedAt"]), viewers.epoch(brk["roundEndAt"])
    assert ended == pytest.approx(died, abs=0.01)  # the end that came, not the one that was told
    # sent as soon as the waiting call sees the round is over: after the real end, never before it
    assert 0 <= called - ended <= live.PRECUE_POLL_SEC + 0.01
    # the end screen stays until the ad has every tile's picture, counted from the report
    assert r["holdSec"] >= called - ended + LATEST_PLACE
    assert brk["endToAdSec"] == round(called + live.STREAM_LEAD_SEC - ended, 1)


def test_a_round_that_ends_early_after_its_pre_cue_left_still_holds_its_end_screen(ctx, clock, waits):
    """A death after the break was sent for the told end: the ad sits up to 7.5 s after the call, past the built-in
    player's 4 s of end screen."""
    s = _trailer_start(ctx, clock, every=1)
    end = clock.t + 40
    _pre_cue(ctx, s, clock, 1, end)
    called = viewers.epoch(_breaks_log(ctx, s)[-1]["cuedAt"])
    clock.t = called + 0.6  # 1.4 s before the told end
    r = live.round_done(ctx, s, {"rounds": 1})
    assert r["preCued"] is True and r["holdSec"] >= LATEST_PLACE - 0.6
    clock.t = _job(ctx)["breakUntil"] + 1
    end = clock.t + 40
    _pre_cue(ctx, s, clock, 2, end)
    clock.t = end + 0.3  # the round ended by its clock: held only as long as its break can take (no early-end hold)
    assert live.round_done(ctx, s, {"rounds": 2})["holdSec"] <= live.PRECUE_PLACE_MAX_SEC


def test_a_broadcast_started_before_the_call_was_timed_keeps_no_lead_longer_than_the_default(ctx, clock, waits):
    """An older job's preCueLeadSec 4.5 meant the play window's report, not the call: as a call lead it would put
    the ad before the round's end."""
    s = _trailer_start(ctx, clock, every=1)
    job = _job(ctx)
    job["preCueLeadSec"] = 4.5
    del job["leadAtCall"]
    _put_job(ctx, job)
    assert live.status(ctx, s)["job"]["preCueSendSec"] == live.PRECUE_LEAD_SEC + live.PRECUE_PREP_SEC
    end = clock.t + 40
    clock.t = end - 4.5
    assert live.round_eta(ctx, s, {"round": 1, "endsInMs": 4500})["leadSec"] == live.PRECUE_LEAD_SEC
    assert viewers.epoch(_breaks_log(ctx, s)[-1]["cuedAt"]) == pytest.approx(end - live.PRECUE_LEAD_SEC, abs=0.01)


def test_a_watch_page_that_went_away_before_the_verdict_leaves_the_break_unjudged(ctx, clock, waits):
    """A page closed, reloaded or switched before any tile showed the ad gives no lost verdict and no make-up."""
    s = _trailer_start(ctx, clock, every=1)
    assert _pre_cue(ctx, s, clock, 1, clock.t + 40)["preCued"] is True
    cued = viewers.epoch(_breaks_log(ctx, s)[-1]["cuedAt"])
    clock.t = cued + 2
    _watch(ctx, s)  # its last beat: the page is closed before its tiles reach the break
    clock.t = cued + live.LOST_AFTER_SEC + 1
    assert not _breaks_log(ctx, s)[-1].get("lost") and "makeup" not in _job(ctx)
    assert "airCheck" not in _job(ctx)  # and it is not judged later either


def test_a_tiles_lead_shorter_than_any_break_ever_sat_is_not_a_measurement(ctx, clock, waits):
    """The mark reaches the page through a timer that a hidden or throttled tab delays, so mark → ad can read
    shorter than any break sits (2.4 s at the earliest)."""
    s = _trailer_start(ctx, clock, every=1)
    end = clock.t + 40
    _pre_cue(ctx, s, clock, 1, end)
    clock.t = end + 3
    assert _shown(ctx, s, "v-minji", 400) == {"recorded": True}  # the ad's start counts: the break aired
    brk = _breaks_log(ctx, s)[-1]
    assert brk["shown"].keys() == {"v-minji"} and "tileLead" not in brk and "leadSeen" not in _job(ctx)
    assert live._lead_now(_job(ctx)) == _job(ctx)["preCueLeadSec"]


def test_a_tiles_report_is_credited_to_the_break_whose_mark_it_names(ctx, clock, waits):
    """A report that names a break goes to that break, not to the newest one."""
    s = _trailer_start(ctx, clock, every=1)
    t = clock.t
    _pre_cue(ctx, s, clock, 1, t + 20)
    first = _breaks_log(ctx, s)[-1]
    clock.t = t + 20
    live.round_done(ctx, s, {"rounds": 1})
    job = _job(ctx)
    job.update(airUntil=0, breakUntil=0)  # (a short ad: the next round's break may follow)
    _put_job(ctx, job)
    _pre_cue(ctx, s, clock, 2, t + 50)
    second = _breaks_log(ctx, s)[-1]
    assert second["round"] == 2 and second["breakId"] != first["breakId"]
    clock.t = t + 52
    late = {"viewerId": "v-junho", "kind": "trailer", "action": "start", "leadMs": 5200}
    assert live.ad_event(ctx, s, {**late, "eventId": first["breakId"]}) == {"recorded": True}  # a tile 30 s behind
    one, two = _breaks_log(ctx, s)[-2:]
    assert one["tileLead"] == {"v-junho": 5.2} and "shown" not in two
    # no mark (the broadcast console's player, a tile that had just reloaded): the newest break
    assert live.ad_event(ctx, s, {"viewerId": "", "eventId": "", "kind": "trailer", "action": "start"}) == {"recorded": True}
    assert "" in _breaks_log(ctx, s)[-1]["shown"]
