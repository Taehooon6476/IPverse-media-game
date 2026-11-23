#!/usr/bin/env python3
"""End-to-end check of the deployed platform through its public API, both panes, one fresh session.

  python3 scripts/e2e.py            # ~25-40 min (GPU images, Hunyuan3D, Deadline rig/turntable, LTX shot)

Each step is a pass/fail line; the report also goes to build/e2e-report.json. Steps:
  login → session → concept+character+gun (agent) → re-roll + restore (UI tools) → 3D chains (direct tool)
  → LTX shot → trailer → rig/turntable done → game (agent) with rigged player + weapon → publish with the
  trailer as pre-roll (+ ad every N rounds) → published page, release.json → retry endpoint guard.
"""
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from smoke import api_call, cognito_login, get_secret  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
REPORT = ROOT / "build" / "e2e-report.json"
steps = []


def check(name, ok, detail=""):
    steps.append({"step": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)
    REPORT.write_text(json.dumps(steps, ensure_ascii=False, indent=1))
    return ok


def http_ok(url):
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return r.status == 200
    except urllib.error.URLError:
        return False


def main():
    secret = get_secret()
    base = secret["cloudfrontUrl"].rstrip("/")
    token = cognito_login(secret["cloudfrontUrl"], secret["username"], secret["password"])
    check("login", token)

    def call(method, path, body=None):
        nonlocal token
        try:
            return api_call(base, method, path, token, body)
        except urllib.error.HTTPError as e:
            if e.code == 401:  # the access token is 1 h; this run can be longer
                token = cognito_login(secret["cloudfrontUrl"], secret["username"], secret["password"])
                return api_call(base, method, path, token, body)
            raise

    sid = call("POST", "/api/sessions", {"title": "E2E 자동 점검", "genre": "sf-shooter"})["session"]["sessionId"]
    check("session", sid, sid)
    snap = lambda: call("GET", f"/api/sessions/{sid}")  # noqa: E731

    def turn(text, timeout=900):
        call("POST", f"/api/sessions/{sid}/chat", {"text": text})
        t0 = time.time()
        while time.time() - t0 < timeout:
            s = snap()
            last = s["messages"][-1]
            if last["role"] == "assistant" and last["status"] != "pending":
                return s, last
            time.sleep(10)
        return snap(), {"status": "timeout", "text": ""}

    def wait_jobs(ids, timeout=3600):
        t0 = time.time()
        while time.time() - t0 < timeout:
            jobs = {j["jobId"]: j for j in snap()["jobs"]}
            if all(jobs.get(i, {}).get("status") in ("done", "failed") for i in ids):
                return jobs
            time.sleep(20)
        return {j["jobId"]: j for j in snap()["jobs"]}

    s, msg = turn("SF 컨셉을 잡고 주인공 캐릭터 '테오'(정찰 기사)와 그의 무기 플라즈마 권총(총)을 만들어줘")
    hero = next((i for i in s["ips"] if i["kind"] == "character"), None)
    gun = next((i for i in s["ips"] if i["kind"] == "weapon"), None)
    assets = {a["assetId"]: a for a in s["assets"]}
    check("agent: concept + character + weapon", s["session"].get("concept") and hero and gun, msg["status"])
    if not (hero and gun):
        return
    check("images reachable (image + cutout)", all(http_ok(assets[i[k]]["url"]) for i in (hero, gun)
                                                   for k in ("imageAssetId", "cutoutAssetId")))

    # UI tools: re-roll (background) then restore v1
    call("POST", f"/api/sessions/{sid}/tools/reroll_ip_image/async", {"ipId": hero["ipId"]})
    t0 = time.time()
    while time.time() - t0 < 400 and snap()["messages"][-1]["status"] == "pending":
        time.sleep(8)
    h2 = next(i for i in snap()["ips"] if i["ipId"] == hero["ipId"])
    check("re-roll makes v2", h2["version"] == 2, f"v{h2['version']}")
    call("POST", f"/api/sessions/{sid}/tools/restore_ip_version", {"ipId": hero["ipId"], "imageAssetId": hero["imageAssetId"]})
    h1 = next(i for i in snap()["ips"] if i["ipId"] == hero["ipId"])
    check("restore goes back to v1", h1["imageAssetId"] == hero["imageAssetId"] and h1["version"] == 1)

    # left pane: 3D chains (direct tool route, like the card button), one LTX shot, a trailer
    r3d = call("POST", f"/api/sessions/{sid}/tools/render_3d", {"ipId": hero["ipId"]})["result"]
    g3d = call("POST", f"/api/sessions/{sid}/tools/render_3d", {"ipId": gun["ipId"]})["result"]
    check("3D chains registered", r3d.get("rigJobId") and r3d.get("poseJobId") and g3d.get("meshJobId") and "rigJobId" not in g3d)
    shot = call("POST", f"/api/sessions/{sid}/tools/make_video_shot",
                {"ipId": hero["ipId"], "prompt": "the scout knight walks forward through neon rain, slow push in",
                 "aspect_ratio": "16:9", "duration": 5})["result"]["jobId"]
    trailer = call("POST", f"/api/sessions/{sid}/tools/cut_trailer",
                   {"shot_job_ids": [shot], "title": "테오", "subtitle": "E2E", "make_shorts": True})["result"]["jobId"]
    jobs = wait_jobs([shot, trailer])
    check("LTX shot done", jobs[shot]["status"] == "done", jobs[shot].get("error") or "")
    check("trailer + shorts done", jobs[trailer]["status"] == "done" and len(jobs[trailer]["outputs"]) == 2,
          jobs[trailer].get("error") or "")
    chain = [r3d["poseJobId"], r3d["meshJobId"], r3d["jobId"], r3d["rigJobId"], g3d["meshJobId"], g3d["jobId"]]
    jobs = wait_jobs(chain)
    for jid in chain:
        check(f"job {jobs[jid]['kind']} ({'hero' if jid in r3d.values() else 'gun'})", jobs[jid]["status"] == "done",
              jobs[jid].get("error") or "")
    s = snap()
    hero = next(i for i in s["ips"] if i["ipId"] == hero["ipId"])
    check("hero has rigged GLB + turntable", hero.get("riggedGlbAssetId") and hero.get("turntableAssetId"))

    # right pane: game with the rigged hero holding the gun
    s, msg = turn("이 캐릭터가 이 무기를 들고 싸우는 3D SF 슈터 게임을 만들어줘")
    game = s["games"][-1] if s["games"] else None
    check("agent: game made", game, msg["status"])
    if not game:
        return
    spec = json.loads(urllib.request.urlopen(f"{base}/{game['specKey'].lstrip('/')}", timeout=30).read())
    player = spec.get("player", {})
    check("game spec: rigged player + weapon + anim clips",
          str(player.get("modelUrl", "")).endswith(".rig.glb") and player.get("weaponUrl") and spec.get("animUrl"),
          f"{player.get('modelUrl')} {player.get('weaponUrl')}")
    for key in ("modelUrl", "weaponUrl"):
        check(f"game asset reachable: {key}", http_ok(f"{base}/games/{game['gameId']}/{player[key]}"))

    ad = next(a for a in snap()["assets"] if a["kind"] == "trailer")
    pub = call("POST", f"/api/sessions/{sid}/publish", {"gameId": game["gameId"], "adAssetId": ad["assetId"],
                                                       "skipAfterSec": 3, "adEveryRounds": 2})
    check("publish", pub.get("publishedUrl"), pub.get("publishedUrl", ""))
    release = json.loads(urllib.request.urlopen(f"{base}/games/{game['gameId']}/release.json", timeout=30).read())
    check("release.json: pre-roll trailer + every 2 rounds",
          (release.get("ad") or {}).get("videoUrl") and (release.get("ad") or {}).get("everyRounds") == 2, json.dumps(release)[:200])
    check("published page reachable", http_ok(pub["publishedUrl"]))

    try:
        call("POST", f"/api/sessions/{sid}/jobs/{shot}/retry", {})
        check("retry refuses a done job", False)
    except urllib.error.HTTPError as e:
        check("retry refuses a done job", e.code == 400)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — a crash is a failed step, not a silent stop
        check(f"crashed: {type(e).__name__}", False, (getattr(e, "read", lambda: b"")().decode(errors="replace") or str(e))[:300])
    finally:
        failed = [s for s in steps if not s["ok"]]
        print(f"\n{len(steps) - len(failed)}/{len(steps)} passed" + (f"; failed: {[s['step'] for s in failed]}" if failed else ""))
        sys.exit(1 if failed else 0)
