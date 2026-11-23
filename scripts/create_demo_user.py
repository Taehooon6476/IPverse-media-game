#!/usr/bin/env python3
"""
Create/update demo Cognito user and store credentials in Secrets Manager.
Idempotent — safe to re-run.
Run: python3 scripts/create_demo_user.py
"""
import json
import pathlib
import secrets
import sys

import boto3
from botocore.exceptions import ClientError

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUTPUTS_FILE = ROOT / "build" / "outputs.json"
SECRET_NAME = "ipverse/demo-user"
USERNAME = "demo"


def make_password() -> str:
    """16 url-safe chars + a digit + a symbol → satisfies 12+ policy."""
    base = secrets.token_urlsafe(16)
    return base + "9!"


def create_demo_user() -> None:
    if not OUTPUTS_FILE.exists():
        print(f"ERROR: {OUTPUTS_FILE} not found. Run deploy first.", file=sys.stderr)
        sys.exit(1)

    outputs = json.loads(OUTPUTS_FILE.read_text())
    core = outputs.get("IpverseCore", {})
    cdn_domain = core.get("CdnDomain") or core.get("CdnDomainOutput")
    user_pool_id = core.get("UserPoolId") or core.get("UserPoolIdOutput")

    if not user_pool_id or not cdn_domain:
        print(f"ERROR: Missing outputs: {core}", file=sys.stderr)
        sys.exit(1)

    region = "us-east-1"
    idp = boto3.client("cognito-idp", region_name=region)
    sm = boto3.client("secretsmanager", region_name=region)

    password = make_password()

    try:
        idp.admin_create_user(
            UserPoolId=user_pool_id,
            Username=USERNAME,
            MessageAction="SUPPRESS",
        )
        print(f"Created user '{USERNAME}'")
    except ClientError as e:
        if e.response["Error"]["Code"] == "UsernameExistsException":
            print(f"User '{USERNAME}' already exists — updating password.")
        else:
            raise

    idp.admin_set_user_password(
        UserPoolId=user_pool_id,
        Username=USERNAME,
        Password=password,
        Permanent=True,
    )

    cloudfront_url = f"https://{cdn_domain}/"
    secret_value = json.dumps({
        "username": USERNAME,
        "password": password,
        "cloudfrontUrl": cloudfront_url,
    })

    try:
        sm.create_secret(Name=SECRET_NAME, SecretString=secret_value)
        print(f"Created secret '{SECRET_NAME}'")
    except ClientError as e:
        if e.response["Error"]["Code"] in ("ResourceExistsException", "ResourceNotFoundException"):
            sm.put_secret_value(SecretId=SECRET_NAME, SecretString=secret_value)
            print(f"Updated secret '{SECRET_NAME}'")
        else:
            raise

    print(f"\nCloudFront URL : {cloudfront_url}")
    print(f"Secret name   : {SECRET_NAME}")
    # The password is never printed.


if __name__ == "__main__":
    create_demo_user()
