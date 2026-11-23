"""GPU trial agent: runs ON the trial box (server/agents.py ships it gzip+base64 in user-data). Not imported by the API.

Claude (Bedrock Converse) gets a root shell on a fresh g6e box and installs one open-weight image or video model
from Hugging Face as ``/opt/mg/model_custom.py``, a module for the ``jobserver.make_app()`` every mediagen box runs.
On ``finish`` the harness starts the job server on that module, renders every benchmark prompt through
``POST /jobs`` and checks each output. Progress goes to ``s3://<bucket>/<prefix>status.json``, the outcome to
``result.json``, outputs under ``outputs/trials/<id>/`` behind the mediagen CDN.

A passing box is made keepable before exit (``mg.service`` installed, the HF token wiped, ``/opt/mg/promote``
touched) so the sweeper can park it until the user approves; any other box terminates itself.

Stdlib + boto3 only. The HF token is redacted from every tool output before the model or the log sees it.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import signal
import stat
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

import boto3
from botocore.config import Config

CFG = json.loads(Path("/opt/trial/env.json").read_text()) if __name__ == "__main__" else {}
TID = CFG.get("trialId", "")
KIND = CFG.get("kind", "image")
MODES = {"image": ("t2i", "i2i"), "video": ("t2v", "i2v")}[KIND]
DEADLINE = time.time() + CFG.get("maxHours", 2) * 3600 - 15 * 60
TOKEN_FILE = Path("/root/.cache/huggingface/token")
SECRET = TOKEN_FILE.read_text().strip() if TOKEN_FILE.exists() else ""
OUT_DIR = Path("/opt/trial/out")
MG_DIR = Path("/opt/mg")
SERVER_LOG = Path("/opt/trial/server.log")
MAX_TURNS = 150
KEEP_RECENT = 24
MAX_VERIFY = 3
_failed = 0
s3 = boto3.client("s3", region_name=CFG.get("region", "us-east-1"))
bedrock = boto3.client("bedrock-runtime", region_name=CFG.get("region", "us-east-1"),
                       config=Config(read_timeout=300, retries={"mode": "adaptive", "max_attempts": 10}))

HARDWARE = {
    "g6e.2xlarge": "1x NVIDIA L40S (48 GB VRAM), 8 vCPU, 64 GB RAM",
    "g6e.4xlarge": "1x NVIDIA L40S (48 GB VRAM), 16 vCPU, 128 GB RAM",
    "g6e.8xlarge": "1x NVIDIA L40S (48 GB VRAM), 32 vCPU, 256 GB RAM",
    "g6e.16xlarge": "1x NVIDIA L40S (48 GB VRAM), 64 vCPU, 512 GB RAM",
    "g6e.12xlarge": "4x NVIDIA L40S (48 GB VRAM each), 48 vCPU, 384 GB RAM",
}


def redact(text: str) -> str:
    if SECRET:
        text = text.replace(SECRET, "[HF_TOKEN]")
    return re.sub(r"hf_[A-Za-z0-9]{30,}", "[HF_TOKEN]", text)


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {redact(msg)}", flush=True)


def put_json(name: str, obj: dict) -> None:
    s3.put_object(Bucket=CFG["bucket"], Key=f"{CFG['prefix']}{name}", ContentType="application/json",
                  Body=json.dumps(obj, ensure_ascii=False).encode())


def report(phase: str, message: str = "") -> dict:
    put_json("status.json", {"phase": phase[:200], "message": redact(message)[:1000], "at": time.time()})
    log(f"phase: {phase} {message}")
    return {"ok": True}


def bash(command: str, timeout_s: int = 900) -> dict:
    timeout_s = max(10, min(int(timeout_s), 1800, int(DEADLINE - time.time())))
    log(f"$ {command[:500]}")
    try:
        p = subprocess.run(["bash", "-lc", command], capture_output=True, text=True, errors="replace",
                           timeout=timeout_s, cwd="/opt/trial")
        out, code = p.stdout + p.stderr, p.returncode
    except subprocess.TimeoutExpired as e:
        out = (e.stdout.decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")) + \
            f"\n[timed out after {timeout_s}s -- run long jobs with nohup ... & and poll their log]"
        code = -1
    out = redact(out)
    log(f"exit {code}: {out[-800:]}")
    return {"exit_code": code, "output": out[-6000:], "truncated": len(out) > 6000}


def write_file(path: str, content: str) -> dict:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    log(f"wrote {path} ({len(content)} chars)")
    return {"ok": True, "path": path}


# finish(): serve the module through the real job server and render the benchmark with it

def _http(method: str, path: str, key: str = "", body: dict | None = None) -> dict:
    req = urllib.request.Request(f"http://127.0.0.1:8000{path}", method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "X-Api-Key": key})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path}: HTTP {e.code} {e.read().decode('utf-8', 'replace')[:500]}") from None


def _server_tail(n: int = 3000) -> str:
    try:
        return redact(SERVER_LOG.read_text(errors="replace")[-n:])
    except OSError:
        return ""


def _duration(path: Path):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                              str(path)], capture_output=True, text=True, timeout=30).stdout.strip()
        return round(float(out), 2)
    except Exception:  # noqa: BLE001
        return None


def _fetch(url: str, dst: Path):
    """Download one output from the CDN and check it is what it claims: a PNG, or an mp4 (→ its seconds)."""
    with urllib.request.urlopen(url, timeout=300) as r, open(dst, "wb") as f:
        shutil.copyfileobj(r, f)
    head = dst.read_bytes()[:12]
    if KIND == "image":
        if not head.startswith(b"\x89PNG") or dst.stat().st_size < 5_000:
            raise RuntimeError(f"{url} is not a PNG ({dst.stat().st_size} bytes)")
        return None
    if dst.stat().st_size < 10_000 or head[4:8] != b"ftyp":
        raise RuntimeError(f"{url} is not an mp4 ({dst.stat().st_size} bytes)")
    return _duration(dst)


def _render(proc, key: str, kind: str, params: dict, label: str) -> dict:
    job = _http("POST", "/jobs", key, {"kind": kind, "params": params})["job_id"]
    until = min(time.time() + 30 * 60, DEADLINE)
    while time.time() < until:
        if proc.poll() is not None:
            raise RuntimeError(f"job server exited (code {proc.returncode}) during {label}")
        st = _http("GET", f"/jobs/{job}", key)
        if st["status"] == "SUCCEEDED":
            return st
        if st["status"] == "FAILED":
            raise RuntimeError(f"{label} failed in run(): {st.get('error')}")
        time.sleep(5 if KIND == "image" else 10)
    raise RuntimeError(f"{label} did not finish within 30 min")


def _params(item: dict, ref: str | None) -> dict:
    if KIND == "image":
        p = {"prompt": item["prompt"], "width": 1024, "height": 1024, "seed": 20261109}
        if item["mode"] == "i2i":
            p["image_urls"] = [ref]
        return p
    p = {"prompt": item["prompt"], "seconds": 5, "seed": 20261109}
    if item["mode"] == "i2v":
        p["image_url"] = ref
    return p


def _own_reference(first: Path) -> str:
    """No baseline picture yet: the candidate's own first output (a PNG, or the first frame of clip 1)."""
    if KIND == "image":
        png = first
    else:
        if not shutil.which("ffmpeg"):
            subprocess.run(["bash", "-c", "DEBIAN_FRONTEND=noninteractive apt-get update -q && apt-get install -y -q "
                            "ffmpeg"], capture_output=True, timeout=900)
        png = OUT_DIR / "ref.png"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(first), "-frames:v", "1", str(png)],
                       check=True, capture_output=True, timeout=120)
    key = f"outputs/trials/{TID}/reference.png"
    s3.upload_file(str(png), CFG["outBucket"], key, ExtraArgs={"ContentType": "image/png"})
    return f"https://{CFG['cdn']}/{key}"


def _verify(python: str) -> tuple:
    if not re.fullmatch(r"/[\w./+-]+", python) or not os.access(python, os.X_OK):
        raise RuntimeError(f"python must be the absolute path of an executable interpreter, got {python!r}")
    if not os.path.normpath(python).startswith(("/opt/", "/root/", "/usr/")):
        raise RuntimeError(f"python must live under /opt, /root or /usr (it has to survive a reboot), got {python!r}")
    for f in ("model_custom.py", "jobserver.py"):
        if not (MG_DIR / f).is_file():
            raise RuntimeError(f"/opt/mg/{f} is missing")
    deps = [python, "-c", "import fastapi, uvicorn, httpx, boto3, pydantic"]
    if subprocess.run(deps, capture_output=True).returncode != 0:
        report("verifying: installing job server dependencies", python)
        subprocess.run([python, "-m", "pip", "install", "-q", "fastapi", "uvicorn[standard]", "httpx", "boto3",
                        "pydantic"], capture_output=True, timeout=900)
        p = subprocess.run(deps, capture_output=True, text=True, errors="replace")
        if p.returncode != 0:
            raise RuntimeError(f"fastapi/uvicorn/httpx/boto3/pydantic do not import in {python}: {p.stderr[-800:]}")
    (MG_DIR / "serve.py").write_text("import jobserver, model_custom\napp = jobserver.make_app(model_custom)\n")
    gpu = subprocess.run(["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader"],
                         capture_output=True, text=True, timeout=60).stdout.split()
    for pid in [int(p) for p in gpu if p.isdigit() and int(p) != os.getpid()]:
        subprocess.run(["kill", "-9", str(pid)], capture_output=True)  # the model's own smoke tests hold VRAM
    time.sleep(5 if gpu else 0)
    key = secrets.token_hex(16)
    env = {**os.environ, "MG_MODEL": f"trials/{TID}", "MG_BUCKET": CFG["outBucket"], "MG_CDN": CFG["cdn"],
           "MG_API_KEY": key, "MG_IDLE_STOP_MIN": "0", "HF_HUB_OFFLINE": "1", "AWS_REGION": CFG["region"],
           "HOME": "/root", "HF_HOME": "/root/.cache/huggingface",
           "HF_TOKEN_PATH": "/nonexistent/token", "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1"}
    env.pop("HF_TOKEN", None)
    env.pop("HUGGING_FACE_HUB_TOKEN", None)
    with open(SERVER_LOG, "wb") as server_log:
        proc = subprocess.Popen([python, "-m", "uvicorn", "serve:app", "--host", "127.0.0.1", "--port", "8000"],
                                cwd=MG_DIR, env=env, stdout=server_log, stderr=subprocess.STDOUT,
                                start_new_session=True)
        try:
            return _benchmark(proc, key)
        finally:
            for sig, wait in ((signal.SIGTERM, 30), (signal.SIGKILL, 10)):
                try:
                    os.killpg(proc.pid, sig)
                    proc.wait(wait)
                    break
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    continue


def _benchmark(proc, key: str) -> tuple:
    report("verifying: loading the model in the job server", "HF_HUB_OFFLINE=1")
    t0, h = time.time(), {}
    while not h.get("ready"):
        if proc.poll() is not None:
            raise RuntimeError(f"job server exited with code {proc.returncode}")
        if time.time() > min(t0 + 40 * 60, DEADLINE):
            raise RuntimeError("load() did not finish within 40 min")
        time.sleep(10)
        try:
            h = _http("GET", "/health")
        except (OSError, ValueError, RuntimeError):
            continue
        if h.get("error"):
            raise RuntimeError(f"load() failed: {h['error']}")
    checks: dict = {"load_seconds": round(time.time() - t0)}
    first, second = MODES
    kinds = [k for k in h.get("kinds") or [] if k in MODES]
    if first not in kinds:
        raise RuntimeError(f"model_custom.KINDS must contain {first!r}, got {h.get('kinds')!r}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ext = ".png" if KIND == "image" else ".mp4"
    outputs, firsts = [], [b for b in CFG["bench"] if b["mode"] == first]
    for i, item in enumerate(firsts):
        report(f"verifying: rendering {first} prompt {i + 1}/{len(firsts)}", "through the job server")
        st = _render(proc, key, first, _params(item, None), f"{first} prompt {i + 1}")
        outputs.append({"mode": first, "prompt": item["prompt"], "url": st["url"],
                        "seconds": _fetch(st["url"], OUT_DIR / f"{first}-{i + 1}{ext}"),
                        "genSeconds": round((st.get("ms") or 0) / 1000, 1)})
    checks[first] = "verified"
    # the first kind passed, so this box may be kept: the second check and _keep_box must not race the hard stop
    subprocess.run(["bash", "-c", "shutdown -c; shutdown -h +60"], capture_output=True, timeout=60)
    if second in kinds:  # offered only if it renders here too
        kinds.remove(second)
        report(f"verifying: {second}", "reference image as the input")
        try:
            if DEADLINE - time.time() < 10 * 60:
                raise RuntimeError("no time left before the trial deadline")
            for i, item in enumerate(b for b in CFG["bench"] if b["mode"] == second):
                ref = item.get("referenceUrl") or _own_reference(OUT_DIR / f"{first}-1{ext}")
                st = _render(proc, key, second, _params(item, ref), f"{second} check")
                outputs.append({"mode": second, "prompt": item["prompt"], "url": st["url"], "referenceUrl": ref,
                                "seconds": _fetch(st["url"], OUT_DIR / f"{second}-{i + 1}{ext}"),
                                "genSeconds": round((st.get("ms") or 0) / 1000, 1)})
            kinds.append(second)
            checks[second] = "verified"
        except Exception as e:  # noqa: BLE001 — the first kind passed; the second is just not offered
            checks[second] = f"not verified: {redact(str(e))[:300]}"
    return outputs, kinds, checks


def _scrub_token() -> None:
    """The kept box keeps its disk: drop the token from whatever the model left behind (files under 2 MB)."""
    if not SECRET:
        return
    needle = SECRET.encode()
    for top in ("/root", "/home", "/opt", "/etc", "/tmp", "/var/tmp", "/var/log"):
        for d, _, files in os.walk(top):
            for name in files:
                p = Path(d, name)
                try:
                    st = p.lstat()
                    if not stat.S_ISREG(st.st_mode) or st.st_size > 2_000_000:
                        continue
                    data = p.read_bytes()
                    if needle in data:
                        p.write_bytes(data.replace(needle, b"[HF_TOKEN]"))
                        log(f"scrubbed the HF token from {p}")
                except OSError:
                    continue


def _keep_box(python: str) -> None:
    """Install the job server as mg.service and wipe the HF token, so the sweeper can park this box."""
    Path("/etc/systemd/system/mg.service").write_text(f"""[Unit]
Description=mediagen job server ({CFG['slug']}, added by the IPverse open-model scout)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=3600
StartLimitBurst=5
StartLimitAction=poweroff
[Service]
WorkingDirectory=/opt/mg
Environment=MG_MODEL={CFG['slug']} MG_BUCKET={CFG['outBucket']} MG_CDN={CFG['cdn']} AWS_REGION={CFG['region']}
Environment=MG_IDLE_STOP_MIN=20 HF_HUB_OFFLINE=1 HOME=/root HF_HOME=/root/.cache/huggingface
ExecStart={python} -m uvicorn serve:app --host 0.0.0.0 --port 8000
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
""")
    subprocess.run(["bash", "-c", "systemctl daemon-reload && systemctl enable mg"], check=True, capture_output=True,
                   timeout=120)
    for f in (TOKEN_FILE, TOKEN_FILE.parent / "stored_tokens", Path("/root/.huggingface/token")):
        f.unlink(missing_ok=True)
    _scrub_token()
    subprocess.run(["sync"], timeout=300)
    (MG_DIR / "promote").touch()


def finish(python: str, notes: str = "", metrics: dict | None = None) -> dict:
    global _failed
    try:
        outputs, kinds, checks = _verify(python)
    except Exception as e:  # noqa: BLE001 — handed back to the model, which can fix it and call finish again
        _failed += 1
        err, tail = redact(str(e) or repr(e))[:1500], _server_tail()
        log(f"verification {_failed}/{MAX_VERIFY} failed: {err}")
        if _failed >= MAX_VERIFY:
            give_up(f"verification failed {MAX_VERIFY} times; last: {err}\n\n{tail[-1500:]}", notes)
            return {"error": err, "done": True}
        return {"error": f"verification {_failed}/{MAX_VERIFY} failed: {err}", "server_log_tail": tail,
                "next": "fix model_custom.py or its environment, then call finish again"}
    report("keeping the box for approval", f"verified kinds: {', '.join(kinds)}")
    extra = {k: v for k, v in metrics.items() if k not in MODES} if isinstance(metrics, dict) else {}
    result = {"status": "succeeded", "outputs": outputs, "notes": redact(notes)[:4000], "error": "",
              "metrics": {**extra, **checks}, "kinds": kinds, "python": python}
    try:
        _keep_box(python)
        result["promotable"] = True
    except Exception as e:  # noqa: BLE001 — the benchmark still stands; the box just terminates
        result.update(promotable=False, promoteError=redact(str(e))[:500])
    put_json("result.json", result)
    log(f"finished: succeeded, promotable={result['promotable']}")
    return {"ok": True, "done": True}


def give_up(error: str, notes: str = "") -> dict:
    put_json("result.json", {"status": "failed", "outputs": [], "metrics": {}, "notes": redact(notes)[:4000],
                             "error": redact(error)[:2000]})
    log("finished: failed")
    return {"ok": True, "done": True}


TOOLS = {"bash": bash, "write_file": write_file, "report": report, "finish": finish, "give_up": give_up}

SPECS = [
    {"toolSpec": {"name": "bash", "description": "Run a bash command as root (cwd /opt/trial). Output is the last 6000 "
                  "characters. Max 30 min per call: start long downloads/inference with nohup ... > log 2>&1 & and poll.",
                  "inputSchema": {"json": {"type": "object", "properties": {
                      "command": {"type": "string"}, "timeout_s": {"type": "integer"}}, "required": ["command"]}}}},
    {"toolSpec": {"name": "write_file", "description": "Write a text file (scripts, configs, the model module).",
                  "inputSchema": {"json": {"type": "object", "properties": {
                      "path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}}},
    {"toolSpec": {"name": "report", "description": "Tell the user which phase you are in (shown live in the UI).",
                  "inputSchema": {"json": {"type": "object", "properties": {
                      "phase": {"type": "string"}, "message": {"type": "string"}}, "required": ["phase"]}}}},
    {"toolSpec": {"name": "finish", "description": "Hand /opt/mg/model_custom.py over for verification: the job server "
                  "is started on it with HF_HUB_OFFLINE=1 and renders every benchmark prompt. On failure you get the "
                  f"error and the server log tail: fix it and call finish again ({MAX_VERIFY} attempts). On success the "
                  "trial ends.",
                  "inputSchema": {"json": {"type": "object", "properties": {
                      "python": {"type": "string", "description": "absolute path of the interpreter that imports the "
                                 "model's dependencies, e.g. /opt/mg/venv/bin/python"},
                      "metrics": {"type": "object", "description": "e.g. resolution, steps, peak_vram_gb"},
                      "notes": {"type": "string", "description": "Korean, markdown: what you installed, settings, "
                                "quality observations, problems"}},
                      "required": ["python", "notes"]}}}},
    {"toolSpec": {"name": "give_up", "description": "End the trial as failed because the model cannot work here.",
                  "inputSchema": {"json": {"type": "object", "properties": {
                      "error": {"type": "string"}, "notes": {"type": "string"}}, "required": ["error"]}}}},
]


def system_prompt() -> str:
    first, second = MODES
    if KIND == "image":
        contract = (f'- `KINDS = ["t2i"]`; add "i2i" only if the model edits an image from reference images (it is '
                    "then tested too).\n- `run(kind, params, workdir, set_phase) -> str`: draw one image, return the "
                    "path of a local .png under workdir. params: prompt (str), width, height (int, default 1024), seed "
                    "(int or None), image_urls (i2i only: a list of reference image URLs; fetch each with "
                    "`jobserver.download(url, dst)`).")
        target = "Krea 2 Turbo (text -> image) and FLUX.2 klein 9B (image editing with references)"
    else:
        contract = ('- `KINDS = ["t2v"]`; add "i2v" only if the model does image-to-video (it is then tested too).\n'
                    "- `run(kind, params, workdir, set_phase) -> str`: render one clip, return the path of a local "
                    ".mp4 under workdir. params: prompt (str), seconds (float, default 5), seed (int or None), "
                    "image_url (i2v only; fetch it with `jobserver.download(url, dst)`). Keep the audio if the model "
                    "generates audio.")
        target = "LTX-2.5"
    bench = [{k: b[k] for k in ("mode", "prompt")} for b in CFG["bench"]]
    return f"""You are a senior ML engineer running an unattended GPU trial. Nobody will answer questions.

Goal: install the open-weight {KIND} generation model **{CFG['label']}** (Hugging Face repo `{CFG['hfRepo']}`) on this
machine and wrap it as a module for the team's job server. The team compares its outputs with {target} on the same
prompts, and if the user approves, THIS machine becomes the team's server for the model.

Machine: AWS {CFG['instanceType']} -- {HARDWARE.get(CFG['instanceType'], '')}. Ubuntu 22.04 Deep Learning AMI, CUDA
drivers installed, PyTorch venv at /opt/pytorch (`source /opt/pytorch/bin/activate`), {300} GB disk. Put weights under
/opt/models (or the default HF cache /root/.cache/huggingface) and test outputs under {OUT_DIR}. The Hugging Face token
is configured for huggingface_hub; NEVER print, cat or echo it. You have about {CFG['maxHours']} hours in total, then
the machine powers off.

The module, /opt/mg/model_custom.py, is served by /opt/mg/jobserver.py (`app = jobserver.make_app(model_custom)`):
{contract}
- `load()`: load the weights onto the GPU once; the model stays resident and jobs run one at a time.
- Call set_phase("...") for progress.
- It must work with HF_HUB_OFFLINE=1 and no token, because that is how it will be served: download everything
  beforehand and load from absolute paths or the HF cache. Do not depend on files outside /opt/mg, /opt/models and
  /root/.cache/huggingface.

Benchmark (finish renders each through your module; {second} only if KINDS has it, with a reference image):
{json.dumps(bench, ensure_ascii=False, indent=1)}

How to work:
1. Read the model card first (`curl -s https://huggingface.co/{CFG['hfRepo']}/raw/main/README.md | head -300`) and
   follow its official inference path: a diffusers pipeline if one exists, otherwise the repo's own scripts. Prefer
   a separate venv under /opt/mg (`python -m venv --system-site-packages`) when the model pins conflicting versions.
2. Download only what inference needs, in the background, and poll. Call report() at every phase change.
3. If the weights do not fit in VRAM, use the model's documented offload / fp8 / quantized options.
4. Smoke-test the module once yourself (import model_custom, load(), run("{first}", ...)), check the output file, and
   let that process exit.
5. Call finish(python=..., notes=...). It loads the model again and renders every prompt, so start it with at least
   {20 if KIND == 'image' else 45} minutes left.
6. If it cannot work (weights missing, gated without access, OOM after offload, unsupported), call give_up(error=...)
   early with the concrete reason.
"""


def compact(messages: list) -> None:
    for m in messages[:-KEEP_RECENT]:
        for c in m["content"]:
            if "toolResult" in c and c["toolResult"]["content"] != [{"text": "[older output elided]"}]:
                c["toolResult"]["content"] = [{"text": "[older output elided]"}]


def main() -> None:
    report("agent started", f"{CFG['label']} on {CFG['instanceType']}")
    js = MG_DIR / "jobserver.py"
    if not js.is_file() or not re.search(r"\bMG_API_KEY\b", js.read_text(errors="replace")):
        give_up(f"/opt/mg/jobserver.py is missing or predates MG_API_KEY: upload mediagen/common/jobserver.py to "
                f"s3://{CFG['outBucket']}/code/common/ and test again")
        return
    system = system_prompt()
    messages = [{"role": "user", "content": [{"text": "Start the trial."}]}]
    for _ in range(MAX_TURNS):
        compact(messages)
        resp = bedrock.converse(modelId=CFG["modelId"], system=[{"text": system}], messages=messages,
                                toolConfig={"tools": SPECS}, inferenceConfig={"maxTokens": 8192})
        msg = resp["output"]["message"]
        messages.append(msg)
        for c in msg["content"]:
            if c.get("text"):
                log(f"model: {c['text'][:600]}")
        uses = [c["toolUse"] for c in msg["content"] if "toolUse" in c]
        if not uses:
            messages.append({"role": "user", "content": [{"text": "Continue; call finish or give_up when done."}]})
            continue
        results, done = [], False
        for u in uses:
            try:
                out = TOOLS[u["name"]](**u["input"])
            except Exception as e:  # noqa: BLE001 — the model sees the error and adapts
                out = {"error": redact(str(e))[:1000]}
            done = done or bool(out.get("done"))
            results.append({"toolResult": {"toolUseId": u["toolUseId"], "content": [{"json": out}]}})
        left = DEADLINE - time.time()
        if left < 20 * 60 and not done:
            results.append({"text": f"Only {int(left // 60)} minutes left: call finish now if model_custom.py works, "
                                    "otherwise give_up."})
        messages.append({"role": "user", "content": results})
        if done:
            return
    give_up(f"stopped after {MAX_TURNS} steps without finishing")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        log(f"agent crashed: {e!r}")
        try:
            put_json("result.json", {"status": "failed", "outputs": [], "error": f"trial agent crashed: {redact(repr(e))}"})
        except Exception:  # noqa: BLE001
            pass
