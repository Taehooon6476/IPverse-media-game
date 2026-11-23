"""UE5 + Amazon GameLift Streams placeholder stack (us-west-2).

Registered in app.py as IpverseStreams; deployed by hand (scripts/deploy.sh does not touch it). See docs/ue5/design.md.

Defaults are zero-cost: the stream group gets MaxCapacity=0 (no streams possible, nothing billed),
and the Application is only created once BuildVersion points at an uploaded packaged UE5 build.
Deploy order: this stack parked (bucket only matters) -> IpverseUe5Build packages into
s3://<BuildsBucketName>/ipverse-ue5/<version>/app/ -> redeploy with BuildVersion=<version> MaxCapacity=1.
"""
from aws_cdk import (
    CfnCondition,
    CfnOutput,
    CfnParameter,
    Fn,
    RemovalPolicy,
    Stack,
    aws_gameliftstreams as gls,
    aws_iam as iam,
    aws_s3 as s3,
)
from constructs import Construct

# Cheapest classes that plausibly run a UE5 build at 1080p60 (Linux/Proton first). Prices: design.md.
STREAM_CLASSES = ["gen6n_high", "gen4n_high", "gen6n_ultra", "gen5n_high", "gen4n_win2022", "gen6n_ultra_win2022"]
EXECUTABLE = "IpverseGame.sh"  # UE5 Linux package launcher at the package root
LOG_PATHS = ["IpverseGame/Saved/Logs/"]  # relative to the package root


class StreamsStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        build_version = CfnParameter(
            self, "BuildVersion", type="String", default="",
            description="Version under ipverse-ue5/ whose app/ holds the packaged UE5 Linux build. Empty = no Application yet.",
        )
        stream_class = CfnParameter(
            self, "StreamClass", type="String", default="gen6n_high", allowed_values=STREAM_CLASSES,
            description="Stream class (immutable after creation). gen6n_high = L4, 2 sessions per GPU.",
        )
        max_capacity = CfnParameter(
            self, "MaxCapacity", type="Number", default=0, min_value=0, max_value=10,
            description="On-demand ceiling. 0 = parked (no streams, no capacity charges).",
        )
        always_on = CfnParameter(
            self, "AlwaysOnCapacity", type="Number", default=0, min_value=0, max_value=10,
            description="Always-on (billed every hour). Raise only for a scheduled demo window.",
        )
        seoul_capacity = CfnParameter(
            self, "SeoulMaxCapacity", type="Number", default=0, min_value=0, max_value=10,
            description="On-demand ceiling in remote location ap-northeast-2 (Korean players). 0 = location not added.",
        )
        web_version = CfnParameter(
            self, "WebPlayerVersion", type="String", default="v1",
            description="Version under ipverse-web-player/ (scripts/build_stream_shell.py) for three.js games.",
        )
        web_class = CfnParameter(
            self, "WebStreamClass", type="String", default="gen4n_win2022",
            allowed_values=["gen4n_win2022", "gen5n_win2022", "gen6n_pro_win2022"],
            description="Windows stream class for the web player (immutable after creation).",
        )
        web_capacity = CfnParameter(
            self, "WebMaxCapacity", type="Number", default=2, min_value=0, max_value=10,
            description="On-demand ceiling for web-player streams (billed only while a stream runs).",
        )
        has_seoul = CfnCondition(self, "HasSeoul", expression=Fn.condition_not(Fn.condition_equals(seoul_capacity.value_as_string, "0")))
        has_build = CfnCondition(self, "HasBuild", expression=Fn.condition_not(Fn.condition_equals(build_version.value_as_string, "")))

        # ── packaged builds + session logs: private, TLS only ─────────────────
        builds = s3.Bucket(
            self, "BuildsBucket",
            bucket_name=f"ipverse-ue5-builds-{self.account}-{self.region}",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,  # SSE-KMS would also need a key policy for the service
            enforce_ssl=True,
            versioned=True,
            removal_policy=RemovalPolicy.RETAIN,
        )
        service = iam.ServicePrincipal("gameliftstreams.amazonaws.com")
        same_account = {"StringEquals": {"aws:SourceAccount": self.account}}
        builds.add_to_resource_policy(iam.PolicyStatement(
            principals=[service], actions=["s3:GetObject", "s3:ListBucket"],
            resources=[builds.bucket_arn, builds.arn_for_objects("ipverse-ue5/*"),
                       builds.arn_for_objects("ipverse-web-player/*")], conditions=same_account,
        ))
        builds.add_to_resource_policy(iam.PolicyStatement(
            principals=[service], actions=["s3:PutObject"],
            resources=[builds.arn_for_objects("logs/*")], conditions=same_account,
        ))

        # ── application: one template game, every IPverse game is data (spec URL) ──
        app = gls.CfnApplication(
            self, "TemplateGame",
            description="IPverse UE5 template game",
            application_source_uri=f"s3://{builds.bucket_name}/ipverse-ue5/{build_version.value_as_string}/app/",
            executable_path=EXECUTABLE,
            runtime_environment=gls.CfnApplication.RuntimeEnvironmentProperty(type="UBUNTU", version="22_04_LTS"),
            application_log_output_uri=f"s3://{builds.bucket_name}/logs/",
            application_log_paths=LOG_PATHS,
        )
        app.cfn_options.condition = has_build
        app.node.add_dependency(builds.policy)  # service must be able to read the build at create time

        group = gls.CfnStreamGroup(
            self, "StreamGroup",
            description="IPverse UE5 streams",
            stream_class=stream_class.value_as_string,
            location_configurations=[
                gls.CfnStreamGroup.LocationConfigurationProperty(
                    location_name=self.region,
                    always_on_capacity=always_on.value_as_number,
                    maximum_capacity=max_capacity.value_as_number,
                    target_idle_capacity=0,
                ),
                # Seoul has no GameLift Streams API endpoint; it is a remote location of this us-west-2 group.
                Fn.condition_if(
                    has_seoul.logical_id,
                    {"LocationName": "ap-northeast-2", "AlwaysOnCapacity": 0,
                     "MaximumCapacity": seoul_capacity.value_as_number, "TargetIdleCapacity": 0},
                    Fn.ref("AWS::NoValue"),
                ),
            ],
            default_application=Fn.condition_if(
                has_build.logical_id,
                {"Id": app.attr_id},
                Fn.ref("AWS::NoValue"),
            ),
        )

        # ── web player: every three.js IPverse game in one Chromium shell (IPVERSE_GAME_URL per session) ──
        web_app = gls.CfnApplication(
            self, "WebPlayer",
            description="IPverse web player - Electron for three.js games and playable ads",
            application_source_uri=f"s3://{builds.bucket_name}/ipverse-web-player/{web_version.value_as_string}/app/",
            executable_path="ipverse-player.exe",
            runtime_environment=gls.CfnApplication.RuntimeEnvironmentProperty(type="WINDOWS", version="2022"),
        )
        web_app.node.add_dependency(builds.policy)
        web_group = gls.CfnStreamGroup(
            self, "WebStreamGroup",
            description="IPverse three.js games and playable ads",
            stream_class=web_class.value_as_string,
            location_configurations=[gls.CfnStreamGroup.LocationConfigurationProperty(
                location_name=self.region, always_on_capacity=0,
                maximum_capacity=web_capacity.value_as_number, target_idle_capacity=0)],
            # ponytail: on first create this left the group with no app; ran `aws gameliftstreams associate-applications` once
            default_application={"Id": web_app.attr_id},
        )

        # ── what the (us-east-1) API Lambda needs; IAM is global, attach by ARN ──
        arn = f"arn:{self.partition}:gameliftstreams:{self.region}:{self.account}"
        policy = iam.ManagedPolicy(
            self, "ApiStreamAccess",
            managed_policy_name="ipverse-api-gameliftstreams",  # IpverseCore attaches it by name
            description="IPverse API Lambda: start/poll/stop UE5 stream sessions in one stream group",
            statements=[iam.PolicyStatement(
                actions=[
                    "gameliftstreams:StartStreamSession",
                    "gameliftstreams:GetStreamSession",
                    "gameliftstreams:TerminateStreamSession",
                    "gameliftstreams:CreateStreamSessionConnection",  # reconnect after a dropped tab
                    "gameliftstreams:GetStreamGroup",  # default application = current build
                ],
                resources=[
                    group.attr_arn, web_group.attr_arn,
                    f"{arn}:application/*",  # the app is conditional; the stream group scopes the session
                    f"{arn}:streamsession/{group.attr_id}/*",
                    f"{arn}:streamsession/{web_group.attr_id}/*",
                ],
            )],
        )

        CfnOutput(self, "BuildsBucketName", value=builds.bucket_name)
        CfnOutput(self, "WebStreamGroupId", value=web_group.attr_id)
        CfnOutput(self, "WebApplicationId", value=web_app.attr_id)
        CfnOutput(self, "StreamGroupId", value=group.attr_id)
        CfnOutput(self, "ApiStreamPolicyArn", value=policy.managed_policy_arn)
        out = CfnOutput(self, "ApplicationId", value=app.attr_id)
        out.condition = has_build
