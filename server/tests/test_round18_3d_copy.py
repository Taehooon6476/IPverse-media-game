"""The 3D cards' times and the 3D wait copy: a mesh's work (작업) starts when the GPU box takes it, not when it is
sent; a turntable's usual time covers what the farm takes from the send; the chat says the model load of either boot.
D4 is a recorded run: a prop's mesh queued behind a hero's on a stopped box started again."""
import json
import re
from datetime import datetime

import pytest

from server import jobs, store, waits
from server.providers import img3d
from server.providers.img3d import Img3dProvider
from server.tests.conftest import FakeProvider
from server.tests.fake_gpu import Clock, fake_time
from server.tests.test_img3d import BUCKET, _mesh, _status, ctx  # noqa: F401  (ctx: fixture)
from server.tests.test_round10_img3d import _fifo, _sent, _session  # noqa: F401  (_fifo: autouse fixture)


@pytest.fixture
def clock(monkeypatch):
    """Seconds after the hero's chain was asked for."""
    c = Clock(0.0)
    fake_time(monkeypatch, c, jobs)
    return c


def _stamp(sec_ago=0) -> str:
    return store.now(-sec_ago * 1000)[:19] + "Z"  # whole seconds, as the worker writes them (worker.py now_iso)


def _head(ctx, ticket, job_id, status="running", started_sec_ago=0, expect_sec=img3d.RUN_SEC):  # noqa: F811
    ctx.s3._store[(BUCKET, img3d.HEAD_KEY)] = json.dumps(
        {"ticket": ticket, "jobId": job_id, "status": status, "startedAt": _stamp(started_sec_ago),
         "expectSec": expect_sec}).encode()


def _box(ctx, job_id, seconds, phase, status="running"):  # noqa: F811
    """The mesh's status.json as the worker writes it `seconds` after taking the mesh."""
    _status(ctx, job_id, status=status, phase=phase, seconds=seconds, updatedAt=_stamp())
    if status == "done":
        ctx.s3._store[(BUCKET, f"img3d/out/{job_id}/model.glb")] = b"GLB"


def _card(job):
    """(대기, 작업) in seconds as the job's card counts them (web/src/types.ts jobTimes); 작업 None while it waits."""
    def at(ts):
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    origin = at(job.get("retriedAt") or job["createdAt"])
    end = at(job["updatedAt"] if job["status"] in ("done", "failed") else store.now())
    if job["status"] == "queued" or not job.get("startedAt"):
        return round((end - origin).total_seconds()), None
    began = at(job["startedAt"])
    return round((began - origin).total_seconds()), round((end - began).total_seconds())


def test_d4_a_mesh_waiting_in_the_gpu_queue_behind_another_starts_when_the_box_takes_it(ctx, clock, monkeypatch):  # noqa: F811
    pose = FakeProvider("apose", states=[("running", "A-포즈로 다시 그리는 중 (klein)")])
    monkeypatch.setitem(jobs.PROVIDERS, "apose", pose)
    ctx.ec2.state = "running"
    store._update(ctx, *img3d.QUEUE, {"line": 8, "tail": 12, "rev": 18})
    _head(ctx, 12, "job_81c5a46a5c", status="done", started_sec_ago=35000)
    send = ctx.sqs.send_message
    ctx.sqs.send_message = lambda **kw: (clock.sleep(3), send(**kw))[1]  # a send and the box's wake take 3 s
    sid = _session(ctx, "세린")["sessionId"]
    store.put_ip(ctx, sid, {"ipId": "ip_2", "kind": "prop", "name": "달빛 물뿌리개", "version": 1})
    cut = f"sessions/{sid}/cut.png"
    apose = jobs.create_job(ctx, sid, "apose", "apose", {"ipId": "ip_1"}, [])
    hero = jobs.create_job(ctx, sid, "mesh3d", "img3d", {"ipId": "ip_1", "cutoutKey": cut}, [apose["jobId"]])["jobId"]
    Img3dProvider().register(ctx, sid, store.get_job(ctx, sid, hero))
    clock.t = 14
    prop = jobs.create_job(ctx, sid, "mesh3d", "img3d", {"ipId": "ip_2", "cutoutKey": cut}, [])["jobId"]
    Img3dProvider().register(ctx, sid, store.get_job(ctx, sid, prop))

    def poll(at):
        clock.t = at
        jobs.advance_jobs(ctx, sid)
        return store.get_job(ctx, sid, hero), store.get_job(ctx, sid, prop)

    _, held = poll(25)
    assert held["status"] == "queued" and held["progress"] == "GPU 서버 순서 기다리는 중 · 앞선 요청 1개"
    poll(60)
    pose.states = [("done", "")]
    poll(101)  # the A-pose landed: the hero's mesh is sent, then the prop's
    assert _sent(ctx) == [(hero, 13), (prop, 14)]

    clock.t = 120  # the box takes the hero's mesh and loads the models in its line
    _head(ctx, 13, hero, expect_sec=img3d.RUN_SEC + img3d.LOAD_SEC)
    _box(ctx, hero, 0, "download")
    poll(122)
    clock.t = 180
    _box(ctx, hero, 60, "loading_models")
    first, waiting = poll(237)
    assert first["progress"] == "3D 모델 만드는 중 · 도구 준비 · 60초"
    assert waiting["status"] == "running"
    assert re.fullmatch(r"GPU 서버 준비 중 · 대기열 1번째 · 시작까지 약 \d분", waiting["progress"])
    assert _card(waiting) == (223, None)  # still waiting: no work counted from the send

    clock.t = 402  # the hero's mesh is done after 282 s and the box takes the prop's
    _box(ctx, hero, 282, "done", status="done")
    _head(ctx, 14, prop)
    _box(ctx, prop, 0, "shape")
    done, taken = poll(404)
    assert done["status"] == "done" and taken["progress"] == "3D 모델 만드는 중 · 모양 만들기 · 0초"
    assert _card(taken) == (388, 2)

    clock.t = 487  # the box ran the prop's mesh for 85 s
    _box(ctx, prop, 85, "done", status="done")
    first, second = poll(488)
    assert second["status"] == "done"
    assert _card(second) == (388, 86)
    assert _card(first) == (120, 284)  # the 18 s before the box took it are wait, not work


def test_a_mesh_that_failed_on_the_box_between_two_polls_keeps_when_the_box_took_it(ctx, clock):  # noqa: F811
    ctx.ec2.state = "running"
    sid, job_id = _mesh(ctx)
    clock.t = 300
    jobs.advance_jobs(ctx, sid)
    assert store.get_job(ctx, sid, job_id)["startedAt"] == ""  # sent, not taken
    clock.t = 400  # the box took it at 360 and failed 40 s in, before the next poll
    _status(ctx, job_id, status="failed", error="CUDA out of memory", seconds=40, updatedAt=_stamp())
    jobs.advance_jobs(ctx, sid)
    job = store.get_job(ctx, sid, job_id)
    assert job["status"] == "failed" and _card(job) == (360, 40)


def test_a_retried_mesh_starts_again_when_the_box_takes_it_and_never_before_its_retry(ctx, clock):  # noqa: F811
    ctx.ec2.state = "running"
    sid, job_id = _mesh(ctx)
    clock.t = 300
    jobs.advance_jobs(ctx, sid)
    clock.t = 340  # the box took it at 310
    _box(ctx, job_id, 30, "shape")
    jobs.advance_jobs(ctx, sid)
    assert _card(store.get_job(ctx, sid, job_id)) == (310, 30)
    jobs.cancel_job(ctx, sid, job_id)  # 중지: the box goes on with it
    clock.t = 350
    assert jobs.retry_job(ctx, sid, job_id) == [job_id]
    jobs.advance_jobs(ctx, sid)  # sent again
    job = store.get_job(ctx, sid, job_id)
    assert job["status"] == "running" and job["startedAt"] == ""  # its stopped run's start is gone
    clock.t = 395  # the stopped run, still on the box, writes its status.json again: it answers for the retry
    _box(ctx, job_id, 85, "texture")
    jobs.advance_jobs(ctx, sid)
    job = store.get_job(ctx, sid, job_id)
    assert job["startedAt"] == job["retriedAt"]  # taken before the retry: such a start would read 경과 on the card
    assert _card(job) == (0, 45)


def test_a_mesh_stopped_in_the_gpu_queue_never_started(ctx):  # noqa: F811
    ctx.ec2.state = "running"
    sid, job_id = _mesh(ctx)
    jobs.advance_jobs(ctx, sid)
    jobs.cancel_job(ctx, sid, job_id)
    job = store.get_job(ctx, sid, job_id)
    assert job["status"] == "failed" and job["startedAt"] == ""


# the farm's turntables of a mesh, seconds from the create to the end (from the farm's job history): the worker's
# pickup after the create plus the render
FARM = [250, 269, 270, 401, 366, 511, 488, 400, 667, 253, 246, 378, 361, 370, 694, 335, 385]


def test_d36_a_turntables_usual_time_holds_what_the_farm_takes_from_the_send():
    lo, hi = waits.THREE_D_TYPICAL["render3d"]
    # three turntables seen on cards (작업 5:40, 6:26, 6:06)
    for sec in (340, 386, 366):
        assert lo * 60 <= sec <= hi * 60, (sec, lo, hi)
    inside = [sec for sec in FARM if lo * 60 <= sec <= hi * 60]
    assert len(inside) * 4 >= len(FARM) * 3, (len(inside), len(FARM))  # at least three quarters
    assert waits.TOTAL == "9–21분"  # 1–2 + 2–8 + 2–4 + 4–7


def test_the_chat_says_the_model_load_of_a_box_started_again_and_of_one_launched_new():
    """A stopped box started again loads the models in ~3 min, one launched new in ~5 min. The mesh's lines say the
    load of their own boot (test_round18_img3d.py); the chat, which cannot tell ahead, says both ends."""
    assert waits.BOX == "GPU 서버가 꺼져 있으면 켜는 데 ~1분, 준비에 ~3–5분 포함"
    # its two ends are what the mesh's own lines say of each boot
    assert "준비에 ~3분" in img3d.STARTING and "준비에 ~5분" in img3d.LAUNCHING
    assert waits.BOX in waits.RENDER_3D
