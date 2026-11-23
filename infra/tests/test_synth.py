"""
Synth tests — run with: infra/.venv/bin/python -m pytest infra/tests -v
Fixtures create placeholder build artifacts when real ones are absent.
"""
import os
import sys
import pathlib
import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]  # worktree root
sys.path.insert(0, str(ROOT / "infra"))

# ── fixture: ensure placeholder build artifacts exist ────────────────────────
@pytest.fixture(scope="session", autouse=True)
def build_artifacts(tmp_path_factory):
    # Bundle layout: build/server/server/app.py (handler: server.app.handler)
    server_pkg = ROOT / "build" / "server" / "server"
    server_pkg.mkdir(parents=True, exist_ok=True)
    app_py = server_pkg / "app.py"
    if not app_py.exists():
        app_py.write_text("def handler(event, context): pass\n")
    init_py = server_pkg / "__init__.py"
    if not init_py.exists():
        init_py.write_text("")

    layer_bin = ROOT / "build" / "ffmpeg-layer" / "bin"
    layer_bin.mkdir(parents=True, exist_ok=True)
    ffmpeg = layer_bin / "ffmpeg"
    if not ffmpeg.exists():
        ffmpeg.write_text("#!/bin/sh\necho ffmpeg placeholder\n")
        ffmpeg.chmod(0o755)


import aws_cdk as cdk
from aws_cdk.assertions import Template
from stacks.core_stack import CoreStack
from stacks.video_stack import VideoStack


@pytest.fixture(scope="session")
def core_template():
    app = cdk.App()
    stack = CoreStack(
        app,
        "IpverseCore",
        env=cdk.Environment(account="087967639890", region="us-east-1"),
    )
    return Template.from_stack(stack)


@pytest.fixture(scope="session")
def video_template():
    app = cdk.App()
    stack = VideoStack(
        app,
        "IpverseVideo",
        env=cdk.Environment(account="087967639890", region="us-west-2"),
    )
    return Template.from_stack(stack)


# ── Core stack assertions ─────────────────────────────────────────────────────

def test_dynamodb_table(core_template):
    core_template.resource_count_is("AWS::DynamoDB::Table", 1)
    core_template.has_resource_properties("AWS::DynamoDB::Table", {
        "KeySchema": [
            {"AttributeName": "pk", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        "BillingMode": "PAY_PER_REQUEST",
    })


def test_lambda_function(core_template):
    core_template.has_resource_properties("AWS::Lambda::Function", {
        "FunctionName": "ipverse-api",
        "Handler": "server.app.handler",
        "Runtime": "python3.12",
        "Timeout": 900,  # long agent turns (TURN_BUDGET_SEC 720)
        "MemorySize": 2048,
        "EphemeralStorage": {"Size": 2048},
    })


def test_lambda_env_agent_model(core_template):
    core_template.has_resource_properties("AWS::Lambda::Function", {
        "Environment": {
            "Variables": {
                "AGENT_MODEL_ID": "global.anthropic.claude-sonnet-5-5",
            }
        }
    })


def test_lambda_env_all_vars(core_template):
    """Every required env var is present; fixed-string vars have correct values."""
    required = [
        "TABLE_NAME", "ASSETS_BUCKET", "CDN_DOMAIN", "VIDEO_BUCKET",
        "VIDEO_REGION", "IMAGE_REGION", "QUEUE_BUCKET", "QUEUE_PREFIX",
        "DEADLINE_FARM_ID", "DEADLINE_QUEUE_ID", "USER_POOL_ID", "CLIENT_ID",
        "AGENT_MODEL_ID", "IMAGE_MODEL_ID", "REMOVE_BG_MODEL_ID",
        "VIDEO_MODEL_ID", "RUNTIME_PREFIX", "FFMPEG_BIN", "FFPROBE_BIN",
        "FONT_PATH", "SELF_FUNCTION_NAME",
    ]
    fixed_values = {
        "VIDEO_REGION": "us-west-2",
        "IMAGE_REGION": "us-west-2",
        "QUEUE_BUCKET": "griptapenode-queue-087967639890-us-east-1-an",
        "QUEUE_PREFIX": "DeadlineCloud/ipverse",
        "DEADLINE_FARM_ID": "farm-7e90f6ad8b8d4a99a614f5e0db148f36",
        "DEADLINE_QUEUE_ID": "queue-3a8f02c1a75d4bef86411923256597ac",
        "AGENT_MODEL_ID": "global.anthropic.claude-sonnet-5-5",
        "IMAGE_MODEL_ID": "stability.stable-image-ultra-v1:1",
        "REMOVE_BG_MODEL_ID": "us.stability.stable-image-remove-background-v1:0",
        "VIDEO_MODEL_ID": "luma.ray-v2:0",
        "RUNTIME_PREFIX": "runtime/v1/",
        "FFMPEG_BIN": "/opt/bin/ffmpeg",
        "FFPROBE_BIN": "",  # ffprobe not shipped; server uses ffmpeg -i
        "FONT_PATH": "/opt/fonts/NotoSansKR-Bold.otf",
        "SELF_FUNCTION_NAME": "ipverse-api",
        "VIDEOGEN_MCP_URL": "https://v2hgkct6d2.execute-api.us-east-1.amazonaws.com/mcp",
        "VIDEOGEN_KEY_PARAM": "/mediagen/mcp-api-key",
        "IMAGEGEN_MCP_URL": "https://77fmd8ppzh.execute-api.us-east-1.amazonaws.com/mcp",
        "IMAGEGEN_KEY_PARAM": "/storyboard-mcp/api-key",
    }
    resources = core_template.find_resources("AWS::Lambda::Function")
    fn_resources = [
        v for v in resources.values()
        if v.get("Properties", {}).get("FunctionName") == "ipverse-api"
    ]
    assert fn_resources, "ipverse-api function not found"
    env_vars = fn_resources[0]["Properties"]["Environment"]["Variables"]
    missing = [k for k in required if k not in env_vars]
    assert not missing, f"Missing env vars: {missing}"
    wrong = {k: (env_vars[k], want) for k, want in fixed_values.items() if env_vars.get(k) != want}
    assert not wrong, f"Wrong env var values: {wrong}"


def test_queue_list_bucket_condition(core_template):
    """ListBucket on griptape queue bucket must be scoped to DeadlineCloud/ipverse/* prefix."""
    resources = core_template.find_resources("AWS::IAM::Policy")
    queue_bucket = "griptapenode-queue-087967639890-us-east-1-an"
    found_condition = False
    for resource in resources.values():
        statements = resource.get("Properties", {}).get("PolicyDocument", {}).get("Statement", [])
        for stmt in statements:
            actions = stmt.get("Action", [])
            if isinstance(actions, str):
                actions = [actions]
            if "s3:ListBucket" not in actions:
                continue
            resources_in_stmt = stmt.get("Resource", [])
            if isinstance(resources_in_stmt, str):
                resources_in_stmt = [resources_in_stmt]
            bucket_arns = [r for r in resources_in_stmt if isinstance(r, str) and queue_bucket in r]
            if not bucket_arns:
                continue
            condition = stmt.get("Condition", {})
            string_like = condition.get("StringLike", {})
            prefix_cond = string_like.get("s3:prefix", [])
            if isinstance(prefix_cond, str):
                prefix_cond = [prefix_cond]
            if any("DeadlineCloud/ipverse" in p for p in prefix_cond):
                found_condition = True
                break
        if found_condition:
            break
    assert found_condition, "ListBucket on griptape queue bucket missing StringLike s3:prefix condition"


def test_deadline_create_job_includes_job_arn(core_template):
    """The IAM statement containing deadline:CreateJob must include the queue/job/* ARN."""
    job_arn = (
        "arn:aws:deadline:us-east-1:087967639890"
        ":farm/farm-7e90f6ad8b8d4a99a614f5e0db148f36"
        "/queue/queue-3a8f02c1a75d4bef86411923256597ac/job/*"
    )
    resources = core_template.find_resources("AWS::IAM::Policy")
    found = False
    for resource in resources.values():
        for stmt in resource.get("Properties", {}).get("PolicyDocument", {}).get("Statement", []):
            actions = stmt.get("Action", [])
            if isinstance(actions, str):
                actions = [actions]
            if "deadline:CreateJob" not in actions:
                continue
            arns = stmt.get("Resource", [])
            if isinstance(arns, str):
                arns = [arns]
            if job_arn in arns:
                found = True
                break
        if found:
            break
    assert found, f"deadline:CreateJob statement missing resource: {job_arn}"


def _statements(template):
    for resource in template.find_resources("AWS::IAM::Policy").values():
        for stmt in resource.get("Properties", {}).get("PolicyDocument", {}).get("Statement", []):
            actions = stmt.get("Action", [])
            resources = stmt.get("Resource", [])
            yield ([actions] if isinstance(actions, str) else actions,
                   [resources] if isinstance(resources, str) else resources, stmt.get("Condition"))


def test_mediagen_key_parameter_read(core_template):
    """The Lambda reads the two MCP proxy keys: GetParameter on exactly those parameters, KMS decrypt only via SSM."""
    key_arns = ["arn:aws:ssm:us-east-1:087967639890:parameter/mediagen/mcp-api-key",
                "arn:aws:ssm:us-east-1:087967639890:parameter/storyboard-mcp/api-key"]
    stmts = list(_statements(core_template))
    assert any("ssm:GetParameter" in a and r == key_arns for a, r, _ in stmts), "ssm:GetParameter grant missing"
    assert any(a == ["kms:Decrypt"] and r == ["*"]
               and c == {"StringEquals": {"kms:ViaService": "ssm.us-east-1.amazonaws.com"}}
               for a, r, c in stmts), "kms:Decrypt via SSM grant missing"


def test_session_delete_grants(core_template):
    """DELETE /api/sessions/{id} (server/store.py delete_session): lists and deletes the assets bucket's objects
    under sessions/<id>/ and games/<gameId>/, and deletes the session's table items."""
    bucket = core_template.find_resources("AWS::S3::Bucket")
    table = core_template.find_resources("AWS::DynamoDB::Table")
    [bucket_id], [table_id] = list(bucket), list(table)
    bucket_arn = {"Fn::GetAtt": [bucket_id, "Arn"]}
    objects_arn = {"Fn::Join": ["", [bucket_arn, "/*"]]}
    stmts = list(_statements(core_template))
    assert any("s3:DeleteObject*" in a and objects_arn in r for a, r, _ in stmts), "s3:DeleteObject on the assets bucket missing"
    assert any("s3:List*" in a and bucket_arn in r for a, r, _ in stmts), "s3:ListBucket on the assets bucket missing"
    assert any("dynamodb:DeleteItem" in a and {"Fn::GetAtt": [table_id, "Arn"]} in r for a, r, _ in stmts), \
        "dynamodb:DeleteItem on the table missing"


def test_session_delete_reaches_the_3d_jobs_scratch_in_the_queue_bucket(core_template):
    """A deleted session's turntable and rig copies under the queue bucket's DeadlineCloud/ipverse/<jobId>/ can be
    deleted (server/store.py _scratch). The mesh's img3d/in and img3d/out are in the assets bucket
    (test_session_delete_grants)."""
    queue = "arn:aws:s3:::griptapenode-queue-087967639890-us-east-1-an"
    on_queue = [(a, r, c) for a, r, c in _statements(core_template) if any(str(x).startswith(queue) for x in r)]
    # the bucket is shared (the Griptape farm's): the delete reaches the app's own prefix and nothing else in it
    assert [r for a, r, _ in on_queue if any(x.startswith("s3:Delete") for x in a)] == [[f"{queue}/DeadlineCloud/ipverse/*"]], \
        "s3:DeleteObject on exactly the queue bucket's DeadlineCloud/ipverse/* missing"
    assert (["s3:ListBucket"], [queue], {"StringLike": {"s3:prefix": ["DeadlineCloud/ipverse/*"]}}) in on_queue, \
        "prefix-scoped s3:ListBucket on the queue bucket missing"


def test_session_delete_reaches_the_edge_copies_of_this_distribution(core_template):
    """A deleted session's files are invalidated at the CDN (server/store.py _invalidate). The function reads the
    distribution's id from a parameter the stack writes: its env cannot name the distribution, nor can its role's
    default policy, which it depends on (the CDN_DOMAIN cycle; Template.from_stack refuses one)."""
    [dist] = core_template.find_resources("AWS::CloudFront::Distribution")
    dist_arn = {"Fn::Join": ["", ["arn:aws:cloudfront::087967639890:distribution/", {"Ref": dist}]]}
    name = "/ipverse/cdn-distribution-id"
    stmts = [(a, r if isinstance(r, list) else [r]) for a, r, c in _statements(core_template) if c is None]
    # other projects' distributions live in this account: the grant names this one, and invalidations only
    on_cdn = [(a, r) for a, r in stmts if any(x.startswith("cloudfront:") for x in a)]
    assert on_cdn == [(["cloudfront:CreateInvalidation"], [dist_arn])], \
        "cloudfront:CreateInvalidation on exactly this distribution missing"
    params = [p["Properties"] for p in core_template.find_resources("AWS::SSM::Parameter").values()]
    assert params == [{"Name": name, "Type": "String", "Value": {"Ref": dist}}], \
        "the parameter holding the distribution's id missing"
    assert (["ssm:GetParameter"], [f"arn:aws:ssm:us-east-1:087967639890:parameter{name}"]) in stmts, \
        "ssm:GetParameter on the distribution id's parameter missing"
    core_template.has_resource_properties("AWS::Lambda::Function", {
        "FunctionName": "ipverse-api", "Environment": {"Variables": cdk.assertions.Match.object_like(
            {"CDN_DISTRIBUTION_PARAM": name})}})


def test_cloudfront_cache_behaviors(core_template):
    resources = core_template.find_resources("AWS::CloudFront::Distribution")
    assert resources, "No CloudFront distribution found"
    dist = list(resources.values())[0]
    behaviors = dist["Properties"]["DistributionConfig"].get("CacheBehaviors", [])
    patterns = {b["PathPattern"] for b in behaviors}
    for expected in ["/api/*", "/sessions/*", "/games/*", "/runtime/*"]:
        assert expected in patterns, f"Missing CloudFront behavior: {expected}"


def test_cognito_user_pool_client(core_template):
    core_template.has_resource_properties("AWS::Cognito::UserPoolClient", {
        "ExplicitAuthFlows": cdk.assertions.Match.array_with(
            ["ALLOW_USER_PASSWORD_AUTH"]
        ),
    })


def test_spa_cf_function_on_default_behavior(core_template):
    """Default behavior has a FunctionAssociation (viewer-request); no CustomErrorResponses."""
    resources = core_template.find_resources("AWS::CloudFront::Distribution")
    assert resources, "No CloudFront distribution found"
    dist_config = list(resources.values())[0]["Properties"]["DistributionConfig"]

    assert "CustomErrorResponses" not in dist_config, \
        "CustomErrorResponses must be removed; SPA routing uses a CF Function instead"

    default_cache = dist_config.get("DefaultCacheBehavior", {})
    fa = default_cache.get("FunctionAssociations", [])
    assert fa, "Default behavior missing FunctionAssociations"
    event_types = [a.get("EventType") for a in fa]
    assert "viewer-request" in event_types, \
        f"Expected viewer-request FunctionAssociation, got: {event_types}"


def test_api_origin_read_timeout(core_template):
    """FunctionUrlOrigin for /api/* must have read_timeout = 60 s."""
    resources = core_template.find_resources("AWS::CloudFront::Distribution")
    dist_config = list(resources.values())[0]["Properties"]["DistributionConfig"]
    api_behavior = next(
        (b for b in dist_config.get("CacheBehaviors", []) if b.get("PathPattern") == "/api/*"),
        None,
    )
    assert api_behavior, "/api/* behavior not found"
    # CDK renders read_timeout as ReadTimeout on the origin group or CustomOriginConfig
    origin_id = api_behavior.get("TargetOriginId")
    origins_list = dist_config.get("Origins", [])
    api_origin_cfg = next((o for o in origins_list if o.get("Id") == origin_id), None)
    assert api_origin_cfg, f"Origin with id {origin_id} not found"
    custom_cfg = api_origin_cfg.get("CustomOriginConfig", {})
    assert custom_cfg.get("OriginReadTimeout") == 60, \
        f"Expected OriginReadTimeout=60, got {custom_cfg.get('OriginReadTimeout')}"


def test_async_invoke_no_retry(core_template):
    """Lambda EventInvokeConfig must have MaximumRetryAttempts=0."""
    core_template.has_resource_properties("AWS::Lambda::EventInvokeConfig", {
        "MaximumRetryAttempts": 0,
    })


def test_function_url_auth_type_iam(core_template):
    """Function URL must use AWS_IAM (account guardrail removes NONE URLs)."""
    core_template.has_resource_properties("AWS::Lambda::Url", {
        "AuthType": "AWS_IAM",
    })


def test_api_origin_has_oac(core_template):
    """/api/* origin must carry an OriginAccessControlId (CloudFront OAC for Lambda)."""
    resources = core_template.find_resources("AWS::CloudFront::Distribution")
    dist_config = list(resources.values())[0]["Properties"]["DistributionConfig"]
    api_behavior = next(
        (b for b in dist_config.get("CacheBehaviors", []) if b.get("PathPattern") == "/api/*"),
        None,
    )
    assert api_behavior, "/api/* behavior not found"
    origin_id = api_behavior.get("TargetOriginId")
    api_origin_cfg = next(
        (o for o in dist_config.get("Origins", []) if o.get("Id") == origin_id),
        None,
    )
    assert api_origin_cfg, f"Origin {origin_id} not found"
    assert api_origin_cfg.get("OriginAccessControlId"), \
        "/api/* origin missing OriginAccessControlId"


def test_lambda_oac_resource_exists(core_template):
    """A CloudFront OAC with OriginAccessControlOriginType=lambda must exist."""
    core_template.has_resource_properties("AWS::CloudFront::OriginAccessControl", {
        "OriginAccessControlConfig": cdk.assertions.Match.object_like({
            "OriginAccessControlOriginType": "lambda",
        }),
    })


def test_no_public_lambda_permission(core_template):
    """No AWS::Lambda::Permission with Principal '*' (public Function URL) must exist."""
    resources = core_template.find_resources("AWS::Lambda::Permission")
    public = [
        rid for rid, r in resources.items()
        if r.get("Properties", {}).get("Principal") == "*"
    ]
    assert not public, f"Found public Lambda Permission(s): {public}"


# ── Video stack assertions ────────────────────────────────────────────────────

def test_video_bucket(video_template):
    video_template.has_resource_properties("AWS::S3::Bucket", {
        "BucketName": "ipverse-video-087967639890-us-west-2",
    })


def test_video_lifecycle(video_template):
    video_template.has_resource_properties("AWS::S3::Bucket", {
        "LifecycleConfiguration": {
            "Rules": cdk.assertions.Match.array_with([
                cdk.assertions.Match.object_like({
                    "ExpirationInDays": 7,
                    "Status": "Enabled",
                })
            ])
        }
    })
