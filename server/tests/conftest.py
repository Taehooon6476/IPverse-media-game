"""Fake boto3 clients for unit tests. No network, no AWS."""
from __future__ import annotations
import copy
import io
import json
from decimal import Decimal
import pytest
from botocore.exceptions import ClientError
from server.providers import mcp_client
from server.providers.base import Ctx


@pytest.fixture(autouse=True)
def _no_mcp_network(request, monkeypatch):
    """Unit tests never reach the MCP proxies (or SSM for their keys); tests fake mcp_client._post/download.
    LIVE tests (named *live*) are exempt."""
    if "live" in request.node.name:
        return

    def blocked(*args, **kwargs):
        raise AssertionError("unit test tried to reach an MCP proxy; fake mcp_client._post / download")

    monkeypatch.setattr(mcp_client, "_post", blocked)
    monkeypatch.setattr(mcp_client, "download", blocked)
    monkeypatch.setattr(mcp_client, "_key_cache", {"/mediagen/mcp-api-key": "test-key",
                                                   "/storyboard-mcp/api-key": "test-key"})


def _client_error(code: str, op: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": code}}, op)


def _ddb_value(v):
    """What boto3 does to values: ints come back as Decimal, floats are rejected."""
    if isinstance(v, float):
        raise TypeError("Float types are not supported. Use Decimal types instead.")
    if isinstance(v, int) and not isinstance(v, bool):
        return Decimal(v)
    if isinstance(v, dict):
        return {k: _ddb_value(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_ddb_value(x) for x in v]
    return v


class FakeTable:
    """Dict-backed DynamoDB Table resource. Supports the store's usage only: put/get, update with
    `SET #a = :a, ...` (+ one `#c = :c` or `attribute_not_exists(#c)` condition), delete (+ one `#c = :c`
    condition), query on `Key("pk").eq(...)`."""

    def __init__(self):
        self.items: dict = {}  # (pk, sk) -> item

    def put_item(self, Item, **kwargs):
        self.items[(Item["pk"], Item["sk"])] = _ddb_value(Item)

    def get_item(self, Key, **kwargs):
        item = self.items.get((Key["pk"], Key["sk"]))
        return {"Item": copy.deepcopy(item)} if item is not None else {}

    def delete_item(self, Key, ConditionExpression=None, ExpressionAttributeNames=None,
                    ExpressionAttributeValues=None, **kwargs):
        key = (Key["pk"], Key["sk"])
        if ConditionExpression is not None:  # `#c = :c` only (store._delete)
            lhs, rhs = (s.strip() for s in ConditionExpression.split("="))
            item = self.items.get(key)
            if item is None or item.get(ExpressionAttributeNames[lhs]) != _ddb_value(ExpressionAttributeValues)[rhs]:
                raise _client_error("ConditionalCheckFailedException", "DeleteItem")
        self.items.pop(key, None)

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames,
                    ExpressionAttributeValues, ConditionExpression=None, **kwargs):
        names, values = ExpressionAttributeNames, _ddb_value(ExpressionAttributeValues)
        key = (Key["pk"], Key["sk"])
        item = self.items.get(key)
        if ConditionExpression is not None:
            if ConditionExpression.startswith("attribute_not_exists("):
                ok = item is None or names[ConditionExpression[len("attribute_not_exists("):-1]] not in item
            else:
                lhs, rhs = (s.strip() for s in ConditionExpression.split("="))
                ok = item is not None and item.get(names[lhs]) == values[rhs]
            if not ok:
                raise _client_error("ConditionalCheckFailedException", "UpdateItem")
        assert UpdateExpression.startswith("SET "), UpdateExpression
        item = item if item is not None else dict(Key)
        for clause in UpdateExpression[4:].split(","):
            lhs, rhs = (s.strip() for s in clause.split("="))
            item[names[lhs]] = copy.deepcopy(values[rhs])
        self.items[key] = item
        return {}

    def query(self, KeyConditionExpression, ScanIndexForward=True, **kwargs):
        expr = KeyConditionExpression.get_expression()
        assert expr["operator"] == "=" and expr["values"][0].name == "pk", expr
        pk = expr["values"][1]
        items = sorted(
            (item for (p, _), item in self.items.items() if p == pk),
            key=lambda i: i["sk"],
            reverse=not ScanIndexForward,
        )
        return {"Items": copy.deepcopy(items)}


class FakeProvider:
    """Scripted JobProvider. `states` is popped per status() call (last one repeats); `errors` are raised
    by the first submit() calls, one each. sync=True mimics FfmpegProvider: submit() stores the result on
    the job dict, collect() reads it."""

    def __init__(self, name, states=(("running", "RUNNING · 0초"),), assets=(), sync=False, errors=()):
        self.name = name
        self.states = list(states)
        self.assets = list(assets)
        self.sync = sync
        self.errors = list(errors)
        self.attempts = 0  # submit() calls, raising or not
        self.submitted: list = []  # copies of the job dicts passed to successful submit() calls

    def submit(self, job, ctx):
        self.attempts += 1
        if self.errors:
            raise self.errors.pop(0)
        self.submitted.append(copy.deepcopy(job))
        if self.sync:
            job["result"] = list(self.assets)
            return "local"
        return f"ext-{job['jobId']}"

    def status(self, job, ctx):
        if self.sync:
            return ("done", "")  # like FfmpegProvider: the work happened in submit()
        return self.states.pop(0) if len(self.states) > 1 else self.states[0]

    def collect(self, job, ctx):
        return job.get("result", []) if self.sync else list(self.assets)


class FakeLambda:
    """Records invoke calls."""

    def __init__(self):
        self.calls: list = []

    def invoke(self, **kwargs):
        self.calls.append(kwargs)
        return {"StatusCode": 202}


class FakeCognito:
    """get_user for known tokens ({token: (sub, username)}); NotAuthorizedException otherwise."""

    def __init__(self, users=None):
        self.users: dict = dict(users or {})
        self.calls: int = 0

    def get_user(self, AccessToken):
        self.calls += 1
        if AccessToken not in self.users:
            raise _client_error("NotAuthorizedException", "GetUser")
        sub, username = self.users[AccessToken]
        return {"Username": username, "UserAttributes": [{"Name": "sub", "Value": sub}]}


class FakeS3:
    """Dict-backed S3 fake: put/get/copy/list/download/upload."""

    def __init__(self):
        self._store: dict = {}  # (bucket, key) -> bytes
        self.put_kwargs: dict = {}  # (bucket, key) -> extra put_object kwargs (ContentType, CacheControl)
        self.copies: list = []  # copy_object calls: {"CopySource", "Bucket", "Key"}
        self.page_size = 1000  # list_objects_v2 pages like S3 (0: one unpaged answer)
        self.delete_calls: list = []  # delete_objects calls: the keys of each

    def put_object(self, Bucket, Key, Body, IfMatch=None, IfNoneMatch=None, **kwargs):
        # S3 conditional writes: only over the version that was read, or ("*") only where there is no object yet
        if (IfMatch is not None and IfMatch != self._etag(Bucket, Key)) or (IfNoneMatch == "*" and (Bucket, Key) in self._store):
            from botocore.exceptions import ClientError
            raise ClientError({"Error": {"Code": "PreconditionFailed", "Message": "At least one of the pre-conditions you specified did not hold"}}, "PutObject")
        data = Body if isinstance(Body, (bytes, bytearray)) else Body.encode()
        self._store[(Bucket, Key)] = bytes(data)
        self.put_kwargs[(Bucket, Key)] = kwargs

    def _etag(self, Bucket, Key):
        import hashlib
        data = self._store.get((Bucket, Key))
        return None if data is None else f'"{hashlib.md5(data).hexdigest()}"'

    def get_object(self, Bucket, Key):
        data = self._store.get((Bucket, Key), b"")
        when = getattr(self, "modified", {}).get((Bucket, Key))  # a test's own: (bucket, key) -> datetime
        return {"Body": io.BytesIO(data), "ETag": self._etag(Bucket, Key), **({"LastModified": when} if when else {})}

    def head_object(self, Bucket, Key):
        if (Bucket, Key) not in self._store:
            raise _client_error("404", "HeadObject")
        extra = self.put_kwargs.get((Bucket, Key), {})
        return {"ETag": self._etag(Bucket, Key), "ContentLength": len(self._store[(Bucket, Key)]),
                "ContentType": extra.get("ContentType", "binary/octet-stream"),
                **({"CacheControl": extra["CacheControl"]} if "CacheControl" in extra else {})}

    def copy_object(self, CopySource, Bucket, Key, MetadataDirective="COPY", **kwargs):
        self.copies.append({"CopySource": dict(CopySource), "Bucket": Bucket, "Key": Key})
        src_bucket = CopySource["Bucket"]
        src_key = CopySource["Key"]
        data = self._store.get((src_bucket, src_key), b"")
        self._store[(Bucket, Key)] = data
        # like S3: the copy keeps the source's headers unless they are replaced
        self.put_kwargs[(Bucket, Key)] = (dict(kwargs) if MetadataDirective == "REPLACE"
                                          else dict(self.put_kwargs.get((src_bucket, src_key), {})))

    def list_objects_v2(self, Bucket, Prefix="", Delimiter=None, ContinuationToken=None, **kwargs):
        contents = [
            {"Key": k}
            for (b, k) in sorted(self._store)
            if b == Bucket and k.startswith(Prefix)
        ]
        if self.page_size and not Delimiter:  # like S3: at most page_size keys per page; the token is a key
            after = [k for k in contents if ContinuationToken is None or k["Key"] > ContinuationToken]
            page, more = after[:self.page_size], len(after) > self.page_size
            return {**({"Contents": page} if page else {}), "IsTruncated": more,
                    **({"NextContinuationToken": page[-1]["Key"]} if more else {})}
        if Delimiter:  # like S3: keys past the next delimiter roll up into CommonPrefixes
            rolled = sorted({Prefix + k["Key"][len(Prefix):].split(Delimiter, 1)[0] + Delimiter
                             for k in contents if Delimiter in k["Key"][len(Prefix):]})
            contents = [k for k in contents if Delimiter not in k["Key"][len(Prefix):]]
            return {"Contents": contents, "CommonPrefixes": [{"Prefix": p} for p in rolled]}
        if not contents:
            return {}
        return {"Contents": contents}

    def delete_objects(self, Bucket, Delete):
        keys = [o["Key"] for o in Delete["Objects"]]
        assert len(keys) <= 1000, "S3 DeleteObjects takes at most 1000 keys"
        self.delete_calls.append(keys)
        for k in keys:  # like S3: a missing key is not an error
            self._store.pop((Bucket, k), None)
            self.put_kwargs.pop((Bucket, k), None)
        return {"Deleted": [{"Key": k} for k in keys]}

    def download_file(self, Bucket, Key, Filename):
        data = self._store.get((Bucket, Key), b"")
        with open(Filename, "wb") as f:
            f.write(data)

    def upload_file(self, Filename, Bucket, Key, **kwargs):
        with open(Filename, "rb") as f:
            self._store[(Bucket, Key)] = f.read()


class FakeBedrockRT:
    """Scripted Bedrock Runtime fake. Pass responses list; each invoke_model pops one."""

    def __init__(self, responses=None):
        self._responses: list = list(responses or [])
        self.calls: list = []

    def invoke_model(self, modelId, body, **kwargs):
        self.calls.append({"method": "invoke_model", "modelId": modelId, "body": json.loads(body)})
        resp = self._responses.pop(0) if self._responses else {}
        return {"body": io.BytesIO(json.dumps(resp).encode())}

    def start_async_invoke(self, modelId, modelInput, outputDataConfig, **kwargs):
        self.calls.append({
            "method": "start_async_invoke",
            "modelId": modelId,
            "modelInput": modelInput,
            "outputDataConfig": outputDataConfig,
        })
        return {"invocationArn": "arn:aws:bedrock:us-west-2::async-invoke/test-1"}

    def get_async_invoke(self, invocationArn, **kwargs):
        resp = self._responses.pop(0) if self._responses else {}
        return resp if resp else {"status": "Completed"}

    def converse(self, **kwargs):
        # deepcopy: the agent keeps appending to the messages list it passed in
        self.calls.append({"method": "converse", **copy.deepcopy(kwargs)})
        return self._responses.pop(0)


class FakeDeadline:
    """Scripted Deadline fake."""

    def __init__(self):
        self.calls: list = []
        self._job_responses: dict = {}

    def create_job(self, **kwargs):
        self.calls.append({"method": "create_job", **kwargs})
        return {"jobId": "job-1"}

    def get_job(self, farmId, queueId, jobId, **kwargs):
        return self._job_responses.get(
            jobId,
            {
                "taskRunStatus": "RUNNING",
                "lifecycleStatus": "CREATE_COMPLETE",
                "createdAt": "2026-01-01T00:00:00Z",
            },
        )


def make_ctx(**fakes) -> Ctx:
    """Build a Ctx with fake clients. Pass keyword overrides (s3, bedrock_rt_east, etc.)."""
    defaults = dict(
        table_name="test-table",
        assets_bucket="test-assets",
        cdn_domain="cdn.example.com",
        video_bucket="test-video",
        video_region="us-west-2",
        image_region="us-west-2",
        queue_bucket="griptapenode-queue-087967639890-us-east-1-an",
        queue_prefix="DeadlineCloud/ipverse",
        deadline_farm_id="farm-1",
        deadline_queue_id="queue-1",
        agent_model_id="test-agent",
        image_model_id="stability.stable-image-ultra-v1:1",
        remove_bg_model_id="us.stability.stable-image-remove-background-v1:0",
        video_model_id="luma.ray-v2:0",
        ffmpeg_bin="ffmpeg",
        ffprobe_bin="ffprobe",
        font_path="/tmp/no-such-font.otf",
        s3=None,
        bedrock_rt_east=None,
        bedrock_rt_west=None,
        deadline=None,
        lambda_=None,
        cognito=None,
        table=None,
    )
    defaults.update(fakes)
    return Ctx(**defaults)
