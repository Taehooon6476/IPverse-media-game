"""Re-pose a humanoid IP into the rig's A-pose before it becomes a mesh (FLUX.2 klein 9B, the IP image as
reference). Krea ignores pose and framing, which Hunyuan3D turns into fused arms or no legs; klein keeps the face
and outfit and redraws the figure full-length on a plain background. Only the 3D chain uses this image.

collect writes the cutout to a fixed key per job so the chained mesh3d job can read it.
"""
from __future__ import annotations
import traceback

from server.providers import cutout, mcp_client
from server.providers.bedrock_image import remove_background

PROMPT = ("The same {who} from the reference image, identical face, hair, outfit, materials and colors, fully "
          "clothed exactly as in the reference, now shown full-length from head to feet on a plain light grey "
          "studio background, standing in a strict A-pose: both arms straight and lowered about 45 degrees away "
          "from the torso with a clear gap between arms and body, hands open and empty, legs slightly apart, "
          "front view facing camera, whole body small in frame with margin above the head and below the feet. "
          "No scenery, no props, no weapon, no text.")


def pose_key(session_id: str, job_id: str) -> str:
    return f"sessions/{session_id}/{job_id}-apose.png"


def prompt_for(name: str) -> str:
    return PROMPT.format(who=f"character ({name})" if name else "character")


class AposeProvider:
    name = "apose"

    def submit(self, job: dict, ctx) -> str:
        inp = job["input"]
        out = mcp_client.call_tool(ctx, mcp_client.IMAGE, "start_image", {
            "prompt": prompt_for(inp.get("name", "")), "model": "klein9",
            "reference_image_urls": [mcp_client.public_input_url(ctx, inp["imageKey"])]})
        if out.get("status") == "FAILED" or not out.get("job_id"):
            raise RuntimeError(f"start_image: {out.get('error') or out}"[:300])
        return out["job_id"]

    def status(self, job: dict, ctx) -> tuple:
        st = mcp_client.call_tool(ctx, mcp_client.IMAGE, "get_image_status", {"job_id": job["externalId"]})
        if st.get("status") == "SUCCEEDED":
            return ("done", "") if st.get("url") else ("failed", "3D용 자세 그림을 받지 못했습니다")
        if st.get("status") == "FAILED":
            return ("failed", f"3D용 자세 그림을 그리지 못했습니다: {st.get('error') or '원인 미상'}"[:300])
        # the job card's own name for this step (waits.STEP_LABEL)
        return ("running", "3D용 자세 그림 그리는 중")

    def collect(self, job: dict, ctx) -> list:
        session_id = job["pk"].split("#")[1]
        st = mcp_client.call_tool(ctx, mcp_client.IMAGE, "get_image_status", {"job_id": job["externalId"]})
        raw = mcp_client.download(st["url"])
        try:  # cleaned: faint alpha and stray specks would become geometry in Hunyuan3D
            cut = cutout.clean(remove_background(ctx, raw))
        except Exception:  # Bedrock 503s happen; the img3d worker removes an opaque background itself
            traceback.print_exc()
            cut = raw
        key = pose_key(session_id, job["jobId"])
        ctx.s3.put_object(Bucket=ctx.assets_bucket, Key=key, Body=cut, ContentType="image/png")
        return [{"kind": "pose_cutout", "key": key, "contentType": "image/png",
                 "meta": {"model": "klein9", "purpose": "rig A-pose"}}]
