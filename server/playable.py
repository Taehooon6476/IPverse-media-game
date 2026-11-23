"""Playable ads over Amazon GameLift Streams.

A studio user turns a game into an ad (create): an ad page (#ad=<id>) shows the session's trailer, and "▶ 지금 플레이"
starts a short web-player stream of the real game (30-180 s) for anyone with the link: no login, no download. When
the time is up the page shows the call to action (the published game). The stream is a normal web-player session
(server/streams.py) whose description names the ad, which lets the public poll/stop calls touch only that ad's
sessions.

Live viewers (the watch page) get a different game each (server/adserver.py, kind "playable"), so the warm host is
game-agnostic: the watch page keeps one hidden session of the IPverse launcher (games/gm_launcher/index.html, inside
the stream shell's allow-list of /games/gm_*/index.html). The launcher polls GET /api/ads/launch/<token> (signed,
expires with the session); a card click writes a signed, single-use instruction (the viewer's game URL, valid
GO_TTL_SEC), which the launcher fetches once to open the game. A game takes several seconds to build on the stream
host, so the launcher loads games ahead in hidden frames: the card's while one is up (hint), and between cards the
next card's (launch_fetch asks live.launcher_ahead every AHEAD_SEC). Only a game that can hold for the first input
is loaded ahead; a click then only reveals its frame.

Capacity: the web group's MaximumCapacity is the number of seats. A card that finds every seat taken gets a place in
a queue (GLSQ#<group>: "대기 n번째") and polls it; the first in line starts once a seat frees, and a hidden launcher
nobody is using gives its seat up to it. A watch page names what it starts before it asks (launchId, startId) and
ends it by that name, so a window that closes while a start is in flight leaves no session holding a seat.

ponytail: no per-viewer rate limit; the web stream group's MaxCapacity bounds concurrent ads (and their cost).
"""
from __future__ import annotations
import hashlib
import hmac
import pathlib
import re
import secrets
import time
import uuid

from server import store, streams, waits
from server import i18n
from server.i18n import said, tr

MIN_SEC, MAX_SEC, DEFAULT_SEC = 30, 180, 90
GRACE_SEC = 45  # connect + a moment after the timer, before GameLift Streams ends the session itself
STANDBY_SEC = 45 * 60  # a live viewer's hidden session outlives the broadcast cap (live.MAX_MINUTES)
# Every seat taken: one frees when a trial ends, so the wait named spans the usual trial to the longest, plus grace
FULL = "지금은 체험할 자리가 모두 찼어요 (클라우드 GPU {n}대 사용 중). {wait} 뒤 다시 눌러 주세요"
FULL_WAIT = waits.span_sec(DEFAULT_SEC + GRACE_SEC, MAX_SEC + GRACE_SEC)
FULL_TEXT = FULL.replace("{wait}", FULL_WAIT)  # ({n}: streams.open_session fills it)


def _full_text() -> str:
    """FULL_TEXT in the request's language, its {n} left for streams.open_session."""
    return tr(FULL, n="{n}", wait=i18n.span(FULL_WAIT))
LAUNCHER_KEY = "games/gm_launcher/index.html"  # the stream shell allows /games/gm_<id>/index.html only
LAUNCHER_FILE = pathlib.Path(__file__).with_name("launcher.html")
LAUNCH_TTL_SEC = STANDBY_SEC + 10 * 60  # a launcher token lives as long as its session can
GO_TTL_SEC = 60  # an instruction the launcher has not fetched by then is void (the click is long over)
# The launcher's poll (the server sets it in every "wait"): quick while its page shows a card (a hint came in the
# last HINT_FAST_SEC), slow otherwise
FAST_POLL_MS, IDLE_POLL_MS = 250, 1500
HINT_FAST_SEC = 40
# A card is up on a page this long after its cue at most (web CARD_MS, CUE_LATE_MS); after it the launcher holds the
# next card's games
CARD_UP_SEC = 30
AHEAD_SEC = 10  # the next card's games are decided again this often while no card is up (the viewers' logs grow)
# Games one launcher holds at once: the four tiles of a watch page. Each is a built three.js world that no longer
# draws (up to ~270 MB of GPU memory; a gen4n_win2022 host has 16 GB)
PRELOAD_MAX = 4
GONE_TEXT = "이 대기 세션은 이미 끝났어요"
QUEUE_ALIVE_SEC = 15  # a waiting card polls every ~3 s: one silent this long has left the queue
LAUNCH_ID = re.compile(r"[a-f0-9]{12}")
# The name a page gives a card click's own session before it asks for it. Never the shape of a GameLift Streams id
# (13 letters and digits), so stop takes either in the same place
START_ID = re.compile(r"st_[a-f0-9]{12}")
TOKEN = re.compile(r"([a-f0-9]{12})\.(\d{10})\.([a-f0-9]{32})")
_cache: dict = {}  # per container: the launch key, the uploaded launcher's hash


class AdError(Exception):
    def __init__(self, status: int, code: str, message: str):
        message = said(message)  # in the request's language
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _key(ad_id):
    return f"AD#{ad_id}", "META"


def trial_seconds(seconds) -> int:
    """A trial length an ad can have, or the refusal (in the console's word for it, 체험 길이). Asked on its own by a
    broadcast's start, before it takes the channel (server/live.py start)."""
    if isinstance(seconds, bool) or not isinstance(seconds, int) or not MIN_SEC <= seconds <= MAX_SEC:
        raise AdError(400, "bad_request", f"체험 길이는 {MIN_SEC}–{MAX_SEC}초 사이에서 골라 주세요.")
    return seconds


def create(ctx, session: dict, body: dict, ad_id: str | None = None) -> dict:
    """A new ad, or (ad_id: the game's own, for_game) that ad as its game is now: its title, trailer and addresses
    are written again, its plays and its age stay. The session keeps a pointer to each of its ads (SESSION#<id> /
    AD#<adId>), which is how delete_session finds them."""
    snap = store.snapshot(ctx, session["sessionId"])
    game = next((g for g in snap["games"] if g["gameId"] == body.get("gameId")), None)
    if not game:
        raise AdError(400, "bad_request", "광고로 만들 게임을 골라 주세요.")
    seconds = trial_seconds(body.get("seconds", DEFAULT_SEC))
    # the trailer the user picked, else the newest one (trailers are not linked to a game)
    trailer = next((a for a in snap["assets"] if a["kind"] == "trailer" and a["assetId"] == body.get("trailerAssetId")), None) \
        or next((a for a in reversed(snap["assets"]) if a["kind"] == "trailer"), None)
    ad_id = ad_id or "ad_" + uuid.uuid4().hex[:12]
    shown = {"adId": ad_id, "sessionId": session["sessionId"], "gameId": game["gameId"], "title": game["title"],
             "seconds": seconds, "trailerUrl": trailer["url"] if trailer else None,
             "ctaUrl": game.get("publishedUrl") or game["previewUrl"], "gameUrl": game["previewUrl"]}
    pk, sk = _key(ad_id)
    old = store._get(ctx, pk, sk)
    if old and not old.get("gone"):  # only these fields: a play counted meanwhile is not written over
        store._update(ctx, pk, sk, shown)
        item = {**old, **shown}
    else:
        item = {**shown, "createdAt": store.now(), "plays": 0}
        store._put(ctx, pk, sk, item)
    store._put(ctx, store._pk(session["sessionId"]), f"AD#{ad_id}", {"adId": ad_id})
    return {**item, "adPath": f"#ad={ad_id}"}


def for_game(ctx, session_id: str, game_id: str, seconds: int, refresh: bool = False) -> dict:
    """The playable ad of a game: one per game and trial length (the same id every break and every broadcast, so its
    plays add up), made on first use. A live viewer's pick takes it as it is while its game is there; refresh (a
    broadcast's own ad, at its start) writes what its page shows again, as the game is now. A game that is gone has
    no ad (AdError: the caller offers another)."""
    ad_id = "ad_" + hashlib.sha1(f"{game_id}|{seconds}".encode()).hexdigest()[:12]
    item = store._get(ctx, *_key(ad_id))
    if item and not item.get("gone") and not refresh and store.get_game(ctx, item["sessionId"], item["gameId"]):
        return item
    return create(ctx, {"sessionId": session_id}, {"gameId": game_id, "seconds": seconds}, ad_id)


GAME_GONE = "이 광고의 게임이 삭제됐어요"
# What the public ad page shows for an address that is no ad, and for a trial whose connection is gone
NO_AD = "광고를 찾지 못했어요. 주소를 다시 확인해 주세요."
NO_TRIAL = "체험 연결이 이미 끝났어요. 다시 시작해 주세요."


def _record(ctx, ad_id: str) -> dict:
    """The ad's record, whatever became of its game (a stream that is running is still polled and ended by it). An
    ad that was buried with its game (store.bury_ad) says so every time it is asked for; an address that never was
    an ad says to check it."""
    item = store._get(ctx, *_key(ad_id)) if isinstance(ad_id, str) and ad_id.startswith("ad_") else None
    if not item:
        raise AdError(404, "not_found", tr(NO_AD))
    if item.get("gone"):
        raise AdError(404, "ad_gone", tr(GAME_GONE))
    return item


def get(ctx, ad_id: str) -> dict:
    """An ad that can be played: its record, while its game is still there. An ad whose game (or whole session) is
    gone answers 404 and is buried here, so its public link cannot start a paid stream on a deleted game."""
    item = _record(ctx, ad_id)
    if not store.get_game(ctx, item.get("sessionId") or "", item.get("gameId") or ""):
        drop(ctx, ad_id, item.get("sessionId"))
        raise AdError(404, "ad_gone", tr(GAME_GONE))
    return item


def drop(ctx, ad_id: str, session_id: str | None = None) -> None:
    """The ad's game is gone: what it held goes (its record's fields and the names its pages gave their starts,
    START#<name>) and the small record that says so stays (store.bury_ad); its session's pointer to it goes too."""
    store.bury_ad(ctx, ad_id)
    if session_id:
        ctx.table.delete_item(Key={"pk": store._pk(session_id), "sk": f"AD#{ad_id}"})


def public(ctx, ad_id: str) -> dict:
    """What the ad page shows before the click. startText: how long the stream takes to start (waits.CLOUD_START)."""
    ad = get(ctx, ad_id)
    return {**{k: ad.get(k) for k in ("adId", "title", "seconds", "trailerUrl", "ctaUrl")}, "startText": waits.CLOUD_START}


def start(ctx, ad_id: str, body: dict) -> dict:
    ad = get(ctx, ad_id)
    signal = streams._signal(body)
    # standby (a hidden session that waits for the next break) only for the ad of the running playable
    # broadcast: anyone else gets the normal, short session
    from server import live
    standby = body.get("standby") is True
    if standby and live.live_ad(ctx, ad_id, body.get("standbyToken")) is None:
        # not (or no longer) the running broadcast's ad for its owner: start nothing (no session, no play counted)
        raise AdError(409, "standby_refused", "지금은 미리 연결해 둘 수 없는 광고예요. 누르면 바로 시작해요")
    # &standby=1: the game holds its round (and the trial clock) until the viewer's first input, so the trial
    # starts when they do, not when the stream connects (a game whose runtime cannot wait starts on load)
    holds = standby or live._standby_capable(ctx, ad["gameId"])
    query = f"noads=1&playable={ad['seconds']}" + ("&standby=1" if holds else "")
    group = streams._web_group()
    gls = streams.client()
    ticket = body.get("ticket") if isinstance(body.get("ticket"), str) else None
    # startId: the watch page names its click's own session, as it names its launcher (launcher_start), so it can end
    # a start still in flight (stop): one whose page is gone starts nothing, or ends what it started
    name = body["startId"] if isinstance(body.get("startId"), str) and START_ID.fullmatch(body["startId"]) else None
    if name and store._get(ctx, *_start_key(ad_id, name)):  # its page left before this start (or the name is taken)
        _page_gone(ctx, ticket)
    _my_turn(ctx, group, ticket, hidden=standby)
    resp = streams.open_session(
        ctx, gls, group, _full_text(), ApplicationIdentifier=streams._application_id(gls, group), Protocol="WebRTC",
        SignalRequest=signal, UserId=f"ad-{ad_id}", Description=f"ipverse ad {ad_id}" + (" standby" if standby else ""),
        AdditionalEnvironmentVariables={"IPVERSE_GAME_URL": streams.web_game_url({"previewUrl": ad["gameUrl"]}, query)},
        Locations=[streams._region()], SessionLengthSeconds=ad["seconds"] + GRACE_SEC + (STANDBY_SEC if standby else 0),
        ConnectionTimeoutSeconds=120,
    )
    stream_id = streams._stream_id(resp["Arn"])
    if name and not store._update(ctx, *_start_key(ad_id, name), {"streamId": stream_id, "state": "started"},
                                  expect={"state": None}):
        streams.end(ctx, group, stream_id)  # its page left while GameLift Streams started the session
        _page_gone(ctx, ticket)
    if ticket:
        leave(ctx, ticket)
    if not standby:  # a standby session counts when it is played (it may never be)
        store._update(ctx, *_key(ad_id), {"plays": int(ad.get("plays") or 0) + 1})
    return {"streamId": stream_id, "status": resp.get("Status", "ACTIVATING"), "seconds": ad["seconds"],
            "standby": standby, "waitsForInput": holds}


def _start_key(ad_id: str, name: str) -> tuple:
    return f"AD#{ad_id}", f"START#{name}"


def _page_gone(ctx, ticket):
    """This start's page ended it by name before it was there (stop): no session, no play, and no place in line."""
    if ticket:
        leave(ctx, ticket)
    raise AdError(410, "start_gone", "이 체험은 창이 닫혀서 시작하지 않았어요")


def _session(ctx, ad_id, stream_id):
    _record(ctx, ad_id)
    if not isinstance(stream_id, str) or not stream_id or "/" in stream_id:
        raise AdError(404, "not_found", tr(NO_TRIAL))
    try:
        resp = streams.client().get_stream_session(Identifier=streams._web_group(), StreamSessionIdentifier=stream_id)
    except Exception:  # unknown id
        raise AdError(404, "not_found", tr(NO_TRIAL)) from None
    if resp.get("Description") not in (f"ipverse ad {ad_id}", f"ipverse ad {ad_id} standby"):
        raise AdError(404, "not_found", tr(NO_TRIAL))
    return resp


def poll(ctx, ad_id: str, stream_id: str) -> dict:
    resp = _session(ctx, ad_id, stream_id)
    out = {"streamId": stream_id, "status": resp.get("Status")}
    if resp.get("Status") == "ACTIVE" and resp.get("SignalResponse"):
        out["signalResponse"] = resp["SignalResponse"]
    if resp.get("StatusReason"):
        out["statusReason"] = resp["StatusReason"]
    return out


def played(ctx, ad_id: str, stream_id: str) -> dict:
    """A live viewer revealed their standby session (▶ 지금 플레이): that is when it counts as a play, once per
    session (a normal session already counted at start)."""
    resp = _session(ctx, ad_id, stream_id)
    ad = _record(ctx, ad_id)
    plays = int(ad.get("plays") or 0)
    seen = list(ad.get("playedStreams") or [])
    if resp.get("Description", "").endswith(" standby") and stream_id not in seen:
        plays += 1
        store._update(ctx, *_key(ad_id), {"plays": plays, "playedStreams": (seen + [stream_id])[-50:]})
    return {"plays": plays}


def stop(ctx, ad_id: str, stream_id: str) -> dict:
    """Ends the ad's session, by its stream id or by the name its page gave the start (START_ID). A name whose start
    is still in flight is marked ended before the session exists, so that start starts nothing or ends what it
    started: otherwise the session would hold a seat until connectionTimeout (120 s).

    ponytail: a name's row (AD#<adId> / START#<name>) stays in the table, like a launcher's."""
    if isinstance(stream_id, str) and START_ID.fullmatch(stream_id):
        _record(ctx, ad_id)
        key = _start_key(ad_id, stream_id)
        if not store._update(ctx, *key, {"state": "ended"}, expect={"state": None}):  # it started: end what it made
            made = (store._get(ctx, *key) or {}).get("streamId")
            if made:
                streams.end(ctx, streams._web_group(), made)
        return {"streamId": stream_id, "status": "TERMINATING"}
    _session(ctx, ad_id, stream_id)
    streams.end(ctx, streams._web_group(), stream_id)  # also one still waiting for a host
    return {"streamId": stream_id, "status": "TERMINATING"}


def end_standby(ctx, ad_id) -> int:
    """The broadcast stopped using this ad (switched to trailer, a new ad, stopped): its viewers' hidden sessions
    are ended here, whether or not their watch windows are still there to do it. A session a viewer is playing
    right now (revealed) is left to finish its trial. Returns how many were ended."""
    if not ad_id:
        return 0
    try:
        group = streams._web_group()
        played = set((store._get(ctx, *_key(ad_id)) or {}).get("playedStreams") or [])
        hidden = [i["streamId"] for i in streams.ledger(ctx, group)
                  if i.get("desc") == f"ipverse ad {ad_id} standby" and i.get("streamId") not in played]
        for stream_id in hidden:
            streams.end(ctx, group, stream_id)
        return len(hidden)
    except Exception as e:  # noqa: BLE001 — the watch windows still end their own; connectionTimeout ends the rest
        print(f"end standby sessions of {ad_id} failed: {e}")
        return 0


# ── the capacity queue ("대기 n번째") ─────────────────────────────────────────

def _queue_pk(group: str) -> str:
    return f"GLSQ#{group}"


def _queue(ctx, group: str) -> list:
    """The cards waiting for a seat, first in line first; one that stopped polling is dropped on the way."""
    now_ms = int(time.time() * 1000)
    out = []
    for item in store._query(ctx, _queue_pk(group)):
        item = store.plain(item)
        if now_ms - item.get("seenAt", 0) > QUEUE_ALIVE_SEC * 1000:
            ctx.table.delete_item(Key={"pk": item["pk"], "sk": item["sk"]})
        else:
            out.append(item)
    return sorted(out, key=lambda i: (i["at"], i["sk"]))


def _launch_of(desc: str) -> str | None:
    """The launch id in a launcher session's description ("ipverse launcher <jobId> <launchId>")."""
    parts = (desc or "").split()
    return parts[3] if len(parts) == 4 and parts[:2] == ["ipverse", "launcher"] else None


def _free_idle_launcher(ctx, group: str) -> bool:
    """Someone waits and every seat is taken: the oldest hidden launcher nobody plays gives its seat up; one whose
    page shows a card right now (a fresh hint: its viewer is about to click) goes last."""
    idle = []
    for item in streams.ledger(ctx, group):
        lid = _launch_of(item.get("desc", ""))
        doc = store._get(ctx, f"LAUNCH#{lid}", "META") if lid else None
        if doc and doc.get("state") == "waiting":
            idle.append((time.time() - float(doc.get("hintAt") or 0) < HINT_FAST_SEC, lid, item["streamId"]))
    for _, lid, stream_id in sorted(idle, key=lambda i: i[0]):  # stable: the ledger's (oldest first) order otherwise
        if store._update(ctx, f"LAUNCH#{lid}", "META", {"state": "ended"}, expect={"state": "waiting"}):
            streams.end(ctx, group, stream_id)
            return True
    return False


def claim(ctx, ticket: str | None = None, viewer_id: str = "") -> dict:
    """A playable card wants a seat: {"go": True, ticket} when it may start a session now (first in line and a seat
    free), else {"go": False, "position": n, ticket}. The card polls with its ticket every few seconds (that keeps its
    place) and passes it to start; leave() drops it."""
    group = streams._web_group()
    pk, now_ms = _queue_pk(group), int(time.time() * 1000)
    q = _queue(ctx, group)
    mine = next((i for i in q if i.get("ticket") == ticket), None) if ticket else None
    if mine:
        store._update(ctx, pk, mine["sk"], {"seenAt": now_ms})
    else:
        ticket = "q_" + uuid.uuid4().hex[:12]
        # the same millisecond: the nanosecond clock keeps the arrival order
        store._put(ctx, pk, f"{now_ms:015d}#{time.time_ns():020d}#{ticket}",
                   {"at": now_ms, "ticket": ticket, "viewerId": viewer_id, "seenAt": now_ms})
        q = _queue(ctx, group)
    position = [i.get("ticket") for i in q].index(ticket) + 1
    n = streams._max_capacity(streams.client(), group)
    full = isinstance(n, int) and n > 0 and len(streams.ledger(ctx, group)) >= n
    if position == 1 and not full:
        return {"go": True, "position": 1, "ticket": ticket}
    if position == 1:
        _free_idle_launcher(ctx, group)
    return {"go": False, "position": position, "ticket": ticket}


def leave(ctx, ticket: str):
    group = streams._web_group()
    for item in _queue(ctx, group):
        if item.get("ticket") == ticket:
            ctx.table.delete_item(Key={"pk": item["pk"], "sk": item["sk"]})


def _my_turn(ctx, group: str, ticket: str | None, hidden: bool):
    """A start goes only if nobody waits ahead of it: a hidden session never starts while someone waits, and a card
    with a ticket starts when it is first in line."""
    q = _queue(ctx, group)
    if not q or (not hidden and ticket and q[0].get("ticket") == ticket):
        return
    ahead = next((n for n, i in enumerate(q) if i.get("ticket") == ticket), len(q)) if ticket else len(q)
    raise AdError(503, "stream_queued", f"체험을 기다리는 시청자가 있어요. 지금 대기 {ahead + (0 if hidden else 1)}번째예요.")


# ── the game-agnostic warm host: the launcher ─────────────────────────────────

def _launch_key(ctx) -> bytes:
    """The HMAC key of launch tokens and instructions: made once, kept in the table (never sent anywhere)."""
    hit = _cache.get("key")
    if hit and hit[0] is ctx.table:
        return hit[1]
    item = store._get(ctx, "LAUNCHKEY", "META")
    if not item:
        key = secrets.token_hex(32)
        if store._update(ctx, "LAUNCHKEY", "META", {"key": key}, expect={"key": None}):
            item = {"key": key}
        else:  # another container made it first
            item = store._get(ctx, "LAUNCHKEY", "META")
    _cache["key"] = (ctx.table, bytes.fromhex(item["key"]))
    return _cache["key"][1]


def _mac(ctx, text: str) -> str:
    return hmac.new(_launch_key(ctx), text.encode(), hashlib.sha256).hexdigest()[:32]


def launch_token(ctx, launch_id: str, exp: int) -> str:
    """What the launcher page gets in its URL (?t=): its launch id and expiry, signed; only characters the stream
    shell's URL allow-list takes."""
    return f"{launch_id}.{exp}.{_mac(ctx, f'launch|{launch_id}|{exp}')}"


def _check_token(ctx, token: str) -> str:
    m = TOKEN.fullmatch(token or "")
    if not m or not hmac.compare_digest(m.group(3), _mac(ctx, f"launch|{m.group(1)}|{m.group(2)}")):
        raise AdError(403, "bad_token", "잘못된 대기 세션이에요")
    if time.time() > int(m.group(2)):
        raise AdError(410, "expired", "대기 세션이 끝났어요")
    return m.group(1)


def _sign_go(ctx, launch_id: str, url: str, exp: int) -> str:
    return _mac(ctx, f"go|{launch_id}|{url}|{exp}")


def ensure_launcher(ctx) -> str:
    """The launcher page in the assets bucket (uploaded when this container has not checked it yet). → its URL."""
    body = LAUNCHER_FILE.read_bytes()
    digest = hashlib.sha1(body).hexdigest()
    if _cache.get("launcher") != (ctx.assets_bucket, digest):
        try:
            current = ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=LAUNCHER_KEY)["Body"].read()
        except Exception:  # noqa: BLE001 — not there yet
            current = b""
        if hashlib.sha1(current).hexdigest() != digest:
            ctx.s3.put_object(Bucket=ctx.assets_bucket, Key=LAUNCHER_KEY, Body=body,
                              ContentType="text/html; charset=utf-8", CacheControl="no-cache")
        _cache["launcher"] = (ctx.assets_bucket, digest)
    return store.public_url(ctx, LAUNCHER_KEY)


def launcher_start(ctx, job_id: str, body: dict) -> dict:
    """A watch page's hidden, game-agnostic session for this broadcast (live.launcher_start checked the owner): the
    stream shell opens the launcher, which waits for an instruction. The page names the launcher itself (launchId), so
    it can end a start still in flight (launcher_stop): one whose page is gone starts nothing, or ends what it
    started. viewerId, viewerIds: whose cards the page can play, the likeliest first. → {launchId, streamId, status}."""
    signal = streams._signal(body)
    group = streams._web_group()
    named = isinstance(body.get("launchId"), str) and LAUNCH_ID.fullmatch(body["launchId"])
    launch_id = body["launchId"] if named else uuid.uuid4().hex[:12]
    if named and store._get(ctx, f"LAUNCH#{launch_id}", "META"):  # its page left before this start (or the id is taken)
        raise AdError(410, "launcher_gone", tr(GONE_TEXT))
    _my_turn(ctx, group, None, hidden=True)
    exp = int(time.time() + LAUNCH_TTL_SEC)
    url = f"{ensure_launcher(ctx)}?t={launch_token(ctx, launch_id, exp)}"
    gls = streams.client()
    resp = streams.open_session(
        ctx, gls, group, _full_text(), ApplicationIdentifier=streams._application_id(gls, group), Protocol="WebRTC",
        SignalRequest=signal, UserId=f"launcher-{launch_id}", Description=f"ipverse launcher {job_id} {launch_id}",
        AdditionalEnvironmentVariables={"IPVERSE_GAME_URL": url}, Locations=[streams._region()],
        SessionLengthSeconds=STANDBY_SEC + MAX_SEC + GRACE_SEC, ConnectionTimeoutSeconds=120)
    stream_id = streams._stream_id(resp["Arn"])
    doc = {"launchId": launch_id, "jobId": job_id, "streamId": stream_id, "exp": exp, "state": "waiting",
           "createdAt": store.now(), **({"viewerId": body["viewerId"]} if isinstance(body.get("viewerId"), str) else {}),
           **({"viewerIds": body["viewerIds"]} if isinstance(body.get("viewerIds"), list) else {})}
    if not store._update(ctx, f"LAUNCH#{launch_id}", "META", doc, expect={"state": None}):
        streams.end(ctx, group, stream_id)  # its page left while GameLift Streams started the session
        raise AdError(410, "launcher_gone", tr(GONE_TEXT))
    return {"launchId": launch_id, "streamId": stream_id, "status": resp.get("Status", "ACTIVATING")}


def _launch(ctx, launch_id: str, job_id: str | None = None) -> dict:
    ok = isinstance(launch_id, str) and LAUNCH_ID.fullmatch(launch_id)
    doc = store._get(ctx, f"LAUNCH#{launch_id}", "META") if ok else None
    if not doc or not doc.get("streamId") or (job_id and doc.get("jobId") != job_id):  # no stream: ended before it started
        raise AdError(404, "not_found", "대기 세션을 찾을 수 없어요")
    return doc


def launcher_poll(ctx, job_id: str, launch_id: str) -> dict:
    doc = _launch(ctx, launch_id, job_id)
    try:
        resp = streams.client().get_stream_session(Identifier=streams._web_group(), StreamSessionIdentifier=doc["streamId"])
    except Exception:  # noqa: BLE001 — long gone
        raise AdError(404, "not_found", "대기 세션을 찾을 수 없어요") from None
    out = {"launchId": launch_id, "streamId": doc["streamId"], "status": resp.get("Status"), "state": doc.get("state")}
    if resp.get("Status") == "ACTIVE" and resp.get("SignalResponse"):
        out["signalResponse"] = resp["SignalResponse"]
    if resp.get("StatusReason"):
        out["statusReason"] = resp["StatusReason"]
    return out


def launcher_stop(ctx, job_id: str, launch_id: str) -> dict:
    """The page ends its launcher. One it named whose start is still in flight is marked ended before it exists, so
    that start ends what it starts (launcher_start) instead of holding a seat until connectionTimeout."""
    if isinstance(launch_id, str) and LAUNCH_ID.fullmatch(launch_id) and store._update(
            ctx, f"LAUNCH#{launch_id}", "META", {"launchId": launch_id, "jobId": job_id, "state": "ended"},
            expect={"state": None}):
        return {"launchId": launch_id, "status": "TERMINATING"}
    doc = _launch(ctx, launch_id, job_id)
    store._update(ctx, f"LAUNCH#{launch_id}", "META", {"state": "ended"})
    streams.end(ctx, streams._web_group(), doc["streamId"])
    return {"launchId": launch_id, "status": "TERMINATING"}


def game_url(ad: dict, holds: bool) -> str:
    """The page a launcher opens for this ad: the same URL for a hint and for the click, so a game the launcher loaded
    ahead is the one the click wants."""
    return streams.web_game_url({"previewUrl": ad["gameUrl"]},
                                f"noads=1&playable={ad['seconds']}" + ("&standby=1" if holds else ""))


def _viewers_of(doc: dict) -> list:
    """The viewers a launcher's page named: the one whose card it will most likely play, then its other tiles'."""
    who = doc.get("viewerIds")
    if isinstance(who, list) and who:
        return who
    return [doc["viewerId"]] if isinstance(doc.get("viewerId"), str) else []


def hint(ctx, job_id: str, launch_id: str, first: str | None, also: list = (), at: float | None = None,
         who: list | None = None) -> dict:
    """A card is up on this launcher's page (since `at`: now, at its cue): the game its viewer will likely click (first;
    None when that game cannot hold for the first input: it is not loaded ahead) and the games of the page's other
    tiles (also). The launcher holds them in hidden frames (and polls quickly while the card is up), so a click only
    reveals one. who: the page's viewers as it names them now. A launcher already opening a game is left alone."""
    doc = _launch(ctx, launch_id, job_id)
    now = time.time()
    fields = {"preload": first, "also": list(also), "hintAt": now, "cardAt": now if at is None else at, "aheadAt": 0,
              **({"viewerId": who[0], "viewerIds": who} if who else {})}
    if doc.get("state") != "waiting" or not store._update(ctx, f"LAUNCH#{launch_id}", "META", fields,
                                                          expect={"state": "waiting"}):
        return {"launchId": launch_id, "preload": None}
    return {"launchId": launch_id, "preload": first}


def name_viewers(ctx, job_id: str, launch_id: str, who: list) -> dict:
    """The launcher's page shows these viewers' tiles now (its viewer list loaded after the launcher started, the view
    or the persona changed): the next card's games are decided for them at the launcher's next poll."""
    _launch(ctx, launch_id, job_id)
    store._update(ctx, f"LAUNCH#{launch_id}", "META", {"viewerId": who[0], "viewerIds": who, "aheadAt": 0},
                  expect={"state": "waiting"})
    return {"launchId": launch_id, "preload": None}


def assign(ctx, job_id: str, launch_id: str, ad: dict, holds: bool) -> dict:
    """A card click: this page's hidden launcher gets the signed, single-use instruction to open the ad's game (valid
    GO_TTL_SEC). Only a waiting launcher can be assigned, and only once. The play counts now."""
    doc = _launch(ctx, launch_id, job_id)
    url = game_url(ad, holds)
    exp = int(time.time() + GO_TTL_SEC)
    go = {"url": url, "exp": exp, "sig": _sign_go(ctx, launch_id, url, exp)}
    if not store._update(ctx, f"LAUNCH#{launch_id}", "META", {"state": "assigned", "go": go, "adId": ad["adId"]},
                         expect={"state": "waiting"}):
        raise AdError(409, "launcher_taken", "이 대기 세션은 이미 다른 게임을 열었어요")
    seen = list(ad.get("playedStreams") or [])
    store._update(ctx, *_key(ad["adId"]), {"plays": int(ad.get("plays") or 0) + 1,
                                           "playedStreams": (seen + [doc["streamId"]])[-50:]})
    return {"launchId": launch_id, "streamId": doc["streamId"], "adId": ad["adId"], "waitsForInput": holds,
            "seconds": ad["seconds"]}


def _ahead(ctx, launch_id: str, doc: dict, now: float) -> dict | None:
    """What the launcher holds between cards: the next card's games for its page's viewers ({preload, also,
    calmUntil}: live.launcher_ahead), decided again every AHEAD_SEC. None: its page named no viewer, or the broadcast
    has no next card."""
    who = _viewers_of(doc)
    if not who:
        return None
    if now - float(doc.get("aheadAt") or 0) < AHEAD_SEC:
        return doc.get("ahead")
    from server import live
    try:
        ahead = live.launcher_ahead(ctx, doc["jobId"], who)
    except Exception as e:  # noqa: BLE001 — the launcher keeps what it holds; the cue names its games anyway
        print(f"launcher {launch_id}: the next card's games failed: {e}")
        ahead = doc.get("ahead")
    store._update(ctx, f"LAUNCH#{launch_id}", "META", {"ahead": ahead, "aheadAt": now}, expect={"state": "waiting"})
    return ahead


def launch_fetch(ctx, token: str) -> dict:
    """GET /api/ads/launch/<token> (public: the launcher page on the stream host polls it). {"state": "wait"} until a
    click assigns a game, then {"state": "go", "url"} exactly once; a used, expired or tampered one is refused. A wait
    says when to ask again (next, ms) and the games to hold: preload (its page's likely viewer's, or null) and also
    (the page's other tiles'), the card's while one is up (card: true, CARD_UP_SEC from its cue) and the next card's
    after it, with how long no card is due (calm, seconds; absent when no round length is known or the card is due
    now): the launcher builds another viewer's game only while that leaves room."""
    launch_id = _check_token(ctx, token)
    doc = _launch(ctx, launch_id)
    state = doc.get("state")
    if state == "waiting":
        now = time.time()
        fast = now - float(doc.get("hintAt") or 0) < HINT_FAST_SEC
        card = now - float(doc.get("cardAt") or 0) < CARD_UP_SEC
        first, also, calm = doc.get("preload"), doc.get("also") or [], 0
        ahead = None if card else _ahead(ctx, launch_id, doc, now)
        if ahead:
            first, also, calm = ahead.get("preload"), ahead.get("also") or [], float(ahead.get("calmUntil") or 0) - now
        return {"state": "wait", "next": FAST_POLL_MS if fast else IDLE_POLL_MS, "preload": first,
                **({"also": also} if also else {}), **({"card": True} if card else {}),
                **({"calm": int(calm)} if calm >= 1 else {})}
    if state != "assigned":
        raise AdError(410, "used", "이 대기 세션은 이미 쓰였어요")
    go = doc.get("go") or {}
    expect = _sign_go(ctx, launch_id, str(go.get("url", "")), int(go.get("exp", 0)))
    if not hmac.compare_digest(str(go.get("sig", "")), expect):
        raise AdError(403, "bad_instruction", "서명이 맞지 않는 지시예요")
    if time.time() > int(go["exp"]):
        raise AdError(410, "expired", "지시가 만료됐어요")
    if not store._update(ctx, f"LAUNCH#{launch_id}", "META", {"state": "used", "usedAt": store.now()},
                         expect={"state": "assigned"}):
        raise AdError(410, "used", "이 대기 세션은 이미 쓰였어요")
    return {"state": "go", "url": go["url"]}


def launcher_connected(ctx, job_id: str) -> bool | None:
    """Whether a viewer could be served by a warm launcher right now: one of this broadcast's hidden launchers nobody
    plays yet is CONNECTED. False while they are all still starting (a cold host takes waits.CLOUD_START_SEC), None
    when the broadcast has none at all."""
    group = streams._web_group()
    gls = streams.client()
    seen = False
    for item in streams.ledger(ctx, group):
        lid = _launch_of(item.get("desc", ""))
        if not lid or item["desc"].split()[2] != job_id:
            continue
        doc = store._get(ctx, f"LAUNCH#{lid}", "META") or {}
        if doc.get("state") != "waiting":
            continue
        seen = True
        try:
            status = gls.get_stream_session(Identifier=group, StreamSessionIdentifier=item["streamId"]).get("Status")
        except Exception:  # noqa: BLE001 — gone meanwhile
            continue
        if status == "CONNECTED":
            return True
    return False if seen else None


def waiting_launchers(ctx, job_id: str) -> list:
    """[(launchId, [viewerId, …])] of the broadcast's hidden launchers nobody plays yet whose page named its viewers
    (the likeliest first)."""
    out = []
    for item in streams.ledger(ctx, streams._web_group()):
        lid = _launch_of(item.get("desc", ""))
        if not lid or item["desc"].split()[2] != job_id:
            continue
        doc = store._get(ctx, f"LAUNCH#{lid}", "META") or {}
        if doc.get("state") == "waiting" and _viewers_of(doc):
            out.append((lid, _viewers_of(doc)))
    return out


def end_launchers(ctx, job_id: str | None) -> int:
    """The broadcast stopped using playables (switched, stopped, the switch OFF): its hidden launchers nobody plays
    are ended. → how many."""
    if not job_id:
        return 0
    try:
        group = streams._web_group()
        n = 0
        for item in streams.ledger(ctx, group):
            lid = _launch_of(item.get("desc", ""))
            if not lid or item["desc"].split()[2] != job_id:
                continue
            doc = store._get(ctx, f"LAUNCH#{lid}", "META") or {}
            if doc.get("state") in (None, "waiting"):
                store._update(ctx, f"LAUNCH#{lid}", "META", {"state": "ended"})
                streams.end(ctx, group, item["streamId"])
                n += 1
        return n
    except Exception as e:  # noqa: BLE001 — the pages end their own; connectionTimeout ends the rest
        print(f"end launchers of {job_id} failed: {e}")
        return 0
