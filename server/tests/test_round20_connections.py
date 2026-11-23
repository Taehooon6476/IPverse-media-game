"""GET /api/connections shows no backend detail (addresses, farm and model ids, tool schemas): a platform row is its
plain name and state, plus the dropdowns' models for the two generation services. A user's own MCP servers still
show what the user typed in. Fakes only."""
import json

import pytest

from server import app, auth, connections
from server.providers import mcp_client, mediagen_video
from server.tests.conftest import FakeCognito, FakeTable, make_ctx

USER = {"sub": "user-demo", "username": "demo"}
IMAGE_URL = "https://77fmd8ppzh.execute-api.us-east-1.amazonaws.com/mcp"
VIDEO_URL = "https://v2hgkct6d2.execute-api.us-east-1.amazonaws.com/mcp"
FARM = "farm-7e90f6ad8b8d4a99a614f5e0db148f36"
INGEST = "0123456789ab.global-contribute.live-video.net"
AGENT_MODEL = "global.anthropic.claude-sonnet-5-5"
TOOLS = [{"name": "list_models", "description": "d", "inputSchema": {"type": "object", "properties": {"x": {}}}},
         {"name": "start_image", "description": "d", "inputSchema": {"type": "object", "properties": {}}},
         {"name": "ltx_start_video", "description": "d", "inputSchema": {"type": "object", "properties": {}}}]
# backend words the answer must not carry
BACKEND = ("execute-api", "https://", "amazonaws", "farm-", "live-video.net", "global-contribute", AGENT_MODEL,
           "anthropic", "twelvelabs", "pegasus-1-5", "bedrock-runtime", "us-east-1", "us-west-2", "start_image",
           "ltx_start_video", "list_models", "toolDefs", "inputSchema", "toolCount", "endpoint", "keyParam", "api-key",
           "detail", "configured")
SERVICE_NAMES = ("Amazon", "AWS", "Bedrock", "IVS", "MediaTailor", "GameLift", "Deadline", "MCP", "Pegasus")


@pytest.fixture
def ctx(monkeypatch):
    monkeypatch.setenv("DEADLINE_FARM_ID", FARM)
    monkeypatch.setenv("LIVE_IVS_INGEST", INGEST)
    monkeypatch.setenv("AGENT_MODEL_ID", AGENT_MODEL)
    monkeypatch.setattr(mcp_client, "IMAGE", mcp_client.Endpoint(IMAGE_URL, "/storyboard-mcp/api-key"))
    monkeypatch.setattr(mcp_client, "VIDEO", mcp_client.Endpoint(VIDEO_URL, "/mediagen/mcp-api-key"))
    monkeypatch.setattr(connections, "list_tools", lambda url, headers, budget=None: list(TOOLS))
    monkeypatch.setattr(mediagen_video, "catalog", lambda c: {"live": True, "models": [
        {"id": "ltx", "label": "LTX-2.5", "kinds": ["i2v", "t2v"], "status": "ready", "promoted": False}]})
    monkeypatch.setattr(connections, "image_catalog", lambda c: {"live": True, "models": [
        {"id": "klein9", "label": "FLUX.2 klein 9B", "kinds": ["t2i", "i2i"]}, {"id": "krea", "label": "Krea 2 Turbo", "kinds": ["t2i"]}]})
    return make_ctx(table=FakeTable())


def test_a_platform_row_is_a_plain_name_and_a_state(ctx):
    platform = connections.listing(ctx, USER)["platform"]
    assert [c["id"] for c in platform] == ["imagegen", "videogen", "bedrock-agent", "bedrock-image", "bedrock-pegasus",
                                           "deadline", "live"]  # the ids the page looks rows up by stay
    for c in platform:
        assert set(c) <= {"id", "name", "status", "models"}, c
        assert c["status"] == "connected" and c["name"]
        assert not any(word in c["name"] for word in SERVICE_NAMES), c["name"]
    text = json.dumps(platform, ensure_ascii=False)
    assert [word for word in BACKEND if word in text] == []
    assert {c["id"]: c["name"] for c in platform} == {
        "imagegen": "이미지 생성", "videogen": "영상 생성", "bedrock-agent": "채팅 에이전트",
        "bedrock-image": "배경 제거 · Stable Image 생성", "bedrock-pegasus": "라이브 하이라이트",
        "deadline": "3D 렌더", "live": "라이브 방송"}


def test_the_model_dropdowns_still_get_their_lists(ctx):
    by_id = {c["id"]: c for c in connections.listing(ctx, USER)["platform"]}
    assert by_id["videogen"]["models"] == [{"id": "ltx", "label": "LTX-2.5", "kinds": ["i2v", "t2v"], "status": "ready",
                                            "promoted": False}]
    assert by_id["imagegen"]["models"] == [{"id": "klein9", "label": "FLUX.2 klein 9B"}, {"id": "krea", "label": "Krea 2 Turbo"}]
    assert all("models" not in c for cid, c in by_id.items() if cid not in ("imagegen", "videogen"))


def test_a_service_that_does_not_answer_says_so_without_its_address(ctx, monkeypatch, capsys):
    def down(url, headers, budget=None):
        raise RuntimeError(f"연결 실패: <urlopen error [Errno 8] nodename nor servname provided: {url}>")
    monkeypatch.setattr(connections, "list_tools", down)
    by_id = {c["id"]: c for c in connections.listing(ctx, USER)["platform"]}
    for cid in ("imagegen", "videogen"):
        assert by_id[cid]["status"] == "error" and set(by_id[cid]) == {"id", "name", "status", "error"}
        assert by_id[cid]["error"] == connections.NO_ANSWER and "execute-api" not in by_id[cid]["error"]
    assert "execute-api" in capsys.readouterr().err  # the reason is in the server's log, for whoever runs it


def test_a_service_that_is_not_set_up_reads_off(ctx, monkeypatch):
    monkeypatch.delenv("DEADLINE_FARM_ID")
    monkeypatch.delenv("LIVE_IVS_INGEST")
    by_id = {c["id"]: c for c in connections.listing(ctx, USER)["platform"]}
    assert by_id["deadline"] == {"id": "deadline", "name": "3D 렌더", "status": "off"}
    assert by_id["live"] == {"id": "live", "name": "라이브 방송", "status": "off"}
    assert "미설정" not in json.dumps(by_id, ensure_ascii=False) and "미배포" not in json.dumps(by_id, ensure_ascii=False)


def test_before_the_check_a_row_is_its_name_alone(ctx):
    platform = connections.listing(ctx, USER, live=False)["platform"]
    assert all(set(c) == {"id", "name", "status"} and c["status"] == "unknown" for c in platform)


def test_a_users_own_server_still_shows_what_the_user_typed(ctx, monkeypatch):
    monkeypatch.setattr(connections, "_safe_url", lambda url: url)
    added = connections.add(ctx, USER, {"name": "내 노트", "url": "https://mcp.example.com/mcp", "authValue": "Bearer s3cret"})
    [mine] = connections.listing(ctx, USER)["servers"]
    assert mine["url"] == "https://mcp.example.com/mcp" and mine["tools"] == ["list_models", "start_image", "ltx_start_video"]
    assert mine["id"] == added["id"] and mine["hasAuth"] and "authValue" not in mine and "toolDefs" not in mine
    assert connections.listing(ctx, {"sub": "someone-else"})["servers"] == []


def test_the_route_answers_the_demo_account_the_same_plain_rows(ctx, monkeypatch):
    ctx.cognito = FakeCognito({"demo-token": ("user-demo", "demo")})
    monkeypatch.setattr(app, "CTX", ctx)
    monkeypatch.setattr(auth, "_CACHE", {})
    resp = app.handler({"requestContext": {"http": {"method": "GET"}}, "rawPath": "/api/connections",
                        "headers": {"x-auth-token": "demo-token"}, "isBase64Encoded": False, "body": None}, None)
    assert resp["statusCode"] == 200
    assert [word for word in BACKEND if word in resp["body"]] == []
    body = json.loads(resp["body"])
    assert len(body["platform"]) == 7 and body["servers"] == []
