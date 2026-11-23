"""Image → textured 3D mesh (Hunyuan3D-2.1) on the IpverseImg3d GPU box.

submit: copy the cutout to img3d/in/{jobId}.png, enqueue {jobId, input_key, output_prefix, params} on SQS,
start (or relocate) the box. status: read img3d/out/{jobId}/status.json, written by the worker
(workers/img3d/worker.py); before it exists, report the box state (booting, queued). collect: copy model.glb
(+ preview.png) into the session; the GLB key is fixed per job so a chained Blender turntable can find it.

Waking: exactly one instance carries the tag ipverse=img3d. A stopped box is started; if its AZ has no g6e
capacity (or no box exists), a replacement is launched from the `ipverse-img3d` launch template across
LAUNCH_SUBNETS × LAUNCH_TYPES, and stopped leftovers are terminated once it runs. Polls overlap, so the wake goes
in rounds kept in one table item (WAKE): a poll claims one step (step 0 starts each stopped box, step k tries
launch entry k), runs it without SDK retries and leaves the next one STEP_GAP_SEC later, so a poll makes at most
one start or launch call. A round refused everywhere waits BACKOFF_SEC; a throttled call waits THROTTLE_SEC.
"""
from __future__ import annotations
import json
import os
from datetime import datetime, timezone

from botocore.exceptions import ClientError

from server import store

TAG = ("ipverse", "img3d")
# the worker's phases in plain words, after "3D 모델 만드는 중" (the card's name for this step, waits.STEP_LABEL)
PHASES = {"download": "그림 받기", "loading_models": "도구 준비", "shape": "모양 만들기",
          "texture": "색과 질감 입히기", "export": "파일 저장", "upload": "결과 올리기"}
NO_START_SEC = 7200  # no status.json two hours after submit: the box never picked it up
LAUNCH_TEMPLATE = os.environ.get("IMG3D_LAUNCH_TEMPLATE", "ipverse-img3d")
# default-VPC public subnets, in try order (us-east-1a last: it runs out of g6e capacity first)
LAUNCH_SUBNETS = os.environ.get("IMG3D_SUBNETS", "subnet-01ee633e6f81b846b,subnet-0529bb17719d70c14,"
                                "subnet-0116ede44ccc8c166,subnet-07922e1760eeb715e").split(",")
LAUNCH_TYPES = ("g6e.xlarge", "g6e.2xlarge", "g6e.4xlarge")  # one L40S each
CAPACITY_CODES = {"InsufficientInstanceCapacity", "Unsupported", "InstanceLimitExceeded"}
# a start refused because the box is no longer stopped: another poll started it, it is stopping, or a poll retired
# it (EC2 answers UnsupportedOperation for a box terminated meanwhile)
MOVED_CODES = {"IncorrectInstanceState", "UnsupportedOperation", "InvalidInstanceID.NotFound"}
STALE_HEARTBEAT_SEC = 600  # the worker rewrites status.json every 60 s while running
# the wake round, shared by every poll's Lambda: a whole try list per poll takes 9–16 s, and overlapping polls get
# the account throttled on ec2:RunInstances
WAKE = ("GPU#img3d", "WAKE")  # its table item (pk, sk): the next step, when it is due, what the last step found
STEP_GAP_SEC = 3  # between two steps, whichever polls run them
LEASE_SEC = 30  # a claimed step: other polls skip it; a poll that died in it gives it up after this
BACKOFF_SEC = 180  # a round that found no capacity anywhere: the start and the try list wait this long
THROTTLE_SEC = 30  # EC2 throttled the step's call: the same step again after this
ROUND_STALE_SEC = 600  # a round nobody stepped this long is over: the next wake starts the stopped box first
# The GPU queue: every submit takes the next send ticket (`tail` of the QUEUE item, one counter for all sessions)
# and sends it in the message; the worker writes the ticket it runs to HEAD_KEY. On the FIFO queue (one message
# group) a waiting job's place is its ticket minus the head's; a standard queue keeps no order, so no place there.
# Request order: render_3d takes a line ticket (`line`) for the mesh and enters it in `waiting` {ticket: {sid, job,
# at}}; a mesh whose deps are ready is held while an earlier ticket there still waits to be sent, for at most
# HOLD_SEC. Sending leaves `waiting`; a failed, stopped or vanished entry is pruned by whoever meets it. A retried
# mesh enters again with its own ticket. Every write is conditioned on `rev`.
QUEUE = ("GPU#img3d", "QUEUE")
HEAD_KEY = "img3d/queue/head.json"
GROUP = "img3d"  # one message group: first in, first out across every session
HOLD_SEC = 600  # an earlier mesh still waiting for its deps (image 20 s–3 min, A-pose 1–2 min) holds later ones this long
# ... nor does one whose session nobody polls: only a poll of its session sends it. A session with no tab open is
# polled by the minute tick alone (jobs.advance_active: every 60 s, up to its 50 s budget late), so the window is
# wider than two ticks can be apart
UNPOLLED_SEC = 180
HELD = "GPU 서버 순서 기다리는 중 · 앞선 요청 {n}개"
# The box's phases, measured: a start or launch to the box taking input 26–44 s; the first mesh then loads the
# models, 310–335 s on a box launched new, done by 180 s on a stopped box started again; a mesh on a warm box
# 66–120 s.
BOOT_SEC = 45  # start/launch → the worker polls
LOAD_SEC = 300  # the model load before the first mesh on a box launched new (workers/img3d/worker.py LOAD_SEC)
RELOAD_SEC = 180  # the same load on a stopped box started again
RUN_SEC = 90  # a mesh on a warm box


def _min(sec) -> int:
    return max(1, -(-int(sec) // 60))


def _starting(load) -> str:
    return f"GPU 서버 켜는 중 (켜는 데 ~{_min(BOOT_SEC)}분, 준비에 ~{_min(load)}분)"


def _booting(load) -> str:
    return f"GPU 서버 켜지는 중 (~{_min(BOOT_SEC)}분, 이어서 준비 ~{_min(load)}분)"


STARTING = _starting(RELOAD_SEC)  # a stopped box started again; a new box still pending says LOAD_SEC (_load_sec)
LAUNCHING = f"자리가 있는 곳에 GPU 서버를 새로 켜는 중 (켜는 데 ~{_min(BOOT_SEC)}분, 준비에 ~{_min(LOAD_SEC)}분)"
LOADING = "GPU 서버 준비 중"
WAITING = "GPU 서버 순서 기다리는 중"


def glb_key(session_id: str, job_id: str) -> str:
    return f"sessions/{session_id}/{job_id}.glb"


def _out_prefix(job_id: str) -> str:
    return f"img3d/out/{job_id}/"


def _age_sec(iso: str) -> float:
    try:
        return store.age_sec(iso)  # the store's clock, like the jobs' own timestamps
    except (AttributeError, ValueError):
        return 0.0


class Img3dProvider:
    name = "img3d"
    # a mesh's work begins when the box takes it, not when it is sent: status() says when (job["_began"], kept by
    # the engine as startedAt), so time in the GPU queue counts as waiting
    own_start = True

    def submit(self, job: dict, ctx) -> str:
        job_id, inp = job["jobId"], job["input"]
        input_key = f"img3d/in/{job_id}.png"
        ctx.s3.copy_object(CopySource={"Bucket": ctx.assets_bucket, "Key": inp["cutoutKey"]},
                           Bucket=ctx.assets_bucket, Key=input_key, ContentType="image/png",
                           MetadataDirective="REPLACE")
        # a retried job keeps its jobId: its last run's failed status.json would fail it again at once
        ctx.s3.delete_object(Bucket=ctx.assets_bucket, Key=f"{_out_prefix(job_id)}status.json")
        ticket = _ticket(ctx, job.get("lineTicket"))
        url = _queue_url(ctx)
        fifo = {"MessageGroupId": GROUP, "MessageDeduplicationId": f"{job_id}-{ticket or store.now()}"} \
            if url.endswith(".fifo") else {}
        ctx.sqs.send_message(QueueUrl=url, MessageBody=json.dumps({
            "jobId": job_id, "input_key": input_key, "output_prefix": _out_prefix(job_id),
            "params": inp.get("params") or {}, **({"ticket": ticket} if ticket else {})}), **fifo)
        if ticket:
            job["queueTicket"] = ticket
            job["_save"] = {"queueTicket": ticket}  # the engine stores it with the external id
        # status() runs next in the same pass: it reports this wake, since a describe right after a start can still
        # show the box stopped (in memory only, like mediagen_image's _note)
        job["_wake"] = self._wake(ctx)
        return job_id

    def status(self, job: dict, ctx) -> tuple:
        st = self._read_status(job, ctx)
        if st is None:
            state, boot_left = job.pop("_wake", None) or self._wake(ctx)
            if _age_sec(job.get("createdAt", "")) > NO_START_SEC:
                return ("failed", "GPU 작업이 시작되지 않았습니다 (시간 초과)")
            load = _load_sec(ctx)
            place, loading = self._place(job, ctx, state, boot_left, load)
            if state == "running" or loading:  # loading: a booting box already on its first mesh
                line = LOADING if loading else WAITING
                return ("running", f"{line} · {place}" if place else WAITING)
            if state == "no-capacity":
                line = "GPU 서버 자리가 없어 다시 켜 보는 중"
            elif state == "launched":
                line = LAUNCHING
            elif state == "booting":
                line = _booting(load)
            else:
                line = _starting(load) if state in ("stopped", "pending") else "GPU 서버가 꺼지는 중이라 다시 켜지기를 기다리는 중"
            return ("running", f"{line} · {place}" if place else line)
        job["_began"] = _took(st)  # in memory only, like _wake
        if st.get("status") in ("done", "failed"):  # the worker's last write is the mesh's end (jobs._finished_at)
            job["_ended"] = st.get("updatedAt")
        if st.get("status") == "done":
            return ("done", "")
        if st.get("status") == "failed":
            return ("failed", f"3D 모델을 만들지 못했습니다: {st.get('error') or '알 수 없는 오류'}"[:300])
        if _age_sec(st.get("updatedAt", "")) > STALE_HEARTBEAT_SEC:
            return ("failed", "GPU 서버가 응답하지 않습니다 (신호 끊김)")
        phase = PHASES.get(st.get("phase"), st.get("phase") or "처리")
        return ("running", f"3D 모델 만드는 중 · {phase} · {int(st.get('seconds') or 0)}초")

    def collect(self, job: dict, ctx) -> list:
        session_id = job["pk"].split("#")[1]
        job_id = job["jobId"]
        prefix = _out_prefix(job_id)
        stats = (self._read_status(job, ctx) or {}).get("stats") or {}
        # cleanup: the worker's floor-slab / flat-card removal before painting (workers/img3d/meshclean.py)
        meta = {"model": "hunyuan3d-2.1", **{k: stats[k] for k in ("vertices", "faces", "cleanup") if k in stats}}
        key = glb_key(session_id, job_id)
        _copy(ctx, f"{prefix}model.glb", key, "model/gltf-binary")
        assets = [{"kind": "glb", "key": key, "contentType": "model/gltf-binary", "meta": meta}]
        try:
            poster = f"sessions/{session_id}/{job_id}-preview.png"
            _copy(ctx, f"{prefix}preview.png", poster, "image/png")
            assets.append({"kind": "poster", "key": poster, "contentType": "image/png", "meta": {}})
        except ClientError as e:
            if _code(e) not in ("NoSuchKey", "404"):
                raise
        return assets

    # ── helpers ──
    def _read_status(self, job, ctx):
        return _read_json(ctx, f"{_out_prefix(job['jobId'])}status.json")

    def _place(self, job, ctx, state, boot_left, load):
        """→ ("대기열 N번째 · 시작까지 약 M분", the head mesh is loading the models) for a job still in the GPU queue,
        from its ticket and the head the worker wrote; "" on the standard queue, when either is missing, or when the
        head is past it. N = 1: next. A box coming up adds what is left of its boot, and for N > 1 the model load of
        the first mesh (`load` seconds on this boot); a box out of capacity, or stopping, gets no time."""
        ticket = int(job.get("queueTicket") or 0) if _queue_url(ctx).endswith(".fifo") else 0
        head = _read_json(ctx, HEAD_KEY) if ticket else None
        place = ticket - int((head or {}).get("ticket") or ticket)
        if place < 1:
            return "", False
        line = f"대기열 {place}번째"
        if state not in ("running", "booting", "stopped", "pending", "launched"):
            return line, False
        wait, loading = (place - 1) * RUN_SEC, False
        # the box can take input before BOOT_SEC is up: a head started since this boot is the box's own first mesh,
        # so what is left of it (model load included) is the wait, not the boot. One left running from before the
        # boot (a box that died mid-mesh) is not.
        started_here = state == "booting" and head.get("status") == "running" and \
            _age_sec(head.get("startedAt") or "") <= BOOT_SEC - boot_left + 5
        if state != "running" and not started_here:  # a fresh box: the first in line loads the models after the boot
            wait += boot_left + (load if place > 1 else 0)
        elif head.get("status") == "running":
            expect = int(head.get("expectSec") or RUN_SEC)
            age = _age_sec(head.get("startedAt") or store.now())
            left = expect - age
            if expect > RUN_SEC:  # the first mesh after a boot: its own line says whether it still loads
                st = _read_json(ctx, f"{_out_prefix(head.get('jobId') or '')}status.json") or {}
                loading = st.get("status") == "running" and st.get("phase") in ("download", "loading_models")
                # the worker writes LOAD_SEC for every boot: this boot's load counts. While the head loads, its mesh
                # is still to come; once it has loaded, no more than that mesh is left
                left = RUN_SEC + load - age
                left = max(left, RUN_SEC) if loading else min(left, RUN_SEC)
            wait += max(0, left)
        return f"{line} · 시작까지 약 {_min(wait)}분", loading

    def register(self, ctx, session_id: str, job: dict) -> int:
        """render_3d's mesh (and a retried one) takes its place in line: a new line ticket, or the one it was
        requested with, entered in `waiting` until it is sent. Kept on the job as lineTicket. → the ticket, or 0
        when the line item stayed contended (the mesh is then sent without holding anyone)."""
        for _ in range(5):
            rec = store._get(ctx, *QUEUE) or {}
            ticket = int(job.get("lineTicket") or 0) or int(rec.get("line") or 0) + 1
            waiting = {**(rec.get("waiting") or {}),
                       str(ticket): {"sid": session_id, "job": job["jobId"], "at": store.now()}}
            if _put_queue(ctx, rec, line=max(ticket, int(rec.get("line") or 0)), waiting=waiting):
                if job.get("lineTicket") != ticket:
                    store.update_job(ctx, session_id, job["jobId"], lineTicket=ticket)
                    job["lineTicket"] = ticket
                return ticket
        return 0

    def hold(self, ctx, session_id: str, job: dict) -> str:
        """The progress line of a mesh, ready to send, that waits for earlier requests still in `waiting`, or ""
        to send it now. Its own entry comes back first if it left (a retry). Earlier entries that failed, stopped,
        were sent or vanished are pruned; one waiting longer than HOLD_SEC no longer holds anyone."""
        ticket = int(job.get("lineTicket") or 0)
        if not ticket:
            return ""  # requested before line tickets
        rec = store._get(ctx, *QUEUE) or {}
        if str(ticket) not in (rec.get("waiting") or {}):
            self.register(ctx, session_id, job)
            rec = store._get(ctx, *QUEUE) or {}
        waiting = rec.get("waiting") or {}
        ahead, dead = 0, []
        for key, entry in waiting.items():
            if int(key) >= ticket:
                continue
            other = store.get_job(ctx, entry["sid"], entry["job"])
            if not other or other["status"] in ("done", "failed") or other.get("externalId") \
                    or int(other.get("lineTicket") or 0) != int(key):
                dead.append(key)
            elif _age_sec(entry.get("at") or "") <= HOLD_SEC and \
                    _age_sec(other.get("polledAt") or other.get("createdAt") or "") <= UNPOLLED_SEC:
                ahead += 1
        if dead:  # best effort: a lost race leaves them for the next poll
            _put_queue(ctx, rec, waiting={k: v for k, v in waiting.items() if k not in dead})
        return HELD.format(n=ahead) if ahead else ""

    def _wake(self, ctx):
        """→ (state, seconds of boot left): "running" (up past its boot) | "booting" (up for less than BOOT_SEC since
        its LaunchTime, the last start) | "pending" | "stopping" | "stopped" (start issued) | "launched" |
        "no-capacity". A pending or running box is already waking and a stopping one is waited out (a later poll
        starts it). A stopped box, or none, is woken by the round (_step)."""
        state, up = self._wake_state(ctx)
        if state != "running":
            return state, BOOT_SEC
        left = BOOT_SEC - _age_sec(up.isoformat()) if up else 0
        return ("booting", left) if left > 0 else ("running", 0)

    def _wake_state(self, ctx):
        """→ (state, LaunchTime of the running box or None)."""
        resp = ctx.ec2.describe_instances(Filters=[
            {"Name": f"tag:{TAG[0]}", "Values": [TAG[1]]},
            {"Name": "instance-state-name", "Values": ["pending", "running", "stopping", "stopped"]}])
        found = [i for r in resp.get("Reservations", []) for i in r.get("Instances", [])]
        by_state = {}
        for inst in found:
            by_state.setdefault(inst["State"]["Name"], []).append(inst["InstanceId"])
        if by_state.get("running"):
            if by_state.get("stopped"):  # a replacement is up: retire the box stranded in a full AZ
                ctx.ec2.terminate_instances(InstanceIds=by_state["stopped"])
            up = [i.get("LaunchTime") for i in found if i["State"]["Name"] == "running"]
            return "running", (up[0] if up and isinstance(up[0], datetime) else None)
        for state in ("pending", "stopping"):
            if by_state.get(state):
                return state, None
        return self._step(ctx, by_state.get("stopped", [])), None

    def _step(self, ctx, stopped):
        """One step of the wake round, by the poll that claims it in the WAKE item; every other poll meanwhile, and
        every poll while the round waits, makes no EC2 call and reports what the last step found. Step 0 starts each
        stopped box once (step 1 when there is none), step k tries launch entry k, on ec2_launch (no SDK retries:
        botocore retries every capacity refusal for ~10 s)."""
        rec = store._get(ctx, *WAKE) or {}
        due = rec.get("nextTryAt") or ""
        if due and _age_sec(due) >= ROUND_STALE_SEC:
            rec = {}  # a round nobody stepped this long is over: a new one starts the stopped box first
        found, entries = rec.get("state") or "stopped", _entries()
        step = min(int(rec.get("step") or 0), len(entries)) or (0 if stopped else 1)
        if due > store.now() or not store._update(ctx, *WAKE, {"nextTryAt": store.now(LEASE_SEC * 1000), "step": step,
                                                               "state": found}, expect={"nextTryAt": due or None}):
            return found  # another poll runs a step, or the round waits
        ec2 = getattr(ctx, "ec2_launch", None) or ctx.ec2
        try:
            state = self._start(ec2, stopped) if step == 0 else self._launch(ec2, *entries[step - 1])
        except ClientError as e:
            if _code(e) != "RequestLimitExceeded":
                self._next(ctx, step, found, 0)  # the next poll asks again, and fails as loudly
                raise
            print(f"img3d wake: EC2 throttled {e.operation_name} (RequestLimitExceeded): step {step} of the round "
                  f"again in {THROTTLE_SEC} s")
            return self._next(ctx, step, found, THROTTLE_SEC)
        if state:  # a start issued, a box launched, or another poll moved the box: the next wake starts a new round
            return self._next(ctx, 0, state, 0 if state == "pending" else STEP_GAP_SEC)
        if step < len(entries):
            return self._next(ctx, step + 1, "no-capacity", STEP_GAP_SEC)
        print(f"img3d wake: no g6e capacity in the whole round (the start, {len(entries)} launch entries): "
              f"the next round in {BACKOFF_SEC} s")
        return self._next(ctx, 0, "no-capacity", BACKOFF_SEC)

    def _next(self, ctx, step, state, wait_sec):
        """Hands the round on: `step` is due in wait_sec, polls until then report `state`. → state."""
        store._update(ctx, *WAKE, {"step": step, "state": state, "nextTryAt": store.now(wait_sec * 1000)})
        return state

    def _start(self, ec2, stopped):
        """Step 0: each stopped box once. → "stopped" (a start issued), "pending" (another poll moved a box: it is
        waking or retiring them, so no replacement for a race), or None (their AZs have no g6e capacity)."""
        moved = False
        for iid in stopped:
            try:
                ec2.start_instances(InstanceIds=[iid])
                return "stopped"
            except ClientError as e:  # its AZ has no g6e capacity: launch elsewhere, keep it until then
                if _code(e) in MOVED_CODES:
                    print(f"img3d wake: {iid} is no longer stopped ({_code(e)}): another poll moved it, "
                          "the next poll looks again")
                    moved = True
                elif _code(e) != "InsufficientInstanceCapacity":
                    raise
        return "pending" if moved else None

    def _launch(self, ec2, itype, subnet):
        """One launch entry. → "launched", or None when it has no capacity."""
        # ClientToken: overlapping polls in the same 10 minutes get the same instance, not a second one
        window = int(datetime.now(timezone.utc).timestamp() // 600)
        try:
            ec2.run_instances(LaunchTemplate={"LaunchTemplateName": LAUNCH_TEMPLATE, "Version": "$Latest"},
                              InstanceType=itype, SubnetId=subnet, MinCount=1, MaxCount=1,
                              ClientToken=f"img3d-{window}-{itype}-{subnet}")
        except ClientError as e:
            if _code(e) not in CAPACITY_CODES:
                raise
            return None
        return "launched"


def _read_json(ctx, key: str):
    """An img3d S3 JSON file, or None before it exists."""
    try:
        body = ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=key)["Body"]
    except ClientError as e:
        if _code(e) in ("NoSuchKey", "404"):
            return None
        raise
    return json.loads(body.read())


def _took(st: dict) -> str:
    """When the box took the mesh, off its status.json: with each update the worker writes how long it has had it
    (workers/img3d/worker.py put_status: seconds, updatedAt). In the store's form, like the job's own timestamps."""
    return store.now(-round(1000 * (_age_sec(st.get("updatedAt") or "") + int(st.get("seconds") or 0))))


def _load_sec(ctx) -> int:
    """The model load the first mesh takes on the box now coming up: LOAD_SEC when the wake round has just launched
    it new, RELOAD_SEC for a stopped box started again. The WAKE item keeps the round's last step until the next
    wake, so an old "launched" says nothing of this boot."""
    rec = store._get(ctx, *WAKE) or {}
    launched = rec.get("state") == "launched" and _age_sec(rec.get("nextTryAt") or "") < ROUND_STALE_SEC
    return LOAD_SEC if launched else RELOAD_SEC


def _ticket(ctx, line_ticket=None):
    """The next send ticket (1, 2, ...), shared by every session, and the mesh's line ticket out of `waiting`, in one
    conditional write that overlapping polls retry. None after 5 lost races: the job then runs without a place."""
    for _ in range(5):
        rec = store._get(ctx, *QUEUE) or {}
        tail = int(rec.get("tail") or 0) + 1
        waiting = {k: v for k, v in (rec.get("waiting") or {}).items() if k != str(line_ticket)}
        if _put_queue(ctx, rec, tail=tail, waiting=waiting):
            return tail
    return None


def _put_queue(ctx, rec: dict, **fields) -> bool:
    """One write of the QUEUE item, only if no one wrote it since `rec` was read."""
    rev = rec.get("rev")
    return store._update(ctx, *QUEUE, {**fields, "rev": int(rev or 0) + 1}, expect={"rev": rev})


def _entries() -> list:
    """The launch try list: each type in each subnet, smallest type first."""
    return [(itype, subnet) for itype in LAUNCH_TYPES for subnet in LAUNCH_SUBNETS]


def _queue_url(ctx) -> str:
    return getattr(ctx, "img3d_queue_url", "") or os.environ.get(
        "IMG3D_QUEUE_URL", "https://sqs.us-east-1.amazonaws.com/087967639890/ipverse-img3d-jobs")


def _copy(ctx, src: str, dst: str, content_type: str) -> None:
    ctx.s3.copy_object(CopySource={"Bucket": ctx.assets_bucket, "Key": src}, Bucket=ctx.assets_bucket, Key=dst,
                       ContentType=content_type, MetadataDirective="REPLACE")


def _code(e: ClientError) -> str:
    return e.response.get("Error", {}).get("Code", "")
