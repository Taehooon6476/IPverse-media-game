#!/usr/bin/env python3
"""Update only IPverse application code and public runtimes; no infra or password changes."""
from __future__ import annotations

import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request
import uuid
import zipfile

import boto3

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from server.tools import RUNTIME3D_FILES, RUNTIME_FILES
from upload_web import content_type

CHANGED_MODULES = (
    "server/agent.py", "server/app.py", "server/prompts.py", "server/gamespec.py",
    "server/tools.py", "server/game_design.py", "server/authored_contract.py",
)
BUCKET = "ipverse-assets-087967639890-us-east-1"
HOST = "d12ka835iwfpnx.cloudfront.net"


def sha(blob):
    return hashlib.sha256(blob).hexdigest()


def main():
    assert boto3.client("sts").get_caller_identity()["Account"] == "087967639890"
    base = "https://" + HOST
    # The existing audience gate must still reject anonymous and invalid credentials.
    gate = []
    for headers in ({}, {"X-Auth-Token": "invalid-authored-deploy-check"}):
        try:
            urllib.request.urlopen(urllib.request.Request(base + "/api/sessions", headers=headers), timeout=30)
            raise RuntimeError("Audience gate admitted an unauthenticated caller")
        except urllib.error.HTTPError as error:
            data = json.load(error)
            assert error.code == 401 and data.get("error") == "unauthorized"
            gate.append({"status": error.code, "error": data["error"]})
    web_files = list((ROOT / "web/dist").rglob("*"))
    assert (ROOT / "web/dist/index.html").is_file()
    upload = {}
    for file in web_files:
        if file.is_file():
            upload["web/" + file.relative_to(ROOT / "web/dist").as_posix()] = file
    for dirname, files, prefix in (
        ("game", RUNTIME_FILES, "runtime/v1/"),
        ("game3d", RUNTIME3D_FILES, "runtime3d/v1/"),
    ):
        for name in files:
            file = ROOT / dirname / name
            assert file.is_file(), f"Missing runtime module {file}"
            upload[prefix + name] = file
    lam = boto3.client("lambda", region_name="us-east-1")
    fn = lam.get_function(FunctionName="ipverse-api")
    baseline = json.loads((ROOT / "build/game-personalization/baseline-deployment.json").read_text())
    report_file = ROOT / "evidence/authored-deployment.json"
    previous_report = json.loads(report_file.read_text()) if report_file.exists() else {}
    expected = {baseline["CodeSha256"], previous_report.get("codeSha256")}
    assert fn["Configuration"]["CodeSha256"] in expected, "Concurrent deployment detected; rebase first"
    with urllib.request.urlopen(fn["Code"]["Location"], timeout=40) as r:
        blob = r.read()
    assert base64.b64encode(hashlib.sha256(blob).digest()).decode() == fn["Configuration"]["CodeSha256"]
    source = zipfile.ZipFile(io.BytesIO(blob))
    original = zipfile.ZipFile(ROOT / "build/game-personalization/baseline-lambda.zip")
    for name in source.namelist():
        if name not in CHANGED_MODULES:
            assert name in original.namelist() and source.read(name) == original.read(name), "Unrelated module changed"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name in source.namelist():
            if name not in CHANGED_MODULES:
                bundle.writestr(name, source.read(name))
        for name in CHANGED_MODULES:
            bundle.writestr(name, (ROOT / name).read_bytes())
    updated = buf.getvalue()
    out = ROOT / "build/game-personalization"
    (out / "deployed-lambda.zip").write_bytes(updated)
    # Snapshot only the public frontend/runtime objects being updated, for rollback.
    s3 = boto3.client("s3", region_name="us-east-1")
    previous = []
    for key in upload:
        try:
            body = s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
        except s3.exceptions.NoSuchKey:
            continue
        path = out / "baseline-s3" / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        previous.append({"key": key, "sha256": sha(body)})
    report = {"status": "DEPLOYING", "host": HOST, "function": "ipverse-api",
              "scope": "Existing Lambda code, frontend and browser runtimes; no infrastructure/configuration/password mutation.",
              "anonymousDenial": gate, "originalCodeSha256": baseline["CodeSha256"],
              "previousCodeSha256": fn["Configuration"]["CodeSha256"],
              "previousPublicObjects": previous, "modules": {}, "objects": []}
    if previous_report:
        (out / f"deployment-{previous_report.get('invalidationId', 'previous')}.json").write_text(
            json.dumps(previous_report, ensure_ascii=False, indent=2))
    report_file.parent.mkdir(parents=True, exist_ok=True)
    def save():
        report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    save()
    for key, file in upload.items():
        body = file.read_bytes()
        s3.put_object(Bucket=BUCKET, Key=key, Body=body, ContentType=content_type(file))
        assert s3.get_object(Bucket=BUCKET, Key=key)["Body"].read() == body
        report["objects"].append({"key": key, "sha256": sha(body), "bytes": len(body), "s3Verified": True})
    response = lam.update_function_code(FunctionName="ipverse-api", ZipFile=updated,
                                         RevisionId=fn["Configuration"]["RevisionId"])
    print("Updated existing application code; waiting for Lambda readiness.", flush=True)
    for _ in range(60):
        config = lam.get_function_configuration(FunctionName="ipverse-api")
        if config["LastUpdateStatus"] == "Successful":
            break
        if config["LastUpdateStatus"] == "Failed":
            raise RuntimeError("Lambda code update failed")
        time.sleep(2)
    assert config["LastUpdateStatus"] == "Successful"
    assert config["CodeSha256"] == base64.b64encode(hashlib.sha256(updated).digest()).decode()
    deployed = lam.get_function(FunctionName="ipverse-api")
    with urllib.request.urlopen(deployed["Code"]["Location"], timeout=40) as r:
        actual = zipfile.ZipFile(io.BytesIO(r.read()))
    for name in CHANGED_MODULES:
        assert actual.read(name) == (ROOT / name).read_bytes()
        report["modules"][name] = sha(actual.read(name))
    report["codeSha256"] = config["CodeSha256"]
    cf = boto3.client("cloudfront")
    dist_id = next(dist["Id"] for page in cf.get_paginator("list_distributions").paginate()
                   for dist in page.get("DistributionList", {}).get("Items", []) if dist["DomainName"] == HOST)
    inv = cf.create_invalidation(DistributionId=dist_id, InvalidationBatch={
        "Paths": {"Quantity": 3, "Items": ["/", "/index.html", "/runtime3d/v1/*"]},
        "CallerReference": "authored-" + uuid.uuid4().hex,
    })["Invalidation"]
    report.update(distributionId=dist_id, invalidationId=inv["Id"], status="DEPLOYED_RUNTIME_QA_PENDING")
    save()
    print("Application and runtimes deployed. Live generation and browser QA remain.", flush=True)


if __name__ == "__main__":
    main()
