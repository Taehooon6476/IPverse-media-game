"""Games over Amazon GameLift Streams (docs/ue5/design.md §5).

Two stream groups in us-west-2: the UE5 template game (STREAM_GROUP_ID, Linux) and the web player
(WEB_STREAM_GROUP_ID, Windows: an Electron shell, workers/stream-shell) that opens any three.js IPverse game whose
URL arrives in IPVERSE_GAME_URL. A session remembers its group, so poll/reconnect/stop go to the right one.

The API Lambda (us-east-1) drives one stream group in us-west-2. Per stream the server writes a manifest
(GameSpec + presigned GLB URLs) under the private `streams/` prefix and hands the game a presigned URL to it
through the IPVERSE_SPEC_URL environment variable. Starting is split from polling: placement can take up to
90 s, longer than an API Gateway/CloudFront request.
"""
from __future__ import annotations
import json
import os
import time
import traceback
import uuid

from server import store
from server.i18n import said, tr

URL_TTL_SEC = 900  # the game reads the manifest and GLBs once, right after launch
SESSION_LENGTH_SEC = 1800
CONNECT_TIMEOUT_SEC = 180  # pre-roll ad (≤30 s) plays between ACTIVE and the WebRTC connect
MAX_SIGNAL_CHARS = 64_000
# TerminateStreamSession refuses a session that is still ACTIVATING (waiting for a host). Left alone, it takes the
# next free host and holds it until connectionTimeout, so a self-invoke ends it the moment it is placed.
END_POLL_SEC = 5
END_BUDGET_SEC = 240  # one self-invoke waits this long (well inside the Lambda timeout), then hands over to the next
END_ROUNDS = 8  # ~32 min in all: longer than any placement wait
RESERVE_SEC = 30  # a start in flight holds its place in the capacity count this long
ADOPT_TRIES = 3  # polls of a taken-over session whose connection fails before the page is told to retry
_DONE = ("TERMINATING", "TERMINATED", "ERROR")  # holds no host (an ERROR session never got one)
REPLACED_TEXT = ("이 세션의 클라우드 플레이를 다른 창(또는 기기)에서 시작해서 이 창의 스트림은 닫았어요. "
                 "여기서 계속하려면 다시 시도를 누르세요")
CAPACITY_TEXT = ("지금은 클라우드 GPU {n}대가 모두 사용 중이에요. 다른 창이나 다른 사람의 클라우드 플레이가 끝나면 "
                 "다시 시도해 주세요. 바로 하려면 ‘브라우저 미리보기’로 플레이할 수 있어요")
# a cloud play this session no longer has (it ended, or the page is out of date)
NO_STREAM_TEXT = "클라우드 플레이 연결이 이미 끝났어요. 다시 시작해 주세요."
_client = None
_app_cache: dict = {}  # group -> {"id", "at"}; (group, "max") -> {"n", "at"}


class StreamError(Exception):
    def __init__(self, status: int, code: str, message: str):
        message = said(message)  # in the request's language: the sentence is written where it is raised
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _region() -> str:
    return os.environ.get("STREAMS_REGION", "us-west-2")


def _group() -> str:
    group = os.environ.get("STREAM_GROUP_ID", "")
    if not group:
        raise StreamError(503, "streams_disabled", "Unreal 플레이가 아직 준비되지 않았어요. 관리자에게 문의해 주세요.")
    return group


def _web_group() -> str:
    group = os.environ.get("WEB_STREAM_GROUP_ID", "")
    if not group:
        raise StreamError(503, "streams_disabled", "클라우드 플레이가 아직 설정되지 않았어요. 관리자에게 문의해 주세요.")
    return group


def web_game_url(game: dict, query: str = "noads=1") -> str:
    """The game page the web player opens (its own pre-roll is shown by the studio client instead)."""
    base = (game.get("publishedUrl") or game["previewUrl"]).split("?", 1)[0]
    return f"{base}?{query}" if query else base


def client():
    global _client
    if _client is None:
        import boto3
        _client = boto3.client("gameliftstreams", region_name=_region())
    return _client


def _application_id(gls, group: str) -> str:
    """STREAM_APPLICATION_ID, else the stream group's default application (a new build swaps it, no redeploy)."""
    fixed = os.environ.get("STREAM_APPLICATION_ID")
    if fixed and group == os.environ.get("STREAM_GROUP_ID"):
        return fixed
    hit = _app_cache.get(group)
    if hit and time.monotonic() - hit["at"] < 60:
        return hit["id"]
    desc = gls.get_stream_group(Identifier=group)
    _cache_max(group, desc)
    app_id = (desc.get("DefaultApplication") or {}).get("Id")
    if not app_id:
        raise StreamError(503, "no_build", "클라우드 플레이가 아직 준비되지 않았어요. 관리자에게 문의해 주세요.")
    _app_cache[group] = {"id": app_id, "at": time.monotonic()}
    return app_id


def _locations() -> list:
    raw = os.environ.get("STREAM_LOCATIONS", "")
    return [x.strip() for x in raw.split(",") if x.strip()] or [_region()]


def _model_yaw() -> float:
    """Degrees the game turns every IP mesh so its face points forward (Hunyuan3D GLBs share one convention)."""
    try:
        return float(os.environ.get("UE5_MODEL_YAW", "0"))
    except ValueError:
        return 0.0


def _presign(ctx, key: str) -> str:
    return ctx.s3.generate_presigned_url(
        "get_object", Params={"Bucket": ctx.assets_bucket, "Key": key}, ExpiresIn=URL_TTL_SEC)


def _unreal_game(ctx, session_id: str, game_id=None) -> dict:
    games = [g for g in store.snapshot(ctx, session_id)["games"] if g.get("engine") == "unreal" and g.get("ue5Key")]
    if game_id is not None:
        games = [g for g in games if g["gameId"] == game_id]
    if not games:
        raise StreamError(409, "no_unreal_game", "Unreal로 만든 게임이 없어요. 채팅에서 Unreal 게임을 먼저 만들어 달라고 해 주세요.")
    return games[-1]


def write_manifest(ctx, session_id: str, game: dict) -> str:
    """Resolves the game's ue5.json (GLB keys) into a manifest with presigned URLs; returns its presigned URL."""
    template = json.loads(ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=game["ue5Key"])["Body"].read())
    expires = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + URL_TTL_SEC))
    manifest = {
        "manifestVersion": 1, "sessionId": session_id, "gameId": game["gameId"], "expiresAt": expires,
        "spec": template["spec"],
        "ips": {ip_id: {"role": ip["role"], "name": ip.get("name") or ip_id, "glbUrl": _presign(ctx, ip["glbKey"]),
                        "yaw": ip.get("yaw", _model_yaw())}
                for ip_id, ip in template.get("ips", {}).items()},
    }
    key = f"streams/{session_id}/{uuid.uuid4().hex}.json"
    ctx.s3.put_object(Bucket=ctx.assets_bucket, Key=key, Body=json.dumps(manifest, ensure_ascii=False).encode(),
                      ContentType="application/json")
    return _presign(ctx, key)


def _stream_id(arn: str) -> str:
    return arn.rsplit("/", 1)[-1]


def _owned(session: dict, stream_id: str) -> dict:
    stream = session.get("stream") or {}
    if not stream_id or _stream_id(stream.get("arn", "")) != stream_id:
        raise StreamError(404, "not_found", tr(NO_STREAM_TEXT))
    return stream


def _signal(body: dict) -> str:
    signal = body.get("signalRequest")
    if not isinstance(signal, str) or not signal.strip() or len(signal) > MAX_SIGNAL_CHARS:
        raise StreamError(400, "bad_request", "연결 정보가 올바르지 않아요. 페이지를 새로 고친 뒤 다시 해 주세요.")
    return signal


def _any_game(ctx, session_id: str, game_id) -> dict:
    games = store.snapshot(ctx, session_id)["games"]
    game = next((g for g in games if g["gameId"] == game_id), None) if game_id else (games[-1] if games else None)
    if not game:
        raise StreamError(409, "no_game", "클라우드로 플레이할 게임이 없어요. 먼저 게임을 만들어 주세요.")
    return game


def start(ctx, user: dict, session: dict, body: dict) -> tuple:
    """kind web (or any non-Unreal game): the web player; else the UE5 template game."""
    signal = _signal(body)
    if body.get("kind") == "web" or not (_any_game(ctx, session["sessionId"], body.get("gameId")).get("engine") == "unreal"):
        return _start_web(ctx, user, session, body, signal)
    group = _group()
    game = _unreal_game(ctx, session["sessionId"], body.get("gameId"))
    gls = client()
    app_id = _application_id(gls, group)
    if adopted := _adopt(ctx, session, group, game["gameId"], signal):
        return 202, adopted
    _terminate_old(ctx, session)
    resp = open_session(
        ctx, gls, group, tr(CAPACITY_TEXT), ApplicationIdentifier=app_id, Protocol="WebRTC", SignalRequest=signal,
        UserId=user["sub"], Description=f"ipverse {game['gameId']}"[:80],
        AdditionalEnvironmentVariables={"IPVERSE_SPEC_URL": write_manifest(ctx, session["sessionId"], game)},
        Locations=_locations(), SessionLengthSeconds=SESSION_LENGTH_SEC, ConnectionTimeoutSeconds=CONNECT_TIMEOUT_SEC,
    )
    store.update_session(ctx, session, stream={"arn": resp["Arn"], "gameId": game["gameId"], "group": group,
                                               "startedAt": store.now()})
    return 202, {"streamId": _stream_id(resp["Arn"]), "status": resp.get("Status", "ACTIVATING"), "gameId": game["gameId"]}


def _terminate_old(ctx, session):
    old = session.get("stream") or {}
    if old.get("arn"):  # one stream per session: a new start replaces the old one (and its billing)
        end(ctx, old.get("group") or _group(), _stream_id(old["arn"]))


# ── a page that replaces a session still waiting for a host takes that session over ──────────────────────────
# GameLift Streams places waiting sessions in order and cannot end one before it is placed, so a fresh session
# would wait behind every page it replaced. The newest page gets the waiting session under its own handle
# "<session id>.<tag>" (older handles end nothing); its offer is answered through CreateStreamSessionConnection
# once the session is ACTIVE.

def _handle(stream: dict) -> str:
    return stream.get("handle") or _stream_id(stream.get("arn", ""))


def _gls_id(handle: str) -> str:
    return handle.split(".", 1)[0]


def _offer_key(handle: str) -> tuple:
    return f"STREAMOFFER#{_gls_id(handle)}", handle


def _adopt(ctx, session, group, game_id, signal):
    old = session.get("stream") or {}
    if not old.get("arn") or (old.get("group") or _group()) != group or old.get("gameId") != game_id:
        return None
    gls_id = _stream_id(old["arn"])
    if _status(group, gls_id) != "ACTIVATING":  # placed (another page may play it) or gone: a new one
        return None
    handle = f"{gls_id}.{uuid.uuid4().hex[:8]}"
    store._put(ctx, *_offer_key(handle), {"signal": signal, "tries": 0})
    store.update_session(ctx, session, stream={**old, "handle": handle})
    return {"streamId": handle, "status": "ACTIVATING", "gameId": game_id}


def _answer(ctx, group: str, handle: str):
    """The answer to the adopting page's offer (one connection, remembered), or after ADOPT_TRIES failures 'ERROR'."""
    item = store._get(ctx, *_offer_key(handle)) or {}
    if item.get("answer") or not item.get("signal"):
        return item.get("answer")
    try:
        answer = client().create_stream_session_connection(
            Identifier=group, StreamSessionIdentifier=_gls_id(handle), SignalRequest=item["signal"])["SignalResponse"]
    except Exception:  # noqa: BLE001 — a passing error: the next poll tries again
        traceback.print_exc()
        tries = int(item.get("tries") or 0) + 1
        store._put(ctx, *_offer_key(handle), {**item, "tries": tries})
        return "ERROR" if tries >= ADOPT_TRIES else None
    store._put(ctx, *_offer_key(handle), {"answer": answer})
    return answer


def _start_web(ctx, user, session, body, signal) -> tuple:
    group = _web_group()
    game = _any_game(ctx, session["sessionId"], body.get("gameId"))
    gls = client()
    app_id = _application_id(gls, group)
    if adopted := _adopt(ctx, session, group, game["gameId"], signal):
        return 202, adopted
    _terminate_old(ctx, session)
    resp = open_session(
        ctx, gls, group, tr(CAPACITY_TEXT), ApplicationIdentifier=app_id, Protocol="WebRTC", SignalRequest=signal,
        UserId=user["sub"], Description=f"ipverse web {game['gameId']}"[:80],
        AdditionalEnvironmentVariables={"IPVERSE_GAME_URL": web_game_url(game)},
        Locations=[_region()], SessionLengthSeconds=SESSION_LENGTH_SEC, ConnectionTimeoutSeconds=CONNECT_TIMEOUT_SEC,
    )
    store.update_session(ctx, session, stream={"arn": resp["Arn"], "gameId": game["gameId"], "group": group,
                                               "kind": "web", "startedAt": store.now()})
    return 202, {"streamId": _stream_id(resp["Arn"]), "status": resp.get("Status", "ACTIVATING"), "gameId": game["gameId"]}


def _taken_over(stream: dict, stream_id) -> bool:
    """An older page's handle of the session a newer page took over: replaced, but the session is still in use."""
    return bool(stream.get("arn") and isinstance(stream_id, str) and stream_id
                and _gls_id(stream_id) == _stream_id(stream["arn"]) and stream_id != _handle(stream))


def poll(ctx, user: dict, session: dict, stream_id: str) -> tuple:
    stream = session.get("stream") or {}
    if _taken_over(stream, stream_id):
        raise StreamError(409, "stream_replaced", tr(REPLACED_TEXT))
    if not stream_id or _handle(stream) != stream_id:
        group = _replaced(user, stream_id)
        if not group:
            raise StreamError(404, "not_found", tr(NO_STREAM_TEXT))
        end(ctx, group, _gls_id(stream_id))  # nobody plays it any more: its host goes back now
        raise StreamError(409, "stream_replaced", tr(REPLACED_TEXT))
    group = stream.get("group") or _group()
    resp = client().get_stream_session(Identifier=group, StreamSessionIdentifier=_gls_id(stream_id))
    out = {"streamId": stream_id, "status": resp.get("Status")}
    if resp.get("Status") == "ACTIVE" and stream.get("handle"):  # taken over: the answer is to this page's offer
        answer = _answer(ctx, group, stream_id)
        if answer == "ERROR":
            out["status"], out["statusReason"] = "ERROR", "connectionFailed"
        elif answer:
            out["signalResponse"] = answer
    elif resp.get("Status") == "ACTIVE" and resp.get("SignalResponse"):
        out["signalResponse"] = resp["SignalResponse"]
    if resp.get("StatusReason"):
        out["statusReason"] = resp["StatusReason"]
    return 200, out


def reconnect(ctx, user: dict, session: dict, stream_id: str, body: dict) -> tuple:
    stream = _owned(session, stream_id)
    resp = client().create_stream_session_connection(
        Identifier=stream.get("group") or _group(), StreamSessionIdentifier=_gls_id(stream_id), SignalRequest=_signal(body))
    return 200, {"streamId": stream_id, "signalResponse": resp["SignalResponse"]}


def terminate(ctx, user: dict, session: dict, stream_id: str) -> tuple:
    stream = session.get("stream") or {}
    if _taken_over(stream, stream_id):
        pass  # a newer page plays that session now: closing the older page ends nothing
    elif stream_id and _handle(stream) == stream_id:
        end(ctx, stream.get("group") or _group(), _gls_id(stream_id))
        store.update_session(ctx, session, stream=None)
        if stream.get("handle"):
            pk, sk = _offer_key(stream_id)
            ctx.table.delete_item(Key={"pk": pk, "sk": sk})
    else:  # a window whose stream another start replaced (or raced): its session still holds a host
        group = _replaced(user, stream_id)
        if not group:
            raise StreamError(404, "not_found", tr(NO_STREAM_TEXT))
        end(ctx, group, _gls_id(stream_id))
    return 200, {"streamId": stream_id, "status": "TERMINATING"}


def _replaced(user: dict, stream_id: str):
    """The group of a studio stream this user started that their session no longer points at (another window's
    start replaced it, or two starts raced and the other one was stored), else None."""
    if not isinstance(stream_id, str) or not stream_id or "/" in stream_id:
        return None
    for group in [g for g in (os.environ.get("WEB_STREAM_GROUP_ID"), os.environ.get("STREAM_GROUP_ID")) if g]:
        try:
            resp = client().get_stream_session(Identifier=group, StreamSessionIdentifier=_gls_id(stream_id))
        except Exception:  # not in this group
            continue
        if resp.get("UserId") == user["sub"] and (resp.get("Description") or "").startswith("ipverse "):
            return group
    return None


# ── session lifetime: every start is counted against the group's capacity, every end really ends ──────────────
# A ledger in the table (pk GLS#<group>) lists the sessions this API started and not yet saw end: the capacity
# check counts it (GameLift Streams queues a start past MaximumCapacity as ACTIVATING without a word), and an
# ad's hidden sessions are found in it when the broadcast changes.

def _ledger_pk(group: str) -> str:
    return f"GLS#{group}"


def _status(group: str, stream_id: str):
    try:
        return client().get_stream_session(Identifier=group, StreamSessionIdentifier=stream_id).get("Status")
    except Exception:  # unknown or long gone
        return None


def _max_capacity(gls, group: str):
    hit = _app_cache.get((group, "max"))
    if hit and time.monotonic() - hit["at"] < 60:
        return hit["n"]
    return _cache_max(group, gls.get_stream_group(Identifier=group))


def _cache_max(group: str, desc: dict):
    loc = next((x for x in desc.get("LocationStates") or [] if x.get("LocationName") == _region()), {})
    _app_cache[(group, "max")] = {"n": loc.get("MaximumCapacity"), "at": time.monotonic()}
    return loc.get("MaximumCapacity")


def ledger(ctx, group: str) -> list:
    """Sessions (and starts in flight) that may hold a host, oldest first; ended ones are dropped on the way."""
    out = []
    now_ms = int(time.time() * 1000)
    for item in store._query(ctx, _ledger_pk(group)):
        item = store.plain(item)
        if not item.get("streamId"):
            if now_ms - item["at"] > RESERVE_SEC * 1000:  # a start that never finished
                ctx.table.delete_item(Key={"pk": item["pk"], "sk": item["sk"]})
            else:
                out.append(item)
            continue
        if _status(group, item["streamId"]) in (None, *_DONE):
            ctx.table.delete_item(Key={"pk": item["pk"], "sk": item["sk"]})
            continue
        if not item.get("ending"):  # one set to end as soon as placed frees its host by itself
            out.append(item)
    return sorted(out, key=lambda i: (i["at"], not i.get("streamId"), i["sk"]))  # a tie: the started one first


def open_session(ctx, gls, group: str, full_text: str, **kwargs) -> dict:
    """StartStreamSession, once the group has room: a start past MaximumCapacity is refused with full_text
    (503) instead of waiting ACTIVATING for minutes. Concurrent starts each reserve a place first, so of three at
    once on a group of two the latest one is refused."""
    pk, rsv = _ledger_pk(group), f"rsv#{uuid.uuid4().hex[:12]}"
    at = int(time.time() * 1000)
    store._put(ctx, pk, rsv, {"at": at})
    try:
        n = _max_capacity(gls, group)
        if isinstance(n, int) and n > 0 and [i["sk"] for i in ledger(ctx, group)].index(rsv) >= n:
            raise StreamError(503, "stream_capacity", full_text.format(n=n))
        resp = gls.start_stream_session(Identifier=group, **kwargs)
    except Exception:
        ctx.table.delete_item(Key={"pk": pk, "sk": rsv})
        raise
    stream_id = _stream_id(resp["Arn"])
    store._put(ctx, pk, stream_id, {"at": at, "streamId": stream_id, "desc": kwargs.get("Description", "")})
    ctx.table.delete_item(Key={"pk": pk, "sk": rsv})
    return resp


def end(ctx, group: str, stream_id: str) -> str:
    """Ends a stream session now, or as soon as GameLift Streams lets it. Idempotent: asking again for one that is
    ended (or already set to end) changes nothing."""
    try:
        client().terminate_stream_session(Identifier=group, StreamSessionIdentifier=stream_id)
        status = "TERMINATING"
    except Exception:  # ACTIVATING (refused), already gone, or a transient error
        status = _status(group, stream_id)
    if status in (None, *_DONE):
        ctx.table.delete_item(Key={"pk": _ledger_pk(group), "sk": stream_id})
        return status or "TERMINATED"
    item = store._get(ctx, _ledger_pk(group), stream_id)
    if item and item.get("ending"):
        return status  # its self-invoke already waits for it
    store._put(ctx, _ledger_pk(group), stream_id, {**(item or {"at": int(time.time() * 1000), "streamId": stream_id}),
                                                   "ending": True})
    _end_later(ctx, group, stream_id, 1)
    return status


def _end_later(ctx, group: str, stream_id: str, round_: int):
    try:
        ctx.lambda_.invoke(FunctionName=os.environ["SELF_FUNCTION_NAME"], InvocationType="Event",
                           Payload=json.dumps({"action": "stream_end", "group": group, "streamId": stream_id,
                                               "round": round_}))
    except Exception:  # noqa: BLE001 — the session then ends at its connectionTimeout
        traceback.print_exc()


def end_when_placed(ctx, group: str, stream_id: str, round_: int = 1) -> dict:
    """Self-invoke (action stream_end): wait while the session is ACTIVATING, then terminate it."""
    deadline = time.monotonic() + END_BUDGET_SEC
    while (status := _status(group, stream_id)) == "ACTIVATING":
        if time.monotonic() >= deadline:
            if round_ < END_ROUNDS:
                _end_later(ctx, group, stream_id, round_ + 1)
            else:  # given up: the next end() of it waits again
                ctx.table.delete_item(Key={"pk": _ledger_pk(group), "sk": stream_id})
            return {"status": status, "round": round_}
        time.sleep(END_POLL_SEC)
    if status not in (None, *_DONE):
        try:
            client().terminate_stream_session(Identifier=group, StreamSessionIdentifier=stream_id)
            status = "TERMINATING"
        except Exception:  # noqa: BLE001 — it ends at its connectionTimeout instead
            traceback.print_exc()
    ctx.table.delete_item(Key={"pk": _ledger_pk(group), "sk": stream_id})
    return {"status": status, "round": round_}
