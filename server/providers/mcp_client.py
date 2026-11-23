"""A small client for the account's MCP proxies (mediagen video, storyboard image): MCP streamable HTTP in
stateless JSON mode, one JSON-RPC tools/call per POST, `x-api-key: Key <key>` from an SSM SecureString."""
from __future__ import annotations
import json
import os
import urllib.error
import urllib.request
from typing import NamedTuple

TIMEOUT_SEC = 60


class Endpoint(NamedTuple):
    url: str
    key_param: str


VIDEO = Endpoint(os.environ.get("VIDEOGEN_MCP_URL", "https://v2hgkct6d2.execute-api.us-east-1.amazonaws.com/mcp"),
                 os.environ.get("VIDEOGEN_KEY_PARAM", "/mediagen/mcp-api-key"))
IMAGE = Endpoint(os.environ.get("IMAGEGEN_MCP_URL", "https://77fmd8ppzh.execute-api.us-east-1.amazonaws.com/mcp"),
                 os.environ.get("IMAGEGEN_KEY_PARAM", "/storyboard-mcp/api-key"))
_key_cache: dict = {}  # SSM parameter name → key, per process


def _api_key(ctx, param: str) -> str:
    if param not in _key_cache:
        ssm = getattr(ctx, "ssm", None)
        if ssm is None:
            import boto3
            ssm = boto3.client("ssm", region_name="us-east-1")
        _key_cache[param] = ssm.get_parameter(Name=param, WithDecryption=True)["Parameter"]["Value"].strip()
    return _key_cache[param]


def _post(url: str, body: dict, key: str) -> dict:
    """POST one JSON-RPC message → the decoded JSON-RPC response (an SSE reply's last data line is accepted too)."""
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={
        "content-type": "application/json", "accept": "application/json, text/event-stream",
        "x-api-key": f"Key {key}"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as r:
            raw = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"MCP HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from None
    if not raw.lstrip().startswith("{"):
        data = [line[5:].strip() for line in raw.splitlines() if line.startswith("data:")]
        raw = data[-1] if data else raw
    return json.loads(raw)


def call_tool(ctx, endpoint: Endpoint, tool: str, arguments: dict) -> dict:
    """tools/call → the tool's result dict. JSON-RPC errors and isError results raise with their text."""
    resp = _post(endpoint.url, {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                "params": {"name": tool, "arguments": arguments}}, _api_key(ctx, endpoint.key_param))
    if resp.get("error"):
        raise RuntimeError(f"{tool}: {resp['error'].get('message') or resp['error']}")
    result = resp.get("result") or {}
    text = "".join(c.get("text", "") for c in result.get("content", []) if c.get("type", "text") == "text")
    if result.get("isError"):
        raise RuntimeError(f"{tool}: {text[:300] or 'tool error'}")
    if isinstance(result.get("structuredContent"), dict) and not text:
        return result["structuredContent"]
    try:
        out = json.loads(text)
    except ValueError:
        raise RuntimeError(f"{tool}: unexpected reply {text[:200]!r}") from None
    return out if isinstance(out, dict) else {"result": out}


def public_input_url(ctx, key: str) -> str:
    """GPU boxes fetch inputs over the internet: CloudFront when deployed, else a 1 h presigned S3 GET."""
    if ctx.cdn_domain:
        return f"https://{ctx.cdn_domain}/{key}"
    return ctx.s3.generate_presigned_url("get_object", Params={"Bucket": ctx.assets_bucket, "Key": key},
                                         ExpiresIn=3600)


def download(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=TIMEOUT_SEC) as r:
        return r.read()
