#!/usr/bin/env python3
"""Plan/apply a bounded city NPC rig + rendering patch to the existing demo.

Default: read-only AWS dry run and private local rollback snapshots.
Apply only when the source and local city quality checks are ready:
  python scripts/deploy_city_patch.py --dry-run
  python scripts/deploy_city_patch.py --apply --plan evidence/city-patch-plan.json

Only server/gamespec.py inside the fresh Lambda ZIP and the shared city.js
template are replaced. No generated game/session, asset kit, auth, configuration,
infrastructure or model job is changed.
"""
from __future__ import annotations

import argparse
import copy
import io
import json
from pathlib import Path
import sys
import time
import uuid
import zipfile

import boto3

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
import deploy_city_games as core

MODULE = "server/gamespec.py"
SOURCE = "game3d/city.js"
KEY = "runtime3d/v1/city.js"


def package(original):
    module = core.local_file(ROOT, MODULE).read_bytes()
    with zipfile.ZipFile(io.BytesIO(original)) as baseline:
        names = baseline.namelist()
        core.require(len(names) == len(set(names)) and MODULE in names
                     and "server/city_contract.py" in names,
                     "Existing city ZIP is missing or has duplicate application modules")
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
            for info in baseline.infolist():
                target.writestr(copy.copy(info), module if info.filename == MODULE
                                else baseline.read(info.filename))
        result = output.getvalue()
        with zipfile.ZipFile(io.BytesIO(result)) as target:
            unchanged = [name for name in names if name != MODULE]
            core.require(all(baseline.read(name) == target.read(name) for name in unchanged),
                         "An unrelated deployed Lambda ZIP member changed")
            core.require(target.read(MODULE) == module, "Gamespec module packaging mismatch")
    core.require(len(result) <= 50 * 1024 * 1024, "Patch ZIP exceeds the direct code-update bound")
    return result, core.sha(module), len(unchanged)


def source():
    blob = core.local_file(ROOT, SOURCE).read_bytes()
    return blob, {"source": SOURCE, "sha256": core.sha(blob), "bytes": len(blob)}


def dry_run(args, clients, gate):
    lam, s3, cf = clients
    config, original = core.fetch_lambda(lam)
    updated, module_sha, preserved = package(original)
    body, item = source()
    previous = core.object_snapshot(s3, KEY)
    core.require(previous is not None, "Existing city.js template is missing")
    run = ROOT / "build/city-patch" / uuid.uuid4().hex
    run.mkdir(parents=True, mode=0o700)
    core.private_write(run / "baseline-lambda.zip", original)
    core.private_write(run / "planned-lambda.zip", updated)
    core.private_write(run / "baseline-s3" / KEY, previous[0])
    report = {
        "status": "DRY_RUN_READY", "observedAt": core.now(), "awsWrites": False,
        "host": core.HOST, "account": core.ACCOUNT, "function": core.FUNCTION, "bucket": core.BUCKET,
        "scope": "Only deployed gamespec.py and shared city.js template; generated games and sessions untouched",
        "proofScope": "Read-only code/source/auth preflight and backups; not skeletal animation or gameplay proof",
        "anonymousDenial": gate, "distributionId": core.distribution_id(cf),
        "baselineCodeSha256": config["CodeSha256"], "baselineRevisionId": config["RevisionId"],
        "plannedCodeSha256": core.code_sha(updated), "module": {"path": MODULE, "sha256": module_sha},
        "object": {"key": KEY, **item}, "previousObject": {
            "sha256": core.sha(previous[0]), "bytes": len(previous[0]), "metadata": previous[1]},
        "backupDirectory": run.relative_to(ROOT).as_posix(),
        "untouchedMembers": preserved, "unrelatedLambdaBytesPreserved": True,
        "configurationChanges": False, "generatedGameChanges": False, "modelJobs": 0,
    }
    core.save(args.report, report)
    print(json.dumps({"status": report["status"], "awsWrites": False, "modules": 1, "objects": 1,
                      "unrelatedMembersPreserved": preserved,
                      "plan": args.report.relative_to(ROOT).as_posix()}), flush=True)


def apply(args, clients, gate):
    core.require(args.plan is not None, "--apply requires a saved dry-run --plan")
    plan = json.loads(args.plan.read_bytes())
    core.require(plan.get("status") == "DRY_RUN_READY" and plan.get("awsWrites") is False
                 and plan.get("host") == core.HOST and plan.get("account") == core.ACCOUNT
                 and plan.get("module", {}).get("path") == MODULE and plan.get("object", {}).get("key") == KEY,
                 "Expected unchanged bounded city patch plan is required")
    lam, s3, cf = clients
    config, original = core.fetch_lambda(lam)
    core.require(config["CodeSha256"] == plan["baselineCodeSha256"]
                 and config["RevisionId"] == plan["baselineRevisionId"],
                 "Concurrent Lambda change detected; run a fresh dry run")
    updated, module_sha, preserved = package(original)
    body, item = source()
    core.require(plan["plannedCodeSha256"] == core.code_sha(updated)
                 and plan["module"]["sha256"] == module_sha
                 and plan["object"] == {"key": KEY, **item},
                 "Local patch source changed after planning; run a fresh dry run")
    previous = core.object_snapshot(s3, KEY)
    core.require(previous is not None and core.sha(previous[0]) == plan["previousObject"]["sha256"],
                 "Shared city template changed concurrently; run a fresh dry run")
    core.require(core.distribution_id(cf) == plan["distributionId"], "Existing distribution changed")
    report = {**plan, "status": "DEPLOYING", "awsWrites": True, "startedAt": core.now(),
              "anonymousDenial": gate, "appliedPlan": args.plan.relative_to(ROOT).as_posix()}
    core.save(args.report, report)
    try:
        s3.put_object(Bucket=core.BUCKET, Key=KEY, Body=body,
                      ContentType="application/javascript")
        actual_object = core.object_snapshot(s3, KEY)
        core.require(actual_object is not None and actual_object[0] == body, "Shared city.js byte verification failed")
        report["objectVerified"] = True
        core.save(args.report, report)
        lam.update_function_code(FunctionName=core.FUNCTION, ZipFile=updated,
                                 RevisionId=config["RevisionId"])
        print("Bounded city patch submitted; waiting for Lambda readiness.", flush=True)
        deadline = time.monotonic() + 180
        while True:
            current = lam.get_function_configuration(FunctionName=core.FUNCTION)
            core.require(current.get("LastUpdateStatus") != "Failed", "Lambda patch update failed")
            if current.get("LastUpdateStatus") == "Successful" and current["CodeSha256"] == core.code_sha(updated):
                break
            core.require(time.monotonic() < deadline, "Lambda patch readiness timed out")
            time.sleep(2)
        final_config, actual = core.fetch_lambda(lam)
        core.require(actual == updated, "Complete deployed ZIP differs from the planned patch ZIP")
        fields = ("Environment", "Role", "Runtime", "Handler", "Timeout", "MemorySize", "Layers",
                  "VpcConfig", "KMSKeyArn", "Architectures")
        core.require(all(config.get(field) == final_config.get(field) for field in fields),
                     "Lambda configuration changed during the code-only patch")
        invalidation = cf.create_invalidation(DistributionId=plan["distributionId"], InvalidationBatch={
            "Paths": {"Quantity": 1, "Items": ["/" + KEY]},
            "CallerReference": "city-rig-patch-" + uuid.uuid4().hex,
        })["Invalidation"]
        report.update(status="DEPLOYED_S3_LAMBDA_VERIFIED_NEW_GAME_QA_PENDING",
                      codeSha256=final_config["CodeSha256"], configurationPreserved=True,
                      untouchedMembers=preserved, invalidationId=invalidation["Id"], completedAt=core.now(),
                      postDeployAnonymousDenial=core.audience_gate())
        core.save(args.report, report)
        print(json.dumps({"status": report["status"], "modules": 1, "objects": 1,
                          "report": args.report.relative_to(ROOT).as_posix()}), flush=True)
    except Exception as error:
        report.update(status="FAILED_OR_PARTIAL_DEPLOYMENT", failureType=type(error).__name__, failedAt=core.now())
        core.save(args.report, report)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Read-only AWS plan (default)")
    mode.add_argument("--apply", action="store_true", help="Apply the unchanged plan after root quality checks")
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    args.plan = (ROOT / args.plan).resolve() if args.plan else None
    args.report = (ROOT / (args.report or ("evidence/city-patch.json" if args.apply else
                                         "evidence/city-patch-plan.json"))).resolve()
    core.require(args.report.is_relative_to(ROOT) and
                 (args.plan is None or args.plan.is_relative_to(ROOT)), "Plan/report must remain inside this workspace")
    core.require(not args.apply or args.plan != args.report, "Apply report must not overwrite the dry-run plan")
    caller = boto3.client("sts", region_name=core.REGION).get_caller_identity()
    core.require(caller["Account"] == core.ACCOUNT, "Caller is outside the expected AWS account")
    gate = core.audience_gate()
    clients = (boto3.client("lambda", region_name=core.REGION), boto3.client("s3", region_name=core.REGION),
               boto3.client("cloudfront", region_name=core.REGION))
    if args.apply:
        apply(args, clients, gate)
    else:
        dry_run(args, clients, gate)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        detail = str(error) if type(error) is RuntimeError else "Review the saved patch plan/report."
        print(f"City patch stopped ({type(error).__name__}): {detail}", file=sys.stderr)
        sys.exit(1)
