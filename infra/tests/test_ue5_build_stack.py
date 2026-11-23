"""Synth test for the UE5 build box. Run: infra/.venv/bin/python -m pytest infra/tests/test_ue5_build_stack.py -v"""
import json
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "infra"))

import aws_cdk as cdk
from aws_cdk.assertions import Match, Template
from stacks.ue5_build_stack import Ue5BuildStack


@pytest.fixture(scope="module")
def t():
    app = cdk.App()
    return Template.from_stack(Ue5BuildStack(
        app, "IpverseUe5Build", env=cdk.Environment(account="087967639890", region="us-east-1")))


def test_instance_shape(t):
    t.has_resource_properties("AWS::EC2::Instance", {
        "InstanceType": "c6i.8xlarge",
        "InstanceInitiatedShutdownBehavior": "stop",
        "BlockDeviceMappings": [Match.object_like({"Ebs": Match.object_like({"VolumeSize": 400, "VolumeType": "gp3"})})],
    })


def test_no_ingress(t):
    for sg in t.find_resources("AWS::EC2::SecurityGroup").values():
        assert "SecurityGroupIngress" not in sg["Properties"]


def test_role_scope(t):
    statements = [s for p in t.find_resources("AWS::IAM::Policy").values()
                  for s in p["Properties"]["PolicyDocument"]["Statement"]]
    text = json.dumps(statements)
    assert "secret:ipverse/ghcr-token-*" in text
    assert "ipverse-ue5-builds-087967639890-us-west-2/ipverse-ue5/*" in text
    assert '"*"' not in text  # no wildcard resources


def test_idle_stop_installed(t):
    (inst,) = t.find_resources("AWS::EC2::Instance").values()
    user_data = json.dumps(inst["Properties"]["UserData"])
    assert "ipverse-idle-stop" in user_data and "shutdown -h now" in user_data
    assert "docker.io" in user_data
