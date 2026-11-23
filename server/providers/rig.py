"""Auto-rig a Hunyuan3D GLB onto the UAL skeleton on the Deadline Cloud farm (workers/rig/).

submit stages the inputs under the queue bucket's DeadlineCloud/ prefix (the only one the queue role reads).
status: when the worker refused the figure (meta.json method "refused"), the job carries the reason a person reads
(_refused: jobs.py ends it as outcome "refused"). collect: rigged.glb → `rigged_glb`, rig_preview.mp4 → `rig_preview`.
"""
from __future__ import annotations
import json
import re
import uuid
from datetime import datetime, timezone

from server.providers.deadline import PHASES, DeadlineProvider

UAL_KEY = "runtime3d/v1/anims/ual.glb"
POSE_MODEL_KEY = "rig/models/rtmpose-m_body7_256x192.onnx"
OUTPUTS = (("rigged.glb", "rigged_glb", "glb", "model/gltf-binary"),
           ("rig_preview.mp4", "rig_preview", "mp4", "video/mp4"))
META_FIELDS = ("method", "fallbackReason", "weights", "ualHipsScale", "seconds", "cleanup")  # cleanup: slab/cards

# A figure the worker cannot rig (workers/rig/blender_rig.py: meta.json {"method": "refused", "fallbackReason"}) is
# refused, and a retry cannot succeed: the job's record says it was a refusal (jobs.REFUSED) and why, in words a
# person can act on (the web shows `reason` as it is).
# REASONS: the start of the worker's reason → the reason as people read it (no closing mark: each line punctuates).
UNEVEN = "legs of uneven length"
REASONS = (("not a full body", "다리가 보이지 않거나 너무 짧아요"),
           (UNEVEN, "두 다리의 길이가 다르게 보여요(꼬리나 긴 옷자락이 다리처럼 보일 수 있어요)"))
_UNEVEN_REFUSED = re.compile(re.escape(UNEVEN) + r" \([\d.]+%\) after ")  # the worker's refusal, as it writes it
OTHER_REASON = "뼈대를 맞출 수 없는 모양이에요"  # a refusal for a reason this table does not know yet
# the lead of a refusal's error line, now and in older records: what tells a refusal on a record that has no
# refusal field
REFUSED_LEAD = "움직임 뼈대를 넣을 수 없는 모양입니다"
OLD_LEADS = (REFUSED_LEAD, "리깅 불가")
# What a game made with such a model is like and what brings the motions, as the server tells the user
# (agent._finished) and the agent (tools.NO_SKELETON): the unrigged model slides with a bob (game3d/world.js)
NO_MOTION = "걷는 동작 없이 나와요"
PICTURE_NEEDS = "머리부터 발끝까지 보이고 두 다리가 드러나게 서 있는 그림"
REDRAW_FORM = "걷는 동작을 넣으려면 {needs}으로 다시 뽑은 뒤 3D를 다시 만들어 주세요."  # (server/i18n.py tr: its English)
REDRAW = REDRAW_FORM.format(needs=PICTURE_NEEDS)


def reason_ko(reason) -> str:
    """The worker's refusal reason as people read it."""
    return next((said for lead, said in REASONS if str(reason or "").startswith(lead)), OTHER_REASON)


def refusal(error) -> str:
    """The reason (as people read it) of a failed rig job's error line when that line is a refusal's, else "": for
    a record that has no refusal field. Only the reasons the worker refuses for count: older records gave the
    refusal's lead to every failure that left a fallbackReason, some of which a retry can pass."""
    lead, _, reason = str(error or "").partition(": ")
    if lead not in OLD_LEADS:
        return ""
    # "legs of uneven length (40%)" alone is why the worker's detection gave up, not a refusal: that job went on
    # with proportions. The refusal for uneven legs always names what it came after ("… after pose estimator failed")
    if reason.startswith(UNEVEN) and not _UNEVEN_REFUSED.match(reason):
        return ""
    return next((said for known, said in REASONS if reason.startswith(known)), "")


# the rig job's line: the farm's lines while it waits, its own step's name while it works (waits.STEP_LABEL)
RIG_PHASES = {**PHASES, "RUNNING": "움직임 뼈대 넣는 중"}


class RigProvider(DeadlineProvider):
    name = "rig"
    phases = RIG_PHASES

    def _load_template(self) -> dict:
        if self._template_loader is not None:
            return self._template_loader()
        from server.workers.template_loader import load_rig_template  # lazy
        return load_rig_template()

    def submit(self, job: dict, ctx) -> str:
        job_id = job["jobId"]
        inputs = f"{ctx.queue_prefix}/{job_id}/inputs/"
        uri = {}
        for name, key in (("model.glb", job["input"]["glbKey"]), ("ual.glb", UAL_KEY), ("pose.onnx", POSE_MODEL_KEY)):
            ctx.s3.copy_object(CopySource={"Bucket": ctx.assets_bucket, "Key": key},
                               Bucket=ctx.queue_bucket, Key=inputs + name)
            uri[name] = {"string": f"s3://{ctx.queue_bucket}/{inputs}{name}"}
        response = ctx.deadline.create_job(
            farmId=ctx.deadline_farm_id,
            queueId=ctx.deadline_queue_id,
            template=json.dumps(self._load_template()),
            templateType="JSON",
            parameters={"InputUri": uri["model.glb"], "AnimUri": uri["ual.glb"], "PoseModelUri": uri["pose.onnx"],
                        "OutputPrefix": {"string": f"s3://{ctx.queue_bucket}/{ctx.queue_prefix}/{job_id}"}},
            priority=50,
            maxRetriesPerTask=1,
        )
        return response["jobId"]

    def _meta(self, job, ctx) -> dict:
        """What this run of the job left in meta.json: {} when there is none, or when the file is an earlier run's.
        A run keeps its files under the job's own id, so after a retry the old meta.json is still there until the
        worker writes a new one; the file is this run's only when written after startedAt (jobs._advance)."""
        try:
            got = ctx.s3.get_object(Bucket=ctx.queue_bucket, Key=f"{ctx.queue_prefix}/{job['jobId']}/meta.json")
            written, began = got.get("LastModified"), job.get("startedAt") or job.get("retriedAt") or job.get("createdAt")
            if isinstance(written, datetime) and began:
                written = written if written.tzinfo else written.replace(tzinfo=timezone.utc)
                if written < datetime.fromisoformat(began.replace("Z", "+00:00")):
                    return {}
            return json.loads(got["Body"].read() or b"{}")
        except Exception:  # no meta.json (Blender never got that far) or unreadable
            return {}

    def status(self, job: dict, ctx) -> tuple:
        state, progress = super().status(job, ctx)
        if state == "failed":
            meta = self._meta(job, ctx)
            # only the worker's own word makes a refusal: a meta.json with a fallbackReason is also what a job leaves
            # that fell back to proportions and failed later, and that model can be rigged
            if meta.get("method") == "refused":
                reason = meta.get("fallbackReason") or ""
                job["_refused"] = reason_ko(reason)  # in memory: jobs._settle ends the job as a refusal with it
                return state, f"{REFUSED_LEAD}: {reason}" if reason else REFUSED_LEAD
        return state, progress

    def collect(self, job: dict, ctx) -> list:
        session_id = job["pk"].split("#")[1]
        prefix = f"{ctx.queue_prefix}/{job['jobId']}/"
        meta = {k: v for k, v in self._meta(job, ctx).items() if k in META_FIELDS}
        assets = []
        for fname, kind, ext, content_type in OUTPUTS:
            dst_key = f"sessions/{session_id}/{uuid.uuid4()}.{ext}"
            ctx.s3.copy_object(CopySource={"Bucket": ctx.queue_bucket, "Key": prefix + fname},
                               Bucket=ctx.assets_bucket, Key=dst_key)
            assets.append({"kind": kind, "key": dst_key, "contentType": content_type,
                           "meta": meta if kind == "rigged_glb" else {}})
        return assets
