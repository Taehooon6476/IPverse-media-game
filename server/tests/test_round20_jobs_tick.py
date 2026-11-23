"""A scheduled invocation (action jobs_tick, every minute) advances the sessions that hold queued or running jobs, so
a chain's next step does not wait for a studio tab's poll: a mark per session in the table (pk JOBSACTIVE), written
with a job and removed when the session's last job settled. Fakes only."""
import json

import boto3
import pytest
from botocore.stub import Stubber

from server import app, jobs, store
from server.tests.conftest import FakeLambda, FakeProvider, FakeTable, make_ctx

SID, OTHER = "ses_tick", "ses_other"


class CountingTable(FakeTable):
    """Counts the calls a DynamoDB table would bill."""

    def __init__(self):
        super().__init__()
        self.calls: list = []

    def query(self, *a, **kw):
        self.calls.append("query")
        return super().query(*a, **kw)

    def get_item(self, *a, **kw):
        self.calls.append("get")
        return super().get_item(*a, **kw)

    def put_item(self, *a, **kw):
        self.calls.append("put")
        return super().put_item(*a, **kw)

    def update_item(self, *a, **kw):
        self.calls.append("update")
        return super().update_item(*a, **kw)

    def delete_item(self, *a, **kw):
        self.calls.append("delete")
        return super().delete_item(*a, **kw)

    def scan(self, *a, **kw):  # never: the tick reads its own partition
        raise AssertionError("the tick scanned the table")


@pytest.fixture
def ctx(monkeypatch):
    monkeypatch.setenv("SELF_FUNCTION_NAME", "ipverse-api")
    return make_ctx(table=CountingTable(), lambda_=FakeLambda())


def _job(ctx, job_id, sid=SID):
    return next(j for j in store.snapshot(ctx, sid)["jobs"] if j["jobId"] == job_id)


def _marked(ctx):
    return [m["sessionId"] for m in store.active_sessions(ctx)]


def _old(ctx, sid=SID, minutes=10):
    """The session's mark as one written a while ago (past the grace a fresh mark is given)."""
    ctx.table.items[(store.ACTIVE_PK, f"SESSION#{sid}")]["at"] = store.now(-minutes * 60_000)


def _asset(kind, key):
    return {"kind": kind, "key": key, "contentType": "model/gltf-binary", "meta": {}}


def test_a_chain_runs_to_its_end_on_the_ticks_alone(ctx, monkeypatch):
    """No GET /sessions/{id} at all: the mesh is sent, settles, and the rig behind it starts, by the tick."""
    mesh = FakeProvider("img3d", states=[("running", "메시 생성 중")], assets=[_asset("glb", "sessions/x/m.glb")])
    rig = FakeProvider("rig", states=[("running", "리깅 중")], assets=[_asset("rigged_glb", "sessions/x/r.glb")])
    for fake in (mesh, rig):
        monkeypatch.setitem(jobs.PROVIDERS, fake.name, fake)
    m = jobs.create_job(ctx, SID, "mesh3d", "img3d", {}, [])
    r = jobs.create_job(ctx, SID, "rig", "rig", {}, [m["jobId"]])
    assert _marked(ctx) == [SID]

    assert jobs.advance_active(ctx) == {"sessions": 1, "advanced": 1}
    assert _job(ctx, m["jobId"])["status"] == "running" and _job(ctx, r["jobId"])["status"] == "queued"

    mesh.states = [("done", "")]
    jobs.advance_active(ctx)  # the mesh settles and, in the same pass, its dependent is sent
    assert _job(ctx, m["jobId"])["status"] == "done" and len(rig.submitted) == 1
    assert _marked(ctx) == [SID]  # the rig is still running

    rig.states = [("done", "")]
    _old(ctx)
    jobs.advance_active(ctx)
    assert _job(ctx, r["jobId"])["status"] == "done"
    assert _marked(ctx) == []  # the session's last job settled: the mark went with it
    assert len(mesh.submitted) == 1 and len(rig.submitted) == 1


def test_an_idle_tick_costs_one_read_and_writes_nothing(ctx):
    ctx.table.calls.clear()
    assert jobs.advance_active(ctx) == {"sessions": 0, "advanced": 0}
    assert ctx.table.calls == ["query"]


def test_the_tick_reads_only_the_sessions_that_are_marked(ctx, monkeypatch):
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", FakeProvider("deadline"))
    jobs.create_job(ctx, SID, "render3d", "deadline", {}, [])
    store.put_job(ctx, OTHER, {"jobId": "job_unmarked", "kind": "render3d", "provider": "deadline", "status": "done",
                               "input": {}, "outputs": [], "deps": [], "rev": 0})
    seen = []
    real = store.snapshot
    monkeypatch.setattr(store, "snapshot", lambda c, sid: seen.append(sid) or real(c, sid))
    jobs.advance_active(ctx)
    assert set(seen) == {SID}


def test_a_failed_chain_also_clears_its_mark(ctx, monkeypatch):
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", FakeProvider("deadline", states=[("failed", "렌더 실패")]))
    job = jobs.create_job(ctx, SID, "render3d", "deadline", {}, [])
    _old(ctx)
    jobs.advance_active(ctx)
    assert _job(ctx, job["jobId"])["status"] == "failed" and _marked(ctx) == []
    ctx.table.calls.clear()
    jobs.advance_active(ctx)
    assert ctx.table.calls == ["query"]  # idle again


def test_a_fresh_mark_stays_through_a_tick_that_finds_no_job_yet(ctx):
    """create_job writes the mark first and the job right after: a tick in between sees a session with nothing in
    flight, and must leave the mark for the job that is coming."""
    store.mark_active(ctx, SID)
    jobs.advance_active(ctx)
    assert _marked(ctx) == [SID]
    _old(ctx)  # nothing came (the job's write failed): the mark goes once it is no longer fresh
    jobs.advance_active(ctx)
    assert _marked(ctx) == []


def test_a_mark_renewed_while_the_tick_looked_is_not_removed(ctx, monkeypatch):
    """The tick read the mark and found the session settled; a job was created before the tick removed the mark
    (its mark write renewed it): the removal is refused, so the new job is not left to a tab's poll."""
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", FakeProvider("deadline"))
    store.mark_active(ctx, SID)
    _old(ctx)
    real = jobs.advance_jobs

    def advance_then_a_job_arrives(c, sid):
        active = real(c, sid)
        jobs.create_job(c, sid, "render3d", "deadline", {}, [])
        return active
    monkeypatch.setattr(jobs, "advance_jobs", advance_then_a_job_arrives)
    jobs.advance_active(ctx)
    assert _marked(ctx) == [SID]
    monkeypatch.setattr(jobs, "advance_jobs", real)
    jobs.advance_active(ctx)
    assert [j["status"] for j in store.snapshot(ctx, SID)["jobs"]] == ["running"]


def test_a_retry_marks_the_session_again(ctx, monkeypatch):
    fake = FakeProvider("deadline", states=[("failed", "렌더 실패")])
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", fake)
    job = jobs.create_job(ctx, SID, "render3d", "deadline", {}, [])
    _old(ctx)
    jobs.advance_active(ctx)
    assert _marked(ctx) == []
    assert jobs.retry_job(ctx, SID, job["jobId"]) == [job["jobId"]]
    assert _marked(ctx) == [SID]
    fake.states = [("running", "렌더 중")]
    jobs.advance_active(ctx)
    assert _job(ctx, job["jobId"])["status"] == "running" and len(fake.submitted) == 2


def test_a_tab_poll_in_the_middle_of_the_ticks_submit_sends_nothing_twice(ctx, monkeypatch):
    """The tick and a studio tab advance the same session at the same moment: the claim (queued → running, on the
    job's rev) is taken once, so the provider gets one submit."""
    class TabPollsDuringSubmit(FakeProvider):
        def submit(self, job, ctx_):
            jobs.advance_jobs(ctx_, SID)  # GET /sessions/{id} lands while the tick's submit is in flight
            return super().submit(job, ctx_)

    fake = TabPollsDuringSubmit("deadline")
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", fake)
    job = jobs.create_job(ctx, SID, "render3d", "deadline", {}, [])
    jobs.advance_active(ctx)
    assert fake.attempts == 1 and len(fake.submitted) == 1
    stored = _job(ctx, job["jobId"])
    assert stored["status"] == "running" and stored["externalId"] == f"ext-{job['jobId']}"


def test_a_tab_poll_that_claims_first_leaves_the_tick_nothing_to_send(ctx, monkeypatch):
    """The other order: both read the job queued, the tab's claim lands first, the tick's write loses on the rev."""
    fake = FakeProvider("deadline")
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", fake)
    job = jobs.create_job(ctx, SID, "render3d", "deadline", {}, [])
    real, raced = store.update_job, []

    def tab_first(c, sid, job_id, expect=None, **fields):
        if fields.get("status") == "running" and not raced:  # the tick is about to claim
            raced.append(True)
            jobs.advance_jobs(c, sid)  # the tab's whole pass: claim, submit, external id
        return real(c, sid, job_id, expect=expect, **fields)
    monkeypatch.setattr(store, "update_job", tab_first)
    jobs.advance_active(ctx)
    assert raced and fake.attempts == 1
    assert _job(ctx, job["jobId"])["externalId"] == f"ext-{job['jobId']}"


def test_a_finished_result_is_collected_once_when_both_look(ctx, monkeypatch):
    class TabPollsDuringCollect(FakeProvider):
        def collect(self, job, ctx_):
            jobs.advance_jobs(ctx_, SID)
            return super().collect(job, ctx_)

    fake = TabPollsDuringCollect("deadline", states=[("done", "")], assets=[_asset("turntable", "sessions/x/tt.mp4")])
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", fake)
    job = jobs.create_job(ctx, SID, "render3d", "deadline", {}, [])
    jobs.advance_active(ctx)
    assert _job(ctx, job["jobId"])["status"] == "done"
    assert len(store.snapshot(ctx, SID)["assets"]) == 1  # one asset, not one per look


def test_one_broken_session_does_not_stop_the_others(ctx, monkeypatch):
    fake = FakeProvider("deadline")
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", fake)
    jobs.create_job(ctx, OTHER, "render3d", "deadline", {}, [])
    jobs.create_job(ctx, SID, "render3d", "deadline", {}, [])
    real = jobs.advance_jobs

    def broken(c, sid):
        if sid == OTHER:
            raise RuntimeError("ProvisionedThroughputExceededException")
        return real(c, sid)
    monkeypatch.setattr(jobs, "advance_jobs", broken)
    out = jobs.advance_active(ctx)
    assert out["sessions"] == 2 and len(fake.submitted) == 1
    assert sorted(_marked(ctx)) == sorted([SID, OTHER])  # the broken one is tried again next minute


def test_a_long_list_is_cut_at_the_budget_and_starts_elsewhere_next_minute(ctx, monkeypatch):
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", FakeProvider("deadline"))
    ids = [f"ses_{n}" for n in range(4)]
    for sid in ids:
        jobs.create_job(ctx, sid, "render3d", "deadline", {}, [])
    clock = {"mono": 0.0, "wall": 0.0}
    monkeypatch.setattr(jobs.time, "monotonic", lambda: clock["mono"])
    monkeypatch.setattr(jobs.time, "time", lambda: clock["wall"])
    real, order = jobs.advance_jobs, []

    def slow(c, sid):
        order.append(sid)
        clock["mono"] += jobs.TICK_BUDGET_SEC / 2 + 1  # two sessions fill a tick
        return real(c, sid)
    monkeypatch.setattr(jobs, "advance_jobs", slow)
    first = jobs.advance_active(ctx)
    assert first == {"sessions": 4, "advanced": 2}
    clock["mono"], clock["wall"] = 1000.0, 120.0  # two minutes on
    jobs.advance_active(ctx)
    assert sorted(order) == sorted(ids)  # the tail was not starved


def test_a_job_that_never_settles_is_not_ticked_for_ever(ctx, monkeypatch, capsys):
    """A render the farm lost stays "running": its session's mark goes a day after the last job was made there, and
    the session is left to its tab's polls (the job itself is untouched)."""
    fake = FakeProvider("deadline")  # running, always
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", fake)
    job = jobs.create_job(ctx, SID, "render3d", "deadline", {}, [])
    _old(ctx, minutes=23 * 60)
    jobs.advance_active(ctx)
    assert _marked(ctx) == [SID] and _job(ctx, job["jobId"])["status"] == "running"  # within the day: still ticked
    _old(ctx, minutes=24 * 60 + 1)
    real, read = store.snapshot, []
    monkeypatch.setattr(store, "snapshot", lambda c, sid: read.append(sid) or real(c, sid))
    assert jobs.advance_active(ctx) == {"sessions": 1, "advanced": 1}
    monkeypatch.setattr(store, "snapshot", real)
    assert read == [] and _marked(ctx) == [] and _job(ctx, job["jobId"])["status"] == "running"
    assert SID in capsys.readouterr().out  # said in the log
    jobs.retry_job(ctx, SID, job["jobId"])  # (not failed: no retry) and a new job marks the session again
    jobs.create_job(ctx, SID, "render3d", "deadline", {}, [])
    assert _marked(ctx) == [SID]


def test_a_pass_never_writes_a_job_back_after_its_session_was_deleted(ctx, monkeypatch):
    """The tick looks at a session a tab deletes at the same moment: its bookkeeping write (polledAt) must not bring
    the job's item back as a row of its own."""
    class DeletedDuringStatus(FakeProvider):
        def status(self, job, ctx_):
            for key in [k for k in ctx_.table.items if k[0] == f"SESSION#{SID}"]:
                del ctx_.table.items[key]
            return ("running", "렌더 중")

    monkeypatch.setitem(jobs.PROVIDERS, "deadline", DeletedDuringStatus("deadline"))
    job = jobs.create_job(ctx, SID, "render3d", "deadline", {}, [])
    store.update_job(ctx, SID, job["jobId"], status="running", externalId="ext-1")
    jobs.advance_active(ctx)
    assert not [k for k in ctx.table.items if k[0] == f"SESSION#{SID}"]


def test_the_handler_runs_the_tick_for_the_scheduled_action(ctx, monkeypatch):
    monkeypatch.setattr(app, "CTX", ctx)
    fake = FakeProvider("deadline")
    monkeypatch.setitem(jobs.PROVIDERS, "deadline", fake)
    jobs.create_job(ctx, SID, "render3d", "deadline", {}, [])
    assert app.handler({"action": "jobs_tick"}, None) == {"sessions": 1, "advanced": 1}
    assert len(fake.submitted) == 1
    assert json.dumps(app.handler({"action": "jobs_tick"}, None))  # a plain answer the scheduler can take


def test_the_marks_calls_fit_dynamodbs_api_and_a_refused_removal_reads_as_false():
    """The real client with stubbed answers: botocore checks each request against DynamoDB's API model, which the
    table's fake does not; nothing is sent."""
    table = boto3.resource("dynamodb", region_name="us-east-1", aws_access_key_id="x",
                           aws_secret_access_key="x").Table("ipverse-main")
    real = make_ctx(table=table)
    mark = {"sessionId": SID, "at": "2026-11-16T03:27:01.000Z"}
    asked = {"TableName": "ipverse-main", "Key": {"pk": store.ACTIVE_PK, "sk": f"SESSION#{SID}"},
             "ConditionExpression": "#c = :c", "ExpressionAttributeNames": {"#c": "at"},
             "ExpressionAttributeValues": {":c": mark["at"]}}
    with Stubber(table.meta.client) as ddb:
        ddb.add_response("put_item", {})
        store.mark_active(real, SID)
        ddb.add_response("query", {"Items": [], "Count": 0, "ScannedCount": 0})
        assert store.active_sessions(real) == []
        ddb.add_response("delete_item", {}, asked)
        assert store.clear_active(real, mark) is True
        ddb.add_client_error("delete_item", "ConditionalCheckFailedException")  # renewed since it was read
        assert store.clear_active(real, mark) is False
        ddb.add_response("update_item", {})  # the pass's bookkeeping, onto an item that is there
        assert store.update_job(real, SID, "job_1", expect={"jobId": "job_1"}, polledAt=store.now()) is True
        ddb.add_client_error("update_item", "ConditionalCheckFailedException")  # ... and onto one that is gone
        assert store.update_job(real, SID, "job_1", expect={"jobId": "job_1"}, polledAt=store.now()) is False
        ddb.assert_no_pending_responses()
