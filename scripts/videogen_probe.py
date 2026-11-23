#!/usr/bin/env python3
"""Probe the account's videogen MCP proxy (LTX-2.5 / MiniMax H3 / Kandinsky / Wan) with one JSON-RPC tools/call.

  python3 scripts/videogen_probe.py list_video_models '{}'

The API key is read from SSM /mediagen/mcp-api-key and never printed.
"""
import json
import sys
import urllib.request

import boto3

ENDPOINTS = {  # MCP proxies in the account: name -> (url, SSM key parameter)
    "video": ("https://v2hgkct6d2.execute-api.us-east-1.amazonaws.com/mcp", "/mediagen/mcp-api-key"),
    "image": ("https://77fmd8ppzh.execute-api.us-east-1.amazonaws.com/mcp", "/storyboard-mcp/api-key"),
}


def call(tool: str, args: dict, endpoint: str = "video") -> dict:
    url, param = ENDPOINTS[endpoint]
    key = boto3.client("ssm", region_name="us-east-1").get_parameter(
        Name=param, WithDecryption=True)["Parameter"]["Value"].strip()
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": tool, "arguments": args}}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "content-type": "application/json", "accept": "application/json, text/event-stream",
        "x-api-key": f"Key {key}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


if __name__ == "__main__":
    out = call(sys.argv[1], json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}, sys.argv[3] if len(sys.argv) > 3 else "video")
    print(json.dumps(out, ensure_ascii=False, indent=1)[:4000])
