from __future__ import annotations
import base64
import json
import os
import re
import traceback

# Which end of a drawn weapon is held: no shape rule tells a sword (the wide guard by its grip) from a spear or an axe
# (the wide head away from it), so a small vision model is asked about the picture.
GRIP_MODEL_ID = os.environ.get("GRIP_MODEL_ID", "global.anthropic.claude-haiku-5-5")
# asks for the working end, not the held one: asked which end is held, the model named a binding behind a spearhead
GRIP_QUESTION = ("This picture shows one weapon or tool lying across the frame. Which end is its working end: the "
                 "blade tip, the spearhead, the axe, hammer or staff head, or the muzzle, not the end held in the "
                 "hand? Answer with one word: left or right.")


def generate_image(
    ctx,
    prompt: str,
    negative: str,
    seed: int,
    aspect_ratio: str = "1:1",
    output_format: str = "jpeg",
) -> bytes:
    """Call Stability stable-image-ultra on Bedrock (us-west-2). Returns raw image bytes."""
    body = json.dumps({
        "prompt": prompt,
        "negative_prompt": negative,
        "aspect_ratio": aspect_ratio,
        "seed": seed,
        "output_format": output_format,
    })
    response = ctx.bedrock_rt_west.invoke_model(
        modelId=ctx.image_model_id,
        body=body,
        contentType="application/json",
        accept="application/json",
    )
    resp_body = json.loads(response["body"].read())
    return base64.b64decode(resp_body["images"][0])


def remove_background(ctx, image_bytes: bytes) -> bytes:
    """Call Stability remove-background on Bedrock (us-east-1). Returns PNG with alpha."""
    b64_input = base64.b64encode(image_bytes).decode()
    body = json.dumps({"image": b64_input, "output_format": "png"})
    response = ctx.bedrock_rt_east.invoke_model(
        modelId=ctx.remove_bg_model_id,
        body=body,
        contentType="application/json",
        accept="application/json",
    )
    resp_body = json.loads(response["body"].read())
    # Accept both {"image": "<b64>"} and {"images": ["<b64>"]}
    if "image" in resp_body:
        return base64.b64decode(resp_body["image"])
    return base64.b64decode(resp_body["images"][0])


def grip_side(ctx, image_bytes: bytes):
    """The end ("left" or "right") a weapon drawn lying across the frame is held by: the one opposite the working end
    GRIP_MODEL_ID names (one word, thinking off). None when there is no quick client, the answer names neither side
    or both, or the call fails: the caller keeps the grip at the left."""
    client = getattr(ctx, "bedrock_rt_quick", None)  # never the agent's client: 10 minutes a try, 3 tries
    kind = ("png" if image_bytes.startswith(b"\x89PNG\r\n\x1a\n")
            else "jpeg" if image_bytes.startswith(b"\xff\xd8") else "")
    if client is None or not kind:
        return None
    try:
        out = client.converse(modelId=GRIP_MODEL_ID, inferenceConfig={"maxTokens": 5},
                              additionalModelRequestFields={"thinking": {"type": "disabled"}}, messages=[
            {"role": "user", "content": [{"image": {"format": kind, "source": {"bytes": image_bytes}}},
                                         {"text": GRIP_QUESTION}]}])
        text = " ".join(b.get("text", "") for b in out["output"]["message"]["content"]).lower()
    except Exception:  # a throttle, a timeout or a refusal: the drawn convention stays
        traceback.print_exc()
        return None
    sides = [side for side in ("left", "right") if re.search(rf"\b{side}\b", text)]
    return {"left": "right", "right": "left"}[sides[0]] if len(sides) == 1 else None


# A klein edit can draw more than asked (a covered head becomes a face, a new background or style), so the reference
# and the edit are shown to the same small vision model, one call per landed draw. An edit is a new render, never
# pixel-equal: the question says what a redraw brings anyway, and the model says whether what it names is that small
# (other_minor). A change the request itself asks for (background_asked, style_asked) never fails the edit, and the
# background is judged against the reference's own, whatever it shows.
EDIT_QUESTION = (
    "Image 1 is a reference picture. Image 2 is an edit of it that was asked to make only this change: \"{change}\".\n"
    "An edit draws the whole picture again. So image 2 may have another pixel size or be scaled a little, and parts "
    "that were not asked to change come back with small differences in shape, texture, folds or fine detail. That "
    "is expected and is not a change.\n"
    "Image 1's background is the one that must stay, whether it is a plain backdrop or full scenery: judge image "
    "2's background against image 1 as it is, never against a plain studio.\n"
    "Compare image 2 with image 1 and answer with only one JSON object, no other text:\n"
    "{{\"reference_head_covered\": true if in image 1 the head is covered by a helmet, visor or mask, or is a robot or "
    "machine head, so no human face shows,\n"
    " \"face_appeared\": true if such a covered head in image 1 shows a visible human face, skin, eyes or hair in "
    "image 2,\n"
    " \"background_asked\": true if the requested change itself asks to change, add to or replace the background or "
    "what is behind or around the subject (a sky, a moon, scenery, a place, weather),\n"
    " \"background_changed\": true if the background differs in a way the requested change does not ask for, for "
    "example a plain studio became a landscape, a room or scenery, or scenery became a plain backdrop,\n"
    " \"style_asked\": true if the requested change itself asks for another art style or rendering,\n"
    " \"style_changed\": true if the art style or rendering differs in a way the requested change does not ask for "
    "(painterly became flat illustration, cartoon or photo, or the reverse) or a signature, logo, watermark or text "
    "appeared,\n"
    " \"other_changes\": \"\" or a short Korean phrase naming anything else that clearly changed beyond the requested "
    "change,\n"
    " \"other_minor\": true if other_changes is empty or names only such small redraw differences in parts that are "
    "otherwise the same, false if it names a real change: a different character or object, another body, pose or "
    "design of the armor, outfit or object, another color on a part that was not asked to change, or something "
    "added, removed or replaced}}\n"
    "Ignore what the requested change itself covers or hides, and tiny differences in noise or sharpness.")
EDIT_PROBLEMS = (("faceAppeared", "투구·가면으로 가려진 머리가 사람 얼굴로 바뀜"),
                 ("backgroundChanged", "요청하지 않은 배경 변경"),
                 ("styleChanged", "화풍이 바뀜(또는 서명·글자가 생김)"))
_check_clients: dict = {}


def _check_client(ctx):
    """The quick client gives up after 5 s (one weapon word); two pictures and a JSON answer take longer, so a real
    client gets a sibling in the same region with a 30 s read timeout, still one try."""
    quick = getattr(ctx, "bedrock_rt_quick", None)
    region = getattr(getattr(quick, "meta", None), "region_name", None)
    if quick is None or not region:
        return quick  # None, or a test fake
    if region not in _check_clients:
        import boto3
        from botocore.config import Config
        _check_clients[region] = boto3.client("bedrock-runtime", region_name=region, config=Config(
            connect_timeout=2, read_timeout=30, retries={"total_max_attempts": 1}))
    return _check_clients[region]


def _format(image_bytes: bytes) -> str:
    return ("png" if image_bytes.startswith(b"\x89PNG\r\n\x1a\n")
            else "jpeg" if image_bytes.startswith(b"\xff\xd8") else "")


def edit_check(ctx, reference: bytes, result: bytes, change: str):
    """Whether a klein edit changed only what was asked, as GRIP_MODEL_ID judges the reference and the result.
    → {ok, headCovered, faceAppeared, backgroundChanged, styleChanged, other, otherMinor, problem (Korean, "" when
    ok)}, or None when it cannot be judged (no client, unknown format, a failed call, no JSON): the caller lets the
    edit land unchecked. `other` fails the edit unless otherMinor; an answer that does not say counts as real."""
    client, kinds = _check_client(ctx), (_format(reference), _format(result))
    if client is None or not all(kinds):
        return None
    try:  # 400 tokens: an answer cut before its last key (other_minor) would hold no JSON
        out = client.converse(modelId=GRIP_MODEL_ID, inferenceConfig={"maxTokens": 400},
                              additionalModelRequestFields={"thinking": {"type": "disabled"}}, messages=[
            {"role": "user", "content": [{"image": {"format": kinds[0], "source": {"bytes": reference}}},
                                         {"image": {"format": kinds[1], "source": {"bytes": result}}},
                                         {"text": EDIT_QUESTION.format(change=change.strip().replace('"', "'"))}]}])
        text = " ".join(b.get("text", "") for b in out["output"]["message"]["content"])
        found = re.search(r"\{.*\}", text, re.S)
        answer = json.loads(found.group(0)) if found else None
    except Exception:  # a throttle, a timeout, a refusal or broken JSON: unchecked
        traceback.print_exc()
        return None
    if not isinstance(answer, dict):
        return None
    yes = lambda k: answer.get(k) is True or str(answer.get(k)).lower() == "true"  # noqa: E731
    asked = {"backgroundAsked": yes("background_asked"), "styleAsked": yes("style_asked")}
    verdict = {"headCovered": yes("reference_head_covered"), "faceAppeared": yes("face_appeared"), **asked,
               "backgroundChanged": yes("background_changed") and not asked["backgroundAsked"],
               "styleChanged": yes("style_changed") and not asked["styleAsked"],
               "other": str(answer.get("other_changes") or "").strip()[:80], "otherMinor": yes("other_minor")}
    problems = [text for key, text in EDIT_PROBLEMS if verdict[key]]
    problems += [f"요청 밖 변경: {verdict['other']}"] if verdict["other"] and not verdict["otherMinor"] else []
    return {"ok": not problems, **verdict, "problem": ", ".join(problems)}
