import json

import pytest

from server import agent, app, auth, jobs, store
from server.tests.conftest import FakeCognito, FakeLambda, FakeProvider, FakeS3, FakeTable, make_ctx

TOKEN = "good-token"


@pytest.fixture
def ctx(monkeypatch):
    c = make_ctx(table=FakeTable(), s3=FakeS3(), lambda_=FakeLambda(),
                 cognito=FakeCognito({TOKEN: ("user-1", "demo"), "other-token": ("user-2", "other")}))
    monkeypatch.setattr(app, "CTX", c)
    monkeypatch.setattr(auth, "_CACHE", {})
    monkeypatch.setenv("SELF_FUNCTION_NAME", "ipverse-api")
    return c


def call(method, path, body=None, token=TOKEN, header="x-auth-token"):
    event = {"requestContext": {"http": {"method": method}}, "rawPath": path,
             "headers": {header: token} if token else {}, "isBase64Encoded": False,
             "body": None if body is None else json.dumps(body)}
    resp = app.handler(event, None)
    assert resp["headers"] == {"content-type": "application/json"}
    return resp["statusCode"], json.loads(resp["body"])


def _new_session(**body):
    status, data = call("POST", "/api/sessions", body)
    assert status == 201
    return data["session"]["sessionId"]


def test_app_health_no_auth(ctx):
    status, body = call("GET", "/api/health", token=None)
    assert status == 200 and body["ok"] is True and body["botocore"]  # the runtime SDK, for the shipped models
    assert ctx.cognito.calls == 0


def test_app_rejects_missing_token(ctx):
    assert call("GET", "/api/sessions", token=None) == (401, {"error": "unauthorized"})
    assert call("GET", "/api/sessions", token="expired-token") == (401, {"error": "unauthorized"})


def test_app_chat_returns_202_and_self_invokes(ctx):
    status, data = call("POST", "/api/sessions", {"title": "루나", "genre": "sf-shooter"}, header="X-Auth-Token")
    assert status == 201 and data["session"]["title"] == "루나"
    sid = data["session"]["sessionId"]

    status, data = call("POST", f"/api/sessions/{sid}/chat", {"text": "컨셉 잡아줘"})

    assert status == 202
    [invoke] = ctx.lambda_.calls
    assert (invoke["FunctionName"], invoke["InvocationType"]) == ("ipverse-api", "Event")
    assert json.loads(invoke["Payload"]) == {"action": "agent_turn", "sessionId": sid, "messageId": data["messageId"],
                                             "lang": "ko"}  # the language of the request that started the turn
    messages = store.snapshot(ctx, sid)["messages"]
    assert [(m["role"], m["status"], m["text"]) for m in messages] == [
        ("user", "done", "컨셉 잡아줘"), ("assistant", "pending", "")]
    assert messages[1]["messageId"] == data["messageId"]
    assert ctx.cognito.calls == 1  # token cached across requests
    assert call("POST", f"/api/sessions/{sid}/chat", {"text": "  "})[0] == 400


def test_app_chat_fails_the_reply_when_self_invoke_raises(ctx, monkeypatch):
    sid = _new_session()

    def boom(**kwargs):
        raise RuntimeError("TooManyRequestsException on Invoke")

    monkeypatch.setattr(ctx.lambda_, "invoke", boom)

    status, data = call("POST", f"/api/sessions/{sid}/chat", {"text": "컨셉 잡아줘"})

    assert status == 202
    reply = store.snapshot(ctx, sid)["messages"][1]
    assert reply["messageId"] == data["messageId"]
    assert (reply["status"], reply["text"]) == ("failed", "요청을 시작하지 못했어요. 다시 보내 주세요.")

def test_app_dispatches_async_actions(ctx, monkeypatch):
    seen = []
    monkeypatch.setattr(agent, "run_turn", lambda c, sid, mid: seen.append(("agent_turn", c, sid, mid)))
    monkeypatch.setattr(jobs, "run_job", lambda c, sid, jid: seen.append(("run_job", c, sid, jid)))
    app.handler({"action": "agent_turn", "sessionId": "ses_1", "messageId": "msg_1"}, None)
    app.handler({"action": "run_job", "sessionId": "ses_1", "jobId": "job_1"}, None)
    assert seen == [("agent_turn", ctx, "ses_1", "msg_1"), ("run_job", ctx, "ses_1", "job_1")]


def test_app_500_does_not_echo_the_exception(ctx, monkeypatch):
    def boom(*args):
        raise RuntimeError("arn:aws:dynamodb:us-east-1:087967639890:table/ipverse-main exploded")

    monkeypatch.setattr(store, "list_sessions", boom)
    assert call("GET", "/api/sessions") == (500, {"error": "internal", "message": "서버에서 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요."})


def test_app_get_session_advances_jobs(ctx, monkeypatch):
    deadline = FakeProvider("deadline")
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", deadline)
    sid = _new_session()
    jobs.create_job(ctx, sid, "render3d", "deadline", {"ipId": "ip_1"}, [])

    status, snap = call("GET", f"/api/sessions/{sid}")

    assert status == 200
    # gameHeroes: who can be a game's hero by the server's rule, said as the session is read
    assert set(snap) == {"session", "messages", "ips", "assets", "jobs", "games", "gameHeroes"}
    assert snap["jobs"][0]["status"] == "running" and len(deadline.submitted) == 1
    assert call("GET", "/api/sessions/ses_missing")[0] == 404


def test_app_hides_other_users_sessions(ctx):
    sid = _new_session(title="내 세션")
    assert call("GET", f"/api/sessions/{sid}", token="other-token")[0] == 404
    assert call("GET", "/api/sessions", token="other-token") == (200, {"sessions": []})
    status, data = call("GET", "/api/sessions")
    assert status == 200 and [s["sessionId"] for s in data["sessions"]] == [sid]


def test_app_patch_tools_and_publish_routes(ctx):
    sid = _new_session()
    status, snap = call("PATCH", f"/api/sessions/{sid}", {"genre": "rpg-quest", "title": "새 제목"})
    assert status == 200 and (snap["session"]["genre"], snap["session"]["title"]) == ("rpg-quest", "새 제목")
    assert call("GET", "/api/sessions")[1]["sessions"][0]["genre"] == "rpg-quest"  # list index follows
    assert call("PATCH", f"/api/sessions/{sid}", {"genre": "moba"})[0] == 400

    concept = {"title": "T", "logline": "L", "style": "S", "palette": ["#000000", "#111111", "#222222"],
               "genre": "rpg-quest"}
    status, data = call("POST", f"/api/sessions/{sid}/tools/set_concept", concept)
    assert status == 200 and data["result"]["palette"] == concept["palette"]
    assert call("POST", f"/api/sessions/{sid}/tools/hack_the_planet", {})[0] == 404
    assert call("POST", f"/api/sessions/{sid}/tools/render_3d", {"ipId": "ip_x"})[0] == 404

    store.put_game(ctx, sid, {"gameId": "gm_1", "title": "G", "genre": "rpg-quest", "specKey": "games/gm_1/spec.json",
                              "previewUrl": "https://cdn.example.com/games/gm_1/index.html"})
    ad = store.put_asset(ctx, sid, {"kind": "shorts", "key": "sessions/s/x.mp4", "contentType": "video/mp4"})
    status, data = call("POST", f"/api/sessions/{sid}/publish",
                        {"gameId": "gm_1", "adAssetId": ad["assetId"], "skipAfterSec": 3})
    assert (status, data) == (200, {"publishedUrl": "https://cdn.example.com/games/gm_1/index.html"})
    release = json.loads(ctx.s3._store[("test-assets", "games/gm_1/release.json")])
    assert release["ad"] == {"videoUrl": ad["url"], "skipAfterSec": 3}
