"""Studio details: (1) an edit check that judges against what was asked, and a fresh redraw beside the edit;
(2) wait estimates of what will actually run; (3) the studio's own words in replies; (7) a job's finish time taken
from its provider, not from the poll that notices it."""
import inspect
import json
from datetime import datetime, timezone

from server import agent, agents, jobs, prompts, store, tools, waits
from server.providers import bedrock_image, mediagen_image as mi
from server.tests.conftest import FakeBedrockRT, make_ctx
from server.tests.test_klein_edit_check import KNIGHT, PNG, _run, _snap, box, ctx, session, verdict, vision  # noqa: F401
from server.tests.test_round12_klein import QWEN, qwen  # noqa: F401

MOON = "a huge pale full moon centered directly behind the beetle, larger than the beetle's body"
BEETLE = "a spiked armored beetle with a glossy black carapace and long curved horns"
BEETLE_MOON = BEETLE + ", a huge pale full moon directly behind it, larger than its body"


def _check(change, **answer):
    reply = {"output": {"message": {"content": [{"text": json.dumps(
        {"reference_head_covered": False, "face_appeared": False, "background_changed": False, "style_changed": False,
         "other_changes": "", "other_minor": True, **answer}, ensure_ascii=False)}]}}}
    rt = FakeBedrockRT([reply])
    return bedrock_image.edit_check(make_ctx(bedrock_rt_quick=rt), PNG + b"a", PNG + b"b", change), rt


def _beetle(ctx, session):  # noqa: F811
    made = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "enemy", "humanoid": False, "name": "가시 딱정벌레",
                                                            "description": BEETLE})
    _run(ctx, session)
    return made["ipId"]


# 1a: the edit check judges against what was asked


def test_1_a_backdrop_change_the_request_names_does_not_fail_the_edit_check():
    out, rt = _check(MOON, background_changed=True, background_asked=True)  # the moon now fills the backdrop
    assert out["ok"] is True and out["backgroundChanged"] is False and out["backgroundAsked"] is True, out
    assert out["problem"] == ""
    out, _ = _check("a navy blue cloak instead of brown", background_changed=True)  # nobody asked for a landscape
    assert out["ok"] is False and out["problem"] == "요청하지 않은 배경 변경"
    out, _ = _check("redraw it as a watercolor painting", style_changed=True, style_asked=True)
    assert out["ok"] is True and out["styleChanged"] is False
    out, _ = _check(MOON, style_changed=True, background_asked=True)  # asked for the backdrop, not for another style
    assert out["ok"] is False and "화풍" in out["problem"]
    question = rt.calls[0]["messages"][0]["content"][-1]["text"]  # the judge is told what counts as asked
    assert "background_asked" in question and "style_asked" in question and "does not ask for" in question


def test_1_an_edit_that_asks_for_the_backdrop_lands_as_the_ips_picture(ctx, session, box, vision):  # noqa: F811
    vision._responses[:] = [verdict(covered=False, background_changed=True, background_asked=True)]
    ip_id = _beetle(ctx, session)
    out = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": ip_id, "prompt": MOON})
    _run(ctx, session, 6)
    snap = _snap(ctx, session)
    job = next(j for j in snap["jobs"] if j["jobId"] == out["jobId"])
    ip = next(i for i in snap["ips"] if i["ipId"] == ip_id)
    assert ip["version"] == 2 and not job.get("error") and not job.get("redraws"), job


def test_1_a_redraw_of_an_asked_backdrop_does_not_take_the_backdrop_back():
    """The composition check can still send such an edit back for one more draw (a subject cut at the frame edge):
    that draw holds to the reference's style, not to the plain background the user asked to change."""
    edit = tools.edit_prompt("가시 딱정벌레", MOON, "creature")
    job = {"jobId": "job_1", "pk": "SESSION#s", "redraws": 1, "redrawFor": ["composition", "backgroundAsked"],
           "input": {"model": "klein9", "prompt": edit, "references": ["sessions/s/v1.png"], "subject": "object",
                     "edit": MOON}}
    sent = mi._redraw_prompt(job)
    assert mi.KEEP_STYLE in sent and mi.KEEP_HARDER not in sent and "background" not in sent.split(edit[:-1])[1]
    assert mi.KEEP_HARDER in mi._redraw_prompt({**job, "redrawFor": ["composition"]})  # any other edit


# 1b: "새로 다시 그려줘" is a fresh draw, not an edit


def _spec_of(name):
    return next(t for t in tools.TOOL_SPECS if t["name"] == name)


def test_1_the_agent_has_a_fresh_redraw_and_is_told_when_to_use_it():
    assert "reroll_ip_image" not in tools.UI_ONLY_TOOLS  # the agent can redraw, not only edit
    spec = _spec_of("reroll_ip_image")
    assert set(spec["inputSchema"]["json"]["properties"]) == {"ipId", "description"}
    assert spec["inputSchema"]["json"]["required"] == ["ipId"]
    [rule] = [line for line in prompts.SYSTEM.splitlines() if line.startswith("- reroll_ip_image:")]
    assert "새로 다시 그려줘" in rule and "make_ip_variant" in rule and "description" in rule
    [edit] = [line for line in prompts.SYSTEM.splitlines() if line.startswith("- make_ip_variant:")]
    assert "reroll_ip_image" in edit  # the edit's own rule sends a redraw request away
    assert "reroll_ip_image" in _spec_of("make_ip_variant")["description"]


def test_1_a_redraw_with_a_new_look_is_a_text_draw_with_no_reference_and_no_edit_check(ctx, session, box, vision):  # noqa: F811
    ip_id = _beetle(ctx, session)
    sid = session["sessionId"]
    out = tools.run_tool(ctx, session, "reroll_ip_image", {"ipId": ip_id, "description": BEETLE_MOON})
    sent = store.get_job(ctx, sid, out["jobId"])["input"]
    assert out["version"] == 2 and sent["model"] == "krea" and sent["references"] == [] and "edit" not in sent
    assert "a huge pale full moon directly behind it" in sent["prompt"]
    _run(ctx, session, 6)
    snap = _snap(ctx, session)
    ip = next(i for i in snap["ips"] if i["ipId"] == ip_id)
    assets = {a["assetId"]: a for a in snap["assets"]}
    assert ip["version"] == 2 and not vision.calls  # nothing to compare a fresh draw with
    assert tools.current_description(ip, assets) == BEETLE_MOON  # shots of this version are told the moon
    again = tools.run_tool(ctx, session, "reroll_ip_image", {"ipId": ip_id})  # the card's 다시 뽑기 keeps that look
    assert "a huge pale full moon directly behind it" in store.get_job(ctx, sid, again["jobId"])["input"]["prompt"]


def test_1_a_redraw_of_an_edited_picture_starts_from_no_picture(ctx, session, box, vision):  # noqa: F811
    vision._responses[:] = [verdict(covered=False)]
    ip_id = _beetle(ctx, session)
    tools.run_tool(ctx, session, "make_ip_variant", {"ipId": ip_id, "prompt": "a red carapace instead of black"})
    _run(ctx, session, 6)
    sid = session["sessionId"]
    assert next(i for i in _snap(ctx, session)["ips"] if i["ipId"] == ip_id)["version"] == 2  # a klein edit of v1
    out = tools.run_tool(ctx, session, "reroll_ip_image", {"ipId": ip_id, "description": BEETLE_MOON})
    sent = store.get_job(ctx, sid, out["jobId"])["input"]
    assert sent["model"] == "krea" and sent["references"] == [] and "edit" not in sent and "covered" not in sent
    assert sent["description"] == BEETLE_MOON and "Change only that" not in sent["prompt"]
    same = tools.run_tool(ctx, session, "reroll_ip_image", {"ipId": ip_id})  # (refused: v3 is being drawn)
    assert same["error"] == "image_pending"


# 2: the estimate is of what will run: a 3D chain without a pose and a rig is shorter than the hero's, and an edit
# on a box that is already up has no boot to wait for


def test_2_a_3d_without_a_pose_and_a_rig_is_told_its_own_total(ctx, session, box):  # noqa: F811
    assert (waits.TOTAL, waits.TOTAL_UNRIGGED) == ("9–21분", "6–15분")  # 2–8 + 4–7: the mesh and the turntable
    lantern = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "prop", "name": "등불", "description": "a lantern"})
    hero = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "character", "name": "세린", "description": "a girl"})
    _run(ctx, session)
    assert tools.run_tool(ctx, session, "render_3d", {"ipId": lantern["ipId"]})["typical"] == "3D 회전 영상까지 전체 보통 6–15분"
    assert tools.run_tool(ctx, session, "render_3d", {"ipId": _beetle(ctx, session)})["typical"].endswith("6–15분")
    assert tools.run_tool(ctx, session, "render_3d", {"ipId": hero["ipId"]})["typical"] == "3D 회전 영상까지 전체 보통 9–21분"
    # the copy the agent reads ahead of a result names both chains, and the rule sends it to the result's figure
    assert waits.TOTAL in waits.RENDER_3D and waits.TOTAL_UNRIGGED in waits.RENDER_3D
    assert waits.RENDER_3D in prompts.SYSTEM and waits.RENDER_3D in _spec_of("render_3d")["description"]
    assert "결과의 typical" in prompts.SYSTEM
    [more] = [line for line in prompts.SYSTEM.splitlines() if "더 만들 IP 3–8개" in line]
    assert waits.TOTAL_UNRIGGED in more and waits.TOTAL in more  # the IPs it proposes: props and enemies too


class _Ec2:
    """describe_instances of the promoted boxes (server/agents.py promoted_boxes): Qwen's box in one state."""

    def __init__(self, state):
        self.state = state

    def describe_instances(self, Filters):
        return {"Reservations": [{"Instances": [{"InstanceId": "i-1", "State": {"Name": self.state}, "Tags": [
            {"Key": "mediagen", "Value": QWEN}, {"Key": "mediagen-label", "Value": "Qwen-Image 2.1"},
            {"Key": "mediagen-kinds", "Value": "t2i,i2i"}]}]}]}


def _plume(ctx, session, state):  # noqa: F811
    """The plume edit of the closed-helm knight, with Qwen's box in `state` (None: EC2 does not answer)."""
    ctx.ec2 = _Ec2(state) if state else None
    made = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "character", "name": "바론", "description": KNIGHT})
    _run(ctx, session)
    out = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": made["ipId"], "prompt": "a red plume on the helmet"})
    return out, store.get_job(ctx, session["sessionId"], out["jobId"])["input"]


def test_2_an_edit_on_a_box_that_is_already_up_is_not_told_its_boot(ctx, session, box, qwen):  # noqa: F811
    out, sent = _plume(ctx, session, "running")
    assert sent["model"] == QWEN and out["etaMinutes"] == 1 and "etaMinutes" not in sent  # the card: 보통 20초–3분
    assert "약 1분 뒤" in out["message"] and "켜져 있어" in out["message"]
    assert "켜는 시간" not in out["message"] and "11분" not in out["message"]


def test_2_an_edit_on_a_stopped_box_keeps_the_one_eta_with_its_boot(ctx, session, box, qwen):  # noqa: F811
    out, sent = _plume(ctx, session, "stopped")
    eta = waits.PROMOTED_BOOT_MIN + 1
    assert out["etaMinutes"] == sent["etaMinutes"] == eta
    assert f"정지돼 있어 켜는 시간(~{waits.PROMOTED_BOOT_MIN}분)을 포함해 약 {eta}분 뒤" in out["message"]


def test_2_an_edit_on_a_box_in_an_unknown_state_is_told_both_ends(ctx, session, box, qwen):  # noqa: F811
    out, sent = _plume(ctx, session, None)
    eta = waits.PROMOTED_BOOT_MIN + 1
    assert out["etaMinutes"] == sent["etaMinutes"] == eta  # the card keeps the longer one until a line says which
    assert f"켜져 있으면 약 1분, 정지돼 있으면 켜는 시간(~{waits.PROMOTED_BOOT_MIN}분)을 포함해 약 {eta}분 뒤" in out["message"]
    [rule] = [line for line in prompts.SYSTEM.splitlines() if line.startswith("- make_ip_variant:")]
    assert "결과 message" in rule and "켜져 있으면" in rule  # the reply says the message's figure, a range when it is one


# 3: replies use the studio's words, not the prompt's own (description, turntable, GPU 박스, tool names)


def test_3_a_reply_says_the_studios_words_for_the_prompts_own():
    said = agent.humanize_tools
    assert said("세 카드의 다시 뽑기를 쓰거나 description을 바꿔 새로 그리면") == "세 카드의 다시 뽑기를 쓰거나 묘사를 바꿔 새로 그리면"
    assert said("세린은 지금 turntable 렌더 중입니다") == "세린은 지금 3D 회전 영상 렌더 중입니다"
    assert said("GPU 박스를 켜는 시간까지 합쳐 약 11분입니다") == "GPU 서버를 켜는 시간까지 합쳐 약 11분입니다"
    assert said("3D 회전 영상(turntable)이 끝나면") == "3D 회전 영상이 끝나면"  # said once where the reply said both


def test_3_the_wording_rule_names_those_words_and_no_copy_teaches_them():
    [rule] = [line for line in prompts.SYSTEM.splitlines() if "화면의 말로 말한다" in line]  # the one wording rule
    for word, studio in (("description", "묘사"), ("turntable", "3D 회전 영상"), ("GPU 박스", "GPU 서버")):
        assert word in rule and studio in rule, word
    assert "호출" in rule and "게임 요청을 보류해 두었어요" in rule  # what was done, not which tool was called
    # the copy the agent repeats does not say them itself
    assert "description을 바꾼 새 그림" not in prompts.SYSTEM
    for text in (prompts.SYSTEM.replace(rule, ""), inspect.getsource(agents.prompt_block),
                 waits.promoted_image_wait("Qwen", 1, 30, None)):
        assert "GPU 박스" not in text and "정지된 박스" not in text, text[:120]


# 7: a job's time is its provider's, not the poll's: a session nobody polls notices a finished job minutes late


def _ago(sec) -> str:
    return store.now(-sec * 1000)


class _Farm:
    """A provider whose job ended `ended_sec_ago` before the poll that notices it."""
    name = "deadline"

    def __init__(self, ended, state="done"):
        self.ended, self.state = ended, state

    def status(self, job, ctx):
        job["_ended"] = self.ended  # in memory only, like _began
        return (self.state, "" if self.state == "done" else "FAILED")

    def collect(self, job, ctx):
        return []


def _turntable(ctx, session, monkeypatch, ended, state="done"):  # noqa: F811
    """The hero's turntable, sent 13:05 ago, polled again only now. → the job as stored after that poll."""
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", _Farm(ended, state))
    sid = session["sessionId"]
    job = jobs.create_job(ctx, sid, "render3d", "deadline", {"ipId": "ip_1", "glbKey": "k.glb"}, [])
    store.update_job(ctx, sid, job["jobId"], status="running", externalId="dl-1", createdAt=_ago(785), startedAt=_ago(785))
    jobs.advance_jobs(ctx, sid)
    return store.get_job(ctx, sid, job["jobId"])


def _work_sec(job) -> float:
    """작업, as the card counts it (web/src/types.ts jobTimes)."""
    at = lambda ts: datetime.fromisoformat(ts.replace("Z", "+00:00"))  # noqa: E731
    return (at(job.get("finishedAt") or job["updatedAt"]) - at(job["startedAt"])).total_seconds()


def test_7_a_job_noticed_late_ends_when_its_provider_says_it_ended(ctx, session, monkeypatch):  # noqa: F811
    ended = _ago(418)  # the farm's endedAt: 6:07 after the send, 6:58 before this poll
    job = _turntable(ctx, session, monkeypatch, ended)
    assert job["status"] == "done" and job["finishedAt"] == ended
    assert round(_work_sec(job)) == 367  # 작업 6:07, not the 13:05 until the poll
    state = json.loads(agent.state_summary(_snap(ctx, session)))
    assert state["jobs"][0]["finishedAt"] == agent.kst(ended)  # the agent says that time too
    failed = _turntable(ctx, session, monkeypatch, ended, "failed")
    assert failed["status"] == "failed" and failed["finishedAt"] == ended


def test_7_a_finish_time_outside_the_jobs_own_run_is_not_believed(ctx, session, monkeypatch):  # noqa: F811
    for ended in (_ago(-60), _ago(900), None, "soon"):  # ahead of now, before its start, none, no time at all
        job = _turntable(ctx, session, monkeypatch, ended)
        assert job["status"] == "done" and not job.get("finishedAt"), ended
        assert round(_work_sec(job)) == 785  # counted until the poll
    assert jobs.RESET["finishedAt"] == ""  # 다시 시도 forgets the last run's end


def test_7_the_farm_and_the_mesh_box_say_when_they_ended():
    from server.providers.deadline import DeadlineProvider
    from server.providers.img3d import Img3dProvider
    from server.tests import test_img3d
    from server.tests.conftest import FakeDeadline
    farm = FakeDeadline()
    farm._job_responses["dl-1"] = {"taskRunStatus": "SUCCEEDED", "lifecycleStatus": "CREATE_COMPLETE",
                                   "endedAt": datetime(2026, 11, 12, 1, 41, 57, 250000, tzinfo=timezone.utc)}
    job = {"jobId": "job_t", "pk": "SESSION#s", "externalId": "dl-1", "input": {}}
    assert DeadlineProvider().status(job, make_ctx(deadline=farm)) == ("done", "")
    assert jobs._finished_at({**job, "createdAt": "2026-11-12T01:35:50.000Z"}) == "2026-11-12T01:41:57.250Z"
    box = test_img3d.ctx.__wrapped__()  # the mesh worker's last status.json write is its end (worker.py put_status)
    mesh = test_img3d._job()
    test_img3d._status(box, status="done", seconds=120, updatedAt="2026-11-12T01:39:50Z")
    assert Img3dProvider().status(mesh, box) == ("done", "") and mesh["_ended"] == "2026-11-12T01:39:50Z"
