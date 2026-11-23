from __future__ import annotations
import json
import uuid
from datetime import datetime, timezone


# Deadline Cloud's taskRunStatus as the 3D turntable's job line says it, in the card's words (waits.STEP_LABEL)
PHASES = {
    "PENDING": "렌더 서버 순서 기다리는 중", "READY": "렌더 서버 배정 기다리는 중",
    "ASSIGNED": "렌더 서버 배정됨", "SCHEDULED": "렌더 서버 배정됨",
    "STARTING": "렌더 서버 시작하는 중", "RUNNING": "3D 회전 영상 만드는 중",
    "INTERRUPTING": "렌더 서버가 작업을 멈추는 중", "SUSPENDED": "렌더 서버 잠시 멈춤",
}


class DeadlineProvider:
    name = "deadline"
    phases = PHASES  # the job line per taskRunStatus; the rig, on the same farm, says its own (rig.RIG_PHASES)

    def __init__(self, template_loader=None):
        # ponytail: inject for tests; production uses the lazy import
        self._template_loader = template_loader

    def _load_template(self) -> dict:
        if self._template_loader is not None:
            return self._template_loader()
        from server.workers.template_loader import load_template  # lazy
        return load_template()

    def submit(self, job: dict, ctx) -> str:
        """Create a Deadline Cloud job. Returns jobId string."""
        session_id = job["pk"].split("#")[1]
        job_id = job["jobId"]
        inp = job["input"]

        # glbKey: turntable of a Hunyuan3D mesh (the img3d dep job wrote it); else the cutout relief
        src_key = inp.get("glbKey") or inp.get("cutoutKey", f"sessions/{session_id}/{inp.get('ipId')}.png")
        # The queue role reads/writes only the queue bucket under DeadlineCloud/* (its wildcard GetObject
        # is conditioned on Deadline's access points), so stage the input next to the job's outputs.
        # The task script picks the Blender mode from the extension (.glb → import, .png → relief).
        staged_key = f"{ctx.queue_prefix}/{job_id}/inputs/" + ("model.glb" if inp.get("glbKey") else "cutout.png")
        ctx.s3.copy_object(
            CopySource={"Bucket": ctx.assets_bucket, "Key": src_key},
            Bucket=ctx.queue_bucket,
            Key=staged_key,
        )
        input_uri = f"s3://{ctx.queue_bucket}/{staged_key}"
        output_prefix = f"s3://{ctx.queue_bucket}/{ctx.queue_prefix}/{job_id}"

        template = self._load_template()

        parameters = {
            "InputUri": {"string": input_uri},
            "OutputPrefix": {"string": output_prefix},
            # cost ruling: ~40 CPU-s/frame at 24 spp; 48 frames at 16 spp is about 2 min of render
            "Frames": {"int": "48"},
            "Width": {"int": "1280"},
            "Height": {"int": "720"},
            "Samples": {"int": "16"},
            "Accent": {"string": inp.get("accent", "#5de6cf")},
        }

        response = ctx.deadline.create_job(
            farmId=ctx.deadline_farm_id,
            queueId=ctx.deadline_queue_id,
            template=json.dumps(template),
            templateType="JSON",
            parameters=parameters,
            priority=50,
            maxRetriesPerTask=1,
        )
        return response["jobId"]

    def status(self, job: dict, ctx) -> tuple:
        """Poll job status. Returns ("running"|"done"|"failed", progress_text)."""
        job_id = job["externalId"]
        resp = ctx.deadline.get_job(
            farmId=ctx.deadline_farm_id,
            queueId=ctx.deadline_queue_id,
            jobId=job_id,
        )

        lifecycle = resp.get("lifecycleStatus", "")
        task_run = resp.get("taskRunStatus", "PENDING")
        # the farm's own clock for the job's end (in memory only; the engine keeps it as finishedAt, jobs._finished_at):
        # a turntable is settled by the poll that notices it, which can be minutes after the farm finished it
        job["_ended"] = resp.get("endedAt")

        if "_FAILED" in lifecycle:
            return ("failed", f"렌더 서버가 작업을 받지 못했습니다: {lifecycle}")

        if task_run == "SUCCEEDED":
            return ("done", "")

        if task_run in ("FAILED", "CANCELED"):
            return ("failed", f"렌더 서버에서 작업이 {'취소됐습니다' if task_run == 'CANCELED' else '실패했습니다'}: {task_run}")

        elapsed = _format_elapsed(resp.get("createdAt"))
        phase = self.phases.get(task_run) or self.phases["RUNNING"]
        return ("running", f"{phase} · {elapsed}" if elapsed else phase)

    def collect(self, job: dict, ctx) -> list:
        """Copy turntable.mp4, model.glb, poster.png from queue bucket to assets bucket.
        A GLB-mode turntable keeps the Hunyuan3D GLB as the IP's model, so it copies no model.glb."""
        session_id = job["pk"].split("#")[1]
        job_id = job["jobId"]  # submit() set OutputPrefix to our jobId; externalId is Deadline's
        prefix = f"{ctx.queue_prefix}/{job_id}/"

        assets = []
        outputs = [
            ("turntable.mp4", "turntable", "mp4", "video/mp4"),
            ("model.glb", "glb", "glb", "model/gltf-binary"),
            ("poster.png", "poster", "png", "image/png"),
        ]
        if job["input"].get("glbKey"):
            outputs = [o for o in outputs if o[1] != "glb"]
        for fname, kind, ext, content_type in outputs:
            src_key = f"{prefix}{fname}"
            asset_id = str(uuid.uuid4())
            dst_key = f"sessions/{session_id}/{asset_id}.{ext}"

            ctx.s3.copy_object(
                CopySource={"Bucket": ctx.queue_bucket, "Key": src_key},
                Bucket=ctx.assets_bucket,
                Key=dst_key,
            )
            assets.append(
                {"kind": kind, "key": dst_key, "contentType": content_type, "meta": {}}
            )

        return assets


def _format_elapsed(created_at) -> str:
    """Time since createdAt in Korean; boto3 gives a datetime, the fakes a str."""
    if not created_at:
        return "0초"
    try:
        if not isinstance(created_at, datetime):
            created_at = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        delta = max(0, int((now - created_at).total_seconds()))
        minutes, seconds = divmod(delta, 60)
        if minutes:
            return f"{minutes}분 {seconds}초"
        return f"{seconds}초"
    except Exception:
        return ""
