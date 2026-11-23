"""Agent registration: the schedule forms the dialog shows (five-field cron in Korean time, the label's own words)
are taken, a refusal names the forms that are, an agent that cannot do its task (it can only search Hugging Face and
the web and post notes) is not registered, and the agent API's errors are plain Korean."""
import json
import pathlib
import re

import pytest
from botocore.exceptions import ClientError

from server import agents, store
from server.tests.test_agents import DEMO_USER, call, ctx, mcp  # noqa: F401 (fixtures)


def _agent(description="매주 월요일 9시에 게임 트렌드 알려줘"):
    status, agent = call("POST", "/api/agents", {"description": description})
    assert status == 201, agent
    return agent


# ── the schedule ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("typed,stored,label", [
    ("0 9 * * *", "cron(0 9 * * ? *)", "매일 09:00 KST"),  # the hint's own example
    ("30 8 * * 1-5", "cron(30 8 ? * MON-FRI *)", "평일 08:30 KST"),
    ("0 9 * * 1", "cron(0 9 ? * MON *)", "매주 월요일 09:00 KST"),
    ("0 9 * * 0", "cron(0 9 ? * SUN *)", "매주 일요일 09:00 KST"),
    ("0 9 * * 7", "cron(0 9 ? * SUN *)", "매주 일요일 09:00 KST"),
    ("0 10 * * 6,0", "cron(0 10 ? * SAT,SUN *)", "주말 10:00 KST"),
    ("0 9 * * mon,wed,fri", "cron(0 9 ? * MON,WED,FRI *)", "매주 월·수·금요일 09:00 KST"),
    ("0 9 1 * *", "cron(0 9 1 * ? *)", "매월 1일 09:00 KST"),
    ("  0   9 * * *  ", "cron(0 9 * * ? *)", "매일 09:00 KST"),
    ("cron(0 9 * * ? *)", "cron(0 9 * * ? *)", "매일 09:00 KST"),  # the stored form
    ("rate(3 hours)", "rate(3 hours)", "3시간마다"),
])
def test_a_five_field_cron_in_korean_time_is_taken(ctx, typed, stored, label):  # noqa: F811
    aid = _agent()["agentId"]
    status, patched = call("PATCH", f"/api/agents/{aid}", {"cron": typed})
    assert status == 200, patched
    assert (patched["cron"], patched["scheduleLabel"]) == (stored, label)
    sched = ctx.scheduler.schedules[agents.schedule_name("sub-demo", aid)]
    assert (sched["ScheduleExpression"], sched["ScheduleExpressionTimezone"]) == (stored, "Asia/Seoul")


@pytest.mark.parametrize("typed,stored", [
    ("매일 08:00 KST", "cron(0 8 * * ? *)"),  # what the hint prints after 지금:
    ("매일 오전 9시", "cron(0 9 * * ? *)"),  # ... and after 예:
    ("매일 09:00", "cron(0 9 * * ? *)"),
    ("매일 아침 9시에", "cron(0 9 * * ? *)"),  # the registration example's own words
    ("매일 오후 3시 30분", "cron(30 15 * * ? *)"),
    ("매일 저녁 7시", "cron(0 19 * * ? *)"),
    ("매일 밤 12시", "cron(0 0 * * ? *)"),
    ("매일 오후 12시", "cron(0 12 * * ? *)"),
    ("매일 9시 반", "cron(30 9 * * ? *)"),
    ("평일 09:00 KST", "cron(0 9 ? * MON-FRI *)"),
    ("주말 오후 2시", "cron(0 14 ? * SAT,SUN *)"),
    ("매주 월요일 09:00 KST", "cron(0 9 ? * MON *)"),
    ("매주 금요일 오후 6시", "cron(0 18 ? * FRI *)"),
    ("매주 월·수·금요일 09:00 KST", "cron(0 9 ? * MON,WED,FRI *)"),
    ("매월 1일 09:00 KST", "cron(0 9 1 * ? *)"),
    ("3시간마다", "rate(3 hours)"),
    ("1시간마다", "rate(1 hour)"),
    ("2일마다", "rate(2 days)"),
])
def test_the_words_the_dialog_shows_are_taken_back(typed, stored):
    assert agents.validate_cron(typed) == stored
    # whatever the label prints of a schedule can be typed again
    assert agents.validate_cron(agents.schedule_label(stored)) == stored


@pytest.mark.parametrize("typed", ["수동 실행", "수동", "", None, "   "])
def test_no_schedule_is_a_schedule_too(typed):
    assert agents.validate_cron(typed) is None
    assert agents.validate_cron(agents.schedule_label(None)) is None


@pytest.mark.parametrize("typed,says", [
    ("내일 아침", "매일 09:00"),  # no day it repeats on, no hour
    ("매일 아침", "매일 09:00"),
    ("0 9 1 * 1", "매일 09:00"),  # a day of the month and a weekday: cron's "either" is no schedule here
    ("0 25 * * *", "매일 09:00"),
    ("61 9 * * *", "매일 09:00"),
    ("0 9 * * 9", "매일 09:00"),
    ("매일 25시", "매일 09:00"),
    ("abc", "매일 09:00"),
    ("*/5 * * * *", "한 시간에 한 번"),  # more often than hourly (the cap on what a run costs)
    ("cron(*/5 * * * ? *)", "한 시간에 한 번"),
    ("rate(5 minutes)", "한 시간에 한 번"),
    ("30분마다", "한 시간에 한 번"),
])
def test_a_schedule_it_cannot_read_is_refused_with_the_forms_it_takes(ctx, typed, says):  # noqa: F811
    aid = _agent()["agentId"]
    status, body = call("PATCH", f"/api/agents/{aid}", {"cron": typed})
    assert status == 400 and body["error"] == "bad_schedule", body
    message = body["message"]
    assert says in message, message
    # what it takes, by example: the label's form, the hint's example, and how to run by hand only
    for form in ("매일 09:00", "평일 오전 9시", "매주 월요일 09:00", "3시간마다", "0 9 * * *", "수동 실행"):
        assert form in message, (form, message)
    assert "지원하지 않는 일정 식" not in message and "day-of-month" not in message and "?" not in message.replace("?)", "")
    assert re.search(r"(요|세요)\.$", message), message
    assert call("GET", "/api/agents")[1]["agents"][1]["cron"] == "cron(0 9 ? * MON *)"  # the agent keeps what it had


def test_a_schedule_eventbridge_itself_refuses_is_told_in_korean(ctx):  # noqa: F811
    aid = _agent()["agentId"]

    def refuse(**kw):
        raise ClientError({"Error": {"Code": "ValidationException", "Message": "Invalid Schedule Expression cron(0 9 31 2 ? *)."}}, "UpdateSchedule")
    ctx.scheduler.update_schedule = refuse
    status, body = call("PATCH", f"/api/agents/{aid}", {"cron": "cron(0 9 31 2 ? *)"})
    assert status == 400 and body["error"] == "bad_schedule"
    assert "Invalid" not in body["message"] and "매일 09:00" in body["message"]


# ── an agent that cannot do what it was asked ──────────────────────────────────

CANNOT = {"name": "아침 세션 수 확인", "cron": "cron(0 8 * * ? *)",
          "instructions": "매일 아침 사용자의 세션 수를 알린다. 단, 이 Agent는 Hugging Face와 웹 검색만 할 수 있어 세션 목록을 볼 수 없다.",
          "cannot": "스튜디오의 세션 목록은 볼 수 없어요."}


def test_an_agent_that_says_it_cannot_do_its_task_is_not_registered(ctx):  # noqa: F811
    ctx.bedrock_rt_east.spec = dict(CANNOT)
    call("GET", "/api/agents")  # the built-in scout and its schedule are there from the first look
    before = dict(ctx.scheduler.schedules)

    status, body = call("POST", "/api/agents", {"description": "매일 아침 내 세션 수를 알려줘"})

    assert status == 422 and body["error"] == "cannot_do", body
    message = body["message"]
    assert message.startswith("이 일은 지금 에이전트에게 맡길 수 없어요: 스튜디오의 세션 목록은 볼 수 없어요.")
    assert "Hugging Face" in message and "웹" in message and "받은 편지함" in message  # what an agent can do
    # ... by the inbox's own name on the page
    inbox = (pathlib.Path(__file__).resolve().parents[2] / "web/src/components/AgentInbox.tsx").read_text(encoding="utf-8")
    assert "받은 편지함" in inbox
    assert "다시 적어 주세요" in message
    # nothing was registered and nothing was scheduled: the dialog keeps the sentence for another try
    assert [a["agentId"] for a in call("GET", "/api/agents")[1]["agents"]] == [agents.SCOUT_ID]
    assert ctx.scheduler.schedules == before
    assert [i for i in store._query(ctx, "AGENT#sub-demo") if i["sk"] != agents.SCOUT_ID] == []


@pytest.mark.parametrize("cannot", [None, "", "   ", False])
def test_an_agent_that_can_is_registered_and_switched_on_as_before(ctx, cannot):  # noqa: F811
    ctx.bedrock_rt_east.spec = {**ctx.bedrock_rt_east.spec, "cannot": cannot}
    agent = _agent()
    assert (agent["name"], agent["cron"], agent["enabled"]) == ("주간 게임 트렌드", "cron(0 9 ? * MON *)", True)
    assert agents.schedule_name("sub-demo", agent["agentId"]) in ctx.scheduler.schedules


def test_the_draft_is_asked_whether_the_task_can_be_done(ctx):  # noqa: F811
    _agent()
    asked = ctx.bedrock_rt_east.calls[-1]
    schema = asked["toolConfig"]["tools"][0]["toolSpec"]["inputSchema"]["json"]
    assert "cannot" in schema["required"] and schema["properties"]["cannot"]["type"] == ["string", "null"]
    system = asked["system"][0]["text"]
    assert "cannot" in system and "Hugging Face" in system
    # the draft's own five-field or worded schedule is taken too
    ctx.bedrock_rt_east.spec = {"name": "아침 트렌드", "instructions": "매일 아침 트렌드를 알린다.", "cron": "0 9 * * *"}
    assert _agent("매일 아침 9시에 트렌드 알려줘")["cron"] == "cron(0 9 * * ? *)"


# ── the agent API's other texts ────────────────────────────────────────────────

def test_what_the_agent_api_refuses_it_says_in_plain_korean(ctx):  # noqa: F811
    aid = _agent()["agentId"]
    said = [call("POST", "/api/agents", {"description": ""})[1], call("POST", "/api/agents", {"description": "가" * 4001})[1],
            call("PATCH", f"/api/agents/{aid}", {"name": ""})[1], call("PATCH", f"/api/agents/{aid}", {"instructions": " "})[1],
            call("PATCH", f"/api/agents/{aid}", {"enabled": "yes"})[1], call("PATCH", "/api/agents/agt_none", {"name": "x"})[1],
            call("PATCH", f"/api/agents/{agents.SCOUT_ID}", {"name": "x"})[1], call("DELETE", f"/api/agents/{agents.SCOUT_ID}")[1]]
    for body in said:
        message = body["message"]
        assert re.search("[가-힣]", message) and re.search(r"(요|세요)\.?$", message), message
        for raw in ("description", "enabled", "instructions", "name", "true/false", "cron(", "합니다", "습니다"):
            assert raw not in message, (raw, message)
    assert "이름" in said[2]["message"] and "할 일" in said[3]["message"]


def test_a_run_that_fails_is_told_without_the_exception(ctx, monkeypatch):  # noqa: F811
    agent = _agent()

    def boom(*args):
        raise RuntimeError("ThrottlingException: Too many requests")
    monkeypatch.setattr(agents, "run_custom", boom)
    out = agents.run_agent(ctx, "sub-demo", agent["agentId"])
    assert out["status"] == "failed"
    assert "Throttling" not in out["summary"] and "RuntimeError" not in out["summary"]
    assert "지금 실행" in out["summary"] and out["summary"].endswith("주세요.")
    [listed] = [a for a in call("GET", "/api/agents")[1]["agents"] if a["agentId"] == agent["agentId"]]
    assert listed["lastRun"]["summary"] == out["summary"]
    assert json.dumps(listed, ensure_ascii=False).count("Throttling") == 0
