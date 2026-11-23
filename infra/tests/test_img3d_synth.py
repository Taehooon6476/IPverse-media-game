"""IpverseImg3d synth tests + the IpverseCore grants it needs. Run: infra/.venv/bin/python -m pytest infra/tests -q"""
import json
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "infra"))

import aws_cdk as cdk  # noqa: E402
from aws_cdk.assertions import Match, Template  # noqa: E402
from stacks.img3d_stack import Img3dStack  # noqa: E402
from tests.test_synth import build_artifacts, core_template  # noqa: E402,F401  (shared fixtures)

ENV = cdk.Environment(account="087967639890", region="us-east-1")


@pytest.fixture(scope="module")
def t():
    return Template.from_stack(Img3dStack(cdk.App(), "IpverseImg3d", env=ENV))


def _statements(t):
    out = []
    for pol in t.find_resources("AWS::IAM::Policy").values():
        out += pol["Properties"]["PolicyDocument"]["Statement"]
    return out


def _actions(stmt):
    a = stmt["Action"]
    return [a] if isinstance(a, str) else a


def test_queue_and_dlq(t):
    t.resource_count_is("AWS::SQS::Queue", 4)  # the old standard queue (drained, then idle) and the FIFO one, each with a DLQ
    t.has_resource_properties("AWS::SQS::Queue", {
        "QueueName": "ipverse-img3d-jobs",
        "VisibilityTimeout": 1800,
        "RedrivePolicy": {"maxReceiveCount": 2, "deadLetterTargetArn": Match.any_value()},
    })
    t.has_resource_properties("AWS::SQS::Queue", {"QueueName": "ipverse-img3d-jobs-dlq"})
    t.has_resource_properties("AWS::SQS::Queue", {
        "QueueName": "ipverse-img3d-jobs.fifo", "FifoQueue": True, "VisibilityTimeout": 600,
        "RedrivePolicy": {"maxReceiveCount": 2, "deadLetterTargetArn": Match.any_value()},
    })
    t.has_resource_properties("AWS::SQS::Queue", {"QueueName": "ipverse-img3d-jobs-dlq.fifo", "FifoQueue": True})


def test_no_public_ingress(t):
    groups = t.find_resources("AWS::EC2::SecurityGroup")
    assert len(groups) == 1
    for g in groups.values():
        assert not g["Properties"].get("SecurityGroupIngress"), "img3d SG must have no inbound rules"
    t.resource_count_is("AWS::EC2::SecurityGroupIngress", 0)


def test_launch_template_no_standing_instance(t):
    t.resource_count_is("AWS::EC2::Instance", 0)  # the API Lambda starts or launches the box
    lt = next(iter(t.find_resources("AWS::EC2::LaunchTemplate").values()))["Properties"]
    assert lt["LaunchTemplateName"] == "ipverse-img3d"
    d = lt["LaunchTemplateData"]
    assert d["ImageId"] == "ami-032da630dc1c31744" and d["InstanceType"] == "g6e.xlarge"
    assert d["MetadataOptions"] == {"HttpTokens": "required"}
    assert d["BlockDeviceMappings"] == [{"DeviceName": "/dev/sda1",
                                         "Ebs": {"VolumeSize": 200, "VolumeType": "gp3", "DeleteOnTermination": True,
                                                 "VolumeInitializationRate": 300}}]
    assert "NetworkInterfaces" not in d and len(d["SecurityGroupIds"]) == 1
    for spec in d["TagSpecifications"]:  # every launched instance/volume carries the tag
        assert {"Key": "ipverse", "Value": "img3d"} in spec["Tags"]
    assert {s["ResourceType"] for s in d["TagSpecifications"]} == {"instance", "volume"}
    assert "img3d/worker/setup.sh" in json.dumps(d["UserData"]) and "IMG3D_QUEUE_URL" in json.dumps(d["UserData"])


def test_worker_role_scoped(t):
    stmts = _statements(t)
    by_action = {a: s for s in stmts for a in _actions(s)}
    assert by_action["s3:PutObject"]["Resource"] == "arn:aws:s3:::ipverse-assets-087967639890-us-east-1/img3d/*"
    stop = by_action["ec2:StopInstances"]
    assert stop["Condition"] == {"StringEquals": {"aws:ResourceTag/ipverse": "img3d"}}
    for a in ("sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"):
        assert "Fn::GetAtt" in json.dumps(by_action[a]["Resource"])
    assert "ec2:StartInstances" not in by_action and "s3:*" not in by_action
    roles = t.find_resources("AWS::IAM::Role")
    assert "AmazonSSMManagedInstanceCore" in json.dumps(roles)


def test_core_grants_img3d(core_template):
    stmts = []
    for pol in core_template.find_resources("AWS::IAM::Policy").values():
        stmts += pol["Properties"]["PolicyDocument"]["Statement"]
    by_action = {a: s for s in stmts for a in _actions(s)}
    assert by_action["sqs:SendMessage"]["Resource"] == "arn:aws:sqs:us-east-1:087967639890:ipverse-img3d-jobs.fifo"
    assert by_action["ec2:StartInstances"]["Condition"] == {"StringEquals": {"aws:ResourceTag/ipverse": "img3d"}}
    assert "ec2:DescribeInstances" in by_action
    fn = next(v for v in core_template.find_resources("AWS::Lambda::Function").values()
              if v["Properties"].get("FunctionName") == "ipverse-api")
    assert fn["Properties"]["Environment"]["Variables"]["IMG3D_QUEUE_URL"] == \
        "https://sqs.us-east-1.amazonaws.com/087967639890/ipverse-img3d-jobs.fifo"


def test_core_relocation_grants_scoped_to_the_template_and_role():
    from stacks.core_stack import CoreStack
    app = cdk.App()
    img3d = Img3dStack(app, "IpverseImg3d", env=ENV)
    core = Template.from_stack(CoreStack(app, "IpverseCore", img3d=img3d, env=ENV))
    stmts = []
    for pol in core.find_resources("AWS::IAM::Policy").values():
        stmts += pol["Properties"]["PolicyDocument"]["Statement"]
    # the agents' trial boxes (server/agents.py) have their own RunInstances/PassRole/... statements: pick img3d's
    def img3d_stmt(action, key):
        return next(s for s in stmts if action in _actions(s) and key in json.dumps(s))
    run = img3d_stmt("ec2:RunInstances", "ec2:LaunchTemplate")
    cond = json.dumps(run["Condition"]["ArnLike"]["ec2:LaunchTemplate"])
    assert "launch-template/" in cond and "IpverseImg3d" in cond  # the img3d template, by cross-stack ref
    pass_role = img3d_stmt("iam:PassRole", "IpverseImg3d")
    assert "PassRole" in json.dumps(pass_role["Action"])
    assert "IpverseImg3d" in json.dumps(pass_role["Resource"])  # only the worker role
    assert pass_role["Condition"] == {"StringEquals": {"iam:PassedToService": "ec2.amazonaws.com"}}
    assert img3d_stmt("ec2:CreateTags", "ec2:CreateAction")["Condition"] == {
        "StringEquals": {"ec2:CreateAction": "RunInstances"}}
    assert img3d_stmt("ec2:TerminateInstances", "aws:ResourceTag/ipverse")["Condition"] == {
        "StringEquals": {"aws:ResourceTag/ipverse": "img3d"}}
    # and the agents' grants never reach an img3d box or another fleet box: every mutating one needs mediagen=trial
    for s in stmts:
        if set(_actions(s)) & {"ec2:TerminateInstances", "ec2:StopInstances"} and "aws:ResourceTag/ipverse" not in \
                json.dumps(s):
            assert s["Condition"] == {"StringEquals": {"aws:ResourceTag/mediagen": "trial"}}
