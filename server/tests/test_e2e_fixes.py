"""Regression tests for defects an end-to-end sweep found."""
import json

from server import agent, connections, gamespec, jobs, tools
from server.tests.test_city_contract import city_spec, invalid
from server.tests.test_gamespec import authored_spec
from server.tests.test_streams import call, ctx, gls  # noqa: F401 — fixtures


def test_f4_spec_text_with_a_stray_closing_brace_still_parses():
    spec = {"a": {"b": [1, 2]}}
    assert tools._parse_spec_text(json.dumps(spec)) == spec
    assert tools._parse_spec_text(json.dumps(spec) + "}") == spec
    assert tools._parse_spec_text('{"a": 1} trailing words') == '{"a": 1} trailing words'  # left for the validator


def test_gl5_a_malformed_ad_id_is_not_found_without_login(ctx):  # noqa: F811
    assert call("GET", "/api/ads/not-an-id", token="")[0] == 404


def test_rp6_a_platform_is_always_solid():
    spec = authored_spec()
    spec["world"]["entities"].append({"id": "altar", "kind": "platform", "x": 5, "z": 5, "height": .8, "solid": False})
    validated, errors = gamespec.validate_spec(spec)
    assert errors == [] and next(e for e in validated["world"]["entities"] if e["id"] == "altar")["solid"] is True


def test_f3_vehicle_goals_only_in_city_reach_stages():
    spec = city_spec()
    spec["mission"]["stages"][-1]["vehicle"] = True  # the city's reach stage
    assert gamespec.validate_spec(spec)[1] == []
    spec = authored_spec()
    spec["mission"]["stages"][-1]["vehicle"] = True  # not a city
    invalid(spec, "vehicle is only true")


def test_md3_gpu_capacity_shortage_is_transient():
    assert any(t in "clienterror: (insufficientinstancecapacity) when calling startinstances" for t in jobs.TRANSIENT)


def test_mm1_mcp_calls_get_a_longer_timeout_than_the_handshake(monkeypatch):
    seen = []
    monkeypatch.setattr(connections, "_open", lambda url, headers, deadline: None)
    monkeypatch.setattr(connections, "_rpc", lambda *a, **kw: seen.append(kw.get("timeout")) or ({"content": []}, None))
    connections.call_tool("https://x", {}, "t", {})
    assert connections.TIMEOUT_SEC < seen[0] <= connections.CALL_TIMEOUT_SEC
    import time
    connections.call_tool("https://x", {}, "t", {}, deadline=time.monotonic() + 30)  # bounded by the turn deadline
    assert seen[1] <= 30


def test_mm2_a_failed_mcp_call_says_so_in_the_tool_event():
    src = open(agent.__file__, encoding="utf-8").read()
    # the summary is built from the result, not only the tool name
    assert 'tr("{label} 실패: {why}", label=label, why=result.get("message") or result["error"])' in src


def test_history_tells_the_model_which_answers_used_tools():
    msgs = [{"messageId": "u1", "role": "user", "text": "위키 찾아줘"},
            {"messageId": "a1", "role": "assistant", "text": "GLTFLoader는 ...", "toolEvents": [{"summary": "MCP 도구: DeepWiki · ask"}]},
            {"messageId": "u2", "role": "user", "text": "안녕"}]
    turns = agent.history(msgs, "pending")
    assert turns[1]["content"][0]["text"].startswith("[이 답변에서 실제로 실행한 도구: MCP 도구: DeepWiki · ask]")


def test_the_history_marker_never_reaches_the_user():
    assert agent._strip_marker("[이 답변에서 실제로 실행한 도구: MCP 도구: W · ask]\nGLTFLoader는 …") == "GLTFLoader는 …"


def test_agent_tools_use_the_cached_list_without_a_handshake(monkeypatch):
    server = {"id": "mcp_abc123", "name": "W", "url": "https://x", "enabled": True,
              "toolDefs": [{"name": "ask", "description": "d", "inputSchema": {"type": "object", "properties": {}}}]}
    monkeypatch.setattr(connections, "_user_servers", lambda ctx, sub: [server])

    def no_handshake(*a, **k):
        raise AssertionError("no handshake on a chat turn")
    monkeypatch.setattr(connections, "list_tools", no_handshake)
    specs, routes = connections.agent_tools(None, "sub")
    assert [s["name"] for s in specs] == list(routes) and len(specs) == 1


def test_not_a_city_and_open_tracks_are_not_city_requests():
    from server.city_contract import is_city_request
    assert not is_city_request("도시가 아닌 붉은 사막 협곡의 트랙 레이스")
    assert is_city_request("밤의 도시 오픈월드")
