#!/usr/bin/env python3
"""Read-only independent delivery/lineage audit of the native background test."""
from __future__ import annotations

import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import time
from types import SimpleNamespace
import zipfile

import boto3
from botocore.config import Config

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]
import deploy_city_games as core
import verify_city_delivery as delivery
from server import game_design, store, tools

REPORT = ROOT / "evidence/background-delivery-live.json"
SID = "ses_b84b58961e"
BG = "ip_65e7f7e34e"
IMAGE = "ast_e5b70b81c9"
IMAGE_SHA = "4f5605ef04d88c7bdbd41b753e8b322f4313d6d5a85bdd9e633b2c6b5ca1eb8c"
GAME = "gm_d29f0e77e6"
LIMIT = 64 * 1024 * 1024
CONFIG = Config(connect_timeout=5, read_timeout=15, retries={"max_attempts": 2})


def digest(value):
    return hashlib.sha256(json.dumps(store.plain(value), sort_keys=True,
                                     ensure_ascii=False).encode()).hexdigest()


def s3_bytes(s3, key):
    response = s3.get_object(Bucket=core.BUCKET, Key=key)
    body = response["Body"]
    try:
        result = body.read(LIMIT + 1)
    finally:
        body.close()
    core.require(0 < len(result) <= LIMIT, "S3 byte count is empty or exceeds the bounded audit")
    return result


def bytes_receipt(key, body, public=True):
    result = {"key": key, "bytes": len(body), "sha256": core.sha(body), "s3ByteVerified": True}
    if public:
        path = key.removeprefix("web/") if key.startswith("web/") else key
        result.update(delivery.verify_public({"path": path, "bytes": len(body), "sha256": core.sha(body)}))
    return result


def deployed_code(lam, receipt):
    config, blob = core.fetch_lambda(lam)
    core.require(config["CodeSha256"] == receipt["codeSha256"], "Lambda changed since the background deployment")
    folder = receipt["backupDirectory"]
    core.require(blob == core.local_file(ROOT, folder + "/planned-lambda.zip").read_bytes(),
                 "Deployed complete Lambda ZIP differs from its actual deployment plan")
    actual = {}
    with zipfile.ZipFile(io.BytesIO(blob)) as current:
        for name, expected in receipt["modules"].items():
            actual[name] = core.sha(current.read(name))
            core.require(actual[name] == expected == core.sha(core.local_file(ROOT, name).read_bytes()),
                         "Deployed background module differs from the frozen source")
        with zipfile.ZipFile(core.local_file(ROOT, folder + "/baseline-lambda.zip")) as baseline:
            unrelated = [name for name in baseline.namelist() if name not in receipt["modules"]]
            current_names = current.namelist()
            baseline_names = baseline.namelist()
            core.require(len(current_names) == len(set(current_names))
                         and len(baseline_names) == len(set(baseline_names))
                         and set(current_names) == set(baseline_names)
                         and all(current.read(name) == baseline.read(name) for name in unrelated),
                         "An unrelated Lambda member changed during the background deployment")
    core.require(len(actual) == 6 and receipt.get("configurationPreserved") is True,
                 "Six-module configuration-preserving deployment evidence is incomplete")
    return {"codeSha256": config["CodeSha256"], "lastUpdateStatus": config["LastUpdateStatus"],
            "completeZipByteMatch": True, "sixModulesSourceByteVerified": actual,
            "unrelatedMembersByteVerified": len(unrelated),
            "memberNamesIdenticalAndDuplicateFree": True,
            "zipMemberOrderScope": "Member order may change when scoped replacements are appended; identity and full bytes are verified.",
            "configurationPreservedAtDeploymentReported": True,
            "configurationScope": "Deployment receipt verifies unchanged config; historical secret/environment values are not stored."}


def main():
    report = {"status": "VERIFYING", "startedAt": core.now(), "awsWrites": False, "modelCalls": 0,
              "sessionId": SID, "backgroundIpId": BG, "gameId": GAME,
              "priorVerifierFailure": {
                  "receipt": "evidence/background-delivery-initial-zip-order-failure.json",
                  "diagnosis": "evidence/background-delivery-zip-order-diagnosis.json",
                  "cause": "ZIP member order equality was too strict; actual member identities and 46 unrelated full contents match."},
              "scope": "Independent read-only DDB/S3/public HTTPS/Lambda audit of the actual native-UI-created background and game. "
                       "Native playback/completion is a separate evidence scope."}
    core.save(REPORT, report)
    try:
        core.require(boto3.client("sts", region_name=core.REGION, config=CONFIG).get_caller_identity()["Account"] == core.ACCOUNT,
                     "Unexpected AWS account")
        prep = delivery.read_report("background-game-test.json")
        deployment = delivery.read_report("background-deployment.json")
        studio = delivery.read_report("background-studio-live.json")
        core.require(prep["sessionId"] == SID and studio["sessionId"] == SID and studio["status"] == "PASS"
                     and deployment["status"].startswith("DEPLOYED"), "Required actual UI/preparation/deployment receipts are incomplete")
        s3 = boto3.client("s3", region_name=core.REGION, config=CONFIG)
        lam = boto3.client("lambda", region_name=core.REGION, config=CONFIG)
        cf = boto3.client("cloudfront", region_name=core.REGION, config=CONFIG)
        ctx = SimpleNamespace(table=boto3.resource("dynamodb", region_name=core.REGION, config=CONFIG).Table("ipverse-main"))
        source = store.snapshot(ctx, prep["sourceSession"])
        target = store.snapshot(ctx, SID)
        source_hash = digest(source)
        core.require(source_hash == prep["sourceSnapshotSha256"] == prep["sourceSnapshotBackupSha256"],
                     "The original source session changed since preparation")
        owner = prep["sourceSnapshotBackup"]["session"]["userSub"]
        core.require(source["session"]["userSub"] == target["session"]["userSub"] == owner
                     and SID != prep["sourceSession"] and SID not in prep["initialSessionIds"],
                     "New session is not the fresh session owned by the authenticated preparation operator")
        ips = {i["ipId"]: i for i in target["ips"]}
        assets = {a["assetId"]: a for a in target["assets"]}
        core.require(set(ips) == {*prep["preparedCastIpIds"], BG}
                     and set(assets) == {*prep["preparedAssetIds"], IMAGE, "ast_58f49a5d3d"},
                     "The native test has an unexpected IP or media asset")
        baseline_ips = {i["ipId"]: i for i in prep["sourceSnapshotBackup"]["ips"]}
        baseline_assets = {a["assetId"]: a for a in prep["sourceSnapshotBackup"]["assets"]}
        core.require(all(digest(ips[i]) == digest(baseline_ips[i]) for i in prep["preparedCastIpIds"])
                     and all(digest(assets[i]) == digest(baseline_assets[i]) for i in prep["preparedAssetIds"]),
                     "Prepared original player/core records changed during background testing")
        report["ownershipAndSourcePreservation"] = {
            "sourceSession": prep["sourceSession"], "actualSourceSnapshotSha256": source_hash,
            "matchesPreTestFullSnapshot": True, "newSessionSameOwner": True,
            "ownerSha256": core.sha(owner.encode()), "freshSessionVerified": True,
            "originalPreparedIpRecordsUnchanged": len(prep["preparedCastIpIds"]),
            "originalPreparedAssetRecordsUnchanged": len(prep["preparedAssetIds"]),
            "ownerScope": "Actual DDB owners match the authenticated native/preparation receipt; no new authentication or secret read by this auditor."}
        core.require(all(m["status"] == "done" for m in target["messages"]) and len(target["messages"]) == 4
                     and target["jobs"] == [], "The two native turns are incomplete or created an unexpected model job")
        calls = [event["tool"] for m in target["messages"] for event in m.get("toolEvents", [])]
        core.require(calls == ["create_ip_asset", "make_game"], "Unexpected media/model tool calls in the native test")
        bg = ips[BG]
        original, preview = assets[bg["imageAssetId"]], assets[bg["cutoutAssetId"]]
        core.require(bg["kind"] == "prop" and bg["usage"] == "background"
                     and original["assetId"] == IMAGE and original["kind"] == "image"
                     and original["ipId"] == preview["ipId"] == BG
                     and original["key"] == f"sessions/{SID}/{IMAGE}.png"
                     and original["meta"]["model"] == "krea",
                     "Selected background original/model metadata does not match the actual native creation")
        core.require(preview["kind"] == "cutout" and preview["assetId"] != IMAGE
                     and preview["meta"] == {"backgroundPreserved": True, "forAssetId": IMAGE},
                     "The separate full-scene compatibility preview lost its original pairing")
        original_bytes, preview_bytes = (s3_bytes(s3, a["key"]) for a in (original, preview))
        core.require(len(original_bytes) == 1104701 and core.sha(original_bytes) == IMAGE_SHA
                     and original_bytes == preview_bytes and original_bytes.startswith(b"\x89PNG\r\n\x1a\n"),
                     "Actual original/preserved-preview bytes differ from the native generation receipt")
        original_row = bytes_receipt(original["key"], original_bytes)
        preview_row = bytes_receipt(preview["key"], preview_bytes)
        prompt = original["meta"]["prompt"]
        core.require("Full environmental scene" in prompt and "Wide establishing composition" in prompt
                     and "plain neutral studio background" not in prompt, "The actual provider prompt is not a full-environment request")
        report["backgroundCreation"] = {
            "ipId": BG, "kind": bg["kind"], "usage": bg["usage"], "imageAssetId": IMAGE,
            "imageAssetKind": "image", "sourceModelMetadata": original["meta"]["model"],
            "promptSha256": core.sha(prompt.encode()), "prompt": prompt,
            "pngDimensions": list(struct.unpack(">II", original_bytes[16:24])),
            "createdAt": original["createdAt"], "original": original_row, "preview": preview_row,
            "previewAssetId": preview["assetId"], "previewMeta": preview["meta"],
            "previewBytesIntentionallyEqual": True,
            "providerScope": "Actual committed Krea model metadata and successful native create_ip_asset turn; no independent GPU execution trace is persisted by the existing image provider."}
        # Only this fresh target's game records are consulted to resolve the new game.
        deadline = time.monotonic() + 55
        while not any(g["gameId"] == GAME for g in target["games"]):
            core.require(time.monotonic() < deadline, "Actual target game creation is still pending")
            time.sleep(3)
            target = store.snapshot(ctx, SID)
        game = next(g for g in target["games"] if g["gameId"] == GAME)
        prefix = f"games/{GAME}/"
        core.require(game["specKey"] == prefix + "spec.json"
                     and game["previewUrl"] == f"https://{core.HOST}/{prefix}index.html",
                     "Actual target game points outside its own folder")
        spec_bytes = s3_bytes(s3, game["specKey"])
        spec = json.loads(spec_bytes)
        actual_bg = spec["world"]["background"]
        core.require(actual_bg == {"ipId": BG, "mode": "image", "rotation": 0,
                                   "imageUrl": f"assets/{BG}.background.png"},
                     "Live game did not resolve the selected original image in the separate background slot")
        design_messages = [m for m in target["messages"] if m.get("gameDesign")]
        core.require(len(design_messages) == 1, "Expected one native structured game-design submission")
        design = design_messages[0]["gameDesign"]
        core.require(design["backgroundIpId"] == spec["design"]["backgroundIpId"] == BG
                     and spec["design"]["sourcePrompt"] == design["prompt"] == design_messages[0]["text"]
                     and game_design.role_errors(spec, design) == []
                     and set(game["castIpIds"]) == set(design["castIpIds"]) == set(ips),
                     "Saved game roles/cast or original native user prompt were substituted")
        core.require(spec["player"]["ipId"] == prep["commonCast"]["playerIpId"]
                     and [p["ipId"] for p in spec["props"]] == prep["commonCast"]["propIpIds"]
                     and spec["enemies"] == [] and "npc" not in spec["world"] and "city" not in spec["world"]
                     and [spec["world"]["width"], spec["world"]["depth"]] == [60, 48]
                     and [stage["type"] for stage in spec["mission"]["stages"]] == ["collect", "reach"],
                     "Actual saved game changed the selected roles or requested playable design")
        packed_bg_key = prefix + actual_bg["imageUrl"]
        packed_bg = s3_bytes(s3, packed_bg_key)
        core.require(packed_bg == original_bytes, "Actual game background differs from the selected original full image")
        game_objects = [bytes_receipt(game["specKey"], spec_bytes), bytes_receipt(packed_bg_key, packed_bg)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            def runtime(name):
                local = core.local_file(ROOT / "game3d", name).read_bytes()
                template = s3_bytes(s3, "runtime3d/v1/" + name)
                packed = s3_bytes(s3, prefix + name)
                core.require(local == template == packed, "A background game runtime copy differs from its current deployed source")
                return bytes_receipt(prefix + name, packed)
            game_objects += list(pool.map(runtime, tools.RUNTIME3D_FILES))
        # Derive each selected player's/item's original metadata independently
        # from its resolved filename; then compare full source and game bytes.
        selected = []
        for entity in [spec["player"], *spec["props"], *spec["enemies"]]:
            ip = ips[entity["ipId"]]
            for field in ("spriteUrl", "modelUrl"):
                url = entity.get(field)
                if not url:
                    continue
                source_field = ("cutoutAssetId" if field == "spriteUrl" else
                                "riggedGlbAssetId" if url.endswith(".rig.glb") else "glbAssetId")
                asset = assets[ip[source_field]]
                core.require(asset["ipId"] == ip["ipId"], "Existing selected IP source lineage mismatch")
                source_body = s3_bytes(s3, asset["key"])
                game_body = s3_bytes(s3, prefix + url)
                core.require(source_body == game_body, "A selected original IP asset changed during game packaging")
                selected.append({"ipId": ip["ipId"], "sourceAssetId": asset["assetId"],
                                 "sourceKey": asset["key"], **bytes_receipt(prefix + url, game_body)})
        if spec.get("animUrl"):
            library = s3_bytes(s3, "runtime3d/v1/anims/ual.glb")
            actual_library = s3_bytes(s3, prefix + spec["animUrl"])
            core.require(library == actual_library and library.startswith(b"glTF"), "Shared UAL animation library copy differs")
            selected.append({"kind": "shared-animation-library", **bytes_receipt(prefix + spec["animUrl"], actual_library)})
        report["game"] = {
            "gameId": GAME, "previewUrl": game["previewUrl"], "actualOwnedGameRecord": game,
            "background": actual_bg, "originalImageAssetId": IMAGE, "originalSourceKey": original["key"],
            "backgroundGameKey": packed_bg_key, "backgroundSha256": core.sha(packed_bg),
            "backgroundSourcePolicy": "Original identified by selected IP.imageAssetId, kind image and deployed resolver. "
                                      "Preview deliberately has the same bytes, so SHA alone cannot distinguish these two source keys.",
            "sourcePromptSha256": core.sha(design["prompt"].encode()), "rolesAndCastRetained": True,
            "sourcePromptRetainedExactly": True, "worldDimensions": [60, 48],
            "missionStageTypes": ["collect", "reach"], "runtimeFiles": len(tools.RUNTIME3D_FILES),
            "publicRuntimeSpecAndBackground": game_objects, "selectedOriginalAssetCopies": selected,
            "scope": "Actual owned saved design and exact public file bytes, not independently observed native gameplay completion."}
        inventory_rows = [a for row in prep["sourceAssetInventory"] for a in row["assets"].values()]
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            def source_asset(item):
                blob = s3_bytes(s3, item["sourceKey"])
                core.require(len(blob) == item["bytes"] and core.sha(blob) == item["sha256"],
                             "An original source media file changed since the pre-test inventory")
                return {"assetId": item["assetId"], "key": item["sourceKey"], "bytes": len(blob),
                        "sha256": core.sha(blob), "originalFullBytesUnchanged": True}
            report["originalSourceFilesUnchanged"] = list(pool.map(source_asset, inventory_rows))
        report["anonymousAndInvalidDenied"] = core.audience_gate()
        report["deployedLambda"] = deployed_code(lam, deployment)
        report["storageProtection"] = delivery.storage_protection(s3, cf, deployment["distributionId"])
        report["invalidation"] = delivery.invalidation(cf, deployment["distributionId"], deployment["invalidationId"])
        core.require(report["invalidation"]["status"] == "Completed", "Background CDN invalidation is incomplete")
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            def deployed_object(pair):
                key, metadata = pair
                body = s3_bytes(s3, key)
                core.require(len(body) == metadata["bytes"] and core.sha(body) == metadata["sha256"],
                             "A background deployment object differs from its actual deployment receipt")
                result = bytes_receipt(key, body, public=key.startswith("web/"))
                if key.startswith("runtime3d/"):
                    result["scope"] = "Internal S3 template; its actual generated game copy is publicly verified above."
                return result
            report["deploymentObjects"] = list(pool.map(deployed_object, deployment["objects"].items()))
        public_config = s3_bytes(s3, "web/config.json")
        core.require(core.sha(public_config) == deployment["publicConfigSha256"]
                     and deployment["publicConfigBytePreserved"] is True, "Existing Cognito public config changed")
        report["publicConfigPreserved"] = bytes_receipt("web/config.json", public_config)
        core.require(digest(store.snapshot(ctx, prep["sourceSession"])) == source_hash,
                     "The original source session changed during the independent audit")
        report.update(status="DELIVERY_AND_ORIGINAL_LINEAGE_VERIFIED_GAMEPLAY_SEPARATE",
                      completedAt=core.now(), originalSourceStillUnchanged=True,
                      sourceReports=["background-game-test.json", "background-studio-live.json",
                                     "background-deployment.json", "backend-background-contract.json"],
                      scopeLimits=["This actual hosted case uses an original 2D image background; no inferred terrain/navmesh/collision.",
                                   "Live model-background gameplay is not claimed by this image-case receipt.",
                                   "Native UI and native-input playback/completion remain separate root/agent evidence."])
        core.save(REPORT, report)
        print(json.dumps({"status": report["status"], "gameId": GAME, "backgroundBytes": len(original_bytes),
                          "backgroundSha256": IMAGE_SHA, "publicGameRuntimeFiles": len(tools.RUNTIME3D_FILES),
                          "originalSourceFilesUnchanged": len(report["originalSourceFilesUnchanged"]),
                          "deploymentObjects": len(report["deploymentObjects"]), "awsWrites": False,
                          "report": str(REPORT.relative_to(ROOT))}), flush=True)
    except Exception as error:
        report.update(status="FAILED_OR_PENDING", failedAt=core.now(), failureType=type(error).__name__)
        if type(error) is RuntimeError:
            report["failure"] = str(error)
        core.save(REPORT, report)
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        detail = str(error) if type(error) is RuntimeError else "Review the saved safe delivery receipt."
        print(f"Background delivery verification stopped ({type(error).__name__}): {detail}", file=sys.stderr)
        sys.exit(1)
