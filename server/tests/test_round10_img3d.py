"""The GPU-queue ticket is taken when the mesh is requested (not when its session first polls), so the box gets
meshes in request order; and the boot line says the box's real phase with its boot and model-load times."""
from datetime import datetime, timedelta, timezone

import pytest

from server import jobs, store, tools
from server.providers import img3d
from server.providers.deadline import DeadlineProvider
from server.providers.img3d import Img3dProvider
from server.tests.conftest import FakeProvider
from server.tests.test_img3d import BUCKET, EC2, FIFO, _head, _job, _status, ctx  # noqa: F401  (ctx: fixture)


@pytest.fixture(autouse=True)
def _fifo(ctx, monkeypatch):  # noqa: F811
    ctx.img3d_queue_url = FIFO
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", DeadlineProvider(template_loader=lambda: {"name": "stub"}))


def _session(ctx, name):
    session = store.put_session(ctx, "user-1", name, "sf-shooter")
    sid = session["sessionId"]
    cut = store.put_asset(ctx, sid, {"kind": "cutout", "key": f"sessions/{sid}/cut.png", "contentType": "image/png"})
    ctx.s3._store[(BUCKET, cut["key"])] = b"PNG"
    store.put_ip(ctx, sid, {"ipId": "ip_1", "kind": "prop", "name": name, "version": 1,
                            "imageAssetId": cut["assetId"], "cutoutAssetId": cut["assetId"]})
    return session


def _render(ctx, session):
    return tools.run_tool(ctx, session, "render_3d", {"ipId": "ip_1"})["meshJobId"]


def _sent(ctx):
    return [(body["jobId"], body.get("ticket")) for _, body in ctx.sqs.sent]


# ── the ticket at request time ──

def test_render_3d_takes_the_ticket_when_the_mesh_is_requested(ctx):
    a, b = _session(ctx, "타이어 벽"), _session(ctx, "포션")
    tire, potion = _render(ctx, a), _render(ctx, b)
    assert store.get_job(ctx, a["sessionId"], tire)["lineTicket"] == 1
    assert store.get_job(ctx, b["sessionId"], potion)["lineTicket"] == 2
    assert ctx.sqs.sent == []  # nothing sent yet: only the place in line is taken


def test_m8_the_later_request_waits_when_its_session_polls_first_and_the_box_gets_them_in_request_order(ctx):
    a, b = _session(ctx, "타이어 벽"), _session(ctx, "포션")
    tire, potion = _render(ctx, a), _render(ctx, b)  # the tire first, then the potion

    jobs.advance_jobs(ctx, b["sessionId"])  # the potion's session polls first
    held = store.get_job(ctx, b["sessionId"], potion)
    assert held["status"] == "queued" and "앞선 요청 1개" in held["progress"]
    assert ctx.sqs.sent == []

    jobs.advance_jobs(ctx, a["sessionId"])
    jobs.advance_jobs(ctx, b["sessionId"])
    assert _sent(ctx) == [(tire, 1), (potion, 2)]  # FIFO order = request order, and the places follow it
    assert store.get_job(ctx, b["sessionId"], potion)["queueTicket"] == 2


def test_a_mesh_waiting_for_its_a_pose_keeps_its_place(ctx, monkeypatch):
    pose = FakeProvider("apose", states=[("running", "A-포즈 그리는 중")])
    monkeypatch.setitem(jobs.PROVIDERS, "apose", pose)
    a, b = _session(ctx, "기사"), _session(ctx, "포션")
    sid_a, sid_b = a["sessionId"], b["sessionId"]
    apose = jobs.create_job(ctx, sid_a, "apose", "apose", {"ipId": "ip_1"}, [])
    knight = jobs.create_job(ctx, sid_a, "mesh3d", "img3d", {"ipId": "ip_1", "cutoutKey": f"sessions/{sid_a}/cut.png"},
                             [apose["jobId"]])
    Img3dProvider().register(ctx, sid_a, knight)  # what render_3d does for a character's mesh
    potion = _render(ctx, b)

    for _ in range(2):  # the A-pose draws; the potion, requested later, is ready but waits for the knight
        jobs.advance_jobs(ctx, sid_a)
        jobs.advance_jobs(ctx, sid_b)
    assert ctx.sqs.sent == [] and store.get_job(ctx, sid_b, potion)["status"] == "queued"

    pose.states = [("done", "")]
    jobs.advance_jobs(ctx, sid_a)  # the A-pose lands: the knight is sent in the same pass
    jobs.advance_jobs(ctx, sid_b)
    assert _sent(ctx) == [(knight["jobId"], 1), (potion, 2)]


def test_an_earlier_mesh_holds_the_line_no_longer_than_hold_sec(ctx, monkeypatch):
    a, b = _session(ctx, "기사"), _session(ctx, "포션")
    stuck = jobs.create_job(ctx, a["sessionId"], "mesh3d", "img3d", {"ipId": "ip_1"}, ["job_never"])
    Img3dProvider().register(ctx, a["sessionId"], stuck)
    potion = _render(ctx, b)
    monkeypatch.setattr(img3d, "HOLD_SEC", -1)  # the knight's A-pose retries for half an hour
    jobs.advance_jobs(ctx, b["sessionId"])
    assert _sent(ctx) == [(potion, 1)]


def test_an_earlier_mesh_whose_session_nobody_polls_does_not_hold_the_line(ctx):
    a, b = _session(ctx, "기사"), _session(ctx, "포션")
    knight, potion = _render(ctx, a), _render(ctx, b)
    old = (datetime.now(timezone.utc) - timedelta(seconds=img3d.UNPOLLED_SEC + 5)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    store.update_job(ctx, a["sessionId"], knight, polledAt=old)  # its page closed: only its own polls send it
    jobs.advance_jobs(ctx, b["sessionId"])
    assert _sent(ctx) == [(potion, 1)]


def test_an_earlier_mesh_that_only_the_minute_tick_polls_keeps_its_place_between_two_ticks(ctx):
    """With no tab open a session is polled by the scheduled tick alone, once a minute and up to its budget late:
    the window after which an unpolled mesh lets later ones pass must be wider than that."""
    a, b = _session(ctx, "기사"), _session(ctx, "포션")
    knight, potion = _render(ctx, a), _render(ctx, b)
    widest = 60 + jobs.TICK_BUDGET_SEC + jobs.ADVANCE_BUDGET_SEC  # one tick at the start of its pass, the next at its end
    assert img3d.UNPOLLED_SEC > widest
    seen = (datetime.now(timezone.utc) - timedelta(seconds=widest)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    store.update_job(ctx, a["sessionId"], knight, polledAt=seen)
    jobs.advance_jobs(ctx, b["sessionId"])  # the potion's tab polls in between: it still waits for the knight
    assert ctx.sqs.sent == [] and "앞선 요청 1개" in store.get_job(ctx, b["sessionId"], potion)["progress"]
    jobs.advance_jobs(ctx, a["sessionId"])  # the tick comes
    jobs.advance_jobs(ctx, b["sessionId"])
    assert _sent(ctx) == [(knight, 1), (potion, 2)]


def test_a_failed_or_stopped_earlier_mesh_leaves_the_line(ctx):
    a, b = _session(ctx, "기사"), _session(ctx, "포션")
    knight, potion = _render(ctx, a), _render(ctx, b)
    jobs.cancel_job(ctx, a["sessionId"], knight)  # 중지 before it was sent
    jobs.advance_jobs(ctx, b["sessionId"])
    assert _sent(ctx) == [(potion, 1)]
    assert store._get(ctx, *img3d.QUEUE)["waiting"] == {}  # the stopped one is pruned, the sent one left


def test_a_retried_mesh_keeps_its_ticket_and_goes_before_later_requests(ctx):
    a, b = _session(ctx, "기사"), _session(ctx, "포션")
    knight = _render(ctx, a)
    jobs.advance_jobs(ctx, a["sessionId"])  # sent as place 1
    _status(ctx, knight, status="failed", error="CUDA out of memory")
    jobs.advance_jobs(ctx, a["sessionId"])
    assert store.get_job(ctx, a["sessionId"], knight)["status"] == "failed"

    potion = _render(ctx, b)  # requested after the knight first was
    assert knight in jobs.retry_job(ctx, a["sessionId"], knight)  # with its turntable
    jobs.advance_jobs(ctx, b["sessionId"])  # the potion's session polls first again
    assert store.get_job(ctx, b["sessionId"], potion)["status"] == "queued"
    jobs.advance_jobs(ctx, a["sessionId"])
    jobs.advance_jobs(ctx, b["sessionId"])
    assert _sent(ctx) == [(knight, 1), (knight, 2), (potion, 3)]
    assert store.get_job(ctx, a["sessionId"], knight)["lineTicket"] == 1  # the ticket it was requested with


def test_a_mesh_made_before_tickets_is_sent_as_before(ctx):
    sid = _session(ctx, "포션")["sessionId"]
    old = jobs.create_job(ctx, sid, "mesh3d", "img3d", {"ipId": "ip_1", "cutoutKey": f"sessions/{sid}/cut.png"}, [])
    jobs.advance_jobs(ctx, sid)
    assert _sent(ctx) == [(old["jobId"], 1)]


# ── the real phase of the box, with measured times ──

class TimedEC2(EC2):
    """EC2 whose describe gives each box a LaunchTime (`launched`: {id: seconds ago}), as EC2 does: the last start."""

    def __init__(self, state="stopped"):
        super().__init__(state)
        self.launched_ago = {}

    def describe_instances(self, Filters):
        resp = super().describe_instances(Filters)
        for r in resp["Reservations"]:
            for inst in r["Instances"]:
                ago = self.launched_ago.get(inst["InstanceId"])
                if ago is not None:
                    inst["LaunchTime"] = datetime.now(timezone.utc) - timedelta(seconds=ago)
        return resp


# No box below is launched new, so each counts the load of a stopped box started again (RELOAD_SEC, 180 s); a box
# launched new takes LOAD_SEC (test_round18_img3d.py covers both).
def test_a_stopped_box_says_it_starts_the_instance_with_the_boot_and_the_model_load_it_takes(ctx):
    assert Img3dProvider().status(_job(), ctx) == ("running", "GPU 서버 켜는 중 (켜는 데 ~1분, 준비에 ~3분)")
    assert not any("10분" in line for line in img3d.PHASES.values())


def test_a_box_up_for_seconds_is_booting_then_ready(ctx):
    ctx.ec2 = TimedEC2("running")
    ctx.ec2.launched_ago["i-img3d"] = 12
    assert Img3dProvider().status(_job(), ctx) == ("running", "GPU 서버 켜지는 중 (~1분, 이어서 준비 ~3분)")
    ctx.ec2.launched_ago["i-img3d"] = 600
    assert Img3dProvider().status(_job(), ctx) == ("running", "GPU 서버 순서 기다리는 중")


def test_a_box_starting_says_when_each_place_starts_from_the_measured_boot_and_load(ctx):
    _head(ctx, 2, status="done", started_sec_ago=3600)
    p = Img3dProvider()
    # the next in line starts once the box is up (~45 s); it then loads the models in its own line
    assert p.status(_job(queueTicket=3), ctx) == (
        "running", "GPU 서버 켜는 중 (켜는 데 ~1분, 준비에 ~3분) · 대기열 1번째 · 시작까지 약 1분")
    # the one after it waits for the boot, the model load and the first mesh: 45 + 180 + 90 s
    assert p.status(_job(queueTicket=4), ctx)[1].endswith("대기열 2번째 · 시작까지 약 6분")


def test_while_the_first_mesh_loads_the_models_the_ones_behind_say_so(ctx):
    ctx.ec2 = TimedEC2("running")
    ctx.ec2.launched_ago["i-img3d"] = 120
    _head(ctx, 1, status="running", started_sec_ago=60, expect_sec=img3d.RUN_SEC + img3d.LOAD_SEC)
    _status(ctx, "job_t1", status="running", phase="loading_models", seconds=60)
    line = Img3dProvider().status(_job(queueTicket=2), ctx)[1]
    assert line == "GPU 서버 준비 중 · 대기열 1번째 · 시작까지 약 4분"  # 270 - 60 s left of the first one
    _status(ctx, "job_t1", status="running", phase="shape", seconds=310)
    assert Img3dProvider().status(_job(queueTicket=2), ctx)[1].startswith("GPU 서버 순서 기다리는 중 · 대기열 1번째")
