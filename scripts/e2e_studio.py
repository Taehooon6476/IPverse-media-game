#!/usr/bin/env python3
"""End-to-end check of the studio features on a session that already has IPs with 3D (default: the demo session):

  python3 scripts/e2e_studio.py [sessionId]      # ~10 min (agent turns, no GPU work)

  connections listing · job stop guard · sign-up validation · live highlight guard (not on air) ·
  출연 IP: a game with 3 of the session's IPs has exactly those · two design briefs give different games ·
  a revision (게임 수정) keeps the base game's cast and links to it.
Each step is a pass/fail line; the report also goes to build/e2e-studio-report.json.
"""
import hashlib
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from smoke import api_call, cognito_login, get_secret  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
REPORT = ROOT / "build" / "e2e-studio-report.json"
steps = []


def check(name, ok, detail=""):
    steps.append({"step": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)
    REPORT.write_text(json.dumps(steps, ensure_ascii=False, indent=1))
    return ok


def used_ips(spec):
    ids = set()
    for e in [spec.get("player") or {}] + list(spec.get("enemies") or []) + list(spec.get("props") or []):
        ids.add(e.get("ipId"))
        if e.get("weaponIpId"):
            ids.add(e["weaponIpId"])
    return ids


def main():
    sid = sys.argv[1] if len(sys.argv) > 1 else "ses_f0b01b0d50"
    secret = get_secret()
    base = secret["cloudfrontUrl"].rstrip("/")
    token = cognito_login(secret["cloudfrontUrl"], secret["username"], secret["password"])
    call = lambda m, p, b=None: api_call(base, m, p, token, b)  # noqa: E731
    snap = lambda: call("GET", f"/api/sessions/{sid}")  # noqa: E731

    def status_of(method, path, body=None):
        try:
            call(method, path, body)
            return 200
        except urllib.error.HTTPError as e:
            return e.code

    def turn(text, timeout=600):
        call("POST", f"/api/sessions/{sid}/chat", {"text": text})
        t0 = time.time()
        while time.time() - t0 < timeout:
            s = snap()
            last = s["messages"][-1]
            if last["role"] == "assistant" and last["status"] != "pending":
                return s, last
            time.sleep(8)
        return snap(), {"status": "timeout", "text": ""}

    def spec_of(game):
        return json.loads(urllib.request.urlopen(f"{base}/{game['specKey'].lstrip('/')}", timeout=30).read())

    # settings and guards
    conns = call("GET", "/api/connections")
    # a platform row is its plain name and its state: no address, farm id, model id or tool list
    gen = [c for c in conns["platform"] if c["id"] in ("imagegen", "videogen")]
    check("connections: the image and video services answer their check", len(gen) == 2 and all(c["status"] == "connected" for c in gen),
          ", ".join(f"{c['name']} {c['status']}" for c in gen))
    told = json.dumps(conns["platform"], ensure_ascii=False)
    check("connections: platform rows carry no backend address",
          all(set(c) <= {"id", "name", "status", "error", "models"} for c in conns["platform"])
          and not any(word in told for word in ("execute-api", "https://", "farm-", "live-video.net", "toolDefs")))
    s = snap()
    done = next((j for j in s["jobs"] if j["status"] == "done"), None)
    if done:
        check("job stop refuses a finished job", status_of("POST", f"/api/sessions/{sid}/jobs/{done['jobId']}/cancel", {}) == 400)
    body = json.dumps({"username": "x", "password": "short"})
    req = urllib.request.Request(f"{base}/api/signup", data=body.encode(), method="POST", headers={
        "content-type": "application/json", "x-amz-content-sha256": hashlib.sha256(body.encode()).hexdigest()})
    try:
        urllib.request.urlopen(req, timeout=30)
        code = 200
    except urllib.error.HTTPError as e:
        code = e.code
    check("sign-up validates input (no account made)", code == 400, str(code))
    check("highlight upload refused when not on air", status_of("POST", f"/api/sessions/{sid}/live/highlights",
                                                                {"round": 1, "seconds": 10, "contentType": "video/mp4"}) == 409)

    # 출연 IP: pick 3 of the session's IPs
    ips = s["ips"]
    hero = next(i for i in ips if i["kind"] == "character")
    weapon = next((i for i in ips if i["kind"] == "weapon"), None)
    enemies = [i for i in ips if i["kind"] == "enemy"]
    cast = [hero] + ([weapon] if weapon else []) + enemies[:1]
    left_out = [i for i in ips if i not in cast]
    check("session has IPs left out of the cast", len(cast) >= 2 and left_out, f"cast {[i['name'] for i in cast]}, out {[i['name'] for i in left_out]}")
    line = f"[출연 IP cast_ip_ids={','.join(i['ipId'] for i in cast)}] " + ", ".join(i["name"] for i in cast)
    before = {g["gameId"] for g in s["games"]}
    s, msg = turn("[게임 설계] 이 설계대로 3D 게임을 만들어줘.\n유형: 섬멸전 (적 N명 처치) [kills]\n환경: 정글 유적 [jungle-ruins], 하늘 노을 [dusk], 배치 원형 성벽 [ring]\n"
                  "미션: 유적에 몰려든 적 20마리를 쓰러뜨려라\n난이도: 보통 [normal]\n" + line + "\n게임에는 위 출연 IP만 나와야 해 (다른 IP나 이름 없는 적·소품 없이).")
    new = [g for g in s["games"] if g["gameId"] not in before]
    check("agent: cast game made", new, msg["status"] + " " + msg.get("text", "")[:120])
    if not new:
        return
    g1 = new[-1]
    sp1 = spec_of(g1)
    used = used_ips(sp1)
    check("cast game: only the picked IPs", used == {i["ipId"] for i in cast}, f"used {sorted(x or 'none' for x in used)}")
    check("cast game: recorded castIpIds", sorted(g1.get("castIpIds") or []) == sorted(i["ipId"] for i in cast))
    check("cast game: brief's world", (sp1.get("environment") or {}).get("theme") == "jungle-ruins"
          and sp1.get("objective", {}).get("type") == "kills", json.dumps(sp1.get("environment")))

    # a different brief: different game style
    before = {g["gameId"] for g in s["games"]}
    s, msg = turn("[게임 설계] 이 설계대로 3D 게임을 만들어줘.\n유형: 생존전 (N초 버티기, 갈수록 적이 늘어남) [survive]\n"
                  "환경: 폐허 도시 [ruined-city], 하늘 폭풍 [storm], 배치 미로 [maze]\n미션: 폭풍이 그칠 때까지 3분 버텨라\n"
                  "클리어 조건: 180초 생존\n난이도: 어려움 [hard]\n추가 규칙: 플레이어 체력 150, 적 출현 속도 1.5배")
    new = [g for g in s["games"] if g["gameId"] not in before]
    check("agent: second style game made", new, msg["status"])
    if new:
        sp2 = spec_of(new[-1])
        env1, env2 = sp1.get("environment") or {}, sp2.get("environment") or {}
        check("second game differs (objective, theme, sky, layout, rules)",
              sp2["objective"]["type"] == "survive" and env2.get("theme") == "ruined-city" and env2.get("sky") == "storm"
              and env2.get("layout") == "maze" and env1.get("theme") != env2.get("theme")
              and (sp2.get("rules") or {}).get("playerHp") == 150,
              f"{sp2['objective']} {env2} {sp2.get('rules')}")

    # revision keeps the cast
    before = {g["gameId"] for g in snap()["games"]}
    s, msg = turn(f"[게임 수정 gameId={g1['gameId']}] '{g1['title']}'을(를) 이렇게 고친 새 버전을 만들어줘. 나머지는 그대로 둬.\n제한 시간을 2분으로 해줘")
    new = [g for g in s["games"] if g["gameId"] not in before]
    check("agent: revision made", new, msg["status"])
    if new:
        rev = new[-1]
        sp3 = spec_of(rev)
        check("revision links to its base and keeps the cast", rev.get("baseGameId") == g1["gameId"]
              and used_ips(sp3) == used and sorted(rev.get("castIpIds") or []) == sorted(i["ipId"] for i in cast),
              f"base {rev.get('baseGameId')} cast {rev.get('castIpIds')}")
        check("revision changed the time limit only", (sp3.get("rules") or {}).get("timeLimitSec") == 120
              and (sp3.get("environment") or {}).get("theme") == "jungle-ruins", json.dumps(sp3.get("rules")))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — a crash is a failed step, not a silent stop
        check(f"crashed: {type(e).__name__}", False, (getattr(e, "read", lambda: b"")().decode(errors="replace") or str(e))[:300])
    finally:
        failed = [s for s in steps if not s["ok"]]
        print(f"\n{len(steps) - len(failed)}/{len(steps)} passed" + (f"; failed: {[s['step'] for s in failed]}" if failed else ""))
        sys.exit(1 if failed else 0)
