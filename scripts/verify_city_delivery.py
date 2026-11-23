#!/usr/bin/env python3
"""Read-only delivery checks for the existing IPverse city platform.

Verify deployed code, all planned S3 objects, intended public frontend/runtime
bytes, the publicly published CC0 kit, auth denial and private S3/OAC. When the
actual city generation report is complete, additionally verify each fresh game
manifest/runtime/model over public HTTPS. Never invoke generation or mutate AWS.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import io
import json
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

import boto3
from botocore.config import Config

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import deploy_city_games as core

REPORT = ROOT / "evidence/city-delivery-live.json"
LIMIT = 64 * 1024 * 1024
KIT_PREFIX = "games/city-kit/v1/"
AWS_CONFIG = Config(connect_timeout=5, read_timeout=15, retries={"max_attempts": 2})


def read_report(name):
    path = ROOT / "evidence" / name
    # The report may be mid-write by another process: retry the read.
    for attempt in range(5):
        try:
            return json.loads(path.read_bytes())
        except json.JSONDecodeError:
            if attempt == 4:
                raise
            time.sleep(.2)


def invalidation(cf, distribution, identity):
    deadline = time.monotonic() + 55
    while True:
        result = cf.get_invalidation(DistributionId=distribution, Id=identity)["Invalidation"]
        if result["Status"] == "Completed" or time.monotonic() >= deadline:
            return {"id": identity, "status": result["Status"], "pollBudgetSeconds": 55}
        time.sleep(3)


def public_bytes(path, expected_bytes):
    core.require(isinstance(path, str) and not path.startswith("/")
                 and "\\" not in path and ".." not in path.split("/")
                 and 0 <= expected_bytes <= LIMIT, "Untrusted public delivery path or byte bound")
    url = "https://" + core.HOST + "/" + urllib.parse.quote(path, safe="/")
    with urllib.request.urlopen(url, timeout=25) as response:
        core.require(response.status == 200 and response.geturl() == url,
                     "Expected direct public HTTPS success was not observed")
        return response.read(expected_bytes + 1)


def verify_public(item):
    body = public_bytes(item["path"], item["bytes"])
    core.require(len(body) == item["bytes"] and core.sha(body) == item["sha256"],
                 "Public HTTPS object differs from the expected deployed bytes")
    return {**item, "httpsStatus": 200, "httpsByteVerified": True}


def verify_planned(pair, s3):
    key, item = pair
    actual = core.object_snapshot(s3, key)
    core.require(actual is not None and len(actual[0]) == item["bytes"]
                 and core.sha(actual[0]) == item["sha256"], "Planned S3 object differs from deployment")
    row = {"key": key, "sha256": item["sha256"], "bytes": item["bytes"], "s3ByteVerified": True}
    if key.startswith("runtime3d/v1/"):
        # These are private server-side copy templates. The kit's intended
        # public endpoint is games/city-kit/v1; game copies have games/gm_* paths.
        row.update(httpsScope="Internal template; verified in S3. Public game/kit copies verified separately.")
    else:
        path = key.removeprefix("web/") if key.startswith("web/") else key
        row.update(verify_public({"path": path, "sha256": item["sha256"], "bytes": item["bytes"]}))
    return row


def lambda_code(lam, deployment, patch):
    config, actual = core.fetch_lambda(lam)
    core.require(config["CodeSha256"] == patch["codeSha256"], "Current Lambda SHA differs from the completed patch")
    expected_zip = core.local_file(ROOT, patch["backupDirectory"] + "/planned-lambda.zip").read_bytes()
    core.require(actual == expected_zip, "Current complete Lambda ZIP differs from the planned deployed ZIP")
    expected_modules = {**deployment["modules"], patch["module"]["path"]: patch["module"]["sha256"]}
    with zipfile.ZipFile(io.BytesIO(actual)) as current:
        modules = {name: core.sha(current.read(name)) for name in expected_modules}
        core.require(modules == expected_modules, "An actual city application module differs from deployment")
        baseline_zip = core.local_file(ROOT, patch["backupDirectory"] + "/baseline-lambda.zip").read_bytes()
        with zipfile.ZipFile(io.BytesIO(baseline_zip)) as baseline:
            others = [name for name in baseline.namelist() if name != patch["module"]["path"]]
            core.require(current.namelist() == baseline.namelist()
                         and all(current.read(name) == baseline.read(name) for name in others),
                         "Patch changed an unrelated deployed ZIP member")
    first_baseline = json.loads((ROOT / "build/game-personalization/baseline-deployment.json").read_bytes())
    runtime_match = config.get("Runtime") == first_baseline.get("Runtime")
    core.require(runtime_match and deployment.get("configurationPreserved") is True
                 and patch.get("configurationPreserved") is True,
                 "Existing configuration preservation evidence is missing or runtime drifted")
    return {"codeSha256": config["CodeSha256"], "lastUpdateStatus": config["LastUpdateStatus"],
            "actualCompleteZipMatch": True, "actualModuleSha256": modules,
            "unrelatedMembersByteVerified": len(others), "runtimeMatchesOriginal": runtime_match,
            "configurationPreservedAtDeploymentReported": True,
            "configurationScope": "Current runtime checked; other unchanged configuration verified by deployment reports. "
                                  "Historical environment/secret values are not persisted here."}


def storage_protection(s3, cf, distribution):
    block = s3.get_public_access_block(Bucket=core.BUCKET)["PublicAccessBlockConfiguration"]
    policy_status = s3.get_bucket_policy_status(Bucket=core.BUCKET)["PolicyStatus"]
    core.require(all(block.get(key) is True for key in ("BlockPublicAcls", "IgnorePublicAcls",
                                                      "BlockPublicPolicy", "RestrictPublicBuckets"))
                 and policy_status.get("IsPublic") is False, "Expected private S3 storage boundary is absent")
    distro = cf.get_distribution_config(Id=distribution)["DistributionConfig"]
    s3_origins = [origin for origin in distro["Origins"]["Items"]
                  if origin["DomainName"].startswith(core.BUCKET + ".s3.")]
    controls = []
    for identity in sorted({origin.get("OriginAccessControlId") for origin in s3_origins}):
        core.require(bool(identity), "S3 distribution origin has no OAC")
        config = cf.get_origin_access_control(Id=identity)["OriginAccessControl"]["OriginAccessControlConfig"]
        core.require(config.get("OriginAccessControlOriginType") == "s3"
                     and config.get("SigningBehavior") == "always" and config.get("SigningProtocol") == "sigv4",
                     "S3 origin does not use the expected signed OAC")
        controls.append({"id": identity, "originType": "s3", "signingBehavior": "always", "signingProtocol": "sigv4"})
    core.require(s3_origins and controls, "Expected S3 CDN origins were not found")
    games_route = next((behavior for behavior in distro.get("CacheBehaviors", {}).get("Items", [])
                       if behavior["PathPattern"].lstrip("/") == "games/*"), None)
    core.require(games_route and any(origin["Id"] == games_route["TargetOriginId"]
                                    and origin.get("OriginPath", "") == "" for origin in s3_origins),
                 "Existing games route does not target the root private S3 origin")
    return {"publicAccessBlock": block, "bucketPolicyIsPublic": False, "oac": controls,
            "publicGamesRouteUsesRootS3Origin": True,
            "scope": "Private S3 direct-storage boundary; intentional public demo game/CC0 CDN routes remain public."}


def game_delivery(s3):
    path = ROOT / "evidence/city-generation-live.json"
    if not path.exists():
        return {"status": "GENERATION_PENDING", "cases": []}
    generation = read_report(path.name)
    cases = generation.get("cases", [])
    if generation.get("status") not in {
        "GENERATION_VERIFIED_GAMEPLAY_PENDING", "GENERATED_AND_BYTE_VERIFIED"
    } or not cases or not all(c.get("ok") for c in cases):
        return {"status": "GENERATION_PENDING", "generationStatus": generation.get("status"), "cases": []}
    delivered = []
    for case in cases:
        identity = case["gameId"]
        core.require(re.fullmatch(r"gm_[a-f0-9]{10}", identity) is not None,
                     "Generation report contains an unexpected game identifier")
        prefix = "games/" + identity + "/"
        core.require(case["specKey"] == prefix + "spec.json"
                     and case["previewUrl"] == "https://" + core.HOST + "/" + prefix + "index.html",
                     "Generated preview path is outside the expected owned game folder")
        expected = [{"path": case["specKey"], "sha256": case["specSha256"], "bytes": case["specBytes"],
                     "kind": "spec"}]
        for item in case["runtimeBindings"]:
            local = core.local_file(ROOT / "game3d", item["file"]).read_bytes()
            core.require(item.get("matchesCurrentSource") is True and core.sha(local) == item["sha256"],
                         "Packaged game runtime differs from the current verified source")
            expected.append({"path": prefix + item["file"], "sha256": item["sha256"],
                             "bytes": item["bytes"], "kind": "runtime"})
        for item in case["assetBindings"]:
            core.require(item.get("matchesSelectedAsset") is True and item["packagedKey"].startswith(prefix + "assets/"),
                         "Packaged model/cutout lineage evidence is missing")
            expected.append({"path": item["packagedKey"], "sha256": item["sha256"], "bytes": item["bytes"],
                             "kind": "selected-ip-asset", "role": item["role"], "ipId": item["ipId"]})
        spec = case["spec"]
        rigged = [entity for entity in [spec["player"], *spec["props"], *spec["enemies"]]
                  if entity.get("modelUrl", "").endswith(".rig.glb")]
        if rigged:
            core.require(spec.get("animUrl") == "assets/ual.glb", "Rigged game lacks the shared UAL library")
            library = s3.get_object(Bucket=core.BUCKET, Key="runtime3d/v1/anims/ual.glb")["Body"].read()
            core.require(library.startswith(b"glTF") and len(library) <= LIMIT, "Expected real UAL library is invalid")
            expected.append({"path": prefix + "assets/ual.glb", "sha256": core.sha(library),
                             "bytes": len(library), "kind": "animation-library"})
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            verified = list(pool.map(verify_public, expected))
        delivered.append({"type": case["type"], "gameId": identity, "previewUrl": case["previewUrl"],
                          "gameManifestAndRuntimeFiles": 1 + len(case["runtimeBindings"]),
                          "selectedAssetFiles": len(case["assetBindings"]), "objects": verified,
                          "sourcePromptSha256": core.sha(spec["design"]["sourcePrompt"].encode()),
                          "actualCityDimensions": [spec["world"]["width"], spec["world"]["depth"]],
                          "scope": "Public runtime/manifest/model/library bytes; not loaded-model or gameplay proof."})
    return {"status": "FRESH_GAME_PUBLIC_BYTES_VERIFIED", "cases": delivered,
            "generationEvidenceSha256": core.sha(path.read_bytes()),
            "ownershipScope": "Source ownership/authenticated generation checks belong to the linked generation helper report."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=REPORT)
    args = parser.parse_args()
    args.report = (ROOT / args.report).resolve()
    core.require(args.report == REPORT.resolve(), "This verifier only writes its assigned delivery evidence")
    report = {"status": "VERIFYING", "startedAt": core.now(), "host": core.HOST, "awsWrites": False,
              "modelCalls": 0, "proofScope": "Independent read-only HTTPS/S3/Lambda/OAC/auth delivery verification. "
                                               "Static delivery success is distinct from UI/native-input gameplay."}
    core.save(args.report, report)
    try:
        identity = boto3.client("sts", region_name=core.REGION, config=AWS_CONFIG).get_caller_identity()
        core.require(identity["Account"] == core.ACCOUNT, "Unexpected AWS account")
        deployment = read_report("city-deployment.json")
        patch = read_report("city-patch.json")
        plan = read_report("city-deployment-plan.json")
        publication = read_report("city-kit-publication.json")
        route = read_report("city-runtime-route.json")
        core.require(deployment["status"].startswith("DEPLOYED") and patch["status"].startswith("DEPLOYED")
                     and publication["status"] == "PUBLIC_KIT_VERIFIED", "Required completed deployment/publication reports are missing")
        core.require(route["status"] == "S3_RUNTIME_TEMPLATE_VERIFIED"
                     and route["key"] == "runtime3d/v1/city.js"
                     and route["previousSha256"] == patch["object"]["sha256"]
                     and route["kitUrl"] == "/games/city-kit/v1/city-assets/commonassetcatalog.json"
                     and route["gameFoldersChanged"] == [],
                     "Final city runtime route receipt does not match the bounded template update")
        city_source = core.local_file(ROOT / "game3d", "city.js").read_bytes()
        core.require(len(city_source) == route["bytes"] and core.sha(city_source) == route["sha256"],
                     "Current city runtime source differs from the final route update receipt")
        lam = boto3.client("lambda", region_name=core.REGION, config=AWS_CONFIG)
        s3 = boto3.client("s3", region_name=core.REGION, config=AWS_CONFIG)
        cf = boto3.client("cloudfront", region_name=core.REGION, config=AWS_CONFIG)
        report["anonymousAndInvalidAuthDenied"] = core.audience_gate()
        report["lambda"] = lambda_code(lam, deployment, patch)
        report["storageProtection"] = storage_protection(s3, cf, deployment["distributionId"])
        report["invalidations"] = [invalidation(cf, deployment["distributionId"], item["invalidationId"])
                                   for item in (deployment, patch)]
        core.require(all(item["status"] == "Completed" for item in report["invalidations"]),
                     "CloudFront invalidation is still pending; rerun after completion")
        expected = dict(plan["objects"])
        expected[route["key"]] = {"key": route["key"], "sha256": route["sha256"], "bytes": route["bytes"]}
        report["finalCityRuntime"] = {
            "key": route["key"], "sha256": route["sha256"], "bytes": route["bytes"],
            "currentSourceByteVerified": True, "publicKitUrl": route["kitUrl"],
            "scope": "Final route receipt supersedes the earlier city.js patch hash; no existing game folders changed.",
        }
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            report["plannedObjects"] = list(pool.map(lambda item: verify_planned(item, s3), expected.items()))
        report["plannedS3ObjectCount"] = len(expected)
        report["publicFrontendAndLegacyTemplateCount"] = sum("httpsByteVerified" in item
                                                            for item in report["plannedObjects"])
        kit = []
        for item in publication["publicObjects"]:
            core.require(item["key"].startswith(KIT_PREFIX + "city-assets/"),
                         "Published kit evidence escaped the allowed public CC0 prefix")
            kit.append({"path": item["key"], "sha256": item["sha256"], "bytes": item["bytes"]})
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            report["publicCityKit"] = list(pool.map(verify_public, kit))
        report["publicKitModels"] = publication["assetCount"]
        report["publicKitObjectCount"] = len(kit)
        report["games"] = game_delivery(s3)
        report.update(status="STATIC_DELIVERY_VERIFIED_GAMEPLAY_UI_PENDING", completedAt=core.now(),
                      restrictedApiGateVerified=True, gameplayUiScope="Not verified by this delivery script.",
                      sourceReports=["city-deployment-plan.json", "city-deployment.json", "city-patch.json",
                                     "city-runtime-route.json", "city-kit-publication.json", "city-generation-live.json"])
        core.save(args.report, report)
        print(json.dumps({"status": report["status"], "plannedS3Objects": len(expected),
                          "publicKitObjects": len(kit), "actualKitModels": publication["assetCount"],
                          "newGames": len(report["games"]["cases"]), "awsWrites": False,
                          "report": args.report.relative_to(ROOT).as_posix()}), flush=True)
    except Exception as error:
        report.update(status="DELIVERY_FAILED_OR_PENDING", failureType=type(error).__name__, failedAt=core.now())
        if type(error) is RuntimeError:
            report["failure"] = str(error)
        core.save(args.report, report)
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        detail = str(error) if type(error) is RuntimeError else "Review the saved delivery report."
        print(f"City delivery verification stopped ({type(error).__name__}): {detail}", file=sys.stderr)
        sys.exit(1)
