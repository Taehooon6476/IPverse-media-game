"""DELETE /api/sessions/{id}: every item under the session, its sidebar index item, and its S3 files go."""
import json
from datetime import datetime

import pytest
from botocore.stub import ANY, Stubber

from server import store
from server.tests.conftest import _client_error
from server.tests.test_app import call, ctx  # noqa: F401 — the app fixture

BUCKET = "test-assets"


def _fill(ctx, sid):
    """One of every item kind the store and the live code write under a session, and files for each."""
    store.put_message(ctx, sid, "user", "안녕", "done")
    store.put_ip(ctx, sid, {"ipId": "ip_1", "name": "루나"})
    store.put_asset(ctx, sid, {"kind": "image", "key": f"sessions/{sid}/a.png", "contentType": "image/png"})
    store.put_job(ctx, sid, {"jobId": "job_1", "kind": "image", "provider": "x", "status": "done", "deps": []})
    store.put_job(ctx, sid, {"jobId": "job_2", "kind": "video", "provider": "x", "status": "failed", "deps": []})
    store.put_game(ctx, sid, {"gameId": "gm_del1", "title": "게임"})
    store._put(ctx, store._pk(sid), "EVENT#lj_1#round#00001", {"type": "round_end"})  # ads.log_round
    for i in range(2500):  # more than one list page and one DeleteObjects call
        ctx.s3.put_object(Bucket=BUCKET, Key=f"sessions/{sid}/f{i:04d}.png", Body=b"x")
    ctx.s3.put_object(Bucket=BUCKET, Key="games/gm_del1/index.html", Body=b"<html>")
    ctx.s3.put_object(Bucket=BUCKET, Key="games/gm_del1/spec.json", Body=b"{}")


def _session(**body):
    status, data = call("POST", "/api/sessions", body)
    assert status == 201
    return data["session"]["sessionId"]


def test_delete_removes_every_item_kind_and_the_s3_prefixes(ctx):
    sid, keep = _session(title="지울 세션"), _session(title="남길 세션")
    _fill(ctx, sid)
    ctx.s3.put_object(Bucket=BUCKET, Key=f"sessions/{keep}/k.png", Body=b"x")
    ctx.s3.put_object(Bucket=BUCKET, Key="games/gm_other/index.html", Body=b"x")
    ctx.s3.put_object(Bucket=BUCKET, Key=f"sessions/{sid}x/near.png", Body=b"x")  # same text prefix, other session
    ctx.s3.page_size = 1000

    status, data = call("DELETE", f"/api/sessions/{sid}")
    assert status == 200 and data == {"deleted": sid}

    assert [k for k in ctx.table.items if k[0] == f"SESSION#{sid}"] == []
    assert [s["sessionId"] for s in call("GET", "/api/sessions")[1]["sessions"]] == [keep]
    left = {k for (b, k) in ctx.s3._store if b == BUCKET}
    assert not any(k.startswith((f"sessions/{sid}/", "games/gm_del1/")) for k in left)
    assert {f"sessions/{keep}/k.png", "games/gm_other/index.html", f"sessions/{sid}x/near.png"} <= left
    assert all(len(c) <= 1000 for c in ctx.s3.delete_calls) and len(ctx.s3.delete_calls) >= 3
    assert call("GET", f"/api/sessions/{sid}")[0] == 404


def test_delete_is_idempotent(ctx):
    sid = _session()
    _fill(ctx, sid)
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200
    # gone: a second delete is "not found", never a 500
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 404


def test_delete_after_a_partial_run_finishes_the_job(ctx, monkeypatch):
    """A delete that died part way (Lambda timeout) is finished by the next one: META goes last."""
    sid = _session()
    _fill(ctx, sid)
    real = ctx.table.delete_item
    calls = {"n": 0}

    def flaky(Key, **kw):
        calls["n"] += 1
        if calls["n"] == 3:
            raise RuntimeError("timeout")
        return real(Key=Key, **kw)

    monkeypatch.setattr(ctx.table, "delete_item", flaky)
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 500
    assert store.get_session(ctx, sid) is not None
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200
    assert [k for k in ctx.table.items if k[0] == f"SESSION#{sid}"] == []


def test_delete_refuses_another_users_session(ctx):
    sid = _session()
    _fill(ctx, sid)
    status, data = call("DELETE", f"/api/sessions/{sid}", token="other-token")
    assert status == 404 and data["error"] == "not_found"
    assert store.get_session(ctx, sid) is not None
    assert (BUCKET, "games/gm_del1/index.html") in ctx.s3._store
    assert (BUCKET, f"sessions/{sid}/f0000.png") in ctx.s3._store


def test_delete_refuses_a_live_broadcast(ctx, monkeypatch):
    monkeypatch.setenv("LIVE_BUCKET", "live-b")
    sid = _session()
    _fill(ctx, sid)
    ctx.s3.put_object(Bucket="live-b", Key="broadcaster/job.json",
                      Body=json.dumps({"jobId": "lj_1", "sessionId": sid, "mode": "player"}))
    status, data = call("DELETE", f"/api/sessions/{sid}")
    assert status == 409 and data["error"] == "live_on_air" and "방송" in data["message"]
    assert store.get_session(ctx, sid) is not None
    assert (BUCKET, "games/gm_del1/index.html") in ctx.s3._store

    # stopped: the delete goes through
    ctx.s3.put_object(Bucket="live-b", Key="broadcaster/job.json",
                      Body=json.dumps({"jobId": "lj_1", "sessionId": sid, "mode": "player", "stop": True}))
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200


def test_delete_ignores_another_sessions_broadcast(ctx, monkeypatch):
    monkeypatch.setenv("LIVE_BUCKET", "live-b")
    sid = _session()
    ctx.s3.put_object(Bucket="live-b", Key="broadcaster/job.json",
                      Body=json.dumps({"jobId": "lj_1", "sessionId": "ses_other", "mode": "player"}))
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200


@pytest.mark.parametrize("status", ["queued", "running"])
def test_delete_refuses_running_jobs(ctx, status):
    sid = _session()
    _fill(ctx, sid)
    store.put_job(ctx, sid, {"jobId": "job_run", "kind": "video", "provider": "x", "status": status, "deps": []})
    code, data = call("DELETE", f"/api/sessions/{sid}")
    assert code == 409 and data["error"] == "jobs_running" and "1건" in data["message"]
    assert store.get_session(ctx, sid) is not None


def test_delete_refuses_a_reply_in_progress(ctx):
    sid = _session()
    store.put_message(ctx, sid, "assistant", "", "pending")
    code, data = call("DELETE", f"/api/sessions/{sid}")
    assert code == 409 and data["error"] == "turn_running"


# 3D jobs keep copies outside sessions/<id>/, in prefixes each provider keys by job id: the GPU box's input and output
# in the assets bucket, what the Deadline farm was handed and wrote in the queue bucket. The delete removes them too.
QUEUE = "griptapenode-queue-087967639890-us-east-1-an"
D7 = [("job_6db23190a2", "mesh3d", "img3d"), ("job_1797623ff5", "render3d", "deadline"),
      ("job_f1bcd8f3f1", "rig", "rig"), ("job_49c31f1b19", "mesh3d", "img3d"),
      ("job_a152e6718d", "render3d", "deadline")]
TURNTABLE = ("inputs/model.glb", "meta.json", "poster.png", "turntable.mp4")
RIG = ("front.png", "inputs/model.glb", "inputs/pose.onnx", "inputs/ual.glb", "meta.json", "rig_preview.mp4",
       "rig_sheet.png", "rig_weights.png", "rigged.glb")


def _three_d(ctx, sid):
    """Five finished 3D jobs and the copies they left outside sessions/<id>/. → the 23 (bucket, key)s."""
    scratch = []
    for job_id, kind, provider in D7:
        store.put_job(ctx, sid, {"jobId": job_id, "kind": kind, "provider": provider, "status": "done", "deps": []})
        if provider == "img3d":
            scratch += [(BUCKET, f"img3d/in/{job_id}.png"), (BUCKET, f"img3d/out/{job_id}/model.glb"),
                        (BUCKET, f"img3d/out/{job_id}/status.json")]
        else:
            scratch += [(QUEUE, f"DeadlineCloud/ipverse/{job_id}/{name}") for name in (RIG if kind == "rig" else TURNTABLE)]
    for bucket, key in scratch:
        ctx.s3.put_object(Bucket=bucket, Key=key, Body=b"x")
    return scratch


def test_d7_delete_removes_the_3d_jobs_copies_outside_the_session_prefix(ctx):
    sid = _session()
    scratch = _three_d(ctx, sid)
    assert len(scratch) == 23
    keep = [(BUCKET, "img3d/in/job_other.png"), (BUCKET, "img3d/out/job_other/model.glb"),  # another session's mesh
            (BUCKET, "img3d/out/job_6db23190a2x/model.glb"),  # same text prefix, another job
            (BUCKET, "img3d/queue/head.json"), (BUCKET, "img3d/worker/worker.py"),  # the GPU box's own files
            (BUCKET, "rig/models/rtmpose-m_body7_256x192.onnx"), (BUCKET, "runtime3d/v1/anims/ual.glb"),
            (QUEUE, "DeadlineCloud/ipverse/job_other/rigged.glb"),
            (QUEUE, "DeadlineCloud/ipverse/job_f1bcd8f3f1x/rigged.glb"),
            (QUEUE, "DeadlineCloud/griptape/job_f1bcd8f3f1/out.png")]  # the queue bucket's other tenants
    for bucket, key in keep:
        ctx.s3.put_object(Bucket=bucket, Key=key, Body=b"x")
    ctx.s3.page_size = 4  # the rig's nine objects take three list pages

    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200

    assert [k for k in scratch if k in ctx.s3._store] == []
    assert [k for k in keep if k not in ctx.s3._store] == []
    rig = [keys for keys in ctx.s3.delete_calls if keys[0].startswith("DeadlineCloud/ipverse/job_f1bcd8f3f1/")]
    assert [len(keys) for keys in rig] == [4, 4, 1]


def test_d7_a_delete_that_died_in_the_scratch_is_finished_by_the_next_one(ctx, monkeypatch):
    sid = _session()
    scratch = _three_d(ctx, sid)
    real, died = ctx.s3.list_objects_v2, []

    def flaky(**kw):
        if kw["Prefix"] == "img3d/out/job_6db23190a2/" and not died:
            died.append(kw["Prefix"])
            raise RuntimeError("SlowDown")
        return real(**kw)

    monkeypatch.setattr(ctx.s3, "list_objects_v2", flaky)
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 500
    # the job items are the only record of where the scratch is: they go after it
    assert {j["jobId"] for j in store.snapshot(ctx, sid)["jobs"]} == {job_id for job_id, _, _ in D7}
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200
    assert [k for k in scratch if k in ctx.s3._store] == []
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 404


def test_d7_a_refused_scratch_delete_is_logged_and_the_session_still_goes(ctx, monkeypatch, capsys):
    """A role with no s3:DeleteObject on the queue bucket's prefix: S3 answers such a DeleteObjects with 200 and an
    AccessDenied per key."""
    sid = _session()
    scratch = _three_d(ctx, sid)
    real = ctx.s3.delete_objects

    def denied(Bucket, Delete):
        if Bucket != QUEUE:
            return real(Bucket=Bucket, Delete=Delete)
        return {"Errors": [{"Key": o["Key"], "Code": "AccessDenied", "Message": "Access Denied"} for o in Delete["Objects"]]}

    monkeypatch.setattr(ctx.s3, "delete_objects", denied)
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200
    assert call("GET", f"/api/sessions/{sid}")[0] == 404
    assert {bucket for bucket, key in scratch if (bucket, key) in ctx.s3._store} == {QUEUE}
    lines = [line for line in capsys.readouterr().out.splitlines() if "AccessDenied" in line]
    assert len(lines) == 3 and all(sid in line and f"s3://{QUEUE}/DeadlineCloud/ipverse/job_" in line for line in lines)


# The CDN: /sessions/* is cached at the edge for a day, so the delete invalidates the session's and its games' folders
# or CloudFront goes on answering for files S3 no longer has.
PARAM, DIST = "/ipverse/cdn-distribution-id", "EQC0HYZ4T1PP5"
D7_SEEN = ("job_7a68ee3875.png", "8e81e93e-ae6c-4244-b8ad-d0c3408d0088.mp4", "71fcdbfd-c322-4593-8410-c1571b9af6de.mp4")
HIT, MISS, GONE = (200, "Hit from cloudfront"), (200, "Miss from cloudfront"), (403, "Error from cloudfront")


class FakeCloudFront:
    """The distribution's edge in front of the assets bucket: a file fetched once is answered from the edge's copy
    until an invalidation names it (a trailing * stands for any rest). Like CloudFront it keeps 15 wildcard paths
    active (Service Quotas L-DAD40481) and refuses the batch that would pass that."""

    def __init__(self, s3):
        self.s3, self.copies, self.batches, self.in_progress, self.refuse = s3, set(), [], 0, None

    def get(self, path):
        """A viewer's GET → (status, X-Cache)."""
        if path in self.copies:
            return HIT
        if (BUCKET, path[1:]) not in self.s3._store:
            return GONE  # S3 behind the origin access control answers a missing key 403
        self.copies.add(path)
        return MISS

    def create_invalidation(self, DistributionId, InvalidationBatch):
        paths = InvalidationBatch["Paths"]["Items"]
        assert DistributionId == DIST and InvalidationBatch["Paths"]["Quantity"] == len(paths)
        assert all(p.startswith("/") for p in paths)
        wildcards = sum(p.endswith("*") for p in paths)
        if self.refuse or self.in_progress + wildcards > 15:
            raise _client_error(self.refuse or "TooManyInvalidationsInProgress", "CreateInvalidation")
        self.in_progress += wildcards
        self.batches.append({"paths": paths, "ref": InvalidationBatch["CallerReference"]})
        self.copies = {c for c in self.copies
                       if not any(c.startswith(p[:-1]) if p.endswith("*") else c == p for p in paths)}
        return {"Invalidation": {"Id": f"I{len(self.batches)}", "Status": "InProgress"}}


class FakeSsm:
    def __init__(self, values):
        self.values, self.reads = values, 0

    def get_parameter(self, Name, **kwargs):
        self.reads += 1
        if Name not in self.values:
            raise _client_error("ParameterNotFound", "GetParameter")
        return {"Parameter": {"Name": Name, "Type": "String", "Value": self.values[Name]}}


@pytest.fixture
def edge(ctx, monkeypatch):
    """The deployed API's CDN: the distribution's id in the parameter its stack writes, CloudFront behind it."""
    monkeypatch.setenv("CDN_DISTRIBUTION_PARAM", PARAM)
    monkeypatch.setattr(store, "_distribution", {})
    ctx.ssm, ctx.cloudfront = FakeSsm({PARAM: DIST}), FakeCloudFront(ctx.s3)
    return ctx.cloudfront


def _shown(ctx, edge, paths):
    """The files exist and a page showed them: the edge holds a copy of each."""
    for path in paths:
        ctx.s3.put_object(Bucket=BUCKET, Key=path[1:], Body=b"x")
    assert [edge.get(path) for path in paths] == [MISS] * len(paths)


def _lines(capsys, word):
    return [line for line in capsys.readouterr().out.splitlines() if word in line]


def test_d7_a_deleted_sessions_files_are_gone_from_the_edge_too(ctx, edge):
    sid, keep = _session(), _session()
    _fill(ctx, sid)
    seen = [f"/sessions/{sid}/{name}" for name in (*D7_SEEN, "highlights/hl_1/round.mp4")]
    seen += ["/games/gm_del1/index.html", "/games/gm_del1/assets/ip_1.glb"]
    kept = [f"/sessions/{keep}/k.png", f"/sessions/{sid}x/near.png", "/games/gm_other/index.html"]
    _shown(ctx, edge, seen + kept)

    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200

    assert [edge.get(path) for path in seen] == [GONE] * len(seen)
    assert [edge.get(path) for path in kept] == [HIT] * len(kept)
    # one invalidation, by folder: CloudFront bills a wildcard path as one path whatever it covers
    assert [batch["paths"] for batch in edge.batches] == [[f"/sessions/{sid}/*", "/games/gm_del1/*"]]
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 404 and len(edge.batches) == 1


def test_d7_a_delete_that_died_before_the_invalidation_sends_it_the_next_time(ctx, edge, monkeypatch):
    sid = _session()
    _fill(ctx, sid)
    seen = [f"/sessions/{sid}/f0000.png", "/games/gm_del1/index.html"]
    _shown(ctx, edge, seen)
    real, died = ctx.s3.list_objects_v2, []

    def flaky(**kw):
        if kw["Prefix"] == f"sessions/{sid}/" and not died:
            died.append(kw["Prefix"])
            raise RuntimeError("SlowDown")
        return real(**kw)

    monkeypatch.setattr(ctx.s3, "list_objects_v2", flaky)
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 500
    # files were still in the bucket: an edge asked now would fetch and keep one again
    assert edge.batches == [] and (BUCKET, f"sessions/{sid}/f0000.png") in ctx.s3._store
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200
    assert [batch["paths"] for batch in edge.batches] == [[f"/sessions/{sid}/*", "/games/gm_del1/*"]]
    assert [edge.get(path) for path in seen] == [GONE, GONE]


def test_d7_a_delete_that_died_after_the_invalidation_had_named_every_folder(ctx, edge, monkeypatch):
    """The game items are the only record of the games' folders: the invalidation goes before them."""
    sid = _session()
    _fill(ctx, sid)
    seen = [f"/sessions/{sid}/f0000.png", "/games/gm_del1/index.html"]
    _shown(ctx, edge, seen)
    real, gone, died = ctx.table.delete_item, [], []

    def flaky(Key, **kw):
        if gone and not died:
            died.append(Key["sk"])
            raise RuntimeError("timeout")
        if Key["sk"].startswith("GAME#"):
            gone.append(Key["sk"])
        return real(Key=Key, **kw)

    monkeypatch.setattr(ctx.table, "delete_item", flaky)
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 500
    assert gone == ["GAME#gm_del1"] and store.get_session(ctx, sid) is not None
    assert [batch["paths"] for batch in edge.batches] == [[f"/sessions/{sid}/*", "/games/gm_del1/*"]]
    assert [edge.get(path) for path in seen] == [GONE, GONE]
    # the next delete finds no game item: it names the session's folder once more, under a reference of its own
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200
    assert [batch["paths"] for batch in edge.batches[1:]] == [[f"/sessions/{sid}/*"]]
    assert len({batch["ref"] for batch in edge.batches}) == 2
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 404 and len(edge.batches) == 2


@pytest.mark.parametrize("refusal", ["TooManyInvalidationsInProgress", "AccessDenied"])
def test_d7_a_refused_invalidation_is_logged_and_the_session_still_goes(ctx, edge, capsys, refusal):
    """CloudFront has no room while 15 wildcard paths are active (deletes in a row, a hotpatch of many games); the
    grant is a policy of its own, which a stack update may attach after the function's new code."""
    sid = _session()
    _fill(ctx, sid)
    _shown(ctx, edge, [f"/sessions/{sid}/f0000.png"])
    if refusal == "AccessDenied":
        edge.refuse = refusal
    else:
        edge.in_progress = 14  # this delete's two paths do not fit

    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200

    assert call("GET", f"/api/sessions/{sid}")[0] == 404
    assert not [k for (b, k) in ctx.s3._store if k.startswith((f"sessions/{sid}/", "games/gm_del1/"))]
    assert edge.batches == [] and edge.get(f"/sessions/{sid}/f0000.png") == HIT  # until the copy expires
    [line] = _lines(capsys, refusal)
    assert sid in line and f"/sessions/{sid}/*" in line and "/games/gm_del1/*" in line


def test_d7_an_unreadable_distribution_id_is_logged_and_read_again_by_the_next_delete(ctx, edge, capsys):
    first, second, third = _session(), _session(), _session()
    ctx.ssm.values = {}  # the parameter is gone (deleted by hand; the stack writes it)
    assert call("DELETE", f"/api/sessions/{first}")[0] == 200
    [line] = _lines(capsys, "ParameterNotFound")
    assert first in line and f"/sessions/{first}/*" in line and edge.batches == []

    ctx.ssm.values = {PARAM: DIST}
    assert call("DELETE", f"/api/sessions/{second}")[0] == 200
    assert call("DELETE", f"/api/sessions/{third}")[0] == 200
    assert [batch["paths"] for batch in edge.batches] == [[f"/sessions/{second}/*"], [f"/sessions/{third}/*"]]
    assert ctx.ssm.reads == 2  # the id is read once per process, not per delete


@pytest.mark.parametrize("games", [0, 1, 2, 3, 38])
def test_d7_a_delete_takes_at_most_three_of_cloudfronts_fifteen_wildcard_paths(ctx, edge, games):
    """A session may hold dozens of games, and a batch naming each folder could never be taken: past two games the
    delete names all of /games/, whose files are then fetched again from the bucket."""
    sid = _session()
    ids = [f"gm_{n:02d}" for n in range(games)]
    for game_id in ids:
        store.put_game(ctx, sid, {"gameId": game_id, "title": "게임"})
    seen = [f"/games/{game_id}/index.html" for game_id in ids]
    _shown(ctx, edge, seen + ["/games/gm_other/index.html"])

    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200

    named = games <= 2
    assert [batch["paths"] for batch in edge.batches] == [
        [f"/sessions/{sid}/*"] + ([f"/games/{game_id}/*" for game_id in ids] if named else ["/games/*"])]
    assert [edge.get(path) for path in seen] == [GONE] * games
    assert edge.get("/games/gm_other/index.html") == (HIT if named else MISS)  # another session's game


def test_d7_five_deletes_in_a_row_fit_in_progress_together(ctx, edge):
    for _ in range(5):
        sid = _session()
        for n in range(2):
            store.put_game(ctx, sid, {"gameId": store.new_id("gm"), "title": "게임"})
        assert call("DELETE", f"/api/sessions/{sid}")[0] == 200
    assert [len(batch["paths"]) for batch in edge.batches] == [3] * 5 and edge.in_progress == 15


def test_d7_with_no_distribution_named_the_delete_asks_nothing_of_cloudfront_and_says_so(ctx, monkeypatch, capsys):
    """Without CDN_DISTRIBUTION_PARAM (unit tests, local dev, a server deployed without its stack) no client is
    built, and the log says the edges' copies were left."""
    monkeypatch.delenv("CDN_DISTRIBUTION_PARAM", raising=False)
    ctx.ssm = FakeSsm({PARAM: DIST})
    sid = _session()
    _fill(ctx, sid)
    assert call("DELETE", f"/api/sessions/{sid}")[0] == 200
    assert call("GET", f"/api/sessions/{sid}")[0] == 404
    assert ctx.ssm.reads == 0 and getattr(ctx, "cloudfront", None) is None
    [line] = _lines(capsys, "CDN_DISTRIBUTION_PARAM")
    assert sid in line and f"/sessions/{sid}/*" in line


def test_d7_the_client_the_delete_builds_gives_up_in_seconds_and_its_call_fits_the_api(ctx, monkeypatch, capsys):
    """The delete waits on CloudFront inside a request (the page is answered 504 after 60 s). The client is the real
    one with a stubbed answer: botocore checks the request against CloudFront's API model, nothing is sent."""
    monkeypatch.setenv("CDN_DISTRIBUTION_PARAM", PARAM)
    monkeypatch.setattr(store, "_distribution", {})
    ctx.ssm = FakeSsm({PARAM: DIST})
    client = store._cloudfront(ctx)
    config = client.meta.config
    assert (config.connect_timeout, config.read_timeout, config.retries["total_max_attempts"]) == (3, 10, 2)
    sid = _session()
    _fill(ctx, sid)
    batch = {"Paths": {"Quantity": 2, "Items": [f"/sessions/{sid}/*", "/games/gm_del1/*"]}, "CallerReference": ANY}
    with Stubber(client) as cloudfront:
        cloudfront.add_response(
            "create_invalidation",
            {"Invalidation": {"Id": "I1", "Status": "InProgress", "CreateTime": datetime(2026, 11, 12),
                              "InvalidationBatch": {**batch, "CallerReference": sid}}},
            {"DistributionId": DIST, "InvalidationBatch": batch})
        assert call("DELETE", f"/api/sessions/{sid}")[0] == 200
        cloudfront.assert_no_pending_responses()
    assert store._cloudfront(ctx) is client and _lines(capsys, "CloudFront") == []
