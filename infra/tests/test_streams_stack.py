"""Synth test for the (undeployed) UE5 + GameLift Streams stack.
Run: infra/.venv/bin/python -m pytest infra/tests/test_streams_stack.py -v
"""
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "infra"))

import aws_cdk as cdk
from aws_cdk.assertions import Match, Template
from stacks.streams_stack import StreamsStack


@pytest.fixture(scope="module")
def t():
    app = cdk.App()
    stack = StreamsStack(app, "IpverseStreams", env=cdk.Environment(account="087967639890", region="us-west-2"))
    return Template.from_stack(stack)


def test_stream_group_parked_by_default(t):
    t.has_parameter("MaxCapacity", {"Default": 0})
    t.has_parameter("AlwaysOnCapacity", {"Default": 0})
    t.has_parameter("StreamClass", {"Default": "gen6n_high"})
    t.has_resource_properties("AWS::GameLiftStreams::StreamGroup", {
        "StreamClass": {"Ref": "StreamClass"},
        "LocationConfigurations": [{
            "LocationName": "us-west-2",
            "AlwaysOnCapacity": {"Ref": "AlwaysOnCapacity"},
            "MaximumCapacity": {"Ref": "MaxCapacity"},
            "TargetIdleCapacity": 0,
        }, {"Fn::If": ["HasSeoul", Match.object_like({"LocationName": "ap-northeast-2"}), {"Ref": "AWS::NoValue"}]}],
    })
    t.has_parameter("SeoulMaxCapacity", {"Default": 0})


def test_application_only_with_build(t):
    apps = {k: v for k, v in t.find_resources("AWS::GameLiftStreams::Application").items() if v.get("Condition") == "HasBuild"}
    assert len(apps) == 1  # the UE5 template game (the web player shell is the other application)
    (app,) = apps.values()
    assert app["Condition"] == "HasBuild"
    props = app["Properties"]
    assert props["RuntimeEnvironment"] == {"Type": "UBUNTU", "Version": "22_04_LTS"}
    assert props["ExecutablePath"] == "IpverseGame.sh"


def test_builds_bucket_private_and_service_readable(t):
    t.has_resource_properties("AWS::S3::Bucket", {
        "PublicAccessBlockConfiguration": {
            "BlockPublicAcls": True, "BlockPublicPolicy": True,
            "IgnorePublicAcls": True, "RestrictPublicBuckets": True,
        },
        "VersioningConfiguration": {"Status": "Enabled"},
    })
    t.has_resource_properties("AWS::S3::BucketPolicy", {
        "PolicyDocument": {"Statement": Match.array_with([
            Match.object_like({
                "Principal": {"Service": "gameliftstreams.amazonaws.com"},
                "Action": ["s3:GetObject", "s3:ListBucket"],
                "Condition": {"StringEquals": {"aws:SourceAccount": "087967639890"}},
            }),
        ])},
    })


def test_api_policy_scoped_to_stream_group(t):
    policies = t.find_resources("AWS::IAM::ManagedPolicy")
    assert len(policies) == 1
    (stmt,) = list(policies.values())[0]["Properties"]["PolicyDocument"]["Statement"]
    assert sorted(stmt["Action"]) == [
        "gameliftstreams:CreateStreamSessionConnection",
        "gameliftstreams:GetStreamGroup",
        "gameliftstreams:GetStreamSession",
        "gameliftstreams:StartStreamSession",
        "gameliftstreams:TerminateStreamSession",
    ]
    assert "*" not in stmt["Resource"]
    sg_logical = next(iter(t.find_resources("AWS::GameLiftStreams::StreamGroup")))
    assert stmt["Resource"][0] == {"Fn::GetAtt": [sg_logical, "Arn"]}


def test_only_registered_behind_ue5_context():
    app_py = (ROOT / "infra" / "app.py").read_text()
    assert 'try_get_context("ue5")' in app_py
    assert app_py.index('try_get_context("ue5")') < app_py.index('StreamsStack(app')
