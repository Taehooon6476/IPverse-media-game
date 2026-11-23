"""IpverseLive synth: the private player channel and its recording (run: infra/.venv/bin/python -m pytest infra/tests)."""
import pathlib
import sys

import aws_cdk as cdk
from aws_cdk.assertions import Match, Template

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from stacks.live_stack import LiveStack  # noqa: E402


def _template():
    app = cdk.App()
    return Template.from_stack(LiveStack(app, "IpverseLive", env=cdk.Environment(account="087967639890", region="us-east-1")))


def test_the_player_channel_is_private_and_records_to_the_assets_bucket():
    t = _template()
    t.has_resource_properties("AWS::IVS::RecordingConfiguration", {
        "Name": "ipverse-live-rec",
        "DestinationConfiguration": {"S3": {"BucketName": "ipverse-assets-087967639890-us-east-1"}},
        "ThumbnailConfiguration": {"RecordingMode": "DISABLED"},
        "RenditionConfiguration": {"RenditionSelection": "ALL"},
        "RecordingReconnectWindowSeconds": Match.any_value(),
    })
    rec = t.find_resources("AWS::IVS::RecordingConfiguration")
    [rec_id] = rec
    window = rec[rec_id]["Properties"]["RecordingReconnectWindowSeconds"]
    assert 0 < window <= 60
    t.has_resource_properties("AWS::IVS::Channel", {
        "Name": "ipverse-live-player", "Authorized": True, "LatencyMode": "LOW", "Type": "BASIC",
        "RecordingConfigurationArn": {"Fn::GetAtt": [rec_id, "Arn"]},
    })
    # logical ids stay, so the channel and its stream key are updated in place, not replaced
    assert "PlayerIngest" in "".join(t.find_resources("AWS::IVS::Channel"))
    t.has_output("AdsUrl", {"Value": {"Fn::Join": ["", ["https://", Match.any_value(), "/vast/ivs/p-[player_params.persona].xml"]]}})
