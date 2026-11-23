#!/usr/bin/env python3
"""Real authenticated generation with the same owned IPs and two different prompts.

Creates two useful demo sessions, reusing existing assets without generating media.
Credentials and tokens stay in memory. No existing session or release is changed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import urllib.request

import boto3

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from smoke import api_call, cognito_login, get_secret
from server import gamespec, store
from server.providers.base import Ctx


CASES = [
    {
        "name": "숲의 유적 · IP 맞춤 데모",
        "prompt": "[게임 설계]\n같은 선택 IP로 평화로운 판타지 숲 유적 탐험 게임을 만들어줘. "
                  "주인공은 제나, 소품은 에너지 코어, NPC는 노인 정비사 카이. 선택하지 않은 적이나 새 IP는 추가하지 마. "
                  "초록·금빛의 맑은 낮, 나무와 돌기둥·아치·작은 신전이 서로 다른 구역을 이루는 월드를 직접 배치해줘. "
                  "먼저 NPC에게 E로 이야기하고, 서로 다른 숲 구역의 코어 3개를 수집하고, "
                  "마지막에 신전 입구에 도착하면 클리어하는 3단계 미션으로 만들어줘. "
                  "코어는 우리 소품의 실제 3D를 사용해. 제한 시간과 전투·자동 발사는 없고 점프와 달리기는 켜줘. "
                  "시작점과 미션 대상은 구조물에 막히지 않게 해줘. 이미 3D가 준비되어 있으니 이미지·영상·3D 작업은 하지 말고 "
                  "version 2 world와 mission으로 바로 플레이 가능한 게임을 만들어줘.",
    },
    {
        "name": "네온 시설 탈출 · IP 맞춤 데모",
        "prompt": "[게임 설계]\n같은 선택 IP로 제한 시간 90초의 SF 네온 전력시설 탈출 게임을 만들어줘. "
                  "주인공은 제나, 소품은 에너지 코어, NPC는 노인 정비사 카이. 선택하지 않은 적이나 새 IP는 추가하지 마. "
                  "차가운 남색 밤과 청록 네온, 건물 사이 골목·전력실·탈출 게이트가 이어지게 직접 배치하고 "
                  "붉은 위험 구역 2곳은 우회할 수 있게 만들어줘. "
                  "전력실의 실제 소품 코어 2개를 수집한 뒤, 떨어져 있는 단말 2곳에서 E로 각각 상호작용하고, "
                  "마지막에 탈출 게이트에 도착하면 클리어하는 3단계 미션으로 만들어줘. "
                  "NPC는 안전한 입구에 실제 선택 캐릭터로 두되 이 미션에 대화는 필수로 넣지 마. "
                  "점프는 끄고 대시·달리기는 켜고 자동 발사는 끄고 체력 200으로 해줘. "
                  "시작점과 미션 대상은 구조물에 막히지 않게 해줘. 이미 3D가 준비되어 있으니 이미지·영상·3D 작업은 하지 말고 "
                  "version 2 world와 mission으로 바로 플레이 가능한 게임을 만들어줘.",
    },
]
ROLE_IDS = {
    "playerIpId": "ip_01c8ef0ece",
    "propIpIds": ["ip_daa57bd628"],
    "npcIpIds": ["ip_96d1439744"],
    "enemyIpIds": [],
    "weaponIpId": None,
}
CAST = [ROLE_IDS["playerIpId"], *ROLE_IDS["propIpIds"], *ROLE_IDS["npcIpIds"]]


def digest(value):
    return hashlib.sha256(json.dumps(store.plain(value), sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-session", default="ses_e57caf98a9")
    parser.add_argument("--report", default="evidence/authored-generation-live.json")
    parser.add_argument("--resume", action="store_true", help="Poll sessions already created in this report")
    args = parser.parse_args()
    report_file = ROOT / args.report
    report_file.parent.mkdir(parents=True, exist_ok=True)
    secret = get_secret()
    base = secret["cloudfrontUrl"].rstrip("/")
    assert base == "https://d12ka835iwfpnx.cloudfront.net"
    token = cognito_login(base, secret["username"], secret["password"])
    sub = next(a["Value"] for a in boto3.client("cognito-idp", region_name="us-east-1")
               .get_user(AccessToken=token)["UserAttributes"] if a["Name"] == "sub")
    env = boto3.client("lambda", region_name="us-east-1").get_function_configuration(
        FunctionName="ipverse-api")["Environment"]["Variables"]
    os.environ.update(env)
    ctx = Ctx.from_env()
    source = store.snapshot(ctx, args.source_session)
    assert source["session"]["userSub"] == sub, "Source must belong to the authenticated demo user"
    source_hash = digest(source)
    ips = {i["ipId"]: i for i in source["ips"]}
    assert all(i in ips for i in CAST)
    required_assets = {ips[i][key] for i in CAST
                       for key in ("imageAssetId", "cutoutAssetId", "glbAssetId", "riggedGlbAssetId")
                       if ips[i].get(key)}
    assert all(ips[i].get("glbAssetId") for i in CAST), "Use real prepared 3D IP assets"
    report = json.loads(report_file.read_text()) if args.resume and report_file.exists() else {
        "status": "RUNNING", "sameCast": CAST, "sourceSession": args.source_session,
        "sourceSnapshotSha256": source_hash, "cases": [],
        "proofScope": "Real Cognito/CloudFront/chat/Bedrock/Lambda generation and asset binding; browser gameplay is separate.",
    }
    def save():
        report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    for index, case in enumerate(CASES):
        if len(report["cases"]) <= index:
            session = api_call(base, "POST", "/api/sessions", token,
                               {"title": case["name"], "genre": "rpg-quest"})["session"]
            for asset in source["assets"]:
                if asset["assetId"] in required_assets:
                    store.put_asset(ctx, session["sessionId"], dict(asset))
            for ip_id in CAST:
                store.put_ip(ctx, session["sessionId"], dict(ips[ip_id]))
            store.update_session(ctx, session, concept=source["session"]["concept"])
            design = {"prompt": case["prompt"], "castIpIds": CAST, **ROLE_IDS}
            reply = api_call(base, "POST", f"/api/sessions/{session['sessionId']}/chat", token,
                             {"text": case["prompt"], "gameDesign": design})
            report["cases"].append({"name": case["name"], "sessionId": session["sessionId"],
                                     "messageId": reply["messageId"], "prompt": case["prompt"]})
            save()
        result = report["cases"][index]
        if result.get("ok"):
            continue
        started = time.monotonic()
        while time.monotonic() - started < 420:
            snap = api_call(base, "GET", f"/api/sessions/{result['sessionId']}", token)
            message = next(m for m in snap["messages"] if m["messageId"] == result["messageId"])
            if message["status"] != "pending":
                break
            print(f"Waiting for actual generation: {case['name']} ({int(time.monotonic()-started)}s)", flush=True)
            time.sleep(8)
        result["messageStatus"] = message["status"]
        result["agentText"] = message["text"]
        result["toolEvents"] = message["toolEvents"]
        result["newMediaJobs"] = len(snap["jobs"])
        if not snap["games"]:
            result["ok"] = False
            save()
            raise RuntimeError(f"Actual generation did not produce a game: {message['status']}")
        game = snap["games"][-1]
        spec_bytes = ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=game["specKey"])["Body"].read()
        spec = json.loads(spec_bytes)
        normalized, errors = gamespec.validate_spec(spec)
        assert not errors, errors
        checks = {
            "version2": spec["version"] == 2 and game["engine"] == "three",
            "exactOriginalPrompt": spec.get("design", {}).get("sourcePrompt") == case["prompt"],
            "sameSelectedCast": set(game.get("castIpIds", [])) == set(CAST),
            "selectedPlayer": spec["player"]["ipId"] == ROLE_IDS["playerIpId"],
            "selectedProp": any(p["ipId"] == ROLE_IDS["propIpIds"][0] for p in spec["props"]),
            "selectedNpc": spec["props"][spec["world"]["npc"]["propIndex"]]["ipId"] == ROLE_IDS["npcIpIds"][0],
            "noUnselectedEnemies": not spec["enemies"] and not spec["world"]["enemySpawns"],
            "threeOrderedStages": len(spec["mission"]["stages"]) == 3,
            "noExtraMediaJobs": not snap["jobs"],
            "autoFireOff": not spec["mechanics"].get("autoFire"),
        }
        asset_bindings = []
        for entity in [spec["player"], *spec["props"]]:
            ip = ips[entity["ipId"]]
            assert entity.get("modelUrl"), "Actual 3D binding required"
            field = "riggedGlbAssetId" if entity["modelUrl"].endswith(".rig.glb") else "glbAssetId"
            original = next(a for a in source["assets"] if a["assetId"] == ip[field])
            source_blob = ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=original["key"])["Body"].read()
            packaged = ctx.s3.get_object(Bucket=ctx.assets_bucket,
                                         Key=f"games/{game['gameId']}/{entity['modelUrl']}")["Body"].read()
            asset_bindings.append({"ipId": ip["ipId"], "modelUrl": entity["modelUrl"],
                                   "bytes": len(packaged), "sha256": hashlib.sha256(packaged).hexdigest(),
                                   "matchesSelectedAsset": packaged == source_blob})
        checks["sameActualSelectedAssets"] = all(a["matchesSelectedAsset"] for a in asset_bindings)
        result.update(gameId=game["gameId"], previewUrl=game["previewUrl"], checks=checks,
                      assetBindings=asset_bindings, specSha256=hashlib.sha256(spec_bytes).hexdigest(),
                      spec=spec, ok=all(checks.values()))
        save()
        print(case["name"], "PASS" if result["ok"] else "FAIL", json.dumps(checks), flush=True)
        if not result["ok"]:
            raise RuntimeError("Generated game does not meet its structural checks")
    a, b = [case["spec"] for case in report["cases"]]
    report["comparison"] = {
        "sameCast": a["design"]["castIpIds"] == b["design"]["castIpIds"],
        "differentAuthoredGeometry": digest(a["world"]["entities"]) != digest(b["world"]["entities"]),
        "differentMissionActions": [s["type"] for s in a["mission"]["stages"]] != [s["type"] for s in b["mission"]["stages"]],
        "differentMechanics": a["mechanics"] != b["mechanics"],
        "differentArtDirection": a["artDirection"] != b["artDirection"],
        "sourceSessionUnchanged": digest(store.snapshot(ctx, args.source_session)) == source_hash,
    }
    report["status"] = "GENERATION_VERIFIED_GAMEPLAY_PENDING" if all(report["comparison"].values()) else "FAIL"
    save()
    print(json.dumps(report["comparison"], indent=2), flush=True)


if __name__ == "__main__":
    main()
