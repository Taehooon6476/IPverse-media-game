"""Job cancel, MCP connections (and their agent tools), instant sign-up, game revisions."""
import io
import json

import pytest

from server import app, connections, jobs, store, tools
from server.tests.conftest import FakeProvider, FakeS3, FakeTable, make_ctx

SID = "ses_test"
USER = {"sub": "sub-1", "username": "u"}


class FakeDeadline:
    def __init__(self):
        self.updates = []

    def update_job(self, **kw):
        self.updates.append(kw)


def test_cancel_stops_an_active_job_fails_its_dependents_and_cancels_deadline(monkeypatch):
    ctx = make_ctx(table=FakeTable(), deadline=FakeDeadline())
    render = FakeProvider("deadline")
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", render)
    a = jobs.create_job(ctx, SID, "turntable", "deadline", {"ipId": "ip_1"}, [])["jobId"]
    monkeypatch.setitem(jobs.PROVIDERS, "img3d", FakeProvider("img3d"))
    b = jobs.create_job(ctx, SID, "mesh3d", "img3d", {}, [a])["jobId"]
    jobs.advance_jobs(ctx, SID)  # a is submitted (externalId from the fake)
    assert store.get_job(ctx, SID, a)["status"] == "running"
    assert jobs.cancel_job(ctx, SID, a) is True
    job = store.get_job(ctx, SID, a)
    assert (job["status"], job["error"]) == ("failed", jobs.CANCELED)
    assert ctx.deadline.updates[0]["targetTaskRunStatus"] == "CANCELED"
    assert jobs.cancel_job(ctx, SID, a) is None  # not active any more
    jobs.advance_jobs(ctx, SID)
    assert store.get_job(ctx, SID, b)["error"] == jobs.DEP_FAILED
    assert jobs.retry_job(ctx, SID, a)  # a stopped job can be retried


def test_connections_add_list_toggle_remove_and_agent_tools(monkeypatch):
    ctx = make_ctx(table=FakeTable())
    calls = []
    monkeypatch.setattr(connections, "_safe_url", lambda url: url)
    monkeypatch.setattr(connections, "list_tools", lambda url, headers, budget=0: calls.append(headers) or [
        {"name": "search.notes", "description": "Search my notes", "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}}}}])
    monkeypatch.setattr(connections, "call_tool", lambda url, headers, name, args, deadline=None: {"result": f"{name}:{args['q']}"})
    monkeypatch.setattr(connections, "_check_platform", lambda ctx, c: {**c, "status": "connected"})

    added = connections.add(ctx, USER, {"name": "My Notes", "url": "https://mcp.example.com/mcp", "authValue": "Bearer s3cret"})
    assert added["toolCount"] == 1 and added["hasAuth"] and "authValue" not in added
    assert calls[0] == {"authorization": "Bearer s3cret"}
    listing = connections.listing(ctx, USER)
    assert [s["name"] for s in listing["servers"]] == ["My Notes"] and "authValue" not in listing["servers"][0]
    assert {c["id"] for c in listing["platform"]} >= {"imagegen", "videogen", "bedrock-pegasus"}
    assert all("keyParam" not in c for c in listing["platform"])
    assert connections.listing(ctx, {"sub": "other"})["servers"] == []  # per user

    specs, routes = connections.agent_tools(ctx, USER["sub"])
    name = specs[0]["name"]
    assert name.startswith("mcp_") and "." not in name and specs[0]["inputSchema"]["json"]["properties"]["q"]
    assert connections.run_agent_tool(routes[name], {"q": "boss"}) == {"result": "search.notes:boss"}

    connections.update(ctx, USER, added["id"], {"enabled": False})
    assert connections.agent_tools(ctx, USER["sub"]) == ([], {})
    with pytest.raises(connections.ConnError):
        connections.add(ctx, USER, {"name": "", "url": "https://x"})
    connections.remove(ctx, USER, added["id"])
    assert connections.listing(ctx, USER)["servers"] == []


def test_safe_url_rejects_plain_http_and_private_addresses():
    for url in ("http://example.com/mcp", "https://127.0.0.1/mcp", "https://169.254.169.254/latest", "ftp://x"):
        with pytest.raises(connections.ConnError):
            connections._safe_url(url)


class FakeCognito:
    class exceptions:
        class UsernameExistsException(Exception):
            pass

        class InvalidPasswordException(Exception):
            pass

    def __init__(self):
        self.users, self.passwords = set(), {}

    def admin_create_user(self, UserPoolId, Username, MessageAction):
        if Username in self.users:
            raise self.exceptions.UsernameExistsException()
        self.users.add(Username)

    def admin_set_user_password(self, UserPoolId, Username, Password, Permanent):
        if not any(c.isupper() for c in Password):
            raise self.exceptions.InvalidPasswordException()
        self.passwords[Username] = (Password, Permanent)

    def admin_delete_user(self, UserPoolId, Username):
        self.users.discard(Username)


def test_signup_creates_a_confirmed_user_or_explains_why_not(monkeypatch):
    monkeypatch.setenv("USER_POOL_ID", "pool-1")
    ctx = make_ctx(table=FakeTable(), cognito=FakeCognito())
    assert app.signup(ctx, {"username": "neo_1", "password": "Abcdefgh123!"}) == (201, {"username": "neo_1"})
    assert ctx.cognito.passwords["neo_1"] == ("Abcdefgh123!", True)
    for body, code in (({"username": "neo_1", "password": "Abcdefgh123!"}, 409),
                       ({"username": "x", "password": "Abcdefgh123!"}, 400),
                       ({"username": "weak", "password": "abcdefgh123!"}, 400)):
        with pytest.raises(app.HttpError) as e:
            app.signup(ctx, body)
        assert e.value.status == code
    assert "weak" not in ctx.cognito.users  # a rejected password leaves no half-made user


def test_get_game_spec_drops_resolved_urls_and_make_game_links_the_revision():
    ctx = make_ctx(table=FakeTable(), s3=FakeS3())
    session = store.put_session(ctx, "sub-1", "t", "sf-shooter")
    sid = session["sessionId"]
    store.put_game(ctx, sid, {"gameId": "gm_1", "title": "G", "genre": "sf-shooter", "specKey": "games/gm_1/spec.json", "previewUrl": "x"})
    ctx.s3._store[(ctx.assets_bucket, "games/gm_1/spec.json")] = json.dumps(
        {"title": "G", "player": {"ipId": "ip_1", "modelUrl": "a.glb", "speed": 5}, "enemies": [{"spriteUrl": "e.png", "hp": 2}]}).encode()
    out = tools.get_game_spec(ctx, session, {"gameId": "gm_1"})
    assert out["spec"] == {"title": "G", "player": {"ipId": "ip_1", "speed": 5}, "enemies": [{"hp": 2}]}
    assert "error" in tools.get_game_spec(ctx, session, {"gameId": "gm_nope"})
    assert "get_game_spec" in tools.TOOLS and any(s["name"] == "get_game_spec" for s in tools.TOOL_SPECS)


def test_demo_login_hands_out_the_demo_account_tokens_and_never_its_password(monkeypatch):
    """The 데모 로그인 button: the password stays in Secrets Manager (ipverse/demo-user), the browser gets tokens only."""
    monkeypatch.setenv("CLIENT_ID", "client-1")
    calls = []

    class Secrets:
        def get_secret_value(self, SecretId):
            assert SecretId == "ipverse/demo-user"
            return {"SecretString": '{"username": "demo", "password": "S3cret-pass-word!"}'}

    class Cognito:
        def initiate_auth(self, **kw):
            calls.append(kw)
            return {"AuthenticationResult": {"AccessToken": "a", "RefreshToken": "r", "ExpiresIn": 3600, "IdToken": "i"}}

    ctx = make_ctx(table=FakeTable(), cognito=Cognito())
    ctx.secretsmanager = Secrets()
    assert app.demo_login(ctx, {}) == (200, {"AccessToken": "a", "RefreshToken": "r", "ExpiresIn": 3600})
    assert calls == [{"AuthFlow": "USER_PASSWORD_AUTH", "ClientId": "client-1",
                      "AuthParameters": {"USERNAME": "demo", "PASSWORD": "S3cret-pass-word!"}}]
