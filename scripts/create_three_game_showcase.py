#!/usr/bin/env python3
"""Create three real chat/Bedrock-generated games from existing owned IPs.

Operator workflow:
  1. Review CASES and run --preflight-only for read-only asset verification.
  2. Run normally to create three fresh sessions and submit the exact prompts.
  3. After interruption use --resume; it never blindly repeats a POST.
  4. Run scripts/verify_three_game_showcase.mjs for separate physical-input QA.

No image, mesh or video generation is requested. Credentials/tokens stay in
memory. This script copies asset records into new owned sessions; source S3
objects and the source session are unchanged. Failed/ambiguous mutations stop
for inspection instead of automatically submitting a duplicate request.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import time
import urllib.error
import urllib.request
import uuid

import boto3

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from smoke import cognito_login, get_secret
from server import game_design, gamespec, store
from server.providers.base import Ctx

EXPECTED_BASE = "https://d12ka835iwfpnx.cloudfront.net"
PLAYER = "ip_01c8ef0ece"
CORE = "ip_daa57bd628"
NPC = "ip_96d1439744"
WEAPON = "ip_216cfc7716"
ENEMY = "ip_09cd7b3ff5"
BASE_CAST = [PLAYER, CORE, NPC]
MAX_ASSET_BYTES = 128 * 1024 * 1024
FIELDS = ("imageAssetId", "cutoutAssetId", "glbAssetId", "riggedGlbAssetId")

COMMON = (
    "주인공은 제나, 실제 소품은 에너지 코어, NPC는 노인 정비사 카이야. "
    "선택 IP와 명시한 역할을 그대로 유지해. 모든 이미지·컷아웃·실제 3D와 리깅은 이미 준비되어 있어. "
    "이미지·영상·3D·액션 샷 등 미디어 작업이나 새 IP 제작은 절대 호출하지 마. "
    "기존 IP의 서버 해결 3D를 사용하고 version 2, engine three의 world와 mission으로 바로 게임을 만들어. "
    "미션은 정확히 3단계, 실제 대상 ID와 단계 활성화 시점을 지정해. "
    "미션 문구나 테마만 바꾸지 말고 아래 공간과 행동을 실제 좌표·목표·규칙으로 구현해. "
    "모든 대상은 경계와 구조물에서 떨어진 지상에 두고 시작점부터 3m 이상 넓은 통로로 접근 가능하게 해. "
)

CASES = [
    {
        "type": "exploration", "name": "숲의 코어 탐험", "genre": "rpg-quest",
        "stageTypes": ["talk", "collect", "reach"], "stageTargets": [1, 3, 1],
        "roles": {"playerIpId": PLAYER, "weaponIpId": None, "propIpIds": [CORE],
                  "enemyIpIds": [], "npcIpIds": [NPC]},
        "prompt": "[게임 설계]\n" + COMMON
        + "평화로운 낮의 판타지 숲 유적 탐험으로 해줘. 적이나 무기는 넣지 마. "
        "world는 폭 56m 깊이 48m, 시작점은 (-18,14), 카이는 (-12,8)에 둬. "
        "서쪽 숲, 중앙의 열린 돌기둥 광장, 동쪽 신전 정원이 서로 다른 구역을 이루도록 "
        "나무·아치·돌기둥·작은 신전을 경로 바깥에 직접 배치하고, 막힌 미로는 만들지 마. "
        "첫 단계 greet는 카이에게 E로 대화 1회, 두 번째 gather는 서로 다른 위치 "
        "(-8,2), (2,-4), (12,3)의 실제 코어 3개 수집, 마지막 arrive는 (18,-12)의 신전 비콘 도착이야. "
        "코어 3개는 gather 단계에만 활성화해. 제한 시간 0, 체력 200, autoFire false, "
        "dash false, jump true, sprint true, regenPerSec 0, interactRadius 3으로 해줘. "
        "하늘 #8fc9a0, 안개 #c9e1b3와 밀도 0.009, 바닥 #314c35, "
        "노출 1.1, 블룸 0.2의 녹색·금빛 자연광으로 해줘. 난이도 easy로 만들어.",
    },
    {
        "type": "combat", "name": "네온 거점 돌파", "genre": "sf-shooter",
        "stageTypes": ["kills", "collect", "reach"], "stageTargets": [2, 1, 1],
        "roles": {"playerIpId": PLAYER, "weaponIpId": WEAPON, "propIpIds": [CORE],
                  "enemyIpIds": [ENEMY], "npcIpIds": [NPC]},
        "prompt": "[게임 설계]\n" + COMMON
        + "실제로 쏘고 적을 처치하는 쉬운 SF 액션 전투로 해줘. 제나는 준비된 플라즈마 라이플을 들고, "
        "적 템플릿은 준비된 사이버 좀비 병사 1종만 써서 정확히 2명을 배치해. "
        "새 적·무기나 다른 IP는 만들지 마. 좀비는 humanoid true, hp 1, speed 1로 해줘. "
        "world는 폭 48m 깊이 48m의 열린 네온 거점, 시작점 (0,14), 카이는 안전한 (-16,14)에 둬. "
        "중앙 x -10~10, z -18~16는 장애물 없이 비워서 적을 향해 움직이고 조준할 수 있게 해줘. "
        "기둥·건물 4~8개만 외곽 x 절댓값 17 이상에 둬. 위험 지형이나 미로는 넣지 마. "
        "첫 단계 combat는 guard_left(-6,4), guard_right(6,4)에 출현하는 좀비 2명 처치(target 2), "
        "두 번째 supply는 (0,-6)의 supply_core 1개 수집(target 1), "
        "마지막 extract는 (0,-15)의 exit_gate 도착(target 1)이야. "
        "두 적은 combat에만, 코어는 supply에만 활성화해. 카이 대화는 필수가 아니야. "
        "시간 제한 0, 체력 250, weaponDamage 5, regenPerSec 8, fireIntervalSec 0.15, "
        "autoFire false, dash true, jump true, sprint true, interactRadius 3으로 해줘. "
        "하늘 #090c22, 안개 #151638와 밀도 0.006, 바닥 #171b2c, "
        "노출 1.2, 블룸 0.75의 청록·보라 네온으로 해줘. 난이도 easy로 만들어.",
    },
    {
        "type": "escape", "name": "전력시설 탈출", "genre": "sf-survival",
        "stageTypes": ["collect", "interact", "reach"], "stageTargets": [2, 2, 1],
        "roles": {"playerIpId": PLAYER, "weaponIpId": None, "propIpIds": [CORE],
                  "enemyIpIds": [], "npcIpIds": [NPC]},
        "prompt": "[게임 설계]\n" + COMMON
        + "제한 시간 120초의 SF 전력시설 탈출로 해줘. 적이나 무기는 넣지 마. "
        "world는 폭 60m 깊이 44m, 시작점 (-22,12), 카이는 안전한 (-22,7)에 둬. "
        "열린 서쪽 전력실, 중앙 단말 광장, 동쪽 탈출 게이트가 이어지게 "
        "건물·기둥·벽을 경로 밖에 직접 배치해. 붉은 위험 구역 두 곳은 경로에서 "
        "충분히 떨어진 (0,14), (12,14)에 작게 두고 자유롭게 우회 가능하게 해줘. "
        "첫 단계 power는 실제 코어 2개를 (-14,2), (-8,-4)에서 수집, "
        "두 번째 unlock는 beacon 종류의 terminal_a(2,-4), terminal_b(10,2)에 "
        "각각 다가가 E로 상호작용 2회(holdSec 0), 마지막 escape는 (22,-8)의 exit_gate 도착이야. "
        "코어는 power 단계에만 활성화해. NPC 대화는 필수가 아니야. "
        "rules.timeLimitSec 120, 체력 200, autoFire false, dash true, jump false, sprint true, "
        "regenPerSec 0, interactRadius 3으로 해줘. "
        "하늘 #27354e, 안개 #617b96와 밀도 0.015, 바닥 #39475a, "
        "노출 1.0, 블룸 0.4의 차가운 시설 조명과 주황색 경고등으로 해줘. 난이도 easy로 만들어.",
    },
]


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(json.dumps(store.plain(value), sort_keys=True,
                                     ensure_ascii=False).encode()).hexdigest()


def selected_cast(case):
    r = case["roles"]
    return [r["playerIpId"], *r["propIpIds"], *r["npcIpIds"],
            *([r["weaponIpId"]] if r["weaponIpId"] else []), *r["enemyIpIds"]]


def call_api(base, method, path, token, body=None):
    """One request only: never automatically repeat a mutation after a timeout."""
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    headers = {"Content-Type": "application/json", "X-Auth-Token": token}
    if data is not None:
        headers["x-amz-content-sha256"] = hashlib.sha256(data).hexdigest()
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        # Do not echo credentials, token headers or arbitrary response bodies.
        raise RuntimeError(f"Owned API returned HTTP {error.code} for {method} {path}") from None


def read_blob(ctx, key):
    result = ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=key)
    body = result["Body"]
    try:
        size = result["ContentLength"]
        if not 0 < size <= MAX_ASSET_BYTES:
            raise RuntimeError("Asset has an empty or excessive declared size")
        blob = body.read(MAX_ASSET_BYTES + 1)
    finally:
        body.close()
    if len(blob) != size:
        raise RuntimeError("Actual asset bytes differ from declared size")
    return blob


def validate_blob(blob, field):
    if field in ("glbAssetId", "riggedGlbAssetId"):
        if len(blob) < 20 or struct.unpack("<4sII", blob[:12]) != (b"glTF", 2, len(blob)):
            raise RuntimeError("Prepared model is not a complete binary glTF 2 file")
        length, kind = struct.unpack("<I4s", blob[12:20])
        if kind != b"JSON" or 20 + length > len(blob):
            raise RuntimeError("Prepared model has an invalid GLB JSON chunk")
        gltf = json.loads(blob[20:20 + length])
        if not gltf.get("meshes") or not gltf.get("accessors"):
            raise RuntimeError("Prepared model does not contain mesh geometry")
    elif field == "cutoutAssetId":
        if not blob.startswith(b"\x89PNG\r\n\x1a\n"):
            raise RuntimeError("Prepared cutout is not PNG bytes")
    elif not (blob.startswith(b"\xff\xd8\xff") or blob.startswith(b"\x89PNG\r\n\x1a\n")):
        raise RuntimeError("Prepared image is not JPEG or PNG bytes")


def source_inventory(ctx, source):
    """Read full real bytes before any session creation, keeping hashes in evidence."""
    ips = {ip["ipId"]: ip for ip in source["ips"]}
    assets = {asset["assetId"]: asset for asset in source["assets"]}
    all_ids = list(dict.fromkeys(ip_id for case in CASES for ip_id in selected_cast(case)))
    rows, blobs, selected_assets = [], {}, {}
    for ip_id in all_ids:
        ip = ips.get(ip_id)
        if not ip:
            raise RuntimeError(f"Prepared source IP missing: {ip_id}")
        if not all(ip.get(field) in assets for field in ("imageAssetId", "cutoutAssetId", "glbAssetId")):
            raise RuntimeError(f"Real prepared image/cutout/raw GLB required: {ip_id}")
        if ip_id == WEAPON and (ip.get("kind"), ip.get("weaponType")) != ("weapon", "gun"):
            raise RuntimeError("Combat requires the existing prepared gun")
        if ip_id == ENEMY and (ip.get("kind") != "enemy" or ip.get("humanoid") is not True
                               or ip.get("riggedGlbAssetId") not in assets):
            raise RuntimeError("Combat requires the existing prepared rigged humanoid enemy")
        record = {"ipId": ip_id, "name": ip.get("name"), "kind": ip.get("kind"),
                  "weaponType": ip.get("weaponType"), "humanoid": ip.get("humanoid"), "assets": {}}
        for field in FIELDS:
            if not ip.get(field):
                continue
            asset = assets.get(ip[field])
            if not asset or asset.get("ipId") != ip_id:
                raise RuntimeError(f"Prepared asset lineage mismatch: {ip_id}/{field}")
            if not asset["key"].startswith(f"sessions/{source['session']['sessionId']}/"):
                raise RuntimeError("Source assets must belong to the owned source session prefix")
            blob = read_blob(ctx, asset["key"])
            validate_blob(blob, field)
            blobs[asset["assetId"]] = blob
            selected_assets[asset["assetId"]] = asset
            record["assets"][field] = {"assetId": asset["assetId"], "kind": asset.get("kind"),
                                       "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest(),
                                       "sourceKey": asset["key"]}
        rows.append(record)
    return ips, selected_assets, blobs, rows


def save_report(path, report):
    report["updatedAt"] = now()
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(store.plain(report), ensure_ascii=False, indent=2) + "\n")
    temp.replace(path)


def recover_created_session(base, token, report, result):
    candidates = [s for s in call_api(base, "GET", "/api/sessions", token)["sessions"]
                  if s["sessionId"] not in report["initialSessionIds"]
                  and s["title"] == result["name"] and s["genre"] == result["genre"]]
    if len(candidates) != 1:
        raise RuntimeError("Session creation outcome is ambiguous; inspect the saved creation intent "
                           "and owned session list before another POST. No duplicate was submitted.")
    result["sessionId"] = candidates[0]["sessionId"]
    result["creationRecovered"] = True


def recover_chat(snap, result, case):
    users = [m for m in snap["messages"] if m.get("role") == "user" and m.get("text") == case["prompt"]]
    if len(users) != 1:
        raise RuntimeError("Chat submission outcome is ambiguous; inspect saved chat intent/messages. "
                           "No duplicate model request was submitted.")
    index = next(i for i, m in enumerate(snap["messages"]) if m["messageId"] == users[0]["messageId"])
    assistants = [m for m in snap["messages"][index + 1:] if m.get("role") == "assistant"]
    if len(assistants) != 1:
        raise RuntimeError("Cannot safely recover exactly one assistant reply for the submitted prompt")
    result["messageId"] = assistants[0]["messageId"]
    result["chatRecovered"] = True


def inspect_game(ctx, source_ips, source_assets, source_blobs, snap, result, case):
    message = next(m for m in snap["messages"] if m["messageId"] == result["messageId"])
    result.update(messageStatus=message["status"], agentText=message.get("text", ""),
                  toolEvents=message.get("toolEvents", []), newMediaJobs=len(snap["jobs"]))
    if message["status"] != "done" or not snap["games"]:
        raise RuntimeError("Actual chat did not finish with a generated game")
    game = snap["games"][-1]
    spec_bytes = read_blob(ctx, game["specKey"])
    spec = json.loads(spec_bytes)
    normalized, errors = gamespec.validate_spec(spec)
    if errors:
        raise RuntimeError("Generated GameSpec failed local validation: " + "; ".join(errors))
    roles, cast = case["roles"], selected_cast(case)
    design = {"prompt": case["prompt"], "castIpIds": cast, **roles}
    role_errors = game_design.role_errors(normalized, design)
    stages = spec["mission"]["stages"]
    checks = {
        "version2Three": spec["version"] == 2 and game["engine"] == "three",
        "correctSessionGenre": snap["session"]["genre"] == case["genre"] == spec["genre"],
        "exactOriginalPrompt": spec.get("design", {}).get("sourcePrompt") == case["prompt"],
        "exactSelectedCast": set(game.get("castIpIds", [])) == set(cast),
        "exactRoles": not role_errors and all(spec.get("design", {}).get(k) == v for k, v in roles.items()),
        "threeOrderedActions": [s["type"] for s in stages] == case["stageTypes"],
        "exactStageTargets": [s["target"] for s in stages] == case["stageTargets"],
        "actualAgentGameTool": any(e["tool"] == "make_game" for e in message.get("toolEvents", [])),
        "onlyGameTools": all(e["tool"] in ("make_game", "get_game_spec") for e in message.get("toolEvents", [])),
        "noMediaJobs": not snap["jobs"],
        "manualFire": spec.get("mechanics", {}).get("autoFire") is False,
        "npcActualIp": spec["props"][spec["world"]["npc"]["propIndex"]]["ipId"] == NPC,
    }
    if case["type"] == "combat":
        checks.update(
            selectedGun=spec["player"].get("weaponIpId") == WEAPON and spec["player"].get("weaponType") == "gun",
            exactlyTwoSelectedEnemies=len(spec["enemies"]) == 1
            and spec["enemies"][0]["ipId"] == ENEMY and len(spec["world"]["enemySpawns"]) == 2,
            combatNoTimer=spec.get("rules", {}).get("timeLimitSec") == 0,
            combatHp=200 <= spec.get("rules", {}).get("playerHp", 0) <= 300,
            combatDamage=spec["mechanics"].get("weaponDamage") == 5,
            combatRegen=spec["mechanics"].get("regenPerSec") == 8,
            openCombatMap=spec["world"]["width"] == 48 and spec["world"]["depth"] == 48
            and all(not e.get("solid") or abs(e["x"]) >= 16 for e in spec["world"]["entities"]),
        )
    else:
        checks["noUnselectedEnemiesOrWeapon"] = not spec["enemies"] and not spec["world"]["enemySpawns"] \
            and not spec["player"].get("weaponIpId") and not spec["player"].get("weaponUrl")
        checks["correctTimer"] = spec.get("rules", {}).get("timeLimitSec") == (
            120 if case["type"] == "escape" else 0)
        checks["correctJump"] = spec["mechanics"].get("jump") is (case["type"] == "exploration")
    bindings = []
    def bind(ip_id, url, field, role):
        ip = source_ips[ip_id]
        original = source_assets[ip[field]]
        expected = f"assets/{ip_id}.png" if field == "cutoutAssetId" else (
            f"assets/{ip_id}.rig.glb" if field == "riggedGlbAssetId" and role != "weapon" else f"assets/{ip_id}.glb")
        if url != expected:
            raise RuntimeError("Packaged asset URL is not the canonical selected IP path")
        packed_key = f"games/{game['gameId']}/{url}"
        packaged = read_blob(ctx, packed_key)
        validate_blob(packaged, field)
        bindings.append({"role": role, "ipId": ip_id, "modelUrl": url if field != "cutoutAssetId" else None,
                         "spriteUrl": url if field == "cutoutAssetId" else None,
                         "assetId": original["assetId"], "sourceKey": original["key"], "packagedKey": packed_key,
                         "bytes": len(packaged), "sha256": hashlib.sha256(packaged).hexdigest(),
                         "matchesSelectedAsset": packaged == source_blobs[original["assetId"]]})
    for role, entity in [("player", spec["player"]), *[("prop", p) for p in spec["props"]],
                         *[("enemy", e) for e in spec["enemies"]]]:
        ip_id = entity["ipId"]
        if ip_id == NPC:
            role = "npc"
        if not entity.get("modelUrl") or not entity.get("spriteUrl"):
            raise RuntimeError("Every selected player/NPC/prop/enemy needs real packaged 3D and image")
        field = "riggedGlbAssetId" if entity["modelUrl"].endswith(".rig.glb") else "glbAssetId"
        bind(ip_id, entity["modelUrl"], field, role)
        bind(ip_id, entity["spriteUrl"], "cutoutAssetId", role)
        if entity.get("weaponIpId"):
            wid = entity["weaponIpId"]
            field = "glbAssetId" if source_ips[wid].get("glbAssetId") else "riggedGlbAssetId"
            bind(wid, entity.get("weaponUrl"), field, "weapon")
    checks["allActualSourceBytesMatch"] = bool(bindings) and all(b["matchesSelectedAsset"] for b in bindings)
    result.update(gameId=game["gameId"], previewUrl=game["previewUrl"], checks=checks,
                  roleErrors=role_errors, assetBindings=bindings, spec=spec,
                  specSha256=hashlib.sha256(spec_bytes).hexdigest(), ok=all(checks.values()))
    if not result["ok"]:
        raise RuntimeError("Generated game failed structural checks: "
                           + ", ".join(k for k, passed in checks.items() if not passed))


def geometry_signature(spec):
    w = spec["world"]
    return {"width": w["width"], "depth": w["depth"], "spawn": w["spawn"],
            "entities": [{k: e.get(k) for k in ("kind", "x", "z", "y", "width", "depth", "height", "rotation", "solid")}
                         for e in w["entities"]],
            "props": [{k: p.get(k) for k in ("propIndex", "x", "z")} for p in w["propPlacements"]],
            "enemies": [{k: p.get(k) for k in ("enemyIndex", "x", "z")} for p in w["enemySpawns"]],
            "npc": {k: (w.get("npc") or {}).get(k) for k in ("x", "z", "propIndex")}}


def run(args):
    report_path = ROOT / args.report
    if report_path.exists() and not args.resume and not args.preflight_only:
        raise RuntimeError("Report already exists; use --resume to avoid duplicate showcase sessions")
    report = json.loads(report_path.read_text()) if args.resume and report_path.exists() else None
    secret = get_secret()
    base = secret["cloudfrontUrl"].rstrip("/")
    if base != EXPECTED_BASE:
        raise RuntimeError("Unexpected demo endpoint; no session mutation performed")
    token = cognito_login(base, secret["username"], secret["password"])
    user = boto3.client("cognito-idp", region_name="us-east-1").get_user(AccessToken=token)
    sub = next(a["Value"] for a in user["UserAttributes"] if a["Name"] == "sub")
    env = boto3.client("lambda", region_name="us-east-1").get_function_configuration(
        FunctionName="ipverse-api")["Environment"]["Variables"]
    os.environ.update(env)
    ctx = Ctx.from_env()
    source = store.snapshot(ctx, args.source_session)
    if not source["session"] or source["session"]["userSub"] != sub:
        raise RuntimeError("Source must belong to the authenticated operator")
    source_hash = digest(source)
    ips, source_assets, blobs, inventory = source_inventory(ctx, source)
    if args.preflight_only:
        print(json.dumps({"status": "READ_ONLY_SOURCE_BYTES_VERIFIED", "sourceSession": args.source_session,
                          "ownerVerified": True, "configuredAgentModel": ctx.agent_model_id,
                          "inventory": inventory, "cases": [
                              {"type": c["type"], "name": c["name"], "genre": c["genre"], "castIpIds": selected_cast(c)}
                              for c in CASES]}, ensure_ascii=False, indent=2))
        return
    config_hash = digest(CASES)
    if report:
        if (report["sourceSession"], report["caseConfigSha256"], report["sourceSnapshotSha256"]) != (
                args.source_session, config_hash, source_hash):
            raise RuntimeError("Saved source/configuration changed; do not silently resume with different IPs/prompts")
    else:
        report = {
            "status": "RUNNING", "runId": uuid.uuid4().hex[:12], "createdAt": now(), "cases": [],
            "sourceSession": args.source_session, "sourceSnapshotSha256": source_hash,
            "caseConfigSha256": config_hash, "commonCast": BASE_CAST, "sourceOwnerVerified": True,
            "sourceAssetInventory": inventory, "configuredAgentModel": ctx.agent_model_id,
            "initialSessionIds": [s["sessionId"] for s in call_api(base, "GET", "/api/sessions", token)["sessions"]],
            "proofScope": "Real authenticated chat generation, saved authored design and selected asset byte equality. "
                          "Configured model ID and native make_game trace are recorded. Physical gameplay, visual quality "
                          "and independent Bedrock request traces are separate evidence.",
            "gameplayStatus": "NOT_YET_VERIFIED",
        }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    save_report(report_path, report)
    try:
        for index, case in enumerate(CASES):
            if len(report["cases"]) <= index:
                report["cases"].append({"type": case["type"], "name": case["name"], "genre": case["genre"],
                                        "prompt": case["prompt"], "roles": case["roles"],
                                        "castIpIds": selected_cast(case), "ok": False})
            result = report["cases"][index]
            if result.get("ok"):
                continue
            if not result.get("sessionId"):
                if result.get("creationIntentAt"):
                    recover_created_session(base, token, report, result)
                else:
                    result["creationIntentAt"] = now()
                    save_report(report_path, report)
                    created = call_api(base, "POST", "/api/sessions", token,
                                       {"title": case["name"], "genre": case["genre"]})
                    result["sessionId"] = created["session"]["sessionId"]
                save_report(report_path, report)
            session = store.get_session(ctx, result["sessionId"])
            if not session or session["userSub"] != sub:
                raise RuntimeError("Resumed showcase session owner mismatch")
            if not result.get("assetsPreparedAt"):
                for ip_id in selected_cast(case):
                    for field in FIELDS:
                        aid = ips[ip_id].get(field)
                        if aid:
                            store.put_asset(ctx, session["sessionId"], copy.deepcopy(source_assets[aid]))
                    store.put_ip(ctx, session["sessionId"], copy.deepcopy(ips[ip_id]))
                store.update_session(ctx, session, concept=copy.deepcopy(source["session"]["concept"]))
                result["assetsPreparedAt"] = now()
                save_report(report_path, report)
            design = {"prompt": case["prompt"], "castIpIds": selected_cast(case), **case["roles"]}
            _, errors = game_design.validate_design(design, ips, case["prompt"])
            if errors:
                raise RuntimeError("Invalid structured showcase roles: " + "; ".join(errors))
            if not result.get("messageId"):
                if result.get("chatIntentAt"):
                    recover_chat(call_api(base, "GET", f"/api/sessions/{session['sessionId']}", token), result, case)
                else:
                    result["chatIntentAt"] = now()
                    save_report(report_path, report)
                    reply = call_api(base, "POST", f"/api/sessions/{session['sessionId']}/chat", token,
                                     {"text": case["prompt"], "gameDesign": design})
                    result["messageId"] = reply["messageId"]
                save_report(report_path, report)
            print(f"{case['name']}: request submitted — {result['sessionId']}/{result['messageId']}", flush=True)
        # Start every fresh model request before waiting for any of them.
        for index, case in enumerate(CASES):
            result = report["cases"][index]
            if result.get("ok"):
                continue
            started, last_log = time.monotonic(), -30
            while True:
                snap = call_api(base, "GET", f"/api/sessions/{result['sessionId']}", token)
                message = next((m for m in snap["messages"] if m["messageId"] == result["messageId"]), None)
                if message and message["status"] != "pending":
                    break
                elapsed = time.monotonic() - started
                if elapsed >= args.timeout:
                    raise TimeoutError(f"{case['name']} still pending; --resume polls the same request")
                if elapsed - last_log >= 30:
                    print(f"{case['name']}: actual generation pending ({int(elapsed)}s)", flush=True)
                    last_log = elapsed
                time.sleep(8)
            inspect_game(ctx, ips, source_assets, blobs, snap, result, case)
            result["verifiedAt"] = now()
            save_report(report_path, report)
            print(f"{case['name']}: generation/asset binding PASS — {result['previewUrl']}", flush=True)
        specs = [c["spec"] for c in report["cases"]]
        report["comparison"] = {
            "threeFreshDistinctSessions": len({c["sessionId"] for c in report["cases"]}) == 3
            and all(c["sessionId"] not in report["initialSessionIds"] for c in report["cases"]),
            "sameBasePlayerPropNpc": all(s["player"]["ipId"] == PLAYER
                and s["props"][s["world"]["npc"]["propIndex"]]["ipId"] == NPC
                and any(p["ipId"] == CORE for p in s["props"]) for s in specs),
            "threeDifferentWorldLayouts": len({digest(geometry_signature(s)) for s in specs}) == 3,
            "threeDifferentMissionActions": len({digest([t["type"] for t in s["mission"]["stages"]]) for s in specs}) == 3,
            "threeDifferentMechanics": len({digest(s["mechanics"]) for s in specs}) == 3,
            "threeDifferentArtDirections": len({digest(s["artDirection"]) for s in specs}) == 3,
            "sourceSessionUnchanged": digest(store.snapshot(ctx, args.source_session)) == source_hash,
        }
        if not all(report["comparison"].values()):
            raise RuntimeError("Showcase comparison failed; inspect actual saved layouts and source state")
        report["status"] = "GENERATION_VERIFIED_GAMEPLAY_PENDING"
        report.pop("error", None)
        save_report(report_path, report)
        print(json.dumps(report["comparison"], ensure_ascii=False, indent=2), flush=True)
    except Exception as error:
        report["status"] = "STOPPED_FOR_REVIEW"
        report["error"] = {"type": type(error).__name__, "message": str(error), "at": now()}
        save_report(report_path, report)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-session", default="ses_e57caf98a9")
    parser.add_argument("--report", default="evidence/three-game-showcase-generation.json")
    parser.add_argument("--resume", action="store_true", help="Recover/poll saved sessions without repeating ambiguous POSTs")
    parser.add_argument("--preflight-only", action="store_true", help="Read source ownership and full asset bytes; no writes")
    parser.add_argument("--timeout", type=int, default=600, help="Maximum polling seconds per existing request")
    args = parser.parse_args()
    if not 60 <= args.timeout <= 900:
        parser.error("--timeout must be 60–900 seconds")
    run(args)


if __name__ == "__main__":
    main()
