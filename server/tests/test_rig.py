"""Rig provider (Deadline auto-rig) and the render_3d → mesh3d → rig chain."""
import json

import pytest

from server import jobs, store, tools
from server.providers.rig import POSE_MODEL_KEY, UAL_KEY, RigProvider
from server.tests.conftest import FakeDeadline, FakeProvider, FakeS3, FakeTable, make_ctx

QUEUE = "griptapenode-queue-087967639890-us-east-1-an"
OUT = "DeadlineCloud/ipverse/job_r1/"


def _job(**inp):
    return {"pk": "SESSION#ses_1", "jobId": "job_r1", "externalId": "dl-1",
            "input": {"ipId": "ip_1", "glbKey": "sessions/ses_1/job_m1.glb", **inp}}


def test_submit_stages_mesh_clips_and_pose_model_in_the_queue_inputs():
    s3, deadline = FakeS3(), FakeDeadline()
    ctx = make_ctx(s3=s3, deadline=deadline)
    assert RigProvider(template_loader=lambda: {"name": "rig"}).submit(_job(), ctx) == "job-1"
    assert [(c["CopySource"]["Key"], c["Bucket"], c["Key"]) for c in s3.copies] == [
        ("sessions/ses_1/job_m1.glb", QUEUE, OUT + "inputs/model.glb"),
        (UAL_KEY, QUEUE, OUT + "inputs/ual.glb"),
        (POSE_MODEL_KEY, QUEUE, OUT + "inputs/pose.onnx")]
    call = deadline.calls[0]
    assert json.loads(call["template"]) == {"name": "rig"} and call["templateType"] == "JSON"
    assert call["parameters"] == {
        "InputUri": {"string": f"s3://{QUEUE}/{OUT}inputs/model.glb"},
        "AnimUri": {"string": f"s3://{QUEUE}/{OUT}inputs/ual.glb"},
        "PoseModelUri": {"string": f"s3://{QUEUE}/{OUT}inputs/pose.onnx"},
        "OutputPrefix": {"string": f"s3://{QUEUE}/DeadlineCloud/ipverse/job_r1"}}


def test_status_failure_reports_the_workers_refusal_reason():
    s3, deadline = FakeS3(), FakeDeadline()
    deadline._job_responses["dl-1"] = {"taskRunStatus": "FAILED", "lifecycleStatus": "CREATE_COMPLETE"}
    ctx = make_ctx(s3=s3, deadline=deadline)
    provider = RigProvider(template_loader=dict)
    # no meta.json: the farm's own status, after a sentence
    assert provider.status(_job(), ctx) == ("failed", "렌더 서버에서 작업이 실패했습니다: FAILED")
    s3._store[(QUEUE, OUT + "meta.json")] = json.dumps({"method": "refused", "fallbackReason": "not a full body"}).encode()
    assert provider.status(_job(), ctx) == ("failed", "움직임 뼈대를 넣을 수 없는 모양입니다: not a full body")
    deadline._job_responses["dl-1"] = {"taskRunStatus": "SUCCEEDED", "lifecycleStatus": "CREATE_COMPLETE"}
    assert provider.status(_job(), ctx) == ("done", "")


def test_collect_copies_rigged_glb_and_preview_with_rig_meta():
    s3 = FakeS3()
    s3._store[(QUEUE, OUT + "rigged.glb")] = b"GLB"
    s3._store[(QUEUE, OUT + "rig_preview.mp4")] = b"MP4"
    cleanup = {"removedFaces": 2123, "slabs": 1, "cards": 0}  # the floor slab the rig stripped first
    s3._store[(QUEUE, OUT + "meta.json")] = json.dumps(
        {"method": "rtmpose", "weights": "voxel_proxy", "ualHipsScale": 0.95, "joints": {"x": 1},
         "cleanup": cleanup}).encode()
    ctx = make_ctx(s3=s3)
    assets = RigProvider(template_loader=dict).collect(_job(), ctx)
    assert [(a["kind"], a["contentType"]) for a in assets] == [("rigged_glb", "model/gltf-binary"),
                                                               ("rig_preview", "video/mp4")]
    assert assets[0]["meta"] == {"method": "rtmpose", "weights": "voxel_proxy", "ualHipsScale": 0.95,
                                 "cleanup": cleanup}
    assert [s3._store[("test-assets", a["key"])] for a in assets] == [b"GLB", b"MP4"]
    assert all(a["key"].startswith("sessions/ses_1/") for a in assets)


def test_rig_provider_is_registered_and_links_the_ip():
    assert isinstance(jobs.PROVIDERS["rig"], RigProvider)
    assert jobs.IP_LINKS["rigged_glb"] == "riggedGlbAssetId"


@pytest.fixture
def ctx():
    return make_ctx(table=FakeTable(), s3=FakeS3())


def _ip(ctx, sid, ip_id, kind, **extra):
    cutout = store.put_asset(ctx, sid, {"kind": "cutout", "key": f"sessions/{sid}/{ip_id}.png",
                                        "contentType": "image/png", "ipId": ip_id})
    return store.put_ip(ctx, sid, {"ipId": ip_id, "kind": kind, "name": ip_id, "version": 1,
                                   "imageAssetId": cutout["assetId"], "cutoutAssetId": cutout["assetId"], **extra})


def test_render_3d_queues_a_rig_job_after_the_mesh_for_humanoids_only(ctx):
    session = store.put_session(ctx, "user-1", "t", "sf-shooter")
    sid = session["sessionId"]
    _ip(ctx, sid, "ip_hero", "character")
    _ip(ctx, sid, "ip_grunt", "enemy", humanoid=True)
    _ip(ctx, sid, "ip_drone", "enemy", humanoid=False)
    _ip(ctx, sid, "ip_box", "prop")
    by_id = lambda: {j["jobId"]: j for j in store.snapshot(ctx, sid)["jobs"]}  # noqa: E731

    for ip_id in ("ip_hero", "ip_grunt"):
        out = tools.render_3d(ctx, session, {"ipId": ip_id})
        rig = by_id()[out["rigJobId"]]
        assert (rig["kind"], rig["provider"], rig["deps"]) == ("rig", "rig", [out["meshJobId"]])
        assert rig["input"] == {"ipId": ip_id, "glbKey": f"sessions/{sid}/{out['meshJobId']}.glb"}
    for ip_id in ("ip_drone", "ip_box"):
        assert "rigJobId" not in tools.render_3d(ctx, session, {"ipId": ip_id})
    assert "rigJobId" not in tools.render_3d(ctx, session, {"ipId": "ip_hero", "model": "relief"})


def test_rig_job_waits_for_the_mesh_then_sets_rigged_glb_on_the_ip(ctx, monkeypatch):
    session = store.put_session(ctx, "user-1", "t", "sf-shooter")
    sid = session["sessionId"]
    _ip(ctx, sid, "ip_hero", "character")
    mesh = FakeProvider("img3d", states=[("running", "shape")])
    rig = FakeProvider("rig", states=[("done", "")],
                       assets=[{"kind": "rigged_glb", "key": f"sessions/{sid}/r.glb", "contentType": "model/gltf-binary",
                                "meta": {"method": "rtmpose"}}])
    for fake in (mesh, rig, FakeProvider("deadline"), FakeProvider("apose", states=[("done", "")])):
        monkeypatch.setitem(jobs.PROVIDERS, fake.name, fake)
    out = tools.render_3d(ctx, session, {"ipId": "ip_hero"})
    jobs.advance_jobs(ctx, sid)
    assert rig.submitted == []  # the mesh is still being made
    mesh.states = [("done", "")]
    jobs.advance_jobs(ctx, sid)
    assert [j["jobId"] for j in rig.submitted] == [out["rigJobId"]]
    jobs.advance_jobs(ctx, sid)
    ip = store.get_ip(ctx, sid, "ip_hero")
    asset = next(a for a in store.snapshot(ctx, sid)["assets"] if a["assetId"] == ip["riggedGlbAssetId"])
    assert asset["kind"] == "rigged_glb" and asset["meta"] == {"method": "rtmpose"}


def _mesh_run(ctx, sid, ip_id, turntable=True):
    """A finished render_3d run of an IP: mesh3d's GLB, then its Blender turntable and poster."""
    mesh = jobs.create_job(ctx, sid, "mesh3d", "img3d", {"ipId": ip_id}, [])
    glb = store.put_asset(ctx, sid, {"kind": "glb", "key": f"sessions/{sid}/{mesh['jobId']}.glb", "jobId": mesh["jobId"],
                                     "ipId": ip_id, "contentType": "model/gltf-binary"})
    store.update_job(ctx, sid, mesh["jobId"], status="done", outputs=[glb["assetId"]])
    out = {"glb": glb["assetId"]}
    if turntable:
        turn = jobs.create_job(ctx, sid, "render3d", "deadline", {"ipId": ip_id, "glbKey": glb["key"]}, [mesh["jobId"]])
        made = [store.put_asset(ctx, sid, {"kind": kind, "key": f"sessions/{sid}/{turn['jobId']}.{ext}", "ipId": ip_id,
                                           "jobId": turn["jobId"], "contentType": ""})
                for kind, ext in (("turntable", "mp4"), ("poster", "png"))]
        store.update_job(ctx, sid, turn["jobId"], status="done", outputs=[a["assetId"] for a in made])
        out.update(turntable=made[0]["assetId"], poster=made[1]["assetId"])
    return out


def test_rig_only_rigs_the_ips_current_mesh_without_a_new_mesh(ctx):
    """A new rig (and its mesh cleanup) reaches an existing character without regenerating its mesh."""
    session = store.put_session(ctx, "user-1", "t", "sf-shooter")
    sid = session["sessionId"]
    _ip(ctx, sid, "ip_hero", "character")
    run = _mesh_run(ctx, sid, "ip_hero")
    store.update_ip(ctx, sid, "ip_hero", glbAssetId=run["glb"])
    before = {j["jobId"] for j in store.snapshot(ctx, sid)["jobs"]}
    out = tools.run_tool(ctx, session, "render_3d", {"ipId": "ip_hero", "rig_only": True})
    new = [j for j in store.snapshot(ctx, sid)["jobs"] if j["jobId"] not in before]
    assert [(j["kind"], j["provider"], j["deps"]) for j in new] == [("rig", "rig", [])]
    glb = next(a for a in store.snapshot(ctx, sid)["assets"] if a["assetId"] == run["glb"])
    assert new[0]["input"] == {"ipId": "ip_hero", "glbKey": glb["key"]}
    assert out["rigJobId"] == new[0]["jobId"] and out["meshAssetId"] == run["glb"]


def test_rig_only_on_an_earlier_mesh_makes_it_current_once_its_rig_lands(ctx, monkeypatch):
    """When the rig of an earlier mesh lands, that mesh, its turntable and poster are the IP's current 3D again."""
    session = store.put_session(ctx, "user-1", "t", "sf-shooter")
    sid = session["sessionId"]
    _ip(ctx, sid, "ip_skel", "enemy", humanoid=True)
    old, new = _mesh_run(ctx, sid, "ip_skel"), _mesh_run(ctx, sid, "ip_skel")
    store.update_ip(ctx, sid, "ip_skel", glbAssetId=new["glb"], turntableAssetId=new["turntable"],
                    posterAssetId=new["poster"])
    rig = FakeProvider("rig", states=[("done", "")],
                       assets=[{"kind": "rigged_glb", "key": f"sessions/{sid}/r.glb", "contentType": "model/gltf-binary",
                                "meta": {}}])
    monkeypatch.setitem(jobs.PROVIDERS, "rig", rig)
    out = tools.run_tool(ctx, session, "render_3d", {"ipId": "ip_skel", "rig_only": True, "mesh_asset_id": old["glb"]})
    assert store.get_ip(ctx, sid, "ip_skel")["glbAssetId"] == new["glb"]  # until the rig lands
    jobs.advance_jobs(ctx, sid)
    jobs.advance_jobs(ctx, sid)
    ip = store.get_ip(ctx, sid, "ip_skel")
    assert store.get_job(ctx, sid, out["rigJobId"])["status"] == "done"
    assert (ip["glbAssetId"], ip["turntableAssetId"], ip["posterAssetId"]) == (old["glb"], old["turntable"], old["poster"])
    assert ip["riggedGlbAssetId"] == store.get_job(ctx, sid, out["rigJobId"])["outputs"][0]


def test_rig_only_refuses_ips_that_are_not_rigged_and_meshes_that_are_not_theirs(ctx):
    session = store.put_session(ctx, "user-1", "t", "sf-shooter")
    sid = session["sessionId"]
    _ip(ctx, sid, "ip_hero", "character")
    _ip(ctx, sid, "ip_drone", "enemy", humanoid=False)
    other = _mesh_run(ctx, sid, "ip_drone", turntable=False)
    store.update_ip(ctx, sid, "ip_drone", glbAssetId=other["glb"])
    relief = store.put_asset(ctx, sid, {"kind": "glb", "key": f"sessions/{sid}/relief.glb", "ipId": "ip_hero",
                                        "contentType": "model/gltf-binary"})  # no mesh3d job behind it
    calls = ({"ipId": "ip_drone"}, {"ipId": "ip_hero"}, {"ipId": "ip_hero", "mesh_asset_id": other["glb"]},
             {"ipId": "ip_hero", "mesh_asset_id": relief["assetId"]})
    for args in calls:
        assert tools.run_tool(ctx, session, "render_3d", {**args, "rig_only": True})["error"] == "bad_args", args
    assert not [j for j in store.snapshot(ctx, sid)["jobs"] if j["kind"] == "rig"]
