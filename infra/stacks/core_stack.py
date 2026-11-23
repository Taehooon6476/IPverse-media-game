import pathlib
import aws_cdk as cdk
from aws_cdk import (
    aws_ec2 as ec2,
    aws_events as events,
    aws_scheduler as scheduler,
    aws_events_targets as events_targets,
    aws_s3 as s3,
    aws_dynamodb as dynamodb,
    aws_cognito as cognito,
    aws_lambda as lambda_,
    aws_iam as iam,
    aws_cloudfront as cloudfront,
    aws_cloudfront_origins as origins,
    aws_ssm as ssm,
    CfnOutput,
    Duration,
    RemovalPolicy,
)
from constructs import Construct

# Default root: two levels up from this file (works for both cdk CLI and pytest)
_DEFAULT_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent

ACCOUNT = "087967639890"
REGION = "us-east-1"
DEADLINE_FARM = "farm-7e90f6ad8b8d4a99a614f5e0db148f36"
DEADLINE_QUEUE = "queue-3a8f02c1a75d4bef86411923256597ac"
STREAM_GROUP_ID = "sg-awoQFa2Sf"  # IpverseStreams output StreamGroupId
WEB_STREAM_GROUP_ID = "sg-8l9Y9wg67"  # IpverseStreams output WebStreamGroupId (Electron web player, Windows)
STREAMS_POLICY_NAME = "ipverse-api-gameliftstreams"
FUNCTION_NAME = "ipverse-api"
CDN_DISTRIBUTION_PARAM = "/ipverse/cdn-distribution-id"  # SSM: the distribution's id (server/store.py _invalidate)
IMG3D_QUEUE = "ipverse-img3d-jobs.fifo"  # IpverseImg3d stack's FIFO queue; by name, no cross-stack export
# 스킬 · Agent 등록 (server/agents.py): agent schedules, the open-model scout's GPU trial boxes and their promotion
AGENTS_SCHEDULE_GROUP = "ipverse-agents"
TRIAL_VPC = "vpc-0048f3a571ac6b876"  # default VPC: public subnets, the trial box only needs egress
TRIAL_AMI = "ami-012ba162b9cd2729c"  # Deep Learning AMI (Ubuntu 22.04, PyTorch), the harness's trial AMI; -c trialAmi=
TRIAL_INSTANCE_TYPES = ["g6e.xlarge", "g6e.2xlarge", "g6e.4xlarge", "g6e.8xlarge", "g6e.16xlarge", "g6e.12xlarge"]  # agents.INSTANCE_COST
HF_TOKEN_PARAM = "/mediagen/hf-token"  # SSM SecureString the harness's trial boxes read too; never in user-data
# mediagen-infra (mediagen/infra.json): the fleet SG (port 8000, API-key protected) and the narrow promoted-box profile
FLEET_SG = "sg-07314d21c31296a92"
PROMOTED_ROLE = "mediagen-promoted-instance"
MEDIAGEN_OUT = "mediagen-out-{account}-{region}"
MEDIAGEN_CDN = "d511j70n4osuv.cloudfront.net"


class CoreStack(cdk.Stack):
    def __init__(self, scope: Construct, id: str, root: pathlib.Path = _DEFAULT_ROOT, img3d=None, live=None, **kwargs):
        """img3d: the IpverseImg3d stack (its launch template and worker role scope the GPU-box grants)."""
        super().__init__(scope, id, **kwargs)
        root = pathlib.Path(root)

        account = self.account
        region = self.region

        # ── S3 assets bucket ──────────────────────────────────────────────────
        bucket = s3.Bucket(
            self,
            "AssetsBucket",
            bucket_name=f"ipverse-assets-{account}-{region}",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            versioned=False,
            removal_policy=RemovalPolicy.RETAIN,
            cors=[
                s3.CorsRule(
                    # PUT: the play window uploads round recordings with a presigned URL (live highlights)
                    allowed_methods=[s3.HttpMethods.GET, s3.HttpMethods.HEAD, s3.HttpMethods.PUT],
                    allowed_origins=["*"],
                    allowed_headers=["*"],
                )
            ],
        )

        # ── DynamoDB ──────────────────────────────────────────────────────────
        table = dynamodb.Table(
            self,
            "MainTable",
            table_name="ipverse-main",
            partition_key=dynamodb.Attribute(name="pk", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="sk", type=dynamodb.AttributeType.STRING),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            removal_policy=RemovalPolicy.RETAIN,
        )

        # ── Cognito ───────────────────────────────────────────────────────────
        user_pool = cognito.UserPool(
            self,
            "UserPool",
            user_pool_name="ipverse-users",
            self_sign_up_enabled=False,
            password_policy=cognito.PasswordPolicy(
                min_length=12,
                require_uppercase=True,
                require_lowercase=True,
                require_digits=True,
                require_symbols=True,
            ),
            removal_policy=RemovalPolicy.RETAIN,
        )

        client = user_pool.add_client(
            "WebClient",
            user_pool_client_name="ipverse-web",
            generate_secret=False,
            auth_flows=cognito.AuthFlow(
                user_password=True,
                user_srp=False,
            ),
            access_token_validity=Duration.hours(8),
            refresh_token_validity=Duration.days(30),
        )

        # ── ffmpeg layer ──────────────────────────────────────────────────────
        ffmpeg_layer = lambda_.LayerVersion(
            self,
            "FfmpegLayer",
            code=lambda_.Code.from_asset(str(root / "build" / "ffmpeg-layer")),
            compatible_runtimes=[lambda_.Runtime.PYTHON_3_12],
            description="ffmpeg static binary + NotoSansKR font",
        )

        # ── Lambda function ───────────────────────────────────────────────────
        fn = lambda_.Function(
            self,
            "ApiFunction",
            function_name=FUNCTION_NAME,
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="server.app.handler",
            code=lambda_.Code.from_asset(str(root / "build" / "server")),
            memory_size=2048,
            timeout=Duration.seconds(900),  # agent turns that write large game specs
            ephemeral_storage_size=cdk.Size.mebibytes(2048),
            layers=[ffmpeg_layer],
            environment={
                "TABLE_NAME": table.table_name,
                "ACCOUNT_ID": account,  # Bedrock Pegasus s3Location.bucketOwner
                "ASSETS_BUCKET": bucket.bucket_name,
                "CDN_DOMAIN": "",  # filled after CF domain is known; overridden via cfn output ref
                "CDN_DISTRIBUTION_PARAM": CDN_DISTRIBUTION_PARAM,
                "VIDEO_BUCKET": f"ipverse-video-{account}-us-west-2",
                "VIDEO_REGION": "us-west-2",
                "IMAGE_REGION": "us-west-2",
                "QUEUE_BUCKET": f"griptapenode-queue-{account}-us-east-1-an",
                "QUEUE_PREFIX": "DeadlineCloud/ipverse",
                "DEADLINE_FARM_ID": DEADLINE_FARM,
                "DEADLINE_QUEUE_ID": DEADLINE_QUEUE,
                "USER_POOL_ID": user_pool.user_pool_id,
                "CLIENT_ID": client.user_pool_client_id,
                "AGENT_MODEL_ID": "global.anthropic.claude-sonnet-5-5",
                "IMAGE_MODEL_ID": "stability.stable-image-ultra-v1:1",
                "REMOVE_BG_MODEL_ID": "us.stability.stable-image-remove-background-v1:0",
                "VIDEO_MODEL_ID": "luma.ray-v2:0",
                # UE5 over GameLift Streams (IpverseStreams, us-west-2); the app id comes from the group's default
                "STREAMS_REGION": "us-west-2",
                "STREAM_GROUP_ID": STREAM_GROUP_ID,
                "WEB_STREAM_GROUP_ID": WEB_STREAM_GROUP_ID,
                "STREAM_LOCATIONS": "us-west-2",
                "RUNTIME_PREFIX": "runtime/v1/",
                "FFMPEG_BIN": "/opt/bin/ffmpeg",
                "FFPROBE_BIN": "",  # ffprobe not shipped; server uses ffmpeg -i for probing
                "FONT_PATH": "/opt/fonts/NotoSansKR-Bold.otf",
                "SELF_FUNCTION_NAME": FUNCTION_NAME,
                # video shots run on the account's mediagen GPU boxes through its MCP proxy
                "VIDEOGEN_MCP_URL": "https://v2hgkct6d2.execute-api.us-east-1.amazonaws.com/mcp",
                "VIDEOGEN_KEY_PARAM": "/mediagen/mcp-api-key",
                # IP images (Krea 2 Turbo, FLUX.2 klein 9B) run on the storyboard GPU box through its MCP proxy
                "IMAGEGEN_MCP_URL": "https://77fmd8ppzh.execute-api.us-east-1.amazonaws.com/mcp",
                "IMAGEGEN_KEY_PARAM": "/storyboard-mcp/api-key",
                # image-to-3D (Hunyuan3D-2.1) on the IpverseImg3d GPU box: SQS in, S3 img3d/* out
                "IMG3D_QUEUE_URL": f"https://sqs.{region}.amazonaws.com/{account}/{IMG3D_QUEUE}",
                # gameplay live stream (IpverseLive): the play window -> Amazon IVS; ads by IVS ad insertion with
                # MediaTailor (scripts/setup_ivs_ads.py). The bucket holds the job files and the ad's VAST.
                **({"LIVE_BUCKET": live.bucket.bucket_name,
                    # the key reaches only signed-in users through /live
                    "LIVE_IVS_INGEST": live.ivs_ingest, "LIVE_IVS_KEY": live.ivs_key} if live is not None else {}),
            },
        )

        # CDN_DOMAIN is a self-reference via CloudFront — set via CfnOutput token
        # We patch it after distribution is created below.

        # ── IAM grants ───────────────────────────────────────────────────────
        table.grant_read_write_data(fn)

        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["bedrock:InvokeModel", "bedrock:Converse",
                     "bedrock:StartAsyncInvoke", "bedrock:GetAsyncInvoke"],
            resources=["*"],
        ))

        deadline_farm_arn = f"arn:aws:deadline:{region}:{account}:farm/{DEADLINE_FARM}"
        deadline_queue_arn = f"arn:aws:deadline:{region}:{account}:farm/{DEADLINE_FARM}/queue/{DEADLINE_QUEUE}"
        deadline_job_arn = f"arn:aws:deadline:{region}:{account}:farm/{DEADLINE_FARM}/queue/{DEADLINE_QUEUE}/job/*"
        # Deadline evaluates CreateJob against the queue/job/* ARN; grant all four actions
        # on all three ARNs (farm, queue, queue/job/*) to cover current and future auth checks.
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["deadline:CreateJob", "deadline:GetJob", "deadline:ListJobs", "deadline:GetQueue",
                     "deadline:UpdateJob"],  # UpdateJob: the 중지 button cancels the Deadline job
            resources=[deadline_farm_arn, deadline_queue_arn, deadline_job_arn],
        ))

        bucket.grant_read_write(fn)

        # GameLift Streams session calls; the policy is owned by IpverseStreams (IAM is global)
        fn.role.add_managed_policy(iam.ManagedPolicy.from_managed_policy_name(
            self, "Ue5StreamsPolicy", STREAMS_POLICY_NAME))

        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
            resources=[
                f"arn:aws:s3:::ipverse-video-{account}-us-west-2",
                f"arn:aws:s3:::ipverse-video-{account}-us-west-2/*",
            ],
        ))

        fn.add_to_role_policy(iam.PolicyStatement(
            # DeleteObject: a deleted session's turntable and rig copies (server/store.py _scratch)
            actions=["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            resources=[
                f"arn:aws:s3:::griptapenode-queue-{account}-us-east-1-an/DeadlineCloud/ipverse/*",
            ],
        ))
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["s3:ListBucket"],
            resources=[
                f"arn:aws:s3:::griptapenode-queue-{account}-us-east-1-an",
            ],
            conditions={
                "StringLike": {"s3:prefix": ["DeadlineCloud/ipverse/*"]},
            },
        ))

        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["cognito-idp:GetUser"],
            resources=["*"],
        ))
        fn.add_to_role_policy(iam.PolicyStatement(  # POST /api/demo-login: the shared demo account's password
            actions=["secretsmanager:GetSecretValue"],
            resources=[f"arn:aws:secretsmanager:{region}:{account}:secret:ipverse/demo-user-*"],
        ))
        fn.add_to_role_policy(iam.PolicyStatement(  # POST /api/signup: instant demo accounts
            actions=["cognito-idp:AdminCreateUser", "cognito-idp:AdminSetUserPassword", "cognito-idp:AdminDeleteUser"],
            resources=[user_pool.user_pool_arn],
        ))

        # the video and image MCP proxy API keys (SecureStrings, AWS-managed KMS key)
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["ssm:GetParameter"],
            resources=[f"arn:aws:ssm:us-east-1:{account}:parameter/mediagen/mcp-api-key",
                       f"arn:aws:ssm:us-east-1:{account}:parameter/storyboard-mcp/api-key"],
        ))
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["kms:Decrypt"],
            resources=["*"],
            conditions={"StringEquals": {"kms:ViaService": "ssm.us-east-1.amazonaws.com"}},
        ))

        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["lambda:InvokeFunction"],
            resources=[f"arn:aws:lambda:{region}:{account}:function:{FUNCTION_NAME}"],
        ))

        # img3d: enqueue jobs and wake the GPU box (found by its tag). DescribeInstances has no
        # resource-level permissions, so it stays on "*"; StartInstances is limited to ipverse=img3d.
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["sqs:SendMessage"],
            resources=[f"arn:aws:sqs:{region}:{account}:{IMG3D_QUEUE}"],
        ))
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["ec2:StartInstances"],
            resources=[f"arn:aws:ec2:{region}:{account}:instance/*"],
            conditions={"StringEquals": {"aws:ResourceTag/ipverse": "img3d"}},
        ))
        fn.add_to_role_policy(iam.PolicyStatement(actions=["ec2:DescribeInstances"], resources=["*"]))
        # relocation: when the box's AZ has no g6e capacity, launch a replacement from the img3d launch
        # template (only that template, only its worker role, tags only at launch) and retire the old box
        ec2_arn = f"arn:aws:ec2:{region}:{account}"
        if img3d is not None:
            lt_arn = f"{ec2_arn}:launch-template/{img3d.launch_template.launch_template_id}"
            role_arn = img3d.worker_role.role_arn
        else:  # Core synthesized alone (tests): same scope by name pattern
            lt_arn = f"{ec2_arn}:launch-template/*"
            role_arn = f"arn:aws:iam::{account}:role/IpverseImg3d-WorkerRole*"
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["ec2:RunInstances"],
            resources=[f"{ec2_arn}:{r}/*" for r in ("instance", "volume", "network-interface", "subnet",
                                                    "security-group", "launch-template", "image")]
                      + [f"arn:aws:ec2:{region}::image/*"],
            conditions={"ArnLike": {"ec2:LaunchTemplate": lt_arn}},
        ))
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["ec2:CreateTags"],
            resources=[f"{ec2_arn}:instance/*", f"{ec2_arn}:volume/*"],
            conditions={"StringEquals": {"ec2:CreateAction": "RunInstances"}},
        ))
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["iam:PassRole"], resources=[role_arn],
            conditions={"StringEquals": {"iam:PassedToService": "ec2.amazonaws.com"}},
        ))
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["ec2:TerminateInstances"],
            resources=[f"{ec2_arn}:instance/*"],
            conditions={"StringEquals": {"aws:ResourceTag/ipverse": "img3d"}},
        ))

        # live stream (server/live.py): the IVS channel (stream state, ad breaks, timed metadata), the VAST + job
        # files, and the web stream group's idle host while a playable broadcast runs
        if live is not None:
            fn.add_to_role_policy(iam.PolicyStatement(actions=["ivs:ListChannels"], resources=["*"]))
            fn.add_to_role_policy(iam.PolicyStatement(
                actions=["ivs:GetChannel", "ivs:GetStream", "ivs:InsertAdBreak", "ivs:PutMetadata", "ivs:StopStream"],
                resources=[f"arn:aws:ivs:{region}:{account}:channel/*"]))
            live.bucket.grant_read_write(fn)
            fn.add_to_role_policy(iam.PolicyStatement(
                actions=["gameliftstreams:UpdateStreamGroup"],
                resources=[f"arn:aws:gameliftstreams:us-west-2:{account}:streamgroup/*"]))
            # the private player channel: the playback tokens' ES384 key (scripts/setup_ivs_playback_key.py)
            fn.add_to_role_policy(iam.PolicyStatement(
                actions=["secretsmanager:GetSecretValue"],
                resources=[f"arn:aws:secretsmanager:{region}:{account}:secret:ipverse/ivs-playback-key-*"]))

        self._agents(fn, bucket, account, region, user_pool)

        # ── Function URL ─────────────────────────────────────────────────────
        # AWS_IAM required: account guardrail removes public (NONE) Function URL permissions.
        # CloudFront OAC signs origin requests with SigV4 using a non-public policy.
        fn_url = fn.add_function_url(
            auth_type=lambda_.FunctionUrlAuthType.AWS_IAM,
        )

        # Async self-invocations must not retry (prevents duplicate image-gen on timeout)
        fn.configure_async_invoke(retry_attempts=0)

        # ── CloudFront ───────────────────────────────────────────────────────
        # Create OAC once; share between both origins to avoid duplicate construct IDs
        oac = cloudfront.S3OriginAccessControl(self, "AssetsOAC")
        s3_origin_web = origins.S3BucketOrigin.with_origin_access_control(
            bucket,
            origin_access_control=oac,
            origin_path="/web",
        )
        s3_origin_raw = origins.S3BucketOrigin.with_origin_access_control(
            bucket,
            origin_access_control=oac,
        )
        # OAC on Lambda Function URL: CloudFront signs with SigV4; CDK grants
        # lambda:InvokeFunctionUrl to cloudfront.amazonaws.com scoped to this distribution.
        # read_timeout=60s: trailer renders can exceed the default 30s CF origin read timeout.
        api_origin = origins.FunctionUrlOrigin.with_origin_access_control(
            fn_url,
            read_timeout=Duration.seconds(60),
        )

        # SPA client-side routing: rewrite no-extension paths to /index.html on default behavior only.
        # Replaces CustomErrorResponses (which would swallow API 404s and S3 404s as 200 HTML).
        # a closed play window must not leave the IVS stream on or the GameLift Streams idle host held (server/live.py reap)
        events.Rule(self, "LiveReap", schedule=events.Schedule.rate(cdk.Duration.minutes(5)),
                    targets=[events_targets.LambdaFunction(fn, event=events.RuleTargetInput.from_object({"action": "live_reap"}))])

        spa_rewrite_fn = cloudfront.Function(
            self,
            "SpaRewrite",
            code=cloudfront.FunctionCode.from_inline(
                "function handler(event){"
                "var uri=event.request.uri;"
                "var last=uri.split('/').pop();"
                "if(!last||last.indexOf('.')===-1){event.request.uri='/index.html';}"
                "return event.request;"
                "}"
            ),
            runtime=cloudfront.FunctionRuntime.JS_2_0,
        )

        # A game's folder address opens its page: S3 behind the origin access control has no index document. With the
        # slash it serves the folder's index.html; without it the browser is sent to the folder (302, query kept) so the
        # page's relative files resolve. A last part with a dot is a file and passes. Only on /games/*: distribution-wide
        # error pages would replace the API's own 403 and 404 answers.
        games_index_fn = cloudfront.Function(
            self,
            "GamesIndex",
            code=cloudfront.FunctionCode.from_inline(
                "function handler(event){"
                "var r=event.request,uri=r.uri;"
                "if(uri.charAt(uri.length-1)==='/'){r.uri=uri+'index.html';return r;}"
                "if(uri.split('/').pop().indexOf('.')!==-1){return r;}"
                "var q=r.querystring,parts=[];"
                "for(var k in q){var vs=q[k].multiValue||[q[k]];"
                "for(var i=0;i<vs.length;i++){parts.push(vs[i].value===''?k:k+'='+vs[i].value);}}"
                "return {statusCode:302,statusDescription:'Found',"
                "headers:{location:{value:uri+'/'+(parts.length?'?'+parts.join('&'):'')}}};"
                "}"
            ),
            runtime=cloudfront.FunctionRuntime.JS_2_0,
        )

        distribution = cloudfront.Distribution(
            self,
            "Distribution",
            default_root_object="index.html",
            default_behavior=cloudfront.BehaviorOptions(
                origin=s3_origin_web,
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cache_policy=cloudfront.CachePolicy.CACHING_OPTIMIZED,
                allowed_methods=cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                function_associations=[
                    cloudfront.FunctionAssociation(
                        function=spa_rewrite_fn,
                        event_type=cloudfront.FunctionEventType.VIEWER_REQUEST,
                    )
                ],
            ),
            additional_behaviors={
                "/api/*": cloudfront.BehaviorOptions(
                    origin=api_origin,
                    viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cache_policy=cloudfront.CachePolicy.CACHING_DISABLED,
                    origin_request_policy=cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                    allowed_methods=cloudfront.AllowedMethods.ALLOW_ALL,
                ),
                "/sessions/*": cloudfront.BehaviorOptions(
                    origin=s3_origin_raw,
                    viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cache_policy=cloudfront.CachePolicy.CACHING_OPTIMIZED,
                    allowed_methods=cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                ),
                "/games/*": cloudfront.BehaviorOptions(
                    origin=s3_origin_raw,
                    viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cache_policy=cloudfront.CachePolicy.CACHING_OPTIMIZED,
                    allowed_methods=cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    function_associations=[
                        cloudfront.FunctionAssociation(
                            function=games_index_fn,
                            event_type=cloudfront.FunctionEventType.VIEWER_REQUEST,
                        )
                    ],
                ),
                "/runtime/*": cloudfront.BehaviorOptions(
                    origin=s3_origin_raw,
                    viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cache_policy=cloudfront.CachePolicy.CACHING_OPTIMIZED,
                    allowed_methods=cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                ),
            },
        )

        # ponytail: CDN_DOMAIN must be set post-deploy via deploy.sh (update-function-configuration)
        # to avoid CloudFormation circular dep: Lambda -> CF distribution -> FunctionUrl -> Lambda.
        # The placeholder "" is replaced in scripts/deploy.sh from build/outputs.json.

        # A deleted session's files leave the edges too (server/store.py _invalidate). The same cycle as CDN_DOMAIN: the
        # function's env and its role's default policy cannot name the distribution, so the id sits in a parameter the
        # function reads by name, and the grant, on this distribution alone, in a policy of its own.
        ssm.StringParameter(self, "CdnDistributionId", parameter_name=CDN_DISTRIBUTION_PARAM,
                            string_value=distribution.distribution_id)
        iam.Policy(self, "CdnInvalidation", roles=[fn.role], statements=[
            iam.PolicyStatement(
                actions=["cloudfront:CreateInvalidation"],
                resources=[f"arn:aws:cloudfront::{account}:distribution/{distribution.distribution_id}"]),
            iam.PolicyStatement(
                actions=["ssm:GetParameter"],
                resources=[f"arn:aws:ssm:{region}:{account}:parameter{CDN_DISTRIBUTION_PARAM}"]),
        ])

        # ── Outputs ───────────────────────────────────────────────────────────
        CfnOutput(self, "CdnDomainOutput", export_name="CdnDomain", value=distribution.distribution_domain_name)
        CfnOutput(self, "UserPoolIdOutput", export_name="UserPoolId", value=user_pool.user_pool_id)
        CfnOutput(self, "ClientIdOutput", export_name="ClientId", value=client.user_pool_client_id)
        CfnOutput(self, "AssetsBucketOutput", export_name="AssetsBucket", value=bucket.bucket_name)
        CfnOutput(self, "ApiFunctionNameOutput", export_name="ApiFunctionName", value=fn.function_name)

    def _agents(self, fn, bucket, account, region, user_pool):
        """스킬 · Agent 등록 (server/agents.py): EventBridge Scheduler for the agents, a 5-minute sweep, the GPU trial
        box (role, profile, SG: it runs LLM-written shell commands, so it is scoped tightly) and the API's grants to
        launch, park, promote and terminate it. Trial boxes carry mediagen=trial until 승인 retags them. The
        every-minute job tick (JobsAdvance) is here too: it is sent with the same scheduler role."""
        fn_arn = f"arn:aws:lambda:{region}:{account}:function:{FUNCTION_NAME}"
        ec2_arn = f"arn:aws:ec2:{region}:{account}"
        out_bucket = MEDIAGEN_OUT.format(account=account, region=region)
        ami = self.node.try_get_context("trialAmi") or TRIAL_AMI

        trial_role = iam.Role(self, "AgentsTrialRole", assumed_by=iam.ServicePrincipal("ec2.amazonaws.com"))
        trial_role.add_to_policy(iam.PolicyStatement(  # status/result/log out, its own agent script in
            actions=["s3:PutObject", "s3:GetObject"], resources=[bucket.arn_for_objects("agents/trials/*")]))
        trial_role.add_to_policy(iam.PolicyStatement(  # benchmark outputs behind the mediagen CDN
            actions=["s3:PutObject"], resources=[f"arn:aws:s3:::{out_bucket}/outputs/trials/*"]))
        trial_role.add_to_policy(iam.PolicyStatement(  # the fleet job server the model module is verified under
            actions=["s3:GetObject"], resources=[f"arn:aws:s3:::{out_bucket}/code/common/jobserver.py"]))
        trial_role.add_to_policy(iam.PolicyStatement(
            actions=["ssm:GetParameter"], resources=[f"arn:aws:ssm:{region}:{account}:parameter{HF_TOKEN_PARAM}"]))
        trial_role.add_to_policy(iam.PolicyStatement(
            actions=["kms:Decrypt"], resources=["*"],
            conditions={"StringEquals": {"kms:ViaService": f"ssm.{region}.amazonaws.com"}}))
        trial_role.add_to_policy(iam.PolicyStatement(  # Claude on the box (global and regional inference profiles)
            actions=["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse"],
            resources=["arn:aws:bedrock:*::foundation-model/anthropic.*", "arn:aws:bedrock:::foundation-model/anthropic.*",
                       f"arn:aws:bedrock:*:{account}:inference-profile/*"]))
        trial_profile = iam.CfnInstanceProfile(self, "AgentsTrialProfile", roles=[trial_role.role_name])
        trial_sg = ec2.CfnSecurityGroup(
            self, "AgentsTrialSecurityGroup", group_description="IPverse open-model scout GPU trials: egress only",
            vpc_id=TRIAL_VPC, security_group_egress=[ec2.CfnSecurityGroup.EgressProperty(ip_protocol="-1",
                                                                                          cidr_ip="0.0.0.0/0")])

        scheduler_role = iam.Role(self, "AgentsSchedulerRole", assumed_by=iam.ServicePrincipal(
            "scheduler.amazonaws.com", conditions={"StringEquals": {"aws:SourceAccount": account}}))
        scheduler_role.add_to_policy(iam.PolicyStatement(actions=["lambda:InvokeFunction"], resources=[fn_arn]))
        scheduler.CfnScheduleGroup(self, "AgentsScheduleGroup", name=AGENTS_SCHEDULE_GROUP)
        # trial progress, timeouts, parked boxes, benchmark baselines, the demo user's built-in scout
        scheduler.CfnSchedule(
            self, "AgentsSweep", schedule_expression="rate(5 minutes)", group_name="default",
            flexible_time_window=scheduler.CfnSchedule.FlexibleTimeWindowProperty(mode="OFF"),
            target=scheduler.CfnSchedule.TargetProperty(arn=fn_arn, role_arn=scheduler_role.role_arn,
                                                        input='{"action": "agents_sweep"}',
                                                        retry_policy=scheduler.CfnSchedule.RetryPolicyProperty(
                                                            maximum_retry_attempts=0)))
        # A job chain's next step with no studio tab open (server/jobs.py advance_active). The same role as the sweep (it
        # may only invoke this function); no retry, the next minute's tick is one. Idle, a tick is one read of an empty
        # partition.
        scheduler.CfnSchedule(
            self, "JobsAdvance", schedule_expression="rate(1 minute)", group_name="default",
            flexible_time_window=scheduler.CfnSchedule.FlexibleTimeWindowProperty(mode="OFF"),
            target=scheduler.CfnSchedule.TargetProperty(arn=fn_arn, role_arn=scheduler_role.role_arn,
                                                        input='{"action": "jobs_tick"}',
                                                        retry_policy=scheduler.CfnSchedule.RetryPolicyProperty(
                                                            maximum_retry_attempts=0)))

        env = {"AGENTS_SCHEDULE_GROUP": AGENTS_SCHEDULE_GROUP, "AGENTS_SCHEDULER_ROLE_ARN": scheduler_role.role_arn,
               "AGENTS_SELF_ARN": fn_arn, "SCOUT_DEFAULT_USERS": "demo",
               "TRIAL_INSTANCE_PROFILE_ARN": trial_profile.attr_arn, "TRIAL_SECURITY_GROUP": trial_sg.attr_group_id,
               "TRIAL_VPC": TRIAL_VPC, "TRIAL_AMI": ami, "TRIAL_OUTPUT_BUCKET": out_bucket,
               "TRIAL_OUTPUT_CDN": MEDIAGEN_CDN, "HF_TOKEN_PARAM": HF_TOKEN_PARAM, "FLEET_SECURITY_GROUP": FLEET_SG,
               "FLEET_INSTANCE_PROFILE_ARN": f"arn:aws:iam::{account}:instance-profile/{PROMOTED_ROLE}"}
        websearch_url = self.node.try_get_context("websearchGatewayUrl")  # the harness's AgentCore web-search gateway
        if websearch_url:
            env["WEBSEARCH_GATEWAY_URL"] = websearch_url
            fn.add_to_role_policy(iam.PolicyStatement(
                actions=["bedrock-agentcore:InvokeGateway"],
                resources=[self.node.try_get_context("websearchGatewayArn")
                           or f"arn:aws:bedrock-agentcore:{region}:{account}:gateway/*"]))
        for k, v in env.items():
            fn.add_environment(k, v)

        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule",
                     "scheduler:GetSchedule"],
            resources=[f"arn:aws:scheduler:{region}:{account}:schedule/{AGENTS_SCHEDULE_GROUP}/*"]))
        fn.add_to_role_policy(iam.PolicyStatement(actions=["iam:PassRole"], resources=[scheduler_role.role_arn],
                                                  conditions={"StringEquals": {"iam:PassedToService":
                                                                               "scheduler.amazonaws.com"}}))
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["iam:PassRole"], resources=[trial_role.role_arn, f"arn:aws:iam::{account}:role/{PROMOTED_ROLE}"],
            conditions={"StringEquals": {"iam:PassedToService": "ec2.amazonaws.com"}}))
        fn.add_to_role_policy(iam.PolicyStatement(  # the demo user's scout is seeded by the sweep
            actions=["cognito-idp:AdminGetUser"], resources=[user_pool.user_pool_arn]))
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["ec2:DescribeSubnets", "ec2:DescribeIamInstanceProfileAssociations"], resources=["*"]))
        # RunInstances: only the allowlisted GPU sizes, and every launch carries mediagen=trial ...
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["ec2:RunInstances"], resources=[f"{ec2_arn}:instance/*"],
            conditions={"StringEquals": {"ec2:InstanceType": TRIAL_INSTANCE_TYPES,
                                         "aws:RequestTag/mediagen": "trial"}}))
        # ... from this AMI, into this SG
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["ec2:RunInstances"],
            resources=[f"arn:aws:ec2:{region}::image/{ami}", f"{ec2_arn}:subnet/*", f"{ec2_arn}:network-interface/*",
                       f"{ec2_arn}:volume/*",
                       cdk.Fn.join("", [f"{ec2_arn}:security-group/", trial_sg.attr_group_id])]))
        # park (stop), promote (fleet SG + profile, the registry tags LAST) and terminate: only while mediagen=trial
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["ec2:TerminateInstances", "ec2:StopInstances", "ec2:ModifyInstanceAttribute",
                     "ec2:ReplaceIamInstanceProfileAssociation", "ec2:DisassociateIamInstanceProfile",
                     "ec2:AssociateIamInstanceProfile", "ec2:CreateTags"],
            resources=[f"{ec2_arn}:instance/*"],
            conditions={"StringEquals": {"aws:ResourceTag/mediagen": "trial"}}))
        fn.add_to_role_policy(iam.PolicyStatement(
            actions=["ec2:ModifyInstanceAttribute"], resources=[f"{ec2_arn}:security-group/{FLEET_SG}"]))
        CfnOutput(self, "AgentsTrialSecurityGroupOutput", value=trial_sg.attr_group_id)
