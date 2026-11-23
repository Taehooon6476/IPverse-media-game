from __future__ import annotations
import base64
import uuid


class BedrockVideoProvider:
    name = "bedrock_video"

    def submit(self, job: dict, ctx) -> str:
        """Start async video generation via Luma Ray 2 on Bedrock (us-west-2)."""
        session_id = job["pk"].split("#")[1]
        job_id = job["jobId"]
        inp = job["input"]

        model_input = {
            "prompt": inp.get("prompt", ""),
            "aspect_ratio": inp.get("aspect_ratio", "16:9"),
            "loop": False,
            "duration": inp.get("duration", "5s"),
            "resolution": "720p",
        }
        if inp.get("fallback") != "text":  # text fallback: the keyframe was rejected by moderation
            resp = ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=inp["imageKey"])
            b64_image = base64.b64encode(resp["Body"].read()).decode()
            model_input["keyframes"] = {
                "frame0": {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": b64_image,
                    },
                }
            }

        output_uri = f"s3://{ctx.video_bucket}/{session_id}/{job_id}/"

        response = ctx.bedrock_rt_west.start_async_invoke(
            modelId=ctx.video_model_id,
            modelInput=model_input,
            outputDataConfig={"s3OutputDataConfig": {"s3Uri": output_uri}},
        )
        return response["invocationArn"]

    def status(self, job: dict, ctx) -> tuple:
        """Poll async invocation status. Returns (status_str, progress_text)."""
        invocation_arn = job["externalId"]
        response = ctx.bedrock_rt_west.get_async_invoke(invocationArn=invocation_arn)
        status = response.get("status", "InProgress")
        if status == "Completed":
            return ("done", "")
        if status == "Failed":
            msg = response.get("failureMessage", "Unknown failure")
            return ("failed", msg)
        return ("running", status)

    def fallback_input(self, inp: dict, failure: str, description: str):
        """Luma rejected the keyframe ("image moderation failed"): the input for one text-to-video retry,
        or None when this failure gets no fallback."""
        if "moderation" not in (failure or "").lower() or not inp.get("imageKey") or inp.get("fallback"):
            return None
        prompt = ", ".join(p for p in (inp.get("prompt", ""), description) if p)
        return {**inp, "prompt": prompt, "fallback": "text"}

    def collect(self, job: dict, ctx) -> list:
        """Copy the output .mp4 from VIDEO_BUCKET into ASSETS_BUCKET sessions/ prefix."""
        session_id = job["pk"].split("#")[1]
        job_id = job["jobId"]
        asset_id = job["outputs"][0] if job.get("outputs") else str(uuid.uuid4())

        prefix = f"{session_id}/{job_id}/"
        response = ctx.s3.list_objects_v2(Bucket=ctx.video_bucket, Prefix=prefix)

        mp4_key = None
        for obj in response.get("Contents", []):
            if obj["Key"].endswith(".mp4"):
                mp4_key = obj["Key"]
                break

        if not mp4_key:
            raise RuntimeError(
                f"No .mp4 found under s3://{ctx.video_bucket}/{prefix}"
            )

        dst_key = f"sessions/{session_id}/{asset_id}.mp4"
        ctx.s3.copy_object(
            CopySource={"Bucket": ctx.video_bucket, "Key": mp4_key},
            Bucket=ctx.assets_bucket,
            Key=dst_key,
        )

        return [{"kind": "shot", "key": dst_key, "contentType": "video/mp4", "meta": {}}]
