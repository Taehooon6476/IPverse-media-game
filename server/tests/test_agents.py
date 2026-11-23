"""스킬 · Agent 등록 (server/agents.py): agents, the open-model scout, GPU trials and promoted models. Fake EC2,
Scheduler, Bedrock, S3, the MCP proxies and the Hugging Face API: no network."""
import json
import re
from datetime import datetime, timedelta, timezone

import pytest
from botocore.exceptions import ClientError

from server import agent as chat_agent
from server import agents, app, auth, connections, jobs, store, tools
from server.providers import mcp_client, mediagen_image as mi, mediagen_video as mv
from server.tests.conftest import FakeCognito, FakeLambda, FakeS3, FakeTable, make_ctx
from server.tests.test_cutout import figure, png_rgba

DEMO, OTHER = "demo-token", "other-token"
NOW = datetime.now(timezone.utc)


def iso(days_ago=0):
    return (NOW - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _err(code):
    return ClientError({"Error": {"Code": code, "Message": code}}, "op")


class FakeScheduler:
    def __init__(self):
        self.schedules, self.calls = {}, []

    def update_schedule(self, **kw):
        self.calls.append(("update", kw["Name"]))
        if kw["Name"] not in self.schedules:
            raise _err("ResourceNotFoundException")
        self.schedules[kw["Name"]] = kw

    def create_schedule(self, **kw):
        self.calls.append(("create", kw["Name"]))
        self.schedules[kw["Name"]] = kw

    def delete_schedule(self, Name, GroupName):
        self.calls.append(("delete", Name))
        if Name not in self.schedules:
            raise _err("ResourceNotFoundException")
        del self.schedules[Name]


class FakeEc2:
    """Records calls; describe_* answer from `instances` ({id: {"state", "tags"}})."""

    def __init__(self):
        self.calls, self.instances, self.dry = [], {}, set()

    def describe_subnets(self, **kw):
        return {"Subnets": [{"SubnetId": "subnet-a"}, {"SubnetId": "subnet-b"}]}

    def run_instances(self, **kw):
        self.calls.append(("run_instances", kw))
        if (kw["InstanceType"], kw["SubnetId"]) in self.dry or kw["InstanceType"] in self.dry:
            raise _err("InsufficientInstanceCapacity")
        iid = f"i-{len(self.instances) + 1:04d}"
        tags = {t["Key"]: t["Value"] for t in kw["TagSpecifications"][0]["Tags"]}
        self.instances[iid] = {"state": "running", "tags": tags}
        return {"Instances": [{"InstanceId": iid}]}

    def describe_instances(self, **kw):
        rows = []
        for iid, i in self.instances.items():
            if "InstanceIds" in kw and iid not in kw["InstanceIds"]:
                continue
            if "Filters" in kw and i["tags"].get("mediagen-promoted") != "true":
                continue
            rows.append({"InstanceId": iid, "State": {"Name": i["state"]},
                         "Tags": [{"Key": k, "Value": v} for k, v in i["tags"].items()]})
        return {"Reservations": [{"Instances": rows}] if rows else []}

    replace_fails = False  # a just-parked box: EC2 calls the association inactive (IncorrectState)

    def describe_iam_instance_profile_associations(self, **kw):
        return {"IamInstanceProfileAssociations": [
            {"AssociationId": "iip-assoc-1", "IamInstanceProfile": {"Arn": "arn:aws:iam::1:instance-profile/trial"}}]}

    def replace_iam_instance_profile_association(self, **kw):
        self.calls.append(("replace_iam_instance_profile_association", kw))
        if self.replace_fails:
            from botocore.exceptions import ClientError
            raise ClientError({"Error": {"Code": "IncorrectState", "Message": "not the active association"}},
                              "ReplaceIamInstanceProfileAssociation")
        return {}

    def stop_instances(self, InstanceIds):
        self.calls.append(("stop_instances", {"InstanceIds": InstanceIds}))
        for iid in InstanceIds:
            self.instances[iid]["state"] = "stopped"

    def terminate_instances(self, InstanceIds):
        self.calls.append(("terminate_instances", {"InstanceIds": InstanceIds}))
        for iid in InstanceIds:
            self.instances[iid]["state"] = "terminated"

    def create_tags(self, Resources, Tags):
        self.calls.append(("create_tags", {"Resources": Resources, "Tags": Tags}))
        for iid in Resources:
            self.instances[iid]["tags"].update({t["Key"]: t["Value"] for t in Tags})

    def __getattr__(self, name):
        def call(**kw):
            self.calls.append((name, kw))
            return {}
        return call

    def names(self):
        return [n for n, _ in self.calls]


class FakeBedrock:
    """converse() by the one structured tool offered: agent_spec (a draft), propose (the scout's ranking); else `loop` replies."""

    def __init__(self):
        self.spec = {"name": "주간 게임 트렌드", "instructions": "매주 월요일 게임 트렌드를 조사해 알린다.",
                     "cron": "cron(0 9 ? * MON *)"}
        self.proposals, self.loop, self.calls = [], [], []

    def converse(self, **kw):
        self.calls.append(kw)
        # the live agent model refuses forced tool choice ("type tool and any are not supported")
        assert set(((kw.get("toolConfig") or {}).get("toolChoice") or {"auto": {}})) <= {"auto"}
        tools = [t["toolSpec"]["name"] for t in (kw.get("toolConfig") or {}).get("tools", []) if "toolSpec" in t]
        forced = tools[0] if tools and tools[0] in ("agent_spec", "propose") else None  # the one-tool structured calls
        if forced == "agent_spec":
            content = [{"toolUse": {"toolUseId": "t1", "name": "agent_spec", "input": self.spec}}]
        elif forced == "propose":
            content = [{"toolUse": {"toolUseId": "t1", "name": "propose",
                                    "input": {"proposals": self.proposals, "summary": "나머지는 기준 모델보다 낫지 않음"}}}]
        else:
            content = self.loop.pop(0) if self.loop else [{"text": "끝"}]
        return {"output": {"message": {"role": "assistant", "content": content}}, "stopReason": "end_turn"}


def hf_model(repo, pipeline="text-to-image", license="apache-2.0", created=10, likes=300, library="diffusers",
             params=12e9, tags=(), trending=50.0):
    return {"id": repo, "pipeline_tag": pipeline, "likes": likes, "trendingScore": trending, "createdAt": iso(created),
            "lastModified": iso(created), "library_name": library, "tags": [f"license:{license}", *tags],
            "cardData": {"license": license}, **({"safetensors": {"total": params}} if params else {})}


HUB = {
    "text-to-image": [
        hf_model("acme/Pixel-Image-2"),  # passes: apache, recent, diffusers, 12B
        hf_model("acme/Pixel-Image-2-GGUF", library="gguf"),  # a quantized re-upload
        hf_model("old/Legacy-Diffusion", created=900),  # not recent
        hf_model("closed/Secret-Image", license="unknown"),  # no open license
        hf_model("black-forest-labs/FLUX.2-klein-9B"),  # a baseline
        hf_model("nc/Artsy-Image", license="flux-1-dev-non-commercial-license"),  # open, non-commercial
        hf_model("giant/Huge-Image", params=30e9),  # does not fit one L40S
        hf_model("code/Ref-Image", library="custom"),  # reference code in its card
        hf_model("nocode/Bare-Image", library="custom"),  # no inference path
    ],
    "image-to-image": [hf_model("acme/Pixel-Image-2", pipeline="image-to-image")],
    "text-to-video": [hf_model("vid/Motion-5", pipeline="text-to-video", params=14e9),
                      hf_model("Lightricks/LTX-2.5", pipeline="text-to-video")],
    "image-to-video": [],
}
CARDS = {"code/Ref-Image": "## Inference\n```\ngit clone https://github.com/code/ref-image\npython generate.py\n```"}


def fake_http(url, timeout=20, accept="application/json"):
    if url.startswith("https://huggingface.co/api/models?"):
        pipeline = re.search(r"pipeline_tag=([\w-]+)", url).group(1)
        return json.dumps(HUB[pipeline]).encode()
    repo = re.match(r"https://huggingface.co/(.+)/raw/main/README.md", url)
    if repo:
        return CARDS.get(repo.group(1), "# model card").encode()
    raise AssertionError(f"unexpected fetch {url}")


class FakeMCP:
    """mcp_client._post for both proxies: the image MCP (list_models, start_image, get_image_status) and the videogen
    MCP (list_video_models, list_image_models, image_start, image_get_status, ltx_start_video, ltx_get_status)."""

    def __init__(self):
        self.calls, self.image_models, self.video_models = [], [], []
        self.status = {}  # job id -> status reply

    def __call__(self, url, body, key):
        if body.get("method") == "tools/list":
            out = {"tools": [{"name": "video_start", "inputSchema": {"properties": {"model": {}, "prompt": {}}}},
                             {"name": "ltx_start_video", "inputSchema": {"properties": {"prompt": {}, "height": {}}}}]}
            return {"jsonrpc": "2.0", "id": 1, "result": out}
        name, args = body["params"]["name"], body["params"]["arguments"]
        where = "image" if url == mcp_client.IMAGE.url else "video"
        self.calls.append((where, name, args))
        if name == "list_models":
            out = {"models": [{"id": "klein9", "label": "FLUX.2 klein 9B"}, {"id": "krea", "label": "Krea 2 Turbo"}]}
        elif name == "list_image_models":
            out = {"models": self.image_models}
        elif name == "list_video_models":
            out = {"models": self.video_models}
        elif name == "ltx_list_tasks":
            out = {"tasks": []}
        elif name in ("start_image", "image_start", "ltx_start_video"):
            job = f"{name}-{len(self.calls)}"
            self.status[job] = {"status": "SUCCEEDED" if name != "image_start" else "done",
                                "url": f"https://out.example/{job}.{'mp4' if 'ltx' in name else 'png'}"}
            out = {"job_id": job}
        else:
            out = self.status[args["job_id"]]
        return {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": json.dumps(out)}]}}

    def named(self, name):
        return [a for _, n, a in self.calls if n == name]


@pytest.fixture
def mcp(monkeypatch):
    fake = FakeMCP()
    monkeypatch.setattr(mcp_client, "_post", fake)
    monkeypatch.setattr(mcp_client, "download", lambda url: b"\x89PNG-" + url.encode())
    monkeypatch.setattr(connections, "_image_catalog", {})
    monkeypatch.setattr(mv, "_catalog", {})
    return fake


@pytest.fixture
def ctx(monkeypatch, mcp):
    c = make_ctx(table=FakeTable(), s3=FakeS3(), lambda_=FakeLambda(), ec2=FakeEc2(), scheduler=FakeScheduler(),
                 bedrock_rt_east=FakeBedrock(),
                 cognito=FakeCognito({DEMO: ("sub-demo", "demo"), OTHER: ("sub-other", "other")}))
    c.ec2_launch = c.ec2
    monkeypatch.setattr(app, "CTX", c)
    monkeypatch.setattr(auth, "_CACHE", {})
    monkeypatch.setattr(agents, "http_get", fake_http)
    monkeypatch.setattr(agents, "_demo_seeded", set())
    for k, v in {"SELF_FUNCTION_NAME": "ipverse-api", "AGENTS_SCHEDULER_ROLE_ARN": "arn:aws:iam::1:role/sched",
                 "TRIAL_SECURITY_GROUP": "sg-trial", "TRIAL_INSTANCE_PROFILE_ARN": "arn:aws:iam::1:instance-profile/t",
                 "SCOUT_DEFAULT_USERS": "demo"}.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("WEBSEARCH_GATEWAY_URL", raising=False)
    return c


def call(method, path, body=None, token=DEMO):
    event = {"requestContext": {"http": {"method": method}}, "rawPath": path, "headers": {"x-auth-token": token},
             "isBase64Encoded": False, "body": None if body is None else json.dumps(body)}
    resp = app.handler(event, None)
    return resp["statusCode"], (json.loads(resp["body"]) if resp["body"] else None)


DEMO_USER = {"sub": "sub-demo", "username": "demo"}


def _proposal(ctx, kind="image", status="proposed", repo="acme/Pixel-Image-2", label="Pixel Image 2", **extra):
    pid = store.new_id("prop")
    note = agents.put_note(ctx, "sub-demo", {"agentId": agents.SCOUT_ID, "name": agents.SCOUT_NAME}, "모델 제안", "…", pid)
    store._put(ctx, "AGENTPROP#sub-demo", pid, {
        "proposalId": pid, "noteId": note["noteId"], "kind": kind, "hfRepo": repo, "label": label,
        "license": "apache-2.0", "commercialOk": True, "vramGb": 28, "instance": "g6e.2xlarge" if kind == "image"
        else "g6e.4xlarge", "why": "더 낫다", "risks": "-", "status": status, "slug": agents.promoted_slug(label),
        "editCapable": True, **extra})
    return pid


# ── agents API ─────────────────────────────────────────────────────────────────


def test_the_builtin_scout_is_seeded_daily_0800_kst_and_enabled_for_the_demo_user_only(ctx):
    status, body = call("GET", "/api/agents")
    assert status == 200
    [scout] = body["agents"]
    assert (scout["agentId"], scout["name"], scout["builtin"], scout["enabled"]) == (
        "open-model-scout", "오픈웨이트 모델 스카우트", True, True)
    assert (scout["cron"], scout["scheduleLabel"], scout["lastRun"]) == ("cron(0 8 * * ? *)", "매일 08:00 KST", None)
    [sched] = ctx.scheduler.schedules.values()
    assert sched["ScheduleExpressionTimezone"] == "Asia/Seoul" and sched["GroupName"] == "ipverse-agents"
    assert json.loads(sched["Target"]["Input"]) == {"action": "agents_run", "sub": "sub-demo", "agentId": "open-model-scout"}
    assert sched["Target"]["Arn"].endswith(":function:ipverse-api")
    _, other = call("GET", "/api/agents", token=OTHER)
    assert other["agents"][0]["enabled"] is False and len(ctx.scheduler.schedules) == 1


def test_sweep_seeds_the_demo_users_scout_before_anyone_opens_the_page(ctx, monkeypatch):
    monkeypatch.setenv("USER_POOL_ID", "pool-1")
    ctx.cognito.admin_get_user = lambda UserPoolId, Username: {
        "Username": Username, "UserAttributes": [{"Name": "sub", "Value": "sub-demo"}]}
    agents.sweep(ctx)
    assert store._get(ctx, "AGENT#sub-demo", agents.SCOUT_ID)["enabled"] is True and ctx.scheduler.schedules


def test_create_from_natural_language_patch_run_and_delete(ctx):
    status, agent = call("POST", "/api/agents", {"description": "매주 월요일 9시에 게임 트렌드 알려줘"})
    assert status == 201
    assert (agent["name"], agent["cron"], agent["scheduleLabel"], agent["builtin"], agent["enabled"]) == (
        "주간 게임 트렌드", "cron(0 9 ? * MON *)", "매주 월요일 09:00 KST", False, True)
    assert agent["agent"]["agentId"] == agent["agentId"]  # {agent}: the object, also under "agent"
    aid = agent["agentId"]
    assert call("PATCH", f"/api/agents/{aid}", {"cron": "cron(*/5 * * * ? *)"})[0] == 400  # sub-hourly
    status, patched = call("PATCH", f"/api/agents/{aid}", {"cron": "cron(30 7 * * ? *)", "name": "트렌드"})
    assert status == 200 and (patched["name"], patched["scheduleLabel"]) == ("트렌드", "매일 07:30 KST")
    status, off = call("PATCH", f"/api/agents/{aid}", {"enabled": False})
    assert off["enabled"] is False and agents.schedule_name("sub-demo", aid) not in ctx.scheduler.schedules

    status, run = call("POST", f"/api/agents/{aid}/run")
    assert status == 202 and run["runId"].startswith("run_")
    invoke = ctx.lambda_.calls[-1]
    assert invoke["InvocationType"] == "Event" and json.loads(invoke["Payload"]) == {
        "action": "agents_run", "sub": "sub-demo", "agentId": aid, "runId": run["runId"]}
    [listed] = [a for a in call("GET", "/api/agents")[1]["agents"] if a["agentId"] == aid]
    assert listed["lastRun"]["status"] == "running"

    assert call("DELETE", "/api/agents/open-model-scout")[0] == 409
    assert call("PATCH", "/api/agents/open-model-scout", {"instructions": "x"})[0] == 409
    assert call("PATCH", "/api/agents/open-model-scout", {"enabled": False})[1]["enabled"] is False
    assert call("DELETE", f"/api/agents/{aid}") == (204, None)
    assert call("DELETE", f"/api/agents/{aid}")[0] == 404
    assert call("GET", "/api/agents", token=OTHER)[1]["agents"][0]["agentId"] == "open-model-scout"  # user-scoped


def test_a_custom_agent_run_posts_notes_through_its_tool_loop(ctx):
    ctx.bedrock_rt_east.loop = [[{"toolUse": {"toolUseId": "u1", "name": "notify",
                                              "input": {"title": "이번 주 트렌드", "body": "- 로그라이크"}}}],
                                [{"text": "알렸습니다."}]]
    _, agent = call("POST", "/api/agents", {"description": "트렌드"})
    ctx.bedrock_rt_east.loop = [[{"toolUse": {"toolUseId": "u1", "name": "notify",
                                              "input": {"title": "이번 주 트렌드", "body": "- 로그라이크"}}}],
                                [{"text": "알렸습니다."}]]
    out = app.handler({"action": "agents_run", "sub": "sub-demo", "agentId": agent["agentId"]}, None)
    assert out["status"] == "succeeded" and "알림 1건" in out["summary"]
    [note] = call("GET", "/api/agents/inbox")[1]["notes"]
    assert (note["title"], note["agentName"], note["proposal"]) == ("이번 주 트렌드", "주간 게임 트렌드", None)


# ── the scout ──────────────────────────────────────────────────────────────────


def test_scout_hard_filters(ctx):
    stats = {}
    found = {c["hfRepo"]: c for c in agents.scout_candidates(ctx, "sub-demo", stats)}
    assert set(found) == {"acme/Pixel-Image-2", "nc/Artsy-Image", "giant/Huge-Image", "code/Ref-Image",
                          "vid/Motion-5"}
    pixel = found["acme/Pixel-Image-2"]
    assert (pixel["kind"], pixel["license"], pixel["commercialOk"], pixel["vramGb"], pixel["instance"], pixel["fits"],
            pixel["inference"]) == ("image", "apache-2.0", True, 28, "g6e.2xlarge", True, "diffusers")
    assert (found["nc/Artsy-Image"]["commercialOk"], found["nc/Artsy-Image"]["license"]) == (
        False, "flux-1-dev-non-commercial-license")
    assert (found["giant/Huge-Image"]["fits"], found["giant/Huge-Image"]["instance"]) == (False, "g6e.16xlarge")
    assert found["code/Ref-Image"]["inference"] == "reference code"
    assert (found["vid/Motion-5"]["kind"], found["vid/Motion-5"]["instance"]) == ("video", "g6e.4xlarge")
    assert (stats["old"], stats["license"], stats["no_inference"]) == (1, 1, 1)
    assert stats["derived_or_baseline"] == 3  # the GGUF re-upload, FLUX.2 klein and LTX-2.5


def test_license_classes():
    assert agents.classify_license("mit") == (True, True)
    assert agents.classify_license("cc-by-nc-4.0") == (True, False)
    assert agents.classify_license("other:minimax-h3-community-license-agreement") == (True, False)
    assert agents.classify_license("other") == (False, False) and agents.classify_license("") == (False, False)
    m = {"cardData": {"license": "other", "license_name": "Qwen-Research"}, "tags": []}
    assert agents.license_of(m) == "other:qwen-research"
    assert agents.classify_license(agents.license_of(m)) == (True, False)


def test_scout_run_writes_korean_proposals_and_never_proposes_a_repo_twice(ctx):
    bedrock = ctx.bedrock_rt_east
    bedrock.proposals = [{"hfRepo": "acme/Pixel-Image-2", "label": "Pixel Image 2", "why": "프롬프트 충실도가 Krea보다 높다",
                          "risks": "속도 미확인", "editCapable": True},
                         {"hfRepo": "made/Up-Model", "label": "환각", "why": "-", "risks": "-"}]  # not a candidate
    agents.ensure_scout(ctx, DEMO_USER)
    out = agents.run_agent(ctx, "sub-demo", agents.SCOUT_ID)
    assert out["status"] == "succeeded" and out["summary"].startswith("제안 1건")
    ranking = bedrock.calls[-1]["messages"][0]["content"][0]["text"]
    assert "Krea 2 Turbo" in ranking and "FLUX.2 klein 9B" in ranking and "LTX-2.5" in ranking and "Wan2.2" in ranking
    [note] = call("GET", "/api/agents/inbox")[1]["notes"]
    p = note["proposal"]
    assert (p["kind"], p["hfRepo"], p["license"], p["commercialOk"], p["vramGb"], p["instance"], p["status"],
            p["trial"]) == ("image", "acme/Pixel-Image-2", "apache-2.0", True, 28, "g6e.2xlarge", "proposed", None)
    assert "https://huggingface.co/acme/Pixel-Image-2" in note["body"] and "프롬프트 충실도" in note["body"]
    assert "약 28 GB" in note["body"] and "상업 이용 가능" in note["body"] and "레퍼런스 편집 가능" in note["body"]
    [scout] = call("GET", "/api/agents")[1]["agents"]
    assert scout["lastRun"]["status"] == "succeeded"
    # the next morning: the proposed repo is not a candidate any more, and a promoted one never is
    store._put(ctx, "AGENTPROMOTED", "motion-5", {"slug": "motion-5", "hfRepo": "vid/Motion-5", "kind": "video"})
    again = {c["hfRepo"] for c in agents.scout_candidates(ctx, "sub-demo")}
    assert "acme/Pixel-Image-2" not in again and "vid/Motion-5" not in again and "code/Ref-Image" in again
    ctx.ec2.instances["i-9"] = {"state": "stopped", "tags": {"mediagen-promoted": "true", "mediagen": "ref",
                                                             "mediagen-hf": "code/Ref-Image"}}
    assert "code/Ref-Image" not in {c["hfRepo"] for c in agents.scout_candidates(ctx, "sub-demo")}


def test_a_quiet_scout_day_files_a_summary_note(ctx):
    agents.ensure_scout(ctx, DEMO_USER)
    agents.run_agent(ctx, "sub-demo", agents.SCOUT_ID)
    [note] = call("GET", "/api/agents/inbox")[1]["notes"]
    assert note["title"].startswith("조사 완료") and note["proposal"] is None and "Hugging Face에서" in note["body"]


# ── trials: lifecycle, user-data, sweep, promotion ──────────────────────────────


def test_trial_user_data_has_no_secrets_and_fits_ec2s_limit(ctx):
    trial = {"trialId": "tr_1", "kind": "image", "label": "Pixel Image 2", "hfRepo": "acme/Pixel-Image-2",
             "slug": "pixel-image-2", "instanceType": "g6e.2xlarge", "maxHours": 2,
             "bench": agents.bench_for("image", "https://cdn.example.com/ref.png")}
    ud = agents.user_data(ctx, trial)
    assert len(ud.encode()) < 16_000
    assert "shutdown -h +120" in ud and "--name /mediagen/hf-token --with-decryption" in ud
    assert not re.search(r"hf_[A-Za-z0-9]{10,}", ud) and "test-key" not in ud and "token" not in ud.split("CFG")[1]
    cfg = json.loads(ud.split("<<'CFG'\n")[1].split("\nCFG")[0])
    assert {b["mode"] for b in cfg["bench"]} == {"t2i", "i2i"} and cfg["prefix"] == "agents/trials/tr_1/"
    assert next(b for b in cfg["bench"] if b["mode"] == "i2i")["referenceUrl"] == "https://cdn.example.com/ref.png"
    assert ud.rstrip().splitlines()[-1] == \
        "if [ -f /opt/mg/promote ]; then shutdown -c; shutdown -h +60; else shutdown -h now; fi"
    assert {b["mode"] for b in agents.bench_for("video", None)} == {"t2v", "i2v"}


def test_proposal_lifecycle_and_its_409s(ctx):
    pid = _proposal(ctx)
    assert call("POST", f"/api/agents/proposals/{pid}/approve")[0] == 409  # not tested yet
    status, prop = call("POST", f"/api/agents/proposals/{pid}/test")
    assert status == 202 and prop["status"] == "testing" and prop["proposal"]["proposalId"] == pid
    trial = prop["trial"]
    assert trial["phase"] == "GPU 재고 찾는 중" and trial["results"] == [] and trial["finishedAt"] is None
    launch = json.loads(ctx.lambda_.calls[-1]["Payload"])
    assert launch == {"action": "agents_launch", "trialId": trial["trialId"]}
    assert call("POST", f"/api/agents/proposals/{pid}/test")[0] == 409  # this one is testing
    other = _proposal(ctx, kind="video", repo="vid/Motion-5", label="Motion 5")
    status, busy = call("POST", f"/api/agents/proposals/{other}/test")
    assert (status, busy["error"]) == (409, "trial_running")  # one trial box at a time
    assert call("POST", f"/api/agents/proposals/{pid}/approve")[0] == 409  # testing, not passed
    assert call("POST", "/api/agents/proposals/prop_nope/test")[0] == 404
    assert call("POST", f"/api/agents/proposals/{pid}/test", token=OTHER)[0] == 404  # user-scoped

    app.handler(launch, None)  # the launch self-invoke
    t = agents.get_trial(ctx, trial["trialId"])
    run = ctx.ec2.calls[0][1]
    assert t["instanceId"] == "i-0001" and run["InstanceType"] == "g6e.2xlarge"
    assert run["InstanceInitiatedShutdownBehavior"] == "terminate" and run["SecurityGroupIds"] == ["sg-trial"]
    tags = {x["Key"]: x["Value"] for x in run["TagSpecifications"][0]["Tags"]}
    assert tags["mediagen"] == "trial" and tags["ipverse-trial"] == trial["trialId"]
    assert ("test-assets", f"agents/trials/{trial['trialId']}/trial_agent.py") in ctx.s3._store

    status, dismissed = call("POST", f"/api/agents/proposals/{pid}/dismiss")
    assert status == 200 and dismissed["status"] == "dismissed"
    assert ("terminate_instances", {"InstanceIds": ["i-0001"]}) in ctx.ec2.calls
    status, now_free = call("POST", f"/api/agents/proposals/{other}/test")  # the lock went with it
    assert status == 202 and now_free["status"] == "testing"


def test_launch_moves_to_the_next_az_then_a_bigger_box_on_a_capacity_miss(ctx):
    pid = _proposal(ctx)
    ctx.ec2.dry = {"g6e.2xlarge"}
    trial = call("POST", f"/api/agents/proposals/{pid}/test")[1]["trial"]
    agents.run_launch(ctx, trial["trialId"])
    tried = [(kw["InstanceType"], kw["SubnetId"]) for n, kw in ctx.ec2.calls if n == "run_instances"]
    assert tried == [("g6e.2xlarge", "subnet-a"), ("g6e.2xlarge", "subnet-b"), ("g6e.xlarge", "subnet-a")]
    assert agents.get_trial(ctx, trial["trialId"])["instanceType"] == "g6e.xlarge"
    ctx.ec2.dry = {"g6e.xlarge", "g6e.2xlarge", "g6e.4xlarge", "g6e.8xlarge", "g6e.16xlarge"}
    ctx.ec2.calls.clear()
    agents.dismiss(ctx, DEMO_USER, pid)
    pid2 = _proposal(ctx, repo="x/Y", label="Y")
    trial2 = call("POST", f"/api/agents/proposals/{pid2}/test")[1]["trial"]
    agents.run_launch(ctx, trial2["trialId"])
    prop = agents.get_proposal(ctx, "sub-demo", pid2)
    said = agents.get_trial(ctx, trial2["trialId"])["error"]  # what happened and what to do, in 해요체
    assert prop["status"] == "failed" and "남는 GPU 서버" in said and "없어" in said and "다시 눌러 주세요" in said
    assert call("POST", f"/api/agents/proposals/{pid2}/test")[0] == 202  # a failed proposal can be tested again


def _launched(ctx, kind="image", **extra):
    pid = _proposal(ctx, kind=kind, **extra)
    tid = call("POST", f"/api/agents/proposals/{pid}/test")[1]["trial"]["trialId"]
    agents.run_launch(ctx, tid)
    return pid, tid


def _box_writes(ctx, tid, name, obj):
    ctx.s3.put_object(Bucket="test-assets", Key=f"agents/trials/{tid}/{name}", Body=json.dumps(obj).encode())


PASSED = {"status": "succeeded", "promotable": True, "kinds": ["t2i", "i2i"], "notes": "diffusers 0.40으로 설치",
          "metrics": {"load_seconds": 80, "t2i": "verified", "i2i": "verified"},
          "outputs": [{"mode": "t2i", "prompt": agents.IMAGE_PROMPTS[0], "url": "https://cdn/t2i-1.png"},
                      {"mode": "t2i", "prompt": agents.IMAGE_PROMPTS[1], "url": "https://cdn/t2i-2.png"},
                      {"mode": "i2i", "prompt": agents.EDIT_PROMPT, "url": "https://cdn/i2i-1.png",
                       "referenceUrl": "https://cdn/ref.png"}]}


def test_sweep_advances_a_trial_from_the_boxs_status_files_and_parks_a_passing_box(ctx, mcp):
    pid, tid = _launched(ctx)
    _box_writes(ctx, tid, "status.json", {"phase": "downloading weights (24 GB)", "message": ""})
    agents.sweep(ctx)
    t = agents.get_trial(ctx, tid)
    assert (t["status"], t["phase"]) == ("running", "downloading weights (24 GB)")
    assert agents.get_proposal(ctx, "sub-demo", pid)["status"] == "testing"
    # the baselines start once a trial exists: Krea t2i for both prompts (klein waits for the Krea reference)
    assert [a["model"] for a in mcp.named("start_image")] == ["krea", "krea"]
    assert len(mcp.named("ltx_start_video")) == 2

    _box_writes(ctx, tid, "result.json", PASSED)
    agents.sweep(ctx)
    t = agents.get_trial(ctx, tid)
    assert t["status"] == "passed" and t["kinds"] == ["t2i", "i2i"]
    assert ctx.ec2.names()[-2:] == ["modify_instance_attribute", "stop_instances"]  # parked, not terminated
    assert ctx.ec2.calls[-2][1]["InstanceInitiatedShutdownBehavior"] == {"Value": "stop"}
    assert "terminate_instances" not in ctx.ec2.names()
    _, inbox = call("GET", "/api/agents/inbox")
    passed = next(n for n in inbox["notes"] if n["title"].startswith("GPU 테스트 통과"))
    prop = passed["proposal"]
    assert prop["status"] == "passed" and prop["trial"]["finishedAt"] and prop["trial"]["error"] is None
    results = prop["trial"]["results"]
    assert [(r["mode"], r["baseline"]["model"]) for r in results] == [
        ("t2i", "Krea 2 Turbo"), ("t2i", "Krea 2 Turbo"), ("i2i", "FLUX.2 klein 9B")]
    first = results[0]
    assert first["candidate"] == {"url": "https://cdn/t2i-1.png"} and first["prompt"] == agents.IMAGE_PROMPTS[0]
    assert first["baseline"]["url"] == "https://cdn.example.com/sessions/agents-bench/" \
        f"{agents.baseline_key('t2i', agents.IMAGE_PROMPTS[0]).replace('#', '-')}.png"
    assert results[2]["referenceUrl"] == "https://cdn/ref.png"
    # the next sweep: klein's edit baseline starts from the Krea picture
    agents.sweep(ctx)
    klein = mcp.named("start_image")[-1]
    assert klein["model"] == "klein9" and klein["reference_image_urls"] == [first["baseline"]["url"]]


def test_a_failed_or_vanished_trial_terminates_its_box(ctx):
    pid, tid = _launched(ctx)
    _box_writes(ctx, tid, "result.json", {"status": "failed", "outputs": [], "error": "OOM after offload"})
    agents.sweep(ctx)
    assert agents.get_trial(ctx, tid)["status"] == "failed" and ctx.ec2.names()[-1] == "terminate_instances"
    assert agents.get_proposal(ctx, "sub-demo", pid)["status"] == "failed"
    assert any("OOM after offload" in n["body"] for n in call("GET", "/api/agents/inbox")[1]["notes"])
    pid2, tid2 = _launched(ctx, repo="x/Z", label="Z")
    ctx.ec2.instances[agents.get_trial(ctx, tid2)["instanceId"]]["state"] = "terminated"
    agents.sweep(ctx)
    assert "결과 없이" in agents.get_trial(ctx, tid2)["error"]


def test_approve_promotes_the_parked_box_with_the_registry_tags_last(ctx, mcp):
    pid, tid = _launched(ctx, label="Pixel Image 2")
    _box_writes(ctx, tid, "result.json", PASSED)
    agents.sweep(ctx)
    iid = agents.get_trial(ctx, tid)["instanceId"]
    ctx.ec2.calls.clear()
    connections._image_catalog.update({"models": [], "until": 9e12})  # a stale cache: approval clears it
    status, prop = call("POST", f"/api/agents/proposals/{pid}/approve")
    assert status == 202 and prop["status"] == "promoted"
    assert ctx.ec2.names() == ["modify_instance_attribute", "modify_instance_attribute",
                               "replace_iam_instance_profile_association", "stop_instances", "create_tags"]
    kw = [k for _, k in ctx.ec2.calls]
    assert kw[1] == {"InstanceId": iid, "Groups": ["sg-07314d21c31296a92"]}
    assert kw[2]["IamInstanceProfile"]["Arn"].endswith(":instance-profile/mediagen-promoted-instance")
    assert {t["Key"]: t["Value"] for t in kw[4]["Tags"]} == {
        "mediagen": "pixel-image-2", "mediagen-promoted": "true", "mediagen-label": "Pixel Image 2",
        "mediagen-hf": "acme/Pixel-Image-2", "mediagen-kinds": "t2i,i2i", "mediagen-trial": tid,
        "Name": "mediagen-pixel-image-2"}
    assert connections._image_catalog == {}
    reg = store._get(ctx, "AGENTPROMOTED", "pixel-image-2")
    assert (reg["kind"], reg["kinds"], reg["why"]) == ("image", ["t2i", "i2i"], "더 낫다")
    assert call("POST", f"/api/agents/proposals/{pid}/approve")[0] == 409  # already promoted
    assert call("POST", f"/api/agents/proposals/{pid}/dismiss")[0] == 409
    # the chat agent now knows the model, without it becoming a default
    block = agents.prompt_block(ctx)
    assert "pixel-image-2 = Pixel Image 2" in block and "더 낫다" in block and "기본 모델" in block and "i2i" in block


def test_a_video_kind_is_promoted_only_if_its_benchmark_rendered(ctx):
    result = {**PASSED, "kinds": ["t2v", "i2v"], "metrics": {"t2v": "verified", "i2v": "not verified: no time"},
              "outputs": [{"mode": "t2v", "prompt": agents.VIDEO_PROMPTS[0], "url": "https://cdn/1.mp4", "seconds": 5.0}]}
    pid, tid = _launched(ctx, kind="video", repo="vid/Motion-5", label="Motion 5")
    _box_writes(ctx, tid, "result.json", result)
    agents.sweep(ctx)
    assert agents.get_trial(ctx, tid)["kinds"] == ["t2v"]
    call("POST", f"/api/agents/proposals/{pid}/approve")
    tags = {t["Key"]: t["Value"] for t in ctx.ec2.calls[-1][1]["Tags"]}
    assert tags["mediagen-kinds"] == "t2v" and tags["mediagen"] == "motion-5"
    [res] = agents.public_trial(ctx, agents.get_trial(ctx, tid))["results"]
    assert res["candidate"] == {"url": "https://cdn/1.mp4", "seconds": 5.0} and res["baseline"]["model"] == "LTX-2.5"


def test_slugs_never_take_a_fleet_name():
    assert agents.promoted_slug("Qwen-Image 2.1") == "qwen-image-2-1"
    for name in ("LTX", "krea", "klein9", "Trial", "", "可灵"):
        assert agents.promoted_slug(name).startswith("m-"), name


# ── promoted models in the app ─────────────────────────────────────────────────


def test_promoted_models_in_the_image_and_video_catalogs(ctx, mcp):
    mcp.image_models = [{"tag": "pixel-image-2", "label": "Pixel Image 2", "kinds": ["t2i", "i2i"],
                         "hfRepo": "acme/Pixel-Image-2", "promoted": True}]
    mcp.video_models = [
        {"id": "ltx", "label": "LTX", "kinds": ["t2v", "i2v"], "status": "ready"},
        {"id": "motion-5", "label": "Motion 5", "kinds": ["t2v"], "status": "stopped", "promoted": True},
        {"id": "pixel-image-2", "label": "Pixel Image 2", "kinds": ["t2i", "i2i"], "status": "stopped",
         "promoted": True}]  # the image box carries the same tags: not a video model
    image = connections.image_catalog(ctx)["models"]
    assert [m["id"] for m in image] == ["klein9", "krea", "pixel-image-2"]
    assert image[2] == {"id": "pixel-image-2", "label": "Pixel Image 2", "kinds": ["t2i", "i2i"], "promoted": True,
                        "hfRepo": "acme/Pixel-Image-2"}
    assert connections.image_kinds(ctx, "pixel-image-2") == ["t2i", "i2i"] and connections.image_kinds(ctx, "krea") == ["t2i"]
    video = mv.catalog(ctx)["models"]
    assert [m["id"] for m in video] == ["ltx", "motion-5"]
    assert mv.shot_model_error(ctx, "motion-5", "t2v") is None and mv.start_tool("motion-5") == "video_start"


def test_the_image_catalog_falls_back_to_the_registry_when_videogen_is_down(ctx, mcp, monkeypatch):
    store._put(ctx, "AGENTPROMOTED", "pixel-image-2", {"slug": "pixel-image-2", "kind": "image", "label": "Pixel",
                                                       "kinds": ["t2i"], "hfRepo": "acme/Pixel-Image-2"})

    def down(url, body, key):
        if url == mcp_client.VIDEO.url:
            raise RuntimeError("MCP HTTP 502")
        return mcp(url, body, key)
    monkeypatch.setattr(mcp_client, "_post", down)
    assert [m["id"] for m in connections.image_catalog(ctx)["models"]] == ["klein9", "krea", "pixel-image-2"]


@pytest.fixture
def session(ctx, monkeypatch):
    monkeypatch.setattr(mi, "remove_background", lambda ctx, image: png_rgba(figure()))
    s = store.put_session(ctx, "sub-demo", "루나", "sf-shooter")
    store.update_session(ctx, s, concept={"title": "t", "logline": "", "style": "Pixar-like 3D", "palette": []})
    return s


def test_the_image_provider_routes_a_promoted_model_to_image_start(ctx, mcp, session):
    mcp.image_models = [{"tag": "pixel-image-2", "label": "Pixel Image 2", "kinds": ["t2i", "i2i"], "promoted": True},
                        {"tag": "flat-gen", "label": "Flat", "kinds": ["t2i"], "promoted": True}]
    sid = session["sessionId"]
    base = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "character", "name": "Luna", "description": "a cat",
                                                            "image_model": "pixel-image-2"})
    assert base["imageModel"] == "pixel-image-2"
    for _ in range(3):
        jobs.advance_jobs(ctx, sid)
    [start] = mcp.named("image_start")
    assert start["model"] == "pixel-image-2" and (start["width"], start["height"]) == (1216, 688)
    assert isinstance(start["seed"], int) and "image_urls" not in start
    assert not mcp.named("start_image")  # never the storyboard box
    [ip] = store.snapshot(ctx, sid)["ips"]
    image = next(a for a in store.snapshot(ctx, sid)["assets"] if a["assetId"] == ip["imageAssetId"])
    assert image["meta"]["model"] == "pixel-image-2" and ip["cutoutAssetId"]
    # an i2i model edits from the IP's picture; a t2i-only one may not take a reference
    twin = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "character", "name": "Twin", "description": "a cat",
                                                            "image_model": "pixel-image-2",
                                                            "reference_ip_id": ip["ipId"]})
    assert twin["imageModel"] == "pixel-image-2"
    for _ in range(3):
        jobs.advance_jobs(ctx, sid)
    assert mcp.named("image_start")[-1]["image_urls"] == [f"https://cdn.example.com/{mi.image_key(sid, base['jobId'])}"]
    bad = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "character", "name": "X", "description": "a cat",
                                                           "image_model": "flat-gen", "reference_ip_id": ip["ipId"]})
    assert bad["error"] == "bad_args"
    variant = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": ip["ipId"], "prompt": "red coat",
                                                               "image_model": "pixel-image-2"})
    assert "jobId" in variant
    assert tools.run_tool(ctx, session, "make_ip_variant", {"ipId": ip["ipId"], "prompt": "red coat",
                                                            "image_model": "flat-gen"})["error"] == "bad_args"


def test_a_booting_promoted_box_says_so(ctx, mcp):
    p = mi.MediagenImageProvider()
    mcp.status["j1"] = {"status": "booting", "phase": "instance_pending"}
    job = {"jobId": "job_1", "pk": "SESSION#s", "externalId": "j1", "input": {"model": "pixel-image-2", "prompt": "p"}}
    # one figure, the boot and the draw (waits.py), and no model's name
    assert p.status(job, ctx) == ("running", "정지된 GPU 서버 켜는 중 · 보통 ~11분")
    mcp.status["j1"] = {"status": "failed", "error": "CUDA OOM"}
    assert p.status(job, ctx) == ("failed", "이미지 생성 실패: CUDA OOM")


def test_the_chat_agent_prompt_lists_promoted_models_only_when_there_are_some(ctx):
    assert agents.prompt_block(ctx) == ""
    store._put(ctx, "AGENTPROMOTED", "motion-5", {"slug": "motion-5", "kind": "video", "label": "Motion 5",
                                                  "hfRepo": "vid/Motion-5", "kinds": ["t2v"], "why": "움직임이 자연스럽다",
                                                  "commercialOk": False, "promotedAt": "2026-11-09"})
    session = store.put_session(ctx, "sub-demo", "t", "sf-shooter")
    msg = store.put_message(ctx, session["sessionId"], "user", "안녕", "done")
    reply = store.put_message(ctx, session["sessionId"], "assistant", "", "pending", ts=store.now(offset_ms=1))
    ctx.bedrock_rt_east.loop = [[{"text": "안녕하세요"}]]
    chat_agent.run_turn(ctx, session["sessionId"], reply["messageId"])
    system = ctx.bedrock_rt_east.calls[-1]["system"]
    extra = [b["text"] for b in system if "스카우트로 추가된 모델" in b["text"]]
    assert len(extra) == 1 and "motion-5 = Motion 5" in extra[0] and "영상 model" in extra[0]
    assert "상업용 결과물에는 쓰지" in extra[0] and msg


def test_an_approval_that_ec2_refuses_is_a_409_and_can_be_repeated(ctx, monkeypatch):
    pid, tid = _launched(ctx)
    _box_writes(ctx, tid, "result.json", PASSED)
    agents.sweep(ctx)

    def still_stopping(**kw):
        raise _err("IncorrectInstanceState")
    monkeypatch.setattr(ctx.ec2, "replace_iam_instance_profile_association", still_stopping, raising=False)
    status, body = call("POST", f"/api/agents/proposals/{pid}/approve")
    assert (status, body["error"]) == (409, "promote_failed") and "create_tags" not in ctx.ec2.names()
    assert agents.get_proposal(ctx, "sub-demo", pid)["status"] == "passed"
    monkeypatch.delattr(ctx.ec2, "replace_iam_instance_profile_association")
    assert call("POST", f"/api/agents/proposals/{pid}/approve")[1]["status"] == "promoted"


def test_a_just_parked_box_whose_association_ec2_calls_inactive_is_moved_to_the_fleet_profile_anyway(ctx, mcp):
    """ReplaceIamInstanceProfileAssociation can answer IncorrectState ("not the active association") on a stopped box
    that describe calls associated; disassociate + associate works."""
    pid, tid = _launched(ctx, label="Pixel Image 3")
    _box_writes(ctx, tid, "result.json", PASSED)
    agents.sweep(ctx)
    iid = agents.get_trial(ctx, tid)["instanceId"]
    ctx.ec2.calls.clear()
    ctx.ec2.replace_fails = True
    status, prop = call("POST", f"/api/agents/proposals/{pid}/approve")
    assert status == 202 and prop["status"] == "promoted"
    names = ctx.ec2.names()
    assert names[2:5] == ["replace_iam_instance_profile_association", "disassociate_iam_instance_profile",
                          "associate_iam_instance_profile"]
    kw = dict(ctx.ec2.calls)["associate_iam_instance_profile"]
    assert kw["InstanceId"] == iid and kw["IamInstanceProfile"]["Arn"].endswith("/mediagen-promoted-instance")
    assert names[-1] == "create_tags"  # the registry tags still last
