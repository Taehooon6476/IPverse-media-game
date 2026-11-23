#!/usr/bin/env python3
"""Plan/apply the UI usability improvements on the existing demo; frontend objects only."""
import argparse
import concurrent.futures
import json
import uuid
from pathlib import Path

import boto3
import deploy_city_games as core


def frontend_candidates():
    result = {}
    dist = core.ROOT / "web/dist"
    core.local_file(dist, "index.html")
    for file in sorted(dist.rglob("*")):
        if file.is_file() and file.relative_to(dist).as_posix() != "config.json":
            core.require(file.suffix in core.WEB_EXTENSIONS and not file.is_symlink(), "Unexpected frontend file")
            core.add(result, "web/" + file.relative_to(dist).as_posix(), file)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--plan", type=Path)
    args = parser.parse_args()
    clients = (boto3.client("s3", region_name=core.REGION),
               boto3.client("lambda", region_name=core.REGION),
               boto3.client("cloudfront"))
    s3, lam, cf = clients
    core.require(boto3.client("sts", region_name=core.REGION).get_caller_identity()["Account"] == core.ACCOUNT,
                 "Unexpected AWS account")
    gate = core.audience_gate()
    possible = frontend_candidates()
    config = core.object_snapshot(s3, "web/config.json")
    core.require(config is not None and b"PLACEHOLDER" not in config[0], "Unexpected public auth config")
    function = lam.get_function_configuration(FunctionName=core.FUNCTION)
    baseline = function["CodeSha256"]
    out = core.ROOT / ("evidence/uiux-20261101/deployment.json" if args.apply
                       else "evidence/uiux-20261101/deployment-plan.json")
    if args.apply:
        core.require(args.plan is not None, "Apply requires an unchanged reviewed plan")
        plan_path = (core.ROOT / args.plan).resolve()
        core.require(plan_path.is_relative_to(core.ROOT), "Plan must be local")
        plan = json.loads(plan_path.read_bytes())
        core.require(plan["status"] == "DRY_RUN_READY" and plan["host"] == core.HOST
                     and plan["account"] == core.ACCOUNT and plan["lambdaSha256"] == baseline
                     and plan["publicConfigSha256"] == core.sha(config[0]), "Live baseline changed")
        upload = {key: possible[key] for key in plan["objects"]}
        core.require(core.public_items(upload) == plan["objects"], "Local build changed after plan")
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            current = dict(pool.map(lambda key: (key, core.object_snapshot(s3, key)), possible))
        upload = {key: value for key, value in possible.items()
                  if current[key] is None or core.sha(current[key][0]) != value["sha256"]}
        backup = core.ROOT / "build/uiux-web-deployment" / uuid.uuid4().hex
        backup.mkdir(parents=True, mode=0o700)
        previous = {}
        for key in upload:
            result = current[key]
            previous[key] = {"exists": result is not None}
            if result is not None:
                path = backup / key
                core.private_write(path, result[0])
                previous[key].update(sha256=core.sha(result[0]), backup=path.relative_to(core.ROOT).as_posix(),
                                     metadata=result[1])
        plan = {
            "status": "DRY_RUN_READY", "observedAt": core.now(), "awsWrites": False,
            "account": core.ACCOUNT, "host": core.HOST,
            "scope": "UI layout, accessibility, labels and dialogs only; frontend objects only; existing API, Lambda, auth config and game assets preserved",
            "distributionId": core.distribution_id(cf), "lambdaSha256": baseline,
            "publicConfigSha256": core.sha(config[0]), "objects": core.public_items(upload),
            "previousObjects": previous, "anonymousDenial": gate,
            "backupDirectory": backup.relative_to(core.ROOT).as_posix(),
        }
    core.require(upload and all(key.startswith("web/") and key != "web/config.json" for key in upload),
                 "No frontend changes or invalid scope")
    if args.apply:
        core.require(core.distribution_id(cf) == plan["distributionId"], "Distribution changed")
        # Compare each object again before writing any object.
        for key in upload:
            current = core.object_snapshot(s3, key)
            previous = plan["previousObjects"][key]
            core.require((current is None and not previous["exists"])
                         or (current is not None and previous["exists"]
                             and core.sha(current[0]) == previous["sha256"]), "Concurrent frontend change")
        plan.update(status="DEPLOYING", startedAt=core.now(), awsWrites=True, uploaded=[])
        core.save(out, plan)
        for key in sorted(upload, key=lambda name: (name.endswith("index.html"), name)):
            core.upload_one(s3, key, upload[key], plan, out)
        invalidation = cf.create_invalidation(DistributionId=plan["distributionId"], InvalidationBatch={
            "Paths": {"Quantity": 3, "Items": ["/", "/index.html", "/assets/*"]},
            "CallerReference": "uiux-web-" + uuid.uuid4().hex,
        })["Invalidation"]
        core.require(lam.get_function_configuration(FunctionName=core.FUNCTION)["CodeSha256"] == baseline,
                     "Lambda changed during frontend-only deployment")
        core.require(core.object_snapshot(s3, "web/config.json")[0] == config[0], "Auth config changed")
        plan.update(status="DEPLOYED_S3_VERIFIED_NATIVE_QA_PENDING", completedAt=core.now(),
                    invalidationId=invalidation["Id"], lambdaBytePreserved=True, publicConfigBytePreserved=True,
                    postDeployAnonymousDenial=core.audience_gate())
    core.save(out, plan)
    print(json.dumps({"status": plan["status"], "objects": len(upload), "lambdaWrites": 0,
                      "report": out.relative_to(core.ROOT).as_posix()}))


if __name__ == "__main__":
    main()
