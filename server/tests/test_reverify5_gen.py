"""The image track on synthetic cutouts as the remover returns them and a fake image GPU box.

- A blade cut by the frame is caught even where only its restored edge line reaches the frame.
- An orb the remover half-saw comes back inside its rim, without the haze traced between it and the claws.
- The restored glow joins what the remover kept half-opaque without a step in opacity.
- A remove-background outage fails in Korean, keeps the drawn picture for a retry and uses no version number.
"""
import math
import re

from botocore.exceptions import ClientError

from server import jobs, tools
from server.providers import cutout, mediagen_image as mi
from server.tests.test_cutout import W
from server.tests.test_image_jobs import GOOD, _concept, _create, _ip, _job, _poll, _snap, world  # noqa: F401
from server.tests.test_reverify2_gen import CLAW, CORE, HAZE, MIST, hilt, orb_staff, painted, plain, round_px

BUCKET = "test-assets"
FAINT = cutout.FAINT
CLOTH = (120, 124, 128)  # a mid-grey cloth: level 128, white-hot from 208
STEEL = (104, 112, 122)  # the blade's steel: no brighter than the cloth, so nothing can bring it back


def off_frame_katana(to=W):
    """A plasma katana in the small frame: the remover kept the grip, a guard 100 px tall and the
    steel to x 150, and erased the rest of the steel and the white-hot edge line under it, which runs to x = to."""
    def paint(x, y):
        if 10 <= x < 60 and 70 <= y < 90:
            return (70, 25, 70), 255
        if 60 <= x < 72 and 30 <= y < 130:
            return (60, 60, 70), 255
        if 72 <= x < to and 66 <= y < 86:
            return STEEL, 255 if x < 150 else 0
        if 72 <= x < to and 86 <= y < 89:
            return CORE, 0
        return None
    return paint


def _alpha(png):
    _, _, rows = cutout._read(png)
    return lambda x, y: rows[y][x * 4 + 3]


# ── the frame cuts what the remover erased, where the restored glow runs into it ──


def test_n9_a_blade_cut_by_the_frame_is_caught_where_only_its_restored_edge_reaches_the_frame():
    cut = painted(off_frame_katana(), CLOTH)
    assert plain(cut)[1]["ok"] is True  # the remover alone: a hilt and half a blade with margins

    clean, check = cutout.prepare(cut, "object")

    assert (check["ok"], check["cut"], check["problem"]) == (False, ["right"], "오른쪽이 프레임에 잘림")
    assert check["glow"] > 0
    alpha = _alpha(clean)
    assert [alpha(W - 1, y) for y in range(84, 91)] == [0, 0, 255, 255, 255, 0, 0]  # 3 px, by a guard of 100
    assert alpha(200, 75) == 0  # the erased steel stays erased: only the light is put back


def test_n9_a_restored_edge_that_ends_inside_the_frame_still_passes():
    clean, check = cutout.prepare(painted(off_frame_katana(to=200), CLOTH), "object")

    assert (check["ok"], check["cut"]) == (True, []) and check["glow"] > 0
    assert _alpha(clean)(150, 87) == 255 and _alpha(clean)(205, 87) == 0


def test_n9_a_reroll_whose_blade_runs_off_the_frame_never_becomes_the_ips_picture(world):
    _concept(world)
    made = _create(world, "플라즈마 카타나", kind="prop", description="cyberpunk katana, glowing cyan plasma blade")
    _poll(world)
    v1 = _ip(world, made["ipId"])
    off = painted(off_frame_katana(), CLOTH)
    world["cutouts"].update({b"\x89PNG-g2": off, b"\x89PNG-g3": off})  # the re-roll and its one redraw

    out = tools.run_tool(world["ctx"], world["session"], "reroll_ip_image", {"ipId": made["ipId"]})
    _poll(world)

    ip, job = _ip(world, made["ipId"]), _job(world, out["jobId"])
    assert (ip["imageAssetId"], ip["version"]) == (v1["imageAssetId"], 1)  # v1 stays: v2 is not called clean
    assert job["error"].startswith(f"{mi.CHECK_FAILED}: 오른쪽이 프레임에 잘림") and len(world["box"].starts) == 3


# ── what the remover half-saw is put back inside the orb's rim, not in the haze round it ──


def hazy_orb_staff():
    """orb_staff's orb (alpha 6) held by claws 12 px out, whose prongs touch its white-hot arcs, with the pale haze
    between them traced too (alpha 3), while the wedge where the claws meet on the left and the open right side are
    cut cleanly (alpha 0)."""
    orb = orb_staff()

    def paint(x, y):
        r, turn = math.hypot(x - 172, y - 80), math.degrees(math.atan2(80 - y, x - 172)) % 360
        if 6 <= x < 120 and 66 <= y < 94:
            return orb(x, y)  # the shaft
        if r <= 26:
            return orb(x, y)
        held = 30 <= turn <= 150 or 210 <= turn <= 330
        if (38 <= r < 46 and held or 46 <= r < 54 and 150 <= turn <= 210
                or r < 38 and (85 <= turn <= 95 or 265 <= turn <= 275)):
            return CLAW, 255
        if r < 38 and held:
            return HAZE, 3
        return (HAZE, 0) if r < 46 or r < 54 and (turn < 30 or turn > 330) else None
    return paint


def crescents():
    """The haze between the orb's rim and the claws above and below it."""
    hazy = hazy_orb_staff()
    return [(x, y) for x, y in round_px(26, 38) if hazy(x, y) == (HAZE, 3)]


def test_n5_the_orb_comes_back_without_the_haze_the_remover_traced_between_it_and_the_claws():
    clean, check = cutout.prepare(painted(hazy_orb_staff(), MIST), "object")

    assert (check["ok"], check["cut"], check["subjects"]) == (True, [], 1) and check["glow"] > 0
    alpha = _alpha(clean)
    assert {alpha(x, y) for x, y in round_px(0, 20)} == {255}  # the cyan body and the facet, whole
    assert min(alpha(x, y) for x, y in round_px(20, 26)) >= 128  # the bright band and the rim
    haze = [alpha(x, y) for x, y in crescents()]
    assert max(haze) < 128 and sum(a >= FAINT for a in haze) < len(haze) // 4  # clear gaps: a faint fringe at most


def test_n5_the_orb_without_traced_haze_comes_back_as_before():
    clean, check = cutout.prepare(painted(orb_staff(), MIST), "object")

    assert (check["ok"], check["cut"], check["subjects"], check["glow"]) == (True, [], 1, 0.38)
    assert {_alpha(clean)(x, y) for x, y in round_px(0, 20)} == {255}


# ── the restored glow joins what the remover kept of it without a step ──


def rising(x, y):
    """A plasma katana's white-hot edge line: the remover kept it more opaque toward the
    tip, its alpha rising from 40 at the guard to 199 at x 199, so the restore's cells end where it reaches SOLID."""
    if 100 <= x < 200 and 78 <= y < 82:
        return CORE, 40 + (x - 100) * 8 // 5
    return hilt(x, y)


def straddling(x, y):
    """The core's left end: the remover erased the core and kept the white-hot line under
    it at an alpha that straddles SOLID, 120 and 136 by turns."""
    if 100 <= x < 200 and 76 <= y < 80:
        return CORE, 0
    if 100 <= x < 200 and 80 <= y < 82:
        return CORE, (120, 136)[(x + y) % 2]
    return hilt(x, y)


def test_n6_the_restored_line_runs_into_what_the_remover_kept_of_it_without_a_step():
    cut = painted(rising)

    clean, check = cutout.prepare(cut, "object")

    assert (check["ok"], check["cut"]) == (True, []) and check["glow"] > 0
    alpha = _alpha(clean)
    for y in range(78, 82):
        line = [alpha(x, y) for x in range(100, 200)]
        assert line[:50] == [255] * 50, y  # put back where the remover left it under SOLID
        assert max(abs(b - a) for a, b in zip(line, line[1:])) <= 256 // cutout.EDGE, y  # no step: a ramp
        assert all(a >= 40 + i * 8 // 5 for i, a in enumerate(line)), y  # never under what the remover kept


def test_n6_where_the_removers_alpha_straddles_128_the_line_is_not_mottled():
    clean, _ = cutout.prepare(painted(straddling), "object")

    alpha = _alpha(clean)
    line = [alpha(x, y) for y in (80, 81) for x in range(100, 200)]
    assert min(line) >= 255 - 256 // cutout.EDGE  # the half-opaque px join the glow
    assert {alpha(x, y) for y in range(76, 80) for x in range(100, 200)} == {255}  # the core


def test_n6_the_join_leaves_the_removers_cutout_alone_where_nothing_was_put_back():
    for paint in (rising, straddling):
        cut = painted(paint, (200, 200, 205))  # a light backdrop: nothing is restored
        assert cutout.prepare(cut, "object") == plain(cut)


# ── a remove-background outage says so in Korean, keeps the picture and uses no version number ──


def _outage(world, monkeypatch, down):
    """Background removal that answers ServiceUnavailableException while down["on"], else cuts GOOD.
    → the pictures it was called with."""
    calls = []

    def remove_background(ctx, image):
        calls.append(image)
        if down["on"]:
            raise ClientError({"Error": {"Code": "ServiceUnavailableException",
                                         "Message": "Bedrock is unable to process your request."}}, "InvokeModel")
        return GOOD
    monkeypatch.setattr(mi, "remove_background", remove_background)
    return calls


def _failed_reroll(world, monkeypatch):
    """A staff at v1, then a reroll whose background removal is down for good. → (ip id, the reroll's job, the
    outage switch, the remover's calls)."""
    _concept(world)
    down = {"on": False}
    calls = _outage(world, monkeypatch, down)
    made = _create(world, "빛나는 마법 지팡이", kind="prop", description="a magic staff with a glowing cyan orb")
    _poll(world)
    down["on"] = True
    out = tools.run_tool(world["ctx"], world["session"], "reroll_ip_image", {"ipId": made["ipId"]})
    _poll(world)
    return made["ipId"], _job(world, out["jobId"]), down, calls


def test_n7_an_outage_past_the_retries_fails_with_a_korean_sentence_and_keeps_the_ips_picture(world, monkeypatch):
    ip_id, job, _, calls = _failed_reroll(world, monkeypatch)

    assert job["status"] == "failed" and len(calls) == 6  # v1's call, then the re-roll's 5 tries (jobs.COLLECT_RETRIES)
    assert job["error"] == f"결과 저장을 반복 실패했습니다: {mi.REMOVER_DOWN}"
    assert not re.search(r"An error occurred|Exception|InvokeModel|unable", job["error"])
    assert _ip(world, ip_id)["version"] == 1 and len(world["box"].starts) == 2  # the same picture each try


def test_n7_a_draw_that_never_landed_uses_no_version_number(world, monkeypatch):
    ip_id, failed, down, _ = _failed_reroll(world, monkeypatch)
    down["on"] = False

    again = tools.run_tool(world["ctx"], world["session"], "reroll_ip_image", {"ipId": ip_id})
    _poll(world)

    assert again["version"] == 2 and _ip(world, ip_id)["version"] == 2  # v2, not v3: the drawer has no gap
    versions = sorted(a["meta"]["version"] for a in _snap(world)["assets"] if a["kind"] == "image")
    assert versions == [1, 2]


def test_n7_retrying_the_failed_reroll_finishes_the_picture_it_drew(world, monkeypatch):
    ip_id, failed, down, calls = _failed_reroll(world, monkeypatch)
    down["on"] = False

    assert jobs.retry_job(world["ctx"], world["sid"], failed["jobId"]) == [failed["jobId"]]
    _poll(world)

    ip, job = _ip(world, ip_id), _job(world, failed["jobId"])
    assert job["status"] == "done" and len(world["box"].starts) == 2  # no new GPU draw
    image = next(a for a in _snap(world)["assets"] if a["assetId"] == ip["imageAssetId"])
    assert world["ctx"].s3._store[(BUCKET, image["key"])] == b"\x89PNG-g2" == calls[-1]  # the picture it drew
    assert (ip["version"], image["meta"]["version"], image["jobId"]) == (2, 2, failed["jobId"])


def test_n7_a_retried_draw_whose_number_was_taken_meanwhile_lands_as_the_next_one(world, monkeypatch):
    ip_id, failed, down, _ = _failed_reroll(world, monkeypatch)
    down["on"] = False
    newer = tools.run_tool(world["ctx"], world["session"], "reroll_ip_image", {"ipId": ip_id})
    _poll(world)
    current = _ip(world, ip_id)

    assert jobs.retry_job(world["ctx"], world["sid"], failed["jobId"]) == [failed["jobId"]]
    _poll(world)

    ip = _ip(world, ip_id)
    assert (ip["imageAssetId"], ip["version"], newer["version"]) == (current["imageAssetId"], 2, 2)  # never rolled back
    images = {a["jobId"]: a["meta"]["version"] for a in _snap(world)["assets"] if a["kind"] == "image"}
    assert images[failed["jobId"]] == 3 and sorted(images.values()) == [1, 2, 3]  # kept, as its own version
    assert len(world["box"].starts) == 3  # v1, the failed re-roll's one picture, the newer re-roll
