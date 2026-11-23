"""Lambda entry point: async agent turns, and Function URL routing for the HTTP API (shared contracts)."""
from __future__ import annotations
import base64
import json
import os
import re
import time
import traceback

from server import ads, agent, agents, auth, connections, game_design, i18n, jobs, live, playable, store, streams, tools
from server.gamespec import GENRES
from server.providers.base import Ctx
from server.i18n import tr

CTX = None  # built on first use; tests and local_dev.py inject their own
MAX_CHAT_CHARS = 4000


def _ctx():
    global CTX
    if CTX is None:
        CTX = Ctx.from_env()
    return CTX


class HttpError(Exception):
    """An answer of 400 or more. The web shows `message` as it is (api.ts), so it is written for the person at the
    screen, in 해요체, with no field, tool or class name, in the request's language (server/i18n.py).
    extra: more fields of the answer that the page itself reads (retryAfterSec)."""

    def __init__(self, status: int, code: str, message: str = "", **extra):
        message = i18n.said(message)  # in the request's language
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra


# A request the page itself built wrong (no person typed it): the page is out of date or broken
BAD_REQUEST = "요청을 읽지 못했어요. 화면을 새로 고친 뒤 다시 해 주세요."


def _resp(status: int, payload) -> dict:
    return {"statusCode": status, "headers": {"content-type": "application/json"},
            "body": "" if status == 204 else json.dumps(payload, ensure_ascii=False)}


def _body(event: dict) -> dict:
    raw = event.get("body") or ""
    try:
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw).decode("utf-8")
        data = json.loads(raw) if raw else {}
    except ValueError:
        raise HttpError(400, "bad_request", tr(BAD_REQUEST)) from None
    if not isinstance(data, dict):
        raise HttpError(400, "bad_request", tr(BAD_REQUEST))
    return data


def _own_session(ctx, user: dict, session_id: str) -> dict:
    session = store.get_session(ctx, session_id)
    if not session or session.get("userSub") != user["sub"]:
        raise HttpError(404, "not_found", "세션을 찾지 못했어요. 목록에서 다시 골라 주세요.")
    return session


def _starts_work(ctx, user: dict, session_id: str) -> dict:
    """The own session of a request that starts work which goes on after it (a chat turn, a card's tool button, a
    broadcast): the session keeps this request's language for what that work writes later (i18n.remember). Only
    here: a poll never writes."""
    session = _own_session(ctx, user, session_id)
    i18n.remember(ctx, session)
    return session


def _genre(value) -> str:
    if value not in GENRES:
        raise HttpError(400, "bad_request", "장르를 목록에서 다시 골라 주세요.")
    return value


def _tool_result(result: dict) -> dict:
    if "error" in result:
        status = 404 if result["error"] in ("not_found", "unknown_tool") else 400
        raise HttpError(status, result["error"], tools.user_text(result))  # not `message`: that is the agent's copy
    return result


# ── routes: (ctx, user, body, *path groups) -> (status, payload) ────────────────

def list_sessions(ctx, user, body):
    return 200, {"sessions": store.list_sessions(ctx, user["sub"])}


def create_session(ctx, user, body):
    genre = _genre(body["genre"]) if body.get("genre") is not None else None
    title = body["title"].strip() if isinstance(body.get("title"), str) else ""
    return 201, {"session": store.put_session(ctx, user["sub"], title or None, genre)}


def get_session(ctx, user, body, session_id):
    _own_session(ctx, user, session_id)
    jobs.advance_jobs(ctx, session_id)
    snap = store.snapshot(ctx, session_id)
    agent.fail_stale_turns(ctx, snap)
    agent.tell_finished(ctx, snap)  # a 3D chain or a trailer that has ended: one line in the chat
    return 200, _as_read(snap)


def _as_read(snap: dict) -> dict:
    """The session as the page is handed it: the stored snapshot plus gameHeroes, who can be a game's hero here by
    the server's own rule (tools.game_heroes)."""
    snap["gameHeroes"] = tools.game_heroes(snap)
    return snap


def patch_session(ctx, user, body, session_id):
    session = _own_session(ctx, user, session_id)
    fields = {}
    if body.get("genre") is not None:
        fields["genre"] = _genre(body["genre"])
    if body.get("title") is not None:
        fields["title"] = body["title"].strip() if isinstance(body["title"], str) else ""
        if not fields["title"]:
            raise HttpError(400, "bad_request", "세션 제목을 적어 주세요.")
    if fields:
        store.update_session(ctx, session, **fields)
    return 200, _as_read(store.snapshot(ctx, session_id))


def delete_session(ctx, user, body, session_id):
    """Owner only. Refused while something could still write into the session: its broadcast, a queued or
    running job (the user stops those in 작업 현황 first), an agent reply in progress."""
    session = _own_session(ctx, user, session_id)
    if live.on_air(ctx, session_id):
        raise HttpError(409, "live_on_air", "라이브 방송 중인 세션은 지울 수 없어요. 방송을 끈 뒤 다시 시도해 주세요.")
    jobs.advance_jobs(ctx, session_id)  # a render that finished since the last poll no longer counts
    snap = store.snapshot(ctx, session_id)
    running = [j for j in snap["jobs"] if j.get("status") in ("queued", "running")]
    if running:
        raise HttpError(409, "jobs_running", f"진행 중인 작업 {len(running)}건이 있어 지울 수 없어요. "
                                             "작업 현황에서 중지하거나 끝난 뒤 다시 시도해 주세요.")
    if any(m.get("status") == "pending" and store.age_sec(m["ts"]) <= agent.STALE_TURN_SEC for m in snap["messages"]):
        raise HttpError(409, "turn_running", "답변을 만드는 중이에요. 답변이 끝난 뒤 다시 시도해 주세요.")
    store.delete_session(ctx, session)
    return 200, {"deleted": session_id}


def chat(ctx, user, body, session_id):
    _starts_work(ctx, user, session_id)
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise HttpError(400, "bad_request", "보낼 내용을 적어 주세요.")
    if len(text) > MAX_CHAT_CHARS:
        raise HttpError(400, "bad_request", f"메시지가 너무 길어요. {MAX_CHAT_CHARS:,}자 안으로 줄여 다시 보내 주세요.")
    design = None
    if body.get("gameDesign") is not None:
        ips = {i["ipId"]: i for i in store.snapshot(ctx, session_id)["ips"]}
        design, errors = game_design.validate_design(body["gameDesign"], ips, text.strip())
        if errors:
            raise HttpError(400, "invalid_game_design", " ".join(errors))  # sentences (game_design.validate_design)
    message = store.put_message(ctx, session_id, "user", text.strip(), "done")
    if design is not None:
        store.update_message(ctx, session_id, message, gameDesign=design)
    reply = store.put_message(ctx, session_id, "assistant", "", "pending", ts=store.now(offset_ms=1))  # sorts after
    try:
        ctx.lambda_.invoke(FunctionName=os.environ["SELF_FUNCTION_NAME"], InvocationType="Event",
                           Payload=json.dumps({"action": "agent_turn", "sessionId": session_id,
                                               "messageId": reply["messageId"], "lang": i18n.lang()}))
    except Exception:  # no turn will run: fail the reply now instead of leaving it pending
        traceback.print_exc()
        store.update_message(ctx, session_id, reply, status="failed", text=tr("요청을 시작하지 못했어요. 다시 보내 주세요."))
    return 202, {"messageId": reply["messageId"]}


def run_tool(ctx, user, body, session_id, tool):
    session = _starts_work(ctx, user, session_id)
    result = _tool_result(tools.run_tool(ctx, session, tool, body))
    # A 3D chain or a trailer a card's button started: its end is told in the chat (agent.watch), never in the way
    # of the answer
    try:
        agent.watch(ctx, session_id, tool, result)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
    return 200, {"result": result}


ASYNC_TOOL_BUDGET_SEC = 240  # inside the 300 s Lambda timeout
ASYNC_TOOLS = {"reroll_ip_image": "다시 뽑는 중…", "make_action_shot": "액션 샷 준비 중…",
               "make_skill_asset": "장르 스킬 IP 만드는 중… (그림 → 3D)"}


def run_tool_async(ctx, user, body, session_id, tool):
    """UI buttons whose tool waits for a GPU image (longer than CloudFront's 60 s): an assistant status message
    now, the tool in a self-invoke, the message updated with the outcome. No agent turn, no user message."""
    _starts_work(ctx, user, session_id)
    if tool not in ASYNC_TOOLS:
        raise HttpError(400, "bad_request", "이 버튼은 지금 쓸 수 없어요. 화면을 새로 고친 뒤 다시 눌러 주세요.")
    reply = store.put_message(ctx, session_id, "assistant", tr(ASYNC_TOOLS[tool]), "pending")
    try:
        ctx.lambda_.invoke(FunctionName=os.environ["SELF_FUNCTION_NAME"], InvocationType="Event",
                           Payload=json.dumps({"action": "run_tool", "sessionId": session_id, "tool": tool,
                                               "args": body, "lang": i18n.lang(),
                                               "message": {"messageId": reply["messageId"], "ts": reply["ts"]}}))
    except Exception:
        traceback.print_exc()
        store.update_message(ctx, session_id, reply, status="failed", text=tr("작업을 시작하지 못했어요. 다시 눌러 주세요."))
    return 202, {"messageId": reply["messageId"]}


def run_tool_turn(ctx, session_id, tool, args, message):
    session = store.get_session(ctx, session_id)
    if not session:
        return
    try:
        result = tools.run_tool(ctx, session, tool, args if isinstance(args, dict) else {},
                                time.monotonic() + ASYNC_TOOL_BUDGET_SEC)
    except Exception:  # never leave the status message pending; the exception is in the log, not in the chat
        traceback.print_exc()
        result = {"error": "internal", "notice": tr("잠시 뒤 다시 눌러 주세요.")}
    # A refusal's line is the user's sentence (tools.button_line), not the agent's copy of it
    line = (tools.button_line(tool, result) if "error" in result
            else tools.summarize(tool, args if isinstance(args, dict) else {}, result))
    ip = store.get_ip(ctx, session_id, (args or {}).get("ipId", "")) if "error" not in result else None
    if ip:  # "다시 뽑기: 나비 v3" instead of a bare label; a queued draw gets no version, since a failed composition
        # check keeps it out of the IP (a version only) and this line is written once
        version = result.get("version") if result.get("status") != "queued" else None
        line = f"{tools.tool_label(tool)}: {ip.get('name', '')}" + (f" v{version}" if version else "")
    store.update_message(ctx, session_id, message, status="failed" if "error" in result else "done", text=line)


def cancel(ctx, user, body, session_id, job_id):
    _own_session(ctx, user, session_id)
    if jobs.cancel_job(ctx, session_id, job_id) is None:
        raise HttpError(400, "bad_request", "이 작업은 이미 끝났거나 중지돼서 중지할 수 없어요.")
    return 200, {"canceled": job_id}


def _conn(fn, *args):
    try:
        return 200, fn(*args)
    except connections.ConnError as e:
        raise HttpError(e.status, e.code, e.message) from None


def conn_list(ctx, user, body):
    return _conn(connections.listing, ctx, user)


def conn_add(ctx, user, body):
    return _conn(connections.add, ctx, user, body)


def conn_update(ctx, user, body, conn_id):
    return _conn(connections.update, ctx, user, conn_id, body)


def conn_remove(ctx, user, body, conn_id):
    return _conn(connections.remove, ctx, user, conn_id)


USERNAME = re.compile(r"[A-Za-z0-9_.-]{3,32}")


def signup(ctx, body):
    """Instant sign-up for the demo (no e-mail, no confirmation): the user exists with a permanent password and
    the browser logs in right after. ponytail: no rate limit beyond Cognito's own; add a CAPTCHA if abused."""
    username, password = body.get("username"), body.get("password")
    if not isinstance(username, str) or not USERNAME.fullmatch(username):
        raise HttpError(400, "bad_request", "아이디는 영문·숫자·_.- 3–32자로 입력해 주세요")
    if not isinstance(password, str) or not 12 <= len(password) <= 128:
        raise HttpError(400, "bad_request", "비밀번호는 대·소문자, 숫자, 특수문자를 넣어 12자 이상으로 적어 주세요.")
    pool = os.environ["USER_POOL_ID"]
    try:
        ctx.cognito.admin_create_user(UserPoolId=pool, Username=username, MessageAction="SUPPRESS")
    except ctx.cognito.exceptions.UsernameExistsException:
        raise HttpError(409, "exists", "이미 있는 아이디예요. 다른 아이디를 써 주세요") from None
    try:
        ctx.cognito.admin_set_user_password(UserPoolId=pool, Username=username, Password=password, Permanent=True)
    except ctx.cognito.exceptions.InvalidPasswordException:
        ctx.cognito.admin_delete_user(UserPoolId=pool, Username=username)
        raise HttpError(400, "bad_request", "비밀번호는 12자 이상, 대·소문자, 숫자, 특수문자를 모두 넣어 주세요") from None
    return 201, {"username": username}


DEMO_SECRET = "ipverse/demo-user"  # Secrets Manager: {"username", "password"} of the shared demo account
_demo: dict = {}  # what this container last read of it: {"name": its username or None, "until"}


def demo_login(ctx, body):
    """The login screen's 데모 로그인 button: tokens of the shared demo account. Its password stays in Secrets Manager
    (ipverse/demo-user) and never reaches the page. ponytail: open to anyone, like sign-up; gate it if abused."""
    from . import ads
    secret = json.loads(ads._sm(ctx).get_secret_value(SecretId=DEMO_SECRET)["SecretString"])
    result = ctx.cognito.initiate_auth(AuthFlow="USER_PASSWORD_AUTH", ClientId=os.environ["CLIENT_ID"], AuthParameters={
        "USERNAME": secret["username"], "PASSWORD": secret["password"]})["AuthenticationResult"]
    return 200, {key: result[key] for key in ("AccessToken", "RefreshToken", "ExpiresIn")}


def _is_demo(ctx, user: dict) -> bool:
    """Whether this is the shared demo account: its username is the one its secret names, read at runtime (no name
    is written here) and kept ten minutes, a minute when the secret could not be read. Only the username is taken
    from the secret; nothing of it is logged. A secret that cannot be read makes nobody the demo account."""
    if _demo.get("until", 0) <= time.time():
        name = None
        try:
            secret = json.loads(ads._sm(ctx).get_secret_value(SecretId=DEMO_SECRET)["SecretString"])
            name = secret.get("username") if isinstance(secret, dict) else None
        except Exception as e:  # noqa: BLE001 — no secret or no client (a test stack)
            print(f"demo account not known: {type(e).__name__}")
        name = name if isinstance(name, str) and name else None
        _demo.update(name=name, until=time.time() + (600 if name else 60))
    return bool(_demo.get("name")) and user.get("username") == _demo["name"]


def retry(ctx, user, body, session_id, job_id):
    _own_session(ctx, user, session_id)
    retried = jobs.retry_job(ctx, session_id, job_id)
    if retried is None:
        raise HttpError(400, "bad_request", "실패한 작업만 다시 시도할 수 있어요. 이 작업은 이미 다시 돌고 있거나 끝났어요.")
    return 200, {"retried": retried}


def _live(fn, ctx, user, body, session_id):
    session = _own_session(ctx, user, session_id)
    try:
        return 200, fn(ctx, session, body) if fn in (live.start, live.viewer) else fn(ctx, session)
    except live.LiveError as e:
        raise HttpError(e.status, e.code, e.message) from None


def live_start(ctx, user, body, session_id):
    _starts_work(ctx, user, session_id)
    return _live(live.start, ctx, user, body, session_id)


def live_status(ctx, user, body, session_id):
    return _live(live.status, ctx, user, body, session_id)


def live_round(ctx, user, body, session_id):
    session = _own_session(ctx, user, session_id)
    try:
        return 200, live.round_done(ctx, session, body)
    except live.LiveError as e:
        raise HttpError(e.status, e.code, e.message) from None


def live_beat(ctx, user, body, session_id):
    return _live(live.beat, ctx, user, body, session_id)


def live_stop(ctx, user, body, session_id):
    return _live(live.stop, ctx, user, body, session_id)


def live_viewer(ctx, user, body, session_id):
    return _live(live.viewer, ctx, user, body, session_id)


def live_standby(ctx, user, body, session_id):
    return _live(live.standby_status, ctx, user, body, session_id)


def live_standby_set(ctx, user, body, session_id):
    session = _own_session(ctx, user, session_id)
    try:
        return 200, live.standby_set(ctx, session, body)
    except live.LiveError as e:
        raise HttpError(e.status, e.code, e.message) from None


def _live_call(ctx, user, session_id, fn, *args):
    session = _own_session(ctx, user, session_id)
    try:
        return 200, fn(ctx, session, *args)
    except live.LiveError as e:
        raise HttpError(e.status, e.code, e.message) from None


def highlight_create(ctx, user, body, session_id):
    """A round ended: the cut from the IVS recording, Pegasus and ffmpeg run in a self-invoke (tens of seconds)."""
    _, hl = _live_call(ctx, user, session_id, live.highlight_create, body)
    ctx.lambda_.invoke(FunctionName=os.environ["SELF_FUNCTION_NAME"], InvocationType="Event",
                       Payload=json.dumps({"action": "highlight", "sessionId": session_id, "jobId": hl["jobId"], "id": hl["id"],
                                           "lang": i18n.lang()}))
    return 202, hl


def highlight_send(ctx, user, body, session_id, hid):
    return _live_call(ctx, user, session_id, live.highlight_send, hid, body)


def highlight_delete(ctx, user, body, session_id, hid):
    return _live_call(ctx, user, session_id, live.highlight_delete, hid)


def highlight_restore(ctx, user, body, session_id, hid):
    return _live_call(ctx, user, session_id, live.highlight_delete, hid, True)


def highlight_settings(ctx, user, body, session_id):
    return _live_call(ctx, user, session_id, live.highlight_settings, body)


def live_ad_settings(ctx, user, body, session_id):
    return _live_call(ctx, user, session_id, live.ad_settings, body)


def live_round_eta(ctx, user, body, session_id):
    return _live_call(ctx, user, session_id, live.round_eta, body)


def live_launcher_start(ctx, user, body, session_id):
    status, out = _live_call(ctx, user, session_id, live.launcher_start, body)
    return 202, out


def live_launcher_poll(ctx, user, body, session_id, launch_id):
    return _live_call(ctx, user, session_id, live.launcher_poll, launch_id)


def live_launcher_stop(ctx, user, body, session_id, launch_id):
    return _live_call(ctx, user, session_id, live.launcher_stop, launch_id)


def live_launcher_hint(ctx, user, body, session_id, launch_id):
    return _live_call(ctx, user, session_id, live.launcher_hint, launch_id, body)


def live_play(ctx, user, body, session_id):
    return _live_call(ctx, user, session_id, live.play, body)


def live_ad_event(ctx, user, body, session_id):
    return _live_call(ctx, user, session_id, live.ad_event, body)


def _ads(fn, *args):
    try:
        return 200, fn(*args)
    except ads.AdsError as e:
        raise HttpError(e.status, e.code, e.message) from None


def live_personas(ctx, user, body):
    """The viewer personas a watch window can play as (server/ads.py)."""
    return 200, {"personas": [{"personaId": p.get("personaId"), **{k: i18n.data(p.get(k)) for k in ("name", "genre", "profile")}}
                              for p in ads.personas(ctx)]}


def live_viewers(ctx, user, body):
    """The four dummy viewers: profile, the features GAM would get, the ad provider, and the latest activity: the
    seeded history and what this account's own broadcasts added (viewers.shown). Events recorded without an owner
    are the shared demo account's to read (_is_demo)."""
    import time as _time
    from server import adserver, viewers
    now = _time.time()
    unowned = _is_demo(ctx, user)
    out = []
    for v in viewers.ensure(ctx):
        events = viewers.log(ctx, v["viewerId"], now)
        out.append({**viewers.public(ctx, v, viewers.shown(events, user["sub"], unowned)),
                    "features": adserver.features(v, events, now), "provider": adserver.provider(v["viewerId"])})
    return 200, {"viewers": out}


def live_token(ctx, user, body):
    """A playback URL of the private live channel with a signed token for body.persona ("" = 기본), only for the
    account whose broadcast is on air. The refusal says when to ask again (retryAfterSec, live.token_retry)."""
    try:
        wait = live.token_retry(ctx, user["sub"])
    except live.LiveError as e:  # no live stack deployed
        raise HttpError(e.status, e.code, e.message) from None
    if wait is not None:
        raise HttpError(409, "not_live", tr(live.NO_TOKEN_TEXT), retryAfterSec=wait)
    return _ads(ads.playback, ctx, body.get("persona", ""))


def publish(ctx, user, body, session_id):
    session = _own_session(ctx, user, session_id)
    args = {"gameId": body.get("gameId"), "ad_asset_id": body.get("adAssetId"),
            "skip_after_sec": body.get("skipAfterSec"), "ad_every_rounds": body.get("adEveryRounds")}
    return 200, _tool_result(tools.run_tool(ctx, session, "publish_game", args))


def unpublish(ctx, user, body, session_id, game_id):
    """게시 내리기: the game leaves the published state (no address and no ad on its item, release.json as make_game
    first wrote it), so its page plays no ad and the ad server stops offering it. Its folder stays, since the
    studio's preview plays the same files. Owner only; the id is checked against this session before it names a key."""
    _own_session(ctx, user, session_id)
    if not any(g["gameId"] == game_id for g in store.snapshot(ctx, session_id)["games"]):
        raise HttpError(404, "not_found", "게임을 찾지 못했어요. 화면을 새로 고친 뒤 다시 해 주세요.")
    tools._put_json(ctx, f"games/{game_id}/release.json", {"publishedAt": None, "ad": None})
    store.update_game(ctx, session_id, game_id, publishedUrl=None, publishedAt=None, adAssetId=None)
    return 200, {"unpublished": game_id}



def _stream(fn, ctx, user, session_id, *args):
    session = _own_session(ctx, user, session_id)
    try:
        return fn(ctx, user, session, *args)
    except streams.StreamError as e:
        raise HttpError(e.status, e.code, e.message) from None
    except Exception as e:  # botocore ClientError from gameliftstreams
        err = _client_error(e, "지금은 클라우드 플레이 자리가 없어요. 잠시 뒤 다시 시도해 주세요.")
        if not err:
            raise
        raise err from None


def stream_start(ctx, user, body, session_id):
    return _stream(streams.start, ctx, user, session_id, body)


def stream_poll(ctx, user, body, session_id, stream_id):
    return _stream(streams.poll, ctx, user, session_id, stream_id)


def stream_reconnect(ctx, user, body, session_id, stream_id):
    return _stream(streams.reconnect, ctx, user, session_id, stream_id, body)


def _client_error(e, busy_text):
    """botocore ClientError → HttpError by kind (shared by the studio stream and the public ad routes). The sentences
    are for the user; the service's own word stays in the log."""
    code = getattr(e, "response", {}).get("Error", {}).get("Code")
    if not code:
        return None
    traceback.print_exc()
    if code == "ValidationException":
        return HttpError(400, "bad_request", "연결 정보가 올바르지 않아요. 페이지를 새로 고친 뒤 다시 해 주세요.")
    if code == "ResourceNotFoundException":
        return HttpError(404, "not_found", "연결이 이미 끝났어요. 다시 시작해 주세요.")
    if code in ("ServiceQuotaExceededException", "ThrottlingException", "ConflictException") or "Capacity" in code:
        return HttpError(503, "stream_" + code, busy_text)
    return HttpError(502, "stream_" + code, tr("클라우드 서버에 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요."))


def stream_stop(ctx, user, body, session_id, stream_id):
    return _stream(streams.terminate, ctx, user, session_id, stream_id)


def _ad(fn, *args):
    try:
        return fn(*args)
    except (playable.AdError, streams.StreamError) as e:
        raise HttpError(e.status, e.code, e.message) from None
    except Exception as e:  # botocore ClientError from gameliftstreams
        err = _client_error(e, "지금은 체험 자리가 없어요. 잠시 뒤 다시 시도해 주세요.")
        if not err:
            raise
        raise err from None


def playable_create(ctx, user, body, session_id):
    session = _own_session(ctx, user, session_id)
    return 201, _ad(playable.create, ctx, session, body)


def _agents(status, fn, *args):
    """/api/agents (server/agents.py): its AgentError → HttpError."""
    try:
        return status, fn(*args)
    except agents.AgentError as e:
        raise HttpError(e.status, e.code, e.message) from None


def agents_list(ctx, user, body):
    return _agents(200, agents.list_agents, ctx, user)


def _both(key, obj):
    """The contract writes the reply as {agent} / {proposal}: the object itself, also under that key."""
    return {**obj, key: obj}


def agents_create(ctx, user, body):
    status, agent = _agents(201, agents.create_agent, ctx, user, body)
    return status, _both("agent", agent)


def agents_patch(ctx, user, body, agent_id):
    status, agent = _agents(200, agents.patch_agent, ctx, user, agent_id, body)
    return status, _both("agent", agent)


def agents_delete(ctx, user, body, agent_id):
    return _agents(204, agents.delete_agent, ctx, user, agent_id)


def agents_run(ctx, user, body, agent_id):
    return _agents(202, agents.run_now, ctx, user, agent_id)


def agents_inbox(ctx, user, body):
    return _agents(200, agents.inbox, ctx, user)


def agents_proposal(ctx, user, body, proposal_id, action):
    fn = {"test": agents.test_proposal, "approve": agents.approve, "dismiss": agents.dismiss}[action]
    status, proposal = _agents(200 if action == "dismiss" else 202, fn, ctx, user, proposal_id)
    return status, _both("proposal", proposal)


# public (no login): the ad page anyone with the link opens
PUBLIC_ROUTES = [
    # the launcher page on a warm stream host asks for its instruction (its signed token is the only key)
    ("GET", r"/api/ads/launch/([A-Za-z0-9.]+)", lambda ctx, body, tok: (200, _ad(playable.launch_fetch, ctx, tok))),
    ("GET", r"/api/ads/(ad_[A-Za-z0-9]+)", lambda ctx, body, ad: (200, _ad(playable.public, ctx, ad))),
    ("POST", r"/api/ads/(ad_[A-Za-z0-9]+)/stream", lambda ctx, body, ad: (202, _ad(playable.start, ctx, ad, body))),
    ("GET", r"/api/ads/(ad_[A-Za-z0-9]+)/stream/([A-Za-z0-9_-]+)", lambda ctx, body, ad, sid: (200, _ad(playable.poll, ctx, ad, sid))),
    ("DELETE", r"/api/ads/(ad_[A-Za-z0-9]+)/stream/([A-Za-z0-9_-]+)", lambda ctx, body, ad, sid: (200, _ad(playable.stop, ctx, ad, sid))),
    ("POST", r"/api/ads/(ad_[A-Za-z0-9]+)/stream/([A-Za-z0-9_-]+)/play", lambda ctx, body, ad, sid: (200, _ad(playable.played, ctx, ad, sid))),
]

ROUTES = [
    ("GET", r"/api/sessions", list_sessions),
    ("POST", r"/api/sessions", create_session),
    ("GET", r"/api/sessions/([^/]+)", get_session),
    ("PATCH", r"/api/sessions/([^/]+)", patch_session),
    ("DELETE", r"/api/sessions/([^/]+)", delete_session),
    ("POST", r"/api/sessions/([^/]+)/chat", chat),
    ("POST", r"/api/sessions/([^/]+)/tools/([^/]+)/async", run_tool_async),
    ("POST", r"/api/sessions/([^/]+)/tools/([^/]+)", run_tool),
    ("POST", r"/api/sessions/([^/]+)/jobs/([^/]+)/retry", retry),
    ("POST", r"/api/sessions/([^/]+)/jobs/([^/]+)/cancel", cancel),
    ("GET", r"/api/connections", conn_list),
    ("POST", r"/api/connections", conn_add),
    ("PATCH", r"/api/connections/([^/]+)", conn_update),
    ("DELETE", r"/api/connections/([^/]+)", conn_remove),
    ("POST", r"/api/sessions/([^/]+)/live", live_start),
    ("POST", r"/api/sessions/([^/]+)/live/round", live_round),
    ("POST", r"/api/sessions/([^/]+)/live/highlights", highlight_create),
    ("POST", r"/api/sessions/([^/]+)/live/highlights/settings", highlight_settings),
    ("POST", r"/api/sessions/([^/]+)/live/highlights/([^/]+)/send", highlight_send),
    ("POST", r"/api/sessions/([^/]+)/live/highlights/([^/]+)/restore", highlight_restore),
    ("DELETE", r"/api/sessions/([^/]+)/live/highlights/([^/]+)", highlight_delete),
    ("GET", r"/api/sessions/([^/]+)/live", live_status),
    ("DELETE", r"/api/sessions/([^/]+)/live", live_stop),
    ("POST", r"/api/sessions/([^/]+)/live/beat", live_beat),
    ("POST", r"/api/sessions/([^/]+)/live/viewer", live_viewer),
    ("GET", r"/api/sessions/([^/]+)/live/standby", live_standby),
    ("POST", r"/api/sessions/([^/]+)/live/standby", live_standby_set),
    ("POST", r"/api/sessions/([^/]+)/live/ad", live_ad_settings),
    ("POST", r"/api/sessions/([^/]+)/live/round-eta", live_round_eta),
    ("POST", r"/api/sessions/([^/]+)/live/launcher", live_launcher_start),
    ("GET", r"/api/sessions/([^/]+)/live/launcher/([a-f0-9]+)", live_launcher_poll),
    ("DELETE", r"/api/sessions/([^/]+)/live/launcher/([a-f0-9]+)", live_launcher_stop),
    ("POST", r"/api/sessions/([^/]+)/live/launcher/([a-f0-9]+)/hint", live_launcher_hint),
    ("POST", r"/api/sessions/([^/]+)/live/play", live_play),
    ("POST", r"/api/sessions/([^/]+)/live/ad-event", live_ad_event),
    ("GET", r"/api/live/personas", live_personas),
    ("GET", r"/api/live/viewers", live_viewers),
    ("POST", r"/api/live/token", live_token),
    ("POST", r"/api/sessions/([^/]+)/publish", publish),
    ("DELETE", r"/api/sessions/([^/]+)/publish/([^/]+)", unpublish),
    ("POST", r"/api/sessions/([^/]+)/stream", stream_start),
    ("GET", r"/api/sessions/([^/]+)/stream/([^/]+)", stream_poll),
    ("POST", r"/api/sessions/([^/]+)/stream/([^/]+)/reconnect", stream_reconnect),
    ("POST", r"/api/sessions/([^/]+)/playable-ads", playable_create),
    ("DELETE", r"/api/sessions/([^/]+)/stream/([^/]+)", stream_stop),
    ("GET", r"/api/agents", agents_list),
    ("POST", r"/api/agents", agents_create),
    ("GET", r"/api/agents/inbox", agents_inbox),
    ("POST", r"/api/agents/proposals/([^/]+)/(test|approve|dismiss)", agents_proposal),
    ("PATCH", r"/api/agents/([^/]+)", agents_patch),
    ("DELETE", r"/api/agents/([^/]+)", agents_delete),
    ("POST", r"/api/agents/([^/]+)/run", agents_run),
]


def handler(event, context):
    ctx = _ctx()
    # The request's language, once (X-Lang: ko | en). An event that is no request carries the language of the request
    # that started it ("lang"), else starts in Korean
    i18n.use(i18n.from_event(event))
    if event.get("action") == "live_reap":  # EventBridge every 5 min (core_stack.py)
        return live.reap(ctx)
    if event.get("action") == "agent_turn":  # async self-invoke from POST /chat
        agent.run_turn(ctx, event["sessionId"], event["messageId"])
        return {"ok": True}
    if event.get("action") == "run_tool":  # async self-invoke from POST /tools/{name}/async
        run_tool_turn(ctx, event["sessionId"], event["tool"], event.get("args"), event["message"])
        return {"ok": True}
    if event.get("action") == "highlight":  # async self-invoke from POST /live/highlights
        live.highlight_run(ctx, event["sessionId"], event["jobId"], event["id"])
        return {"ok": True}
    if event.get("action") == "stream_end":  # async self-invoke from streams.end (a session still ACTIVATING)
        return streams.end_when_placed(ctx, event["group"], event["streamId"], event.get("round", 1))
    if event.get("action") == "agents_run":  # EventBridge Scheduler per agent, or POST /api/agents/{id}/run
        return agents.run_agent(ctx, event["sub"], event["agentId"], event.get("runId"))
    if event.get("action") == "agents_launch":  # async self-invoke from POST /api/agents/proposals/{id}/test
        return agents.run_launch(ctx, event["trialId"])
    if event.get("action") == "agents_sweep":  # EventBridge every 5 min (core_stack.py)
        return agents.sweep(ctx)
    if event.get("action") == "run_job":  # async self-invoke from advance_jobs (ffmpeg renders)
        jobs.run_job(ctx, event["sessionId"], event["jobId"])
        return {"ok": True}
    if event.get("action") == "jobs_tick":  # EventBridge Scheduler every minute (core_stack.py JobsAdvance)
        return jobs.advance_active(ctx)
    try:
        method = event["requestContext"]["http"]["method"]
        path = event.get("rawPath", "")
        if (method, path) == ("GET", "/api/health"):
            import botocore  # the runtime's SDK (newer service APIs come from server/aws_models)
            return _resp(200, {"ok": True, "botocore": botocore.__version__})
        if (method, path) == ("POST", "/api/signup"):  # before auth: the account does not exist yet
            return _resp(*signup(ctx, _body(event)))
        if (method, path) == ("POST", "/api/demo-login"):
            return _resp(*demo_login(ctx, _body(event)))
        if (method, path) == ("GET", "/api/ads/impression"):  # MediaTailor's impression beacon: no login
            return _resp(*_ads(ads.impression, ctx, event.get("queryStringParameters") or {}))
        for route_method, pattern, route in PUBLIC_ROUTES:  # playable ads: no login
            match = re.fullmatch(pattern, path)
            if match and route_method == method:
                return _resp(*route(ctx, _body(event), *match.groups()))
        if path.startswith("/api/ads/"):  # public namespace: a malformed ad id is not found, not unauthorized
            return _resp(404, {"error": "not_found", "message": tr(playable.NO_AD)})
        user = auth.user_from_event(ctx, event)
        if not user:
            return _resp(401, {"error": "unauthorized"})
        for route_method, pattern, route in ROUTES:
            match = re.fullmatch(pattern, path)
            if match and route_method == method:
                return _resp(*route(ctx, user, _body(event), *match.groups()))
        print(f"no route: {method} {path}")
        raise HttpError(404, "not_found", "요청한 기능을 찾지 못했어요. 화면을 새로 고친 뒤 다시 해 주세요.")
    except HttpError as e:
        return _resp(e.status, {"error": e.code, "message": e.message, **e.extra})
    except Exception:
        traceback.print_exc()  # details go to CloudWatch, not to the client
        return _resp(500, {"error": "internal", "message": tr("서버에서 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.")})
