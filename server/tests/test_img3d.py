"""img3d provider (Hunyuan3D GPU box over SQS/S3) and the render_3d → Blender turntable chain, with fakes."""
import copy
import json
from datetime import datetime, timedelta, timezone

import pytest
from botocore.exceptions import ClientError

from server import jobs, store, tools
from server.providers import img3d
from server.providers.deadline import DeadlineProvider
from server.providers.img3d import Img3dProvider, glb_key
from server.tests.conftest import FakeDeadline, FakeS3, FakeTable, _client_error, make_ctx
from server.tests.fake_gpu import Clock, fake_time

BUCKET = "test-assets"
QUEUE = "https://sqs.us-east-1.amazonaws.com/087967639890/ipverse-img3d-jobs"
SID = "ses_1"
DESCRIBE_SEC, CALL_SEC = 0.2, 0.8  # seconds an EC2 call takes live (a refused StartInstances or RunInstances: ~0.8 s)
THROTTLED = ("Request limit exceeded. Account 087967639890 has been throttled on ec2:RunInstances because it exceeded "
             "its request rate limit.")


class S3(FakeS3):
    """FakeS3 that 404s like S3 on missing keys (the provider tells "not started yet" from that)."""

    def get_object(self, Bucket, Key):
        if (Bucket, Key) not in self._store:
            raise _client_error("NoSuchKey", "GetObject")
        return super().get_object(Bucket, Key)

    def copy_object(self, CopySource, Bucket, Key, **kwargs):
        if (CopySource["Bucket"], CopySource["Key"]) not in self._store:
            raise _client_error("NoSuchKey", "CopyObject")
        super().copy_object(CopySource, Bucket, Key, **kwargs)

    def delete_object(self, Bucket, Key):
        self._store.pop((Bucket, Key), None)


class SQS:
    """`sent`: (queue, body) per message; `fifo`: the FIFO parameters each one carried ({} on a standard queue)."""

    def __init__(self):
        self.sent, self.fifo = [], []

    def send_message(self, QueueUrl, MessageBody, **fifo):
        if fifo and not QueueUrl.endswith(".fifo"):  # SQS refuses a group id on a standard queue
            raise _client_error("InvalidParameterValue", "SendMessage")
        if QueueUrl.endswith(".fifo") and not fifo.get("MessageGroupId"):
            raise _client_error("MissingParameter", "SendMessage")
        self.sent.append((QueueUrl, json.loads(MessageBody)))
        self.fifo.append(fifo)
        return {"MessageId": "m-1"}


class EC2:
    """Tagged instances {id: state}. `state` gets/sets the original box i-img3d (None = no box).
    `stuck`: boxes whose AZ has no capacity; `full`: (type, subnet) pairs RunInstances refuses.
    `moved`: {box: (code, message)} StartInstances refuses: the box left "stopped" after the poll's describe.
    `lag`: how many describes after a start still show the box stopped (EC2 is eventually consistent).
    `starts`, `runs` and `describes` count every call, refused or not. With a `clock`, each call takes as long as
    live (DESCRIBE_SEC, CALL_SEC). `throttle`: how many of the next RunInstances EC2 refuses with RequestLimitExceeded.
    `during`: called once inside the next StartInstances or RunInstances (another poll comes in meanwhile)."""

    def __init__(self, state="stopped"):
        self.instances, self.started, self.launched, self.terminated = {}, [], [], []
        self.stuck, self.full, self.moved = set(), set(), {}
        self.starts, self.describes, self.lag, self._stale = [], 0, 0, {}
        self.runs, self.clock, self.throttle, self.during = [], None, 0, None
        self.state = state

    def _takes(self, sec):
        if self.clock:
            self.clock.sleep(sec)

    def _call(self):  # a StartInstances or RunInstances
        self._takes(CALL_SEC)
        if self.during:
            during, self.during = self.during, None
            during()

    @property
    def state(self):
        return self.instances.get("i-img3d")

    @state.setter
    def state(self, value):
        self.instances.pop("i-img3d", None)
        if value is not None:
            self.instances["i-img3d"] = value

    def describe_instances(self, Filters):
        assert {"Name": "tag:ipverse", "Values": ["img3d"]} in Filters
        self.describes += 1
        self._takes(DESCRIBE_SEC)
        seen = {}
        for i, st in self.instances.items():
            if self._stale.get(i):
                self._stale[i] -= 1
                st = "stopped"
            seen[i] = st
        return {"Reservations": [{"Instances": [{"InstanceId": i, "State": {"Name": st}}]}
                                 for i, st in seen.items() if st != "terminated"]}

    def start_instances(self, InstanceIds):
        self.starts.append(InstanceIds)
        self._call()
        if InstanceIds[0] in self.moved:
            code, message = self.moved[InstanceIds[0]]
            raise ClientError({"Error": {"Code": code, "Message": message}}, "StartInstances")
        if InstanceIds[0] in self.stuck:
            raise _client_error("InsufficientInstanceCapacity", "StartInstances")
        self.started.append(InstanceIds)
        self.instances[InstanceIds[0]] = "pending"
        self._stale[InstanceIds[0]] = self.lag

    def run_instances(self, LaunchTemplate, InstanceType, SubnetId, MinCount, MaxCount, ClientToken):
        assert LaunchTemplate == {"LaunchTemplateName": "ipverse-img3d", "Version": "$Latest"}
        self.runs.append((InstanceType, SubnetId))
        self._call()
        if self.throttle:
            self.throttle -= 1
            raise ClientError({"Error": {"Code": "RequestLimitExceeded", "Message": THROTTLED}}, "RunInstances")
        if (InstanceType, SubnetId) in self.full:
            raise _client_error("InsufficientInstanceCapacity", "RunInstances")
        iid = f"i-new{len(self.launched)}"
        self.launched.append((InstanceType, SubnetId))
        self.instances[iid] = "pending"
        return {"Instances": [{"InstanceId": iid}]}

    def terminate_instances(self, InstanceIds):
        self.terminated += InstanceIds
        for i in InstanceIds:
            self.instances[i] = "terminated"


@pytest.fixture
def ctx():
    c = make_ctx(table=FakeTable(), s3=S3(), sqs=SQS(), ec2=EC2(), deadline=FakeDeadline(), img3d_queue_url=QUEUE)
    c.s3._store[(BUCKET, f"sessions/{SID}/cut.png")] = b"PNG"
    return c


def _job(job_id="job_m1", **extra):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return {"pk": f"SESSION#{SID}", "jobId": job_id, "createdAt": ts,
            "input": {"ipId": "ip_1", "cutoutKey": f"sessions/{SID}/cut.png"}, **extra}


def _status(ctx, job_id="job_m1", **st):
    st.setdefault("updatedAt", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    ctx.s3._store[(BUCKET, f"img3d/out/{job_id}/status.json")] = json.dumps(st).encode()


def test_submit_uploads_enqueues_and_wakes_the_box(ctx):
    assert Img3dProvider().submit(_job(), ctx) == "job_m1"
    assert ctx.s3._store[(BUCKET, "img3d/in/job_m1.png")] == b"PNG"
    assert ctx.sqs.sent == [(QUEUE, {"jobId": "job_m1", "input_key": "img3d/in/job_m1.png",
                                     "output_prefix": "img3d/out/job_m1/", "params": {}, "ticket": 1})]
    assert ctx.ec2.started == [["i-img3d"]]


def test_submit_does_not_start_a_running_box(ctx):
    ctx.ec2.state = "running"
    Img3dProvider().submit(_job(), ctx)
    assert ctx.ec2.started == [] and len(ctx.sqs.sent) == 1


@pytest.mark.parametrize("state,expect", [
    ("pending", ("running", img3d.STARTING)),
    ("running", ("running", "GPU 서버 순서 기다리는 중")),
    ("stopping", ("running", "GPU 서버가 꺼지는 중이라 다시 켜지기를 기다리는 중")),
])
def test_status_before_the_worker_picks_it_up(ctx, state, expect):
    ctx.ec2.state = state
    assert Img3dProvider().status(_job(), ctx) == expect
    assert ctx.ec2.started == []


def test_status_restarts_a_box_that_stopped_with_work_queued(ctx):
    assert Img3dProvider().status(_job(), ctx) == ("running", img3d.STARTING)
    assert ctx.ec2.started == [["i-img3d"]]


def test_stranded_box_is_relocated_then_retired(ctx, drought):
    first, second = img3d.LAUNCH_SUBNETS[:2]
    ctx.ec2.full = {("g6e.xlarge", first)}  # the box's own AZ is full for every g6e size, and the first subnet too
    p = Img3dProvider()
    assert p.submit(_job(), ctx) == "job_m1" and len(ctx.sqs.sent) == 1  # its start is refused: step 0 of the round
    assert p.status(_job(), ctx) == ("running", NO_CAPACITY) and ctx.ec2.runs == []
    for _ in range(2):  # a launch entry a poll
        drought.sleep(img3d.STEP_GAP_SEC)
        p.status(_job(), ctx)
    assert ctx.ec2.runs == [("g6e.xlarge", first), ("g6e.xlarge", second)]
    assert ctx.ec2.launched == [("g6e.xlarge", second)]  # next AZ in order, same type
    assert ctx.ec2.terminated == []  # the old box stays until the new one runs
    # pending replacement, no second launch; a box launched new loads the models ~5 min (STARTING: a restart's ~3)
    assert p.status(_job(), ctx) == ("running", "GPU 서버 켜는 중 (켜는 데 ~1분, 준비에 ~5분)")
    assert len(ctx.ec2.launched) == 1
    ctx.ec2.instances["i-new0"] = "running"
    assert p.status(_job(), ctx) == ("running", "GPU 서버 순서 기다리는 중")
    assert ctx.ec2.terminated == ["i-img3d"]  # exactly one tagged box left
    assert [i for i, st in ctx.ec2.instances.items() if st != "terminated"] == ["i-new0"]


def test_falls_back_to_bigger_types_reporting_no_capacity_until_one_launches(ctx, drought):
    ctx.ec2.full = {("g6e.xlarge", s) for s in img3d.LAUNCH_SUBNETS}
    p = Img3dProvider()
    p.submit(_job(), ctx)
    lines = []
    for _ in img3d.LAUNCH_SUBNETS:  # the smallest type in every subnet
        drought.sleep(img3d.STEP_GAP_SEC)
        lines.append(p.status(_job(), ctx)[1])
    drought.sleep(img3d.STEP_GAP_SEC)
    assert p.status(_job(), ctx) == ("running", img3d.LAUNCHING)
    assert set(lines) == {NO_CAPACITY} and ctx.ec2.launched == [("g6e.2xlarge", img3d.LAUNCH_SUBNETS[0])]


def test_launches_a_box_when_none_exists_and_fails_after_two_hours(ctx):
    ctx.ec2.state = None
    assert Img3dProvider().status(_job(), ctx) == ("running", img3d.LAUNCHING)
    assert len(ctx.ec2.launched) == 1
    old = (datetime.now(timezone.utc) - timedelta(minutes=121)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    assert Img3dProvider().status(_job(createdAt=old), ctx) == ("failed", "GPU 작업이 시작되지 않았습니다 (시간 초과)")


def test_status_reads_the_worker_status_json(ctx):
    p = Img3dProvider()
    _status(ctx, status="running", phase="texture", seconds=93)
    assert p.status(_job(), ctx) == ("running", "3D 모델 만드는 중 · 색과 질감 입히기 · 93초")
    _status(ctx, status="running", phase="shape", updatedAt="2026-01-01T00:00:00Z")
    assert p.status(_job(), ctx)[0] == "failed"  # heartbeat stopped
    _status(ctx, status="failed", error="CUDA out of memory")
    assert p.status(_job(), ctx) == ("failed", "3D 모델을 만들지 못했습니다: CUDA out of memory")
    _status(ctx, status="done", seconds=200)
    assert p.status(_job(), ctx) == ("done", "")


def test_collect_copies_glb_to_its_fixed_key_and_optional_preview(ctx):
    p = Img3dProvider()
    _status(ctx, status="done", stats={"vertices": 20000, "faces": 39998})
    ctx.s3._store[(BUCKET, "img3d/out/job_m1/model.glb")] = b"GLB"
    assets = p.collect(_job(), ctx)
    assert assets == [{"kind": "glb", "key": glb_key(SID, "job_m1"), "contentType": "model/gltf-binary",
                       "meta": {"model": "hunyuan3d-2.1", "vertices": 20000, "faces": 39998}}]
    assert ctx.s3._store[(BUCKET, f"sessions/{SID}/job_m1.glb")] == b"GLB"
    ctx.s3._store[(BUCKET, "img3d/out/job_m1/preview.png")] = b"PNG"
    assert [a["kind"] for a in p.collect(_job(), ctx)] == ["glb", "poster"]


def test_collect_keeps_what_the_worker_stripped_from_the_mesh(ctx):
    cleanup = {"removedFaces": 13144, "slabs": 1, "cards": 0}  # the survival mutant's floor slab
    _status(ctx, status="done", stats={"vertices": 18000, "faces": 26856, "cleanup": cleanup})
    ctx.s3._store[(BUCKET, "img3d/out/job_m1/model.glb")] = b"GLB"
    assert Img3dProvider().collect(_job(), ctx)[0]["meta"] == {
        "model": "hunyuan3d-2.1", "vertices": 18000, "faces": 26856, "cleanup": cleanup}


def test_collect_fails_loudly_without_a_glb(ctx):
    _status(ctx, status="done")
    with pytest.raises(Exception):
        Img3dProvider().collect(_job(), ctx)


def test_render_3d_chain_mesh_then_blender_turntable_of_that_glb(ctx, monkeypatch):
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", DeadlineProvider(template_loader=lambda: {"name": "stub"}))
    session = store.put_session(ctx, "user-1", "루나", "sf-shooter")
    sid = session["sessionId"]
    cut = store.put_asset(ctx, sid, {"kind": "cutout", "key": f"sessions/{sid}/cut.png", "contentType": "image/png"})
    ctx.s3._store[(BUCKET, cut["key"])] = b"PNG"
    store.put_ip(ctx, sid, {"ipId": "ip_1", "kind": "prop", "name": "루나", "version": 1,  # no A-pose/rig steps
                            "imageAssetId": cut["assetId"], "cutoutAssetId": cut["assetId"]})
    out = tools.run_tool(ctx, session, "render_3d", {"ipId": "ip_1"})
    mesh_id, render_id = out["meshJobId"], out["jobId"]
    get = lambda jid: store.get_job(ctx, sid, jid)  # noqa: E731

    jobs.advance_jobs(ctx, sid)  # mesh submitted; the turntable waits for it
    assert get(mesh_id)["status"] == "running" and get(render_id)["status"] == "queued"
    assert ctx.sqs.sent[0][1]["jobId"] == mesh_id and ctx.deadline.calls == []

    _status(ctx, mesh_id, status="done", stats={"vertices": 10, "faces": 12})
    ctx.s3._store[(BUCKET, f"img3d/out/{mesh_id}/model.glb")] = b"GLB"
    jobs.advance_jobs(ctx, sid)  # mesh collected → IP gets the Hunyuan GLB → Blender job submitted with it
    mesh = get(mesh_id)
    assert mesh["status"] == "done"
    ip = store.get_ip(ctx, sid, "ip_1")
    glb = next(a for a in store.snapshot(ctx, sid)["assets"] if a["assetId"] == ip["glbAssetId"])
    assert glb["key"] == f"sessions/{sid}/{mesh_id}.glb" and glb["meta"]["faces"] == 12
    queue = "griptapenode-queue-087967639890-us-east-1-an"
    staged = f"DeadlineCloud/ipverse/{render_id}/inputs/model.glb"
    assert ctx.s3._store[(queue, staged)] == b"GLB"
    assert ctx.deadline.calls[0]["parameters"]["InputUri"] == {"string": f"s3://{queue}/{staged}"}
    assert get(render_id)["status"] == "running"

    ctx.deadline._job_responses["job-1"] = {"taskRunStatus": "SUCCEEDED", "lifecycleStatus": "CREATE_COMPLETE"}
    for name in ("turntable.mp4", "poster.png"):
        ctx.s3._store[(queue, f"DeadlineCloud/ipverse/{render_id}/{name}")] = name.encode()
    jobs.advance_jobs(ctx, sid)  # turntable collected; the GLB stays Hunyuan's (no Blender model.glb)
    assert get(render_id)["status"] == "done"
    ip = store.get_ip(ctx, sid, "ip_1")
    assert ip["glbAssetId"] == glb["assetId"] and ip.get("turntableAssetId") and ip.get("posterAssetId")


def test_failed_mesh_fails_the_turntable(ctx):
    session = store.put_session(ctx, "user-1", "루나", "sf-shooter")
    sid = session["sessionId"]
    mesh = jobs.create_job(ctx, sid, "mesh3d", "img3d", {"ipId": "ip_1", "cutoutKey": f"sessions/{SID}/cut.png"}, [])
    render = jobs.create_job(ctx, sid, "render3d", "deadline", {"ipId": "ip_1", "glbKey": "x.glb"}, [mesh["jobId"]])
    jobs.advance_jobs(ctx, sid)
    _status(ctx, mesh["jobId"], status="failed", error="boom")
    jobs.advance_jobs(ctx, sid)
    assert store.get_job(ctx, sid, mesh["jobId"])["status"] == "failed"
    assert store.get_job(ctx, sid, render["jobId"])["error"] == jobs.DEP_FAILED


# ── a waking poll stays short and never raises on a box another poll moved ──
# Two boxes can carry the tag, both stopped (one stranded in an AZ with no capacity, listed first). The retrying
# client makes 5 StartInstances calls per wake, a describe right after a start still shows the box stopped, and a
# start on a box another poll terminated meanwhile answers UnsupportedOperation.
CLASSIC = ("You can't start a stopped instance in EC2-Classic. Instead, you must launch a new instance in a virtual "
           "private cloud (VPC).")


class Retrying:
    """ctx.ec2 as Ctx.from_env builds it: botocore retries each InsufficientInstanceCapacity (5 calls, ~10 s live).
    It describes and retires boxes; a start on it is recorded."""

    def __init__(self, ec2):
        self.ec2, self.calls = ec2, []

    def describe_instances(self, **kw):
        return self.ec2.describe_instances(**kw)

    def terminate_instances(self, **kw):
        return self.ec2.terminate_instances(**kw)

    def start_instances(self, **kw):
        self.calls.append(("start", kw["InstanceIds"]))
        return self.ec2.start_instances(**kw)


def _mesh(ctx):
    sid = store.put_session(ctx, "user-1", "장창", "sf-shooter")["sessionId"]
    job = jobs.create_job(ctx, sid, "mesh3d", "img3d", {"ipId": "ip_1", "cutoutKey": f"sessions/{SID}/cut.png"}, [])
    return sid, job["jobId"]


def test_r2_the_poll_that_submits_wakes_once_and_asks_each_box_once_on_the_no_retry_client(ctx):
    ec2 = ctx.ec2
    ec2.state = None
    ec2.instances.update({"i-stranded": "stopped", "i-spare": "stopped"})
    ec2.stuck.add("i-stranded")
    ec2.lag = 1  # the describe right after a start still shows the box stopped
    ctx.ec2, ctx.ec2_launch = Retrying(ec2), ec2
    sid, job_id = _mesh(ctx)

    jobs.advance_jobs(ctx, sid)  # one poll: submit, then status in the same pass

    assert ec2.describes == 1  # status() reports submit's wake, it does not wake again on a stale describe
    assert ec2.starts == [["i-stranded"], ["i-spare"]]  # each box asked once, the stranded one without a retry
    assert ctx.ec2.calls == []  # no start on the client that retries capacity errors
    job = store.get_job(ctx, sid, job_id)
    assert (job["status"], job["progress"]) == ("running", img3d.STARTING)


def test_r2_a_start_refused_because_another_poll_retired_the_box_is_one_log_line_not_a_traceback(ctx, capsys):
    sid, job_id = _mesh(ctx)
    ctx.ec2.state = "running"
    jobs.advance_jobs(ctx, sid)  # submitted to a running box: the worker has not picked it up yet
    ctx.ec2.state = "stopped"  # this poll's describe still lists it stopped, but another poll retired it since
    ctx.ec2.moved["i-img3d"] = ("UnsupportedOperation", CLASSIC)
    capsys.readouterr()

    jobs.advance_jobs(ctx, sid)

    job = store.get_job(ctx, sid, job_id)
    assert (job["status"], job["progress"]) == ("running", img3d.STARTING)  # not 상태 확인 재시도 중
    assert not job.get("statusErrorSince")
    out = capsys.readouterr()
    assert "Traceback" not in out.out + out.err
    [line] = out.out.splitlines()
    assert "i-img3d" in line and "UnsupportedOperation" in line
    assert ctx.ec2.launched == [] and ctx.ec2.started == []  # a start that raced launches no second box


def test_r2_the_same_race_in_the_submitting_poll_does_not_fail_the_job(ctx, capsys):
    ctx.ec2.instances["i-spare"] = "stopped"
    ctx.ec2.moved["i-img3d"] = ("UnsupportedOperation", CLASSIC)  # retired after this poll's describe
    sid, job_id = _mesh(ctx)

    jobs.advance_jobs(ctx, sid)

    job = store.get_job(ctx, sid, job_id)  # it was failed with EC2's text, its SQS message already sent
    assert (job["status"], job["progress"]) == ("running", img3d.STARTING)
    assert ctx.ec2.started == [["i-spare"]] and len(ctx.sqs.sent) == 1
    assert "Traceback" not in capsys.readouterr().err


def test_r2_a_box_that_went_on_to_stop_is_waited_out_then_started_from_stopped(ctx, capsys):
    p = Img3dProvider()
    ctx.ec2.moved["i-img3d"] = ("IncorrectInstanceState",
                                "The instance 'i-img3d' is not in a state from which it can be started.")
    assert p.status(_job(), ctx) == ("running", img3d.STARTING)  # it moved after the describe: waking
    ctx.ec2.state = "stopping"
    assert p.status(_job(), ctx) == ("running", "GPU 서버가 꺼지는 중이라 다시 켜지기를 기다리는 중")
    assert ctx.ec2.starts == [["i-img3d"]]  # never a start while it stops
    del ctx.ec2.moved["i-img3d"]
    ctx.ec2.state = "stopped"
    assert p.status(_job(), ctx) == ("running", img3d.STARTING)
    assert ctx.ec2.started == [["i-img3d"]] and ctx.ec2.launched == []
    assert "Traceback" not in capsys.readouterr().err


def test_r2_any_other_start_refusal_still_fails_loudly(ctx):
    ctx.ec2.moved["i-img3d"] = ("UnauthorizedOperation", "You are not authorized to perform this operation.")
    with pytest.raises(ClientError):
        Img3dProvider()._wake(ctx)


# ── no g6e capacity anywhere ──
# A poll must not run one StartInstances and the whole 12-entry RunInstances list every time (seconds a poll, and
# Client.RequestLimitExceeded from EC2 with several pollers), nor raise when EC2 throttles.
NO_CAPACITY = "GPU 서버 자리가 없어 다시 켜 보는 중"
ALL = {(t, s) for t in img3d.LAUNCH_TYPES for s in img3d.LAUNCH_SUBNETS}


@pytest.fixture
def drought(ctx, monkeypatch):
    """No g6e capacity anywhere: the stopped box's AZ and every launch entry refuse. Calls take as long as live, on a
    fake clock that the job engine and the table's timestamps follow too. → the clock."""
    clock = Clock()
    fake_time(monkeypatch, clock, jobs)
    ctx.ec2.clock = clock
    ctx.ec2.stuck.add("i-img3d")
    ctx.ec2.full |= ALL
    return clock


def _studio(ctx, sid, job_id, clock, polls, pages=1, every=3):
    """Studio pages (the browser, a test poller): each sends GET /api/sessions/{id} 3 s after its last one answered,
    handled by a Lambda of its own (the table and EC2 are shared). → [(seconds, job line)] per poll."""
    seen, due = [], [clock.now() + page for page in range(pages)]
    for _ in range(polls):
        page = due.index(min(due))
        clock.sleep(max(0.0, due[page] - clock.now()))
        t0 = clock.now()
        jobs.advance_jobs(copy.copy(ctx), sid)
        seen.append((round(clock.now() - t0, 3), store.get_job(ctx, sid, job_id)["progress"]))
        due[page] = clock.now() + every
    return seen


@pytest.mark.parametrize("pages", [1, 3])  # the browser alone, or with two more pollers
def test_r2_n10_without_capacity_a_poll_stays_short_and_the_try_list_runs_once_in_a_few_minutes(ctx, drought, pages):
    sid, job_id = _mesh(ctx)

    seen = _studio(ctx, sid, job_id, drought, polls=150 * pages, pages=pages)  # about ten minutes of polling

    assert max(sec for sec, _ in seen) <= DESCRIBE_SEC + CALL_SEC  # one start or launch a poll: ~2 s with the request
    assert {line for _, line in seen} == {NO_CAPACITY}  # the job line says so from the first poll on
    rounds = len(ctx.ec2.starts)  # every round asks the stopped box first, then each launch entry once
    assert rounds <= 3 and len(ctx.ec2.runs) <= 12 * rounds and set(ctx.ec2.runs) == ALL  # not 13 calls every poll
    job = store.get_job(ctx, sid, job_id)
    assert job["status"] == "running" and not job.get("statusErrorSince")


def test_r2_n10_a_poll_that_comes_in_during_a_step_makes_no_ec2_call_of_its_own(ctx, drought):
    sid, job_id = _mesh(ctx)
    jobs.advance_jobs(ctx, sid)  # submitted; the stopped box was refused
    other = copy.copy(ctx)  # a second tab or poller: another Lambda, the same table and EC2
    seen = {}

    def overlap():  # it polls while this poll waits on EC2
        calls, t0 = (len(ctx.ec2.starts), len(ctx.ec2.runs)), drought.now()
        jobs.advance_jobs(other, sid)
        seen.update(calls=(len(ctx.ec2.starts), len(ctx.ec2.runs)) == calls, sec=round(drought.now() - t0, 3),
                    line=store.get_job(other, sid, job_id)["progress"])

    drought.sleep(3)
    ctx.ec2.during = overlap
    jobs.advance_jobs(ctx, sid)

    assert seen == {"calls": True, "sec": DESCRIBE_SEC, "line": NO_CAPACITY}


def test_r2_n10_a_throttled_launch_is_one_log_line_and_the_job_keeps_waiting_for_capacity(ctx, drought, capsys):
    sid, job_id = _mesh(ctx)
    jobs.advance_jobs(ctx, sid)  # submitted; the stopped box was refused
    ctx.ec2.throttle = 1  # the next RunInstances: Client.RequestLimitExceeded
    capsys.readouterr()

    seen = _studio(ctx, sid, job_id, drought, polls=15)

    out = capsys.readouterr()
    assert "Traceback" not in out.out + out.err
    [line] = [text for text in out.out.splitlines() if "RequestLimitExceeded" in text]
    assert "RunInstances" in line
    assert {line for _, line in seen} == {NO_CAPACITY}  # not 상태 확인 재시도 중
    assert not store.get_job(ctx, sid, job_id).get("statusErrorSince")
    assert ctx.ec2.runs[1] == ctx.ec2.runs[0]  # the throttled entry is asked again after a wait, not skipped
    assert len(ctx.ec2.runs) >= 3  # and the round goes on


def test_r2_n10_capacity_later_in_the_round_launches_one_box_and_the_next_wake_asks_the_stopped_box_first(ctx, drought):
    found = (img3d.LAUNCH_TYPES[-1], img3d.LAUNCH_SUBNETS[1])  # 18:29:04Z: a g6e.4xlarge in us-east-1c
    ctx.ec2.full.discard(found)
    sid, job_id = _mesh(ctx)

    seen = _studio(ctx, sid, job_id, drought, polls=20)

    assert ctx.ec2.launched == [found] and ctx.ec2.runs[-1] == found and len(ctx.ec2.starts) == 1
    assert img3d.LAUNCHING in [line for _, line in seen]
    ctx.ec2.instances["i-new0"] = "running"
    _studio(ctx, sid, job_id, drought, polls=1)
    assert ctx.ec2.terminated == ["i-img3d"]  # the stranded box is retired once the new one runs
    ctx.ec2.instances["i-new0"] = "stopped"  # the worker stops it when idle; a later 3D job wakes it
    later, _ = _mesh(ctx)
    jobs.advance_jobs(ctx, later)
    assert ctx.ec2.started == [["i-new0"]] and ctx.ec2.launched == [found]  # a new round, from StartInstances


def test_r2_n10_a_round_nobody_finished_starts_over_from_the_stopped_box(ctx, drought):
    sid, job_id = _mesh(ctx)
    _studio(ctx, sid, job_id, drought, polls=4)  # the start and three launch entries were refused
    assert (len(ctx.ec2.starts), len(ctx.ec2.runs)) == (1, 3)
    ctx.ec2.stuck.clear()
    ctx.ec2.state = "running"  # started by hand meanwhile; it later stops itself with the job still waiting
    _studio(ctx, sid, job_id, drought, polls=300)
    ctx.ec2.state = "stopped"

    _studio(ctx, sid, job_id, drought, polls=1)

    assert ctx.ec2.started == [["i-img3d"]] and len(ctx.ec2.runs) == 3  # not launch entry 4 of the old round


# ── meshes are served first in, first out ──
# A standard queue hands messages out in no order, so a mesh could run after many sent later while its card promised
# a wait: the FIFO queue keeps the order and the card shows the place in it.
FIFO = QUEUE + ".fifo"


def _head(ctx, ticket, status="running", started_sec_ago=30, expect_sec=90):
    started = (datetime.now(timezone.utc) - timedelta(seconds=started_sec_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")
    ctx.s3._store[(BUCKET, "img3d/queue/head.json")] = json.dumps(
        {"ticket": ticket, "jobId": f"job_t{ticket}", "status": status, "startedAt": started,
         "expectSec": expect_sec}).encode()


def test_m8_every_submit_takes_the_next_ticket_and_the_job_keeps_it(ctx):
    p = Img3dProvider()
    tickets = []
    for n in range(3):
        job = _job(f"job_{n}")
        p.submit(job, ctx)
        tickets.append(job["_save"]["queueTicket"])
    assert tickets == [1, 2, 3]
    assert [body["ticket"] for _, body in ctx.sqs.sent] == [1, 2, 3]  # the worker reports the one it runs


def test_m8_a_fifo_queue_gets_one_message_group_so_the_box_takes_meshes_in_the_order_they_were_sent(ctx):
    ctx.img3d_queue_url = FIFO
    p = Img3dProvider()
    for n in range(2):
        p.submit(_job(f"job_{n}"), ctx)
    assert [q for q, _ in ctx.sqs.sent] == [FIFO, FIFO]
    assert [f["MessageGroupId"] for f in ctx.sqs.fifo] == ["img3d", "img3d"]  # one line across every session
    dedup = [f["MessageDeduplicationId"] for f in ctx.sqs.fifo]
    assert len(set(dedup)) == 2 and dedup[0].startswith("job_0")


def test_m8_a_retried_mesh_is_a_new_message_and_does_not_read_its_old_failed_status(ctx):
    ctx.img3d_queue_url = FIFO
    ctx.ec2.state = "running"
    p = Img3dProvider()
    p.submit(_job(), ctx)
    _status(ctx, status="failed", error="CUDA out of memory")
    job = _job()
    p.submit(job, ctx)  # 다시 시도: same jobId
    assert ctx.sqs.fifo[0]["MessageDeduplicationId"] != ctx.sqs.fifo[1]["MessageDeduplicationId"]
    assert p.status(job, ctx)[0] == "running"


def test_m8_the_job_line_says_its_place_in_the_gpu_queue_and_when_it_should_start(ctx):
    ctx.img3d_queue_url = FIFO
    ctx.ec2.state = "running"
    _head(ctx, 4, started_sec_ago=30, expect_sec=90)  # the box runs ticket 4, a minute left
    job = _job(queueTicket=7)  # 5 and 6 go first
    assert Img3dProvider().status(job, ctx) == ("running", "GPU 서버 순서 기다리는 중 · 대기열 3번째 · 시작까지 약 4분")
    _head(ctx, 6, status="done")
    assert Img3dProvider().status(job, ctx) == ("running", "GPU 서버 순서 기다리는 중 · 대기열 1번째 · 시작까지 약 1분")


def test_m8_a_box_still_booting_adds_the_boot_and_the_model_load(ctx):
    ctx.img3d_queue_url = FIFO
    _head(ctx, 2, status="done", started_sec_ago=3600)
    line = Img3dProvider().status(_job(queueTicket=4), ctx)[1]
    # the stopped box is started again: 45 s boot + 3 min load + 1.5 min
    assert line == f"{img3d.STARTING} · 대기열 2번째 · 시작까지 약 6분"


def test_m8_without_a_ticket_or_a_head_the_line_stays_as_before(ctx):
    ctx.ec2.state = "running"
    _head(ctx, 1)
    # a standard queue hands meshes out in no order: no place to show
    assert Img3dProvider().status(_job(queueTicket=3), ctx) == ("running", "GPU 서버 순서 기다리는 중")
    ctx.img3d_queue_url = FIFO
    del ctx.s3._store[(BUCKET, "img3d/queue/head.json")]
    assert Img3dProvider().status(_job(queueTicket=3), ctx) == ("running", "GPU 서버 순서 기다리는 중")  # no head yet
    _head(ctx, 5)
    assert Img3dProvider().status(_job(), ctx) == ("running", "GPU 서버 순서 기다리는 중")  # sent before tickets
    # the head is past it (a message from the standard queue drained meanwhile): no place to show
    assert Img3dProvider().status(_job(queueTicket=3), ctx) == ("running", "GPU 서버 순서 기다리는 중")


def test_m8_the_engine_keeps_the_ticket_on_the_job(ctx):
    sid, job_id = _mesh(ctx)
    jobs.advance_jobs(ctx, sid)
    assert store.get_job(ctx, sid, job_id)["queueTicket"] == 1
