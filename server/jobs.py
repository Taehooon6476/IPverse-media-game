"""Job engine: Job items move queued → running → done|failed.

advance_jobs() runs on every GET /sessions/{id} and on the scheduled tick (advance_active, every minute); several
polls can overlap, so every write is optimistic: conditioned on the `rev` this invocation loaded, and skipped when
another invocation got there first. A `running` job without `externalId` is owned by whoever is submitting or
collecting it; everyone else leaves it alone and fails it once it is stale. Sync providers (ffmpeg) work inside
submit(), so a poll only claims them and self-invokes `run_job`; the render never runs inside a request.
A throttled or GPU-busy submit puts the job back to queued with a backoff. A finished picture is never drawn again
because saving it failed: the claim goes back and a later poll collects the same result.
"""
from __future__ import annotations
import json
import time
import os
import traceback
from datetime import datetime, timezone

from botocore.exceptions import ClientError

from server import game_assets, store
from server.providers import BedrockVideoProvider, DeadlineProvider, FfmpegProvider, MediagenVideoProvider
from server.providers.griptape import GriptapeDeadlineProvider
from server.providers.apose import AposeProvider
from server.providers.img3d import Img3dProvider
from server.providers.mediagen_image import MediagenImageProvider
from server.providers.rig import RigProvider, refusal as rig_refusal

# bedrock_video stays registered (no tool creates it) so older jobs still settle
PROVIDERS = {p.name: p for p in (DeadlineProvider(), BedrockVideoProvider(), FfmpegProvider(),
                                 GriptapeDeadlineProvider(), MediagenVideoProvider(), Img3dProvider(), RigProvider(), AposeProvider(),
                                 MediagenImageProvider())}
SYNC_PROVIDERS = {"ffmpeg"}
SERIAL_PROVIDERS = {"bedrock_video"}  # Luma Ray 2 async-invoke concurrency is effectively 1; mediagen is not serial
THROTTLE_CODES = {"ThrottlingException", "TooManyRequestsException", "ServiceQuotaExceededException",
                  "LimitExceededException"}
THROTTLE_GIVE_UP_SEC = 900  # counted from the first throttled submit, not from createdAt
IP_LINKS = {"turntable": "turntableAssetId", "glb": "glbAssetId", "poster": "posterAssetId",
            "rigged_glb": "riggedGlbAssetId", "pose_cutout": "poseCutoutAssetId",
            "image": "imageAssetId", "cutout": "cutoutAssetId"}  # an image job's picture becomes the IP's current one
DEP_FAILED = "선행 작업 실패"
SERIAL_WAIT = "앞선 영상 샷 대기 중"
NO_SHOTS = "성공한 영상 샷이 없습니다"
TEXT_FALLBACK = "키프레임 검열로 텍스트 기반 재생성 중"
STATUS_RETRY = "상태 확인 재시도 중"
STALE_SEC = 900  # ponytail: the Lambda's timeout (900 s, infra/stacks/core_stack.py): an owner silent this long is dead
# A failed job's `outcome` when its provider refused the work itself, so the same input fails the same way and a
# retry cannot succeed (providers/rig.py). With it `reason`: one short Korean sentence for the user. A failure that
# may pass on a retry carries neither. The web and the agent read this field, never the error sentence.
REFUSED = "refused"


def create_job(ctx, session_id: str, kind: str, provider: str, input: dict, deps: list) -> dict:
    ts = store.now()
    job = {"jobId": store.new_id("job"), "kind": kind, "provider": provider, "status": "queued",
           "input": input, "outputs": [], "deps": list(deps), "rev": 0,
           "progress": "선행 작업 대기 중" if deps else "대기 중", "createdAt": ts, "updatedAt": ts}
    store.mark_active(ctx, session_id)  # first: the scheduled advance finds the session with no tab open
    return store.put_job(ctx, session_id, job)


ADVANCE_BUDGET_SEC = 8  # a session snapshot is polled every few seconds: the rest waits for the next poll


def advance_jobs(ctx, session_id: str) -> bool:
    """One pass over the session's jobs. → whether any is still queued or running, as this pass left them."""
    by_id = {j["jobId"]: j for j in store.snapshot(ctx, session_id)["jobs"]}
    for job in by_id.values():
        _mark_refused(ctx, session_id, job)
    seen, tried = set(), set()  # tried: serial providers that already had a submit attempt this pass
    # oldest-checked first, so a budget cut never starves the same jobs (polledAt is set by _guarded's update)
    order = sorted(by_id.values(), key=lambda j: j.get("polledAt") or "")
    stop = time.monotonic() + ADVANCE_BUDGET_SEC

    def visit(job):  # deps first (createdAt can tie), so a dependent can start in the pass its deps finish
        if job["jobId"] in seen or time.monotonic() > stop:
            return
        seen.add(job["jobId"])
        for dep in job["deps"]:
            if dep in by_id:
                visit(by_id[dep])
        if job["status"] not in ("done", "failed") and time.monotonic() <= stop:
            _guarded(ctx, session_id, job, _advance, by_id, tried)
            try:  # only onto the job's own item: a session deleted during this pass gets no row back
                store.update_job(ctx, session_id, job["jobId"], expect={"jobId": job["jobId"]}, polledAt=store.now())
            except Exception:  # noqa: BLE001 — bookkeeping only
                pass

    for job in order:
        visit(job)
    return any(j["status"] in ("queued", "running") for j in by_id.values())


def _mark_refused(ctx, session_id, job) -> None:
    """Backfill: a refused skeleton job whose record predates REFUSED gets the field once, read off the line it
    failed with (rig.refusal). Only onto a record that is still that failure; nothing else of it moves."""
    if job["kind"] != "rig" or job["status"] != "failed" or job.get("outcome"):
        return
    reason = rig_refusal(job.get("error"))
    try:
        if reason and store.update_job(ctx, session_id, job["jobId"], expect={"status": "failed"},
                                       outcome=REFUSED, reason=reason):
            job.update(outcome=REFUSED, reason=reason)
    except Exception:  # noqa: BLE001 — bookkeeping only: the next poll marks it
        traceback.print_exc()


# The scheduled advance (action jobs_tick, every minute: infra/stacks/core_stack.py JobsAdvance), so a chain goes on
# with no tab open. The tick is one more poller: every write is conditioned on the job's rev (_save), so a tab's
# poll and the tick claim each step once.
TICK_BUDGET_SEC = 50  # the next tick is a minute away: what does not fit waits for it
# A mark this fresh stays even with nothing in flight: create_job writes it right before its job
ACTIVE_GRACE_SEC = 120
# A mark this old goes whatever its session holds (the longest chain is under an hour): what is still "running"
# never settles, and the tick would read that session every minute for good. Its tab still advances it.
ACTIVE_MAX_SEC = 24 * 3600


def advance_active(ctx) -> dict:
    """One pass over every session that holds a queued or running job (store.active_sessions: one read, and nothing
    else when the list is empty). A session with nothing left in flight loses its mark, unless the mark is fresh or
    was renewed while this looked (a job on its way). One session's error never stops the others'."""
    marks = store.active_sessions(ctx)
    stop, done = time.monotonic() + TICK_BUDGET_SEC, 0
    first = int(time.time() // 60) % len(marks) if marks else 0  # a list too long for one tick starts elsewhere next time
    for mark in marks[first:] + marks[:first]:
        if time.monotonic() > stop:
            break
        done += 1
        try:
            age = store.age_sec(mark["at"])
            if age > ACTIVE_MAX_SEC:
                print(f"jobs tick: session {mark['sessionId']} still holds a job a day after its last one was made; "
                      "left to its tab")
                store.clear_active(ctx, mark)
            elif not advance_jobs(ctx, mark["sessionId"]) and age > ACTIVE_GRACE_SEC:
                store.clear_active(ctx, mark)
        except Exception:  # noqa: BLE001 — tried again in a minute
            traceback.print_exc()
    return {"sessions": len(marks), "advanced": done}


RETRY_WAIT = "다시 시도 대기 중"
# outcome, reason: a job that runs again is no refusal while it runs
RESET = {"status": "queued", "error": "", "externalId": "", "statusErrorSince": "", "throttledAt": "", "outputs": [],
         "retryAt": "", "collectRetries": 0, "takenOver": False, "finishedAt": "", "outcome": "", "reason": ""}


def retry_job(ctx, session_id: str, job_id: str):
    """A failed job and every job that failed only because of it ("선행 작업 실패") go back to queued, inputs
    untouched; the next poll resubmits them in dependency order. Each records when the retry started (retriedAt):
    the card's 경과 counts from there, not from createdAt. → retried job ids, or None if not failed."""
    by_id = {j["jobId"]: j for j in store.snapshot(ctx, session_id)["jobs"]}
    root = by_id.get(job_id)
    if not root or root["status"] != "failed":
        return None
    todo, chain = [root], []
    while todo:
        job = todo.pop()
        if job["jobId"] in (j["jobId"] for j in chain):
            continue
        chain.append(job)
        todo += [d for d in by_id.values() if job["jobId"] in d["deps"] and d["status"] == "failed"
                 and d.get("error") == DEP_FAILED]
    store.mark_active(ctx, session_id)  # queued again: the scheduled advance takes it up (advance_active)
    # a manual retry gets the automatic GPU retries and the composition redraw again
    at = store.now()
    retried = [j for j in chain if _save(ctx, session_id, j, autoRetries=0, redraws=0, retriedAt=at,
                                         **(TAKE_OVER if _takes_over(j) else {**RESET, "progress": RETRY_WAIT}))]
    for j in retried:  # a mesh takes its place in the GPU line again, with the ticket it was requested with
        register = getattr(PROVIDERS[j["provider"]], "register", None)
        if register and j.get("lineTicket"):
            register(ctx, session_id, j)
    return [j["jobId"] for j in retried]


CANCELED = "사용자가 중지함"
DEADLINE_PROVIDERS = {"deadline", "griptape_deadline"}
# 다시 시도 of a stopped GPU shot: the video MCP has no cancel tool, so the stopped run keeps going on its box.
# Within this long of 중지 the retry polls that run instead of queueing behind it; if it fails after all, the retry
# submits afresh (_settle).
TAKE_OVER_SEC = 1800
TAKEN_OVER = "중지 전 GPU 작업 이어받는 중"
TAKEN_OVER_MARK = "이어받음"  # leads every running line of the taken-over run
TAKE_OVER = {"status": "running", "error": "", "progress": TAKEN_OVER, "takenOver": True, "statusErrorSince": "",
             "retryAt": "", "collectRetries": 0}


def _takes_over(job) -> bool:
    return (job["provider"] == "mediagen_video" and job.get("error") == CANCELED and bool(job.get("externalId"))
            and store.age_sec(job["updatedAt"]) <= TAKE_OVER_SEC)


def cancel_job(ctx, session_id: str, job_id: str):
    """Stops a queued or running job: it fails as "사용자가 중지함" (so 다시 시도 works, and its dependents fail
    as "선행 작업 실패" on the next poll). A Deadline Cloud job is canceled there too; other providers (GPU boxes,
    queues) may finish their work, but the result is dropped because the job is no longer running. A mediagen GPU
    shot keeps its externalId, so a retry soon after takes the run over (_takes_over).
    → True, or None if the job is not active. Retries once if a poll moved the job meanwhile."""
    for _ in range(2):
        job = store.get_job(ctx, session_id, job_id)
        if not job or job["status"] not in ("queued", "running"):
            return None
        if _save(ctx, session_id, job, status="failed", error=CANCELED, progress=""):
            break
    else:
        return None
    if job["provider"] in DEADLINE_PROVIDERS and job.get("externalId"):
        try:
            ctx.deadline.update_job(farmId=ctx.deadline_farm_id, queueId=ctx.deadline_queue_id,
                                    jobId=job["externalId"], targetTaskRunStatus="CANCELED")
        except ClientError:
            traceback.print_exc()  # already finished there: nothing to stop
    return True


def run_job(ctx, session_id: str, job_id: str) -> None:
    """The `run_job` self-invocation: run a claimed sync job (the ffmpeg trailer render) to the end."""
    job = store.get_job(ctx, session_id, job_id)
    if job and job["provider"] in SYNC_PROVIDERS and job["status"] == "running" and not job.get("externalId"):
        _guarded(ctx, session_id, job, _run)  # else: finished, failed, or a duplicate delivery


def _guarded(ctx, session_id, job, step, *args) -> None:
    job["pk"] = f"SESSION#{session_id}"  # providers derive the session from pk
    try:
        step(ctx, session_id, job, *args)
    except Exception as e:  # a provider/client error ends the job (if we still own it), never the poll
        traceback.print_exc()
        _save(ctx, session_id, job, status="failed", error=str(e) or type(e).__name__, progress="")


def _save(ctx, session_id, job, **fields) -> bool:
    """Optimistic write: only if the job is still at the rev we hold. False → someone else moved it."""
    rev = job.get("rev", 0)
    fields.update(rev=rev + 1, updatedAt=store.now())
    if not store.update_job(ctx, session_id, job["jobId"], expect={"rev": rev}, **fields):
        return False
    job.update(fields)
    return True


def _advance(ctx, session_id, job, by_id, tried) -> None:
    provider = PROVIDERS[job["provider"]]
    if (job.get("retryAt") or "") > store.now():  # a GPU-busy or result-save retry waits out its backoff (ISO sorts)
        return
    if job["status"] == "queued":
        verdict, inp = _deps_ready(job, by_id)
        if verdict == "wait":
            return
        if verdict != "go":
            _save(ctx, session_id, job, status="failed", error=verdict, progress="")
            return
        hold = getattr(provider, "hold", None)  # img3d's GPU line
        held = hold(ctx, session_id, job) if hold else ""
        if held:  # a mesh requested earlier, in any session, goes to the GPU queue first
            if job["progress"] != held:
                _save(ctx, session_id, job, progress=held)
            return
        if job["provider"] in SERIAL_PROVIDERS:  # one at a time per session, one attempt per pass
            if job["provider"] in tried or any(o["provider"] == job["provider"] and o["status"] == "running"
                                               for o in by_id.values()):
                if job["progress"] != SERIAL_WAIT:
                    _save(ctx, session_id, job, progress=SERIAL_WAIT)
                return
            tried.add(job["provider"])
        changed = {"input": inp} if inp != job["input"] else {}
        # startedAt = when its work began (first run, or the run after 다시 시도): the card shows the wait and the
        # work apart. A provider with a queue of its own says when the work began (own_start: its status() leaves
        # job["_began"], kept by _settle); until then the job is sent, not started
        if getattr(provider, "own_start", False):
            changed["startedAt"] = ""
        elif not job.get("startedAt") or (job.get("retriedAt") or "") > job["startedAt"]:
            changed["startedAt"] = store.now()
        if not _save(ctx, session_id, job, status="running", progress=_noted("제출 중", inp), **changed):
            return  # another poll claimed it
        if job["provider"] in SYNC_PROVIDERS:
            ctx.lambda_.invoke(FunctionName=os.environ["SELF_FUNCTION_NAME"], InvocationType="Event",
                               Payload=json.dumps({"action": "run_job", "sessionId": session_id,
                                                   "jobId": job["jobId"]}))
            return
        try:
            external_id = provider.submit(job, ctx)
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") not in THROTTLE_CODES:
                raise
            _throttled(ctx, session_id, job)
            return
        except Exception as e:  # e.g. start_image answered "GPU server busy": queued again (submit errors only)
            if job["provider"] not in IMAGE_PROVIDERS or \
                    not _transient_retry(ctx, session_id, job, str(e) or type(e).__name__):
                raise
            traceback.print_exc()
            return
        # record the external id before status() can fail, so a running render is never lost; with it what the
        # provider keeps on the job (img3d: its GPU-queue ticket)
        if not _save(ctx, session_id, job, externalId=external_id, progress="제출됨", throttledAt="",
                     **(job.pop("_save", None) or {})):
            return
    elif job["provider"] in SYNC_PROVIDERS or not job.get("externalId"):
        if store.age_sec(job["updatedAt"]) > STALE_SEC:
            _save(ctx, session_id, job, status="failed", error="작업 처리가 중단되었습니다 (시간 초과)", progress="")
        return
    _settle(ctx, session_id, job, provider)


def _deps_ready(job, by_id):
    """→ ("wait" | "go" | error text, the input to run with). A trailer waits for every dep to end, then cuts
    the done shots only (failing if none), and drops the turntable if its 3D render failed."""
    deps = {d: by_id.get(d) or {} for d in job["deps"]}
    status = {d: dep.get("status") for d, dep in deps.items()}
    if job["kind"] != "trailer":
        if any(s in (None, "failed") for s in status.values()):
            return DEP_FAILED, None
        return ("wait" if any(s != "done" for s in status.values()) else "go"), job["input"]
    if any(s not in (None, "done", "failed") for s in status.values()):
        return "wait", None
    inp = dict(job["input"])
    shots = inp.get("shot_job_ids", [])
    done = [d for d in shots if status.get(d) == "done"]
    if shots and not done:
        return NO_SHOTS, None
    if len(done) < len(shots):
        inp["shot_job_ids"] = done
        inp["skipped_shot_job_ids"] = inp.get("skipped_shot_job_ids", []) + [d for d in shots if d not in done]
    render_failed = any(dep.get("kind") == "render3d" and status[d] != "done" for d, dep in deps.items())
    if render_failed and inp.get("include_turntable_ip_id") and not inp.get("extra_asset_ids"):
        del inp["include_turntable_ip_id"]
        inp["turntable_skipped"] = True
    return "go", inp


def _noted(progress, inp) -> str:
    notes = []
    if inp.get("skipped_shot_job_ids"):
        notes.append(f"실패한 샷 {len(inp['skipped_shot_job_ids'])}개 제외")
    if inp.get("turntable_skipped"):
        notes.append("3D 회전 영상이 실패해 빼고 만듦")
    return f"{progress} ({', '.join(notes)})" if notes else progress


def _throttled(ctx, session_id, job) -> None:
    """Rate-limited submit: release the claim so a later poll retries; give up after a long throttle."""
    since = job.get("throttledAt") or store.now()
    if store.age_sec(since) > THROTTLE_GIVE_UP_SEC:
        _save(ctx, session_id, job, status="failed", error="요청 한도로 제출을 반복 실패했습니다", progress="")
    else:
        _save(ctx, session_id, job, status="queued", progress="요청 한도 대기 중", throttledAt=since)


def _run(ctx, session_id, job) -> None:
    verdict, inp = _deps_ready(job, {j["jobId"]: j for j in store.snapshot(ctx, session_id)["jobs"]})
    if verdict != "go":
        _save(ctx, session_id, job, status="queued", progress="선행 작업 대기 중")  # the next poll decides
        return
    changed = {"input": inp} if inp != job["input"] else {}
    if not _save(ctx, session_id, job, externalId="local", progress=_noted("렌더링 중", inp), **changed):
        return  # a duplicate run_job started first
    provider = PROVIDERS[job["provider"]]
    _bind_turntable(ctx, session_id, job)
    provider.submit(job, ctx)  # ffmpeg renders here and keeps its result on this dict
    _settle(ctx, session_id, job, provider, owned=True)


def _finished_at(job):
    """When the job's work ended, as its provider says it (status() leaves job["_ended"] with its final state), in
    the store's form: a job is settled only by the poll that notices it, which can be minutes later. None when the
    provider says nothing, or a time outside the job's own run: updatedAt stands."""
    raw = job.pop("_ended", None)
    try:
        t = raw if isinstance(raw, datetime) else datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    t = (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    ended = t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"  # like store.now()
    began = job.get("startedAt") or job.get("retriedAt") or job.get("createdAt") or ""
    return ended if began <= ended <= store.now() else None


def _settle(ctx, session_id, job, provider, owned=False) -> None:
    """status() → progress | failed | collect. Polls must claim the collection; run_job already owns it.
    A poll's status() error is retried (the external render is likely still fine) until STALE_SEC passes.
    Only the claimer runs a provider's paid finish (background removal) and its collect; when an image job's
    result cannot be saved, the claim goes back with a backoff (_collect_retry)."""
    if owned:
        state, progress = provider.status(job, ctx)
    else:
        try:
            state, progress = provider.status(job, ctx)
        except Exception as e:
            traceback.print_exc()
            since = job.get("statusErrorSince") or store.now()
            if store.age_sec(since) > STALE_SEC:
                _save(ctx, session_id, job, status="failed", progress="",
                      error=f"상태 확인을 반복 실패했습니다: {(str(e) or type(e).__name__)[:200]}")
            elif job.get("progress") != STATUS_RETRY or not job.get("statusErrorSince"):
                _save(ctx, session_id, job, progress=STATUS_RETRY, statusErrorSince=since)
            return
    cleared = {"statusErrorSince": ""} if job.get("statusErrorSince") else {}
    # When the provider's box took the job (own_start), kept once with whatever this poll saves. Never before the job
    # was asked for or retried: a stopped run still on the box answers for its retry
    began, start = job.pop("_began", None), {}
    if began and not job.get("startedAt"):
        start["startedAt"] = max(began, job.get("retriedAt") or job["createdAt"])
    ended = _finished_at({**job, **start, "_ended": job.pop("_ended", None)})
    end = {"finishedAt": ended} if ended else {}  # kept with the done or failed write: the card's 작업 ends there
    if state == "running":
        if job.get("takenOver"):  # keep a marker on every line of the taken-over run
            progress = f"{TAKEN_OVER_MARK} · {progress}" if progress else TAKEN_OVER
        _save(ctx, session_id, job, progress=progress, **cleared, **start)
        return
    if state == "failed":
        if job.get("takenOver"):  # the stopped run a retry took over failed: the retry is a fresh submit after all
            _save(ctx, session_id, job, **RESET, progress=RETRY_WAIT)
            return
        if not owned and _text_fallback(ctx, session_id, job, provider, progress):
            return
        if _transient_retry(ctx, session_id, job, progress):
            return
        # The provider refused the work itself (status() leaves job["_refused"], the reason as people read it)
        refused = {"outcome": REFUSED, "reason": job["_refused"]} if job.get("_refused") else {}
        _save(ctx, session_id, job, status="failed", error=progress or "작업 실패", progress="", **start, **end, **refused)
        return
    external_id = job["externalId"]
    if not owned and not _save(ctx, session_id, job, externalId="", progress="결과 저장 중", **cleared, **start):
        return  # another poll is collecting it
    # the claim blanked externalId in the table (and on this dict); providers collect by it, so give it back
    # in memory only. The done write below persists it again.
    job["externalId"] = external_id
    finish = getattr(provider, "finish", None)
    try:
        redraw = finish(job, ctx) if finish else ""
        collected = [] if redraw else provider.collect(job, ctx)
    except Exception as e:
        if job["provider"] not in IMAGE_PROVIDERS:
            raise
        traceback.print_exc()
        _collect_retry(ctx, session_id, job, external_id, str(e) or type(e).__name__)
        return
    if redraw:  # the result failed the provider's check: one more draw, its dependents keep waiting
        _save(ctx, session_id, job, **RESET, redraws=int(job.get("redraws") or 0) + 1, progress=redraw)
        return
    ip_id = job["input"].get("ipId")
    outputs, links, linked = [], {}, []
    for found in collected:
        asset = store.put_asset(ctx, session_id, {**found, "jobId": job["jobId"], **({"ipId": ip_id} if ip_id else {})})
        outputs.append(asset["assetId"])
        if ip_id and asset["kind"] in IP_LINKS:
            links[IP_LINKS[asset["kind"]]] = asset["assetId"]
            linked.append(asset["key"])
            if asset["kind"] == "image":  # the new picture is the IP's current version
                links["version"] = int(asset["meta"].get("version") or 1)
    if "version" in links and links["version"] < int((store.get_ip(ctx, session_id, ip_id) or {}).get("version") or 1):
        links = {}  # an older request retried after a newer version landed: kept as a version, not made current
    if job.get("_keep_ip"):  # a draw that failed the provider's check (mediagen_image): a version, the IP keeps its own
        links = {}
    extra = job["input"].get("ipLinks") or {}
    if links and extra:  # render_3d rig_only on an earlier mesh: that mesh is current again together with its new rig
        links.update(extra)
        keys = {a["assetId"]: a["key"] for a in store.snapshot(ctx, session_id)["assets"]}
        linked += [keys[i] for i in extra.values() if i in keys]
    if links:  # one write: the IP never points at an image without its cutout
        store.update_ip(ctx, session_id, ip_id, **links)
    # The provider's note is 작업 현황's error line. With it `outcome`, so a done job that was no success is told
    # without parsing that line: "rejected" = the result was kept out and what was there stays (_keep_ip),
    # "check_failed" = the result, or the provider's stand-in for it, is in use although its check failed
    flagged = {"error": job["_note"], "outcome": "rejected" if job.get("_keep_ip") else "check_failed"} \
        if job.get("_note") else {}
    saved = _save(ctx, session_id, job, externalId=external_id, status="done", outputs=outputs, progress="", **end,
                  **flagged)
    if saved and job.get("_chat"):  # what the chat must hear of it (a rejected edit, mediagen_image._flag): once
        store.put_message(ctx, session_id, "assistant", job["_chat"], "done")
    if links:  # the session's games made with the IP's older files take the new ones (never fails this job)
        game_assets.after_job(ctx, session_id, linked)


TRANSIENT = ("box was stopped", "box stopped", "instance stopped", "connection reset", "timed out", "boot",
             "insufficientinstancecapacity", "insufficient capacity")  # the GPU box comes back; the shot is not wrong
AUTO_RETRIES = 2
IMAGE_PROVIDERS = {"mediagen_image", "apose"}  # the shared image GPU box (Krea / klein)
BUSY = ("busy", "try again later", "mcp http 5", "urlopen error", "remote end closed")  # its proxy: busy or a blip
IMAGE_RETRIES = 2  # 3 tries: ~30 min when every try waits out the proxy's 10 minutes
RETRY_BACKOFF_SEC = 30  # doubled per try; the proxy itself already waited up to 10 min before saying "busy"
CAPACITY_BACKOFF_SEC = 120  # a shot's stopped GPU box found no EC2 capacity: asking again at once gets the same answer
# A finished image that could not be saved: 5 tries over ~7.5 min (waits 30, 60, 120, 240 s), then failed
COLLECT_RETRIES = 4


def _collect_retry(ctx, session_id, job, external_id, error) -> None:
    """Saving a finished image or A-pose failed (the download timed out, the proxy blipped, Bedrock throttled the
    background removal): give the claim back with a backoff, so a later poll collects the same GPU result. Drawing it
    again would cost a GPU job and give a different picture. Failed after COLLECT_RETRIES retries."""
    tries = int(job.get("collectRetries") or 0)
    if tries >= COLLECT_RETRIES:
        _save(ctx, session_id, job, status="failed", externalId=external_id, progress="",
              error=f"결과 저장을 반복 실패했습니다: {error[:200]}")
        return
    wait = RETRY_BACKOFF_SEC * 2 ** tries
    _save(ctx, session_id, job, externalId=external_id, collectRetries=tries + 1, retryAt=store.now(wait * 1000),
          progress=f"결과 저장 실패, {wait}초 뒤 다시 시도 ({tries + 1}/{COLLECT_RETRIES})")


def _transient_retry(ctx, session_id, job, failure) -> bool:
    """A GPU job lost to the box (stopped mid-job, rebooting, a dropped connection) goes back to the queue, at most
    AUTO_RETRIES times for a shot; an image or A-pose job also when the shared image box was busy, IMAGE_RETRIES times
    with a backoff. Its dependents (a trailer, a 3D chain) keep waiting instead of failing. True = re-queued."""
    text = (failure or "").lower()
    image = job["provider"] in IMAGE_PROVIDERS
    if not (image or job["provider"] == "mediagen_video") or not any(t in text for t in TRANSIENT + (BUSY if image else ())):
        return False
    tries, limit = int(job.get("autoRetries") or 0), IMAGE_RETRIES if image else AUTO_RETRIES
    if tries >= limit:
        return False
    if not image and "insufficient" in text:  # no capacity: wait 2, then 4 min
        wait = CAPACITY_BACKOFF_SEC * 2 ** tries
        return _save(ctx, session_id, job, **{**RESET, "retryAt": store.now(wait * 1000)}, autoRetries=tries + 1,
                     progress=f"GPU 용량 부족, {wait}초 뒤 다시 시도 ({tries + 1}/{AUTO_RETRIES})")
    if not image:
        return _save(ctx, session_id, job, **RESET, autoRetries=tries + 1,
                     progress=f"GPU 서버가 작업을 놓쳐 다시 시도 중 ({tries + 1}/{AUTO_RETRIES})")
    wait = RETRY_BACKOFF_SEC * 2 ** tries
    return _save(ctx, session_id, job, **{**RESET, "retryAt": store.now(wait * 1000)}, autoRetries=tries + 1,
                 progress=f"이미지 GPU가 바빠 {wait}초 뒤 다시 시도 ({tries + 1}/{limit})")


def _text_fallback(ctx, session_id, job, provider, failure) -> bool:
    """Luma moderation rejected the keyframe: resubmit the same job once as text-to-video. True = handled.
    The job is already its session's running video job, so resubmitting in place keeps serialization."""
    fallback_input = getattr(provider, "fallback_input", None)
    if not fallback_input or "moderation" not in (failure or "").lower():
        return False
    ip_id = job["input"].get("ipId")
    ip = (store.get_ip(ctx, session_id, ip_id) if ip_id else None) or {}
    inp = fallback_input(job["input"], failure, ip.get("description", ""))
    if not inp:
        return False
    # claim (externalId "" = owned, other polls leave it alone) before resubmitting
    if not _save(ctx, session_id, job, input=inp, externalId="", progress=TEXT_FALLBACK):
        return True  # another poll is handling it
    try:
        external_id = provider.submit(job, ctx)
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") not in THROTTLE_CODES:
            raise
        _throttled(ctx, session_id, job)  # a later poll resubmits with the text-to-video input
        return True
    _save(ctx, session_id, job, externalId=external_id, progress=TEXT_FALLBACK, throttledAt="")
    return True


def _bind_turntable(ctx, session_id, job) -> None:
    """cut_trailer queued before the turntable existed: resolve it now, or refuse to cut without it."""
    inp = job["input"]
    ip_id = inp.get("include_turntable_ip_id")
    if not ip_id or inp.get("extra_asset_ids"):
        return
    turntable = (store.get_ip(ctx, session_id, ip_id) or {}).get("turntableAssetId")
    if not turntable:
        raise RuntimeError("3D 회전 영상이 없습니다 (만든 결과 없음)")
    inp["extra_asset_ids"] = [turntable]
