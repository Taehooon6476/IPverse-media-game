"""Pre-cue timing: the call leaves on time despite slow reads and marks, the round's end is the instant the play
window names, the log never reads an ad before the end, and one short reading barely shortens the lead. Fakes only."""
import pytest

from server import live, viewers
from server.tests.test_ad_styles import _breaks_log, _trailer_start, ctx  # noqa: F401
from server.tests.test_ads import clock, keys  # noqa: F401
from server.tests.test_round19_ad_timing import TILES, _pre_cue, _shown, waits  # noqa: F401
from server.tests.test_viewer_ads import _job


def test_the_look_at_the_job_and_the_mark_are_done_before_the_calls_moment(ctx, clock, waits, monkeypatch):
    s = _trailer_start(ctx, clock, every=1)
    lead = _job(ctx)["preCueLeadSec"]
    real_get, real_meta = live._get_json, live._meta
    slow = []

    def get(c, key):  # a read of the job takes 0.15 s while the call waits
        if key == live.JOB_KEY and slow:
            clock.t += 0.15
        return real_get(c, key)

    def meta(c, payload):  # ivs:PutMetadata takes 0.3 s
        clock.t += 0.3
        return real_meta(c, payload)
    monkeypatch.setattr(live, "_get_json", get)
    monkeypatch.setattr(live, "_meta", meta)
    end = clock.t + 40
    slow.append(True)
    assert _pre_cue(ctx, s, clock, 1, end, endsAtMs=end * 1000)["preCued"] is True
    slow.clear()
    brk = _breaks_log(ctx, s)[-1]
    assert viewers.epoch(brk["cuedAt"]) == pytest.approx(end - lead, abs=0.05)
    # the mark left that long before the call: the tiles' readings are that much longer, and the log knows
    assert 0.3 <= brk["markLeadSec"] <= live.PRECUE_CALL_PREP_SEC


def test_the_round_end_is_the_instant_the_play_window_names_not_the_reports_arrival(ctx, clock, waits):
    """The report arrives about 0.5 s after the play page's own round-end event."""
    s = _trailer_start(ctx, clock, every=1)
    lead = _job(ctx)["preCueLeadSec"]
    end = clock.t + 40
    _pre_cue(ctx, s, clock, 1, end, endsAtMs=end * 1000)
    clock.t = end + 0.5
    live.round_done(ctx, s, {"rounds": 1, "endedAtMs": end * 1000})
    brk = _breaks_log(ctx, s)[-1]
    assert viewers.epoch(brk["roundEndAt"]) == pytest.approx(end, abs=0.01)
    assert brk["endToAdSec"] == round(live.STREAM_LEAD_SEC - lead, 1)
    assert "holdSec" not in live.round_done(ctx, s, {"rounds": 1, "endedAtMs": end * 1000})
    clock.t += 60
    live.round_done(ctx, s, {"rounds": 2, "endedAtMs": (clock.t + 2) * 1000})  # an instant after the arrival: not taken
    assert _job(ctx)["roundEndAt"] == clock.t


def test_the_log_never_reads_an_ad_before_the_end_from_the_tiles_readings(ctx, clock, waits):
    """The tiles' readings run only slightly over the pictures, so the bias taken off must not make the log negative."""
    s = _trailer_start(ctx, clock, every=1)
    lead = _job(ctx)["preCueLeadSec"]
    end = clock.t + 40
    _pre_cue(ctx, s, clock, 1, end)
    clock.t = end
    live.round_done(ctx, s, {"rounds": 1})
    clock.t = end + 5
    for vid, sec in zip(TILES, (3.72, 3.85, 3.99, 5.9)):
        _shown(ctx, s, vid, sec * 1000)
    brk = _breaks_log(ctx, s)[-1]
    mark = brk["markLeadSec"]
    assert brk["endToAdSec"] == round(3.92 - mark - live.TILE_LEAD_LOG_BIAS_SEC - lead, 1) > 0
    for vid in TILES:
        _shown(ctx, s, vid, 2100)  # readings that would put the ad before the end: the log says 0, not less
    assert _breaks_log(ctx, s)[-1]["endToAdSec"] == 0


def test_a_short_reading_shortens_the_lead_only_as_far_as_it_must(ctx, clock, waits):
    """The lead is at most PRECUE_LEAD_MAX_SEC (a break can sit as soon as 2.4 s after its call), and a reading
    only shortens it when the break really sat sooner than that allows."""
    s = _trailer_start(ctx, clock, every=1)
    job = _job(ctx)
    lead = job["preCueLeadSec"]
    job["leadSeen"] = {"a": 5.2, "b": 5.6}
    assert live._lead_now(job) == live.PRECUE_LEAD_MAX_SEC >= lead
    job["leadSeen"]["c"] = 3.72 - 0.6  # the mark 0.6 s before the call
    assert live._lead_now(job) == round(3.12 - live.TILE_LEAD_BIAS_SEC - live.PRECUE_MARGIN_SEC, 2) >= 1.9
    job["leadSeen"]["d"] = 2.5  # a break that sat 2 s after its call
    assert live._lead_now(job) == round(2.5 - live.TILE_LEAD_BIAS_SEC - live.PRECUE_MARGIN_SEC, 2)
    # the earliest a break sits (2.4 s) at the longest lead: still after the end
    assert 2.4 - live.PRECUE_LEAD_MAX_SEC >= 0.19
