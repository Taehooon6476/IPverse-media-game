#!/usr/bin/env python3
"""
Smoke test: log in with demo credentials, create session, send chat, poll until done.
Run: python3 scripts/smoke.py
"""
import hashlib
import json
import pathlib
import sys
import time

import boto3
import urllib.request
import urllib.error

ROOT = pathlib.Path(__file__).resolve().parent.parent
SECRET_NAME = "ipverse/demo-user"
REGION = "us-east-1"
POLL_INTERVAL = 10
TIMEOUT = 600  # 10 minutes


def get_secret() -> dict:
    sm = boto3.client("secretsmanager", region_name=REGION)
    resp = sm.get_secret_value(SecretId=SECRET_NAME)
    return json.loads(resp["SecretString"])


def cognito_login(cloudfront_url: str, username: str, password: str) -> str:
    """Returns Cognito access token via USER_PASSWORD_AUTH."""
    outputs = json.loads((ROOT / "build" / "outputs.json").read_text())
    core = outputs.get("IpverseCore", {})
    user_pool_id = core.get("UserPoolId") or core.get("UserPoolIdOutput")
    client_id = core.get("ClientId") or core.get("ClientIdOutput")

    idp = boto3.client("cognito-idp", region_name=REGION)
    resp = idp.initiate_auth(
        AuthFlow="USER_PASSWORD_AUTH",
        AuthParameters={"USERNAME": username, "PASSWORD": password},
        ClientId=client_id,
    )
    return resp["AuthenticationResult"]["AccessToken"]


def api_call(base_url: str, method: str, path: str, token: str, body: dict = None):
    url = base_url.rstrip("/") + path
    data = json.dumps(body).encode() if body else None
    headers = {
        "Content-Type": "application/json",
        "X-Auth-Token": token,
    }
    if data:
        # CloudFront OAC (Lambda) requires x-amz-content-sha256 on signed requests
        headers["x-amz-content-sha256"] = hashlib.sha256(data).hexdigest()
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read()
        print(f"  HTTP {e.code}: {body.decode()}", file=sys.stderr)
        raise


def smoke() -> None:
    secret = get_secret()
    cloudfront_url = secret["cloudfrontUrl"]
    base = cloudfront_url.rstrip("/")

    print(f"Logging in as '{secret['username']}' at {cloudfront_url} …")
    token = cognito_login(cloudfront_url, secret["username"], secret["password"])
    print("  Login OK")

    print("Creating session …")
    sess = api_call(base, "POST", "/api/sessions", token, {"title": "Smoke test", "genre": "sf-shooter"})
    session_id = sess["session"]["sessionId"]
    print(f"  Session: {session_id}")

    print("Sending chat message …")
    chat_resp = api_call(base, "POST", f"/api/sessions/{session_id}/chat", token,
                         {"text": "안녕하세요! 우주 SF 슈터 게임을 만들어줘."})
    message_id = chat_resp.get("messageId")
    print(f"  Message enqueued: {message_id}")

    print("Polling for assistant response (up to 10 min) …")
    deadline = time.time() + TIMEOUT
    last_status = None
    while time.time() < deadline:
        snap = api_call(base, "GET", f"/api/sessions/{session_id}", token)
        messages = snap.get("messages", [])
        assistant_msgs = [m for m in messages if m.get("role") == "assistant"]
        if assistant_msgs:
            latest = sorted(assistant_msgs, key=lambda m: m.get("ts", 0))[-1]
            status = latest.get("status")
            if status != last_status:
                print(f"  Status: {status}")
                last_status = status
            if status in ("done", "failed"):
                print(f"\nFinal status: {status}")
                print(f"Assistant: {latest.get('text', '')[:400]}")
                print("\nSnapshot summary:")
                for key in ("ips", "assets", "jobs", "games"):
                    print(f"  {key}: {len(snap.get(key, []))}")
                return
        time.sleep(POLL_INTERVAL)

    print("ERROR: Timed out waiting for assistant response.", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    smoke()
