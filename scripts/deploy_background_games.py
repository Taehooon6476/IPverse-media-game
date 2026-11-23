#!/usr/bin/env python3
"""Plan/apply only the existing demo's selected-background feature.

Reuse the code-only deployment guards and rollback snapshots. Existing games,
source IPs, Cognito config, passwords, infrastructure and GPU capacity remain
untouched. Only changed frontend files and five runtime templates are uploaded.
"""
import argparse
import concurrent.futures
import json
from pathlib import Path

import boto3
import deploy_city_games as core

MODULES = ("server/game_design.py", "server/gamespec.py", "server/tools.py",
           "server/authored_contract.py", "server/prompts.py", "server/agent.py")
RUNTIME = ("background.js", "background-data.js", "authored.js", "authored-contract.js", "city.js")


def candidates():
    result = {}
    dist = core.ROOT / "web/dist"
    core.local_file(dist, "index.html")
    for file in sorted(dist.rglob("*")):
        if file.is_file() and file.relative_to(dist).as_posix() != "config.json":
            core.require(file.suffix in core.WEB_EXTENSIONS and not file.is_symlink(), "Unexpected frontend file")
            core.add(result, "web/" + file.relative_to(dist).as_posix(), file)
    for name in RUNTIME:
        core.add(result, "runtime3d/v1/" + name, core.local_file(core.ROOT / "game3d", name))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--plan", type=Path)
    args = parser.parse_args()
    args.plan = (core.ROOT / args.plan).resolve() if args.plan else None
    args.report = core.ROOT / ("evidence/background-deployment.json" if args.apply
                              else "evidence/background-deployment-plan.json")
    core.require(args.plan is None or args.plan.is_relative_to(core.ROOT), "Plan must be inside target workspace")
    core.require(boto3.client("sts", region_name=core.REGION).get_caller_identity()["Account"] == core.ACCOUNT,
                 "Unexpected AWS account")
    clients = (boto3.client("lambda", region_name=core.REGION),
               boto3.client("s3", region_name=core.REGION), boto3.client("cloudfront"))
    before_config = core.object_snapshot(clients[1], "web/config.json")
    core.require(before_config is not None
                 and "PLACEHOLDER" not in before_config[0].decode(), "Existing public Cognito config is invalid")
    gate = core.audience_gate()
    possible = candidates()
    if args.apply:
        core.require(args.plan is not None, "Apply requires a saved dry-run plan")
        plan = json.loads(args.plan.read_bytes())
        core.require(set(plan["modules"]) == set(MODULES)
                     and set(plan["objects"]).issubset(possible)
                     and plan["backgroundFeature"] is True, "Unexpected deployment plan scope")
        upload = {key: possible[key] for key in plan["objects"]}
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            snapshots = list(pool.map(lambda key: (key, core.object_snapshot(clients[1], key)), possible))
        upload = {key: possible[key] for key, current in snapshots
                  if current is None or core.sha(current[0]) != possible[key]["sha256"]}
    core.require(upload and "web/config.json" not in upload, "No feature changes or invalid config target")
    core.CHANGED_MODULES = MODULES
    kit = {"assetCount": 0, "scope": "No shared asset kit uploads; only selected-background feature"}
    if args.apply:
        core.apply(args, upload, kit, clients, gate)
    else:
        core.dry_run(args, upload, kit, clients, gate)
    report = json.loads(args.report.read_bytes())
    report.update(backgroundFeature=True,
                  scope="Six background server modules, changed frontend files and background runtime templates only",
                  publicConfigSha256=core.sha(before_config[0]))
    after_config = core.object_snapshot(clients[1], "web/config.json")
    core.require(after_config is not None and after_config[0] == before_config[0],
                 "Public Cognito config changed during feature deployment")
    report["publicConfigBytePreserved"] = True
    core.save(args.report, report)


if __name__ == "__main__":
    main()
