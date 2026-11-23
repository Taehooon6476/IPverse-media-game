#!/usr/bin/env python3
"""Different prompts → different games, through the real agent, on one session (default: the demo session).

  python3 scripts/demo_variety.py [sessionId]

  1. a melee weapon (룬 대검) + its 3D
  2. 설원 생존 슈터 (survive, snow biome, the pistol)       — made while the sword's 3D runs
  3. 숲 탐험·수집 (collect/reach, forest biome, no combat)
  4. 디아블로풍 핵앤슬래시 (arpg, ruins biome, the sword)    — once the sword has its 3D
  5. a per-character battle trailer (make_action_shot with opponents) cut with intertitles
Prints each game's style, biome, mission and IPs; the report goes to build/demo-variety.json.
"""
import json
import pathlib
import sys
import time
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from smoke import api_call, cognito_login, get_secret  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
REPORT = ROOT / "build" / "demo-variety.json"
report = {"games": [], "steps": []}


def log(step, **kw):
    report["steps"].append({"step": step, **kw})
    print(step, json.dumps(kw, ensure_ascii=False)[:600], flush=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=1))


def main():
    sid = next((a for a in sys.argv[1:] if a.startswith("ses_")), "ses_f0b01b0d50")
    secret = get_secret()
    base = secret["cloudfrontUrl"].rstrip("/")
    tok = {"t": cognito_login(secret["cloudfrontUrl"], secret["username"], secret["password"]), "at": time.time()}

    def call(m, p, b=None):
        if time.time() - tok["at"] > 2400:
            tok.update(t=cognito_login(secret["cloudfrontUrl"], secret["username"], secret["password"]), at=time.time())
        for attempt in range(4):  # a session poll also advances jobs and can be slow; retry reads, never a POST twice
            try:
                return api_call(base, m, p, tok["t"], b)
            except (TimeoutError, OSError):
                if m != "GET" or attempt == 3:
                    raise
                time.sleep(5)

    snap = lambda: call("GET", f"/api/sessions/{sid}")  # noqa: E731

    def turn(text, design=None, timeout=900):
        call("POST", f"/api/sessions/{sid}/chat", {"text": text, **({"gameDesign": design} if design else {})})
        t0 = time.time()
        while time.time() - t0 < timeout:
            s = snap()
            last = s["messages"][-1]
            if last["role"] == "assistant" and last["status"] != "pending":
                return s, last
            time.sleep(10)
        return snap(), {"status": "timeout", "text": "", "toolEvents": []}

    def game_report(label, before, s):
        new = [g for g in s["games"] if g["gameId"] not in before]
        if not new:
            log(f"{label}: no game", reply=s["messages"][-1].get("text", "")[:400])
            return None
        g = new[-1]
        spec = json.loads(urllib.request.urlopen(f"{base}/{g['specKey'].lstrip('/')}", timeout=30).read())
        names = {i["ipId"]: i["name"] for i in s["ips"]}
        info = {"label": label, "gameId": g["gameId"], "title": g["title"], "url": g["previewUrl"],
                "style": (spec.get("mechanics") or {}).get("style", "action"), "biome": (spec.get("artDirection") or {}).get("biome"),
                "genre": spec.get("genre"), "world": f"{spec['world']['width']}x{spec['world']['depth']}" if spec.get("world") else None,
                "stages": [f"{st['type']}:{st['label']}" for st in (spec.get("mission") or {}).get("stages", [])],
                "player": names.get(spec["player"].get("ipId")), "weapon": names.get(spec["player"].get("weaponIpId")),
                "enemies": [names.get(e.get("ipId")) for e in spec.get("enemies", [])],
                "enemySpawns": len((spec.get("world") or {}).get("enemySpawns", [])),
                "setPieces": [e.get("ipId") for e in (spec.get("world") or {}).get("entities", []) if e.get("kind") == "model"]}
        report["games"].append(info)
        log(f"{label}: game", **info)
        return info

    only = sys.argv[sys.argv.index("--only") + 1].split(",") if "--only" in sys.argv else None  # e.g. --only arpg
    want = lambda step: only is None or step in only  # noqa: E731
    s = snap()
    hero = next(i for i in s["ips"] if i["kind"] == "character")
    gun = next((i for i in s["ips"] if i["kind"] == "weapon" and i.get("weaponType") != "melee"), None)
    enemies = [i for i in s["ips"] if i["kind"] == "enemy"]

    # 1. a sword (and its 3D) for the hack-and-slash game
    sword = next((i for i in s["ips"] if i["kind"] == "weapon" and i.get("weaponType") == "melee"), None)
    if not sword and want("sword"):
        s, msg = turn("근접 무기 '룬 대검'을 만들어줘. 푸른 룬이 새겨진 검은 강철 대검이야. 만든 뒤 3D로도 만들어줘.")
        sword = next((i for i in s["ips"] if i["kind"] == "weapon" and i.get("weaponType") == "melee"), None)
        log("sword", status=msg["status"], ipId=sword and sword["ipId"], tools=[e["summary"] for e in msg.get("toolEvents", [])])

    def design(prompt, cast):
        roles = {"castIpIds": [i["ipId"] for i in cast], "playerIpId": hero["ipId"],
                 "weaponIpId": next((i["ipId"] for i in cast if i["kind"] == "weapon"), None),
                 "propIpIds": [], "enemyIpIds": [i["ipId"] for i in cast if i["kind"] == "enemy"], "npcIpIds": []}
        return {"prompt": prompt, **roles}

    # 2. snow survival shooter
    if want("snow"):
        prompt = ("[게임 설계] 이 설계대로 3D 게임을 만들어줘.\n게임 요청: 눈보라 치는 극지 기지에서 밀려오는 기계 군단을 권총으로 버티는 생존 슈터. "
              "엄폐물 뒤에서 싸우고, 시간이 갈수록 적이 늘어난다.\n유형: 생존전 [survive]\n실사 환경: 설원·빙하 [snow]\n난이도: 어려움 [hard]")
        before = {g["gameId"] for g in s["games"]}
        s, msg = turn(prompt, design(prompt, [hero, *([gun] if gun else []), *enemies]))
        game_report("설원 생존 슈터", before, s)

    # 3. forest exploration (no enemies)
    if want("forest"):
        prompt = ("[게임 설계] 이 설계대로 3D 게임을 만들어줘.\n게임 요청: 가을 숲속 고대 유적에서 흩어진 에너지 코어를 찾아 모으고 숲 깊은 곳의 제단까지 가는 평화로운 탐험 게임. "
              "전투 없이 점프와 탐색으로 진행한다.\n유형: 수집전 [collect]\n실사 환경: 숲·정글 [forest]\n난이도: 쉬움 [easy]")
        before = {g["gameId"] for g in s["games"]}
        s, msg = turn(prompt, design(prompt, [hero]))
        game_report("숲 탐험", before, s)

    # 4. wait for the sword's 3D, then the Diablo-like game
    t0 = time.time()
    while sword and time.time() - t0 < 3000:
        s = snap()
        sword = next(i for i in s["ips"] if i["ipId"] == sword["ipId"])
        if sword.get("glbAssetId"):
            break
        jobs = [j for j in s["jobs"] if j.get("input", {}).get("ipId") == sword["ipId"]]
        if jobs and all(j["status"] in ("done", "failed") for j in jobs) and not sword.get("glbAssetId"):
            break
        time.sleep(30)
    log("sword 3D", ready=bool(sword and sword.get("glbAssetId")))
    weapon = sword if sword and sword.get("glbAssetId") else gun
    if want("arpg"):
        prompt = ("[게임 설계] 이 설계대로 3D 게임을 만들어줘.\n게임 요청: 디아블로 같은 핵앤슬래시. 폐허가 된 성채에서 칼로 몰려오는 언데드 기계 무리를 베며 레벨업하고, "
              "아이템을 줍고 장비를 바꾸며 마지막에 거대 보스를 쓰러뜨린다.\n유형: 핵앤슬래시 (디아블로풍) [arpg]\n실사 환경: 폐허·전쟁터 [ruins]\n난이도: 보통 [normal]")
        before = {g["gameId"] for g in s["games"]}
        s, msg = turn(prompt, design(prompt, [hero, *([weapon] if weapon else []), *enemies]))
        game_report("디아블로풍 핵앤슬래시", before, s)

    # 5. battle trailer
    if not want("trailer"):
        return
    s, msg = turn(f"[트레일러 연출] 전체 길이 약 25초, 영상 모델 LTX-2.5. 캐릭터별 전쟁씬 트레일러: {hero['name']}가 "
                  f"{', '.join(e['name'] for e in enemies)}와 각각 맞붙는 전투 장면, 폐허가 된 성채에서. 샷 사이에 짧은 자막으로 이야기를 잇고 마지막은 결전.")
    log("battle trailer", status=msg["status"], reply=msg.get("text", "")[:500], tools=[e["summary"] for e in msg.get("toolEvents", [])])


if __name__ == "__main__":
    main()
