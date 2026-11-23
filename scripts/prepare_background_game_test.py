#!/usr/bin/env python3
"""Prepare one owned background-IP test session without generating any media.

Default --plan-only writes the two later UI prompts locally without AWS calls.
--prepare authenticates, backs up the owned source metadata, hashes full source
files, creates a fresh session through the existing API, and copies only the
selected owned IP/asset records. S3 objects stay unchanged at their source keys.
--prepare --resume safely resumes the saved creation intent without another POST.

This module never submits chat, calls image/video/3D models, or uploads/deploys.
Credentials and Cognito tokens are used in memory only.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
import struct
import sys
from types import SimpleNamespace
from urllib.parse import urlsplit, urlunsplit
import uuid

import boto3

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import create_three_game_showcase as helper
from server import game_design, store
from smoke import cognito_login, get_secret

REPORT = ROOT / "evidence/background-game-test.json"
SOURCE_SESSION = "ses_e57caf98a9"
ACCOUNT = "087967639890"
REGION = "us-east-1"
CAST = [helper.PLAYER, helper.CORE]
ROLES = {"playerIpId": helper.PLAYER, "propIpIds": [helper.CORE],
         "weaponIpId": None, "enemyIpIds": [], "npcIpIds": []}
BACKGROUND_ID = "{BACKGROUND_IP_ID}"
BACKGROUND_NAME = "안개 낀 고대 숲 배경"
ASSET_FIELDS = (*helper.FIELDS, "poseCutoutAssetId", "posterAssetId", "turntableAssetId")
PRIVATE_KEYS = {
    "password", "secret", "secretstring", "secretaccesskey", "accesskeyid",
    "accesstoken", "idtoken", "refreshtoken", "sessiontoken", "authorization",
    "cookie", "setcookie", "apikey", "xauthtoken", "credentials",
}
SIGNED_QUERY = re.compile(r"(?:x-amz-|x-goog-|signature=|token=|api[_-]?key=)", re.I)
PRIVATE_STRING = re.compile(
    r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|"
    r"\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|"
    r"\bBearer\s+[A-Za-z0-9._~-]+", re.I)


def prompts(stem):
    prefix = f"bg_{stem[:12]}"
    background_prompt = (
        f'Create exactly one new prop IP named "{BACKGROUND_NAME}" for the GAME BACKGROUND. '
        'Call create_ip_asset with kind="prop", usage="background", image_model="krea", '
        'role="game environment background". Its English description must be: '
        '"A misty ancient forest environmental landscape, wide cinematic establishing view, '
        'moss-covered ancient trees framing a clear woodland path, fern-covered foreground, '
        'weathered stone ruins in the middle distance, soft volumetric morning mist, '
        'layered distant forest, gentle teal-green and warm amber lighting, detailed stylized '
        '3D adventure-game art, coherent perspective and natural depth. The image contains '
        'the complete location and surrounding environment, no people, no characters, '
        'no isolated object, no product shot, no plain studio backdrop, no text or watermark." '
        'Generate the complete original scene image only; preserve its full background. '
        'Do not remove its background, make a cutout, render a GLB, rig a character, '
        'create video or turntables, or build a game in this request. '
        'Keep the existing Jena and energy-core IPs and their images/models unchanged. '
        'Use the default Krea 2 Turbo image provider through this existing AWS pipeline.'
    )
    game_prompt = (
        "[게임 설계]\n준비된 기존 제나와 에너지 코어, 방금 만든 안개 낀 고대 숲 배경만 사용해 "
        "실제 오른쪽 패널에서 실행할 숲 탐험 게임을 make_game으로 만들어줘. "
        f"player.ipId={helper.PLAYER}, props에는 에너지 코어 ipId={helper.CORE} 하나만 넣어. "
        f"배경 IP {BACKGROUND_ID}는 수집 소품이나 NPC가 아닌 별도의 게임 배경 역할이야. "
        "gameDesign의 playerIpId/propIpIds/backgroundIpId 역할을 그대로 지켜. "
        "version:2, engine:'three', genre:'rpg-explore'. "
        f"world.background={{ipId:'{BACKGROUND_ID}',mode:'image',rotation:0}}를 반드시 넣어 "
        "이 IP의 원본 전체 이미지가 실제 게임 배경으로 보이게 해. 컷아웃을 배경으로 쓰지 마. "
        "이미지는 2D 배경이며 이미지가 충돌 가능한 3D 숲이나 지형으로 변환된다고 주장하지 마. "
        "월드 width60, depth48, spawn={x:0,z:16}. "
        "world.city와 world.npc는 넣지 말고 enemies=[]와 world.enemySpawns=[]로 해. "
        "기존 제나의 준비된 리깅 GLB, 에너지 코어의 준비된 GLB를 그대로 사용해. "
        f"코어 placement는 id='{prefix}_core', propIndex0, x0,z4, "
        f"stageId='{prefix}_collect'로 정확히 하나 배치해. "
        f"목표 beacon은 world.entities에 id='{prefix}_exit', kind:'beacon', x0,z-10, "
        "width2,depth2,height2,y0,solidfalse,color:'#d8ba79',label:'숲의 출구'로 배치해. "
        "임무는 정확히 두 단계: "
        f"id='{prefix}_collect',type:'collect',target1,entityIds=['{prefix}_core'],"
        "label:'에너지 코어 회수' → "
        f"id='{prefix}_reach',type:'reach',target1,entityIds=['{prefix}_exit'],"
        "holdSec0,label:'숲의 출구 도착'. "
        "NPC/적/차량/전투/무기/타이머는 없고 rules.timeLimitSec0, 난이도 easy, "
        "mechanics.autoFirefalse, jumpfalse, dashfalse, sprinttrue, interactRadius3으로 해. "
        "장애물은 길 양옆 x=-9 또는9의 y0,height0.6 이하 장식 crate 2개만 두고 "
        "x=-4..4,z=-14..18 직선 통로에는 장애물을 놓지 마. "
        "groundColor '#2d4938', skyColor '#b3cdc1', fogColor '#93b7a0', fogDensity0.01, "
        "exposure1.1,bloomStrength0.2의 차분한 숲 색감으로 맞춰. "
        "새 이미지/영상/3D/리깅/액션샷/IP 생성 도구는 호출하지 마. "
        "실제 선택 IP의 준비된 서버 에셋만 해결해서 사용하고 make_game으로 바로 생성해."
    )
    if len(background_prompt) > 4000 or len(game_prompt) > 4000:
        raise RuntimeError("UI prompts must each remain within the 4000-character limit")
    design = {"prompt": game_prompt, "castIpIds": [*CAST, BACKGROUND_ID],
              **copy.deepcopy(ROLES), "backgroundIpId": BACKGROUND_ID}
    return background_prompt, game_prompt, design


def safe_backup(value):
    """Keep every metadata record, redacting only credentials or signed URL data."""
    redactions = []

    def visit(item, path):
        if isinstance(item, dict):
            result = {}
            for key, val in item.items():
                child = f"{path}.{key}"
                normalized = re.sub(r"[^a-z0-9]", "", key.lower())
                if normalized in PRIVATE_KEYS and val != "[REDACTED]":
                    result[key] = "[REDACTED]"
                    redactions.append({"path": child, "reason": "credential field"})
                else:
                    result[key] = visit(val, child)
            return result
        if isinstance(item, list):
            return [visit(val, f"{path}[{i}]") for i, val in enumerate(item)]
        if isinstance(item, str):
            if PRIVATE_STRING.search(item):
                redactions.append({"path": path, "reason": "credential-shaped string"})
                return "[REDACTED]"
            if SIGNED_QUERY.search(item):
                parsed = urlsplit(item)
                if parsed.scheme in ("http", "https") and parsed.netloc:
                    redactions.append({"path": path, "reason": "signed URL query"})
                    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
                redactions.append({"path": path, "reason": "embedded signed URL data"})
                return "[REDACTED]"
        return item

    result = visit(store.plain(value), "snapshot")
    return result, redactions


def save_report(path, report):
    # Reports contain only hashes, canonical asset paths, safe metadata and prompts.
    safe, redactions = safe_backup(report)
    if redactions:
        raise RuntimeError("Unsafe report data detected; nothing was written")
    path.parent.mkdir(parents=True, exist_ok=True)
    helper.save_report(path, safe)


def canonical_url(base, key):
    if ("?" in key or "#" in key or not key.startswith("sessions/")
            or ".." in key.split("/") or not re.fullmatch(r"[A-Za-z0-9_./-]+", key)):
        raise RuntimeError("Prepared asset must use a canonical owned source key")
    return f"{base}/{key}"


def authenticate():
    identity = boto3.client("sts", region_name=REGION).get_caller_identity()
    if identity["Account"] != ACCOUNT:
        raise RuntimeError("Unexpected AWS account; no session writes performed")
    secret = get_secret()
    base = secret["cloudfrontUrl"].rstrip("/")
    if base != helper.EXPECTED_BASE:
        raise RuntimeError("Unexpected existing demo endpoint; no session writes performed")
    token = cognito_login(base, secret["username"], secret["password"])
    user = boto3.client("cognito-idp", region_name=REGION).get_user(AccessToken=token)
    sub = next(a["Value"] for a in user["UserAttributes"] if a["Name"] == "sub")
    env = boto3.client("lambda", region_name=REGION).get_function_configuration(
        FunctionName="ipverse-api")["Environment"]["Variables"]
    if (env.get("TABLE_NAME") != "ipverse-main"
            or env.get("ASSETS_BUCKET") != f"ipverse-assets-{ACCOUNT}-{REGION}"):
        raise RuntimeError("Unexpected source table/bucket; no session writes performed")
    cdn = env.get("CDN_DOMAIN") or urlsplit(base).netloc
    if cdn != urlsplit(base).netloc:
        raise RuntimeError("Unexpected canonical asset domain")
    ctx = SimpleNamespace(
        table=boto3.resource("dynamodb", region_name=REGION).Table(env["TABLE_NAME"]),
        s3=boto3.client("s3", region_name=REGION), assets_bucket=env["ASSETS_BUCKET"],
        cdn_domain=cdn)
    return ctx, base, token, sub


def inventory(ctx, source, base):
    ips = {ip["ipId"]: ip for ip in source["ips"]}
    source_assets = {a["assetId"]: a for a in source["assets"]}
    assets, rows = {}, []
    for ip_id, kind in zip(CAST, ("character", "prop")):
        ip = ips.get(ip_id)
        if not ip or ip.get("kind") != kind:
            raise RuntimeError(f"Owned prepared IP role missing: {ip_id}")
        if not all(ip.get(field) in source_assets
                   for field in ("imageAssetId", "cutoutAssetId", "glbAssetId")):
            raise RuntimeError("Prepared source image, cutout and raw mesh are required")
        row = {"ipId": ip_id, "name": ip["name"], "kind": kind, "assets": {}}
        # Never retain a dangling reference in the cloned full IP record.
        referenced = {key for key, val in ip.items() if key.endswith("AssetId") and val}
        if not referenced.issubset(set(ASSET_FIELDS)):
            raise RuntimeError("Unknown prepared IP asset reference; inspect before cloning")
        for field in ASSET_FIELDS:
            if not ip.get(field):
                continue
            asset = source_assets.get(ip[field])
            if not asset or asset.get("ipId") != ip_id:
                raise RuntimeError("Prepared source asset/IP lineage does not match")
            key = asset["key"]
            if not key.startswith(f"sessions/{SOURCE_SESSION}/"):
                raise RuntimeError("Prepared bytes must belong to the owned source session")
            url = canonical_url(base, key)
            blob = helper.read_blob(ctx, key)
            if field == "turntableAssetId":
                if len(blob) < 12 or blob[4:8] != b"ftyp":
                    raise RuntimeError("Existing turntable is not an MP4 container")
                actual_mime = "video/mp4"
            else:
                helper.validate_blob(blob, field)
                actual_mime = ("model/gltf-binary" if field in ("glbAssetId", "riggedGlbAssetId")
                               else "image/png" if blob.startswith(b"\x89PNG")
                               else "image/jpeg")
            meta = {"assetId": asset["assetId"], "kind": asset.get("kind"),
                    "sourceKey": key, "url": url, "bytes": len(blob),
                    "sha256": hashlib.sha256(blob).hexdigest(), "actualMime": actual_mime,
                    "recordContentType": asset.get("contentType"),
                    "sourceOwnerVerified": True, "ipLineageVerified": True}
            if actual_mime == "image/png":
                meta["width"], meta["height"] = struct.unpack(">II", blob[16:24])
            row["assets"][field] = meta
            assets[asset["assetId"]] = copy.deepcopy(asset)
        rows.append(row)
    return ips, assets, rows


def template_report(run_id):
    bg_prompt, game_prompt, design = prompts(run_id)
    return {
        "status": "PLANNED_NO_AWS_CALLS", "runId": run_id, "createdAt": helper.now(),
        "name": f"배경 IP 연결 테스트 · {run_id[:6]}", "genre": "rpg-explore",
        "sourceSession": SOURCE_SESSION, "sessionId": None,
        "commonCast": copy.deepcopy(ROLES),
        "background": {"name": BACKGROUND_NAME, "kind": "prop", "usage": "background",
                       "provider": "krea", "mode": "image", "ipId": None},
        "backgroundCreationPrompt": bg_prompt, "gamePrompt": game_prompt,
        "gameDesignTemplate": design,
        "promptCharacters": {"backgroundCreation": len(bg_prompt), "gameDesign": len(game_prompt)},
        "backgroundPromptPending": True, "gameDesignPending": True,
        "sourceMediaRegenerated": False, "modelCallsSubmitted": 0,
        "proofScope": "Prepared owned test session and existing source byte hashes only. "
                      "The background image, game generation and native UI/playback are not yet verified.",
        "configSource": {"authClient": "build/outputs.json",
                         "existingApiEnvironment": "ipverse-api",
                         "existingCredentialSecret": "ipverse/demo-user (memory only)"},
        "expectedWorld": {"width": 60, "depth": 48, "spawn": {"x": 0, "z": 16},
                          "background": {"ipId": BACKGROUND_ID, "mode": "image", "rotation": 0},
                          "core": {"x": 0, "z": 4}, "exit": {"x": 0, "z": -10},
                          "stageTypes": ["collect", "reach"],
                          "city": False, "npc": False, "enemies": 0, "timer": False},
    }


def prepare(args):
    path = ROOT / args.report
    if path.exists():
        if not args.resume:
            raise RuntimeError("Report exists; use --resume to avoid a duplicate test session")
        report = json.loads(path.read_text())
    else:
        report = template_report(uuid.uuid4().hex[:12])
    if (report.get("sourceSession") != SOURCE_SESSION or report.get("commonCast") != ROLES
            or report.get("background", {}).get("name") != BACKGROUND_NAME):
        raise RuntimeError("Saved preparation has different source/roles; do not overwrite it")
    if not args.prepare:
        if report.get("sessionId"):
            raise RuntimeError("Existing prepared session report cannot be replaced with a plan")
        save_report(path, report)
        return report

    ctx, base, token, sub = authenticate()
    source = store.snapshot(ctx, SOURCE_SESSION)
    if not source["session"] or source["session"]["userSub"] != sub:
        raise RuntimeError("Source session must belong to the authenticated operator")
    source_hash = helper.digest(source)
    if report.get("sourceSnapshotSha256") not in (None, source_hash):
        raise RuntimeError("Source changed since saved preparation; inspect before resuming")
    ips, assets, rows = inventory(ctx, source, base)
    backup, redactions = safe_backup(source)
    report.update({
        "status": "PREPARING_NO_MODEL_CALLS", "accountId": ACCOUNT, "region": REGION,
        "baseUrl": base, "sourceOwnerVerified": True,
        "sourceSnapshotSha256": source_hash, "sourceSnapshotBackup": backup,
        "sourceSnapshotBackupSha256": helper.digest(backup),
        "sourceSnapshotBackupRedactions": redactions,
        "sourceAssetInventory": rows, "sourceAssetFilesFullRead": len(assets),
        "sourceS3Uploads": 0,
    })
    if "initialSessionIds" not in report:
        report["initialSessionIds"] = [
            s["sessionId"] for s in helper.call_api(base, "GET", "/api/sessions", token)["sessions"]]
    save_report(path, report)
    if not report.get("sessionId"):
        if report.get("creationIntentAt"):
            helper.recover_created_session(base, token, report, report)
        else:
            report["creationIntentAt"] = helper.now()
            save_report(path, report)
            response = helper.call_api(base, "POST", "/api/sessions", token,
                                       {"title": report["name"], "genre": report["genre"]})
            report["sessionId"] = response["session"]["sessionId"]
        save_report(path, report)
    sid = report["sessionId"]
    session = store.get_session(ctx, sid)
    if (sid in report["initialSessionIds"] or not session or session["userSub"] != sub
            or session["title"] != report["name"] or session["genre"] != report["genre"]):
        raise RuntimeError("Prepared target must be the fresh owned test session")
    if not report.get("recordsPreparedAt"):
        # Do not overwrite any UI-generated IP/job after a partially completed run.
        current = store.snapshot(ctx, sid)
        if current["messages"] or current["jobs"] or current["games"]:
            raise RuntimeError("Fresh target already has jobs/chat/game; no records were overwritten")
        if any(ip["ipId"] not in CAST for ip in current["ips"]):
            raise RuntimeError("Fresh target already contains an unexpected IP")
        for asset in assets.values():
            store.put_asset(ctx, sid, copy.deepcopy(asset))
        for ip_id in CAST:
            store.put_ip(ctx, sid, copy.deepcopy(ips[ip_id]))
        concept = copy.deepcopy(source["session"].get("concept") or {})
        overrides = {
            "title": "제나 · 안개 숲 배경 연결",
            "logline": "제나가 안개 낀 고대 숲에서 에너지 코어를 회수하고 출구로 향한다.",
            "style": "detailed stylized 3D adventure-game art, misty ancient forest, "
                     "moss-covered trees and weathered stone ruins, cinematic natural lighting",
            "palette": ["#2d4938", "#93b7a0", "#d8ba79"],
        }
        concept.update(overrides)
        store.update_session(ctx, session, concept=concept)
        report["testConceptOverrides"] = overrides
        report["preparedConceptSha256"] = helper.digest(concept)
        report["recordsPreparedAt"] = helper.now()
        save_report(path, report)

    prepared = store.snapshot(ctx, sid)
    prepared_ips = {ip["ipId"]: ip for ip in prepared["ips"]}
    prepared_assets = {asset["assetId"]: asset for asset in prepared["assets"]}
    checks = [
        {"name": "fresh session same owner", "pass": prepared["session"]["userSub"] == sub
         and sid != SOURCE_SESSION and sid not in report["initialSessionIds"]},
        {"name": "exact selected IP records", "pass": set(prepared_ips) == set(CAST)
         and all(helper.digest(prepared_ips[i]) == helper.digest(ips[i]) for i in CAST)},
        {"name": "exact directly referenced source assets", "pass": set(prepared_assets) == set(assets)},
        {"name": "source concept overridden only in fresh target", "pass":
         helper.digest(prepared["session"].get("concept")) == report["preparedConceptSha256"]},
        {"name": "no chat, model, game or media jobs submitted", "pass":
         not prepared["messages"] and not prepared["jobs"] and not prepared["games"]},
    ]
    for row in rows:
        for meta in row["assets"].values():
            actual = prepared_assets.get(meta["assetId"])
            if not actual:
                checks.append({"name": f"prepared {meta['assetId']} binding", "pass": False})
                continue
            blob = helper.read_blob(ctx, actual["key"])
            checks.append({
                "name": f"prepared {meta['assetId']} ownership/bytes/reference",
                "pass": actual.get("ipId") == row["ipId"]
                and actual["key"] == meta["sourceKey"]
                and actual["url"] == meta["url"]
                and len(blob) == meta["bytes"]
                and hashlib.sha256(blob).hexdigest() == meta["sha256"],
            })
    source_after = store.snapshot(ctx, SOURCE_SESSION)
    report["sourceAfterSnapshotSha256"] = helper.digest(source_after)
    report["sourceUnchanged"] = report["sourceAfterSnapshotSha256"] == source_hash
    checks.append({"name": "full source snapshot unchanged", "pass": report["sourceUnchanged"]})
    # Validate today's actual roles, without pretending the future background exists.
    _, role_errors = game_design.validate_design(
        {"prompt": report["gamePrompt"], "castIpIds": CAST, **ROLES}, prepared_ips,
        report["gamePrompt"])
    checks.append({"name": "prepared player/core roles valid", "pass": not role_errors})
    report.update({
        "preparedOwnerVerified": prepared["session"]["userSub"] == sub,
        "preparedAssetIds": list(prepared_assets),
        "preparedCastIpIds": list(prepared_ips),
        "preparedSnapshotSha256": helper.digest(prepared),
        "checks": checks, "ok": all(check["pass"] for check in checks),
        "preparedAt": helper.now(),
    })
    report["status"] = "PREPARED_NO_MODEL_CALLS" if report["ok"] else "PREPARATION_VERIFICATION_FAILED"
    save_report(path, report)
    if not report["ok"]:
        raise RuntimeError("Prepared test failed a bounded verification; inspect the report")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--plan-only", action="store_true", help="local prompts only (default)")
    modes.add_argument("--prepare", action="store_true", help="create one owned test session; no model calls")
    parser.add_argument("--resume", action="store_true", help="resume the saved intent without duplicate POST")
    parser.add_argument("--report", default=str(REPORT.relative_to(ROOT)))
    args = parser.parse_args()
    try:
        report = prepare(args)
    except Exception as error:
        # No raw response body, headers, configuration or credential values.
        print(f"Preparation stopped: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    print(json.dumps({
        "status": report["status"], "sessionId": report["sessionId"], "name": report["name"],
        "sourceSession": SOURCE_SESSION, "sourceUnchanged": report.get("sourceUnchanged"),
        "preparedSourceFiles": report.get("sourceAssetFilesFullRead", 0),
        "modelCallsSubmitted": 0, "report": str(args.report),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
