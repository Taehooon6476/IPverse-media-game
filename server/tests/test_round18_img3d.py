"""The wait a queued mesh is told behind the box's first mesh after a boot. A stopped box started again loads its
models in about 180 s, a box launched new in about 300 s; the lines replay two recorded timelines (D4: started
again, M8: launched new) and must stay within two minutes of what was left."""
import re

from server import store
from server.providers import img3d
from server.providers.img3d import Img3dProvider
from server.tests.test_img3d import _head, _job, _status, ctx  # noqa: F401  (ctx: fixture)
from server.tests.test_round10_img3d import TimedEC2, _fifo  # noqa: F401  (_fifo: autouse fixture)

FIRST = img3d.RUN_SEC + img3d.LOAD_SEC  # head.json expectSec of the first mesh after a boot (workers/img3d/worker.py)
# D4, a stopped box started again: seconds after the start at which the server wrote each line, and the head mesh's
# phase in its status.json (None: head.json still names an older ticket)
D4 = [(3, None), (18, None), (35, "loading_models"), (52, "loading_models"), (68, "loading_models"),
      (85, "loading_models"), (102, "loading_models"), (119, "loading_models"), (134, "loading_models"),
      (151, "loading_models"), (166, "loading_models"), (183, "loading_models"), (200, "shape"), (215, "shape"),
      (231, "shape"), (248, "texture"), (265, "texture"), (282, "texture"), (298, "export")]
D4_INPUT, D4_NEXT = 18, 300  # seconds after the start: the head took input, the next mesh started
# M8, a box launched new: its first mesh had the models loaded 314 s after its input and the next mesh started at
# 395 s. Seconds after the input, and the head's phase then.
M8 = [(0, "download"), (40, "loading_models"), (100, "loading_models"), (160, "loading_models"),
      (220, "loading_models"), (280, "loading_models"), (310, "loading_models"), (320, "shape"), (365, "texture"),
      (390, "texture")]
M8_BOOT, M8_NEXT = 36, 395


def _said(line) -> int:
    return int(re.search(r"시작까지 약 (\d+)분", line).group(1))


def _started(ctx):  # noqa: F811
    """A stopped box that the wake round starts again, as a poll of the first mesh does. → the EC2 fake."""
    ctx.ec2 = TimedEC2("stopped")
    Img3dProvider().status(_job("job_first"), ctx)
    assert ctx.ec2.started == [["i-img3d"]]
    return ctx.ec2


def _launched(ctx):  # noqa: F811
    """No box left: the wake round launches a new one from the AMI. → the EC2 fake (the box is i-new0)."""
    ctx.ec2 = TimedEC2(None)
    Img3dProvider().status(_job("job_first"), ctx)
    assert len(ctx.ec2.launched) == 1
    return ctx.ec2


def _up(ec2, box, sec):
    ec2.instances[box] = "running"
    ec2.launched_ago[box] = sec


def _first_mesh(ctx, ticket, age, phase):  # noqa: F811
    """The box's first mesh after its boot, `age` seconds in: head.json as the worker writes it, its status.json."""
    _head(ctx, ticket, status="running", started_sec_ago=age, expect_sec=FIRST)
    _status(ctx, f"job_t{ticket}", status="running", phase=phase, seconds=age)


def test_d4_behind_the_first_mesh_of_a_stopped_box_started_again_every_line_is_within_two_minutes(ctx):  # noqa: F811
    _head(ctx, 12, status="done", started_sec_ago=35000)
    ec2 = _started(ctx)
    lines = []
    for sec, phase in D4:
        if sec >= D4_INPUT:
            _up(ec2, "i-img3d", sec)
        if phase:
            _first_mesh(ctx, 13, sec - D4_INPUT, phase)
        lines.append(Img3dProvider().status(_job("job_prop", queueTicket=14), ctx)[1])
    off = [(sec, line) for (sec, _), line in zip(D4, lines) if abs(_said(line) - (D4_NEXT - sec) / 60) > 2]
    assert off == []
    assert lines[0].endswith("대기열 2번째 · 시작까지 약 6분")  # 45 s boot + 180 s load + the first mesh, 4.9 min left
    # never 약 1분 while the mesh ahead still loads the models
    assert all(_said(line) >= 2 for (_, phase), line in zip(D4, lines) if phase == "loading_models")


def test_d4_a_stopped_box_started_again_says_its_own_model_load_not_a_new_boxs(ctx):  # noqa: F811
    ctx.ec2 = TimedEC2("stopped")
    assert Img3dProvider().status(_job(), ctx) == ("running", "GPU 서버 켜는 중 (켜는 데 ~1분, 준비에 ~3분)")
    _up(ctx.ec2, "i-img3d", 12)
    assert Img3dProvider().status(_job(), ctx) == ("running", "GPU 서버 켜지는 중 (~1분, 이어서 준비 ~3분)")


def test_m8_a_box_launched_new_keeps_the_five_minute_load_in_its_lines_and_its_wait(ctx):  # noqa: F811
    _head(ctx, 2, status="done", started_sec_ago=3600)
    ec2 = _launched(ctx)
    p = Img3dProvider()
    # the new box while it is pending, then up for seconds
    assert p.status(_job(), ctx) == ("running", "GPU 서버 켜는 중 (켜는 데 ~1분, 준비에 ~5분)")
    assert p.status(_job(queueTicket=4), ctx)[1].endswith("대기열 2번째 · 시작까지 약 8분")  # 45 + 300 + 90 s
    _up(ec2, "i-new0", 12)
    assert p.status(_job(), ctx) == ("running", "GPU 서버 켜지는 중 (~1분, 이어서 준비 ~5분)")
    lines = []
    for age, phase in M8:
        _up(ec2, "i-new0", M8_BOOT + age)
        _first_mesh(ctx, 3, age, phase)
        lines.append(p.status(_job(queueTicket=4), ctx)[1])
    assert [_said(line) for line in lines] == [7, 6, 5, 4, 3, 2, 2, 2, 1, 1]
    assert [(age, line) for (age, _), line in zip(M8, lines) if abs(_said(line) - (M8_NEXT - age) / 60) > 2] == []


def test_d4_once_the_head_has_the_models_loaded_at_most_a_warm_mesh_is_left_whatever_load_was_counted(ctx):  # noqa: F811
    # a box counted as launched new (300 s) whose first mesh has the models loaded by 180 s
    ec2 = _launched(ctx)
    _up(ec2, "i-new0", 200)
    _first_mesh(ctx, 1, 150, "loading_models")
    assert Img3dProvider().status(_job(queueTicket=2), ctx)[1] == "GPU 서버 준비 중 · 대기열 1번째 · 시작까지 약 4분"
    _first_mesh(ctx, 1, 182, "shape")  # the load is over: its uncounted remainder leaves the wait
    assert Img3dProvider().status(_job(queueTicket=2), ctx)[1] == "GPU 서버 순서 기다리는 중 · 대기열 1번째 · 시작까지 약 2분"
    # the one after it waits for that and a warm mesh of its own
    assert Img3dProvider().status(_job(queueTicket=3), ctx)[1].endswith("대기열 2번째 · 시작까지 약 3분")


def test_d4_a_launch_of_an_earlier_boot_says_nothing_of_a_box_that_came_up_since(ctx):  # noqa: F811
    # the WAKE item still says "launched" from an earlier boot: only a wake round's own start replaces it, so a box
    # that comes up any other way must not be read as launched new
    store._update(ctx, *img3d.WAKE, {"step": 0, "state": "launched", "nextTryAt": store.now(-35000 * 1000)})
    ctx.ec2 = TimedEC2("running")
    _up(ctx.ec2, "i-img3d", 12)
    assert Img3dProvider().status(_job(), ctx) == ("running", "GPU 서버 켜지는 중 (~1분, 이어서 준비 ~3분)")
    _up(ctx.ec2, "i-img3d", 100)
    _first_mesh(ctx, 1, 60, "loading_models")
    assert Img3dProvider().status(_job(queueTicket=2), ctx)[1] == "GPU 서버 준비 중 · 대기열 1번째 · 시작까지 약 4분"


def test_d4_a_load_that_outlasts_its_count_never_reads_one_minute_while_it_goes_on(ctx):  # noqa: F811
    # a started box whose load runs past its 180 s: the mesh after the load is still to come
    ec2 = _started(ctx)
    _up(ec2, "i-img3d", 280)
    _first_mesh(ctx, 1, 250, "loading_models")
    assert Img3dProvider().status(_job(queueTicket=2), ctx)[1] == "GPU 서버 준비 중 · 대기열 1번째 · 시작까지 약 2분"
