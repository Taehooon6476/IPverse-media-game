"""Ad timing around a round's end: a break no tile showed is logged as lost and made up, the pre-cue call leaves at
the lead, the tiles measure where the ad sat, and a round that ends before its clock holds its end screen.
Fakes only."""
import pytest

from server import live, viewers
from server.tests.test_ad_styles import _breaks_log, _meta, _trailer_start, ctx  # noqa: F401
from server.tests.test_ads import _err, clock, keys  # noqa: F401
from server.tests.test_viewer_ads import _job

TILES = ["v-minji", "v-junho", "v-seoyeon", "v-hyunwoo"]
# seconds from the ivs:InsertAdBreak call to the break in the stream: on the tile that gets it first, and on a tile
# it reaches one segment later
EARLIEST_PLACE, LATEST_PLACE = 2.4, 7.5


@pytest.fixture
def waits(monkeypatch, clock):
    """The server's sleeps pass on the fake clock."""
    monkeypatch.setattr(live.time, "sleep", lambda d: setattr(clock, "t", clock.t + d))


def _watch(ctx, s):
    """The watch page's heartbeat: its tiles play, and the page reports each tile's full-screen ad."""
    return live.viewer(ctx, s, {"viewers": TILES, "reports": True})


def _pre_cue(ctx, s, clock, rounds, end, **extra):
    """The play window's report, PRECUE_PREP_SEC before the lead as it sends it."""
    send = _job(ctx)["preCueLeadSec"] + live.PRECUE_PREP_SEC
    clock.t = end - send
    return live.round_eta(ctx, s, {"round": rounds, "endsInMs": send * 1000, **extra})


def _shown(ctx, s, vid, lead_ms=None):
    return live.ad_event(ctx, s, {"viewerId": vid, "kind": "trailer", "action": "start",
                                  **({} if lead_ms is None else {"leadMs": lead_ms})})


def test_a_break_no_tile_showed_is_logged_as_lost_and_the_next_round_end_gets_one(ctx, clock, waits):
    """IVS can answer a pre-cued break with an id and never air it."""
    s = _trailer_start(ctx, clock, every=2, corner=True)
    t = clock.t
    clock.t = t + 30
    live.round_done(ctx, s, {"rounds": 1})
    assert _pre_cue(ctx, s, clock, 2, t + 60)["preCued"] is True
    clock.t = t + 60
    live.round_done(ctx, s, {"rounds": 2})
    brk = _breaks_log(ctx, s)[-1]
    assert brk["kind"] == "trailer" and not brk.get("lost")
    clock.t = viewers.epoch(brk["cuedAt"]) + live.LOST_AFTER_SEC - 5
    _watch(ctx, s)
    assert not _breaks_log(ctx, s)[-1].get("lost")  # a tile far behind may still show it
    clock.t += 6
    lost = _breaks_log(ctx, s)[-1]  # the status poll after the deadline
    assert lost["eventId"] == brk["eventId"] and lost["lost"] is True
    assert "endToAdSec" not in lost  # no "판 끝 → 광고 n초" for an ad nobody saw
    # round 3 would get a corner trailer: its end gets the full-screen break that round 2 did not
    assert _job(ctx)["makeup"] == 3
    sent = len(ctx.ivs.breaks())
    assert _pre_cue(ctx, s, clock, 3, t + 97)["preCued"] is True
    assert len(ctx.ivs.breaks()) == sent + 1
    made = _breaks_log(ctx, s)[-1]
    assert (made["round"], made["kind"], made["makeup"]) == (3, "trailer", True)
    clock.t = t + 97
    r = live.round_done(ctx, s, {"rounds": 3})
    assert (r["preCued"], r["corner"]) == (True, False)
    assert "makeup" not in _job(ctx)
    # a make-up nobody saw either is not made up again (the schedule's next break is round 4's)
    clock.t = viewers.epoch(made["cuedAt"]) + live.LOST_AFTER_SEC - 1
    _watch(ctx, s)
    clock.t += 2
    assert _breaks_log(ctx, s)[-1]["lost"] is True and "makeup" not in _job(ctx)


def test_a_break_a_tile_showed_is_not_lost(ctx, clock, waits):
    s = _trailer_start(ctx, clock, every=1)
    assert _pre_cue(ctx, s, clock, 1, clock.t + 40)["preCued"] is True
    cued = viewers.epoch(_breaks_log(ctx, s)[-1]["cuedAt"])
    clock.t = cued + 9.5
    assert _shown(ctx, s, "v-junho") == {"recorded": True}
    clock.t = cued + live.LOST_AFTER_SEC + 1
    _watch(ctx, s)
    brk = _breaks_log(ctx, s)[-1]
    assert brk["shown"] == {"v-junho": 9.5} and not brk.get("lost") and "makeup" not in _job(ctx)


def test_no_break_is_judged_without_a_watch_page_that_reports_its_tiles(ctx, clock, waits):
    """Without a reporting page nothing says whether the break aired, so the log makes no verdict."""
    s = _trailer_start(ctx, clock, every=1)
    assert _pre_cue(ctx, s, clock, 1, clock.t + 40)["preCued"] is True
    clock.t += live.LOST_AFTER_SEC + 10
    live.viewer(ctx, s, {"viewers": TILES})
    assert not _breaks_log(ctx, s)[-1].get("lost") and "makeup" not in _job(ctx)


def test_a_throttled_insert_is_sent_again_and_an_answer_without_an_id_is_no_break(ctx, clock, waits):
    s = _trailer_start(ctx, clock, every=1)
    real, fails = ctx.ivs.insert_ad_break, [_err("ThrottlingException", "InsertAdBreak")]

    def flaky(**kw):
        if fails:
            raise fails.pop()
        return real(**kw)
    ctx.ivs.insert_ad_break = flaky
    assert _pre_cue(ctx, s, clock, 1, clock.t + 40)["preCued"] is True  # nothing was inserted: safe to send again
    assert _breaks_log(ctx, s)[-1]["kind"] == "trailer"
    clock.t += 4.5
    live.round_done(ctx, s, {"rounds": 1})
    clock.t = _job(ctx)["breakUntil"] + 1
    logged = len(_breaks_log(ctx, s))
    ctx.ivs.insert_ad_break = lambda **kw: {}
    r = _pre_cue(ctx, s, clock, 2, clock.t + 40)
    assert r["preCued"] is False and len(_breaks_log(ctx, s)) == logged  # not recorded as sent
    assert "preCued" not in _job(ctx) or _job(ctx)["preCued"] != 2  # the round report cues it the normal way


def test_the_pre_cue_call_leaves_at_the_lead_whatever_the_request_and_the_files_took(ctx, clock, waits):
    """The server waits for the call's moment itself, so the ad does not move with the network or the load."""
    s = _trailer_start(ctx, clock, every=1)
    lead = _job(ctx)["preCueLeadSec"]
    assert live.status(ctx, s)["job"]["preCueSendSec"] == lead + live.PRECUE_PREP_SEC  # when the play window reports
    for n, late in enumerate((0.0, 0.7, 1.9), 1):  # the report reaches the handler this long after it was due
        end = clock.t + 40
        clock.t = end - lead - live.PRECUE_PREP_SEC + late
        assert live.round_eta(ctx, s, {"round": n, "endsInMs": (lead + live.PRECUE_PREP_SEC - late) * 1000})["preCued"] is True
        brk = _breaks_log(ctx, s)[-1]
        assert viewers.epoch(brk["cuedAt"]) == pytest.approx(end - lead, abs=0.01)
        assert brk["endToAdSec"] == round(live.STREAM_LEAD_SEC - lead, 1)
        clock.t = end
        live.round_done(ctx, s, {"rounds": n})
        clock.t = _job(ctx)["breakUntil"] + 1
    # a report that comes with less than the lead left goes at once
    end = clock.t + 40
    clock.t = end - 1
    assert live.round_eta(ctx, s, {"round": 4, "endsInMs": 1000})["preCued"] is True
    assert viewers.epoch(_breaks_log(ctx, s)[-1]["cuedAt"]) == pytest.approx(end - 1, abs=0.01)


def test_the_default_lead_keeps_every_ad_after_the_round_end(ctx, clock, waits):
    s = _trailer_start(ctx, clock, every=1)
    end = clock.t + 40
    assert _pre_cue(ctx, s, clock, 1, end)["preCued"] is True
    called = viewers.epoch(_breaks_log(ctx, s)[-1]["cuedAt"])
    assert called + EARLIEST_PLACE - end >= 0.3, "the ad would take a tile's picture before it showed the round end"
    assert called + live.STREAM_LEAD_SEC - end <= 3  # the usual place: inside 1–3 s
    assert called + LATEST_PLACE - end <= 5.5  # a tile whose break slipped a segment


def test_a_mark_rides_on_the_frame_of_the_call_and_the_tiles_measure_from_it(ctx, clock, waits):
    """The server cannot know a break's place in the stream: each tile measures it (mark → its ad) and the log
    carries what they saw."""
    s = _trailer_start(ctx, clock, every=1)
    end = clock.t + 40
    assert _pre_cue(ctx, s, clock, 1, end)["preCued"] is True
    brk = _breaks_log(ctx, s)[-1]
    calls = [c for c in ctx.ivs.calls if c[0] in ("meta", "break")]
    assert calls[-2] == ("meta", {"type": "mark", "e": brk["breakId"]}) and calls[-1][0] == "break"
    clock.t = end + 0.3
    live.round_done(ctx, s, {"rounds": 1})
    clock.t = end + 4
    for vid, ms in zip(TILES, (3400, 3600, 5600, 3600)):
        assert _shown(ctx, s, vid, ms) == {"recorded": True}
    brk = _breaks_log(ctx, s)[-1]
    assert brk["tileLead"] == {"v-minji": 3.4, "v-junho": 3.6, "v-seoyeon": 5.6, "v-hyunwoo": 3.6}
    lead = _job(ctx)["preCueLeadSec"]
    # the tiles' median less the reading's bias, against the real end
    assert brk["endToAdSec"] == round(3.6 - brk["markLeadSec"] - live.TILE_LEAD_LOG_BIAS_SEC - lead - 0.3, 1)
    assert brk["measured"] == 4
    assert _shown(ctx, s, "v-minji", 99_000) == {"recorded": False}  # not a lead: ignored


def test_the_lead_is_never_more_than_this_broadcasts_earliest_break_allows(ctx, clock, waits):
    """When a broadcast's breaks sit sooner after the call than the default assumes, the next call leaves later, so
    its ad still starts after the round's end. Never earlier than the lead the broadcast was started with."""
    s = _trailer_start(ctx, clock, every=1)
    lead = _job(ctx)["preCueLeadSec"]
    end = clock.t + 40
    _pre_cue(ctx, s, clock, 1, end)
    clock.t = end + 3
    _shown(ctx, s, "v-minji", 3600)  # a reading of 3.6 s: the break sat about 2.5 s after the call
    _shown(ctx, s, "v-junho", 6200)
    live.round_done(ctx, s, {"rounds": 1})
    clock.t = _job(ctx)["breakUntil"] + 1
    end = clock.t + 40
    short = round(3.6 - live.PRECUE_CALL_PREP_SEC - live.TILE_LEAD_BIAS_SEC - live.PRECUE_MARGIN_SEC, 2)  # (the mark that long ahead)
    assert _pre_cue(ctx, s, clock, 2, end)["leadSec"] == short < lead
    brk = _breaks_log(ctx, s)[-1]
    assert viewers.epoch(brk["cuedAt"]) == pytest.approx(end - short, abs=0.01)
    clock.t = end + 3
    _shown(ctx, s, "v-minji", 5000)  # later breaks sit later: the lead does not grow past the broadcast's own
    live.round_done(ctx, s, {"rounds": 2})
    job = _job(ctx)
    job["leadSeen"] = {"x": 5.0}
    assert live._lead_now(job) == lead


def test_a_round_cued_at_its_report_tells_the_play_window_to_hold_its_end_screen(ctx, clock, waits):
    """A break cued at the round report sits later than the built-in player's 4 s end screen, so the next round
    would already run under the ad."""
    s = _trailer_start(ctx, clock, every=1)
    clock.t += 130
    r = live.round_done(ctx, s, {"rounds": 1})
    assert r["cued"] is True and r["holdSec"] == live.END_HOLD_SEC >= LATEST_PLACE
    clock.t = _job(ctx)["breakUntil"] + 1
    end = clock.t + 40
    _pre_cue(ctx, s, clock, 2, end)
    clock.t = end
    r = live.round_done(ctx, s, {"rounds": 2})
    # a pre-cued ad can still start after the 4 s end screen: held until the latest place, less the lead already spent
    assert r["preCued"] is True and r["holdSec"] == round(live.PRECUE_PLACE_MAX_SEC - _job(ctx)["roundEta"]["endsAt"] + _job(ctx)["roundEta"]["callAt"], 1)


def test_an_estimated_end_is_cued_later_and_can_be_called_off_until_the_call(ctx, clock, waits):
    """A race's last stretch at its pace: an estimate, not a clock. The call leaves PRECUE_EST_MARGIN_SEC later than
    for a clock's end, so a round that ends that much after its estimate still has its ad after its end; and the play
    window takes the estimate back when the car slows before the call."""
    s = _trailer_start(ctx, clock, every=1)
    lead = _job(ctx)["preCueLeadSec"]
    end = clock.t + 130
    r = _pre_cue(ctx, s, clock, 1, end, estimated=True)
    assert r["preCued"] is True and r["leadSec"] == lead - live.PRECUE_EST_MARGIN_SEC
    brk = _breaks_log(ctx, s)[-1]
    assert viewers.epoch(brk["cuedAt"]) == pytest.approx(end - lead + live.PRECUE_EST_MARGIN_SEC, abs=0.01)
    assert brk["estimated"] is True
    clock.t = end + live.PRECUE_EST_MARGIN_SEC  # the round ended that much later than estimated
    live.round_done(ctx, s, {"rounds": 1})
    assert viewers.epoch(brk["cuedAt"]) + EARLIEST_PLACE - clock.t >= 0.3
    # round 2: the car hits a wall while the server waits for the call's moment
    clock.t = _job(ctx)["breakUntil"] + 1
    end = clock.t + 130
    sent = len(ctx.ivs.breaks())
    real = live.time.sleep

    def crash(d):  # the play window's cancel arrives during the wait
        real(d)
        assert live.round_eta(ctx, s, {"round": 2, "cancel": True}) == {"preCued": False, "reason": "called_off"}
    live.time.sleep = crash
    try:
        r = _pre_cue(ctx, s, clock, 2, end, estimated=True)
    finally:
        live.time.sleep = real
    assert r == {"preCued": False, "reason": "called_off"} and len(ctx.ivs.breaks()) == sent
    assert _breaks_log(ctx, s)[-1]["round"] == 1 and _job(ctx)["breakUntil"] == 0  # nothing logged, the files free
    clock.t = end + 6
    r = live.round_done(ctx, s, {"rounds": 2})  # the cue at the round report, with the end screen held
    assert r["cued"] is True and r["holdSec"] == live.END_HOLD_SEC
