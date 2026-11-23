from __future__ import annotations
import os
from dataclasses import dataclass, field
from typing import Protocol, Optional


def s3_key_for(session_id: str, asset_id: str, ext: str) -> str:
    return f"sessions/{session_id}/{asset_id}.{ext}"


@dataclass
class Ctx:
    table_name: str
    assets_bucket: str
    cdn_domain: str
    video_bucket: str
    video_region: str
    image_region: str
    queue_bucket: str
    queue_prefix: str
    deadline_farm_id: str
    deadline_queue_id: str
    agent_model_id: str
    image_model_id: str
    remove_bg_model_id: str
    video_model_id: str
    ffmpeg_bin: str
    ffprobe_bin: str
    font_path: str
    # boto3 clients / resources (injected; None → build lazily via from_env)
    s3: object = field(default=None)
    bedrock_rt_east: object = field(default=None)
    bedrock_rt_west: object = field(default=None)
    bedrock_rt_quick: object = field(default=None)  # us-east-1, gives up in seconds (bedrock_image.grip_side)
    deadline: object = field(default=None)
    lambda_: object = field(default=None)
    cognito: object = field(default=None)
    table: object = field(default=None)
    ssm: object = field(default=None)  # reads the mediagen MCP API key (SecureString)
    sqs: object = field(default=None)  # img3d job queue
    ec2: object = field(default=None)  # starts the img3d GPU box
    ec2_launch: object = field(default=None)  # same, without SDK retries (relocating launches)
    img3d_queue_url: str = ""
    ivs: object = field(default=None)  # the live channel: ad breaks, timed metadata, stream state (server/live.py)
    scheduler: object = field(default=None)  # EventBridge Scheduler: the agents' own schedules (server/agents.py)

    @classmethod
    def from_env(cls) -> "Ctx":
        import boto3
        s3 = boto3.client("s3", region_name="us-east-1")
        from botocore.config import Config
        # a full authored GameSpec is 3-6k output tokens: 60 s (the default) cut such answers off and retried them
        bedrock_rt_east = boto3.client("bedrock-runtime", region_name="us-east-1",
                                       config=Config(read_timeout=600, retries={"max_attempts": 2}))
        bedrock_rt_west = boto3.client("bedrock-runtime", region_name="us-west-2")
        deadline = boto3.client("deadline", region_name="us-east-1")
        lambda_ = boto3.client("lambda", region_name="us-east-1")
        cognito = boto3.client("cognito-idp", region_name="us-east-1")
        ssm = boto3.client("ssm", region_name="us-east-1")
        sqs = boto3.client("sqs", region_name="us-east-1")
        ec2 = boto3.client("ec2", region_name="us-east-1")
        from botocore.config import Config
        ec2_launch = boto3.client("ec2", region_name="us-east-1", config=Config(retries={"total_max_attempts": 1}))
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        table_name = os.environ.get("TABLE_NAME", "ipverse-main")
        table = ddb.Table(table_name)
        return cls(
            table_name=table_name,
            assets_bucket=os.environ.get("ASSETS_BUCKET", ""),
            cdn_domain=os.environ.get("CDN_DOMAIN", ""),
            video_bucket=os.environ.get("VIDEO_BUCKET", ""),
            video_region=os.environ.get("VIDEO_REGION", "us-west-2"),
            image_region=os.environ.get("IMAGE_REGION", "us-west-2"),
            queue_bucket=os.environ.get(
                "QUEUE_BUCKET", "griptapenode-queue-087967639890-us-east-1-an"
            ),
            queue_prefix=os.environ.get("QUEUE_PREFIX", "DeadlineCloud/ipverse"),
            deadline_farm_id=os.environ.get("DEADLINE_FARM_ID", ""),
            deadline_queue_id=os.environ.get("DEADLINE_QUEUE_ID", ""),
            agent_model_id=os.environ.get(
                "AGENT_MODEL_ID", "global.anthropic.claude-sonnet-5-5"
            ),
            image_model_id=os.environ.get(
                "IMAGE_MODEL_ID", "stability.stable-image-ultra-v1:1"
            ),
            remove_bg_model_id=os.environ.get(
                "REMOVE_BG_MODEL_ID", "us.stability.stable-image-remove-background-v1:0"
            ),
            video_model_id=os.environ.get("VIDEO_MODEL_ID", "luma.ray-v2:0"),
            ffmpeg_bin=os.environ.get("FFMPEG_BIN", "ffmpeg"),
            # empty → no ffprobe: ffmpeg.py then reads the duration from ffmpeg's own stderr
            ffprobe_bin=os.environ.get("FFPROBE_BIN", "ffprobe").strip(),
            font_path=os.environ.get(
                "FONT_PATH", "/opt/fonts/NotoSansKR-Bold.otf"
            ),
            s3=s3,
            bedrock_rt_east=bedrock_rt_east,
            bedrock_rt_west=bedrock_rt_west,
            bedrock_rt_quick=boto3.client("bedrock-runtime", region_name="us-east-1", config=Config(
                connect_timeout=2, read_timeout=5, retries={"total_max_attempts": 1})),
            deadline=deadline,
            lambda_=lambda_,
            cognito=cognito,
            table=table,
            ssm=ssm,
            sqs=sqs,
            ec2=ec2,
            ec2_launch=ec2_launch,
            ivs=boto3.client("ivs", region_name="us-east-1"),
            scheduler=boto3.client("scheduler", region_name="us-east-1"),
            img3d_queue_url=os.environ.get(
                "IMG3D_QUEUE_URL", "https://sqs.us-east-1.amazonaws.com/087967639890/ipverse-img3d-jobs"
            ),
        )


class JobProvider(Protocol):
    name: str

    def submit(self, job: dict, ctx: "Ctx") -> str:
        ...  # returns externalId

    def status(self, job: dict, ctx: "Ctx") -> tuple:
        ...  # ("running"|"done"|"failed", progress_text)

    def collect(self, job: dict, ctx: "Ctx") -> list:
        ...  # asset dicts to store
