#!/usr/bin/env python3
import pathlib
import aws_cdk as cdk
from stacks.core_stack import CoreStack
from stacks.video_stack import VideoStack
from stacks.img3d_stack import Img3dStack
from stacks.live_stack import LiveStack
from stacks.streams_stack import StreamsStack
from stacks.ue5_build_stack import Ue5BuildStack

# Absolute root so stacks can resolve build/ assets regardless of cwd
ROOT = pathlib.Path(__file__).resolve().parent.parent

app = cdk.App()

img3d = Img3dStack(
    app,
    "IpverseImg3d",
    env=cdk.Environment(account="087967639890", region="us-east-1"),
)

live = LiveStack(app, "IpverseLive", env=cdk.Environment(account="087967639890", region="us-east-1"))

core = CoreStack(
    app,
    "IpverseCore",
    root=ROOT,
    img3d=img3d,
    live=live,
    env=cdk.Environment(account="087967639890", region="us-east-1"),
)

VideoStack(
    app,
    "IpverseVideo",
    env=cdk.Environment(account="087967639890", region="us-west-2"),
)

# UE5 track: only with `-c ue5=1`, so scripts/deploy.sh (deploy --all) never touches the build box or streams.
if app.node.try_get_context("ue5"):
    StreamsStack(app, "IpverseStreams", env=cdk.Environment(account="087967639890", region="us-west-2"))
    Ue5BuildStack(app, "IpverseUe5Build", env=cdk.Environment(account="087967639890", region="us-east-1"))

app.synth()
