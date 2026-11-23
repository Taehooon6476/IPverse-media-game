"""Still images on the storyboard GPU box (Krea 2 Turbo, FLUX.2 klein 9B) through its MCP proxy, as jobs.

The box holds one model at a time: an image takes 10–60 s, plus ~2 min when the box swaps models, and the proxy
fails a job that waited 10 minutes for the box (jobs.py retries it). The tools only register the job, so no agent
turn waits for the box.

submit: start_image with a fresh seed. status: get_image_status only. finish (run by jobs.py once it has claimed
the finished job, so overlapping polls pay for one): download the PNG and, for an IP object, remove the background,
clean the cutout and check the composition (cutout.py); a weapon's cutout is stood up on its held end; a klein edit
is checked against its reference (bedrock_image.edit_check); a bad first draw asks jobs.py for one more draw. A
throttled background removal keeps the picture at the job's key and raises, so a later finish or a retry reuses it.
collect: the image and its cutout at fixed keys per job (the chained 3D, variant or shot job reads them) plus their
asset records. A picture that still fails a check never becomes current silently: it is kept as a version, the IP
keeps its picture, and the done job's error line says so.

input: ipId, model, prompt, references (S3 keys or URLs), version, usage (object | background), subject (figure |
object), kind (the IP's), for an edit (tools.make_ip_variant) edit (the asked change) and covered (a covered head),
and for an action still asset "action_image" with its meta.
"""
from __future__ import annotations
import random
import re
import traceback

from botocore.exceptions import ClientError

from server import i18n, store, waits
from server.i18n import tr
from server.providers import cutout, mcp_client
from server.providers.bedrock_image import edit_check, grip_side, remove_background

MODELS = ("krea", "klein9")  # klein9 is the one that takes reference images
LABELS = {"krea": "Krea 2 Turbo", "klein9": "FLUX.2 klein 9B"}
# Any other model id is one the open-model scout promoted (server/agents.py): its own GPU box behind the videogen MCP
# (image_start / image_get_status), booted on demand. Same cutout, checks and versions as the built-in models.
PROMOTED_SIZE = (1216, 688)  # the storyboard box's landscape frame: IP pictures are composed for it (REFRAME)
PROMOTED_STATUS = {"queued": "RUNNING", "booting": "RUNNING", "running": "RUNNING", "done": "SUCCEEDED",
                   "failed": "FAILED"}


def promoted(model) -> bool:
    return bool(model) and model not in MODELS


def draw_model(job) -> str:
    """The model this draw of the job runs on: its own, or for the redraw of a klein edit whose check found a covered
    head turned into a face, the promoted i2i model it names (input headModel, tools.make_ip_variant)."""
    inp = job["input"]
    if inp.get("headModel") and int(job.get("redraws") or 0) and "head" in (job.get("redrawFor") or []):
        return inp["headModel"]
    return inp["model"]


REDRAWS = 1  # one more draw, with a new seed, when the first fails the composition check
# ... and another framing: the same prompt again tends to repeat the same crop
REFRAME = {"figure": "Redraw with the camera farther back: the one figure about half the frame height, wide empty "
                     "space above the head and below the feet, nobody else in the picture.",
           "object": "Redraw zoomed out: the one object small in the frame, at most two thirds of the frame width, "
                     "with a wide empty margin on every side, nothing else in the picture."}
# An edit's redraw only moves the camera ("Redraw" drew the character anew) and names the reference's own background,
# never a plain one: left unnamed or called plain, the redraw replaced the scenery.
SAME_BACKGROUND = " on the same background as in the reference image"  # left out of a redraw that asked for a backdrop
REFRAME_EDIT = {"figure": "Also pull the camera back: the same figure as in the reference image, about half the frame "
                          f"height, wide empty space above the head and below the feet{SAME_BACKGROUND}, "
                          "nobody else in the picture.",
                "object": "Also zoom out: the same object as in the reference image, small in the frame, at most two "
                          f"thirds of the frame width, with a wide empty margin on every side{SAME_BACKGROUND}, "
                          "nothing else in the picture."}
# an edit's redraw (after either check failed) holds harder to its reference; the head sentence for a covered head
# never says face: naming one draws one
KEEP_HARDER = ("Keep the reference image's own background exactly as it is, with nothing added to it and nothing taken "
               "out of it, and its exact art style and rendering, with no signature, logo or text.")
# ... but not to a background the edit was asked to change (edit.backgroundAsked): that redraw keeps the style alone
KEEP_STYLE = "Keep the reference image's exact art style and rendering, with no signature, logo or text."
KEEP_HEAD = "The head stays covered exactly as in the reference image: the same closed helmet, visor, mask or robot head."
CHECK_FAILED = "구도 검사 실패"  # starts the done job's error line (tools.image_state reads it)
EDIT_FAILED = "수정 검사 실패"  # ... when an edit changed more than asked (bedrock_image.edit_check)
# background-removal errors that pass (throttled, a quota, a Bedrock 5xx); any other refusal (ValidationException,
# content moderation) answers the same every time
PASSING = {"ThrottlingException", "TooManyRequestsException", "ServiceQuotaExceededException",
           "ServiceUnavailableException", "InternalServerException", "ModelNotReadyException", "ModelTimeoutException"}
# the failed job's line after jobs.py's "결과 저장을 반복 실패했습니다: " when they outlast its retries; the picture
# waits at the job's key, so 다시 시도 finishes it instead of drawing anew
REMOVER_DOWN = "배경 제거가 잠시 응답하지 않아 배경을 지운 그림을 만들지 못했습니다. 다시 시도하면 그려 둔 그림으로 이어서 만듭니다."
SAVED = "saved"  # the externalId of a retried job whose picture already waits at its key: no new draw


class RemoverDown(RuntimeError):
    """Background removal did not answer (PASSING): jobs.py finishes the same picture again after a backoff."""


def image_key(session_id: str, job_id: str) -> str:
    return f"sessions/{session_id}/{job_id}.png"


def cutout_key(session_id: str, job_id: str) -> str:
    return f"sessions/{session_id}/{job_id}-cutout.png"


def check_name(check) -> str:
    """Which check a failed picture's record names: the edit check when that one failed, else the composition check."""
    return EDIT_FAILED if (check.get("edit") or {}).get("ok") is False else CHECK_FAILED


# How a check note ends, in the screen's speech level and by the button's own name. web/src/types.ts jobNote says
# the same three endings and reads the same pattern (locked by test_round21_copy.py).
KEPT_END = "새 그림(v{drew})은 버전 기록에만 두고 지금 그림(v{kept})을 그대로 써요."
USED_END = "이 그림(v{drew})을 ‘이 버전 쓰기’로 지금 그림으로 쓰고 있어요."
MOVED_END = "새 그림(v{drew})은 버전 기록에만 있고 지금 그림은 다른 버전(v{current})이에요."


def check_note(check, draws=1, version=None, kept=None) -> str:
    """What 작업 현황 and the agent are told about a picture that failed its composition check: kept as a version
    only while the IP keeps its picture (kept = that version), or kept as an IP's first picture."""
    return (f"{check_name(check)}: {check['problem']}" + (f"({draws}번 그려도 같음). " if draws > 1 else ". ")
            + (KEPT_END.format(drew=version, kept=kept) if kept else "첫 그림이라 그대로 두었으니 다시 뽑아 주세요."))


# check_note's ending, in today's words and in the older "… 그대로 씁니다." that stored records keep
_KEPT = re.compile(r"새 그림\(v(\d+)\)은 버전 기록에만 두고 지금 그림\(v(\d+)\)을 그대로 (?:써요|씁니다)\.$")


def note_now(note, current, drew_current=False) -> str:
    """A check note as it holds now, its ending in today's words. The ending names the picture the IP kept when the
    draw was rejected; 이 버전 쓰기 or a later draw moves the IP on (current = its version now, drew_current = it now
    uses this note's own draw). Any other line comes back as it is."""
    found = _KEPT.search(note or "")
    if not found:
        return note
    drew, kept = int(found[1]), int(found[2])
    if drew_current:
        now = USED_END.format(drew=drew)
    elif not current or current == kept:
        now = KEPT_END.format(drew=drew, kept=kept)
    else:
        now = MOVED_END.format(drew=drew, current=current)
    return note[:found.start()] + now


class MediagenImageProvider:
    name = "mediagen_image"

    def submit(self, job: dict, ctx) -> str:
        inp = job["input"]
        if not int(job.get("redraws") or 0) and _saved(ctx, job):  # 다시 시도 after the remover was down
            return SAVED
        if promoted(draw_model(job)):
            return _promoted_submit(job, ctx)
        args = {"prompt": _redraw_prompt(job), "model": draw_model(job), "style": "real",
                "seed": random.randint(1, 2 ** 31 - 1)}
        if inp.get("references"):  # a key chained on another image job resolves only now, once that image exists
            args["reference_image_urls"] = [r if "://" in r else mcp_client.public_input_url(ctx, r)
                                            for r in inp["references"]]
        out = mcp_client.call_tool(ctx, mcp_client.IMAGE, "start_image", args)
        if out.get("status") == "FAILED" or not out.get("job_id"):
            raise RuntimeError(f"start_image: {out.get('error') or out}"[:300])
        return out["job_id"]

    def _status(self, job, ctx) -> dict:
        if job.get("externalId") == SAVED:  # drawn before: the picture is at the job's key
            return {"status": "SUCCEEDED", "saved": True}
        if promoted(draw_model(job)):
            st = mcp_client.call_tool(ctx, mcp_client.VIDEO, "image_get_status", {"job_id": job["externalId"]})
            raw = str(st.get("status") or "").lower()
            return {**st, "status": PROMOTED_STATUS.get(raw, "RUNNING"), "booting": raw == "booting"}
        return mcp_client.call_tool(ctx, mcp_client.IMAGE, "get_image_status", {"job_id": job["externalId"]})

    def status(self, job: dict, ctx) -> tuple:
        st = self._status(job, ctx)
        if st.get("status") == "FAILED":
            return ("failed", f"이미지 생성 실패: {st.get('error') or '원인 미상'}"[:300])
        if st.get("status") != "SUCCEEDED":
            # What is being done, never the model's name (that is on the job's record, for the card's tooltip)
            if st.get("booting"):  # with the one ETA the chat gave, boot included (waits.py)
                eta = job["input"].get("etaMinutes") or waits.promoted_image_eta()
                return ("running", f"정지된 GPU 서버 켜는 중 · 보통 ~{eta}분")
            return ("running", "그림 그리는 중 (GPU 대기 포함)")
        if not st.get("url") and not st.get("saved"):
            return ("failed", "이미지 결과 URL이 없습니다")
        job["_st"] = st  # in memory: the poll that claims the collection finishes it in the same _settle pass
        return ("done", "")

    def finish(self, job: dict, ctx) -> str:
        """The paid part, after jobs.py claimed the collection. → "" to collect it, or why to draw once more."""
        made = job["_made"] = self._finish(job, ctx, job.get("_st") or self._status(job, ctx))
        check = made.get("check")
        if _redraw(job, check):
            failed = made.get("failed") or ["composition"]
            job["redrawFor"] = failed  # what the redraw fixes (_redraw_prompt), kept on the job for its submit
            store.update_job(ctx, job["pk"].split("#")[1], job["jobId"], redrawFor=failed)
            label = "구도를 다시 그리는 중" if "composition" in failed else "수정 검사에 걸려 다시 그리는 중"
            return f"{label}: {check['problem']}"
        return ""

    def _finish(self, job, ctx, st) -> dict:
        inp = job["input"]
        key = image_key(job["pk"].split("#")[1], job["jobId"])
        image = (ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=key)["Body"].read() if st.get("saved")
                 else mcp_client.download(st["url"]))
        made = {"image": image, "seed": st.get("seed")}
        if inp.get("asset", "image") == "image" and inp.get("usage") != "background":
            try:
                cut = remove_background(ctx, made["image"])
            except ClientError as e:
                if e.response.get("Error", {}).get("Code") in PASSING:  # a throttle or an outage: the picture
                    # waits at its key, and jobs.py finishes it again after a backoff, or fails with REMOVER_DOWN
                    ctx.s3.put_object(Bucket=ctx.assets_bucket, Key=key, Body=made["image"], ContentType="image/png")
                    raise RemoverDown(REMOVER_DOWN) from e
                traceback.print_exc()  # refused for good: kept whole (the 3D worker removes a plain backdrop itself)
                made["cutout"], made["check"] = made["image"], None
            else:
                made["cutout"], made["check"] = cutout.prepare(cut, inp.get("subject", "object"))
            if inp.get("edit") and inp.get("references"):
                _check_edit(ctx, inp, made)
            if made["cutout"] is not made["image"] and inp.get("kind") == "weapon":  # checked as drawn (lying
                # along the frame), stood up for 3D and games; the grip is asked of a kept draw only
                grip = None if _redraw(job, made["check"]) else grip_side(ctx, made["image"])
                made["cutout"] = cutout.stand_up(made["cutout"], grip)
        return made

    def collect(self, job: dict, ctx) -> list:
        made = job.get("_made") or self._finish(job, ctx, job.get("_st") or self._status(job, ctx))
        session_id, inp = job["pk"].split("#")[1], job["input"]
        key = image_key(session_id, job["jobId"])
        ctx.s3.put_object(Bucket=ctx.assets_bucket, Key=key, Body=made["image"], ContentType="image/png")
        meta = {"prompt": inp["prompt"], "model": draw_model(job),
                **({"references": inp["references"]} if inp.get("references") else {}),
                **({"edit": inp["edit"], "covered": bool(inp.get("covered"))} if inp.get("edit") else {}),
                # an edit's description after the change: shots of the IP describe this version
                **({"description": inp["description"]} if inp.get("description") else {}),
                **({"seed": made["seed"]} if made.get("seed") is not None else {})}
        image = {"assetId": store.new_id("ast"), "kind": inp.get("asset", "image"), "key": key, "contentType": "image/png"}
        if image["kind"] == "action_image":  # a still under the IP: no cutout, the IP's own image stays
            return [{**image, "meta": {**meta, **(inp.get("meta") or {})}}]
        meta["version"] = _landing_version(ctx, job, session_id, int(inp.get("version") or 1))
        if made.get("check"):
            meta["check"] = {**made["check"], **({"redraws": job["redraws"]} if job.get("redraws") else {})}
        background = inp.get("usage") == "background"  # the scene is kept whole: the "cutout" is the same picture
        ckey = cutout_key(session_id, job["jobId"])
        ctx.s3.put_object(Bucket=ctx.assets_bucket, Key=ckey, Body=made["image"] if background else made["cutout"],
                          ContentType="image/png")
        if made.get("check") and not made["check"]["ok"]:  # still failing after its redraw
            image["key"], ckey = _flag(ctx, job, session_id, key, ckey, meta["version"], made["check"])
        return [{**image, "meta": meta},
                {"kind": "cutout", "key": ckey, "contentType": "image/png",
                 "meta": {"forAssetId": image["assetId"], **({"backgroundPreserved": True} if background else {})}}]


def _promoted_submit(job, ctx) -> str:
    """image_start on the videogen MCP for a promoted model: references as image_urls (i2i), a fresh seed."""
    inp = job["input"]
    args = {"model": draw_model(job), "prompt": _redraw_prompt(job), "width": PROMOTED_SIZE[0],
            "height": PROMOTED_SIZE[1], "seed": random.randint(1, 2 ** 31 - 1)}
    if inp.get("references"):
        args["image_urls"] = [r if "://" in r else mcp_client.public_input_url(ctx, r) for r in inp["references"]]
    out = mcp_client.call_tool(ctx, mcp_client.VIDEO, "image_start", args)
    if not out.get("job_id"):
        raise RuntimeError(f"image_start: {out.get('error') or out}"[:300])
    return out["job_id"]


def _redraw_prompt(job) -> str:
    """The prompt a draw is sent with: a redraw adds another framing when the composition failed, and an edit's
    redraw also holds harder to its reference (KEEP_HARDER, and KEEP_HEAD for a covered head)."""
    inp = job["input"]
    if not int(job.get("redraws") or 0):
        return inp["prompt"]
    failed = job.get("redrawFor") or ["composition"]  # a job from before redrawFor was a composition redraw
    asked = "backgroundAsked" in failed  # the edit's own change is the backdrop: the redraw does not take it back
    extra = []
    if "composition" in failed:
        reframe = (REFRAME_EDIT if inp.get("references") else REFRAME).get(inp.get("subject"))
        extra.append(reframe.replace(SAME_BACKGROUND, "") if reframe and asked else reframe)
    if inp.get("edit") and inp.get("references"):
        extra += ([KEEP_HEAD] if inp.get("covered") or "head" in failed else []) + [KEEP_STYLE if asked else KEEP_HARDER]
    extra = [e for e in extra if e]
    return f"{inp['prompt'].rstrip(' .')}. {' '.join(extra)}" if extra else inp["prompt"]  # sentences of their own


def _check_edit(ctx, inp, made) -> None:
    """One vision call on a landed klein edit: its reference and the draw to bedrock_image.edit_check. The verdict
    joins the composition check under "edit" (made["check"] is ok only when both pass, their problems joined), and
    made["failed"] names what failed, for the redraw ("head": the reference shows a covered head). An unanswered
    check leaves the draw unchecked (edit {"checked": false}): it lands."""
    ref = inp["references"][0]
    try:
        reference = (mcp_client.download(ref) if "://" in ref
                     else ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=ref)["Body"].read())
    except Exception:  # the reference is gone: nothing to compare with
        traceback.print_exc()
        reference = b""
    verdict = edit_check(ctx, reference, made["image"], inp["edit"]) if reference else None
    comp = made.get("check")
    if verdict is None:  # (a draw with no composition check either stays unchecked as a whole)
        made["check"] = {**comp, "edit": {"checked": False}} if comp else None
        return
    failed = [name for name, check in (("composition", comp), ("edit", verdict)) if check and not check["ok"]]
    # "backgroundAsked": the edit's own change is the backdrop, which the redraw must not take back (_redraw_prompt)
    made["failed"] = (failed + (["head"] if failed and verdict["headCovered"] else [])
                      + (["backgroundAsked"] if failed and verdict.get("backgroundAsked") else []))
    made["check"] = {**(comp or {}), "ok": not failed, "edit": verdict,
                     "problem": ", ".join(c["problem"] for c in (comp, verdict) if c and not c["ok"] and c["problem"])}


def _redraw(job, check) -> bool:
    """A first draw that failed its composition or edit check is drawn once more (its cutout is never used)."""
    return bool(check) and not check["ok"] and int(job.get("redraws") or 0) < REDRAWS


def _saved(ctx, job) -> bool:
    """Whether the job's picture already waits at its key (_finish keeps it there while background removal is down),
    so a 다시 시도 finishes that picture instead of drawing a new one."""
    try:
        ctx.s3.head_object(Bucket=ctx.assets_bucket, Key=image_key(job["pk"].split("#")[1], job["jobId"]))
    except ClientError:
        return False
    return True


def _landing_version(ctx, job, session_id, version) -> int:
    """The version a landing draw is saved as. A draw that never landed takes no number (tools._next_version), so a
    failed one retried later (다시 시도) may find its number taken by a newer draw: it lands as the next free one, and
    as a version only while the IP shows that newer draw or a later one (_keep_ip), never rolling the IP back."""
    snap = store.snapshot(ctx, session_id)
    ip_id = job["input"].get("ipId")
    taken = {int((a.get("meta") or {}).get("version") or 1) for a in snap["assets"]
             if a.get("kind") == "image" and a.get("ipId") == ip_id and a.get("jobId") != job["jobId"]}
    if version not in taken:
        return version
    ip = next((i for i in snap["ips"] if i["ipId"] == ip_id), None) or {}
    current = int(ip.get("version") or 1)
    coming = [int(j["input"]["version"]) for j in snap["jobs"] if j["jobId"] != job["jobId"] and j["kind"] == "image"
              and j["status"] in ("queued", "running") and j["input"].get("ipId") == ip_id and "version" in j["input"]]
    if current >= version:
        job["_keep_ip"] = True
    return max([*taken, *coming, current]) + 1


def _flag(ctx, job, session_id, key, ckey, version, check) -> tuple:
    """A draw that still fails its check never becomes the IP's picture silently. The IP keeps the picture it has:
    the draw moves to keys of its own as a version only, the fixed keys get the kept picture (the chained jobs read
    those) and jobs.py leaves the IP's links alone (_keep_ip). An IP's first picture is kept. Either way the done
    job's error line (_note) says so. → the draw's (image key, cutout key)."""
    draws = int(job.get("redraws") or 0) + 1
    snap = store.snapshot(ctx, session_id)
    ip = next((i for i in snap["ips"] if i["ipId"] == job["input"].get("ipId")), None) or {}
    assets = {a["assetId"]: a for a in snap["assets"]}
    kept = [assets.get(ip.get(field) or "") for field in ("imageAssetId", "cutoutAssetId")]
    if not all(kept):
        job["_note"] = check_note(check, draws)
        return key, ckey
    moved = [f"sessions/{session_id}/{job['jobId']}-v{version}{end}" for end in (".png", "-cutout.png")]
    for src, dst in ((key, moved[0]), (ckey, moved[1]), (kept[0]["key"], key), (kept[1]["key"], ckey)):
        ctx.s3.copy_object(CopySource={"Bucket": ctx.assets_bucket, "Key": src}, Bucket=ctx.assets_bucket, Key=dst)
    job["_note"], job["_keep_ip"] = check_note(check, draws, version, int(ip.get("version") or 1)), True
    if job["input"].get("edit"):  # said in chat too, in the session's language (i18n.remember), never a poll's
        job["_chat"] = rejected_message(job, ip, version, check, i18n.norm((snap.get("session") or {}).get("lang")))
    return moved[0], moved[1]


def rejected_message(job, ip, version, check, lang: str = "ko") -> str:
    """The chat line for an edit kept out of the IP: which version was rejected, why, and what can be tried next.
    The agent reads "다른 모델로 다시" and "기본 모델로 다시" (prompts.py, make_ip_variant)."""
    inp, kept = job["input"], int(ip.get("version") or 1)
    if promoted(draw_model(job)):
        then = tr("바꿀 점을 더 좁혀 다시 요청하거나, ‘기본 모델로 다시 수정해줘’라고 말해 주세요.", lang)
    elif inp.get("headModel"):
        then = tr("바꿀 점을 더 좁혀 다시 요청하거나, ‘다른 모델로 다시 수정해줘’라고 말해 주세요.", lang)
    else:
        then = tr("바꿀 점을 더 좁혀 다시 요청해 주세요(예: ‘배경은 그대로 두고 망토만 빨갛게’).", lang)
    return tr("{name}의 수정한 그림(v{version})은 수정 검사를 통과하지 못해 쓰지 않았어요. 이유: {problem}. "
              "지금 그림(v{kept})은 그대로예요. 새 그림도 카드의 버전 기록에 있어서, 마음에 들면 거기서 골라 쓸 수 있어요. "
              "{then}", lang, name=ip.get("name") or "IP", version=version, problem=i18n.problem(check["problem"], lang),
              kept=kept, then=then)
