"""A game copies its IPs' cutouts, GLBs and rigs into games/<id>/assets/ when it is made. An IP's new file reaches the
session's games that use it, one game can be refreshed on request, and a game's spec never changes."""
import pytest

from server import jobs, store, tools
from server.tests.conftest import FakeLambda, FakeProvider, FakeS3, FakeTable, make_ctx
from server.tests.test_gamespec import authored_spec, minimal_sf

BUCKET = "test-assets"
GLB = "model/gltf-binary"


@pytest.fixture
def ctx(monkeypatch):
    monkeypatch.setenv("SELF_FUNCTION_NAME", "ipverse-api")
    ctx = make_ctx(table=FakeTable(), s3=FakeS3(), lambda_=FakeLambda())
    for name in tools.RUNTIME3D_FILES:
        ctx.s3.put_object(Bucket=BUCKET, Key=f"runtime3d/v1/{name}", Body=name.encode())
    ctx.s3.put_object(Bucket=BUCKET, Key="runtime3d/v1/anims/ual.glb", Body=b"UAL", ContentType=GLB)
    return ctx


@pytest.fixture
def session(ctx):
    return store.put_session(ctx, "user-1", "잿빛 이후", "sf-shooter")


def _asset(ctx, sid, ip_id, kind, body, content_type=GLB):
    ext = "png" if content_type == "image/png" else "glb"
    asset = store.put_asset(ctx, sid, {"kind": kind, "key": f"sessions/{sid}/{store.new_id('ast')}.{ext}",
                                       "contentType": content_type, "ipId": ip_id})
    ctx.s3.put_object(Bucket=BUCKET, Key=asset["key"], Body=body, ContentType=content_type)
    return asset


def _ip(ctx, sid, ip_id, kind, **files):
    """An IP with its picture and cutout, plus {glbAssetId|riggedGlbAssetId: bytes}."""
    ip = {"ipId": ip_id, "kind": kind, "name": ip_id, "version": 1,
          "imageAssetId": _asset(ctx, sid, ip_id, "image", f"{ip_id}-image".encode(), "image/png")["assetId"],
          "cutoutAssetId": _asset(ctx, sid, ip_id, "cutout", f"{ip_id}-cutout".encode(), "image/png")["assetId"]}
    for field, body in files.items():
        ip[field] = _asset(ctx, sid, ip_id, {"glbAssetId": "glb", "riggedGlbAssetId": "rigged_glb"}[field], body)["assetId"]
    return store.put_ip(ctx, sid, ip)


def _survival(ctx, session):
    """A session's cast: the survivor (player), the mutant and the boss (humanoid enemies), all rigged."""
    sid = session["sessionId"]
    _ip(ctx, sid, "ip_hero", "character", glbAssetId=b"hero-mesh", riggedGlbAssetId=b"hero-rig")
    for ip_id in ("ip_mutant", "ip_boss"):
        _ip(ctx, sid, ip_id, "enemy", glbAssetId=f"{ip_id}-mesh-slab".encode(),
            riggedGlbAssetId=f"{ip_id}-rig-slab".encode())


def _game(ctx, session, *enemy_ips):
    spec = minimal_sf()
    spec["player"]["ipId"] = "ip_hero"
    spec["enemies"] = [{**spec["enemies"][0], "ipId": ip_id} for ip_id in enemy_ips]
    out = tools.run_tool(ctx, session, "make_game", {"spec": spec})
    assert "error" not in out, out
    return out["gameId"]


def _files(ctx, game_id=""):
    """{key: bytes} of every game file (or of one game)."""
    prefix = f"games/{game_id}/" if game_id else "games/"
    return {k: v for (_, k), v in ctx.s3._store.items() if k.startswith(prefix)}


def _rig_key(sid, job_id):
    return f"sessions/{sid}/{job_id}-rigged.glb"


class _Rigs(FakeProvider):
    """Each rig job collects its own rigged GLB (the test put its bytes at _rig_key)."""

    def collect(self, job, ctx):
        key = _rig_key(job["pk"].split("#")[1], job["jobId"])
        return [{"kind": "rigged_glb", "key": key, "contentType": GLB, "meta": {}},
                {"kind": "rig_preview", "key": key + ".mp4", "contentType": "video/mp4", "meta": {}}]


@pytest.fixture
def rigs(monkeypatch):
    monkeypatch.setitem(jobs.PROVIDERS, "rig", _Rigs("rig", states=[("done", "")]))


def _rig_job(ctx, sid, ip_id, body):
    job = jobs.create_job(ctx, sid, "rig", "rig", {"ipId": ip_id, "glbKey": f"sessions/{sid}/mesh.glb"}, [])
    ctx.s3.put_object(Bucket=BUCKET, Key=_rig_key(sid, job["jobId"]), Body=body, ContentType=GLB)
    return job


def _status(ctx, sid, job_id):
    return next(j for j in store.snapshot(ctx, sid)["jobs"] if j["jobId"] == job_id)["status"]


def test_a_settled_rig_reaches_the_games_that_use_the_ip_and_nothing_else(ctx, session, rigs):
    sid = session["sessionId"]
    _survival(ctx, session)
    both, boss_only = _game(ctx, session, "ip_mutant", "ip_boss"), _game(ctx, session, "ip_boss")
    before = _files(ctx)
    dst = f"games/{both}/assets/ip_mutant.rig.glb"
    assert before[dst] == b"ip_mutant-rig-slab"

    job = _rig_job(ctx, sid, "ip_mutant", b"mutant-rig-no-slab")
    jobs.advance_jobs(ctx, sid)  # the re-rig finishes

    assert _status(ctx, sid, job["jobId"]) == "done"
    after = _files(ctx)
    # only the mutant's rig in the game that has the mutant: the boss, the survivor, the boss-only game, both specs
    # and the runtime files stay as they were made; no file is added (the preview video is no game file)
    assert {k for k in after if after[k] != before.get(k)} == {dst}
    assert after[dst] == b"mutant-rig-no-slab"
    assert ctx.s3.put_kwargs[(BUCKET, dst)] == {"ContentType": GLB, "CacheControl": "no-cache"}

    copies = len(ctx.s3.copies)
    jobs.advance_jobs(ctx, sid)  # later polls copy nothing again
    assert len(ctx.s3.copies) == copies


def test_overlapping_polls_leave_the_rig_the_ip_points_at(ctx, session, rigs):
    """Two re-rigs of the mutant settle in overlapping polls and the older one's copy lands last: the game still ends
    with the rig the IP points at."""
    sid = session["sessionId"]
    _survival(ctx, session)
    game = _game(ctx, session, "ip_mutant")
    dst = f"games/{game}/assets/ip_mutant.rig.glb"
    older = _rig_job(ctx, sid, "ip_mutant", b"rig-2")
    store.update_job(ctx, sid, older["jobId"], createdAt="2026-01-01T00:00:00.000Z")  # the first poll settles it first
    _rig_job(ctx, sid, "ip_mutant", b"rig-3")
    copy_object, raced = ctx.s3.copy_object, []

    def slow_copy(**kwargs):  # the older rig's copy into the game stalls while another poll settles the newer rig
        if kwargs["Key"] == dst and not raced:
            raced.append(True)
            jobs.advance_jobs(ctx, sid)
        return copy_object(**kwargs)

    ctx.s3.copy_object = slow_copy
    jobs.advance_jobs(ctx, sid)

    assert raced and all(j["status"] == "done" for j in store.snapshot(ctx, sid)["jobs"])
    mutant = store.get_ip(ctx, sid, "ip_mutant")
    rig = next(a for a in store.snapshot(ctx, sid)["assets"] if a["assetId"] == mutant["riggedGlbAssetId"])
    assert ctx.s3._store[(BUCKET, rig["key"])] == b"rig-3"
    assert ctx.s3._store[(BUCKET, dst)] == b"rig-3"


def test_a_failed_copy_never_fails_the_finished_job(ctx, session, rigs):
    sid = session["sessionId"]
    _survival(ctx, session)
    game = _game(ctx, session, "ip_mutant")
    copy_object = ctx.s3.copy_object

    def throttled(**kwargs):
        raise RuntimeError("SlowDown")

    ctx.s3.copy_object = throttled
    job = _rig_job(ctx, sid, "ip_mutant", b"mutant-rig-no-slab")
    jobs.advance_jobs(ctx, sid)

    assert _status(ctx, sid, job["jobId"]) == "done"  # the rig is the IP's; only the game copy is behind
    assert ctx.s3._store[(BUCKET, f"games/{game}/assets/ip_mutant.rig.glb")] == b"ip_mutant-rig-slab"
    ctx.s3.copy_object = copy_object
    out = tools.run_tool(ctx, session, "refresh_game_assets", {"gameId": game})  # '이 게임에 새 3D 반영해줘'
    assert out["updated"] == [{"ipId": "ip_mutant", "name": "ip_mutant", "file": "assets/ip_mutant.rig.glb"}], out
    assert ctx.s3._store[(BUCKET, f"games/{game}/assets/ip_mutant.rig.glb")] == b"mutant-rig-no-slab"


def test_a_new_picture_version_reaches_the_games_sprite(ctx, session, monkeypatch):
    sid = session["sessionId"]
    _survival(ctx, session)
    game = _game(ctx, session, "ip_boss")
    image, cutout = f"sessions/{sid}/v2.png", f"sessions/{sid}/v2-cutout.png"
    ctx.s3.put_object(Bucket=BUCKET, Key=image, Body=b"hero-image-v2", ContentType="image/png")
    ctx.s3.put_object(Bucket=BUCKET, Key=cutout, Body=b"hero-cutout-v2", ContentType="image/png")
    monkeypatch.setitem(jobs.PROVIDERS, "mediagen_image", FakeProvider("mediagen_image", states=[("done", "")], assets=[
        {"kind": "image", "key": image, "contentType": "image/png", "meta": {"version": 2}},
        {"kind": "cutout", "key": cutout, "contentType": "image/png", "meta": {}}]))
    jobs.create_job(ctx, sid, "image", "mediagen_image", {"ipId": "ip_hero", "model": "klein9", "version": 2}, [])

    jobs.advance_jobs(ctx, sid)

    assert ctx.s3._store[(BUCKET, f"games/{game}/assets/ip_hero.png")] == b"hero-cutout-v2"


def test_refresh_game_assets_updates_one_game_and_names_what_needs_a_new_game(ctx, session):
    """'이 게임에 새 3D 반영해줘' copies the IPs' newer rigs into a game made before them. A set piece whose 3D finished
    after the game was made stays its cutout panel: switching it to the model changes the spec, so the answer says a
    re-made game is needed."""
    sid = session["sessionId"]
    _ip(ctx, sid, "ip_hero", "character", glbAssetId=b"hero-mesh", riggedGlbAssetId=b"hero-rig-slab")
    _ip(ctx, sid, "ip_core", "prop")
    _ip(ctx, sid, "ip_mentor", "character")
    _ip(ctx, sid, "ip_wire", "prop")  # 철조망 바리케이드, its 3D still running
    spec = authored_spec()
    spec["player"]["ipId"] = "ip_hero"
    spec["props"][1]["ipId"] = "ip_mentor"
    spec["world"]["entities"].append({"id": "wire_a", "kind": "model", "ipId": "ip_wire", "x": -6, "z": -14,
                                      "width": 4, "depth": .8, "height": 1.4, "label": "철조망 바리케이드"})
    made = tools.run_tool(ctx, session, "make_game",
                          {"spec": spec, "cast_ip_ids": ["ip_hero", "ip_core", "ip_mentor", "ip_wire"]})
    game = made["gameId"]
    made_files = _files(ctx, game)
    # after the game was made: the survivor is re-rigged and the barricade's 3D lands (the IPs move, the game not)
    store.update_ip(ctx, sid, "ip_hero", riggedGlbAssetId=_asset(ctx, sid, "ip_hero", "rigged_glb", b"hero-rig")["assetId"])
    store.update_ip(ctx, sid, "ip_wire", glbAssetId=_asset(ctx, sid, "ip_wire", "glb", b"wire-mesh")["assetId"])
    ctx.s3.put_object(Bucket=BUCKET, Key="runtime3d/v1/anims/ual.glb", Body=b"UAL-2", ContentType=GLB)  # newer runtime

    out = tools.run_tool(ctx, session, "refresh_game_assets", {"gameId": game})

    files = _files(ctx, game)
    assert {k for k in files if files[k] != made_files.get(k)} == {f"games/{game}/assets/ip_hero.rig.glb"}
    assert files[f"games/{game}/assets/ip_hero.rig.glb"] == b"hero-rig"
    assert files[f"games/{game}/assets/ip_wire.png"] == b"ip_wire-cutout"  # still the panel, spec and runtime as made
    assert (out["gameId"], out["updated"], out["needsRemake"]) == (
        game, [{"ipId": "ip_hero", "name": "ip_hero", "file": "assets/ip_hero.rig.glb"}],
        [{"ipId": "ip_wire", "name": "ip_wire"}])
    assert "ip_hero" in out["message"] and "다시 만들어야" in out["message"]
    assert tools.summarize("refresh_game_assets", {"gameId": game}, out) == f"게임 파일 새로 고침: {game}"

    again = tools.run_tool(ctx, session, "refresh_game_assets", {"gameId": game})
    assert again["updated"] == [] and again["needsRemake"] == out["needsRemake"] and "최신" in again["message"]
    assert tools.run_tool(ctx, session, "refresh_game_assets", {"gameId": "gm_nope"})["error"] == "not_found"
    assert tools.run_tool(ctx, session, "refresh_game_assets", {"gameId": {"id": 1}})["error"] == "not_found"


def _made_before_round_11(ctx, game, *ip_ids):
    """The game folder of a game made without the raw mesh next to a rig."""
    for ip_id in ip_ids:
        del ctx.s3._store[(BUCKET, f"games/{game}/assets/{ip_id}.glb")]


def test_a_new_rig_reaches_an_older_game_together_with_its_raw_mesh(ctx, session, rigs):
    """The runtime drops a rig with uneven legs for the raw mesh (game3d/world.js brokenRig), so a rig that lands in
    a folder without that mesh brings the mesh with it."""
    sid = session["sessionId"]
    _survival(ctx, session)
    old, new = _game(ctx, session, "ip_boss"), _game(ctx, session, "ip_boss")
    rig, raw = f"games/{old}/assets/ip_boss.rig.glb", f"games/{old}/assets/ip_boss.glb"
    assert ctx.s3._store[(BUCKET, raw)] == b"ip_boss-mesh-slab"  # make_game today: the mesh next to the rig
    _made_before_round_11(ctx, old, "ip_boss", "ip_hero")
    copies = len(ctx.s3.copies)

    job = _rig_job(ctx, sid, "ip_boss", b"boss-rig-again")
    jobs.advance_jobs(ctx, sid)  # the boss is rigged again

    assert _status(ctx, sid, job["jobId"]) == "done"
    assert ctx.s3._store[(BUCKET, rig)] == b"boss-rig-again"
    assert ctx.s3._store[(BUCKET, raw)] == b"ip_boss-mesh-slab"
    assert ctx.s3.put_kwargs[(BUCKET, raw)] == {"ContentType": GLB, "CacheControl": "no-cache"}
    # only that: the newer game already holds the mesh (the same bytes are not copied again), and the hero's mesh was
    # not asked for (its rig did not change)
    assert sorted(c["Key"] for c in ctx.s3.copies[copies:]) == sorted([rig, raw, f"games/{new}/assets/ip_boss.rig.glb"])


def test_refresh_game_assets_brings_back_the_raw_meshes_an_older_game_lacks(ctx, session):
    """The repair of such a game when no new rig comes: one refresh copies every raw mesh the folder lacks, and
    nothing else."""
    _survival(ctx, session)
    game = _game(ctx, session, "ip_mutant", "ip_boss")
    made = _files(ctx, game)
    _made_before_round_11(ctx, game, "ip_hero", "ip_mutant", "ip_boss")

    out = tools.run_tool(ctx, session, "refresh_game_assets", {"gameId": game})

    assert out["updated"] == [{"ipId": ip_id, "name": ip_id, "file": f"assets/{ip_id}.glb"}
                              for ip_id in ("ip_hero", "ip_mutant", "ip_boss")], out
    assert _files(ctx, game) == made
    assert tools.run_tool(ctx, session, "refresh_game_assets", {"gameId": game})["updated"] == []


def test_the_agent_can_call_refresh_game_assets():
    spec = next(s for s in tools.TOOL_SPECS if s["name"] == "refresh_game_assets")
    assert spec["inputSchema"]["json"]["required"] == ["gameId"] and "새 3D" in spec["description"]
    assert "refresh_game_assets" in tools.TOOLS and "refresh_game_assets" not in tools.UI_ONLY_TOOLS
