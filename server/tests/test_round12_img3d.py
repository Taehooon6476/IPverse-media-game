"""3D progress lines. A mesh behind a head that already runs on a box still inside its boot time waits for the head's
model load and mesh, not only for the rest of the boot. The turntable's line says the render phase in Korean and its
elapsed time (boto3 gives createdAt as a datetime)."""
from datetime import datetime, timedelta, timezone

from server.providers import img3d
from server.providers.deadline import DeadlineProvider
from server.providers.img3d import Img3dProvider
from server.tests.conftest import FakeDeadline, make_ctx
from server.tests.test_img3d import _head, _job, _status, ctx  # noqa: F401  (ctx: fixture)
from server.tests.test_round10_img3d import TimedEC2, _fifo  # noqa: F401  (_fifo: autouse fixture)


def test_item6_behind_a_head_that_runs_on_a_box_still_in_its_boot_the_wait_counts_its_load_and_mesh(ctx):  # noqa: F811
    ctx.ec2 = TimedEC2("running")
    ctx.ec2.launched_ago["i-img3d"] = 30  # under BOOT_SEC: "booting"
    _head(ctx, 1, status="running", started_sec_ago=5, expect_sec=img3d.RUN_SEC + img3d.LOAD_SEC)
    _status(ctx, "job_t1", status="running", phase="download", seconds=0)
    line = Img3dProvider().status(_job(queueTicket=2), ctx)[1]
    # a stopped box started again: 270 - 5 s left of the head
    assert line == "GPU 서버 준비 중 · 대기열 1번째 · 시작까지 약 5분"
    # two behind: the head's 265 s and one warm mesh
    assert Img3dProvider().status(_job(queueTicket=3), ctx)[1].endswith("대기열 2번째 · 시작까지 약 6분")


def test_item6_a_head_left_running_from_before_this_boot_is_not_trusted(ctx):  # noqa: F811
    ctx.ec2 = TimedEC2("running")
    ctx.ec2.launched_ago["i-img3d"] = 30
    _head(ctx, 1, status="running", started_sec_ago=3600, expect_sec=img3d.RUN_SEC)  # a box that died mid-mesh
    line = Img3dProvider().status(_job(queueTicket=2), ctx)[1]
    assert line == "GPU 서버 켜지는 중 (~1분, 이어서 준비 ~3분) · 대기열 1번째 · 시작까지 약 1분"


def test_item5_the_turntable_line_says_the_render_phase_in_korean_and_its_elapsed_time_from_botos_datetime():
    deadline = FakeDeadline()
    dctx = make_ctx(deadline=deadline)
    job = {"pk": "SESSION#s", "jobId": "job_1", "externalId": "job-ext", "input": {}}
    created = datetime.now(timezone.utc) - timedelta(seconds=75)  # boto3's createdAt is a datetime
    lines = {}
    for run in ("PENDING", "READY", "STARTING", "RUNNING"):
        deadline._job_responses["job-ext"] = {"taskRunStatus": run, "lifecycleStatus": "CREATE_COMPLETE",
                                              "createdAt": created}
        status, lines[run] = DeadlineProvider(template_loader=dict).status(job, dctx)
        assert status == "running"
        assert run not in lines[run] and "?" not in lines[run]
    assert lines["PENDING"] == "렌더 서버 순서 기다리는 중 · 1분 15초"
    assert lines["RUNNING"].startswith("3D 회전 영상 만드는 중 · 1분")
