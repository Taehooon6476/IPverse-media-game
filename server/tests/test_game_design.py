"""The user selection remains authoritative even when model output changes roles."""
import copy
import json

import pytest

from server import agent, app, auth, game_design, store, tools
from server.tests.conftest import FakeBedrockRT, FakeCognito, FakeLambda, FakeS3, FakeTable, make_ctx


IPS = {
    "hero": {"ipId": "hero", "kind": "character"},
    "prop": {"ipId": "prop", "kind": "prop"},
    "gun": {"ipId": "gun", "kind": "weapon"},
    "enemy": {"ipId": "enemy", "kind": "enemy"},
    "npc": {"ipId": "npc", "kind": "character"},
}
REQUEST = {
    "prompt": "[게임 설계]\n밤의 도시에서 코어를 회수하고 정비사에게 전달한다",
    "castIpIds": ["hero", "prop", "gun", "enemy", "npc"],
    "playerIpId": "hero", "weaponIpId": "gun",
    "propIpIds": ["prop"], "enemyIpIds": ["enemy"], "npcIpIds": ["npc"],
}


def test_selection_is_validated_against_owned_session_and_unique_roles():
    original = copy.deepcopy(REQUEST)
    assert game_design.validate_design(REQUEST, IPS, REQUEST["prompt"]) == (REQUEST, [])
    assert original == REQUEST
    for patch in (
        {"playerIpId": "someone-elses-ip"},
        {"playerIpId": "prop"},
        {"weaponIpId": "prop"},
        {"enemyIpIds": ["hero", "enemy"]},
        {"propIpIds": ["prop", "prop"]},
        {"castIpIds": ["hero"]},
        {"prompt": "invented request"},
    ):
        value, errors = game_design.validate_design({**REQUEST, **patch}, IPS, REQUEST["prompt"])
        assert value is None and errors, patch


def test_role_validation_rejects_substitutions_and_conflicting_enemy_cast():
    spec = {"player": {"ipId": "hero", "weaponIpId": "gun"},
            "props": [{"ipId": "prop"}, {"ipId": "npc"}], "enemies": [{"ipId": "enemy"}],
            "world": {"npc": {"propIndex": 1}}}
    assert game_design.role_errors(spec, REQUEST) == []
    wrong = copy.deepcopy(spec)
    wrong["player"]["ipId"] = "npc"
    wrong["enemies"].append({"ipId": "hero"})
    assert len(game_design.role_errors(wrong, REQUEST)) == 2
    wrong = copy.deepcopy(spec)
    wrong["world"]["npc"]["propIndex"] = 0
    assert "npcIpIds" in game_design.role_errors(wrong, REQUEST)[0]


def test_design_only_applies_to_its_current_turn():
    messages = [
        {"messageId": "u1", "role": "user", "text": REQUEST["prompt"], "gameDesign": REQUEST},
        {"messageId": "a1", "role": "assistant", "text": ""},
        {"messageId": "u2", "role": "user", "text": "영상 만들어줘"},
        {"messageId": "a2", "role": "assistant", "text": ""},
    ]
    assert game_design.for_turn(messages, "a1") == REQUEST
    assert game_design.for_turn(messages, "a2") is None
    messages[2]["text"] = "[출연 IP cast_ip_ids=hero,prop] 제나와 코어로 게임 만들기"
    assert game_design.for_turn(messages, "a2")["castIpIds"] == ["hero", "prop"]


def test_chat_stores_exact_design_and_rejects_other_session_ips(monkeypatch):
    ctx = make_ctx(table=FakeTable(), s3=FakeS3(), lambda_=FakeLambda(),
                   cognito=FakeCognito({"token": ("user-1", "demo")}))
    monkeypatch.setattr(app, "CTX", ctx)
    monkeypatch.setattr(auth, "_CACHE", {})
    monkeypatch.setenv("SELF_FUNCTION_NAME", "ipverse-api")
    session = store.put_session(ctx, "user-1")
    for ip in IPS.values():
        store.put_ip(ctx, session["sessionId"], ip)
    event = {"requestContext": {"http": {"method": "POST"}},
             "rawPath": f"/api/sessions/{session['sessionId']}/chat",
             "headers": {"x-auth-token": "token"},
             "body": json.dumps({"text": REQUEST["prompt"], "gameDesign": REQUEST})}
    assert app.handler(event, None)["statusCode"] == 202
    messages = store.snapshot(ctx, session["sessionId"])["messages"]
    assert messages[0]["gameDesign"] == REQUEST
    before = len(messages)
    bad = {**REQUEST, "playerIpId": "foreign-ip"}
    event["body"] = json.dumps({"text": REQUEST["prompt"], "gameDesign": bad})
    assert app.handler(event, None)["statusCode"] == 400
    assert len(store.snapshot(ctx, session["sessionId"])["messages"]) == before


def test_agent_supplies_original_selection_even_if_model_changes_cast(monkeypatch):
    uses = {"stopReason": "tool_use", "output": {"message": {"role": "assistant", "content": [
        {"toolUse": {"name": "make_game", "toolUseId": "tu", "input": {
            "cast_ip_ids": ["foreign"], "spec": {"version": 2}}}}]}}}
    final = {"stopReason": "end_turn", "output": {"message": {"role": "assistant", "content": [
        {"text": "완료"}]}}}
    bedrock = FakeBedrockRT([uses, final])
    ctx = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_east=bedrock)
    session = store.put_session(ctx, "user-1")
    user = store.put_message(ctx, session["sessionId"], "user", REQUEST["prompt"], "done",
                             ts="2026-11-01T14:00:00.000Z")
    store.update_message(ctx, session["sessionId"], user, gameDesign=REQUEST)
    pending = store.put_message(ctx, session["sessionId"], "assistant", "", "pending",
                                ts="2026-11-01T14:00:00.001Z")
    captured = []
    def run_tool(c, s, name, args, **kwargs):
        captured.append(args)
        return {"gameId": "test"}
    monkeypatch.setattr(tools, "run_tool", run_tool)
    agent.run_turn(ctx, session["sessionId"], pending["messageId"])
    assert captured[0]["cast_ip_ids"] == REQUEST["castIpIds"]
    assert captured[0]["_game_design"] == REQUEST
    assert captured[0]["_source_prompt"] == REQUEST["prompt"]
    assert bedrock.calls[0]["inferenceConfig"]["maxTokens"] == 32000
