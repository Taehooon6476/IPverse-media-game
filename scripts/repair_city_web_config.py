#!/usr/bin/env python3
"""Restore only the demo's public Cognito configuration from its live Lambda.

The city deployer preserves web/config.json, so a config holding placeholders
stays in place. No identity, password or infrastructure is changed.
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import time
import uuid

import boto3
import requests

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUCKET = "ipverse-assets-087967639890-us-east-1"
DISTRIBUTION = "EQC0HYZ4T1PP5"
URL = "https://d12ka835iwfpnx.cloudfront.net/config.json"
KEY = "web/config.json"
REPORT = ROOT / "evidence/city-web-config-repair.json"


def require(value, message):
    if not value:
        raise RuntimeError(message)


def digest(body):
    return hashlib.sha256(body).hexdigest()


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def save(report):
    REPORT.write_text(json.dumps(report, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    session = boto3.Session(region_name="us-east-1")
    require(session.client("sts").get_caller_identity()["Account"] == "087967639890",
            "Unexpected AWS account")
    variables = session.client("lambda").get_function_configuration(
        FunctionName="ipverse-api")["Environment"]["Variables"]
    expected = {"region": "us-east-1", "userPoolId": variables["USER_POOL_ID"],
                "clientId": variables["CLIENT_ID"]}
    cognito = session.client("cognito-idp")
    client = cognito.describe_user_pool_client(
        UserPoolId=expected["userPoolId"], ClientId=expected["clientId"])["UserPoolClient"]
    require(client["ClientId"] == expected["clientId"]
            and "ALLOW_USER_PASSWORD_AUTH" in client["ExplicitAuthFlows"],
            "Live Cognito client does not support the existing browser flow")
    s3, cf = session.client("s3"), session.client("cloudfront")
    actual = s3.get_object(Bucket=BUCKET, Key=KEY)
    previous = actual["Body"].read()
    before = json.loads(previous)
    require(set(before) == set(expected), "Unexpected public config schema")
    if args.apply:
        require(before == {"region": "us-east-1", "userPoolId": "us-east-1_PLACEHOLDER",
                           "clientId": "PLACEHOLDER_CLIENT_ID"},
                "Origin changed since the diagnosed placeholder failure")
        report = {
            "status": "RESTORED_CACHE_PENDING", "startedAt": timestamp(),
            "scope": "Only public web/config.json and its CDN cache. No passwords, identities, "
                     "Cognito settings, Lambda settings, sessions or games changed.",
            "originBefore": before, "originBeforeSha256": digest(previous),
            "originBeforeLastModified": actual["LastModified"].isoformat(),
            "expected": expected,
            "liveClientSupportsExistingBrowserFlow": True,
            "cityDeployerAlreadyExcludesConfig": True,
        }
        backup = ROOT / "build/city-config-repair"
        backup.mkdir(parents=True, exist_ok=True)
        (backup / "previous-config.json").write_bytes(previous)
        blob = (json.dumps(expected, indent=2) + "\n").encode()
        s3.put_object(Bucket=BUCKET, Key=KEY, Body=blob,
                      ContentType="application/json", CacheControl="no-cache")
        require(s3.get_object(Bucket=BUCKET, Key=KEY)["Body"].read() == blob,
                "Restored origin bytes differ")
        report["originAfterSha256"] = digest(blob)
        invalidation = cf.create_invalidation(
            DistributionId=DISTRIBUTION,
            InvalidationBatch={"CallerReference": "city-web-config-" + uuid.uuid4().hex,
                               "Paths": {"Quantity": 1, "Items": ["/config.json"]}})["Invalidation"]
        report["invalidationId"] = invalidation["Id"]
        save(report)
    else:
        report = json.loads(REPORT.read_text())
        require(report["expected"] == expected and before == expected,
                "Current origin is inconsistent with the live application")
    deadline = time.monotonic() + 45
    while True:
        invalidation = cf.get_invalidation(DistributionId=DISTRIBUTION,
                                          Id=report["invalidationId"])["Invalidation"]
        if invalidation["Status"] == "Completed" or time.monotonic() >= deadline:
            break
        time.sleep(3)
    report["invalidationStatus"] = invalidation["Status"]
    report["variants"] = []
    if invalidation["Status"] == "Completed":
        for encoding in ("identity", "gzip", "br", "gzip, deflate, br"):
            response = requests.get(URL, headers={"Accept-Encoding": encoding}, timeout=25)
            matches = response.status_code == 200 and response.json() == expected
            report["variants"].append({"acceptEncoding": encoding, "status": response.status_code,
                                       "matchesActualCognito": matches,
                                       "cache": response.headers.get("X-Cache"),
                                       "sha256": digest(response.content)})
            require(matches, "A CDN encoding variant still has incorrect public settings")
        report.update(status="PUBLIC_CONFIG_REPAIRED_ALL_VARIANTS_VERIFIED", completedAt=timestamp())
    save(report)
    print(json.dumps({"status": report["status"], "invalidationStatus": report["invalidationStatus"],
                      "variants": report["variants"]}))


if __name__ == "__main__":
    main()
