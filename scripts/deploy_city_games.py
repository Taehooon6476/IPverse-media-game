#!/usr/bin/env python3
"""Plan, then update the existing IPverse application and trusted city runtime.

Default is a read-only AWS dry run with private local rollback snapshots.
Apply only after local city gameplay is verified:
  python scripts/deploy_city_games.py --dry-run
  python scripts/deploy_city_games.py --apply --plan evidence/city-deployment-plan.json

No infrastructure, Lambda environment, authentication, passwords, permissions,
existing game copies, model jobs, or user sessions are modified.
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import copy
import datetime
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import sys
import time
import urllib.error
import urllib.request
import uuid
import zipfile

import boto3
from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from server.tools import CITY_RUNTIME_FILES, RUNTIME3D_FILES, RUNTIME_FILES
from upload_web import content_type

ACCOUNT = "087967639890"
BUCKET = "ipverse-assets-087967639890-us-east-1"
HOST = "d12ka835iwfpnx.cloudfront.net"
FUNCTION = "ipverse-api"
REGION = "us-east-1"
CHANGED_MODULES = (
    "server/prompts.py", "server/gamespec.py", "server/tools.py",
    "server/authored_contract.py", "server/city_contract.py",
)
PUBLIC_PREFIXES = ("web/", "runtime/v1/", "runtime3d/v1/")
CATALOG = "city-assets/commonassetcatalog.json"
KIT_MAX_BYTES = 30 * 1024 * 1024
WEB_EXTENSIONS = {".html", ".js", ".css", ".json", ".svg", ".png", ".webp",
                  ".jpg", ".jpeg", ".ico", ".woff", ".woff2", ".ttf", ".map"}
ASSET_EXTENSIONS = {".glb", ".gltf", ".bin", ".png", ".jpg", ".jpeg", ".webp", ".txt"}


def sha(blob):
    return hashlib.sha256(blob).hexdigest()


def code_sha(blob):
    return base64.b64encode(hashlib.sha256(blob).digest()).decode()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def private_write(path, blob):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as file:
        os.fchmod(file.fileno(), 0o600)
        file.write(blob)


def save(path, report):
    private_write(path, (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode())


def relative(value):
    require(isinstance(value, str) and value and "\\" not in value
            and all(part not in ("", ".", "..") for part in value.split("/")),
            "A source path is not a bounded repository-relative path")
    path = PurePosixPath(value)
    require(not path.is_absolute(), "Absolute source paths are forbidden")
    return path.as_posix()


def local_file(base, rel):
    rel = relative(rel)
    path = base / rel
    require(path.is_file() and not path.is_symlink()
            and path.resolve().is_relative_to(base.resolve()), "Missing or untrusted local source file")
    return path


def add(upload, key, file, expected=None, size=None):
    require(key.startswith(PUBLIC_PREFIXES) and ".." not in key.split("/"),
            "Object key is outside the allowed application prefixes")
    blob = file.read_bytes()
    if expected is not None:
        require(sha(blob) == expected, "A cataloged asset no longer matches its recorded SHA")
    if size is not None:
        require(len(blob) == size, "A cataloged asset no longer matches its recorded byte count")
    if key in upload:
        require(upload[key]["sha256"] == sha(blob), "Conflicting sources target one object key")
    upload[key] = {"file": file, "bytes": len(blob), "sha256": sha(blob)}


def collect_files():
    upload = {}
    dist = ROOT / "web/dist"
    local_file(dist, "index.html")
    for file in sorted(dist.rglob("*")):
        if not file.is_file():
            continue
        rel = relative(file.relative_to(dist).as_posix())
        if rel == "config.json":
            continue  # preserve the existing deployed Cognito configuration
        require(file.suffix in WEB_EXTENSIONS and not file.is_symlink()
                and file.resolve().is_relative_to(dist.resolve()), "Unexpected frontend file")
        add(upload, "web/" + rel, file)
    for dirname, files, prefix in (
        ("game", RUNTIME_FILES, "runtime/v1/"),
        ("game3d", (*RUNTIME3D_FILES, *CITY_RUNTIME_FILES), "runtime3d/v1/"),
    ):
        for name in dict.fromkeys(files):
            add(upload, prefix + relative(name), local_file(ROOT / dirname, name))

    catalog_file = local_file(ROOT / "game3d", CATALOG)
    catalog = json.loads(catalog_file.read_bytes())
    require(catalog.get("version") == 1 and catalog.get("license") == "CC0-1.0",
            "The actual city catalog/license is not the expected version")
    assets = catalog.get("assets")
    require(isinstance(assets, list) and 1 <= len(assets) <= 80, "Invalid city asset count")
    add(upload, "runtime3d/v1/" + CATALOG, catalog_file)
    sources = catalog.get("sources")
    require(isinstance(sources, list) and sources, "City kit source licenses are missing")
    for source in sources:
        require(source.get("license") == "CC0-1.0", "Unexpected city source license")
        rel = "city-assets/" + relative(source["licensePath"])
        require(rel.startswith("city-assets/licenses/") and rel.endswith(".txt"),
                "Source license path is outside the trusted license directory")
        add(upload, "runtime3d/v1/" + rel, local_file(ROOT / "game3d", rel),
            expected=source["licenseSha256"])
    seen = set()
    for asset in assets:
        require(asset.get("license") == "CC0-1.0" and isinstance(asset.get("id"), str)
                and asset["id"] not in seen, "Unexpected or duplicate city asset")
        seen.add(asset["id"])
        rel = relative(asset["path"])
        require(rel.startswith("city-assets/models/") and Path(rel).suffix in {".glb", ".gltf"},
                "City mesh is outside the trusted model directory")
        add(upload, "runtime3d/v1/" + rel, local_file(ROOT / "game3d", rel),
            expected=asset["sha256"], size=asset["bytes"])
        for dependency in asset.get("dependencies", []):
            rel = "city-assets/" + relative(dependency["path"])
            require(rel.startswith("city-assets/models/") and Path(rel).suffix in ASSET_EXTENSIONS,
                    "City mesh dependency is outside the trusted model directory")
            add(upload, "runtime3d/v1/" + rel, local_file(ROOT / "game3d", rel),
                expected=dependency["sha256"], size=dependency["bytes"])
    kit_bytes = sum(item["bytes"] for key, item in upload.items()
                    if key.startswith("runtime3d/v1/city-assets/"))
    require(kit_bytes <= KIT_MAX_BYTES, "Actual city kit exceeds the 30 MiB upload bound")
    return upload, {"catalogSha256": sha(catalog_file.read_bytes()), "assetCount": len(assets),
                    "uploadBytes": kit_bytes, "sharedPrefix": "/runtime3d/v1/city-assets/",
                    "scope": "Catalog allowlisted real meshes, dependencies and source licenses only"}


def audience_gate():
    results = []
    for headers in ({}, {"X-Auth-Token": "invalid-city-deployment-check"}):
        request = urllib.request.Request("https://" + HOST + "/api/sessions", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30):
                raise RuntimeError("The audience gate admitted an anonymous or invalid caller")
        except urllib.error.HTTPError as error:
            body = json.loads(error.read(4096))
            require(error.code == 401 and body.get("error") == "unauthorized",
                    "Expected identifiable unauthorized API denial was not observed")
            results.append({"status": error.code, "error": body["error"]})
    return results


def fetch_lambda(lam):
    function = lam.get_function(FunctionName=FUNCTION)
    configuration = function["Configuration"]
    require(configuration.get("PackageType", "Zip") == "Zip"
            and configuration.get("LastUpdateStatus", "Successful") == "Successful",
            "Existing Lambda is not a stable ZIP deployment")
    # Signed download location remains in memory and is never logged or persisted.
    with urllib.request.urlopen(function["Code"]["Location"], timeout=60) as response:
        blob = response.read(60 * 1024 * 1024 + 1)
    require(len(blob) <= 60 * 1024 * 1024 and code_sha(blob) == configuration["CodeSha256"],
            "Fresh Lambda ZIP does not match the reported CodeSHA or size bound")
    return configuration, blob


def package_lambda(blob):
    modules = {name: local_file(ROOT, name).read_bytes() for name in CHANGED_MODULES}
    with zipfile.ZipFile(io.BytesIO(blob)) as source:
        require(len(source.namelist()) == len(set(source.namelist())), "Baseline ZIP has duplicate members")
        require(all(name in source.namelist() for name in CHANGED_MODULES
                    if name != "server/city_contract.py"), "Baseline lacks an expected application module")
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
            for info in source.infolist():
                if info.filename not in modules:
                    target.writestr(copy.copy(info), source.read(info.filename))
            for name, body in modules.items():
                if name in source.namelist():
                    info = copy.copy(source.getinfo(name))
                else:
                    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = 0o100644 << 16
                target.writestr(info, body)
        updated = output.getvalue()
        with zipfile.ZipFile(io.BytesIO(updated)) as target:
            untouched = [name for name in source.namelist() if name not in modules]
            require(all(source.read(name) == target.read(name) for name in untouched),
                    "An unrelated Lambda ZIP member changed")
    require(len(updated) <= 50 * 1024 * 1024, "Lambda ZIP exceeds direct-update bound")
    return updated, {name: sha(body) for name, body in modules.items()}, len(untouched)


def object_snapshot(s3, key):
    try:
        response = s3.get_object(Bucket=BUCKET, Key=key)
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in {"NoSuchKey", "404", "NotFound"}:
            return None
        raise
    body = response["Body"].read()
    return body, {k: response[k] for k in ("ContentType", "CacheControl", "ContentEncoding",
                                           "ContentDisposition", "Metadata") if k in response}


def public_items(upload):
    return {key: {"source": item["file"].relative_to(ROOT).as_posix(),
                  "sha256": item["sha256"], "bytes": item["bytes"]}
            for key, item in sorted(upload.items())}


def distribution_id(cf):
    matches = [item["Id"] for page in cf.get_paginator("list_distributions").paginate()
               for item in page.get("DistributionList", {}).get("Items", [])
               if item["DomainName"] == HOST]
    require(len(matches) == 1, "Expected existing IPverse distribution was not uniquely found")
    return matches[0]


def dry_run(args, upload, kit, clients, gate):
    lam, s3, cf = clients
    config, original = fetch_lambda(lam)
    updated, modules, preserved = package_lambda(original)
    run = ROOT / "build/city-deployment" / uuid.uuid4().hex
    run.mkdir(parents=True, mode=0o700)
    private_write(run / "baseline-lambda.zip", original)
    private_write(run / "planned-lambda.zip", updated)
    previous = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        snapshots = list(pool.map(lambda key: (key, object_snapshot(s3, key)), upload))
    for key, result in snapshots:
        if result is None:
            previous[key] = {"exists": False}
            continue
        body, metadata = result
        path = run / "baseline-s3" / key
        private_write(path, body)
        previous[key] = {"exists": True, "sha256": sha(body), "bytes": len(body),
                         "backup": path.relative_to(ROOT).as_posix(), "metadata": metadata}
    report = {
        "status": "DRY_RUN_READY", "observedAt": now(), "awsWrites": False, "host": HOST,
        "account": ACCOUNT, "function": FUNCTION, "bucket": BUCKET,
        "scope": "Existing application city modules, frontend and trusted runtime/catalog; no infra/auth/config/password changes",
        "proofScope": "Read-only deployment plan, snapshots and source checks; not deployed or gameplay proof",
        "anonymousDenial": gate, "distributionId": distribution_id(cf),
        "baselineCodeSha256": config["CodeSha256"], "baselineRevisionId": config["RevisionId"],
        "plannedCodeSha256": code_sha(updated), "modules": modules, "untouchedMembers": preserved,
        "unrelatedLambdaBytesPreserved": True, "webConfigPreserved": True,
        "backupDirectory": run.relative_to(ROOT).as_posix(), "objects": public_items(upload),
        "previousObjects": previous, "cityAssets": kit,
    }
    save(args.report, report)
    print(json.dumps({"status": report["status"], "awsWrites": False, "modules": len(modules),
                      "objects": len(upload), "cityAssets": kit["assetCount"],
                      "plan": args.report.relative_to(ROOT).as_posix()}, ensure_ascii=False), flush=True)


def apply(args, upload, kit, clients, gate):
    require(args.plan is not None, "--apply requires a previously saved --plan")
    plan = json.loads(args.plan.read_bytes())
    require(plan.get("status") == "DRY_RUN_READY" and plan.get("awsWrites") is False
            and plan.get("host") == HOST and plan.get("account") == ACCOUNT,
            "Only this application's saved read-only plan can be applied")
    require(plan.get("objects") == public_items(upload) and plan.get("cityAssets") == kit,
            "Local frontend/runtime/kit changed after planning; run a fresh dry run")
    lam, s3, cf = clients
    config, original = fetch_lambda(lam)
    require(config["CodeSha256"] == plan["baselineCodeSha256"]
            and config["RevisionId"] == plan["baselineRevisionId"],
            "Concurrent Lambda deployment detected; run a fresh dry run")
    updated, modules, preserved = package_lambda(original)
    require(modules == plan["modules"] and code_sha(updated) == plan["plannedCodeSha256"],
            "Local application modules changed after planning")
    require(distribution_id(cf) == plan["distributionId"], "Existing distribution changed")
    # Recheck every touched object before any AWS mutation. Leave unrelated
    # public objects and all existing game copies alone.
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        snapshots = list(pool.map(lambda key: (key, object_snapshot(s3, key)), upload))
    for key, result in snapshots:
        previous = plan["previousObjects"][key]
        require((result is None and not previous["exists"]) or
                (result is not None and previous["exists"] and sha(result[0]) == previous["sha256"]),
                "A planned public object changed concurrently; run a fresh dry run")
    report = {**plan, "status": "DEPLOYING", "startedAt": now(), "anonymousDenial": gate,
              "awsWrites": True, "uploaded": [], "appliedPlan": args.plan.relative_to(ROOT).as_posix()}
    save(args.report, report)
    try:
        # Publish dependencies/runtime templates before enabling new backend
        # city builds. Existing generated game folders are never overwritten.
        ordered = sorted(upload, key=lambda key: (key.startswith("web/"), key.endswith("index.html"), key))
        for key in ordered:
            if key.startswith("web/"):
                continue
            upload_one(s3, key, upload[key], report, args.report)
        lam.update_function_code(FunctionName=FUNCTION, ZipFile=updated,
                                 RevisionId=config["RevisionId"])
        print("Existing Lambda update submitted; waiting for readiness.", flush=True)
        deadline = time.monotonic() + 180
        while True:
            current = lam.get_function_configuration(FunctionName=FUNCTION)
            require(current.get("LastUpdateStatus") != "Failed", "Lambda code update failed")
            if current.get("LastUpdateStatus") == "Successful" and current["CodeSha256"] == code_sha(updated):
                break
            require(time.monotonic() < deadline, "Lambda update readiness timed out")
            time.sleep(2)
        final_config, actual = fetch_lambda(lam)
        require(actual == updated, "Deployed ZIP differs from the planned complete ZIP")
        fields = ("Environment", "Role", "Runtime", "Handler", "Timeout", "MemorySize", "Layers",
                  "VpcConfig", "KMSKeyArn", "Architectures")
        require(all(final_config.get(field) == config.get(field) for field in fields),
                "Lambda configuration changed during this code-only update")
        report.update(codeSha256=final_config["CodeSha256"], configurationPreserved=True,
                      unrelatedLambdaBytesPreserved=True, untouchedMembers=preserved)
        save(args.report, report)
        for key in ordered:
            if key.startswith("web/"):
                upload_one(s3, key, upload[key], report, args.report)
        paths = ["/", "/index.html", "/assets/*", "/runtime3d/v1/*", "/runtime/v1/*"]
        invalidation = cf.create_invalidation(DistributionId=plan["distributionId"], InvalidationBatch={
            "Paths": {"Quantity": len(paths), "Items": paths},
            "CallerReference": "city-" + uuid.uuid4().hex,
        })["Invalidation"]
        report.update(status="DEPLOYED_S3_LAMBDA_VERIFIED_RUNTIME_QA_PENDING",
                      invalidationId=invalidation["Id"], completedAt=now())
        report["postDeployAnonymousDenial"] = audience_gate()
        save(args.report, report)
        print(json.dumps({"status": report["status"], "objects": len(report["uploaded"]),
                          "modules": len(modules), "awsWrites": True,
                          "report": args.report.relative_to(ROOT).as_posix()}), flush=True)
    except Exception as error:
        # Partial mutation remains explicit. Do not automatically overwrite a
        # concurrently changed service with rollback data.
        report.update(status="FAILED_OR_PARTIAL_DEPLOYMENT", failureType=type(error).__name__, failedAt=now())
        save(args.report, report)
        raise


def upload_one(s3, key, item, report, report_path):
    body = item["file"].read_bytes()
    require(sha(body) == item["sha256"], "Local source changed during deployment")
    mime = "model/gltf-binary" if item["file"].suffix == ".glb" else content_type(item["file"])
    s3.put_object(Bucket=BUCKET, Key=key, Body=body, ContentType=mime)
    result = object_snapshot(s3, key)
    require(result is not None and result[0] == body, "Uploaded object byte verification failed")
    report["uploaded"].append({"key": key, "sha256": item["sha256"], "bytes": len(body), "s3Verified": True})
    save(report_path, report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Read-only AWS plan (default)")
    mode.add_argument("--apply", action="store_true", help="Apply a reviewed unchanged plan after local gameplay QA")
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    args.plan = (ROOT / args.plan).resolve() if args.plan else None
    args.report = (ROOT / (args.report or ("evidence/city-deployment.json" if args.apply else
                                         "evidence/city-deployment-plan.json"))).resolve()
    require(args.report.is_relative_to(ROOT), "Deployment report must remain inside this workspace")
    require(args.plan is None or args.plan.is_relative_to(ROOT), "Deployment plan must remain inside this workspace")
    require(not args.apply or args.report != args.plan, "Apply report must not overwrite the dry-run plan")
    identity = boto3.client("sts", region_name=REGION).get_caller_identity()
    require(identity["Account"] == ACCOUNT, "Current caller is outside the expected AWS account")
    gate = audience_gate()  # identifiable 401/401 before any AWS mutation
    upload, kit = collect_files()
    clients = (boto3.client("lambda", region_name=REGION), boto3.client("s3", region_name=REGION),
               boto3.client("cloudfront", region_name=REGION))
    if args.apply:
        apply(args, upload, kit, clients, gate)
    else:
        dry_run(args, upload, kit, clients, gate)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never print signed code-download URLs, credentials or raw AWS replies.
        detail = str(error) if type(error) is RuntimeError else "Review the saved plan/report and source checks."
        print(f"City deployment stopped ({type(error).__name__}): {detail}",
              file=sys.stderr)
        sys.exit(1)
