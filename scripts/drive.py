#!/usr/bin/env python3
"""Drive the deployed IPverse API by hand (integration checks).

  python3 scripts/drive.py snapshot SESSION_ID
  python3 scripts/drive.py tool SESSION_ID TOOL '{"json": "args"}'
  python3 scripts/drive.py wait SESSION_ID JOB_ID [TIMEOUT_SECONDS]
  python3 scripts/drive.py chat SESSION_ID "message"

Uses the demo credentials in Secrets Manager (same as smoke.py).
"""
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from smoke import api_call, cognito_login, get_secret  # noqa: E402


def login():
    secret = get_secret()
    base = secret["cloudfrontUrl"].rstrip("/")
    token = cognito_login(secret["cloudfrontUrl"], secret["username"], secret["password"])
    return base, token


def print_snapshot(snap: dict) -> None:
    print("session:", json.dumps({k: snap["session"].get(k) for k in ("sessionId", "title", "genre", "concept")}, ensure_ascii=False))
    for ip in snap.get("ips", []):
        print("ip:", ip["ipId"], ip["kind"], ip["name"], "image=", ip.get("imageAssetId"), "cutout=", ip.get("cutoutAssetId"),
              "glb=", ip.get("glbAssetId"), "turntable=", ip.get("turntableAssetId"))
    for a in snap.get("assets", []):
        print("asset:", a["assetId"], a["kind"], a.get("url"))
    for j in snap.get("jobs", []):
        print("job:", j["jobId"], j["kind"], j["status"], j.get("progress", ""), j.get("error", ""), "outputs=", j.get("outputs"))
    for g in snap.get("games", []):
        print("game:", g["gameId"], g.get("previewUrl"), g.get("publishedUrl"), "ad=", g.get("adAssetId"))
    msgs = snap.get("messages", [])
    if msgs:
        last = msgs[-1]
        print("last message:", last.get("role"), last.get("status"), (last.get("text") or "")[:300])


def main(argv: list) -> int:
    cmd = argv[1]
    sid = argv[2]
    base, token = login()
    if cmd == "list":
        print(json.dumps(api_call(base, "GET", "/api/sessions", token), ensure_ascii=False, indent=1))
    elif cmd == "snapshot":
        print_snapshot(api_call(base, "GET", f"/api/sessions/{sid}", token))
    elif cmd == "tool":
        tool, args = argv[3], json.loads(argv[4])
        print(json.dumps(api_call(base, "POST", f"/api/sessions/{sid}/tools/{tool}", token, args), ensure_ascii=False))
    elif cmd == "chat":
        print(json.dumps(api_call(base, "POST", f"/api/sessions/{sid}/chat", token, {"text": argv[3]}), ensure_ascii=False))
    elif cmd == "wait":
        job_id = argv[3]
        deadline = time.time() + (int(argv[4]) if len(argv) > 4 else 1800)
        last = None
        while time.time() < deadline:
            snap = api_call(base, "GET", f"/api/sessions/{sid}", token)
            job = next((j for j in snap.get("jobs", []) if j["jobId"] == job_id), None)
            if job is None:
                print("no such job"); return 1
            state = (job["status"], job.get("progress", ""))
            if state != last:
                print(time.strftime("%H:%M:%S"), job["status"], job.get("progress", ""), job.get("error", ""))
                last = state
            if job["status"] in ("done", "failed"):
                print("outputs:", job.get("outputs"))
                for a in snap.get("assets", []):
                    if a.get("jobId") == job_id:
                        print("asset:", a["assetId"], a["kind"], a.get("url"))
                return 0 if job["status"] == "done" else 1
            time.sleep(15)
        print("timeout"); return 1
    else:
        print(__doc__); return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
