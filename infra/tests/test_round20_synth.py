"""IpverseCore: the every-minute job tick (server/jobs.py advance_active) and the games/* behaviour's index rewrite."""
import json
import pathlib
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "infra"))

from tests.test_synth import build_artifacts, core_template  # noqa: E402,F401 — the shared fixtures

ACCOUNT, REGION = "087967639890", "us-east-1"
API_ARN = f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:ipverse-api"


def _schedules(template) -> dict:
    """{the target's action: the schedule's properties}."""
    return {json.loads(s["Properties"]["Target"]["Input"])["action"]: s["Properties"]
            for s in template.find_resources("AWS::Scheduler::Schedule").values()}


def test_a_schedule_runs_the_job_tick_every_minute(core_template):
    """A chain's next step must not wait for a studio tab's poll: the API is invoked every minute with action jobs_tick."""
    tick = _schedules(core_template)["jobs_tick"]
    assert tick["ScheduleExpression"] == "rate(1 minute)"
    assert tick["FlexibleTimeWindow"] == {"Mode": "OFF"}
    assert tick["Target"]["Arn"] == API_ARN
    assert json.loads(tick["Target"]["Input"]) == {"action": "jobs_tick"}
    # a tick that fails is not sent again: the next minute's is the retry
    assert tick["Target"]["RetryPolicy"] == {"MaximumRetryAttempts": 0}
    assert tick.get("State", "ENABLED") == "ENABLED"


def test_the_tick_uses_the_sweeps_role_and_adds_no_grant(core_template):
    """The same scheduler role as the agents' sweep, which may only invoke the API (test_agents_synth); the tick's
    own work (the table, the providers) is what the API role already does on a tab's poll."""
    by_action = _schedules(core_template)
    assert set(by_action) == {"agents_sweep", "jobs_tick"}
    assert by_action["jobs_tick"]["Target"]["RoleArn"] == by_action["agents_sweep"]["Target"]["RoleArn"]
    roles = core_template.find_resources("AWS::IAM::Role")
    sched = [k for k, v in roles.items() if "scheduler.amazonaws.com" in json.dumps(v)]
    assert len(sched) == 1
    stmts = [s for p in core_template.find_resources("AWS::IAM::Policy").values()
             for s in p["Properties"]["PolicyDocument"]["Statement"] if sched[0] in json.dumps(p["Properties"]["Roles"])]
    assert stmts == [{"Action": "lambda:InvokeFunction", "Effect": "Allow", "Resource": API_ARN}]
    # the role is assumed by the scheduler of this account only (the confused-deputy guard)
    trust = roles[sched[0]]["Properties"]["AssumeRolePolicyDocument"]["Statement"]
    assert trust == [{"Action": "sts:AssumeRole", "Effect": "Allow", "Principal": {"Service": "scheduler.amazonaws.com"},
                      "Condition": {"StringEquals": {"aws:SourceAccount": ACCOUNT}}}]


# A game's folder address: the bucket has no index document behind the origin access control, so /games/<id>/ and
# /games/<id> would answer S3's AccessDenied XML.

def _behaviors(template) -> dict:
    [dist] = template.find_resources("AWS::CloudFront::Distribution").values()
    config = dist["Properties"]["DistributionConfig"]
    return {**{b["PathPattern"]: b for b in config["CacheBehaviors"]}, "": config["DefaultCacheBehavior"], "config": config}


def _games_function(template) -> str:
    """The code of the one function on the /games/* behaviour (a viewer request)."""
    [assoc] = _behaviors(template)["/games/*"]["FunctionAssociations"]
    assert assoc["EventType"] == "viewer-request"
    [logical_id, attr] = assoc["FunctionARN"]["Fn::GetAtt"]
    assert attr == "FunctionARN"
    props = template.find_resources("AWS::CloudFront::Function")[logical_id]["Properties"]
    assert props["FunctionConfig"]["Runtime"] == "cloudfront-js-2.0" and props["AutoPublish"] is True
    return props["FunctionCode"]


def _run(code: str, uri: str, querystring=None) -> dict:
    """What the function answers a viewer's GET (node runs the code CloudFront would)."""
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed: the function's code is not run")
    event = {"version": "1.0", "request": {"method": "GET", "uri": uri, "querystring": querystring or {},
                                           "headers": {"host": {"value": "d1.cloudfront.net"}}, "cookies": {}}}
    script = f"{code}\nprocess.stdout.write(JSON.stringify(handler({json.dumps(event)})));"
    out = subprocess.run([node, "-e", script], capture_output=True, text=True, timeout=60, check=True)
    return json.loads(out.stdout)


def test_a_games_folder_address_opens_its_index_page(core_template):
    code = _games_function(core_template)
    assert len(code.encode()) < 10_240  # a CloudFront Function's size limit
    # the folder with its slash: the page itself, under the same address (its files are relative to it)
    assert _run(code, "/games/gm_f004991403/")["uri"] == "/games/gm_f004991403/index.html"
    # without the slash the page's relative files (./runtime3d.js, spec.json) would be asked for one folder up:
    # the browser is sent to the folder
    moved = _run(code, "/games/gm_f004991403")
    assert moved["statusCode"] == 302 and moved["headers"]["location"]["value"] == "/games/gm_f004991403/"
    query = {"noads": {"value": "1"}, "playable": {"value": "90"}, "standby": {"value": ""},
             "v": {"value": "a", "multiValue": [{"value": "a"}, {"value": "b"}]}}
    moved = _run(code, "/games/gm_f004991403", query)
    assert moved["headers"]["location"]["value"] == "/games/gm_f004991403/?noads=1&playable=90&standby&v=a&v=b"


def test_a_games_own_files_are_asked_for_as_they_are(core_template):
    code = _games_function(core_template)
    query = {"noads": {"value": "1"}}
    for uri in ("/games/gm_f004991403/index.html", "/games/gm_f004991403/spec.json", "/games/gm_f004991403/runtime3d.js",
                "/games/gm_f004991403/assets/ip_1.glb", "/games/gm_launcher/index.html"):
        out = _run(code, uri, query)
        assert out["uri"] == uri and out["querystring"] == query and "statusCode" not in out, uri


def test_only_the_games_behaviour_got_a_function_and_there_are_still_no_error_pages(core_template):
    """Distribution-wide error pages would also replace the API's own 403 and 404 JSON answers."""
    behaviors = _behaviors(core_template)
    assert "CustomErrorResponses" not in behaviors["config"]
    for pattern in ("/api/*", "/sessions/*", "/runtime/*"):
        assert "FunctionAssociations" not in behaviors[pattern], pattern
    assert len(behaviors[""]["FunctionAssociations"]) == 1  # the SPA rewrite, as before
    assert len(core_template.find_resources("AWS::CloudFront::Function")) == 2
