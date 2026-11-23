#!/usr/bin/env python3
"""Inspect by default; --execute logs in to an existing game without API writes."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    command = ["node", str(ROOT / "scripts/verify_background_studio_readonly.mjs")]
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
        return subprocess.run(command + ["--execute"], input=payload, text=True, cwd=ROOT).returncode
    finally:
        secret.clear()
        payload = ""


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"status": "PRIVATE_READONLY_WRAPPER_FAILED", "errorType": type(error).__name__}))
        sys.exit(1)
