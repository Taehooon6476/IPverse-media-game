"""IPverse img3d GPU worker: SQS job → Hunyuan3D-2.1 shape + PBR paint → model.glb + status.json on S3.

Runs as the `ipverse-img3d` systemd service on the g6e (L40S) box, inside /opt/img3d/venv (Python 3.10,
torch 2.5.1+cu124). Message: {"jobId", "input_key", "output_prefix", "params"}.
status.json under output_prefix: {"status": running|done|failed, "phase", "error", "seconds", "updatedAt", "stats"}.
While a job runs a heartbeat rewrites status.json and extends the message visibility every 60 s.
Queue: the FIFO queue next to IMG3D_QUEUE_URL (`<url>.fifo`, one message group) hands meshes out in the order the
server sent them; the old standard queue, while the env file still names it, is drained first. The worker writes
the ticket of the job it runs to img3d/queue/head.json, so each waiting job's line can say its place
(server/providers/img3d.py).
After IDLE_SEC without a message the box stops itself (ec2:StopInstances, falling back to poweroff).
The white mesh loses Hunyuan's floor slab and stray flat cards (meshclean.py, next to this file) before painting.
"""
from __future__ import annotations
import json
import os
import shutil
import sys
import threading
import time
import traceback
import types
import urllib.request
from datetime import datetime, timezone

QUEUE_URL = os.environ.get("IMG3D_QUEUE_URL", "")
BUCKET = os.environ.get("IMG3D_BUCKET", "")
REGION = os.environ.get("AWS_REGION", "us-east-1")
REPO = os.environ.get("HY3D_REPO", "/opt/img3d/Hunyuan3D-2.1")
WORK = os.environ.get("IMG3D_WORK", "/opt/img3d/work")
IDLE_SEC = int(os.environ.get("IMG3D_IDLE_SEC", "1200"))
VISIBILITY_SEC = 600  # the heartbeat extends it every minute; a dead box holds the FIFO line no longer than this
HEARTBEAT_SEC = 60
HEAD_KEY = "img3d/queue/head.json"
RUN_SEC, LOAD_SEC = 90, 300  # a mesh on a warm box; the model load before the first one after a boot
HERE = os.path.dirname(os.path.abspath(__file__))
MODULES = ("meshclean.py",)  # synced by main(): the unit's ExecStartPre fetches only worker.py


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Worker:
    def __init__(self, sqs, s3, queue_url, bucket, generate, stop_self, idle_sec=IDLE_SEC,
                 clock=time.monotonic, work_dir=WORK, heartbeat_sec=HEARTBEAT_SEC):
        # queue_url: one URL, or [drained first, ..., long-polled] (queue_urls)
        self.queue_urls = [queue_url] if isinstance(queue_url, str) else list(queue_url)
        self.sqs, self.s3, self.bucket = sqs, s3, bucket
        self.head = {}
        self.generate, self.stop_self, self.idle_sec, self.clock = generate, stop_self, idle_sec, clock
        self.work_dir, self.heartbeat_sec = work_dir, heartbeat_sec
        self.last_activity = clock()

    def put_status(self, prefix, **status):
        body = {"status": "running", "phase": "", "error": "", "seconds": 0, **status, "updatedAt": now_iso()}
        self.s3.put_object(Bucket=self.bucket, Key=f"{prefix}status.json", Body=json.dumps(body).encode(),
                           ContentType="application/json")

    def poll_once(self, wait=20) -> bool:
        """One message: each queue but the last is asked without waiting, the last one with a long poll. True =
        handled a message. Stops the box after idle_sec without work."""
        for i, url in enumerate(self.queue_urls):
            last = i == len(self.queue_urls) - 1
            try:
                resp = self.sqs.receive_message(QueueUrl=url, MaxNumberOfMessages=1,
                                                WaitTimeSeconds=wait if last else 0, VisibilityTimeout=VISIBILITY_SEC)
            except Exception:
                if last:
                    raise
                traceback.print_exc()  # the old queue deleted: the idle stop must still come
                continue
            msgs = resp.get("Messages") or []
            if msgs:
                self.handle(msgs[0], url)
                self.last_activity = self.clock()
                return True
        if self.clock() - self.last_activity >= self.idle_sec:
            print(f"img3d: idle {self.idle_sec}s, stopping", flush=True)
            self.stop_self()
        return False

    def put_head(self, job, status, expect_sec=RUN_SEC):
        """The ticket this box runs, for the lines of the jobs behind it (server/providers/img3d.py _place). A message
        sent before tickets leaves it alone. Never fails the job."""
        if not job.get("ticket"):
            return
        self.head.update(ticket=job["ticket"], jobId=job["jobId"], status=status)
        if status == "running":
            self.head.update(startedAt=now_iso(), expectSec=expect_sec)
        try:
            self.s3.put_object(Bucket=self.bucket, Key=HEAD_KEY, Body=json.dumps(self.head).encode(),
                               ContentType="application/json")
        except Exception:
            traceback.print_exc()

    def handle(self, msg, queue_url=None) -> None:
        queue_url = queue_url or self.queue_urls[-1]
        receipt = msg["ReceiptHandle"]
        try:
            job = json.loads(msg["Body"])
            job_id, input_key = job["jobId"], job["input_key"]
            prefix = job["output_prefix"].rstrip("/") + "/"
        except (ValueError, KeyError, TypeError, AttributeError):
            print(f"img3d: dropping malformed message {msg.get('Body')!r}", flush=True)
            self.sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=receipt)
            return
        started = self.clock()
        state = {"phase": "download"}
        stop = threading.Event()

        def set_phase(phase):
            state["phase"] = phase
            self.put_status(prefix, phase=phase, seconds=round(self.clock() - started))

        def heartbeat():
            while not stop.wait(self.heartbeat_sec):
                try:
                    self.put_status(prefix, phase=state["phase"], seconds=round(self.clock() - started))
                    self.sqs.change_message_visibility(QueueUrl=queue_url, ReceiptHandle=receipt,
                                                       VisibilityTimeout=VISIBILITY_SEC)
                except Exception:
                    traceback.print_exc()

        work = os.path.join(self.work_dir, job_id)
        os.makedirs(work, exist_ok=True)
        beat = threading.Thread(target=heartbeat, daemon=True)
        try:
            set_phase("download")
            beat.start()
            loaded = getattr(self.generate, "loaded", lambda: True)()
            self.put_head(job, "running", RUN_SEC + (0 if loaded else LOAD_SEC))
            src = os.path.join(work, "input.png")
            self.s3.download_file(self.bucket, input_key, src)
            out = self.generate(src, work, job.get("params") or {}, set_phase)
            set_phase("upload")
            self.s3.upload_file(out["glb"], self.bucket, f"{prefix}model.glb",
                                ExtraArgs={"ContentType": "model/gltf-binary"})
            if out.get("preview"):
                self.s3.upload_file(out["preview"], self.bucket, f"{prefix}preview.png",
                                    ExtraArgs={"ContentType": "image/png"})
            stop.set()
            self.put_status(prefix, status="done", phase="done", seconds=round(self.clock() - started),
                            stats=out.get("stats") or {})
        except Exception as e:
            traceback.print_exc()
            stop.set()
            self.put_status(prefix, status="failed", phase=state["phase"], seconds=round(self.clock() - started),
                            error=f"{type(e).__name__}: {e}"[:500])
        finally:
            stop.set()
            shutil.rmtree(work, ignore_errors=True)
        self.put_head(job, "done")
        # done or failed: the result is in status.json, so never redeliver
        self.sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=receipt)


# ── Hunyuan3D-2.1 (GPU only; not imported by tests) ───────────────────────────

def hunyuan_generator(repo=REPO):
    sys.path[:0] = [repo, os.path.join(repo, "hy3dshape"), os.path.join(repo, "hy3dpaint")]
    os.chdir(repo)  # the paint config paths are repo-relative
    # mesh_utils imports bpy at module level only for its OBJ→GLB helper; we export with convert_utils instead
    sys.modules.setdefault("bpy", types.ModuleType("bpy"))
    models = {}

    def load(set_phase):
        if models:
            return
        set_phase("loading_models")
        try:
            from torchvision_fix import apply_fix
            apply_fix()
        except Exception:
            traceback.print_exc()
        from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline
        from hy3dshape.postprocessors import DegenerateFaceRemover, FaceReducer, FloaterRemover
        from hy3dshape.rembg import BackgroundRemover
        from textureGenPipeline import Hunyuan3DPaintConfig, Hunyuan3DPaintPipeline
        models["shape"] = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained("tencent/Hunyuan3D-2.1")
        conf = Hunyuan3DPaintConfig(6, 512)
        conf.realesrgan_ckpt_path = "hy3dpaint/ckpt/RealESRGAN_x4plus.pth"
        conf.multiview_cfg_path = "hy3dpaint/cfgs/hunyuan-paint-pbr.yaml"
        conf.custom_pipeline = "hy3dpaint/hunyuanpaintpbr"
        models["paint"] = Hunyuan3DPaintPipeline(conf)
        models["post"] = (FloaterRemover(), DegenerateFaceRemover(), FaceReducer())
        models["rembg"] = BackgroundRemover

    def generate(src, work, params, set_phase):
        import torch
        from PIL import Image
        load(set_phase)
        image = Image.open(src).convert("RGBA")
        if image.getchannel("A").getextrema() == (255, 255):  # no cutout alpha: remove the background
            image = models["rembg"]()(image.convert("RGB"))
        set_phase("shape")
        mesh = models["shape"](image=image, num_inference_steps=int(params.get("steps", 50)),
                               guidance_scale=float(params.get("guidance_scale", 5.0)),
                               octree_resolution=int(params.get("octree_resolution", 384)), num_chunks=20000,
                               generator=torch.manual_seed(int(params.get("seed", 1234))))[0]
        floater, degenerate, reducer = models["post"]
        mesh = reducer(degenerate(floater(mesh)), max_facenum=int(params.get("max_faces", 40000)))
        # before painting: the texture atlas then covers only the body
        mesh, cleanup = strip_sheets(mesh, fill=cutout_fill(image))
        white = os.path.join(work, "white_mesh.obj")
        mesh.export(white)
        set_phase("texture")
        textured = models["paint"](mesh_path=white, image_path=image,
                                   output_mesh_path=os.path.join(work, "textured_mesh.obj"), save_glb=False)
        set_phase("export")
        glb = os.path.join(work, "model.glb")
        loaded = export_glb(textured, glb)
        torch.cuda.empty_cache()
        return {"glb": glb, "stats": {"vertices": int(len(loaded.vertices)), "faces": int(len(loaded.faces)),
                                      "model": "hunyuan3d-2.1", "cleanup": cleanup}}

    generate.load = load
    generate.loaded = lambda: bool(models)
    return generate


def cutout_fill(image):
    """The opaque share of a cutout's alpha bbox (1.0 a rectangle, ~0.73 a kite shield), or None if nothing is
    opaque. meshclean.backdrop compares the mesh's front view with it."""
    import numpy as np
    alpha = np.asarray(image.getchannel("A")) > 127
    if not alpha.any():
        return None
    ys, xs = np.nonzero(alpha)
    return float(alpha[ys.min():ys.max() + 1, xs.min():xs.max() + 1].mean())


def strip_sheets(mesh, fill=None):
    """The trimesh white mesh without Hunyuan's floor slab, stray flat cards and, given the cutout's fill
    (cutout_fill), a backdrop plate filling the front view (meshclean.py, glTF axes: Y up, Z toward the camera).
    → (mesh, {"removedFaces", "slabs", "cards", "backdrops"}). Without meshclean.py the mesh passes."""
    import numpy as np
    if HERE not in sys.path:
        sys.path.append(HERE)
    try:
        import meshclean
    except ImportError:
        traceback.print_exc()
        return mesh, {"skipped": "meshclean.py missing"}
    V, F = np.asarray(mesh.vertices), np.asarray(mesh.faces)
    keep, info = meshclean.clean(V, F, up=1, front=2)
    keep, back = meshclean.backdrop(V, F, keep, fill, up=1, front=2)
    summary = {"removedFaces": back["removedFaces"], "slabs": len(info["slabs"]), "cards": info["cards"], "backdrops": back["backdrops"]}
    if keep.all():
        return mesh, summary
    vertices, faces, _ = meshclean.compact(mesh.vertices, mesh.faces, keep)
    print(f"img3d: removed {summary}", flush=True)
    return type(mesh)(vertices=vertices, faces=faces, process=False), summary


def export_glb(obj_path, glb_path):
    """Textured OBJ (+ .jpg, _metallic.jpg, _roughness.jpg from the paint pipeline) → GLB with binary PNG
    textures, a glTF metallicRoughness map (G=roughness, B=metallic) and smooth normals that ignore UV seams
    (without normals three.js shades every face flat). Returns the trimesh mesh."""
    import numpy as np
    import trimesh
    from PIL import Image
    from trimesh.visual import TextureVisuals
    from trimesh.visual.material import PBRMaterial
    mesh = trimesh.load(obj_path, force="mesh", process=False)
    base = obj_path[:-4]
    albedo = Image.open(base + ".jpg").convert("RGB")
    metal = Image.open(base + "_metallic.jpg").convert("L")
    rough = Image.open(base + "_roughness.jpg").convert("L").resize(metal.size)
    mr = Image.merge("RGB", (Image.new("L", metal.size, 255), rough, metal))
    mesh.visual = TextureVisuals(uv=mesh.visual.uv, material=PBRMaterial(
        name="Hunyuan3D_PBR", baseColorTexture=albedo, metallicRoughnessTexture=mr,
        metallicFactor=1.0, roughnessFactor=1.0))
    _, group = np.unique(np.round(mesh.vertices, 6), axis=0, return_inverse=True)
    group = group.reshape(-1)
    weighted = mesh.face_normals * mesh.area_faces[:, None]
    acc = np.zeros((group.max() + 1, 3))
    np.add.at(acc, group[mesh.faces], np.repeat(weighted[:, None, :], 3, axis=1))
    acc /= np.maximum(np.linalg.norm(acc, axis=1, keepdims=True), 1e-12)
    mesh.vertex_normals = acc[group]
    mesh.export(glb_path, include_normals=True)
    return mesh


def queue_urls(sqs, url) -> list:
    """The queues to poll, oldest first: the env file's URL and, when it names the old standard queue, the FIFO
    queue next to it once that exists (the box's /etc/img3d.env predates it)."""
    if url.endswith(".fifo"):
        return [url]
    try:
        sqs.get_queue_attributes(QueueUrl=url + ".fifo", AttributeNames=["QueueArn"])
    except Exception as e:  # not deployed yet, or the role cannot read it
        print(f"img3d: no FIFO queue next to {url} ({e}), polling the standard queue only", flush=True)
        return [url]
    return [url, url + ".fifo"]


def instance_id() -> str:
    token = urllib.request.urlopen(urllib.request.Request(
        "http://169.254.169.254/latest/api/token", method="PUT",
        headers={"X-aws-ec2-metadata-token-ttl-seconds": "300"}), timeout=5).read().decode()
    return urllib.request.urlopen(urllib.request.Request(
        "http://169.254.169.254/latest/meta-data/instance-id",
        headers={"X-aws-ec2-metadata-token": token}), timeout=5).read().decode()


def main():
    if "--warmup" in sys.argv:  # setup.sh: download every weight into the caches and load once
        hunyuan_generator().load(lambda phase: print(f"img3d warmup: {phase}", flush=True))
        print("img3d warmup: models loaded", flush=True)
        return
    import boto3
    sqs, s3, ec2 = (boto3.client(n, region_name=REGION) for n in ("sqs", "s3", "ec2"))
    for name in MODULES:  # next to worker.py, from where scripts/deploy_img3d.sh uploads it
        try:
            s3.download_file(BUCKET, f"img3d/worker/{name}", os.path.join(HERE, name))
        except Exception:
            traceback.print_exc()

    def stop_self():
        try:
            ec2.stop_instances(InstanceIds=[instance_id()])
        except Exception:
            traceback.print_exc()
            os.system("poweroff")
        time.sleep(300)  # stopping; don't take another message

    queues = queue_urls(sqs, QUEUE_URL)
    worker = Worker(sqs, s3, queues, BUCKET, hunyuan_generator(), stop_self)
    print(f"img3d: polling {queues}, idle stop after {IDLE_SEC}s", flush=True)
    while True:
        try:
            worker.poll_once()
        except Exception:
            traceback.print_exc()
            time.sleep(5)


if __name__ == "__main__":
    main()
