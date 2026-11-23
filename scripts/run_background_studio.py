#!/usr/bin/env python3
"""Run the native background UI verifier with credential JSON on private stdin.

Default inspection performs no AWS calls, starts no browser, and creates no IPs.
Pass --execute only once the background deployment is ready.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--input", default="evidence/background-game-test.json")
    parser.add_argument("--output", default="evidence/background-studio-live.json")
    parser.add_argument("--screenshots", default="evidence/background-studio")
    parser.add_argument("--media", default="evidence/background-studio")
    args = parser.parse_args()
    if args.execute and args.self_test:
        parser.error("Choose execution or self-test")
    command = ["node", str(ROOT / "scripts/verify_background_studio.mjs")]
    if args.self_test:
        return subprocess.run(command + ["--self-test"], cwd=ROOT).returncode
    for name in ("input", "output", "screenshots", "media"):
        path = (ROOT / getattr(args, name)).resolve()
        if not path.is_relative_to(ROOT):
            raise ValueError("QA paths must stay within target workspace")
        command.extend(["--" + name, str(path)])
    # Inspect the prepared fixture before touching credentials or AWS.
    inspected = subprocess.run(command + ["--inspect"], cwd=ROOT)
    if inspected.returncode or not args.execute:
        return inspected.returncode
    import boto3
    secret = {}
    payload = ""
    try:
        secret = json.loads(boto3.client("secretsmanager", region_name="us-east-1")
                            .get_secret_value(SecretId="ipverse/demo-user")["SecretString"])
        env = boto3.client("lambda", region_name="us-east-1").get_function_configuration(
            FunctionName="ipverse-api")["Environment"]["Variables"]
        payload = json.dumps({
            "username": secret["username"], "password": secret["password"],
            "expectedConfig": {"clientId": env["CLIENT_ID"], "userPoolId": env["USER_POOL_ID"],
                               "region": env["USER_POOL_ID"].split("_", 1)[0]},
        })
        secret.clear()
        env.clear()
        result = subprocess.run(command + ["--execute"], input=payload, text=True, cwd=ROOT)
        return result.returncode
    finally:
        secret.clear()
        payload = ""


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        # AWS exceptions can contain request details. Emit only the exception type.
        print(json.dumps({"status": "PRIVATE_WRAPPER_FAILED", "errorType": type(error).__name__}))
        sys.exit(1)
