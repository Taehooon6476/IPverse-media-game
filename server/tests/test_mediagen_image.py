"""GPU images (Krea 2 Turbo / FLUX.2 klein 9B via the storyboard MCP proxy) as jobs, on a fake box and fake transport.
LIVE=1 adds one real list_models call."""
import json
import os

import pytest

from server import jobs, store, tools
from server.providers import mcp_client, mediagen_image as mi
from server.tests.conftest import FakeS3, FakeTable, make_ctx
from server.tests.fake_gpu import BUSY_TEXT, Clock, FakeImageBox
from server.tests.test_cutout import figure, png_rgba

CUT = png_rgba(figure())  # what background removal returns: one figure with a margin


@pytest.fixture
def box(monkeypatch):
    b = FakeImageBox(Clock(), gen_sec=0, swap_sec=0).install(monkeypatch)
    monkeypatch.setattr(mi, "remove_background", lambda ctx, image: CUT)
    return b


@pytest.fixture
def ctx(box):
    return make_ctx(table=FakeTable(), s3=FakeS3())


@pytest.fixture
def session(ctx):
    s = store.put_session(ctx, "user-1", "루나", "sf-shooter")
    store.update_session(ctx, s, concept={"title": "t", "logline": "", "style": "Pixar-like 3D", "palette": []})
    return s


def _ip(ctx, session, args):
    return tools.run_tool(ctx, session, "create_ip_asset", {"kind": "character", "name": "Luna",
                                                            "description": "a cat astronaut", **args})


def _run(ctx, session, passes=3):
    for _ in range(passes):  # the studio page's polls: submit, then status + collect
        jobs.advance_jobs(ctx, session["sessionId"])


def _snap(ctx, session):
    return store.snapshot(ctx, session["sessionId"])


def _assets(ctx, session):
    return {a["assetId"]: a for a in _snap(ctx, session)["assets"]}


# ── the provider ───────────────────────────────────────────────────────────────


def test_submit_draws_a_new_seed_each_time_and_resolves_reference_keys(ctx, box):
    p = mi.MediagenImageProvider()
    job = {"jobId": "job_1", "pk": "SESSION#ses_1", "input": {"model": "klein9", "prompt": "same cat",
           "references": ["sessions/ses_1/a.png", "https://cdn.example.com/old.png"]}}
    assert p.submit(job, ctx) == "g1" and p.submit(job, ctx) == "g2"
    first, second = box.starts
    assert (first["model"], first["prompt"], first["style"]) == ("klein9", "same cat", "real")
    assert first["reference_image_urls"] == ["https://cdn.example.com/sessions/ses_1/a.png", "https://cdn.example.com/old.png"]
    assert isinstance(first["seed"], int) and first["seed"] != second["seed"]


def test_status_and_collect_store_the_image_and_a_clean_cutout_at_fixed_keys(ctx, box):
    p = mi.MediagenImageProvider()
    job = {"jobId": "job_1", "pk": "SESSION#ses_1", "input": {"ipId": "ip_1", "model": "krea", "prompt": "p",
           "references": [], "version": 1, "usage": "object", "subject": "figure"}}
    job["externalId"] = p.submit(job, ctx)
    assert p.status(job, ctx) == ("done", "")
    image, cut = p.collect(job, ctx)
    assert (image["kind"], image["key"], cut["kind"], cut["key"]) == (
        "image", mi.image_key("ses_1", "job_1"), "cutout", mi.cutout_key("ses_1", "job_1"))
    assert image["meta"]["check"] == {"ok": True, "subjects": 1, "cut": [], "problem": ""}
    assert (image["meta"]["model"], image["meta"]["version"], image["meta"]["seed"]) == ("krea", 1, box.starts[0]["seed"])
    assert cut["meta"] == {"forAssetId": image["assetId"]}
    assert ctx.s3._store[("test-assets", image["key"])] == b"\x89PNG-g1"
    assert ctx.s3._store[("test-assets", cut["key"])].startswith(b"\x89PNG\r\n\x1a\n")


def test_status_reports_running_and_the_proxy_failure_text(ctx, box, monkeypatch):
    p = mi.MediagenImageProvider()
    job = {"jobId": "job_1", "pk": "SESSION#ses_1", "externalId": "x", "input": {"model": "klein9", "prompt": "p"}}
    monkeypatch.setattr(p, "_status", lambda job, ctx: {"status": "RUNNING"})
    assert p.status(job, ctx) == ("running", "그림 그리는 중 (GPU 대기 포함)")  # no model's name
    monkeypatch.setattr(p, "_status", lambda job, ctx: {"status": "FAILED", "error": "CUDA OOM"})
    assert p.status(job, ctx) == ("failed", "이미지 생성 실패: CUDA OOM")


# ── tools register image jobs ──────────────────────────────────────────────────


def test_a_new_ip_is_registered_at_once_and_gets_its_picture_from_the_job(ctx, session, box):
    out = _ip(ctx, session, {})
    [ip] = _snap(ctx, session)["ips"]
    assert box.starts == []  # nothing waited for the GPU inside the tool call
    assert (out["ipId"], out["imageModel"], out["status"]) == (ip["ipId"], "krea", "queued")
    assert out["etaMinutes"] >= 1 and "분" in out["message"]
    assert ip["imageJobId"] == out["jobId"] and "imageAssetId" not in ip and ip["version"] == 1
    assert tools.image_state(ip, {j["jobId"]: j for j in _snap(ctx, session)["jobs"]}) == "pending"

    _run(ctx, session)

    [ip] = _snap(ctx, session)["ips"]
    assets = _assets(ctx, session)
    image, cut = assets[ip["imageAssetId"]], assets[ip["cutoutAssetId"]]
    prompt = box.starts[0]["prompt"]
    assert box.starts[0]["model"] == "krea" and "reference_image_urls" not in box.starts[0]
    assert (image["meta"]["model"], image["meta"]["prompt"], image["contentType"]) == ("krea", prompt, "image/png")
    assert prompt.startswith("Single full-body shot of ONE character, Luna: a cat astronaut. Pixar-like 3D. Exactly one")
    assert "character sheet" not in prompt and "no duplicates" in prompt and "soles of the feet" in prompt
    assert cut["meta"]["forAssetId"] == image["assetId"] and image["ipId"] == cut["ipId"] == ip["ipId"]
    assert tools.image_state(ip, {j["jobId"]: j for j in _snap(ctx, session)["jobs"]}) is None


def test_a_derived_ip_uses_klein9_with_the_reference_even_while_it_is_still_drawn(ctx, session, box):
    base = _ip(ctx, session, {"image_model": "krea"})
    twin = _ip(ctx, session, {"name": "Luna's twin", "reference_ip_id": base["ipId"]})
    twin_job = next(j for j in _snap(ctx, session)["jobs"] if j["jobId"] == twin["jobId"])
    assert twin["imageModel"] == "klein9" and twin_job["deps"] == [base["jobId"]]
    assert twin_job["input"]["references"] == [mi.image_key(session["sessionId"], base["jobId"])]

    _run(ctx, session, 4)

    start = box.starts[-1]
    assert start["model"] == "klein9" and "reference image" in start["prompt"]
    assert start["reference_image_urls"] == [f"https://cdn.example.com/{mi.image_key(session['sessionId'], base['jobId'])}"]
    assert all(i.get("imageAssetId") for i in _snap(ctx, session)["ips"])

    assert _ip(ctx, session, {"reference_ip_id": base["ipId"], "image_model": "krea"})["error"] == "bad_args"
    assert _ip(ctx, session, {"reference_ip_id": "ip_nope"})["error"] == "not_found"
    assert _ip(ctx, session, {"image_model": "sdxl"})["error"] == "bad_args"


def test_named_model_and_one_object_prop_prompt(ctx, session, box):
    made = [_ip(ctx, session, {"image_model": "klein9"})["jobId"],
            _ip(ctx, session, {"kind": "prop", "name": "Core", "description": "a glowing plasma core"})["jobId"]]
    # by id: two jobs made in the same millisecond come back from the snapshot in either order (createdAt ties)
    inputs = {j["jobId"]: j["input"] for j in _snap(ctx, session)["jobs"]}
    klein, prop = (inputs[j] for j in made)
    assert (klein["model"], klein["references"]) == ("klein9", [])
    assert prop["prompt"] == (
        "Single product render of ONE object, Core: a glowing plasma core. Pixar-like 3D. Exactly one object, the whole "
        "object from end to end and top to bottom inside the frame with empty space around it, a tall object shown "
        "small enough that its full height fits, no detail close-up beside it, centered with margin, plain neutral "
        "studio background, no text")
    assert (prop["subject"], klein["subject"]) == ("object", "figure")


def test_make_ip_variant_queues_the_next_version_of_the_same_ip(ctx, session, box):
    base = _ip(ctx, session, {})
    _run(ctx, session)
    sid = session["sessionId"]
    old = store.get_ip(ctx, sid, base["ipId"])
    old_key = _assets(ctx, session)[old["imageAssetId"]]["key"]

    out = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": base["ipId"], "prompt": "wearing a red coat"})
    assert (out["version"], out["status"]) == (2, "queued")
    assert store.get_ip(ctx, sid, base["ipId"])["imageAssetId"] == old["imageAssetId"]  # until the new one lands
    _run(ctx, session)

    new = store.get_ip(ctx, sid, base["ipId"])
    start = box.starts[-1]
    assert start["model"] == "klein9" and start["reference_image_urls"] == [f"https://cdn.example.com/{old_key}"]
    assert "wearing a red coat" in start["prompt"]
    assert new["version"] == 2 and len(_snap(ctx, session)["ips"]) == 1
    assert new["imageAssetId"] != old["imageAssetId"] and new["cutoutAssetId"] != old["cutoutAssetId"]
    image = _assets(ctx, session)[new["imageAssetId"]]
    assert (image["meta"]["model"], image["meta"]["version"], image["ipId"]) == ("klein9", 2, base["ipId"])

    assert tools.run_tool(ctx, session, "make_ip_variant", {"ipId": "ip_nope", "prompt": "x"})["error"] == "not_found"
    assert tools.run_tool(ctx, session, "make_ip_variant", {"ipId": base["ipId"]})["error"] == "bad_args"


def test_two_edits_in_a_row_chain_and_number_their_versions(ctx, session, box):
    base = _ip(ctx, session, {})
    first = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": base["ipId"], "prompt": "red coat"})
    second = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": base["ipId"], "prompt": "blue scarf"})
    by_id = {j["jobId"]: j for j in _snap(ctx, session)["jobs"]}
    assert (first["version"], second["version"]) == (2, 3)
    assert by_id[first["jobId"]]["deps"] == [base["jobId"]] and by_id[second["jobId"]]["deps"] == [first["jobId"]]
    _run(ctx, session, 8)
    assert store.get_ip(ctx, session["sessionId"], base["ipId"])["version"] == 3


def test_retrying_an_old_failed_variant_never_rolls_the_ip_back(ctx, session, box):
    """A draw that never landed takes no version number: B fails, C lands as v2 and stays current; B, retried, lands
    as v3 in the version history only."""
    sid = session["sessionId"]
    base = _ip(ctx, session, {})
    _run(ctx, session)
    b = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": base["ipId"], "prompt": "wearing a red coat"})
    store.update_job(ctx, sid, b["jobId"], status="failed", error=BUSY_TEXT)
    c = tools.run_tool(ctx, session, "make_ip_variant", {"ipId": base["ipId"], "prompt": "a blue scarf"})
    _run(ctx, session)
    landed = store.get_ip(ctx, sid, base["ipId"])
    assert landed["version"] == c["version"]

    assert jobs.retry_job(ctx, sid, b["jobId"]) == [b["jobId"]]
    _run(ctx, session)

    ip = store.get_ip(ctx, sid, base["ipId"])
    assert (ip["imageAssetId"], ip["cutoutAssetId"], ip["version"]) == (
        landed["imageAssetId"], landed["cutoutAssetId"], landed["version"])  # still C
    images = [a for a in _snap(ctx, session)["assets"] if a["kind"] == "image"]
    assert (b["version"], c["version"]) == (2, 2)  # B never landed: C takes its number
    assert sorted(a["meta"]["version"] for a in images) == [1, 2, 3]  # B is kept, as its own version
    assert next(a for a in images if a["jobId"] == b["jobId"])["meta"]["version"] == 3


def test_reroll_redraws_the_same_request_and_restore_goes_back(ctx, session, box):
    sid = session["sessionId"]
    base_id = _ip(ctx, session, {})["ipId"]
    _run(ctx, session)
    base = store.get_ip(ctx, sid, base_id)
    tools.run_tool(ctx, session, "make_ip_variant", {"ipId": base_id, "prompt": "wearing a red coat"})
    _run(ctx, session)
    v2 = store.get_ip(ctx, sid, base_id)

    out = tools.run_tool(ctx, session, "reroll_ip_image", {"ipId": base_id})
    assert tools.run_tool(ctx, session, "reroll_ip_image", {"ipId": base_id})["error"] == "image_pending"
    _run(ctx, session)
    v3 = store.get_ip(ctx, sid, base_id)
    assert out["version"] == v3["version"] == 3
    strip = lambda s: {k: v for k, v in s.items() if k != "seed"}  # noqa: E731
    assert strip(box.starts[-1]) == strip(box.starts[-2])  # same prompt, model and reference as v2, a new seed
    assert box.starts[-1]["seed"] != box.starts[-2]["seed"] and v3["imageAssetId"] != v2["imageAssetId"]

    assert tools.run_tool(ctx, session, "restore_ip_version", {"ipId": base_id, "imageAssetId": base["imageAssetId"]})["version"] == 1
    back = store.get_ip(ctx, sid, base_id)
    assert (back["imageAssetId"], back["cutoutAssetId"]) == (base["imageAssetId"], base["cutoutAssetId"])
    # the next edit after a restore still gets a fresh number, not a second v2
    assert tools.run_tool(ctx, session, "make_ip_variant", {"ipId": base_id, "prompt": "blue scarf"})["version"] == 4
    assert tools.run_tool(ctx, session, "restore_ip_version", {"ipId": base_id, "imageAssetId": "ast_nope"})["error"] == "not_found"


@pytest.mark.skipif(os.environ.get("LIVE") != "1", reason="Set LIVE=1 to call the real storyboard image MCP proxy")
def test_live_image_list_models():
    from server.providers.base import Ctx
    out = mcp_client.call_tool(Ctx.from_env(), mcp_client.IMAGE, "list_models", {})
    print(json.dumps(out, ensure_ascii=False)[:1500])
    assert {"krea", "klein9"} <= set(out["image_models"])
