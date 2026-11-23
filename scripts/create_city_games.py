#!/usr/bin/env python3
"""Prepare or create two actual chat-generated, owned-IP browser cities.

  --plan-only       writes exact prompts locally; no AWS/network calls (default)
  --preflight-only  authenticates, reads ownership and full existing asset bytes
  --execute         creates fresh sessions, copies owned asset records and chats
  --execute --resume recovers existing intents; never blindly repeats a POST

Execution is an explicit operator step after the city runtime deployment is ready.
This helper does not deploy code, change source assets, or request media jobs.
Game generation evidence is separate from native-input gameplay/quality evidence.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import uuid

import boto3

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

# Only the transport, byte and recovery helpers are reused; its CASES and reports are left alone.
import create_three_game_showcase as helper
from server import game_design, gamespec, store
from server.providers.base import Ctx
from server.tools import CITY_RUNTIME_FILES, RUNTIME3D_FILES
from smoke import cognito_login, get_secret

REPORT = ROOT / "evidence/city-generation-live.json"
CAST = [helper.PLAYER, helper.CORE, helper.NPC]
ROLES = {"playerIpId": helper.PLAYER, "weaponIpId": None,
         "propIpIds": [helper.CORE], "enemyIpIds": [], "npcIpIds": [helper.NPC]}
LOCAL_RUNTIME = tuple(dict.fromkeys((*RUNTIME3D_FILES, *CITY_RUNTIME_FILES)))


def cases_for(run_id):
    """IDs are fresh per run, persisted before any POST and stable on resume."""
    stem = run_id[:12]
    common = (
        "[게임 설계]\n선택한 기존 출연 IP만 사용하는 실제 도시 게임을 만들어줘. "
        "주인공은 제나, 소품은 에너지 코어, 안내 NPC는 노인 정비사 카이이고 "
        "gameDesign에 지정한 player/prop/npc 역할을 그대로 유지해. "
        "이미지·컷아웃·GLB·리깅이 이미 준비되어 있으니 기존 서버 해결 에셋을 사용해. "
        "이미지·영상·3D·리깅·액션 샷·새 IP 생성 도구는 호출하지 말고 make_game으로 바로 만들어. "
        "version 2, engine three, 실제 world.city를 사용해. 작은 고정 아레나나 "
        "reach 목표의 이름만 주행으로 바꾼 게임은 허용하지 않아. "
        "건물·도로·차량은 준비된 공용 도시 환경 에셋 키트를 사용하고, "
        "플레이어·안내자·보행자·소품은 선택한 실제 IP만 사용해. "
        "NPC 캐릭터 IP는 카이 1종이고 모든 도시 보행자는 같은 props 슬롯을 재사용해. "
        "서로 다른 3개 구역을 실제 중심·폭·깊이로 배치하고 격자 도로를 연결해. "
        "도로 외곽과 월드 경계 사이에는 16m 이상 여유를 남겨. "
        "주차 차량은 도로 위에, 사람과 임무 대상은 도로 옆 인도에 두고 "
        "시작점→NPC→차량→소품→배송 지점 접근로를 건물이나 solid 구조물로 막지 마. "
        "landmark는 열린 비콘으로 두고 route 구간은 도로/인도를 따르는 수평 또는 수직 선분만 사용해. "
        "E로 승하차, WASD로 운전, Space 제동으로 실제 지정 차량을 운전하게 해. "
        "drive 단계는 target 1, entityIds=[지정 차량 ID 하나], distanceMeters에 실제 누적 주행 거리를 넣고 "
        "다른 단계에는 distanceMeters를 넣지 마. 주행은 해당 단계에서 직접 운전한 거리만 진행해야 해. "
        "규칙은 시간 제한 0, playerHp 200, 난이도 easy, enemies [], enemySpawns [], "
        "무기 없이 autoFire false, dash true, jump false, sprint true, regenPerSec 0, interactRadius 3. "
        "world.entities는 인도 밖의 장식과 목표 비콘만 사용하고 도로를 막지 마. "
        "좌표·ID·단계 순서·거리 요구를 정확히 지켜줘. 다음은 요청의 구체적인 설계야.\n"
    )
    day_ids = {name: f"d_{stem}_{name}" for name in
               ("guide", "car", "core", "gate", "greet", "drive", "gather", "deliver")}
    night_ids = {name: f"n_{stem}_{name}" for name in
                 ("guide", "car", "core", "gate", "gather", "drive", "deliver")}
    day_world = {
        "width": 600, "depth": 600, "spawn": {"x": -12, "z": 232},
        "npc": {"id": day_ids["guide"], "x": -12, "z": 220},
        "car": {"id": day_ids["car"], "kind": "sedan", "x": 0, "z": 208, "yaw": 0},
        "core": {"id": day_ids["core"], "x": -12, "z": 0},
        "gate": {"id": day_ids["gate"], "x": 188, "z": -12},
        "roadX": [-180, 0, 180], "roadZ": [-180, 0, 180], "roadWidth": 16,
        "districtStyles": ["downtown", "residential", "waterfront"],
        "pedestrians": 4, "trafficCount": 6,
        "groundColor": "#424d50",
        "artDirection": {"skyColor": "#92c8ed", "fogColor": "#b9d4e0", "fogDensity": .002,
                         "exposure": 1.1, "bloomStrength": .2},
    }
    night_world = {
        "width": 800, "depth": 600, "spawn": {"x": -12, "z": 232},
        "npc": {"id": night_ids["guide"], "x": -12, "z": 220},
        "car": {"id": night_ids["car"], "kind": "suv", "x": 0, "z": 208, "yaw": 0},
        "core": {"id": night_ids["core"], "x": -12, "z": 200},
        "gate": {"id": night_ids["gate"], "x": -228, "z": -12},
        "roadX": [-180, 0, 180], "roadZ": [-240, 0, 240], "roadWidth": 16,
        "districtStyles": ["industrial", "downtown", "residential"],
        "pedestrians": 4, "trafficCount": 4,
        "groundColor": "#242b32",
        "artDirection": {"skyColor": "#091226", "fogColor": "#18243b", "fogDensity": .003,
                         "exposure": 1.25, "bloomStrength": .75},
    }
    day = (
        f"낮의 해안 도시 코어 운송: 새 구역·도로·보행자 ID는 d_{stem}_ 접두사를 사용해 서로 고유하게 해줘. "
        "폭 600m 깊이 600m, world.spawn=(-12,232). "
        f"world.npc.id={day_ids['guide']}, 좌표(-12,220), 실제 카이 props 인덱스를 지정해. "
        "구역은 중앙 도심 downtown 중심(0,0) 폭180 깊이180, "
        "서쪽 주거 residential 중심(-190,0) 폭160 깊이420, "
        "동쪽 수변 waterfront 중심(190,0) 폭160 깊이420의 정확히 3개야. "
        "streets는 x축 도로 z=[-180,0,180], z축 도로 x=[-180,0,180], 전부 width16으로 정확히 6개. "
        f"차량은 sedan 1대 id={day_ids['car']}, (0,208), yaw0. "
        "보행자 4명: (-12,208)↔(-12,196), (12,180)↔(12,160), "
        "(-180,12)↔(-160,12), (180,-12)↔(160,-12)의 두 점 왕복 순환 경로로 "
        "각 첫 점을 시작 좌표로 지정해. trafficCount6. "
        f"미션은 정확히 4단계: {day_ids['greet']} talk, target1, "
        f"entityIds=[{day_ids['guide']}], holdSec0으로 카이와 대화 → "
        f"{day_ids['drive']} drive, target1, entityIds=[{day_ids['car']}], distanceMeters140 → "
        f"{day_ids['gather']} collect, target1, entityIds=[{day_ids['core']}] → "
        f"{day_ids['deliver']} reach, target1, entityIds=[{day_ids['gate']}]. "
        f"실제 코어 placement id={day_ids['core']}는 (-12,0), stageId={day_ids['gather']}에서만 활성화, "
        f"배송 beacon id={day_ids['gate']}는 (188,-12), solidfalse로 배치해. "
        "하늘 #92c8ed, 안개 #b9d4e0 밀도0.002, 바닥 #424d50, exposure1.1, bloomStrength0.2. "
        "지중해풍 낮의 도시 분위기를 실제 구역·도로·키트 건물 배치로 표현해."
    )
    night = (
        f"밤의 산업 도시 코어 배송: 새 구역·도로·보행자 ID는 n_{stem}_ 접두사를 사용해 서로 고유하게 해줘. "
        "폭 800m 깊이 600m, world.spawn=(-12,232). "
        f"world.npc.id={night_ids['guide']}, 좌표(-12,220), 실제 카이 props 인덱스 지정. "
        "구역은 서쪽 산업 industrial 중심(-240,0) 폭240 깊이420, "
        "중앙 도심 downtown 중심(0,0) 폭200 깊이200, "
        "동쪽 주거 residential 중심(240,0) 폭240 깊이420의 정확히 3개야. "
        "streets는 x축 도로 z=[-180,0,180], z축 도로 x=[-240,0,240], 전부 width16으로 정확히 6개. "
        f"차량은 suv 1대 id={night_ids['car']}, (0,208), yaw0. "
        "보행자 4명: (-12,208)↔(-12,196), (12,180)↔(12,160), "
        "(-240,12)↔(-220,12), (240,-12)↔(220,-12)의 두 점 왕복 순환 경로로 "
        "각 첫 점을 시작 좌표로 지정해. trafficCount4. "
        f"미션은 정확히 3단계이고 대화는 필수가 아니야: {night_ids['gather']} collect, "
        f"target1, entityIds=[{night_ids['core']}] → "
        f"{night_ids['drive']} drive, target1, entityIds=[{night_ids['car']}], distanceMeters180 → "
        f"{night_ids['deliver']} reach, target1, entityIds=[{night_ids['gate']}]. "
        f"실제 코어 placement id={night_ids['core']}는 (-12,200), stageId={night_ids['gather']}에서만 활성화, "
        f"산업 배송 beacon id={night_ids['gate']}는 (-228,-12), solidfalse로 배치해. "
        "하늘 #091226, 안개 #18243b 밀도0.003, 바닥 #242b32, exposure1.25, bloomStrength0.75. "
        "짙은 남색 밤, 주황 산업등과 청록 네온의 산업 도시를 실제 구역·키트 건물 배치로 표현해."
    )
    return [
        {"type": "daytime-waterfront", "name": f"해안 도시 코어 운송 · {stem[:6]}",
         "genre": "rpg-quest", "roles": copy.deepcopy(ROLES), "prompt": common + day,
         "expected": day_world, "stageTypes": ["talk", "drive", "collect", "reach"],
         "stageIds": [day_ids[k] for k in ("greet", "drive", "gather", "deliver")], "driveMeters": 140},
        {"type": "industrial-night", "name": f"산업 도시 야간 배송 · {stem[:6]}",
         "genre": "rpg-quest", "roles": copy.deepcopy(ROLES), "prompt": common + night,
         "expected": night_world, "stageTypes": ["collect", "drive", "reach"],
         "stageIds": [night_ids[k] for k in ("gather", "drive", "deliver")], "driveMeters": 180},
    ]


def source_inventory(ctx, source):
    ips = {ip["ipId"]: ip for ip in source["ips"]}
    assets = {asset["assetId"]: asset for asset in source["assets"]}
    rows, blobs, selected = [], {}, {}
    for ip_id, kind in zip(CAST, ("character", "prop", "character")):
        ip = ips.get(ip_id)
        if not ip or ip.get("kind") != kind:
            raise RuntimeError(f"Prepared city source role/kind missing: {ip_id}")
        if not all(ip.get(field) in assets for field in ("imageAssetId", "cutoutAssetId", "glbAssetId")):
            raise RuntimeError(f"Prepared real source image, cutout and mesh are required: {ip_id}")
        row = {"ipId": ip_id, "name": ip.get("name"), "kind": kind, "assets": {}}
        for field in helper.FIELDS:
            aid = ip.get(field)
            if not aid:
                continue
            asset = assets.get(aid)
            if not asset or asset.get("ipId") != ip_id or not asset["key"].startswith(
                    f"sessions/{source['session']['sessionId']}/"):
                raise RuntimeError("Selected city source asset ownership/lineage mismatch")
            blob = helper.read_blob(ctx, asset["key"])
            helper.validate_blob(blob, field)
            selected[aid], blobs[aid] = asset, blob
            row["assets"][field] = {"assetId": aid, "sourceKey": asset["key"], "bytes": len(blob),
                                    "sha256": hashlib.sha256(blob).hexdigest()}
        rows.append(row)
    return ips, selected, blobs, rows


def at(entity, expected):
    return isinstance(entity, dict) and all(entity.get(k) == expected[k] for k in ("id", "x", "z"))


def inspect_game(ctx, source_ips, source_assets, source_blobs, snap, result, case):
    message = next(m for m in snap["messages"] if m["messageId"] == result["messageId"])
    result.update(messageStatus=message["status"], agentText=message.get("text", ""),
                  toolEvents=message.get("toolEvents", []), newMediaJobs=len(snap["jobs"]))
    result["modelToolEvidenceScope"] = "Persisted actual tool events are summaries; raw Bedrock Converse tool payloads are not claimed."
    if message["status"] != "done" or len(snap["games"]) != 1:
        raise RuntimeError("Actual chat must finish with exactly one new city game")
    game = snap["games"][0]
    spec_bytes = helper.read_blob(ctx, game["specKey"])
    spec = json.loads(spec_bytes)
    normalized, errors = gamespec.validate_spec(spec)
    if errors:
        raise RuntimeError("Saved city GameSpec is invalid: " + "; ".join(errors))
    role_errors = game_design.role_errors(normalized, {"prompt": case["prompt"], "castIpIds": CAST, **ROLES})
    world, city, stages = spec["world"], spec["world"].get("city", {}), spec["mission"]["stages"]
    expected = case["expected"]
    vehicles = city.get("vehicles", [])
    car = next((v for v in vehicles if v["id"] == expected["car"]["id"]), {})
    placements = world["propPlacements"]
    core = next((p for p in placements if p["id"] == expected["core"]["id"]), {})
    gate = next((e for e in world["entities"] if e["id"] == expected["gate"]["id"]), {})
    drive = next((s for s in stages if s["type"] == "drive"), {})
    npc_index = world.get("npc", {}).get("propIndex")
    npc_id = spec["props"][npc_index].get("ipId") if isinstance(npc_index, int) else None
    street = lambda axis: sorted(s["coordinate"] for s in city.get("streets", []) if s["axis"] == axis)
    checks = {
        "ownedFreshGame": game.get("gameId") and game["specKey"].startswith(f"games/{game['gameId']}/"),
        "version2ThreeCity": spec["version"] == 2 and spec.get("engine") == game.get("engine") == "three"
        and isinstance(world.get("city"), dict),
        "exactOriginalPrompt": spec.get("design", {}).get("sourcePrompt") == case["prompt"],
        "exactSelectedCast": set(game.get("castIpIds", [])) == set(CAST),
        "exactRoles": not role_errors and all(spec.get("design", {}).get(k) == v for k, v in ROLES.items()),
        "correctSessionGenre": snap["session"]["genre"] == spec["genre"] == case["genre"],
        "exactDimensions": (world["width"], world["depth"]) == (expected["width"], expected["depth"]),
        "exactSpawn": world["spawn"] == expected["spawn"],
        "exactNpcAndRole": at(world.get("npc"), expected["npc"]) and npc_id == helper.NPC,
        "exactDistrictStyles": len(city.get("districts", [])) == 3
        and sorted(d["style"] for d in city["districts"]) == sorted(expected["districtStyles"]),
        "exactRoadTopology": street("x") == expected["roadX"] and street("z") == expected["roadZ"]
        and all(s["width"] == expected["roadWidth"] for s in city.get("streets", [])),
        "exactSelectedVehicle": len(vehicles) == 1 and at(car, expected["car"])
        and car.get("kind") == expected["car"]["kind"] and car.get("yaw") == expected["car"]["yaw"],
        "actualNpcPedestrianReuse": len(city.get("pedestrians", [])) == expected["pedestrians"]
        and all(p["propIndex"] == npc_index for p in city.get("pedestrians", [])),
        "exactTrafficCount": city.get("trafficCount") == expected["trafficCount"],
        "exactRequestedArt": spec.get("artDirection") == expected["artDirection"]
        and world.get("groundColor") == expected["groundColor"],
        "exactMissionActionsAndIds": [s["type"] for s in stages] == case["stageTypes"]
        and [s["id"] for s in stages] == case["stageIds"] and all(s["target"] == 1 for s in stages),
        "realDistanceDriveStage": drive.get("distanceMeters") == case["driveMeters"]
        and drive.get("entityIds") == [expected["car"]["id"]],
        "exactCoreAndDestination": at(core, expected["core"]) and at(gate, expected["gate"])
        and core.get("propIndex") is not None and spec["props"][core["propIndex"]]["ipId"] == helper.CORE,
        "stageBoundCore": core.get("stageId") == next(s["id"] for s in stages if s["type"] == "collect"),
        "peacefulManualNoTimer": not spec["enemies"] and not world["enemySpawns"]
        and not spec["player"].get("weaponIpId") and not spec["player"].get("weaponUrl")
        and spec["mechanics"].get("autoFire") is False and spec["rules"].get("timeLimitSec") == 0,
        "actualAgentGameTool": any(e.get("tool") == "make_game" for e in message.get("toolEvents", [])),
        "onlyGameTools": all(e.get("tool") in ("make_game", "get_game_spec") for e in message.get("toolEvents", [])),
        "noMediaJobs": not snap["jobs"],
    }
    bindings = []
    for entity in [spec["player"], *spec["props"]]:
        ip_id = entity["ipId"]
        if ip_id not in CAST:
            raise RuntimeError("Saved city introduced an unselected IP")
        role = "player" if ip_id == helper.PLAYER else "npc" if ip_id == helper.NPC else "prop"
        for field, url in (
            ("riggedGlbAssetId" if entity.get("modelUrl", "").endswith(".rig.glb") else "glbAssetId", entity.get("modelUrl")),
            ("cutoutAssetId", entity.get("spriteUrl")),
        ):
            ip = source_ips[ip_id]
            original = source_assets.get(ip.get(field))
            expected_url = (f"assets/{ip_id}.png" if field == "cutoutAssetId" else
                            f"assets/{ip_id}.rig.glb" if field == "riggedGlbAssetId" else f"assets/{ip_id}.glb")
            if not original or url != expected_url:
                raise RuntimeError("Saved city must resolve the exact prepared selected-IP assets")
            packaged_key = f"games/{game['gameId']}/{url}"
            packaged = helper.read_blob(ctx, packaged_key)
            helper.validate_blob(packaged, field)
            bindings.append({"role": role, "ipId": ip_id, "assetId": original["assetId"],
                             "sourceKey": original["key"], "packagedKey": packaged_key,
                             "bytes": len(packaged), "sha256": hashlib.sha256(packaged).hexdigest(),
                             "matchesSelectedAsset": packaged == source_blobs[original["assetId"]]})
    runtime = []
    for filename in LOCAL_RUNTIME:
        packed = helper.read_blob(ctx, f"games/{game['gameId']}/{filename}")
        local = (ROOT / "game3d" / filename).read_bytes()
        runtime.append({"file": filename, "bytes": len(packed),
                        "sha256": hashlib.sha256(packed).hexdigest(), "matchesCurrentSource": packed == local})
    checks["allActualSourceBytesMatch"] = len(bindings) == 6 and all(b["matchesSelectedAsset"] for b in bindings)
    checks["cityControllerRuntimePackaged"] = all(r["matchesCurrentSource"] for r in runtime) \
        and {"city-contract.js", *CITY_RUNTIME_FILES}.issubset(r["file"] for r in runtime)
    result.update(gameId=game["gameId"], previewUrl=game["previewUrl"], specKey=game["specKey"],
                  specSha256=hashlib.sha256(spec_bytes).hexdigest(), specBytes=len(spec_bytes),
                  spec=spec, roleErrors=role_errors, assetBindings=bindings, runtimeBindings=runtime,
                  actualSavedGameRecord=game, checks=checks, ok=all(checks.values()))
    if not result["ok"]:
        raise RuntimeError("Actual city differs from the request: " + ", ".join(k for k, ok in checks.items() if not ok))


def init_report():
    run_id = uuid.uuid4().hex
    cases = cases_for(run_id)
    return {
        "status": "PLANNED_NOT_EXECUTED", "createdAt": helper.now(), "runId": run_id,
        "sourceSession": "ses_e57caf98a9", "commonCast": CAST, "sourceOwnerVerified": False,
        "caseConfigSha256": helper.digest(cases),
        "proofScope": "Actual authenticated chat/agent make_game, saved city design and selected asset/runtime byte equality. "
                      "No Unreal or AAA-quality claim. Physical keyboard driving, pedestrian motion and mission completion require separate browser evidence.",
        "gameplayStatus": "NOT_YET_VERIFIED",
        "cases": [{**case, "castIpIds": CAST, "ok": False} for case in cases],
    }


def run(args):
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    report = json.loads(REPORT.read_text()) if REPORT.exists() else init_report()
    cases = cases_for(report["runId"])
    config_hash = helper.digest(cases)
    if config_hash != report["caseConfigSha256"]:
        if any(c.get("creationIntentAt") or c.get("sessionId") for c in report["cases"]):
            raise RuntimeError("Submitted prompt/configuration changed; never resume using different prompts")
        report.setdefault("planRevisions", []).append(
            {"previousCaseConfigSha256": report["caseConfigSha256"], "at": helper.now(),
             "scope": "Unsubmitted local plan revised; no session or model request existed"})
        report["caseConfigSha256"] = config_hash
        report["cases"] = [{**case, "castIpIds": CAST, "ok": False} for case in cases]
    if args.plan_only or not (args.preflight_only or args.execute):
        helper.save_report(REPORT, report)
        print(json.dumps({"status": report["status"], "report": str(REPORT.relative_to(ROOT)),
                          "cases": [{k: c[k] for k in ("type", "name", "stageTypes", "driveMeters")} for c in cases]},
                         ensure_ascii=False, indent=2))
        return
    if args.execute and not args.resume and any(c.get("creationIntentAt") or c.get("sessionId") for c in report["cases"]):
        raise RuntimeError("Existing city creation intents require --execute --resume; no duplicate POST performed")
    secret = get_secret()
    base = secret["cloudfrontUrl"].rstrip("/")
    if base != helper.EXPECTED_BASE:
        raise RuntimeError("Unexpected demo endpoint; no session mutation performed")
    token = cognito_login(base, secret["username"], secret["password"])
    user = boto3.client("cognito-idp", region_name="us-east-1").get_user(AccessToken=token)
    sub = next(a["Value"] for a in user["UserAttributes"] if a["Name"] == "sub")
    config = boto3.client("lambda", region_name="us-east-1").get_function_configuration(FunctionName="ipverse-api")
    os.environ.update(config["Environment"]["Variables"])
    ctx = Ctx.from_env()
    source = store.snapshot(ctx, report["sourceSession"])
    if not source["session"] or source["session"]["userSub"] != sub:
        raise RuntimeError("Source city IP session must belong to the authenticated operator")
    source_hash = helper.digest(source)
    if report.get("sourceSnapshotSha256") and report["sourceSnapshotSha256"] != source_hash:
        raise RuntimeError("Source changed after planning/preflight; do not silently reuse different IPs")
    ips, source_assets, blobs, inventory = source_inventory(ctx, source)
    for case in cases:
        _, errors = game_design.validate_design({"prompt": case["prompt"], "castIpIds": CAST, **ROLES}, ips, case["prompt"])
        if errors:
            raise RuntimeError("City prompt/role preflight failed before any mutation: " + "; ".join(errors))
    report.update(sourceOwnerVerified=True, sourceSnapshotSha256=source_hash,
                  sourceAssetInventory=inventory, configuredAgentModel=ctx.agent_model_id,
                  actualLambdaCodeSha256=config["CodeSha256"])
    if args.preflight_only:
        report["status"] = "READ_ONLY_SOURCE_BYTES_VERIFIED"
        report["sourceSessionUnchanged"] = helper.digest(store.snapshot(ctx, report["sourceSession"])) == source_hash
        helper.save_report(REPORT, report)
        print(json.dumps({"status": report["status"], "ownerVerified": True,
                          "ipCount": len(inventory), "assetCount": sum(len(row["assets"]) for row in inventory),
                          "sourceSessionUnchanged": report["sourceSessionUnchanged"]}, indent=2))
        return
    if "initialSessionIds" not in report:
        report["initialSessionIds"] = [s["sessionId"] for s in helper.call_api(base, "GET", "/api/sessions", token)["sessions"]]
    report.update(status="RUNNING", executionStartedAt=report.get("executionStartedAt", helper.now()))
    helper.save_report(REPORT, report)
    try:
        for case, result in zip(cases, report["cases"]):
            if result.get("ok"):
                continue
            if not result.get("sessionId"):
                if result.get("creationIntentAt"):
                    helper.recover_created_session(base, token, report, result)
                else:
                    result["creationIntentAt"] = helper.now()
                    helper.save_report(REPORT, report)
                    created = helper.call_api(base, "POST", "/api/sessions", token, {"title": case["name"], "genre": case["genre"]})
                    result["sessionId"] = created["session"]["sessionId"]
                helper.save_report(REPORT, report)
            session = store.get_session(ctx, result["sessionId"])
            if not session or session["userSub"] != sub or session["sessionId"] in report["initialSessionIds"]:
                raise RuntimeError("City session owner/freshness mismatch")
            if not result.get("assetsPreparedAt"):
                for ip_id in CAST:
                    for field in helper.FIELDS:
                        aid = ips[ip_id].get(field)
                        if aid:
                            store.put_asset(ctx, session["sessionId"], copy.deepcopy(source_assets[aid]))
                    store.put_ip(ctx, session["sessionId"], copy.deepcopy(ips[ip_id]))
                store.update_session(ctx, session, concept=copy.deepcopy(source["session"]["concept"]))
                result["assetsPreparedAt"] = helper.now()
                helper.save_report(REPORT, report)
            design = {"prompt": case["prompt"], "castIpIds": CAST, **ROLES}
            _, errors = game_design.validate_design(design, ips, case["prompt"])
            if errors:
                raise RuntimeError("Invalid selected city IP design: " + "; ".join(errors))
            if not result.get("messageId"):
                if result.get("chatIntentAt"):
                    helper.recover_chat(helper.call_api(base, "GET", f"/api/sessions/{session['sessionId']}", token), result, case)
                else:
                    result["chatIntentAt"] = helper.now()
                    helper.save_report(REPORT, report)
                    reply = helper.call_api(base, "POST", f"/api/sessions/{session['sessionId']}/chat", token,
                                            {"text": case["prompt"], "gameDesign": design})
                    result["messageId"] = reply["messageId"]
                helper.save_report(REPORT, report)
            print(f"{case['type']}: actual chat submitted {result['sessionId']}/{result['messageId']}", flush=True)
        for case, result in zip(cases, report["cases"]):
            if result.get("ok"):
                continue
            started, last_log = time.monotonic(), -30
            while True:
                snap = helper.call_api(base, "GET", f"/api/sessions/{result['sessionId']}", token)
                message = next((m for m in snap["messages"] if m["messageId"] == result["messageId"]), None)
                if message and message["status"] != "pending":
                    break
                elapsed = time.monotonic() - started
                if elapsed >= args.timeout:
                    raise TimeoutError("Existing city chat is still pending; --execute --resume will poll it without re-submission")
                if elapsed - last_log >= 30:
                    print(f"{case['type']}: actual generation pending ({int(elapsed)}s)", flush=True)
                    last_log = elapsed
                time.sleep(8)
            inspect_game(ctx, ips, source_assets, blobs, snap, result, case)
            result["verifiedAt"] = helper.now()
            helper.save_report(REPORT, report)
            print(f"{case['type']}: generated design and exact asset/runtime bytes PASS ({result['gameId']})", flush=True)
        specs = [c["spec"] for c in report["cases"]]
        report["comparison"] = {
            "twoFreshOwnedSessions": len({c["sessionId"] for c in report["cases"]}) == 2
            and all(c["sessionId"] not in report["initialSessionIds"] for c in report["cases"]),
            "sameSelectedPlayerCoreNpc": all(s["player"]["ipId"] == helper.PLAYER
                and s["props"][s["world"]["npc"]["propIndex"]]["ipId"] == helper.NPC
                and any(p["ipId"] == helper.CORE for p in s["props"]) for s in specs),
            "differentSavedWorlds": len({helper.digest(s["world"]) for s in specs}) == 2,
            "differentRoads": len({helper.digest(sorted(
                [{k: road[k] for k in ("axis", "coordinate", "width")} for road in s["world"]["city"]["streets"]],
                key=lambda road: (road["axis"], road["coordinate"]))) for s in specs}) == 2,
            "differentVehicleKinds": len({s["world"]["city"]["vehicles"][0]["kind"] for s in specs}) == 2,
            "differentStageActions": len({helper.digest([a["type"] for a in s["mission"]["stages"]]) for s in specs}) == 2,
            "differentArtDirections": len({helper.digest(s["artDirection"]) for s in specs}) == 2,
            "sourceSessionUnchanged": helper.digest(store.snapshot(ctx, report["sourceSession"])) == source_hash,
        }
        if not all(report["comparison"].values()):
            raise RuntimeError("Actual city comparison or source immutability failed")
        report.update(status="GENERATION_VERIFIED_GAMEPLAY_PENDING")
        report.pop("error", None)
        helper.save_report(REPORT, report)
        print(json.dumps(report["comparison"], ensure_ascii=False, indent=2))
    except Exception as error:
        report.update(status="STOPPED_FOR_REVIEW", error={"type": type(error).__name__,
                      "message": str(error), "at": helper.now()})
        helper.save_report(REPORT, report)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--plan-only", action="store_true")
    modes.add_argument("--preflight-only", action="store_true")
    modes.add_argument("--execute", action="store_true", help="Explicit actual session/chat mutations after deployment is ready")
    parser.add_argument("--resume", action="store_true", help="Recover/poll existing intents; requires --execute")
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()
    if args.resume and not args.execute:
        parser.error("--resume requires --execute")
    if not 60 <= args.timeout <= 900:
        parser.error("--timeout must be 60–900 seconds")
    run(args)


if __name__ == "__main__":
    main()
