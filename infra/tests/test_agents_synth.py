"""스킬 · Agent 등록 (server/agents.py) in IpverseCore: schedules, the sweep, the GPU trial box and the API's grants."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "infra"))

from tests.test_synth import build_artifacts, core_template  # noqa: E402,F401 — the shared fixtures

ACCOUNT, REGION = "087967639890", "us-east-1"


def _statements(template):
    out = []
    for pol in template.find_resources("AWS::IAM::Policy").values():
        out += pol["Properties"]["PolicyDocument"]["Statement"]
    return out


def _actions(s):
    a = s["Action"]
    return [a] if isinstance(a, str) else a


def _api_env(template):
    fn = next(v for v in template.find_resources("AWS::Lambda::Function").values()
              if v["Properties"].get("FunctionName") == "ipverse-api")
    return fn["Properties"]["Environment"]["Variables"]


def test_the_api_lambda_knows_the_agents_resources(core_template):
    env = _api_env(core_template)
    assert env["AGENTS_SCHEDULE_GROUP"] == "ipverse-agents"
    assert env["AGENTS_SELF_ARN"] == f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:ipverse-api"
    assert env["SCOUT_DEFAULT_USERS"] == "demo"
    assert env["TRIAL_VPC"] == "vpc-0048f3a571ac6b876" and env["TRIAL_AMI"] == "ami-012ba162b9cd2729c"
    assert env["TRIAL_OUTPUT_BUCKET"] == f"mediagen-out-{ACCOUNT}-{REGION}"
    assert env["FLEET_SECURITY_GROUP"] == "sg-07314d21c31296a92"
    assert env["FLEET_INSTANCE_PROFILE_ARN"] == f"arn:aws:iam::{ACCOUNT}:instance-profile/mediagen-promoted-instance"
    # the HF token is a parameter NAME the box resolves itself; no value anywhere in the template
    assert env["HF_TOKEN_PARAM"] == "/mediagen/hf-token"
    assert "hf_" not in json.dumps(core_template.to_json())
    for k in ("AGENTS_SCHEDULER_ROLE_ARN", "TRIAL_INSTANCE_PROFILE_ARN", "TRIAL_SECURITY_GROUP"):
        assert isinstance(env[k], dict)  # resolved from the stack's own resources


def test_schedule_group_and_a_five_minute_sweep(core_template):
    core_template.has_resource_properties("AWS::Scheduler::ScheduleGroup", {"Name": "ipverse-agents"})
    # (by its action: the stack has the every-minute job tick too, tests/test_round20_synth.py)
    sweep = next(s["Properties"] for s in core_template.find_resources("AWS::Scheduler::Schedule").values()
                 if "agents_sweep" in s["Properties"]["Target"]["Input"])
    assert sweep["ScheduleExpression"] == "rate(5 minutes)"
    assert json.loads(sweep["Target"]["Input"]) == {"action": "agents_sweep"}
    assert sweep["Target"]["Arn"] == f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:ipverse-api"


def test_scheduler_role_only_invokes_the_api(core_template):
    roles = core_template.find_resources("AWS::IAM::Role")
    sched = [k for k, v in roles.items() if "scheduler.amazonaws.com" in json.dumps(v)]
    assert len(sched) == 1
    stmts = [s for k, p in core_template.find_resources("AWS::IAM::Policy").items()
             for s in p["Properties"]["PolicyDocument"]["Statement"]
             if sched[0] in json.dumps(p["Properties"]["Roles"])]
    assert stmts == [{"Action": "lambda:InvokeFunction", "Effect": "Allow",
                      "Resource": f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:ipverse-api"}]


def test_trial_box_role_is_narrow(core_template):
    roles = core_template.find_resources("AWS::IAM::Role")
    trial = next(k for k, v in roles.items() if k.startswith("AgentsTrialRole"))
    stmts = [s for p in core_template.find_resources("AWS::IAM::Policy").values()
             for s in p["Properties"]["PolicyDocument"]["Statement"] if trial in json.dumps(p["Properties"]["Roles"])]
    actions = sorted({a for s in stmts for a in _actions(s)})
    assert actions == ["bedrock:Converse", "bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream",
                       "kms:Decrypt", "s3:GetObject", "s3:PutObject", "ssm:GetParameter"]
    ssm = next(s for s in stmts if "ssm:GetParameter" in _actions(s))
    assert ssm["Resource"] == f"arn:aws:ssm:{REGION}:{ACCOUNT}:parameter/mediagen/hf-token"
    assert not any(a.startswith(("ec2:", "iam:", "dynamodb:")) for a in actions)
    core_template.has_resource_properties("AWS::EC2::SecurityGroup", {
        "VpcId": "vpc-0048f3a571ac6b876", "SecurityGroupEgress": [{"CidrIp": "0.0.0.0/0", "IpProtocol": "-1"}]})
    sg = next(v for k, v in core_template.find_resources("AWS::EC2::SecurityGroup").items()
              if k.startswith("AgentsTrialSecurityGroup"))
    assert "SecurityGroupIngress" not in sg["Properties"]


def test_api_can_launch_park_promote_and_terminate_only_trial_boxes(core_template):
    stmts = _statements(core_template)
    run = next(s for s in stmts if "ec2:RunInstances" in _actions(s) and "ec2:InstanceType" in json.dumps(s))
    assert run["Condition"]["StringEquals"]["aws:RequestTag/mediagen"] == "trial"
    assert set(run["Condition"]["StringEquals"]["ec2:InstanceType"]) == {
        "g6e.xlarge", "g6e.2xlarge", "g6e.4xlarge", "g6e.8xlarge", "g6e.16xlarge", "g6e.12xlarge"}
    ami = next(s for s in stmts if "ec2:RunInstances" in _actions(s) and "image/ami-" in json.dumps(s))
    assert f"arn:aws:ec2:{REGION}::image/ami-012ba162b9cd2729c" in ami["Resource"]
    mutate = next(s for s in stmts if "ec2:ReplaceIamInstanceProfileAssociation" in _actions(s))
    assert set(_actions(mutate)) == {"ec2:TerminateInstances", "ec2:StopInstances", "ec2:ModifyInstanceAttribute",
                                     "ec2:ReplaceIamInstanceProfileAssociation", "ec2:DisassociateIamInstanceProfile",
                                     "ec2:AssociateIamInstanceProfile", "ec2:CreateTags"}
    assert mutate["Condition"] == {"StringEquals": {"aws:ResourceTag/mediagen": "trial"}}
    passes = [s for s in stmts if "iam:PassRole" in _actions(s)]
    promoted = next(s for s in passes if "mediagen-promoted-instance" in json.dumps(s))
    assert promoted["Condition"] == {"StringEquals": {"iam:PassedToService": "ec2.amazonaws.com"}}
    sched = next(s for s in stmts if "scheduler:CreateSchedule" in _actions(s))
    assert sched["Resource"] == f"arn:aws:scheduler:{REGION}:{ACCOUNT}:schedule/ipverse-agents/*"
