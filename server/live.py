"""Gameplay live stream: Amazon IVS end to end; ads by IVS server-side ad insertion with AWS Elemental MediaTailor.

The play window publishes its game canvas to the IVS low-latency channel (Web Broadcast SDK) and reports each
finished round to /live/round. Viewers play the channel's IVS playback URL with the Amazon IVS Player. Every
everyRounds-th round:
  trailer   one VAST per viewer (vast/ivs/p-<viewerId>.xml, p-.xml = the default ad; server/adserver.py picks each
            dummy viewer's campaign from its activity log, server/viewers.py), then ivs:InsertAdBreak. The channel
            is private: each viewer's playback token carries its persona, and IVS asks MediaTailor (playback
            configuration "ipverse-ivs", ADS = p-[player_params.persona].xml on the live CDN) per viewer, then
            stitches that viewer's transcoded trailer into its playlist about AD_LEAD_SEC after the call.
  playable  ivs:PutMetadata {"type": "playable", "e": <eventId>, ...}: ID3 timed metadata on the frame that ended the
            round, so a viewer's card shows when their video reaches that moment. Each viewer's card offers its own
            game (adserver kind "playable"). The watch page keeps one game-agnostic GameLift Streams session hidden
            (the launcher, server/playable.py); the web stream group holds an idle host while the broadcast runs and
            from the control room's pre-warm (PREWARM_SEC). The first card waits for a CONNECTED launcher
            (LAUNCHER_GATE_SEC at most; a held round shows corner trailers).
  corner    ivs:PutMetadata {"type": "corner", "e": <eventId>}: each viewer's own trailer in a small muted
            picture-in-picture the player draws for CORNER_SEC; no MediaTailor and no ad break, so it lands on the
            round's end exactly. With corner=True a broadcast shows one at every round that is not its every-N-th.

Pre-cue: a round whose end is known ahead is reported by the play window (/live/round-eta) and ivs:InsertAdBreak
leaves when exactly the lead is left, so the stitched ad starts a moment after the round's end on each viewer's
picture. A round not known ahead is cued at its report, and the built-in player holds the end screen END_HOLD_SEC.
Whether a full-screen break aired is the watch page's word: a break no tile showed is logged as lost and made up at
the next round's end (_check_aired); the tiles' own readings bound the lead (_ad_shown).

Warm-ups: MediaTailor skips a creative it has not transcoded yet (SkippedReason.NewCreative) and transcodes it for
next time, so each new creative gets a 1 s warm-up break while the tiles play, WARM_HOLD_SEC apart, never during a
break or a trailer round's cue window (_cue_due). A trailer cue never waits: each viewer gets its best creative whose
warm-up is TRANSCODE_SEC old, and with none ready the round gets corner trailers instead. Every break reads the same
per-persona files (fixed URLs), so a break owns them until its ad requests are done (breakUntil).

Highlights (player mode): the server cuts each round from the channel's IVS recording (server/recording.py), Bedrock
Pegasus finds the best 4–6 s, ffmpeg cuts a 9:16 short and a 16:9 cut. Overlay = timed metadata the viewer draws
(IVS ad insertion is linear only); linear = an ad break like the trailer.

job.json is updated with S3 conditional writes so concurrent handlers never drop each other's fields. There is one
live channel: it belongs to the owner on air while its play window beats (_alive). Another account's start is
refused, and the stream key, the playback token and the viewers' activity go to that owner alone (_claim_start).
One-time setup (channel offline): scripts/setup_ivs_ads.py.
"""
from __future__ import annotations
import json
import math
import os
import pathlib
import re
import subprocess
import tempfile
import time
import uuid

from botocore.exceptions import ClientError, ParamValidationError

from server import ads, adserver, recording, store, viewers, waits
from server import i18n
from server.i18n import said, tr

MAX_MINUTES = 45
PEGASUS = "us.twelvelabs.pegasus-1-5-v1:0"
HL_KINDS = ("overlay", "linear")
HL_MIN, HL_MAX = 4.0, 6.0
BEAT_TIMEOUT_SEC = 120
IVS_CHANNEL = os.environ.get("LIVE_IVS_CHANNEL_NAME", "ipverse-live-player")
JOB_KEY, STATUS_KEY = "broadcaster/job.json", "broadcaster/status.json"
VAST_KEY = ads.vast_key("")  # the default ad (no persona); each persona has its own file next to it
AD_LEAD_SEC = 11  # InsertAdBreak → the stitched ad on a viewer's screen (measured on this channel: 9.7–14.4 s)
# InsertAdBreak → the break's place in the stream, which each viewer reaches its own delay later: usually 3.0–5.5 s
# (the next keyframe of the WebRTC ingest), sometimes one segment later for a playback session. Both are IVS's
STREAM_LEAD_SEC = 4.5
BREAK_MARGIN_SEC = 15  # after its place: viewers behind live still ask MediaTailor for the break's ads
# a warm-up's 1 s break: its ad requests come when the tiles (~4 s behind live) reach it, so a trailer cue may take
# the files from it this long after its call instead of waiting out the full margin
WARM_HOLD_SEC = AD_LEAD_SEC + 1 + 5
AD_STYLES = ("trailer", "playable", "corner")
CORNER_SEC = 12  # a corner trailer shows this long (10–15 s), muted, the broadcast keeps playing
# a pre-cue sends InsertAdBreak this long before a round's known end (0 = off). A break has sat as soon as 2.4 s
# after its call, so 2 s keeps every ad after the round's end
PRECUE_LEAD_SEC = float(os.environ.get("PRECUE_LEAD_SEC", 2.0))
PRECUE_SLACK_SEC = 3  # an ETA reported more than lead + this early is answered "send again later"
# the play window reports a round's end this long before the lead, so the request's way, the picks and the VAST files
# are done when the call has to leave. It names the end as an instant of the server's clock (endsAtMs)
PRECUE_PREP_SEC = 3.5
# the end instant a play window names is taken when it is no later than, and at most this much sooner than, the end
# counted from the handler (which is late by the request's way: the safe side); else that one stands
PRECUE_TRANSIT_MAX_SEC = 3.0
# an end the game only estimates (a race's last stretch at its pace, not a clock): the call leaves this much later, so
# a round that ends up to this much after its estimate still has its ad after its end
PRECUE_EST_MARGIN_SEC = 1.0
# The broadcast's own tiles measure where their breaks sat after the call (the mark → their ad, _ad_shown); a reading
# runs over the true place by the play window's frame-to-IVS delay, which grows with its load. The lead follows the
# earliest tile's reading of the last PRECUE_SEEN breaks less TILE_LEAD_BIAS_SEC and PRECUE_MARGIN_SEC, once
# PRECUE_SEEN_MIN breaks were measured, never past PRECUE_LEAD_MAX_SEC: a break can sit as soon as 2.4 s after its
# call whatever the ones before it did, and no ad may start before its round's end is seen. The break list shows the
# median reading less TILE_LEAD_LOG_BIAS_SEC, so it never reads sooner than the pictures
TILE_LEAD_BIAS_SEC = 0.6
TILE_LEAD_LOG_BIAS_SEC = 0.3
PRECUE_MARGIN_SEC = 0.6
PRECUE_SEEN = 5
PRECUE_SEEN_MIN = 2
PRECUE_LEAD_MAX_SEC = float(os.environ.get("PRECUE_LEAD_MAX_SEC", 2.2))
# what the last look at the job (an S3 read) and the mark (ivs:PutMetadata) take before the call (measured 0.45–0.65 s)
PRECUE_CALL_PREP_SEC = 0.8
# a tile's mark → ad reading under this is no measurement: a hidden or throttled tab delays the mark's timer, the
# reading comes out short, and one such reading would cut the lead for the next PRECUE_SEEN breaks
MIN_TILE_LEAD_SEC = 2.0
# while the pre-cue's call waits for its moment it looks at the job this often: a round that ended meanwhile (a death,
# an early clear) gets its break at once, and a taken-back estimate is called off without waiting the rest
PRECUE_POLL_SEC = 0.4
# a round that ended this much before the end it had told ended early: its ad was timed for the told end
EARLY_END_SEC = 0.5
WATCH_FRESH_SEC = 20  # a watch page whose last reporting beat (every 15 s) is older than this is gone
# a full-screen break no tile showed this long after its call, with a watch page open that reports its tiles' ads,
# did not air (InsertAdBreak can answer 200 and no playlist carry the break). A tile shows its ad 6–13 s after the
# call, up to 22 s when it has fallen behind
LOST_AFTER_SEC = 30
SHOWN_WINDOW_SEC = 60  # a tile's report of its ad's start counts for the newest break this long after its call
# a round whose ad is cued at its report (its end was not known ahead): the built-in player keeps the round's end
# screen this long, so the ad starts over it and not over the next round (a break sits up to 7.5 s after its call)
END_HOLD_SEC = 8
# ivs:InsertAdBreak errors that inserted nothing and may pass: sent again at once
AD_BREAK_RETRY = ("ConflictException", "ThrottlingException", "InternalServerException", "ServiceUnavailableException")
TRANSCODE_SEC = 90  # after a warm-up: MediaTailor's transcode of a short creative is done (measured ~1 min)
# A trailer round with no trailer ready to air: what its corner entry of the break log says (_cue_trailer). The first:
# a warm-up went out and is not TRANSCODE_SEC old yet. The second: none went out yet, which takes a playing viewer
AD_WARMING = "전체 화면 트레일러를 준비하고 있어요({wait}). 이번 판은 코너 트레일러를 보냈어요."
AD_NOT_STARTED = "전체 화면 트레일러는 시청 창을 열어 두면 준비를 시작해요({wait}). 이번 판은 코너 트레일러를 보냈어요."
AD_WARMING_NOTE = AD_WARMING.format(wait=waits.TRAILER_PREP)
AD_NOT_STARTED_NOTE = AD_NOT_STARTED.format(wait=waits.TRAILER_PREP)
STREAM_CACHE_SEC = 3  # ivs:GetStream is 5 TPS per account: the status polls of all windows share one answer
WARM_DEPTH = 3  # each viewer's top 3 are warmed up front: the frequency cap (2 breaks) moves a viewer down its list
# a full-screen break is sized to end this long before the next round's corner trailer shows (stream time)
CORNER_GAP_SEC = 2
MIN_BREAK_SEC = 5  # less room than this before the next ad: the trailer is skipped and the schedule stays
CORNER_WAIT_SEC = 10  # a tile may hold a corner behind a running full-screen ad this long when the round length is unknown
INVENTORY_KEY = "broadcaster/inventory.json"  # the campaigns of the running broadcast, refreshed after each break
# the saved list's shape: a list saved in an older shape is read again
INVENTORY_VERSION = 2
INVENTORY_REUSE_SEC = 10 * 60  # a start reuses a list this fresh (reading 60 sessions takes seconds)
DEAD_PUBLISH_SEC = 180  # on air but the IVS stream has not been live for this long: the publish died
# creatives MediaTailor has already been shown (url -> when), across jobs. v2: warm-ups are per creative id, and the
# per-persona VAST gave every creative a new id
WARM_REGISTRY = "broadcaster/warmed-v2.json"
STANDBY_KEY = "broadcaster/standby.json"  # the control room's switch: {"mode": "on"|"off", "until", "by", "at"}
MANUAL_HOLD_SEC = 60 * 60  # a host held by hand (before a broadcast) goes away on its own after this
# a switch from playable to trailer keeps the idle host this long, so a switch back finds it warm (a cold host takes
# waits.CLOUD_START_SEC); it goes at the first status poll or reap after this, at once on stop or the switch OFF
STANDBY_GRACE_SEC = 5 * 60
# the control room's playable tab, before a broadcast: the idle host is held this long (a cold host takes
# waits.CLOUD_START_SEC), so the broadcast's launchers connect in seconds; a start makes it the job's. Unused, it
# goes at the control room's first standby poll after this, or at the reap with no control room open
PREWARM_SEC = 10 * 60
# the first playable card waits until a launcher is CONNECTED (a click can use it at once), at most this long
# ponytail: sized for a ~105 s cold host; a slower host outlasts it and the cards go up with no launcher connected
LAUNCHER_GATE_SEC = 150
GLS_HOURLY_USD = 1.512  # gen4n_win2022 in us-west-2, AWS Price List (2026-11): what one held host costs an hour
# the live bucket is the live CDN's origin (public): the owner's standby token lives in the assets bucket's private
# streams/ prefix instead (the main CDN serves only /sessions, /games and /runtime there)
TOKEN_KEY = "streams/live/standby-token.json"


class LiveError(Exception):
    def __init__(self, status: int, code: str, message: str):
        message = said(message)  # in the request's language: the sentence is written where it is raised
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


# What a window of a broadcast that is not (or no longer) this session's is told
NOT_ON_TEXT = "이 세션의 라이브가 켜져 있지 않아요. 라이브를 켠 뒤 다시 해 주세요."
REPLACED_TEXT = "이 방송은 다른 방송으로 바뀌었어요."


def _env(name):
    value = os.environ.get(name, "")
    if not value:
        raise LiveError(503, "live_unavailable", "이 환경에는 라이브 방송이 설치되어 있지 않아요. 관리자에게 문의해 주세요.")
    return value


vast = ads.vast  # VAST 3.0, one linear MP4 creative (server/ads.py)


def _code(e: ClientError) -> str:
    return e.response.get("Error", {}).get("Code", "")


def _put(ctx, key, body, content_type, **kw):
    ctx.s3.put_object(Bucket=_env("LIVE_BUCKET"), Key=key, Body=body.encode(), ContentType=content_type,
                      CacheControl="no-cache", **kw)


def _read(ctx, key):
    """(parsed JSON or None, ETag or None)."""
    try:
        obj = ctx.s3.get_object(Bucket=_env("LIVE_BUCKET"), Key=key)
        data = obj["Body"].read()
        return (json.loads(data) if data else None), obj.get("ETag")
    except ClientError as e:
        if _code(e) in ("NoSuchKey", "404"):
            return None, None
        raise


def _get_json(ctx, key):
    return _read(ctx, key)[0]


def _rmw(ctx, key, change, job_id=None) -> dict:
    """Read-modify-write a JSON file with an S3 conditional write (If-Match the ETag read; If-None-Match for a file
    that was not there, so two first writes cannot both land: a start's claim of the channel), retried when another
    handler wrote in between, so concurrent handlers never drop each other's fields. change(doc) edits in place and
    returns False to leave the file alone; job_id: only that job's file. → the document (as written or as read), or
    None when the file now belongs to another job (callers stop: never act on another job's document)."""
    for _ in range(6):
        doc, etag = _read(ctx, key)
        doc = doc or {}
        if job_id and doc.get("jobId") != job_id:
            return None
        if change(doc) is False:
            return doc
        body = json.dumps(doc)
        try:
            _put(ctx, key, body, "application/json", **({"IfMatch": etag} if etag else {"IfNoneMatch": "*"}))
            return doc
        except ClientError as e:
            if _code(e) not in ("PreconditionFailed", "ConditionalRequestConflict"):
                raise
        except ParamValidationError:  # an SDK without conditional writes: last writer wins
            _put(ctx, key, body, "application/json")
            return doc
    raise LiveError(409, "busy", "방송 상태가 동시에 바뀌고 있어요. 잠시 뒤 다시 시도해 주세요")


def _update_job(ctx, job_id, change) -> dict | None:
    return _rmw(ctx, JOB_KEY, change, job_id)


def _own(job):
    if job is None:
        raise LiveError(409, "not_live", tr(REPLACED_TEXT))
    return job


def _log_break(ctx, job_id, entry):
    _rmw(ctx, STATUS_KEY, lambda st: st.setdefault("breaks", []).append(entry), job_id)


# ── IVS ───────────────────────────────────────────────────────────────────────

_chan: dict = {}
_stream_cache: dict = {}


def _channel(ctx) -> dict:
    """The player channel's ARN and playback URL, looked up by name once per container."""
    if not _chan:
        hit = next((c for c in ctx.ivs.list_channels(filterByName=IVS_CHANNEL)["channels"] if c.get("name") == IVS_CHANNEL), None)
        if not hit:
            print(f"live channel {IVS_CHANNEL} not found")
            raise LiveError(503, "live_unavailable", "라이브 방송 채널을 찾지 못했어요. 관리자에게 문의해 주세요.")
        ch = ctx.ivs.get_channel(arn=hit["arn"])["channel"]
        _chan.update(arn=ch["arn"], playbackUrl=ch["playbackUrl"], ads=bool(ch.get("adConfigurationArn")))
    return _chan


def _stream_state(ctx, fresh=False) -> str:
    """LIVE while a source publishes to the channel, else OFFLINE (cached a few seconds; a throttled call keeps the
    last answer)."""
    now = time.time()
    if not fresh and now - _stream_cache.get("at", 0) < STREAM_CACHE_SEC:
        return _stream_cache["state"]
    try:
        stream = ctx.ivs.get_stream(channelArn=_channel(ctx)["arn"])["stream"]
        state = stream["state"]
        _stream_cache["health"] = stream.get("health")  # HEALTHY | STARVING | UNKNOWN
    except ClientError as e:
        if _code(e) in ("ChannelNotBroadcasting", "ResourceNotFoundException"):
            state = "OFFLINE"
        elif _code(e) == "ThrottlingException" and "state" in _stream_cache:
            return _stream_cache["state"]
        else:
            raise
    _stream_cache.update(state=state, at=now)
    return state


def _file_pick(picks: dict, pid: str) -> dict:
    """The pick of a VAST file: its own, else (an old persona) its viewer's, else the default ("")."""
    return picks.get(pid) or picks.get(viewers.PERSONA_VIEWER.get(pid, "")) or picks[""]


def _set_ads(ctx, picks: dict, break_id: str):
    """Each viewer's (and old persona's) VAST for the next break (MediaTailor reads a viewer's file when IVS asks for
    its ads); one without its own pick gets the default (""). Every file's impression beacon names the break and
    the file's id."""
    for pid in ads.persona_ids(ctx):
        p = _file_pick(picks, pid)
        _put(ctx, ads.vast_key(pid), ads.vast(p["title"], p["url"], p["seconds"], p["creative"],
                                              ads.beacon(ctx, break_id, pid, p["creative"])), "application/xml")


def _ad_break(ctx, seconds) -> str:
    """ivs:InsertAdBreak (1–300 s; the break must be at least as long as the ad or MediaTailor leaves it empty). A
    break still running answers 409: retried briefly, which covers a 1 s warm-up. A throttled call or a fault of the
    service inserted nothing, so it is sent again at once. An answer without a break id is no break."""
    secs = max(1, min(300, math.ceil(seconds)))
    for attempt in range(3):
        try:
            got = ctx.ivs.insert_ad_break(channelArn=_channel(ctx)["arn"], durationSeconds=secs).get("adBreakId", "")
            if not got:
                print("ad break refused: the channel returned no break id")
                raise LiveError(409, "not_live", "광고 구간을 넣지 못했어요. 방송이 켜져 있는지 확인한 뒤 다시 보내 주세요.")
            return got
        except ClientError as e:
            if _code(e) not in AD_BREAK_RETRY or attempt == 2:
                raise
            time.sleep(1.5 if _code(e) == "ConflictException" else 0.3)
    return ""


def _busy(job) -> bool:
    """A break's ad requests may still read the VAST files: a warm-up's for WARM_HOLD_SEC after its call (its 1 s
    break is long past for every watching tile), a full-screen break's until breakUntil. A trailer cue does not ask:
    it takes the files unless a full-screen ad is still on air (_send_break)."""
    now = time.time()
    if job.get("breakKind") == "warm":
        return now < min(job.get("breakUntil", 0), job.get("lastBreakAt", 0) + WARM_HOLD_SEC)
    return now < job.get("breakUntil", 0)


def _on_air(job, at: float) -> bool:
    """A full-screen break is still on air (stream time) at `at`."""
    return job.get("airUntil", 0) > at


def _spoiled(j, keep: set) -> list:
    """A trailer cue takes the files from a warm-up whose ad requests may not have come yet: its creatives (but the
    ones the cue names itself, which its own break warms) are not warmed after all and go back to the queue's front."""
    if j.get("breakKind") != "warm" or time.time() >= j.get("lastBreakAt", 0) + WARM_HOLD_SEC:
        return []
    lost = [w for w in j.get("warmSent", []) if w["url"] not in keep]
    for w in lost:
        j.get("warmedAt", {}).pop(w["url"], None)
    j["warm"] = lost + [w for w in j.get("warm", []) if w["url"] not in {x["url"] for x in lost}]
    return lost


def _break(ctx, job, title, url, seconds, ad_id=None) -> str:
    """A break with the same creative for every persona (a warm-up, a linear highlight). ad_id is kept for callers:
    the creative id comes from the URL (stable, so its warm-up counts). → the IVS break id."""
    return _send_break(ctx, job, {"": ads.pick(url, title, seconds)})[0]


def _send_break(ctx, job, picks: dict, seconds: float | None = None, warm: bool = False, sent: list | None = None,
                cue: bool = False, at: float | None = None, go=None, rush=None) -> tuple:
    """Claim the VAST files (a conditional write: one break at a time owns them until its ad requests are done), then
    write each persona's and insert the break, as long as the longest pick (or seconds). A full-screen break holds the
    files for AD_LEAD_SEC plus the longer of its length and BREAK_MARGIN_SEC (late viewers still ask for its ads); a
    warm-up (sent: its queue items) for WARM_HOLD_SEC. Raises LiveError(409, ad_busy) while another break owns them.
    cue (a trailer cue, which never waits): takes them from any break no longer on air when its own lands (a warm-up
    it spoils goes back to the queue); its call follows a mark in timed metadata, on the same frame, that each tile
    measures from (_ad_shown). at (a pre-cue): the call leaves then, not when the claim and the files are done. go:
    asked right before the call, False calls the break off. rush: asked every PRECUE_POLL_SEC of the wait, True ends
    it. → (IVS break id; our break id, the impression beacons' b, a warm-up's starting with w_ and never counted as
    an impression; when the call left; how long before the call the mark left)."""
    seconds = seconds or max(p["seconds"] for p in picks.values())
    token = uuid.uuid4().hex[:10]
    now = max(time.time(), at or 0)
    until = now + AD_LEAD_SEC + max(math.ceil(seconds), BREAK_MARGIN_SEC)
    keep, lost = {p["url"] for p in picks.values()}, []

    def claim(j):
        lost.clear()
        if (_on_air(j, now + STREAM_LEAD_SEC) if cue else _busy(j)):
            return False
        if cue:
            lost.extend(w["url"] for w in _spoiled(j, keep))
        j.update(breakUntil=until, breakOwner=token, lastBreakAt=now, breakKind="warm" if warm else "break")
        if warm:
            j["warmSent"] = sent or []
        else:
            j.pop("warmSent", None)
            j["airUntil"] = now + STREAM_LEAD_SEC + math.ceil(seconds)
    claimed = _own(_update_job(ctx, job["jobId"], claim))
    job.update(claimed)
    if claimed.get("breakOwner") != token:
        raise LiveError(409, "ad_busy", "다른 광고가 나가는 중이에요. 잠시 뒤 다시 보내 주세요")
    if lost:  # the spoiled warm-up's creatives are not in the registry either
        def forget(reg):
            for u in lost:
                reg.pop(u, None)
        _rmw(ctx, WARM_REGISTRY, forget)
    break_id = ("w_" if warm else "b_") + token
    _set_ads(ctx, picks, break_id)

    def unclaim(j):  # nothing went out: the file is free again
        if j.get("breakOwner") != token:
            return False
        j["breakUntil"] = 0
        if not warm:
            j.pop("airUntil", None)
    if at:  # rush ends the wait early (the round is over already, or called off)
        # the wait ends PRECUE_CALL_PREP_SEC before the call's moment: the last look at the job and the mark come
        # first, and the call then leaves on its moment
        until = min(at, time.time() + PRECUE_PREP_SEC + PRECUE_SLACK_SEC) - PRECUE_CALL_PREP_SEC
        looks = int((PRECUE_PREP_SEC + PRECUE_SLACK_SEC) / PRECUE_POLL_SEC) + 2  # (a clock that stands still ends it too)
        while (looks := looks - 1) >= 0 and time.time() < until - 1e-6 and not (rush and rush()):
            # rush() reads S3 between the loop's test and this line, so the rest can be below zero by then
            time.sleep(max(0.0, min(PRECUE_POLL_SEC, until - time.time())))
        if time.time() < until - 1e-6:
            at = None  # the wait ended early (the round is over, or called off): nothing more to wait for
    try:
        if go and not go():
            raise LiveError(409, "called_off", "판이 끝나는 시간이 바뀌어 광고 구간을 미리 보내지 않았어요")
        marked = time.time()
        if cue:
            try:
                _meta(ctx, {"type": "mark", "e": break_id})
            except (ClientError, LiveError) as e:  # never in the way of the ad
                print(f"break mark failed: {e}")
        if at:
            time.sleep(max(0.0, min(at - time.time(), PRECUE_CALL_PREP_SEC)))
        called = time.time()
        # (the fourth: how long before the call the mark left; a tile's mark → ad reading is that much longer)
        return _ad_break(ctx, seconds), break_id, called, round(called - marked, 2)
    except LiveError:
        _update_job(ctx, job["jobId"], unclaim)
        raise
    except ClientError as e:
        _update_job(ctx, job["jobId"], unclaim)
        print(f"ad break refused: {_code(e) or e}")  # the service's own word stays in the log, not in the toast
        raise LiveError(409, "ad_busy" if _code(e) == "ConflictException" else "not_live",
                        "다른 광고가 나가는 중이에요. 잠시 뒤 다시 보내 주세요" if _code(e) == "ConflictException"
                        else "광고 구간을 넣지 못했어요. 방송이 켜져 있는지 확인한 뒤 다시 보내 주세요.") from None


def _meta(ctx, payload: dict):
    """ivs:PutMetadata (≤ 1 KB): rides on the current frame, so each viewer gets it when their video reaches it."""
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(text.encode()) > 1024:
        raise LiveError(400, "too_big", "방송에 실어 보낼 내용이 너무 길어요. 제목을 줄인 뒤 다시 보내 주세요.")
    ctx.ivs.put_metadata(channelArn=_channel(ctx)["arn"], metadata=text)


def _want_warm(job, url, title, seconds, ad_id, first=False):
    """Queue a warm-up for this creative (first: at the queue's front, or moved there)."""
    if not url or url in job.setdefault("warmedAt", {}):
        return
    queue = job.setdefault("warm", [])
    have = next((w for w in queue if w["url"] == url), None)
    if have and first:
        queue.remove(have)
    if not have or first:
        item = have or {"url": url, "title": title, "seconds": seconds, "adId": ad_id}
        queue.insert(0, item) if first else queue.append(item)


def _plan(job) -> dict:
    """{viewer: pick} of the next trailer break, warm or not ("" = the default ad; a job started before personas:
    its one trailer for everyone)."""
    if job.get("plan"):
        return job["plan"]
    return {"": ads.pick(job["adUrl"], job.get("adTitle", ""), job.get("adSeconds", 15))} if job.get("adUrl") else {}


def _default(job) -> dict:
    return _plan(job).get("") or ads.pick(job["adUrl"], job["adTitle"], job["adSeconds"])


def _inventory(ctx, job, fresh=False, snap=None) -> list:
    """The broadcast's campaigns: the saved list (this job's), or every trailer of the owner's sessions (fresh: read
    all of them again; a start with its session's snapshot reuses a list made in the last INVENTORY_REUSE_SEC and adds
    that session's trailers, so a start does not read every session)."""
    return _inventories(ctx, job, fresh, snap)[0]


def _playables(ctx, job) -> list:
    """The broadcast's playable inventory: the owner's published 3D games (saved with the trailers)."""
    return _inventories(ctx, job)[1]


def _inventories(ctx, job, fresh=False, snap=None) -> tuple:
    """(trailers, playables) of the broadcast, as _inventory describes."""
    doc = _get_json(ctx, INVENTORY_KEY) or {}
    if doc.get("v") != INVENTORY_VERSION:
        doc = {}
    if not fresh and doc.get("jobId") == job["jobId"] and "playables" in doc:
        return doc.get("items", []), doc["playables"]
    recent = doc.get("ownerSub") == job.get("ownerSub") and time.time() - doc.get("at", 0) < INVENTORY_REUSE_SEC
    if not fresh and snap is not None and recent and "playables" in doc:
        def merge(old, mine):
            known = {c["creative"] for c in mine}
            return sorted([c for c in old if c["creative"] not in known] + mine,
                          key=lambda c: (c["createdAt"], c["creative"]))
        items = merge(doc.get("items", []), adserver.campaigns(ctx, snap))
        games = merge(doc["playables"], adserver.games(snap))
    else:
        items, games = adserver.inventories(ctx, job.get("ownerSub", ""), (job["sessionId"],))
    _put(ctx, INVENTORY_KEY, json.dumps({"v": INVENTORY_VERSION, "jobId": job["jobId"], "ownerSub": job.get("ownerSub", ""),
                                         "at": time.time(), "items": items, "playables": games}), "application/json")
    return items, games


def _decide(ctx, job, items, usable=None, kind="trailer") -> tuple:
    """(viewers, {viewerId: adserver decision}) for the job's next break of this style."""
    people = viewers.ensure(ctx)
    now = time.time()
    logs = {v["viewerId"]: viewers.log(ctx, v["viewerId"], now) for v in people}
    n = job.get({"trailer": "trailerBreaks", "corner": "cornerBreaks", "playable": "playableBreaks"}[kind], 0)
    return people, adserver.decide(people, logs, items, now, n, usable, kind)


def _replan(ctx, job, written=True, snap=None):
    """Each viewer's next picks (at start and after each break: its log has grown): the plan is every viewer's pick
    with everything warm (one title per viewer), and warm-ups are queued for those first, then every viewer's best,
    second and third (a cue never waits for them: it serves the best warmed ones, so warming these early is what
    makes the personal picks win). written: the job is in S3 already (else it is edited in place)."""
    items, games = _inventories(ctx, job, fresh=snap is None, snap=snap)
    _, dec = _decide(ctx, job, items)
    default = _default(job)
    plan = {"": default}
    for vid, d in dec.items():
        c = d["pick"]["campaign"]
        plan[vid] = ads.pick(c["url"], c["title"], c["seconds"])
    reg = _get_json(ctx, WARM_REGISTRY) or {}
    urls = {c["url"] for c in items} | {default["url"]}

    def apply(j):
        j["plan"] = plan
        j["adChoices"] = _ad_choices(j, items, games)  # with the list as it is now (a trailer made meanwhile counts)
        j.pop("replanAt", None)
        j["warmedAt"] = {**{u: t for u, t in reg.items() if u in urls}, **j.get("warmedAt", {})}
        for vid, p in plan.items():
            if vid:
                _want_warm(j, p["url"], p["title"], p["seconds"], p["creative"])
        for depth in range(WARM_DEPTH):
            for d in dec.values():
                if depth < len(d["ranked"]):
                    c = d["ranked"][depth]["campaign"]
                    _want_warm(j, c["url"], c["title"], c["seconds"], c["creative"])
    if written:
        return _update_job(ctx, job["jobId"], apply) or job
    apply(job)
    return job


def _ad_choices(job, items, games) -> dict:
    """job.adChoices: how many different ads this broadcast's viewers can get at one break, by style. trailer: the
    campaigns of its trailer inventory, with its default ad when that is none of them (the corner trailers are the
    same list); playable: the owner's published games, or the broadcast's own game for everyone when none is
    published. Counted as a break tells campaigns apart (adserver.distinct). The status hands the count out, so the
    page can say that one trailer is one ad for everyone."""
    default = _plan(job).get("") or {}
    own = [default] if default.get("url") and default["url"] not in {c["url"] for c in items} else []
    return {"trailer": adserver.distinct([*items, *own]), "playable": max(1, adserver.distinct(games))}


def _plan_ads(ctx, job, snap, ad_url, seconds):
    """At start: the owner's chosen trailer is the default ad (warmed first), then each viewer's next picks."""
    chosen = next((t for t in ads.trailers(ctx, snap) if t["url"] == ad_url), None)
    job["plan"] = {"": ads.pick(ad_url, chosen["title"] if chosen else job["adTitle"], seconds)} if ad_url else {}
    # what MediaTailor has seen in earlier broadcasts (the registry); the rest of it joins with the inventory
    job["warmedAt"] = {u: t for u, t in (_get_json(ctx, WARM_REGISTRY) or {}).items() if u == ad_url}
    if ad_url:
        _want_warm(job, ad_url, job["plan"][""]["title"], seconds, job["plan"][""]["creative"])
        _replan(ctx, job, written=False, snap=snap)
    else:  # no trailer to plan (a playable broadcast of a session without one): the inventory is read for the count
        # now, and its first card's cue finds it made. A count never keeps a broadcast off the air
        try:
            job["adChoices"] = _ad_choices(job, *_inventories(ctx, job, snap=snap))
        except Exception as e:  # noqa: BLE001
            print(f"ad choices not counted: {e}")


def _active(job) -> list:
    """The viewers whose tile played within ACTIVE_SEC (the watch page's heartbeat), in seed order."""
    seen = job.get("seen") or {}
    return [v for v in viewers.VIEWER_IDS if time.time() - seen.get(v, 0) <= viewers.ACTIVE_SEC]


def _warm(ctx, job) -> bool:
    """A 1 s ad break (too short for the creative, so nothing shows) while a viewer watches: MediaTailor then
    transcodes what each viewer's file asked for, and the real break later is filled. Each viewer watching right now
    gets a different pending creative, every other file the first, so one warm-up break warms up to one creative per
    watching viewer (warm-up is per MediaTailor configuration and creative id, not per viewer). → whether a warm-up
    was sent."""
    pending = [w for w in job.get("warm", []) if w["url"] not in job.get("warmedAt", {})]
    if not pending or _busy(job) or _cue_due(job):
        return False
    picks, sent = {"": ads.pick(pending[0]["url"], pending[0]["title"], 1)}, [pending[0]]
    for vid, w in zip(_active(job), pending):
        picks[vid] = ads.pick(w["url"], w["title"], 1)
        if w not in sent:
            sent.append(w)
    try:
        _send_break(ctx, job, picks, seconds=1, warm=True, sent=sent)
    except LiveError as e:
        print(f"warm-up break failed: {e.message}")
        return False
    _mark_warm(ctx, job, {w["url"] for w in sent})
    return True


def _mark_warm(ctx, job, urls: set):
    """These creatives went out in a break a viewer watches: MediaTailor transcodes them from now (the job's warmedAt
    and the registry other broadcasts read); a creative marked before keeps its time."""
    now = time.time()

    def done(j):
        for u in urls:
            j.setdefault("warmedAt", {}).setdefault(u, now)
        j["warm"] = [x for x in j.get("warm", []) if x["url"] not in urls]
    job.update(_update_job(ctx, job["jobId"], done) or {})

    def remember(reg):
        for u in urls:
            reg.setdefault(u, now)
        for old in sorted(reg, key=reg.get)[:-200]:  # ponytail: the newest 200 are plenty for a demo
            reg.pop(old)
    _rmw(ctx, WARM_REGISTRY, remember)


def _cue_round(job, rounds: int) -> bool:
    """Round `rounds` ends in the broadcast's every-N-th ad (its base: the first report, or before it rounds - 1)."""
    if job.get("makeup") == rounds and job.get("adType", "trailer") == "trailer":
        return True  # the full-screen break before it did not air (_check_aired): this round's end gets one
    every = job.get("everyRounds") or 0
    base = job.get("roundBase", rounds - 1)
    return bool(every) and rounds > base and (rounds - base) % every == 0


def _cue_due(job) -> bool:
    """A warm-up now would still wait for its ad requests (WARM_HOLD_SEC) when the round being played ends in a
    full-screen trailer cue, which would take the files and spoil it. So no warm-up from WARM_HOLD_SEC before that
    cue to the round's end: the round's known end (the play window's ETA), else the last round end plus the shortest
    recent round less 5 s of slack (no length yet: off for the whole round). Warm-ups go before the first report
    (nothing is known), and while no creative is ready or will be by then: that round's ad is a corner trailer
    (_cue_trailer), which takes no files."""
    if job.get("adType") != "trailer" or "roundBase" not in job and not job.get("roundEta"):
        return False
    playing = job.get("roundsDone", 0) + 1
    if not _cue_round(job, playing):
        return False
    soon = time.time() + WARM_HOLD_SEC
    if not any(soon - at >= TRANSCODE_SEC for at in (job.get("warmedAt") or {}).values()):
        return False
    now, lead = time.time(), job.get("preCueLeadSec") or 0
    eta = job.get("roundEta") or {}
    if eta.get("round") == playing:
        return eta["endsAt"] - lead - WARM_HOLD_SEC <= now <= eta["endsAt"] + 1
    last, typical = job.get("roundEndAt"), min(job.get("roundDurs") or [0])
    if not last or not typical:
        return bool(last)
    return now + WARM_HOLD_SEC + 5 >= last + typical - lead


def _warmed(job, url) -> bool:
    """Its warm-up went out long enough ago for MediaTailor's transcode."""
    at = job.get("warmedAt", {}).get(url)
    return bool(at) and time.time() - at >= TRANSCODE_SEC


# ── the web stream group's idle host (playable broadcasts) ─────────────────────

def _standby(ctx, on: bool):
    """TargetIdleCapacity of the web stream group's location, 1 while a playable broadcast runs: a viewer's GameLift
    Streams session then starts in seconds instead of minutes. Held capacity is billed. Only that field changes (the
    group's maximum and always-on capacity stay as deployed). → None or the error text."""
    from server import streams
    try:
        gls = streams.client()
        group = streams._web_group()
        loc = next((x for x in gls.get_stream_group(Identifier=group).get("LocationStates", [])
                    if x.get("LocationName") == streams._region()), {})
        maximum = loc.get("MaximumCapacity", loc.get("OnDemandCapacity", 0))
        if on and not maximum:
            return "the web stream group has no capacity"
        if (loc.get("TargetIdleCapacity") or 0) == (1 if on else 0):
            return None
        gls.update_stream_group(Identifier=group, LocationConfigurations=[{
            "LocationName": streams._region(), "AlwaysOnCapacity": loc.get("AlwaysOnCapacity", 0),
            "MaximumCapacity": maximum, "TargetIdleCapacity": 1 if on else 0}])
        return None
    except Exception as e:  # noqa: BLE001
        print(f"standby capacity {'on' if on else 'off'} failed: {e}")
        return str(e)[:200]


def _manual(ctx) -> dict:
    """The control room's switch, while it applies: 'on' until its cap, 'off' until a playable broadcast starts."""
    doc = _get_json(ctx, STANDBY_KEY) or {}
    if doc.get("mode") == "on" and time.time() > doc.get("until", 0):
        return {}
    return doc if doc.get("mode") in ("on", "off") else {}


def _release(ctx, job_id):
    """Turn the idle host off for this job; the flag stays set (and reap retries) until it worked. A host the
    control room's switch holds stays (the switch decides)."""
    if _manual(ctx).get("mode") == "on" or _needs_idle(ctx)[0]:  # the switch, or a broadcast started since, holds it
        _update_job(ctx, job_id, lambda j: j.update(standby=False, standbyError=None))
        return None
    err = _standby(ctx, False)
    if err is None:
        _update_job(ctx, job_id, lambda j: j.update(standby=False, standbyError=None))
    else:
        _update_job(ctx, job_id, lambda j: j.update(standbyError=err))
    return err


def _playable_ad(ctx, session, game_id, seconds) -> dict:
    """The broadcast's own playable ad: the game's one ad of this trial length, as the game is now (a start reuses it
    instead of writing a new record)."""
    from server import playable
    made = _ad_call(playable.for_game, ctx, session["sessionId"], game_id, seconds, True)
    return {"playableAdId": made["adId"], "playableSeconds": made["seconds"],
            "playUrl": f"https://{os.environ.get('CDN_DOMAIN', '')}/#ad={made['adId']}"}


def _end_standby(ctx, ad_id, job_id=None):
    """The hidden sessions of the ad (old watch windows) and the job's hidden launchers nobody plays."""
    from server import playable
    playable.end_standby(ctx, ad_id)
    if job_id:
        playable.end_launchers(ctx, job_id)


def _standby_capable(ctx, game_id) -> bool:
    """The game's own runtime copy can wait for the first input (&standby=1); games made before that start their
    round on load, so their live viewers get the ad session on click instead of a hidden one."""
    try:
        body = ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=f"games/{game_id}/runtime3d.js")["Body"].read()
        return b"standby" in body
    except ClientError:
        return False


def _token(ctx, job_id) -> str | None:
    try:
        doc = json.loads(ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=TOKEN_KEY)["Body"].read() or b"{}")
    except (ClientError, ValueError):
        return None
    return doc.get("token") if doc.get("jobId") == job_id else None


def _new_token(ctx, job_id) -> str:
    token = uuid.uuid4().hex
    ctx.s3.put_object(Bucket=ctx.assets_bucket, Key=TOKEN_KEY, Body=json.dumps({"jobId": job_id, "token": token}).encode(),
                      ContentType="application/json")
    return token


def live_ad(ctx, ad_id, token=None) -> dict | None:
    """The running playable broadcast whose ad this is, asked for with its owner's standby token
    (server/playable.py: only the owner's watch windows get hidden standby sessions)."""
    job = _get_json(ctx, JOB_KEY) or {}
    if (not job.get("stop") and job.get("adType") == "playable" and job.get("playableAdId") == ad_id
            and job.get("standbyCapable", True) and token and token == _token(ctx, job.get("jobId"))
            and _manual(ctx).get("mode") != "off"):  # the switch OFF: no hidden sessions either
        return job
    return None


def _ad_call(fn, *args):
    from server import playable, streams
    try:
        return fn(*args)
    except (playable.AdError, streams.StreamError) as e:
        raise LiveError(e.status, e.code, e.message) from None


def launcher_start(ctx, session: dict, body: dict) -> dict:
    """POST /live/launcher: the watch page's one hidden, game-agnostic session for this playable broadcast (only the
    owner's windows, with its standby token; not while the control room's switch is OFF)."""
    from server import playable
    job = _player_job(ctx, session)
    tok = body.get("standbyToken")
    if (job.get("adType") != "playable" or _manual(ctx).get("mode") == "off" or not tok
            or tok != _token(ctx, job["jobId"])):
        raise LiveError(409, "standby_refused", "지금은 미리 연결해 둘 수 없어요. 누르면 그때 시작해요")
    # viewerId: whose card the page will most likely play (1명 보기's viewer, a grid's first), grid: the page shows
    # every viewer's tile. Their next card's games load ahead of its cue (launcher_ahead)
    viewer = _viewer_arg(body) if "viewerId" in body else None
    who = None if viewer is None else _tiles(viewer, body.get("grid"))
    return _ad_call(playable.launcher_start, ctx, job["jobId"], {**body, "viewerId": viewer, "viewerIds": who})


def _tiles(viewer: str, grid) -> list:
    """The viewers whose cards a watch page can play: the one it names (the likeliest) and, in the 4-viewer grid, the
    others in seed order."""
    return [viewer] + ([v for v in viewers.VIEWER_IDS if v != viewer] if grid is True else [])


def _job_of(ctx, session) -> dict:
    """This session's broadcast, running or just stopped (a play that ends after the stop still reports)."""
    job = _get_json(ctx, JOB_KEY) or {}
    if job.get("sessionId") != session["sessionId"]:
        raise LiveError(409, "not_live", "이 세션의 방송이 아니에요")
    return job


def launcher_poll(ctx, session: dict, launch_id: str) -> dict:
    from server import playable
    return _ad_call(playable.launcher_poll, ctx, _job_of(ctx, session)["jobId"], launch_id)


def launcher_stop(ctx, session: dict, launch_id: str) -> dict:
    from server import playable
    return _ad_call(playable.launcher_stop, ctx, _job_of(ctx, session)["jobId"], launch_id)


def launcher_hint(ctx, session: dict, launch_id: str, body: dict) -> dict:
    """POST /live/launcher/<launchId>/hint {viewerId, eventId?, grid?}: what this page shows. With eventId: a playable
    card is up; its viewer's game (and in the grid the other tiles') is held on the page's launcher (server/
    playable.hint), so the click only reveals it. Without: the page's viewers changed after its launcher started (its
    viewer list loaded, the view or the persona switched): the next card's games are decided for them."""
    from server import playable
    job = _player_job(ctx, session)
    who = _tiles(_viewer_arg(body), body.get("grid"))
    if body.get("eventId") is None:
        return _ad_call(playable.name_viewers, ctx, job["jobId"], launch_id, who)
    st = _get_json(ctx, STATUS_KEY) or {}
    card = next((b for b in st.get("breaks", []) if b.get("eventId") == body["eventId"] and b.get("kind") == "playable"),
                None) if st.get("jobId") == job["jobId"] else None
    picks = (card or {}).get("picks") or {}
    if not picks.get(who[0]):
        raise LiveError(404, "no_pick", "이 광고 구간에 이 시청자의 광고가 없어요")
    cue = job.get("playableCue") or {}  # the card went up at its cue, whenever the page's hint comes
    first, also = _ad_call(_launch_games, ctx, picks, who)
    return _ad_call(playable.hint, ctx, job["jobId"], launch_id, first, also,
                    cue.get("at") if cue.get("e") == body["eventId"] else None, who)


def _launch_games(ctx, picks: dict, who: list) -> tuple:
    """(first, also): the game pages a launcher holds for these viewers' picks of one card, the first viewer's first
    (None when it has none to hold) and the others' after it. Only a game whose runtime can hold for the first input
    (&standby=1): any other would run its round in the launcher's hidden frame, so it opens on the click instead."""
    from server import playable
    urls = []
    for vid in who:
        pick = picks.get(vid) or {}
        ad = playable.get(ctx, pick["adId"]) if pick.get("adId") else None
        urls.append(playable.game_url(ad, True) if ad and _standby_capable(ctx, ad["gameId"]) else None)
    first = urls[0] if urls else None
    also = [u for u in dict.fromkeys(urls[1:]) if u and u != first]
    return first, also[:playable.PRELOAD_MAX - 1]


def launcher_ahead(ctx, job_id: str, who: list) -> dict | None:
    """What a waiting launcher holds between cards (server/playable.launch_fetch asks, every AHEAD_SEC): the games the
    broadcast's next playable card will offer its page's viewers, decided now as the cue will decide them (the same
    logs and break number: _playable_picks), and until when no card is due (calmUntil). None: this broadcast has no
    next card. Loading ahead matters: a game's load takes over 10 s, which a click at the cue would wait out."""
    job = _get_json(ctx, JOB_KEY) or {}
    if job.get("jobId") != job_id or job.get("stop") or job.get("adType") != "playable":
        return None
    first, also = _launch_games(ctx, _playable_picks(ctx, job), who)
    due = _card_due_in(job)
    return {"preload": first, "also": also, "calmUntil": None if due is None else time.time() + due}


def _card_due_in(job) -> float | None:
    """Seconds until the broadcast's next playable card is due, from the shortest of its last rounds (a held card
    goes at the next round end); None before a round length is known."""
    typ, last = _typical(job), job.get("roundEndAt")
    if not typ or not last:
        return None
    done = job.get("roundsDone", 0)
    k = 1 if job.get("playableDue") else next((k for k in range(1, 21) if _cue_round(job, done + k)), None)
    return None if k is None else last + k * typ - time.time()


def _pick_of(ctx, job, event_id, viewer_id, kind) -> dict:
    """What the break eventId gave this viewer ('' = 기본), from the break log: the server's own record."""
    st = _get_json(ctx, STATUS_KEY) or {}
    brk = next((b for b in st.get("breaks", []) if b.get("eventId") == event_id and b.get("kind") == kind), None) \
        if st.get("jobId") == job["jobId"] else None
    pick = ((brk or {}).get("picks") or {}).get(viewer_id)
    if not pick:
        raise LiveError(404, "no_pick", "이 광고 구간에 이 시청자의 광고가 없어요")
    return pick


def _viewer_arg(body) -> str:
    raw = body.get("viewerId", "")
    if raw == "":
        return ""
    vid = viewers.resolve(raw) if isinstance(raw, str) else None
    if not vid:
        raise LiveError(400, "bad_request", "없는 시청자예요")
    return vid


def play(ctx, session: dict, body: dict) -> dict:
    """POST /live/play {viewerId, eventId, launchId?, ticket?}: a tile's playable card was clicked. With the page's
    warm launcher (launchId): it opens this viewer's game now (mode launch). Without: a seat in the queue — mode start
    (first in line and a seat free: start the ad's session with the ticket) or mode queued ({position}: "대기 n번째",
    ask again with the ticket every few seconds)."""
    from server import playable
    job = _player_job(ctx, session)
    vid = _viewer_arg(body)
    event_id = body.get("eventId")
    pick = _pick_of(ctx, job, event_id, vid, "playable")
    ad = _ad_call(playable.get, ctx, pick["adId"])
    holds = _standby_capable(ctx, ad["gameId"])
    if body.get("launchId"):
        out = {"mode": "launch", **_ad_call(playable.assign, ctx, job["jobId"], body["launchId"], ad, holds)}
    else:
        c = _ad_call(playable.claim, ctx, body.get("ticket") if isinstance(body.get("ticket"), str) else None, vid)
        if not c["go"]:
            return {"mode": "queued", "position": c["position"], "ticket": c["ticket"], "adId": ad["adId"]}
        out = {"mode": "start", "ticket": c["ticket"], "adId": ad["adId"], "seconds": ad["seconds"], "waitsForInput": holds}
    if vid:
        viewers.client_event(ctx, vid, event_id, "playable", "play", pick, owner=job.get("ownerSub", ""))
    return out


def ad_event(ctx, session: dict, body: dict) -> dict:
    """POST /live/ad-event {viewerId, eventId, kind: corner | playable, action, seconds?}: the watch page's beacon for
    the ads it renders itself (a corner trailer, a playable card): shown (impression), clicked, expanded, unmuted, a
    play's end with its seconds. Each joins the viewer's activity log once per break and action."""
    job = _job_of(ctx, session)
    kind, action = body.get("kind"), body.get("action")
    if (kind, action) == ("trailer", "start"):  # a tile's player began a stitched ad: {viewerId, leadMs?}, no log entry
        return _ad_shown(ctx, job, _viewer_arg(body), body.get("leadMs"), body.get("eventId") or None)
    if (kind, action) not in viewers.CLIENT_EVENTS:
        raise LiveError(400, "bad_request", "광고 기록을 읽지 못했어요. 시청 창을 새로 고쳐 주세요.")
    vid = _viewer_arg(body)
    if not vid:  # 기본 (no viewer) has no activity log
        return {"recorded": False}
    pick = _pick_of(ctx, job, body.get("eventId"), vid, kind)
    seconds = body.get("seconds")
    if seconds is not None and (isinstance(seconds, bool) or not isinstance(seconds, (int, float))):
        raise LiveError(400, "bad_request", "광고를 본 시간을 읽지 못했어요. 시청 창을 새로 고쳐 주세요.")
    return {"recorded": viewers.client_event(ctx, vid, body["eventId"], kind, action, pick, seconds,
                                             owner=job.get("ownerSub", "")) is not None}


def _iso(t: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))


# ── broadcast lifecycle ─────────────────────────────────────────────────────────

def _corner_flag(body: dict, default: bool) -> bool:
    value = body.get("corner", default)
    if not isinstance(value, bool):
        raise LiveError(400, "bad_request", "코너 트레일러 설정을 읽지 못했어요. 화면을 새로 고친 뒤 다시 해 주세요.")
    return value


def _lead(body: dict, default: float) -> float:
    value = body.get("preCueLeadSec", default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 20:
        raise LiveError(400, "bad_request", "광고를 미리 보내는 시간은 0–20초 사이로 적어 주세요(0은 미리 보내지 않아요).")
    return float(value)


BUSY = "다른 사용자가 방송 중이에요. 끝난 뒤(최대 {minutes}분) 다시 시도해 주세요."
BUSY_TEXT = BUSY.format(minutes=MAX_MINUTES)
OTHER_SESSION_TEXT = "내 다른 세션에서 방송 중이에요. 그 방송을 먼저 꺼 주세요."
SWITCH_BUSY_TEXT = "다른 사용자가 방송 중이라 플레이어블 서버를 바꿀 수 없어요. 방송이 끝난 뒤 다시 시도해 주세요."
NO_GAME_SWITCH_TEXT = "게임이 있는 세션에서만 플레이어블 서버를 켜거나 내릴 수 있어요. 먼저 게임을 만들어 주세요."
NO_TOKEN_TEXT = "지금 켜 둔 내 방송이 없어요. 라이브를 켠 뒤 다시 시도해 주세요."


def _alive(job) -> bool:
    """The broadcast is on air and somebody is still at it: not stopped, inside its cap, and its play window beat
    within BEAT_TIMEOUT_SEC (before its first beat: started within the time the reap gives it). What the reap would
    not stop for silence; a broadcast that is not alive holds the channel for nobody."""
    if not job.get("jobId") or job.get("stop") or not job.get("startedAt"):
        return False
    age = store.age_sec(job["startedAt"])
    if age > 60 * job.get("maxMinutes", MAX_MINUTES):
        return False
    beat = job.get("beatAt") or 0
    return time.time() - beat <= BEAT_TIMEOUT_SEC if beat else age <= BEAT_TIMEOUT_SEC + 120


def _others(job, session) -> bool:
    """The channel is another account's now: its broadcast is on air and alive, or its start holds the channel (the
    claim of _claim_start: the seconds before that broadcast's job is written are that account's already)."""
    claim = job.get("starting") or {}
    starting = time.time() - claim.get("at", 0) <= START_CLAIM_SEC and claim.get("sub") != session.get("userSub")
    return starting or (_alive(job) and job.get("ownerSub") != session.get("userSub"))


def owns_air(ctx, sub: str) -> bool:
    """This account's broadcast is on air (not stopped): the one that may be handed a playback token."""
    return token_retry(ctx, sub) is None


# A page that asks for a viewer's token while its account is not on air asks again this soon: under the status
# poll's 4 s, and at once while that account's own start holds the channel (its job is seconds away)
TOKEN_RETRY_SEC, TOKEN_RETRY_STARTING_SEC = 3, 1


def token_retry(ctx, sub: str):
    """None when this account's broadcast is on air (owns_air: a playback token may be signed for it), else the
    seconds after which its page should ask again (the refusal's retryAfterSec), so a watch page opened before the
    start attaches its tiles soon after it. Another account is told the plain figure: nothing of whose start is
    under way."""
    job = _get_json(ctx, JOB_KEY) or {}
    if job.get("jobId") and not job.get("stop") and job.get("ownerSub") == sub:
        return None
    claim = job.get("starting") or {}
    starting = bool(sub) and claim.get("sub") == sub and time.time() - claim.get("at", 0) <= START_CLAIM_SEC
    return TOKEN_RETRY_STARTING_SEC if starting else TOKEN_RETRY_SEC


# ── a start's claim of the channel ─────────────────────────────────────────────
# A start takes seconds (the owner's inventory, the stream group, IVS), in which two accounts could both pass a plain
# check. So it claims the channel first: `starting` {token, sub, sessionId, at} in the job file under S3's
# conditional write (_rmw), and writes its job only over a claim that is still its own (_commit_start). A failed
# start gives its claim back; a dead one holds the channel START_CLAIM_SEC at most.
START_CLAIM_SEC = 60  # a start answers in seconds, and its page waits a minute at most (the CDN's read timeout)
STARTING_TEXT = "‘라이브 켜기’가 겹쳤어요. 잠시 뒤 다시 눌러 주세요."


def _taken(doc: dict, session: dict, takeover: bool):
    """Why this session cannot have the channel now, or None: the broadcast on air while it is alive, or a start
    that claimed the channel in the last START_CLAIM_SEC, is another account's (live_busy), or this account's other
    session's and the start does not say takeover (live_other_session). The session's own is its to replace."""
    claim = doc.get("starting") or {}
    holders = [{"sub": doc.get("ownerSub"), "sessionId": doc.get("sessionId")}] if _alive(doc) else []
    if time.time() - claim.get("at", 0) <= START_CLAIM_SEC:
        holders.append(claim)
    for holder in holders:
        if holder.get("sessionId") == session["sessionId"]:
            continue
        if holder.get("sub") != session.get("userSub"):
            return LiveError(409, "live_busy", tr(BUSY, minutes=MAX_MINUTES))
        if not takeover:
            return LiveError(409, "live_other_session", tr(OTHER_SESSION_TEXT))
    return None


def _claim_start(ctx, session: dict, takeover: bool) -> tuple:
    """Take the channel for this start, before anything is changed → (the job file as it was, the claim's token).
    Raises what _taken says when the channel is not this session's to take."""
    token, seen = uuid.uuid4().hex[:12], {}

    def claim(doc):
        seen.update(old={k: v for k, v in doc.items() if k != "starting"}, refused=_taken(doc, session, takeover))
        if seen["refused"]:
            return False
        doc["starting"] = {"token": token, "sub": session.get("userSub", ""), "sessionId": session["sessionId"],
                           "at": time.time()}
    _rmw(ctx, JOB_KEY, claim)
    if seen["refused"]:
        raise seen["refused"]
    return seen["old"], token


def _commit_start(ctx, token: str, job: dict):
    """Write the new job over the claim, if the claim is still this start's: it is not when this account started
    again meanwhile (the same session, or its other session saying takeover), or when this start ran past
    START_CLAIM_SEC and another one took the channel. Then that start goes on air and this one changes nothing."""
    def write(doc):
        if (doc.get("starting") or {}).get("token") != token:
            return False
        doc.clear()
        doc.update(job)
    if _rmw(ctx, JOB_KEY, write).get("jobId") != job["jobId"]:
        raise LiveError(409, "busy", tr(STARTING_TEXT))


def _release_start(ctx, token: str):
    """This start did not go on air: its claim goes, so the next start need not wait for it to lapse."""
    def drop(doc):
        if (doc.get("starting") or {}).get("token") != token:
            return False
        doc.pop("starting")
    try:
        _rmw(ctx, JOB_KEY, drop)
    except Exception as e:  # noqa: BLE001 — it lapses by itself
        print(f"start claim release failed: {e}")


def start(ctx, session: dict, body: dict) -> dict:
    snap = store.snapshot(ctx, session["sessionId"])
    games = {g["gameId"]: g for g in snap["games"]}
    game = games.get(body.get("gameId")) or (snap["games"][-1] if snap["games"] else None)
    if not game:
        raise LiveError(400, "bad_request", "방송할 게임이 없어요. 먼저 게임을 만들어 주세요.")
    assets = {a["assetId"]: a for a in snap["assets"]}
    ad = assets.get(body.get("adAssetId")) or next((a for a in reversed(snap["assets"]) if a["kind"] == "trailer"), None)
    if ad and not str(ad.get("contentType", "")).startswith("video/"):
        ad = None
    if not ad and body.get("adType", "trailer") != "playable":  # a playable break needs no video
        raise LiveError(400, "bad_request", "광고로 쓸 트레일러가 없어요. 먼저 트레일러를 만들거나 플레이어블 광고를 골라 주세요.")
    if body.get("mode", "player") != "player":
        raise LiveError(400, "bad_request", "지금은 ‘내 플레이’ 방송만 켤 수 있어요.")
    ad_type = body.get("adType", "trailer")
    if ad_type not in AD_STYLES:
        raise LiveError(400, "bad_request", "광고 방식을 전체 화면 트레일러, 플레이어블 광고, 코너 트레일러 중에서 골라 주세요.")
    every = body.get("everyRounds", 2)
    if isinstance(every, bool) or not isinstance(every, int) or not 1 <= every <= 20:
        raise LiveError(400, "bad_request", "광고 간격은 1–20판 사이로 적어 주세요.")
    corner, lead = _corner_flag(body, False), _lead(body, PRECUE_LEAD_SEC)
    if ad_type == "playable":  # a request that is wrong on its face is refused before it takes the channel
        from server import playable
        _ad_call(playable.trial_seconds, body.get("playableSeconds", 90))
    seconds = float(((ad or {}).get("meta") or {}).get("seconds") or 15)
    _channel(ctx)
    # Before anything is changed: another account waits; the same account's other session takes over only when it
    # says so (the console asks). From this claim to the job's write the channel is this start's (_claim_start)
    old, claim = _claim_start(ctx, session, body.get("takeover") is True)
    replaced = bool(old.get("jobId")) and not old.get("stop")  # a broadcast that is over once this job is written
    try:
        inherited = bool(old.get("standby"))  # the job this start replaces held an idle host: it stays tracked
        if inherited and ad_type != "playable":
            if _manual(ctx).get("mode") == "on":  # the control room's switch holds it: not this job's to release
                inherited = False
            else:
                inherited = _standby(ctx, False) is not None  # released now, or this job's stop/reap retries it
        ad_url, title = (store.public_url(ctx, ad["key"]) if ad else ""), game.get("title", "IPverse")
        job = {"adUrl": ad_url, "adTitle": title, "highlightAuto": "off", "highlightGen": False, "jobId": uuid.uuid4().hex[:12],
               "sessionId": session["sessionId"], "gameId": game["gameId"],
               "gameUrl": store.public_url(ctx, f"games/{game['gameId']}/index.html"), "everyRounds": every,
               "adSeconds": round(seconds, 2), "adAssetId": ad["assetId"] if ad else None, "maxMinutes": MAX_MINUTES,
               "startedAt": store.now(), "mode": "player", "input": "ivs", "adType": ad_type, "warm": [],
               # an idle host the old job held stays with this one (released at its stop)
               "standby": inherited, "ownerSub": session.get("userSub", ""), "trailerBreaks": 0,
               "corner": corner and ad_type != "corner", "preCueLeadSec": lead, "leadAtCall": True,  # (_job_lead)
               # the broadcast's genre and tags: a viewer's watch time counts toward them
               **dict(zip(("genre", "tags"), adserver.classify(game.get("title", ""),
                                                               game.get("genre") or session.get("genre", ""))))}
        _plan_ads(ctx, job, snap, ad_url, seconds)
        if ad_type != "playable" and _manual(ctx).get("prewarm"):  # warmed for a playable broadcast that did not come
            _put(ctx, STANDBY_KEY, json.dumps({"mode": "auto", "at": time.time()}), "application/json")
            if not job["standby"]:
                job["standby"] = _standby(ctx, False) is not None  # released now, or this job's stop/reap retries it
        if ad_type == "playable":
            manual = _manual(ctx)
            # taken down by hand earlier: a new playable broadcast wants it again; held by the playable tab's
            # pre-warm: the broadcast holds it now (released at its stop)
            if manual.get("mode") == "off" or manual.get("prewarm"):
                _put(ctx, STANDBY_KEY, json.dumps({"mode": "auto", "at": time.time()}), "application/json")
            job["playableSince"] = time.time()
            job.update(_playable_ad(ctx, session, game["gameId"], body.get("playableSeconds", 90)))
            job["standbyCapable"] = _standby_capable(ctx, game["gameId"])
            err = _standby(ctx, True)
            job["standby"] = job["standby"] or err is None
            if err:
                job["standbyError"] = err
        if replaced and old.get("sessionId") != session["sessionId"] and old.get("ownerSub") == session.get("userSub"):
            # the owner's other session: its windows are told why theirs ended (_status endedBy). Never another
            # account's session id (a start over that account's dead broadcast): the job goes to its owner's pages
            job["tookOver"] = old["sessionId"]
        _commit_start(ctx, claim, job)
    except Exception:
        _release_start(ctx, claim)  # nothing of the job on air was touched: only a start that wrote its job ends it
        raise
    if replaced:  # taken over: the old job is over (the file is this job's now), and so is its publish
        _end_standby(ctx, old.get("playableAdId"), old["jobId"])
        try:  # the old window would otherwise hold the stream key until its next status poll notices
            ctx.ivs.stop_stream(channelArn=_channel(ctx)["arn"])
        except ClientError:
            pass
        _stream_cache.clear()
    _new_token(ctx, job["jobId"])  # only the owner's windows get it (status), so only they hold hidden sessions
    _put(ctx, STATUS_KEY, json.dumps({"jobId": job["jobId"], "state": "waiting", "rounds": 0,
                                      "breaks": [], "updatedAt": store.now()}), "application/json")
    if ad_type == "playable":
        # the host was asked for before the job was written: a reap tick or a hold's end (_lapse_hold) in between saw
        # no job that needs it and released the one this start had found up
        _reconcile_idle(ctx)
    return status(ctx, session)


def round_done(ctx, session: dict, body: dict) -> dict:
    """The play window finished round `rounds`; every everyRounds-th one gets the ad (counted from this broadcast's
    first report)."""
    job = _get_json(ctx, JOB_KEY) or {}
    if job.get("sessionId") != session["sessionId"] or job.get("stop") or job.get("mode") != "player":
        raise LiveError(409, "not_live", tr(NOT_ON_TEXT))
    rounds = body.get("rounds")
    if isinstance(rounds, bool) or not isinstance(rounds, int) or rounds < 1:
        raise LiveError(400, "bad_request", "끝난 판 수를 읽지 못했어요. 플레이 창을 새로 고쳐 주세요.")
    try:  # the session's record of play (phase 2 profiles); never in the way of the ad
        ads.log_round(ctx, session["sessionId"], job["jobId"], body)
    except Exception as e:  # noqa: BLE001
        print(f"round log failed: {e}")
    ended = time.time()
    # endedAtMs: the round's end as an instant of this server's clock, as the play window saw it (round_eta's
    # endsAtMs); the report's arrival is later by the request's way. Never later than the arrival, 3 s sooner at most
    told = body.get("endedAtMs")
    if isinstance(told, (int, float)) and not isinstance(told, bool) \
            and ended - PRECUE_TRANSIT_MAX_SEC <= told / 1000 <= ended:
        ended = told / 1000

    def mark(j):  # the play page may have finished rounds before this broadcast started (the base); round timing
        j.setdefault("roundBase", rounds - 1)
        if rounds <= j.get("roundsDone", -1):
            return
        if j.get("roundEndAt") and 0 < ended - j["roundEndAt"] < 900:  # the last rounds' lengths (for _cue_due)
            j["roundDurs"] = (j.get("roundDurs", []) + [round(ended - j["roundEndAt"], 2)])[-3:]
        j.update(roundsDone=rounds, roundEndAt=ended)
    job = _own(_update_job(ctx, job["jobId"], mark))
    seen = {}

    def count(st):
        if st.get("jobId") != job["jobId"]:
            if (_get_json(ctx, JOB_KEY) or {}).get("jobId") != job["jobId"]:
                return False  # replaced meanwhile: the new job's status stays as it is
            st.clear()
            st.update(jobId=job["jobId"], rounds=0, breaks=[])
        seen["before"] = st.get("rounds", 0)
        st.update(rounds=max(rounds, st.get("rounds", 0)), state="streaming", updatedAt=store.now())
    st = _rmw(ctx, STATUS_KEY, count)
    if "before" not in seen or st.get("jobId") != job["jobId"]:
        raise LiveError(409, "not_live", tr(REPLACED_TEXT))
    new = rounds > seen["before"]
    cue = new and _cue_round(job, rounds)
    style = job.get("adType", "trailer")
    precued = held = False
    unready = ""  # why this trailer round got no full-screen break: no trailer was ready (_cue_trailer's sentence)
    hold = None  # how long the play window's built-in player keeps the end screen up for this round's ad
    if new and style == "playable" and (cue or job.get("playableDue")):
        held = _launcher_gate(ctx, job)  # no warm launcher yet: the card comes at the first round end after one is
        cue = not held
        if held:
            _hold_playable(ctx, job, rounds)
    if cue and style == "trailer" and job.get("preCued") == rounds:  # its break went out before the round ended
        precued, cue = True, False
        _round_ended(ctx, job["jobId"], rounds, ended)
        hold = _early_hold(job, rounds, ended) or _precue_hold(job, rounds, ended)
    elif cue and style == "playable":
        try:  # in-band: each tile's card shows when its video reaches this round's end
            _cue_playable(ctx, job, rounds)
        except (ClientError, LiveError) as e:  # the stream is not live: the round still counts
            print(f"playable cue failed: {e}")
            cue = False
    elif cue and style == "corner":
        cue = _try_corner(ctx, job, rounds)
    elif cue:  # never waits: the best warmed creatives now, or (a break still on air) no ad this round
        try:
            cue = _cue_trailer(ctx, job, rounds, ended)
        except (ClientError, LiveError) as e:  # not live: the round still counts; the next N-th round cues again
            print(f"trailer ad break failed: {getattr(e, 'message', e)}")
            cue = False
            if getattr(e, "code", "") == "ad_warming":  # no trailer is ready to air: corner trailers, and why
                unready = e.message
    # a held playable round shows each viewer's corner trailer instead (no seat, no MediaTailor: it costs nothing and
    # lands at the round end), when the broadcast has trailers; so does a trailer round with no trailer ready
    corner = new and not cue and not precued and (
        (held and bool(job.get("adUrl"))) or bool(unready)
        or (job.get("corner") and style != "corner" and not _cue_round(job, rounds))) and _try_corner(
            ctx, job, rounds, {"instead": "trailer", "note": unready} if unready else None)
    if job.get("makeup") and rounds >= job["makeup"]:  # the make-up round is over, with its break or without
        _update_job(ctx, job["jobId"], lambda j: j.pop("makeup", None))
    st = _get_json(ctx, STATUS_KEY) or st
    if cue and style == "trailer":  # the break was sent only now
        hold = END_HOLD_SEC
    elif hold and any(b.get("round") == rounds and b.get("kind") == "skip" for b in st.get("breaks", [])):
        hold = None  # its pre-cue found no room: no ad to wait for
    return {"cued": bool(cue), "deferred": held, "preCued": precued, "corner": bool(corner),
            "rounds": st.get("rounds", rounds), "breaks": st.get("breaks", []),
            **({"holdSec": hold} if hold else {})}


def _launcher_gate(ctx, job) -> bool:
    """Hold this playable cue: the broadcast's launchers are all still starting (none CONNECTED), it is less than
    LAUNCHER_GATE_SEC since playables started, and hidden launchers are allowed at all. Once one has connected the
    gate is open for good (launcherReadyAt): a later card that finds it busy waits in line."""
    if job.get("launcherReadyAt") or not job.get("standbyCapable", True) or _manual(ctx).get("mode") == "off":
        return False
    if time.time() - job.get("playableSince", viewers.epoch(job["startedAt"])) > LAUNCHER_GATE_SEC:
        return False
    from server import playable
    try:
        ready = playable.launcher_connected(ctx, job["jobId"])
    except Exception as e:  # noqa: BLE001 — never in the way of the ad
        print(f"launcher check failed: {e}")
        return False
    if ready:
        _update_job(ctx, job["jobId"], lambda j: j.update(launcherReadyAt=time.time()))
    return ready is False  # None: no launcher at all, nothing to wait for


def _hold_playable(ctx, job, rounds):
    """The break log says why this round has no card (kind "skip", of "playable", reason launcher_warming); the
    next round end cues it (playableDue) once a launcher has connected."""
    print(f"playable cue of round {rounds} held: no launcher connected yet")
    _update_job(ctx, job["jobId"], lambda j: j.update(playableDue=rounds))
    _log_break(ctx, job["jobId"], {"round": rounds, "kind": "skip", "of": "playable", "reason": "launcher_warming",
                                   "eventId": "s_" + uuid.uuid4().hex[:10], "at": _iso(time.time()), "seconds": 0})


def _try_corner(ctx, job, rounds, extra: dict | None = None) -> bool:
    try:
        _cue_corner(ctx, job, rounds, extra)
        return True
    except (ClientError, LiveError) as e:  # the stream is not live: the round still counts
        print(f"corner cue failed: {e}")
        return False


def _iso_ms(t: float) -> str:
    return viewers._iso(t)


def _skip(ctx, job, rounds, reason, round_end=None, pre=None):
    """No full-screen ad this round, and the schedule stays (the next N-th round cues as usual): the break log says
    why (kind "skip": overlap = the previous full-screen ad would still be on air when this one lands; no_room = less
    than MIN_BREAK_SEC before the next round's ad)."""
    print(f"trailer cue of round {rounds} skipped: {reason}")
    _log_break(ctx, job["jobId"], {"round": rounds, "kind": "skip", "of": "trailer", "reason": reason,
                                   "eventId": "s_" + uuid.uuid4().hex[:10], "at": _iso(time.time()), "seconds": 0,
                                   **_timing(time.time(), round_end, pre)})


def _timing(cued: float, round_end: float | None, pre: dict | None = None) -> dict:
    """How the break sits against its round's end: cuedAt (the InsertAdBreak call), roundEndAt, and endToAdSec, where
    the ad starts in the stream after the round's end (cuedAt + STREAM_LEAD_SEC − roundEndAt: what each viewer sees on
    its own picture, whatever its delay). A pre-cue has the expected end until the round report brings the real one."""
    out = {"cuedAt": _iso_ms(cued)}
    if pre:
        out.update(preCue=True, leadSec=pre["lead"], expectedEndAt=_iso_ms(pre["endsAt"]))
        if pre.get("estimated"):
            out["estimated"] = True
    end = round_end if round_end else (pre or {}).get("endsAt")
    if end:
        out.update(roundEndAt=_iso_ms(end), endToAdSec=round(cued + STREAM_LEAD_SEC - end, 1))
    return out


def _round_ended(ctx, job_id, rounds, ended):
    """A pre-cued round's report: its break now has the real round end (and so the real delay)."""
    def fix(st):
        b = next((b for b in reversed(st.get("breaks", [])) if b.get("round") == rounds and b.get("preCue")), None)
        if not b:
            return False
        cued = viewers.epoch(b["cuedAt"])
        b.update(roundEndAt=_iso_ms(ended), endToAdSec=round(cued + STREAM_LEAD_SEC - ended, 1))
    _rmw(ctx, STATUS_KEY, fix, job_id)


def round_eta(ctx, session: dict, body: dict) -> dict:
    """The play window knows when the round being played ends (a survive stage's seconds, a time limit): {round, endsInMs,
    sentAt}. A round that ends in a full-screen trailer break gets the break now when the end is preCueLeadSec away
    (or less), so the stitched ad starts a moment after each viewer saw the round end; told earlier, the answer says
    when to send again. A clear or a death before that keeps the cue at the round report."""
    job = _player_job(ctx, session)
    rounds = body.get("round")
    ends_in = body.get("endsInMs")
    if isinstance(rounds, bool) or not isinstance(rounds, int) or rounds < 1:
        raise LiveError(400, "bad_request", "몇 번째 판인지 읽지 못했어요. 플레이 창을 새로 고쳐 주세요.")
    if body.get("cancel") is True:  # the game took its estimate back: a call still waiting for its moment is called off
        _update_job(ctx, job["jobId"], lambda j: j.update(etaCancel=rounds))
        return {"preCued": False, "reason": "called_off"}
    if isinstance(ends_in, bool) or not isinstance(ends_in, (int, float)) or not 0 <= ends_in <= 900_000:
        raise LiveError(400, "bad_request", "판이 끝날 시간을 읽지 못했어요. 플레이 창을 새로 고쳐 주세요.")
    asked = _job_lead(job)  # the broadcast's lead: when the play window reports follows it
    estimated = body.get("estimated") is True
    lead = _lead_now(job)
    if lead and estimated:
        lead = max(0.5, lead - PRECUE_EST_MARGIN_SEC)
    now = time.time()
    ends_at = now + ends_in / 1000
    # endsAtMs: the end as an instant of this server's clock (the play window knows the clock from its status polls),
    # which does not move with the request's way here
    told = body.get("endsAtMs")
    if isinstance(told, (int, float)) and not isinstance(told, bool) \
            and ends_at - PRECUE_TRANSIT_MAX_SEC <= told / 1000 <= ends_at:
        ends_at = told / 1000
    if job.get("adType", "trailer") != "trailer" or not lead or not _cue_round(job, rounds):
        return {"preCued": False, "reason": "no_trailer_round"}
    if job.get("preCued") == rounds or job.get("roundsDone", -1) >= rounds:
        return {"preCued": job.get("preCued") == rounds, "reason": "done"}
    _update_job(ctx, job["jobId"], lambda j: j.update(
        roundEta={"round": rounds, "endsAt": ends_at, "callAt": ends_at - lead}))
    if ends_at - now > asked + PRECUE_PREP_SEC + PRECUE_SLACK_SEC:
        return {"preCued": False, "reason": "early",
                "sendInMs": round((ends_at - now - asked - PRECUE_PREP_SEC) * 1000)}
    won = []

    def claim(j):  # one pre-cue per round
        if j.get("preCued") == rounds:
            return False
        j["preCued"] = rounds
        j.pop("etaCancel", None)
        won.append(True)
    job = _own(_update_job(ctx, job["jobId"], claim))
    if not won:
        return {"preCued": True, "reason": "done"}

    pre = {"endsAt": ends_at, "lead": lead, **({"estimated": True} if estimated else {})}

    def look() -> bool:
        """The job as it is now → whether the break may still go. A round that was reported meanwhile ended before
        the end it told (a death, an early clear, a race finished sooner than its pace said): pre["ended"]."""
        j = _get_json(ctx, JOB_KEY) or {}
        if j.get("jobId") == job["jobId"] and j.get("roundsDone", 0) >= rounds and j.get("roundEndAt"):
            pre["ended"] = j["roundEndAt"]
        return j.get("jobId") == job["jobId"] and not j.get("stop") and j.get("etaCancel") != rounds
    # go: right before the call (still this broadcast's round, its end not taken back). rush: during the wait. When
    # the round is over already the break goes at once: the soonest it can follow the real end. Called off: no more
    # waiting
    pre.update(go=look, rush=lambda: not look() or "ended" in pre)
    try:  # never waits (a transcode, a warm-up): the best warmed creatives go now, or this round has no ad
        sent = _cue_trailer(ctx, job, rounds, pre=pre)
    except (ClientError, LiveError) as e:  # not live: the round report cues it the normal way
        _update_job(ctx, job["jobId"], lambda j: j.pop("preCued", None))
        return {"preCued": False, "reason": getattr(e, "code", None) or _code(e)}
    return {"preCued": True, "leadSec": lead} if sent else {"preCued": True, "skipped": True}


def _lead_now(job) -> float:
    """The pre-cue's lead for the next call: the broadcast's, and never more than the earliest place its own last
    breaks took after their calls allows (the tiles' smallest reading less its bias, _ad_shown) less
    PRECUE_MARGIN_SEC: shorter at once, longer than the broadcast's own only with PRECUE_SEEN_MIN breaks measured and
    never past PRECUE_LEAD_MAX_SEC. The earliest ad then starts a second after the round's end, never before it."""
    lead = _job_lead(job)
    seen = list((job.get("leadSeen") or {}).values())
    if not lead or not seen:
        return lead
    fits = round(min(seen) - TILE_LEAD_BIAS_SEC - PRECUE_MARGIN_SEC, 2)
    return max(0.5, min(fits, PRECUE_LEAD_MAX_SEC if len(seen) >= PRECUE_SEEN_MIN else lead))


def _job_lead(job) -> float:
    """The broadcast's pre-cue lead as the call's. A job with no leadAtCall carries the lead of the play window's
    report instead (longer: the ad would start before the round's end), so it never gets more than the default."""
    lead = job.get("preCueLeadSec", PRECUE_LEAD_SEC)
    return lead if job.get("leadAtCall") else min(lead, PRECUE_LEAD_SEC)


PRECUE_PLACE_MAX_SEC = 6.5  # the latest a break sits after its call, seconds (measured 4.1–6.3)


def _precue_hold(job, rounds, ended) -> float | None:
    """A pre-cued round's ad starts up to PRECUE_PLACE_MAX_SEC after its call, and the built-in player starts the next
    round 4 s after the end, which an estimated end's ad can overrun. → the end screen's hold until then."""
    eta = job.get("roundEta") or {}
    if eta.get("round") != rounds:
        return None
    return round(max(0.0, eta.get("callAt", ended) + PRECUE_PLACE_MAX_SEC - ended), 1) or None


def _early_hold(job, rounds, ended) -> float | None:
    """A pre-cued round that ended EARLY_END_SEC or more before the end it had told: its break was timed for that
    end (or goes out now, from the waiting call: within PRECUE_POLL_SEC), so the ad starts as long after the real end
    as one cued at the report. → how long the built-in player keeps the end screen for it, else None."""
    eta = job.get("roundEta") or {}
    if eta.get("round") != rounds or eta["endsAt"] - ended <= EARLY_END_SEC:
        return None
    return round(END_HOLD_SEC + max(0.0, min(eta.get("callAt", ended) - ended, PRECUE_POLL_SEC)), 1)


def _ad_shown(ctx, job, vid: str, lead_ms=None, break_id=None) -> dict:
    """A tile's player began a stitched ad (the watch page's report: the player's AD_BREAK_STARTED): a full-screen
    break really aired, on this tile `shown` seconds after its call: the one whose mark the report names (break_id),
    else the newest. leadMs: from the break's mark to the ad on this tile's own picture, i.e. where the break sat in
    the stream after the call; the log's 판 끝 → 광고 then is what the tiles saw (their median) instead of the usual
    place, and the earliest goes to the job (_lead_now). A reading under MIN_TILE_LEAD_SEC is not one."""
    now = time.time()
    given = lead_ms is not None
    real = isinstance(lead_ms, (int, float)) and not isinstance(lead_ms, bool) and 0 < lead_ms <= 20_000
    lead = round(lead_ms / 1000, 2) if real and lead_ms >= MIN_TILE_LEAD_SEC * 1000 else None
    got = {}

    def note(st):
        aired = [b for b in reversed(st.get("breaks", [])) if b.get("kind") == "trailer" and b.get("cuedAt")]
        b = next((b for b in aired if break_id and b.get("breakId") == break_id), None) or next(iter(aired), None)
        cued = viewers.epoch(b["cuedAt"]) if b else 0
        if not b or not 0 <= now - cued <= SHOWN_WINDOW_SEC or (given and not real):
            return False
        b.setdefault("shown", {}).setdefault(vid, round(now - cued, 1))
        b.pop("lost", None)  # judged too soon: it aired after all
        b.pop("unseen", None)
        if lead is not None:
            b.setdefault("tileLead", {})[vid] = lead
            ago = b.get("markLeadSec", 0)  # the mark left this long before the call
            leads = sorted(x - ago for x in b["tileLead"].values())
            if b.get("roundEndAt"):
                mid = (leads[(len(leads) - 1) // 2] + leads[len(leads) // 2]) / 2
                # for the list: the readings less the least they are over the pictures, and never before the end
                after = cued + mid - TILE_LEAD_LOG_BIAS_SEC - viewers.epoch(b["roundEndAt"])
                b.update(endToAdSec=max(0.0, round(after, 1)), measured=len(leads))
            got["first"] = round(leads[0], 2)
        got["e"] = b["eventId"]
    _rmw(ctx, STATUS_KEY, note, job["jobId"])
    if not got:
        return {"recorded": False}

    def seen(j):
        checked = (j.get("airCheck") or {}).get("e") == got["e"]
        known = (j.get("leadSeen") or {}).get(got["e"])
        if not checked and ("first" not in got or known == got["first"]):
            return False
        if checked:
            j.pop("airCheck")
        if "first" in got:
            j.setdefault("leadSeen", {})[got["e"]] = got["first"]
            for old in list(j["leadSeen"])[:-PRECUE_SEEN]:
                j["leadSeen"].pop(old)
    _update_job(ctx, job["jobId"], seen)
    return {"recorded": True}


def _check_aired(ctx, job) -> dict:
    """On the status polls: the newest full-screen break, LOST_AFTER_SEC after its call. No tile reported its ad while
    a watch page that reports them was open: it did not air. The break log says so (lost) and the round being played
    ends in a full-screen break instead of whatever it was due (makeup), once: a lost make-up is not made up again,
    and a break sent again at once would land in the middle of the next round. No reporting page: nothing is known,
    the log stays as it is."""
    chk = job.get("airCheck")
    if not chk or time.time() - chk["at"] < LOST_AFTER_SEC:
        return job
    lost = []

    def claim(j):
        lost.clear()
        if (j.get("airCheck") or {}).get("e") != chk["e"]:
            return False
        j.pop("airCheck")
        # a page that reports was open after the call and still is (a beat in the last WATCH_FRESH_SEC). Any other
        # page (closed, reloaded, stalled: it beats only for tiles that play) cannot tell a lost break from its own
        # stall: no make-up, and the log says the ad was not confirmed (unseen)
        if j.get("adWatchAt", 0) < chk["at"] or time.time() - j["adWatchAt"] > WATCH_FRESH_SEC:
            lost.append("unseen")
            return None
        lost.append("lost")
        if not chk.get("makeup") and not j.get("stop"):
            j["makeup"] = j.get("roundsDone", 0) + 1
    job = _update_job(ctx, job["jobId"], claim) or job
    if lost:
        if lost[0] == "lost":
            print(f"full-screen break {chk['e']} did not air: no tile showed it {LOST_AFTER_SEC} s after its call")

        def mark(st):
            b = next((b for b in st.get("breaks", []) if b.get("eventId") == chk["e"]), None)
            if not b or b.get("shown"):
                return False
            b[lost[0]] = True
            if lost[0] == "lost":  # (unseen keeps where it should have started; the list says 확인 안 됨)
                b.pop("endToAdSec", None)
        _rmw(ctx, STATUS_KEY, mark, job["jobId"])
    return job


def _people_picks(ctx, job, kind, items, default: dict, base: str, none: str, usable=None) -> dict:
    """{"" : default, viewerId: served pick}: each dummy viewer's decision of this style; a viewer without one gets the
    default with the reason why."""
    people, dec = _decide(ctx, job, items, usable=usable, kind=kind)
    got = {"": {**default, "reason": base, "reasons": [base]}}
    for v in people:
        d = dec.get(v["viewerId"]) or {}
        p = adserver.served(d) or {**default, "reason": none, "reasons": [none]}
        if d.get("fallback"):
            p["fallback"] = True
        got[v["viewerId"]] = p
    return got


def _with_personas(shown: dict) -> dict:
    for persona, vid in viewers.PERSONA_VIEWER.items():  # an old persona window reads its own key
        if vid in shown:
            shown[persona] = shown[vid]
    return shown


def _cue_corner(ctx, job, rounds, extra: dict | None = None):
    """The corner trailer: each viewer's own trailer (kind "corner": its frequency cap counts the full-screen ones too),
    in timed metadata on the round's last frame; the player draws it muted in the corner for CORNER_SEC. No break, no
    MediaTailor: its impression is the watch page's beacon (/live/ad-event). The break log has the cue's wait too: a
    stitched ad replaces the frame the cue rides on, so a tile inside its full-screen ad shows the corner from the
    log when its ad ends. extra: more for its log entry (a corner in place of a full-screen break: instead, note)."""
    default = {**_default(job), "gameUrl": job.get("gameUrl", "")}
    got = _people_picks(ctx, job, "corner", _inventory(ctx, job), default, tr("기본 코너 광고 (시청자 정보 없음)"),
                        tr("맞춤 트레일러가 없어 기본 트레일러"))
    event_id = "c_" + uuid.uuid4().hex[:10]
    now = time.time()
    nxt = _next_ad(job, rounds, now)  # a tile showing a full-screen ad holds the corner until then, at most this long
    wait = CORNER_WAIT_SEC if nxt is None else max(0, int(nxt - CORNER_GAP_SEC - CORNER_SEC - now))
    _meta(ctx, {"type": "corner", "e": event_id, "round": rounds, "seconds": CORNER_SEC, "wait": wait})
    shown = {k: {f: p[f] for f in ("title", "creative", "url", "seconds", "reason", "reasons", "genre", "gameUrl", "score")
                 if f in p} for k, p in got.items()}
    _log_break(ctx, job["jobId"], {"round": rounds, "eventId": event_id, "at": _iso(time.time()), "kind": "corner",
                                   "seconds": CORNER_SEC, "wait": wait, "title": default["title"],
                                   "picks": _with_personas(shown), **(extra or {})})
    _update_job(ctx, job["jobId"], lambda j: j.update(cornerBreaks=j.get("cornerBreaks", 0) + 1))


def _playable_picks(ctx, job) -> dict:
    """{"" | viewerId: pick} of the job's next playable card: each viewer its own game (kind "playable" over the owner's
    published 3D games), one playable ad per game (server/playable.for_game). No published game: everyone gets the
    broadcast's own. Decided from the viewers' logs and the break number alone, so asked ahead of the cue it names the
    games the cue will (launcher_ahead), unless a log grows in between."""
    from server import playable
    secs = job["playableSeconds"]
    default = {"adId": job["playableAdId"], "gameId": job["gameId"], "title": job["adTitle"], "seconds": secs,
               "creative": "pg_" + job["gameId"]}
    got = _people_picks(ctx, job, "playable", _playables(ctx, job), default, tr("기본 플레이어블 (시청자 정보 없음)"),
                        tr("추천할 게임이 없어 이 방송의 게임"))
    shown = {}
    for k, p in got.items():
        if p.get("adId") != job["playableAdId"] and p.get("gameId"):
            try:
                ad = playable.for_game(ctx, p["sessionId"], p["gameId"], secs)
                p = {**p, "adId": ad["adId"], "ctaUrl": ad.get("ctaUrl"), "trailerUrl": ad.get("trailerUrl")}
            except Exception as e:  # noqa: BLE001 — the game went away: the broadcast's own
                print(f"playable ad for {p.get('gameId')} failed: {e}")
                own = tr("추천할 게임이 없어 이 방송의 게임")
                p = {**default, "reason": own, "reasons": [own]}
        shown[k] = {f: p[f] for f in ("adId", "gameId", "title", "creative", "reason", "reasons", "genre", "score",
                                      "ctaUrl", "trailerUrl") if p.get(f) is not None}
        shown[k]["seconds"] = secs
    return shown


def _cue_playable(ctx, job, rounds):
    """The playable card: each viewer its own game (_playable_picks); the card itself rides on timed metadata, so each
    tile shows it when its video reaches this round's end."""
    secs = job["playableSeconds"]
    shown = _playable_picks(ctx, job)
    event_id = uuid.uuid4().hex[:12]
    _meta(ctx, {"type": "playable", "e": event_id, "adId": job["playableAdId"], "seconds": secs, "round": rounds,
                "title": job["adTitle"][:40]})
    _log_break(ctx, job["jobId"], {"round": rounds, "eventId": event_id, "at": store.now(), "seconds": secs,
                                   "kind": "playable", "playable": True, "playUrl": job["playUrl"],
                                   "adId": job["playableAdId"], "picks": _with_personas(shown)})
    def done(j):
        j["playableBreaks"] = j.get("playableBreaks", 0) + 1
        j.pop("playableDue", None)
        j["playableCue"] = {"e": event_id, "at": time.time()}
    _update_job(ctx, job["jobId"], done)
    _hint_launchers(ctx, job, shown)


def _hint_launchers(ctx, job, shown):
    """At the cue: each of the broadcast's waiting launchers whose page named its viewers (launcher_start) is told a
    card is up and which games it offers them, seconds before the card reaches the page's video (IVS latency) and is
    clicked. A launcher that held the next card's games ahead (launcher_ahead) already has them built."""
    from server import playable
    try:
        for launch_id, who in playable.waiting_launchers(ctx, job["jobId"]):
            first, also = _launch_games(ctx, shown, who)
            playable.hint(ctx, job["jobId"], launch_id, first, also)
    except Exception as e:  # noqa: BLE001 — never in the way of the card (the page sends its own hint too)
        print(f"launcher hints failed: {e}")


def _typical(job) -> float | None:
    """The expected round length: the shortest of the last rounds (and of the round being played, when the play
    window told its end), or None before two round ends are known."""
    durs = list(job.get("roundDurs") or [])
    eta = job.get("roundEta") or {}
    if job.get("roundEndAt") and eta.get("round") == job.get("roundsDone", 0) + 1:
        durs.append(eta["endsAt"] - job["roundEndAt"])
    durs = [d for d in durs if d > 1]
    return min(durs) if durs else None


def _next_ad(job, rounds, end) -> float | None:
    """When the next ad after round `rounds` (which ends at `end`) lands in the stream, from the typical round length:
    a full-screen trailer's break STREAM_LEAD_SEC after its cue (lead seconds before its round's end), a corner or a
    playable card at its round's end exactly. None when unknown or there is none."""
    typ = _typical(job)
    if not typ:
        return None
    for k in range(1, 21):
        if _cue_round(job, rounds + k):
            if job.get("adType") != "trailer":
                return end + k * typ
            return end + k * typ - (job.get("preCueLeadSec") or 0) + STREAM_LEAD_SEC
        if job.get("corner"):
            return end + k * typ
    return None


def _cue_trailer(ctx, job, rounds, round_end=None, pre=None) -> bool:
    """The trailer break, at once (it never waits for a transcode or a warm-up): each viewer its own campaign,
    decided now from its activity log (adserver.decide, one title per viewer) among the creatives MediaTailor has
    transcoded that fit the room before the next round's ad; a viewer whose best is not ready gets its best ready
    one (the reason says so) and its best moves to the warm-up queue's front. The default file keeps the owner's
    chosen trailer (else the shortest pick that fits). The break is as long as its longest pick, never longer than
    the room. A full-screen ad still on air when this one would land: no ad this round (_skip). No creative ready:
    LiveError ad_warming, its message the break log's sentence (round_done sends corner trailers with it). pre: a
    pre-cue ({endsAt, lead, go?, estimated?}): its call leaves lead seconds before that end (_send_break waits).
    → whether the break went out."""
    now = time.time()
    call_at = max(now, pre["endsAt"] - pre["lead"]) if pre else now
    landing = call_at + STREAM_LEAD_SEC
    if _on_air(job, landing):
        _skip(ctx, job, rounds, "overlap", round_end, pre)
        return False
    nxt = _next_ad(job, rounds, round_end or (pre or {}).get("endsAt") or now)
    room = None if nxt is None else min(300.0, nxt - CORNER_GAP_SEC - landing)
    if room is not None and room < MIN_BREAK_SEC:
        _skip(ctx, job, rounds, "no_room", round_end, pre)
        return False

    def fits(c):
        return room is None or float(c["seconds"]) <= room

    def usable(c):
        return _warmed(job, c["url"]) and fits(c)
    default = _default(job)
    people, dec = _decide(ctx, job, _inventory(ctx, job), usable=usable)
    base = tr("기본 광고 (시청자 정보 없음)")
    got, warm_first = {"": {**default, "reason": base, "reasons": [base]}}, []
    for v in people:
        d = dec.get(v["viewerId"]) or {}
        best = (d.get("best") or {}).get("campaign")
        if best and not _warmed(job, best["url"]):
            warm_first.append(best)
        note = tr("준비 중") if best and not _warmed(job, best["url"]) else tr("길이 초과")
        none = tr("준비된 맞춤 광고가 없어 기본 광고")
        p = adserver.served(d, note) or {**default, "reason": none, "reasons": [none]}
        p["provider"] = adserver.provider(v["viewerId"])
        if d.get("fallback"):
            p["fallback"] = True
        got[v["viewerId"]] = p
    if not usable(default):  # no-persona viewers: the shortest ready pick that fits, else the default as it is
        ready = sorted((p for k, p in got.items() if k and usable(p)), key=lambda p: p["seconds"])
        if ready:
            got[""] = {**ready[0], "reason": base, "reasons": [base], "fallback": True}
    # Nothing in this break has been transcoded: MediaTailor would skip every file's creative and the log would still
    # say an ad went out. No break: the caller sends each viewer's corner trailer (nothing to transcode) with this
    # sentence in the break log; a pre-cue leaves the round to its report, since a corner rides on its last frame
    if not any(_warmed(job, p["url"]) for p in got.values()):
        print(f"trailer cue of round {rounds}: no creative is ready, corner trailers instead")
        sent = any(p["url"] in job.get("warmedAt", {}) for p in got.values())  # a warm-up of one of them is out
        raise LiveError(409, "ad_warming", (tr(AD_WARMING, wait=i18n.span(waits.TRAILER_PREP)) if sent
                                            else tr(AD_NOT_STARTED, wait=i18n.span(waits.TRAILER_PREP))))
    picks = {k: {f: p[f] for f in ("url", "title", "seconds", "creative")} for k, p in got.items()}
    secs = max(p["seconds"] for p in picks.values())
    if room is not None:
        secs = min(secs, room)
    try:  # cued: when the call left (the break log's cuedAt)
        event_id, break_id, cued, mark_ago = _send_break(ctx, job, picks, seconds=secs, cue=True, at=call_at if pre else None,
                                               go=(pre or {}).get("go"), rush=(pre or {}).get("rush"))
        # the round was reported while the call waited: the log has the end that came, not the one that was told
        round_end = round_end or (pre or {}).get("ended")
    except LiveError as e:
        if e.code != "ad_busy":
            raise
        _skip(ctx, job, rounds, "overlap", round_end, pre)  # another full-screen break got on air in between
        return False
    # a creative named in a watched break gets transcoded by it; the bests still warming go first in the queue
    _mark_warm(ctx, job, {p["url"] for p in picks.values()} - set(job.get("warmedAt", {})))
    if warm_first:
        def queue(j):
            for c in reversed(warm_first):
                _want_warm(j, c["url"], c["title"], c["seconds"], c["creative"], first=True)
        _update_job(ctx, job["jobId"], queue)
    for vid, p in got.items():
        if vid:  # the impression beacon turns this into the viewer's ad_impression (and its click or skip), marked
            # with the broadcast's owner: only that account's /api/live/viewers shows the line (it names the title)
            store._put(ctx, f"ADBREAK#{break_id}", f"SERVED#{vid}", {**{k: v for k, v in p.items() if k != "url"},
                                                                    "owner": job.get("ownerSub", "")})
    shown = {}
    for k, p in got.items():
        # url: the console plays the trailer as a preview over its mirror
        shown[k] = {f: p[f] for f in ("title", "creative", "url", "seconds", "reason", "reasons", "genre", "score", "fallback")
                    if f in p}
        if p.get("provider") == "gam":
            shown[k]["provider"] = "gam"
    for persona, vid in viewers.PERSONA_VIEWER.items():  # an old persona window's badge reads its own key
        shown[persona] = shown[vid]
    _log_break(ctx, job["jobId"], {"round": rounds, "eventId": event_id, "breakId": break_id,
                                   "at": _iso(time.time() + AD_LEAD_SEC), "kind": "trailer",
                                   "seconds": secs, "title": picks[""]["title"], "picks": shown,
                                   **({"roomSec": round(room, 1)} if room is not None else {}),
                                   **({"makeup": True} if job.get("makeup") == rounds else {}),
                                   **({"markLeadSec": mark_ago} if mark_ago >= 0.05 else {}),
                                   **_timing(cued, round_end, pre)})
    if pre and not round_end and pre.get("go"):
        pre["go"]()  # one more look: a round reported between the call and this log entry
        if pre.get("ended"):
            _round_ended(ctx, job["jobId"], rounds, pre["ended"])
    # airCheck: whether a tile shows it is looked at LOST_AFTER_SEC after the call (_check_aired)
    check = {"e": event_id, "at": cued, **({"makeup": True} if job.get("makeup") == rounds else {})}
    _update_job(ctx, job["jobId"], lambda j: j.update(trailerBreaks=j.get("trailerBreaks", 0) + 1, airCheck=check,
                                                      replanAt=j.get("breakUntil", time.time())))
    return True


def _tick(ctx, job):
    """On the owner's status polls (every ~4 s): the next plan once a break is over, an automatic linear highlight
    whose creative MediaTailor has had time to transcode once the VAST file is free, and else a warm-up while the
    tiles play (between their heartbeats, so the queue drains early). First, whether the last full-screen break aired
    (_check_aired)."""
    job = _check_aired(ctx, job)
    if _busy(job):
        return
    if job.get("replanAt") and time.time() >= job["replanAt"]:
        won = []

        def claim(j):  # one poller replans (it reads every session of the owner)
            if not j.get("replanAt"):
                return False
            won.append(j.pop("replanAt"))
        job = _update_job(ctx, job["jobId"], claim) or job
        if won:
            try:  # the break is over (its impressions are in the viewers' logs): the next picks, and their warm-ups
                job = _replan(ctx, job)
            except Exception as e:  # noqa: BLE001 — the old plan stays; the ads keep going
                print(f"replan failed: {e}")
    for hid in list(job.get("autoLinear", [])):
        hl = _get_json(ctx, _hl_key(job["jobId"], hid))
        usable = hl and not hl.get("deleted") and hl.get("state") == "ready"
        if usable and not _warmed(job, hl["wideUrl"]):
            continue
        claimed = []

        def take(j, hid=hid):
            claimed.clear()
            if hid not in j.get("autoLinear", []):
                return False
            wanted = usable and j.get("highlightAuto") == "linear"  # switched off meanwhile: dropped, not sent
            if wanted and (_busy(j) or _cue_due(j)):  # not on air when a trailer round's cue comes
                return False
            j["autoLinear"] = [x for x in j["autoLinear"] if x != hid]
            if wanted:
                claimed.append(hid)
        job = _update_job(ctx, job["jobId"], take)
        if job is None:  # replaced by another broadcast
            return
        if claimed:
            try:
                _send(ctx, job, hl, "linear")
            except LiveError as e:
                if e.code == "ad_busy":  # another break claimed the file first: back in the queue
                    _update_job(ctx, job["jobId"], lambda j: False if hid in j.get("autoLinear", [])
                                or j.get("highlightAuto") != "linear" else j.setdefault("autoLinear", []).append(hid))
                else:
                    print(f"auto linear highlight failed: {e.message}")
            return
    if _active(job) and any(w["url"] not in job.get("warmedAt", {}) for w in job.get("warm", [])):
        _warm(ctx, job)


def status(ctx, session: dict) -> dict:
    job = _get_json(ctx, JOB_KEY) or {}
    # the API ends a player broadcast after maxMinutes (the play window also stops it on close; reap catches the rest)
    if job.get("mode") == "player" and not job.get("stop") and store.age_sec(job["startedAt"]) > 60 * job.get("maxMinutes", MAX_MINUTES):
        return stop(ctx, {"sessionId": job["sessionId"]}) if job["sessionId"] == session["sessionId"] else _status(ctx, session, {})
    if job.get("standby") and not job.get("stop") and time.time() > job.get("standbyGraceUntil", math.inf):
        _release(ctx, job["jobId"])  # switched to trailer and not back within the grace period
        job = _get_json(ctx, JOB_KEY) or {}
    out = _status(ctx, session, job)
    if out["job"] and job.get("mode") == "player":  # the control room and the play window count down to the cap
        out["job"]["secondsLeft"] = max(0, round(60 * job.get("maxMinutes", MAX_MINUTES) - store.age_sec(job["startedAt"])))
    return out


def _status(ctx, session, job):
    mine = job.get("sessionId") == session["sessionId"] and not job.get("stop")
    chan = _channel(ctx)
    live = mine and _stream_state(ctx) == "LIVE"
    took = job.get("tookOver")  # the session whose broadcast this job's start ended
    if live:
        if time.time() - job.get("liveAt", 0) > 30:
            job = _update_job(ctx, job["jobId"], lambda j: j.update(liveAt=time.time())) or job
        _tick(ctx, job)
        fresh = _get_json(ctx, JOB_KEY) or {}
        if fresh.get("jobId") == job.get("jobId"):
            job = fresh
            mine = not job.get("stop")
        else:  # replaced meanwhile by another session's start
            mine, live, job, took = False, False, {}, fresh.get("tookOver")
    # the broadcast of this session that is over, while it is still the channel's last one: its status file is there
    over = not mine and job.get("sessionId") == session["sessionId"] and bool(job.get("stop"))
    st = (_get_json(ctx, STATUS_KEY) or {}) if mine or over else {}
    if st.get("jobId") != job.get("jobId"):
        st = {}
    # What it sent, for the console to keep on screen once the broadcast is off (`stream` goes only with one on air).
    # ads: the break log without its skipped rounds, as the console counts it. Until the channel's next broadcast
    # starts (the files are the channel's)
    last = {"lastBroadcast": {"rounds": st.get("rounds", 0),
                              "ads": sum(1 for b in st.get("breaks") or [] if b.get("kind") != "skip")}} if over and st else {}
    st = st if mine else {}
    # What opens the channel goes to the session on air and to nobody else: the stream key and the ingest endpoint
    # to publish with, and the playback token of the private channel
    ingest = ({"endpoint": os.environ.get("LIVE_IVS_INGEST", ""), "streamKey": os.environ.get("LIVE_IVS_KEY", "")}
              if mine else None)
    # now: this server's clock as the answer leaves (the play window names a round's end on it, round_eta)
    return {"active": mine, "mode": job.get("mode") if mine else None, "ingest": ingest, "now": time.time(),
            # RUNNING = the IVS stream is live (the play window publishes); STARTING = on air, not yet live
            "channelState": "RUNNING" if live else ("STARTING" if mine else "IDLE"),
            # private channel: a token for the default persona (the watch window asks /api/live/token for others)
            "playbackUrl": ads.playback_url(ctx, chan) if mine else "", "adInsertion": "ivs" if chan.get("ads") else None,
            # this session's broadcast was ended by its owner's start in another session (the play window says so)
            **({"endedBy": "takeover"} if not mine and took == session["sessionId"] else {}),
            **last,
            # (never `starting`: the claim of a start under way, which may be another account's over this session's
            # dead broadcast)
            "job": {**{k: v for k, v in job.items() if k != "starting"}, "standbyToken": _token(ctx, job.get("jobId")),
                    # when the play window reports a round's known end: the lead and the time the picks take
                    "preCueSendSec": _lead_now(job) + PRECUE_PREP_SEC if job.get("preCueLeadSec") else 0,
                    "standbyOff": _manual(ctx).get("mode") == "off"} if mine else None,
            "health": _stream_cache.get("health") if live else None,
            "stream": {k: st.get(k) for k in ("state", "rounds", "breaks", "updatedAt", "error")} if st else None,
            # a stopped broadcast keeps its highlights on screen (they are still in S3)
            "highlights": _highlights(ctx, job) if job.get("sessionId") == session["sessionId"] and job.get("mode") == "player" else []}


def beat(ctx, session: dict) -> dict:
    """The play window is still open (every ~20 s while on air)."""
    job = _get_json(ctx, JOB_KEY) or {}
    if job.get("sessionId") != session["sessionId"] or job.get("stop") or job.get("mode") != "player":
        raise LiveError(409, "not_live", tr(NOT_ON_TEXT))
    _update_job(ctx, job["jobId"], lambda j: False if j.get("stop") else j.update(beatAt=time.time()))
    return {"ok": True}


def viewer(ctx, session: dict, body: dict | None = None) -> dict:
    """A viewer (the watch window, the control room's live tab) is playing the stream (every ~15 s): the moment
    MediaTailor can see a warm-up break, so pending new creatives get theirs. body.viewers: the dummy viewers whose
    tiles are playing: their watch time grows, and each can warm its own creative."""
    job = _get_json(ctx, JOB_KEY) or {}
    if job.get("sessionId") != session["sessionId"] or job.get("stop") or job.get("mode") != "player":
        return {"warmed": False}
    raw = (body or {}).get("viewers") if isinstance(body, dict) else None
    ids = [v for v in dict.fromkeys(viewers.resolve(x) for x in (raw if isinstance(raw, list) else [])
                                    if isinstance(x, str)) if v]
    # reports: this page tells when a tile's player begins a stitched ad (/live/ad-event trailer start), so a break
    # no tile showed while it was open did not air (_check_aired)
    reports = isinstance(body, dict) and body.get("reports") is True
    if ids:
        viewers.watch(ctx, ids, job)
    if ids or reports:
        now = time.time()

        def beat(j):
            j.setdefault("seen", {}).update({v: now for v in ids})
            if reports:
                j["adWatchAt"] = now
        job = _update_job(ctx, job["jobId"], beat) or job
    if not [w for w in job.get("warm", []) if w["url"] not in job.get("warmedAt", {})] or _busy(job):
        return {"warmed": False}
    if _stream_state(ctx) != "LIVE":
        return {"warmed": False}
    return {"warmed": _warm(ctx, job)}


def reap(ctx) -> dict:
    """Scheduled (every 5 min): a player broadcast whose window went away (no beat for 2 min) or that ran past its
    cap is stopped, so a closed tab never leaves the stream running; and an idle host that no running playable
    broadcast needs is released (a release that failed at stop is retried here)."""
    job = _get_json(ctx, JOB_KEY) or {}
    reaped = False
    if job.get("mode") == "player" and not job.get("stop"):
        gone = not _alive(job)  # its window went quiet, or it ran past its cap
        dead = False
        if not gone:  # the window still beats but its publish died (network change, sleep)
            try:
                dead = (_stream_state(ctx, fresh=True) != "LIVE"
                        and (time.time() - job["liveAt"] if job.get("liveAt") else store.age_sec(job["startedAt"])) > DEAD_PUBLISH_SEC)
            except Exception as e:  # noqa: BLE001 — IVS trouble must not keep the rest of the reap from running
                print(f"reap: stream state unknown: {e}")
        if gone or dead:
            stop(ctx, {"sessionId": job.get("sessionId")}, job_id=job["jobId"])
            reaped = True
    job = _get_json(ctx, JOB_KEY) or {}
    if job.get("stop") or not job:  # nobody is on air: a stream still publishing with the key is ended
        try:
            if _stream_state(ctx, fresh=True) == "LIVE":
                ctx.ivs.stop_stream(channelArn=_channel(ctx)["arn"])
        except Exception as e:  # noqa: BLE001
            print(f"orphan stream stop failed: {e}")
    _reconcile_idle(ctx)
    return {"reaped": reaped}


def _needs_idle(ctx) -> tuple:
    """(needed, job): from a fresh read of the job and the switch."""
    job = _get_json(ctx, JOB_KEY) or {}
    manual = _manual(ctx).get("mode")
    wanted = job.get("adType") == "playable" or time.time() <= job.get("standbyGraceUntil", 0)
    return manual == "on" or (manual != "off" and not job.get("stop") and wanted), job


def _reconcile_idle(ctx):
    """The idle host as it should be: held while the switch or a running playable broadcast needs it (re-asserted
    if a race or a failed call left it off), else released (a failed release at stop is retried here). A start and
    the playable tab's pre-warm ask for the host before they write the job or the hold that needs it, and one that
    finds it up asks for nothing: a release under way then takes it from them. So a release looks once more after
    it, and those two look again after they wrote (start, _prewarm)."""
    try:
        needed, job = _needs_idle(ctx)
        held = _idle_held(ctx)
        if needed and not held:
            err = _standby(ctx, True)
            if job.get("jobId") and not job.get("stop"):
                _update_job(ctx, job["jobId"], lambda j: j.update(standby=err is None, standbyError=err))
        elif not needed and (held or job.get("standby")):
            if _needs_idle(ctx)[0]:  # a start landed meanwhile
                return
            if _standby(ctx, False) is None and job.get("jobId") and job.get("standby"):
                _update_job(ctx, job["jobId"], lambda j: j.update(standby=False, standbyError=None))
            if _needs_idle(ctx)[0]:  # a start or a pre-warm landed while it was going: back on
                _reconcile_idle(ctx)
    except Exception as e:  # noqa: BLE001 — the next reap tries again
        print(f"reap: idle host reconcile failed: {e}")


def _location(ctx) -> dict:
    from server import streams
    loc = next((x for x in streams.client().get_stream_group(Identifier=streams._web_group()).get("LocationStates", [])
                if x.get("LocationName") == streams._region()), {})
    return loc


def _lapse_hold(ctx):
    """A hold whose time is up (the switch set by hand, or the playable tab's pre-warm) ends here, once, at the
    control room's poll (not left to the 5-minute reap): the switch goes back to automatic and the host goes unless
    a broadcast needs it. What ends is the switch's own file: while a start takes a pre-warm over, the file is
    already "auto" and its job not yet written, so a poll in between releases nothing; a hold renewed meanwhile
    stays (the conditional write)."""
    over = []

    def end(doc):
        over.clear()
        if doc.get("mode") != "on" or time.time() <= doc.get("until", 0):
            return False
        doc.clear()
        doc.update(mode="auto", at=time.time())
        over.append(True)

    try:
        _rmw(ctx, STANDBY_KEY, end)
    except Exception as e:  # noqa: BLE001 — the reap ends it
        print(f"standby hold lapse failed: {e}")
        return
    if over:
        _reconcile_idle(ctx)


def standby_status(ctx, session: dict) -> dict:
    """The playable-ad server as the control room shows it: off | warming (a host is being allocated: the cold wait
    of waits.CLOUD_START_SEC) | ready (an idle host waits), and how many hosts are allocated (a hidden viewer session
    uses one). startSec: how long a stream takes to start with a host held (warm) and without (cold), seconds, from
    that table (the pages type no figure of their own). prewarmSec: how long 미리 켜기 holds the server when no
    broadcast takes it over (PREWARM_SEC), in every answer. The control room asks every 5 s: a hold whose time is up
    ends at that poll (_lapse_hold)."""
    _lapse_hold(ctx)
    try:
        loc = _location(ctx)
    except Exception as e:  # noqa: BLE001
        print(f"standby status failed: {e}")
        raise LiveError(503, "streams_unavailable", "플레이어블 서버 상태를 읽지 못했어요. 잠시 뒤 다시 시도해 주세요.") from None
    target, idle, allocated = loc.get("TargetIdleCapacity") or 0, loc.get("IdleCapacity") or 0, loc.get("AllocatedCapacity") or 0
    manual = _manual(ctx)
    return {"on": target > 0, "state": "off" if not target else ("ready" if idle else "warming"),
            "idle": idle, "allocated": allocated, "max": loc.get("MaximumCapacity", loc.get("OnDemandCapacity", 0)),
            "mode": manual.get("mode", "auto"), "until": manual.get("until"), "prewarm": bool(manual.get("prewarm")),
            "hourlyUsd": GLS_HOURLY_USD, "startSec": {k: list(v) for k, v in waits.CLOUD_START_SEC.items()},
            "prewarmSec": PREWARM_SEC}


def standby_set(ctx, session: dict, body: dict) -> dict:
    """on: hold an idle host now (a pre-warm before a playable broadcast; it goes away after MANUAL_HOLD_SEC);
    off: take it down now, even while a playable broadcast runs (its next instant play then waits for a host).
    prewarm (with on): the playable tab's 미리 켜기 before a broadcast: held PREWARM_SEC (each press renews it), and a
    playable start takes it over; it adds nothing to a host held by hand (ON) or by a broadcast already, and it
    starts the server again after an OFF (_prewarm). Either hold ends at the control room's first standby poll after
    its time (_lapse_hold); with no control room open the reap releases its host.
    Only for an account that could use the server now: its session has a game or its own broadcast is on air
    (NO_GAME_SWITCH_TEXT), and no other account's broadcast holds the channel (SWITCH_BUSY_TEXT)."""
    on = body.get("on")
    if not isinstance(on, bool):
        raise LiveError(400, "bad_request", "플레이어블 서버 설정을 읽지 못했어요. 화면을 새로 고친 뒤 다시 해 주세요.")
    # while another account's broadcast is alive the switch (and the pre-warm) is that account's
    air = _get_json(ctx, JOB_KEY) or {}
    if _others(air, session):
        raise LiveError(409, "live_busy", tr(SWITCH_BUSY_TEXT))
    # the shared GPU host costs GLS_HOURLY_USD an hour and sign-up is open: a session with no game has no broadcast
    # to hold a host for, and nothing of its own to take down. The account whose own broadcast is on air may use the
    # switch from any of its sessions
    mine = _alive(air) and air.get("ownerSub") == session.get("userSub")
    if not mine and not store.snapshot(ctx, session["sessionId"])["games"]:
        raise LiveError(400, "no_game", tr(NO_GAME_SWITCH_TEXT))
    now = time.time()
    if on and body.get("prewarm") is True:
        return _prewarm(ctx, session, now)
    doc = json.dumps({"mode": "on" if on else "off", "by": session["sessionId"], "at": now,
                      **({"until": now + MANUAL_HOLD_SEC} if on else {})})
    if not on:  # OFF first: a release that fails is retried by reap
        _put(ctx, STANDBY_KEY, doc, "application/json")
    err = _standby(ctx, on)
    if err:
        raise LiveError(503, "standby_failed", f"플레이어블 서버를 {'켜지' if on else '내리지'} 못했어요. 잠시 뒤 다시 눌러 주세요.")
    if on:
        _put(ctx, STANDBY_KEY, doc, "application/json")
    job = _get_json(ctx, JOB_KEY) or {}
    if not on and job.get("jobId") and job.get("standby"):  # the broadcast no longer holds it
        _update_job(ctx, job["jobId"], lambda j: j.update(standby=False, standbyError=None))
    if not on and not job.get("stop"):  # no hidden sessions while it is off (the watch windows drop theirs too)
        _end_standby(ctx, job.get("playableAdId"), job.get("jobId"))
    return standby_status(ctx, session)


def _prewarm(ctx, session, now) -> dict:
    """The playable tab's 미리 켜기. Nothing to add when the host is held by hand (its hour would be cut to these ten
    minutes) or by a playable broadcast. An OFF is no reason to stand back: the press is the user's newer word (under
    a broadcast that had taken the host down, too: when its ten minutes are over the broadcast holds the host again)."""
    manual = _manual(ctx)
    by_hand = manual.get("mode") == "on" and not manual.get("prewarm")
    if by_hand or (not manual and _needs_idle(ctx)[0]):
        return standby_status(ctx, session)
    err = _standby(ctx, True)
    if err:
        raise LiveError(503, "standby_failed", "플레이어블 서버를 켜지 못했어요. 잠시 뒤 다시 눌러 주세요.")
    _put(ctx, STANDBY_KEY, json.dumps({"mode": "on", "prewarm": True, "by": session["sessionId"], "at": now,
                                       "until": now + PREWARM_SEC}), "application/json")
    _reconcile_idle(ctx)  # a release under way (an old hold's end, the reap) took the host this found up a moment ago
    return standby_status(ctx, session)


def _idle_held(ctx) -> bool:
    from server import streams
    try:
        loc = next((x for x in streams.client().get_stream_group(Identifier=streams._web_group()).get("LocationStates", [])
                    if x.get("LocationName") == streams._region()), {})
        return (loc.get("TargetIdleCapacity") or 0) > 0
    except Exception:  # noqa: BLE001 — the reconcile is best effort; the next run tries again
        return False


def stop(ctx, session: dict, job_id: str | None = None) -> dict:
    """Ends this session's broadcast (another session's job is left alone; job_id: only that job)."""
    job = _get_json(ctx, JOB_KEY) or {}
    if not job or job.get("sessionId") != session["sessionId"] or (job_id and job.get("jobId") != job_id):
        return _status(ctx, session, job)
    if not job.get("stop"):
        job = _update_job(ctx, job["jobId"], lambda j: j.update(stop=True))
        if job is None:  # replaced meanwhile by another session's start
            return _status(ctx, session, _get_json(ctx, JOB_KEY) or {})
    _end_standby(ctx, job.get("playableAdId"), job["jobId"])
    if job.get("standby"):
        _release(ctx, job["jobId"])
    try:  # a window that went away may still hold the stream key: end its stream too
        ctx.ivs.stop_stream(channelArn=_channel(ctx)["arn"])
    except ClientError as e:
        if _code(e) not in ("ChannelNotBroadcasting", "ResourceNotFoundException", "StreamUnavailable"):
            raise
    _stream_cache.clear()
    return _status(ctx, session, _get_json(ctx, JOB_KEY) or {})


def on_air(ctx, session_id: str) -> bool:
    """This session's broadcast is on (not stopped). No live stack deployed: nothing can be on air."""
    if not os.environ.get("LIVE_BUCKET"):
        return False
    job = _get_json(ctx, JOB_KEY) or {}
    return job.get("sessionId") == session_id and not job.get("stop")


# ── highlights ────────────────────────────────────────────────────────────────

def _player_job(ctx, session):
    job = _get_json(ctx, JOB_KEY) or {}
    if job.get("sessionId") != session["sessionId"] or job.get("stop") or job.get("mode") != "player":
        raise LiveError(409, "not_live", tr(NOT_ON_TEXT))
    return job


def _hl_key(job_id, hid):
    return f"broadcaster/highlights/{job_id}/{hid}.json"


def _highlights(ctx, job) -> list:
    """Newest first. ponytail: one S3 object per highlight (no write races), listed on every status poll."""
    out = ctx.s3.list_objects_v2(Bucket=_env("LIVE_BUCKET"), Prefix=f"broadcaster/highlights/{job['jobId']}/")
    items = [_get_json(ctx, o["Key"]) for o in out.get("Contents", [])]
    return sorted((h for h in items if h and not h.get("deleted")), key=lambda h: h["createdAt"], reverse=True)


def highlight_create(ctx, session: dict, body: dict) -> dict:
    """A round ended on the play window: {round, startedAt, endedAt, sentAt}, epoch ms on the window's clock (sentAt:
    when it sent this, so the server moves the round onto its own clock). The caller self-invokes highlight_run,
    which cuts the round out of the channel's IVS recording: the window uploads nothing."""
    job = _player_job(ctx, session)
    if not job.get("highlightGen"):
        raise LiveError(409, "highlights_off", "하이라이트 자동 생성이 꺼져 있어요. 고급 설정에서 켠 뒤 다시 해 주세요.")
    rounds = body.get("round")
    if isinstance(rounds, bool) or not isinstance(rounds, int) or rounds < 1:
        raise LiveError(400, "bad_request", "몇 번째 판인지 읽지 못했어요. 플레이 창을 새로 고쳐 주세요.")
    times = [body.get(k) for k in ("startedAt", "endedAt", "sentAt")]
    if any(isinstance(t, bool) or not isinstance(t, (int, float)) for t in times):
        raise LiveError(400, "bad_request", "판의 시작과 끝 시간을 읽지 못했어요. 플레이 창을 새로 고쳐 주세요.")
    skew = time.time() - times[2] / 1000
    t0, t1 = (round(t / 1000 + skew, 3) for t in times[:2])
    if t1 - t0 < 1:
        raise LiveError(400, "bad_request", "1초도 안 되는 판은 하이라이트로 만들지 않아요.")
    t0 = max(t0, t1 - 900)  # a longer round: its last 15 minutes
    hid = "hl_" + uuid.uuid4().hex[:10]
    arn = _channel(ctx)["arn"]
    hl = {"id": hid, "round": rounds, "seconds": round(t1 - t0, 2), "window": [t0, t1], "gameId": job.get("gameId"),
          "recording": f"ivs/v1/{os.environ.get('ACCOUNT_ID', '')}/{arn.rsplit('/', 1)[1]}/",
          "sourceKey": f"sessions/{session['sessionId']}/highlights/{hid}/round.mp4", "contentType": "video/mp4",
          "state": "analyzing", "createdAt": store.now()}
    _put(ctx, _hl_key(job["jobId"], hid), json.dumps(hl), "application/json")
    return {"jobId": job["jobId"], **hl}


def pick_moment(segments, length: float) -> dict:
    """The most exciting Pegasus segment (ties: the later one), widened or trimmed to 4–6 s inside the video.
    No usable segment: the last seconds before the round ended (a death or a win)."""
    rank = {"high": 0, "medium": 1, "low": 2}
    ok = [s for s in segments or [] if isinstance(s.get("start_sec"), (int, float))
          and isinstance(s.get("end_sec"), (int, float)) and s["end_sec"] > s["start_sec"]]
    if not ok:
        end = max(length - 0.5, min(HL_MAX, length))
        return {"start": round(max(0.0, end - 5.0), 2), "end": round(end, 2), "title": None, "excitement": None}
    best = min(ok, key=lambda s: (rank.get(s.get("excitement"), 3), -s["start_sec"]))
    dur = min(max(best["end_sec"] - best["start_sec"], HL_MIN), HL_MAX, length)
    mid = (best["start_sec"] + best["end_sec"]) / 2
    start = min(max(mid - dur / 2, 0.0), max(length - dur, 0.0))
    return {"start": round(start, 2), "end": round(start + dur, 2), "title": best.get("title"),
            "excitement": best.get("excitement")}


def game_context(ctx, session_id: str, game_id) -> str:
    """The game a highlight is from, for Pegasus and the title rewrite: its title, genre and mission, so the headline
    keeps to this game's world. "" when it is gone."""
    game = next((g for g in store.snapshot(ctx, session_id)["games"] if g["gameId"] == game_id), None)
    if not game:
        return ""
    try:
        spec = json.loads(ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=game["specKey"])["Body"].read() or b"{}")
    except (ClientError, KeyError, ValueError):
        spec = {}
    mission, obj = spec.get("mission") or {}, spec.get("objective") or {}
    goal = " → ".join(str(st["label"]) for st in mission.get("stages", []) if st.get("label"))
    goal = goal or obj.get("label") or (f"{obj['type']} × {obj.get('target', '')}" if obj.get("type") else "")
    text = f"「{game.get('title') or spec.get('title', '')}」 ({game.get('genre') or spec.get('genre', '')})"
    if mission.get("title") or goal:
        text += ", mission: " + ": ".join(x for x in (mission.get("title"), goal) if x)
    return text[:500]


def _pegasus(ctx, key: str, game: str = "") -> list:
    about = f"the game {game}" if game else "this game"
    body = {"analysis_mode": "time_based_metadata", "temperature": 0, "maxOutputTokens": 2048,
            "segment_time_format": "seconds",
            "mediaSource": {"s3Location": {"uri": f"s3://{ctx.assets_bucket}/{key}",
                                           "bucketOwner": os.environ.get("ACCOUNT_ID", "")}},
            "segment_definitions": [{
                "id": "highlight",
                "description": (f"Exciting moments of one round of {about} that would make a 4 to 6 second highlight "
                                "short: progress on its mission, fights won, narrow escapes, the success or the "
                                "failure at the end. Judge by what this game is about, not by other genres"),
                "fields": [{"name": "title", "type": "string",
                            "description": ((  # in the language of the play window that asked (highlight_run)
                                             "A punchy headline for the moment written in English, under 28 "
                                             if i18n.lang() == "en" else
                                             "A punchy headline for the moment written in Korean (한국어), under 18 ")
                                            + f"characters, about what the player does in {about}; never name things "
                                            "this game does not have")},
                           {"name": "excitement", "type": "string", "enum": ["high", "medium", "low"],
                            "description": "How exciting the moment is to watch"}]}]}
    out = ctx.bedrock_rt_east.invoke_model(modelId=PEGASUS, body=json.dumps(body))
    return json.loads(out["body"].read()).get("segments") or []


FALLBACK_TITLE = "결정적 명장면"


def korean_title(ctx, title: str, game: str = "") -> str:
    """Pegasus often answers in English even when asked for Korean: the agent model rewrites the headline (told
    which game it is from, so it keeps to that game's world)."""
    if not title or re.search(r"[가-힣]", title):
        return title
    try:
        # maxTokens leaves room for the model's reasoning before the title
        ask = (f"게임 {game}의 " if game else "게임 ") + ("하이라이트 쇼츠 제목을 한국어로 짧고 강렬하게 바꿔 줘 (18자 이내, "
                                                        "이 게임에 없는 것은 넣지 말고, 따옴표·설명 없이 제목만): ")
        out = ctx.bedrock_rt_east.converse(modelId=ctx.agent_model_id, inferenceConfig={"maxTokens": 600}, messages=[{
            "role": "user", "content": [{"text": ask + title}]}])
        text = "".join(b.get("text", "") for b in out["output"]["message"]["content"]).strip().strip('"\'“”')
        return text.splitlines()[0][:24] if text else FALLBACK_TITLE
    except Exception:  # noqa: BLE001 — never burn a cut-off English headline into the short
        return FALLBACK_TITLE


def render_cmds(ffmpeg: str, src: str, start: float, seconds: float, title_file: str, foot_file: str, font: str,
                short: str, wide: str) -> list:
    """Two cuts of the moment, with silent stereo audio (ad breaks stitch audio, so the cut has a track too):
    a 720x1280 short (the frame over a blurred fill, title on top) and a 1280x720 linear-ad cut (title below)."""
    text = f"fontfile={font}:fontcolor=white:box=1:boxcolor=black@0.45:x=(w-text_w)/2"
    common = ["-map", "[v]", "-map", "1:a", "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
              "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]
    inputs = [ffmpeg, "-y", "-ss", f"{start:.2f}", "-t", f"{seconds:.2f}", "-i", src,
              "-f", "lavfi", "-t", f"{seconds:.2f}", "-i", "anullsrc=r=48000:cl=stereo"]
    short_vf = ("[0:v]split[a][b];[a]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,"
                "boxblur=20:2,eq=brightness=-0.12[bg];[b]scale=720:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,"
                f"drawtext=textfile={title_file}:{text}:fontsize=52:boxborderw=18:y=180,"
                f"drawtext=textfile={foot_file}:{text}:fontsize=28:boxborderw=12:y=h-230,setsar=1[v]")
    wide_vf = ("[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,"
               f"drawtext=textfile={title_file}:{text}:fontsize=40:boxborderw=14:y=h-110,setsar=1[v]")
    return [[*inputs, "-filter_complex", short_vf, *common, short],
            [*inputs, "-filter_complex", wide_vf, *common, wide]]


def highlight_run(ctx, session_id: str, job_id: str, hid: str) -> dict:
    """Self-invoked: the round's clip is cut from the IVS recording, Pegasus picks the moment, ffmpeg cuts it, the
    highlight turns ready (and goes out if the stream's auto setting says so: an overlay at once, a linear break
    once its creative is warmed)."""
    key = _hl_key(job_id, hid)
    hl = _get_json(ctx, key)
    if not hl:
        return {}
    # the highlight's title and footer are in the language of the play window that asked for it (the payload's
    # "lang", set by app.handler), not the session's latest
    english = i18n.lang() == "en"
    try:
        if hl.get("window"):
            t0, t1 = hl["window"]
            with tempfile.TemporaryDirectory() as tmp:  # the segments fetched while waiting are cut from here
                got = recording.wait_for(ctx, hl["recording"], t0, t1, tmp, ctx.ffmpeg_bin)
                clip = f"{tmp}/round.mp4"
                hl.update(recording.cut(ctx, got, tmp, clip, ctx.ffmpeg_bin, t0, t1))
                ctx.s3.upload_file(clip, ctx.assets_bucket, hl["sourceKey"], ExtraArgs={"ContentType": "video/mp4"})
        game = game_context(ctx, session_id, hl.get("gameId"))
        try:
            segments = _pegasus(ctx, hl["sourceKey"], game)
        except ClientError as e:  # no moment from Pegasus: fall back to the round's last seconds
            segments, hl["analysisError"] = [], str(e)[:200]
        moment = pick_moment(segments, hl["seconds"])
        asked = (moment["title"] or "").strip()
        # (Pegasus is asked for the page's language; a Korean page's headline is rewritten when it came in English)
        title = ((asked[:36] if english else korean_title(ctx, asked, game))
                 or tr("{round}판 명장면", round=hl["round"])).strip()[:36 if english else 24]
        base = hl["sourceKey"].rsplit("/", 1)[0]
        with tempfile.TemporaryDirectory() as tmp:
            d = pathlib.Path(tmp)
            src = d / pathlib.Path(hl["sourceKey"]).name
            ctx.s3.download_file(ctx.assets_bucket, hl["sourceKey"], str(src))
            (d / "title.txt").write_text(title)
            (d / "foot.txt").write_text(tr("IPverse 하이라이트 · {round}판", round=hl["round"]))
            short, wide = d / "short.mp4", d / "wide.mp4"
            for cmd in render_cmds(ctx.ffmpeg_bin, str(src), moment["start"], moment["end"] - moment["start"],
                                   str(d / "title.txt"), str(d / "foot.txt"), ctx.font_path, str(short), str(wide)):
                subprocess.run(cmd, check=True, capture_output=True, timeout=120)
            for f in (short, wide):
                ctx.s3.upload_file(str(f), ctx.assets_bucket, f"{base}/{f.name}", ExtraArgs={"ContentType": "video/mp4"})
        hl.update(state="ready", title=title, excitement=moment["excitement"], start=moment["start"],
                  end=moment["end"], clipSeconds=round(moment["end"] - moment["start"], 2),
                  shortUrl=store.public_url(ctx, f"{base}/short.mp4"), wideUrl=store.public_url(ctx, f"{base}/wide.mp4"),
                  readyAt=store.now())
    except Exception as e:  # noqa: BLE001 — the card shows the failure instead of spinning forever
        err = e.stderr.decode(errors="replace")[-300:] if isinstance(e, subprocess.CalledProcessError) else str(e)[:300]
        hl.update(state="failed", error=err)
    _put(ctx, key, json.dumps(hl), "application/json")
    if hl["state"] != "ready" or hl.get("deleted"):
        return hl
    auto = {}

    def queue(j):  # a linear send needs MediaTailor to have transcoded the cut: a viewer beat warms it first
        if j.get("stop"):
            return False
        _want_warm(j, hl["wideUrl"], hl["title"], hl["clipSeconds"], hl["id"])
        auto["kind"] = j.get("highlightAuto")
        if auto["kind"] == "linear":
            j.setdefault("autoLinear", []).append(hl["id"])
    job = _update_job(ctx, job_id, queue)
    if job and auto.get("kind") == "overlay" and not job.get("stop"):
        try:
            _send(ctx, job, hl, "overlay")
        except LiveError as e:
            hl["sendError"] = e.message
            _put(ctx, key, json.dumps(hl), "application/json")
    return hl


def _send(ctx, job, hl, kind):
    """overlay: timed metadata (the viewer draws the 9:16 short top right); linear: an ad break with the 16:9 cut."""
    secs = hl["clipSeconds"]
    if kind == "linear":
        if not _warmed(job, hl["wideUrl"]):
            # (the toast does not name the ad service: that is in 고급 설정 alone)
            raise LiveError(409, "warming", "이 하이라이트를 방송에 내보낼 준비를 하고 있어요. "
                                            f"{waits.TRAILER_PREP} 뒤에 보내 주세요.")
        event_id = _break(ctx, job, hl["title"], hl["wideUrl"], secs, hl["id"])
    else:
        event_id = uuid.uuid4().hex[:12]
        try:
            _meta(ctx, {"type": "overlay", "id": hl["id"], "url": hl["shortUrl"], "title": hl["title"][:40],
                        "seconds": secs})
        except ClientError as e:
            print(f"overlay metadata failed: {e}")
            raise LiveError(409, "not_live", "하이라이트를 방송에 띄우지 못했어요. 방송이 켜져 있는지 확인한 뒤 다시 보내 주세요.") from None
    _log_break(ctx, job["jobId"], {"round": hl["round"], "eventId": event_id,
                                   "at": _iso(time.time() + (AD_LEAD_SEC if kind == "linear" else 0)),
                                   "seconds": secs, "kind": kind, "highlightId": hl["id"], "title": hl["title"]})
    return event_id


def highlight_send(ctx, session: dict, hid: str, body: dict) -> dict:
    job = _player_job(ctx, session)
    kind = body.get("kind")
    if kind not in HL_KINDS:
        raise LiveError(400, "bad_request", "하이라이트를 보낼 방식을 다시 골라 주세요.")
    hl = _get_json(ctx, _hl_key(job["jobId"], hid))
    if not hl or hl.get("state") != "ready" or hl.get("deleted"):
        raise LiveError(409, "not_ready", "아직 준비 중이거나 지운 하이라이트라 보낼 수 없어요.")
    return {"eventId": _send(ctx, job, hl, kind), "kind": kind}


def highlight_delete(ctx, session: dict, hid: str, restore: bool = False) -> dict:
    """Hides a highlight from the list (restore=True brings it back: the toast's 되돌리기). Its videos stay in S3
    and ads already sent are not recalled. ponytail: soft delete; purge the files if storage ever matters."""
    job = _player_job(ctx, session)
    hl = _get_json(ctx, _hl_key(job["jobId"], hid))
    if not hl:
        raise LiveError(404, "not_found", "하이라이트를 찾지 못했어요. 화면을 새로 고친 뒤 다시 해 주세요.")
    hl["deleted"] = not restore
    hl["deletedAt"] = None if restore else store.now()
    _put(ctx, _hl_key(job["jobId"], hid), json.dumps(hl), "application/json")
    return {"id": hid, "deleted": hl["deleted"]}


def ad_settings(ctx, session: dict, body: dict) -> dict:
    """Change the ad spec of a running player broadcast: adType trailer | playable | corner, everyRounds,
    playableSeconds, corner (a corner trailer at every other round), preCueLeadSec. The count restarts from the rounds
    finished so far (the next break comes after everyRounds more)."""
    job = _player_job(ctx, session)
    ad_type = body.get("adType", job.get("adType", "trailer"))
    if ad_type not in AD_STYLES:
        raise LiveError(400, "bad_request", "광고 방식을 전체 화면 트레일러, 플레이어블 광고, 코너 트레일러 중에서 골라 주세요.")
    every = body.get("everyRounds", job["everyRounds"])
    if isinstance(every, bool) or not isinstance(every, int) or not 1 <= every <= 20:
        raise LiveError(400, "bad_request", "광고 간격은 1–20판 사이로 적어 주세요.")
    if ad_type != "playable" and not job.get("adUrl"):
        raise LiveError(400, "bad_request", "트레일러가 없는 방송이에요. 트레일러 광고로 바꾸려면 트레일러를 만든 뒤 방송을 다시 켜 주세요")
    seconds = body.get("playableSeconds", job.get("playableSeconds", 90))
    fields = {"adType": ad_type, "everyRounds": every,
              "corner": _corner_flag(body, bool(job.get("corner"))) and ad_type != "corner",
              "preCueLeadSec": _lead(body, job.get("preCueLeadSec", PRECUE_LEAD_SEC))}
    if ad_type == "playable" and (not job.get("playUrl") or seconds != job.get("playableSeconds")):
        fields.update(_playable_ad(ctx, session, job["gameId"], seconds))
        fields["standbyCapable"] = _standby_capable(ctx, job["gameId"])
    if ad_type == "playable" and job.get("adType") != "playable" and _manual(ctx).get("mode") == "off":
        _put(ctx, STANDBY_KEY, json.dumps({"mode": "auto", "at": time.time()}), "application/json")
    if ad_type == "playable" and not job.get("standby") and _manual(ctx).get("mode") != "off":
        err = _standby(ctx, True)
        fields["standby"] = err is None
        fields["standbyError"] = err
    st = _get_json(ctx, STATUS_KEY) or {}
    rounds = st.get("rounds", 0) if st.get("jobId") == job["jobId"] else 0

    grace = ad_type != "playable" and job.get("adType") == "playable" and job.get("standby")
    switched = ad_type != job.get("adType")

    def apply(j):
        j.update(fields)
        if ad_type != "trailer":
            j.pop("pendingCue", None)
        if ad_type == "playable":
            j.pop("standbyGraceUntil", None)
        if ad_type == "playable" and switched:  # the old launchers ended with the switch away: wait for new ones
            j["playableSince"] = time.time()
            j.pop("launcherReadyAt", None)
        if ad_type != "playable":
            j.pop("playableDue", None)
        if grace:  # the idle host stays a while: a switch back is warm (status/reap release it after)
            j["standbyGraceUntil"] = time.time() + STANDBY_GRACE_SEC
        if ad_type == "trailer":
            _want_warm(j, j["adUrl"], j["adTitle"], j["adSeconds"], "ipverse-trailer")
        if rounds or "roundBase" in j:  # before the first report, that report sets the base itself
            j["roundBase"] = rounds
    old_ad = job.get("playableAdId")
    job = _own(_update_job(ctx, job["jobId"], apply))
    if old_ad and (ad_type != "playable" or job.get("playableAdId") != old_ad):
        # the hidden sessions of the ad that no longer runs (the launchers too once playables are off)
        _end_standby(ctx, old_ad, job["jobId"] if ad_type != "playable" else None)
    if ad_type == "playable" and not _token(ctx, job["jobId"]):
        _new_token(ctx, job["jobId"])
    return status(ctx, session)


def highlight_settings(ctx, session: dict, body: dict) -> dict:
    """generate: bool — make a highlight of each finished round at all (off by default); auto: off | overlay |
    linear — what happens to each new highlight as soon as it is ready. Either or both."""
    job = _player_job(ctx, session)
    fields = {}
    if "generate" in body:
        if not isinstance(body["generate"], bool):
            raise LiveError(400, "bad_request", "하이라이트 설정을 읽지 못했어요. 화면을 새로 고친 뒤 다시 해 주세요.")
        fields["highlightGen"] = body["generate"]
    if "auto" in body:
        if body["auto"] not in ("off", *HL_KINDS):
            raise LiveError(400, "bad_request", "하이라이트를 자동으로 보낼 방식을 다시 골라 주세요.")
        fields["highlightAuto"] = body["auto"]
    def apply(j):
        j.update(fields)
        if j.get("highlightAuto") != "linear":
            j["autoLinear"] = []
    job = _own(_update_job(ctx, job["jobId"], apply))
    return {"auto": job.get("highlightAuto", "off"), "generate": bool(job.get("highlightGen"))}
