"""The image track on synthetic cutouts and a fake image GPU box.

- Background removal erases a glowing part (a plasma blade, an orb). It keeps the picture's RGB under every pixel,
  alpha only on what it kept, so the cutouts here are built that way. The frame check sees what was erased, and the
  cutout gets the glow back with edges that follow the picture's pixels; what cannot be put back fails the check.
- A weapon's grip end is opposite the working end a vision model names, so its cutout stands on the grip.
- The results the UI shows carry a short notice for the user beside the agent-facing message.
"""
import math
import re

from server import prompts, store, tools
from server.providers import Ctx, bedrock_image, cutout, mediagen_image as mi
from server.tests.conftest import FakeBedrockRT, FakeS3, FakeTable, make_ctx
from server.tests.test_cutout import H, W, alpha_box, encode, png_rgba
from server.tests.test_image_jobs import _concept, _create, _ip, _job, _poll, _snap, world  # noqa: F401 (fixture)

BUCKET = "test-assets"
DARK = (18, 20, 30)  # Krea's "plain dark background": a dark cloth
HILT = [(20, 72, 90, 88, (70, 25, 70), 255), (90, 58, 100, 102, (120, 60, 140), 255)]  # wrapped grip, guard: kept
# a spear drawn head-left: the leaf-shaped head at x 5–40, the shaft to the butt at the right end
SPEAR = [(5, 70, 40, 90, 255), (40, 78, 235, 82, 255)]


def blade(to):
    """The glowing plasma blade from the guard to x = to, cyan edges round a white-hot core: erased (alpha 0)."""
    return [(100, 74, to, 86, (40, 220, 255), 0), (100, 78, to, 82, (235, 255, 255), 0)]


def removed(parts, backdrop=DARK):
    """What background removal returns, as Stability writes it (Up rows): the picture's RGB under every pixel, alpha
    only on what it kept. parts: boxes (x0, y0, x1, y1, (r, g, b), alpha) drawn over the backdrop."""
    rows = [bytearray(bytes((*backdrop, 0)) * W) for _ in range(H)]
    for x0, y0, x1, y1, rgb, alpha in parts:
        for y in range(y0, y1):
            rows[y][x0 * 4:x1 * 4] = bytes((*rgb, alpha)) * (x1 - x0)
    return encode(W, H, rows, filters=(2,))


def plain(png, subject="object"):
    """prepare() without the glow restore: the same clean-up and check, nothing put back."""
    restore, cutout._restore_glow = cutout._restore_glow, lambda *args: (0, (), 0, (), 0)
    try:
        return cutout.prepare(png, subject)
    finally:
        cutout._restore_glow = restore


def drawn_png(name):
    """A picture as the GPU box returns it: only its PNG signature matters here (the grip question sends it as png)."""
    return b"\x89PNG\r\n\x1a\n" + name.encode()


def said(text):
    """A Converse reply with this text."""
    return {"output": {"message": {"role": "assistant", "content": [{"text": text}]}}, "stopReason": "end_turn"}


def _bytes(w, key):
    return w["ctx"].s3._store[(BUCKET, key)]


def _assets(w):
    return {a["assetId"]: a for a in _snap(w)["assets"]}


# ── the check sees what background removal ate; the cutout keeps the glow ──


def test_m0_a_glowing_blade_that_background_removal_erased_still_fails_the_frame_check():
    cut = removed(HILT + blade(W))  # a hilt close-up: the blade runs off the right edge
    assert plain(cut)[1]["ok"] is True  # without the restore: a hilt with margins, a false pass

    _, check = cutout.prepare(cut, "object")

    assert (check["ok"], check["cut"], check["problem"]) == (False, ["right"], "오른쪽이 프레임에 잘림")
    assert check["glow"] == 1.35  # the blade's cells put back, as a share of the hilt's


def test_m0_a_whole_glowing_blade_is_put_back_into_the_cutout_in_its_drawn_colours():
    clean, check = cutout.prepare(removed(HILT + blade(200)), "object")

    assert (check["ok"], check["cut"], check["subjects"]) == (True, [], 1) and check["glow"] == 0.96
    assert alpha_box(clean) == (20, 58, 199, 101)  # grip to blade tip: a 3D or game weapon is not a hilt
    _, _, rows = cutout._read(clean)
    assert rows[80][150 * 4:150 * 4 + 4] == bytes((235, 255, 255, 255))  # the white core, opaque, as drawn
    assert rows[75][150 * 4:150 * 4 + 4] == bytes((40, 220, 255, 255))  # the cyan rim
    assert rows[80][50 * 4 + 3] == 255 and rows[80][210 * 4:210 * 4 + 4] == bytes(4)  # grip kept; past the tip clear


def test_m0_a_blades_dark_steel_between_its_glowing_edge_and_core_is_filled():
    steel = [(100, 74, 200, 76, (240, 245, 255), 0), (100, 76, 200, 82, (70, 85, 110), 0),
             (100, 82, 200, 86, (235, 255, 255), 0)]  # the white edge line, the steel, the white core

    clean, check = cutout.prepare(removed(HILT + steel), "object")

    _, _, rows = cutout._read(clean)
    assert check["ok"] is True and rows[79][150 * 4 + 3] == 255  # the steel is part of the blade


def test_m0_the_light_a_neon_car_casts_on_the_floor_stays_out_of_its_cutout():
    car = [(40, 50, 200, 100, (230, 120, 40), 255)]
    pool = [(30, 100, 210, 112, (255, 140, 40), 0)]  # bright orange light on the floor, no white core: a brightness
    cut = removed(car + pool)  # rule alone would glue it on, out to both side edges

    clean, check = cutout.prepare(cut, "object")

    assert (clean, check) == plain(cut) and "glow" not in check  # nothing put back


def test_m0_a_light_backdrop_a_short_rim_light_or_a_figure_leave_the_removers_cutout_alone():
    white = removed(HILT + [(100, 74, 200, 86, (250, 250, 250), 0)], backdrop=(200, 200, 205))  # too light to tell
    rim = removed(HILT + [(20, 71, 36, 72, (255, 255, 255), 0)])  # a short rim light: under RESTORE of the object
    for cut in (white, rim):
        assert cutout.prepare(cut, "object") == plain(cut)
    glowing = removed(HILT + blade(W))
    assert cutout.prepare(glowing, "figure") == plain(glowing, "figure")  # objects only
    assert cutout.clean(glowing) == plain(glowing)[0]  # and the A-pose cutout (apose.py) is a figure
    empty = cutout.prepare(removed(blade(200)), "object")[1]  # nothing kept to grow from
    assert empty == {"ok": False, "subjects": 0, "cut": [], "problem": "피사체가 없음"}


def test_m0_an_image_job_checks_its_cutout_with_the_glow_back_and_keeps_the_glowing_blade(world):
    _concept(world)
    drawn = {"g1": drawn_png("g1"), "g2": drawn_png("g2")}  # a hilt close-up, then the whole katana
    world["box"].png = lambda job: drawn[job["id"]]
    world["cutouts"].update({drawn["g1"]: removed(HILT + blade(W)), drawn["g2"]: removed(HILT + blade(200))})
    world["ctx"].bedrock_rt_quick = vision = FakeBedrockRT([said("right")])  # the blade tip: held at the left

    out = _create(world, "플라즈마 카타나 II", kind="weapon", description="cyberpunk katana, glowing cyan plasma blade")
    _poll(world)

    assert len(world["box"].starts) == 2 and "zoomed out" in world["box"].starts[1]["prompt"]  # caught, drawn again
    ip, job = _ip(world, out["ipId"]), _job(world, out["jobId"])
    image, cut = _assets(world)[ip["imageAssetId"]], _assets(world)[ip["cutoutAssetId"]]
    assert _bytes(world, image["key"]) == drawn["g2"] and job["error"] == ""
    assert image["meta"]["check"]["ok"] is True and image["meta"]["check"]["glow"] == 0.96
    x0, y0, x1, y1 = alpha_box(_bytes(world, cut["key"]))
    assert (x1 - x0, y1 - y0) == (101 - 58, 199 - 20)  # stood up, grip to tip: the blade is in the 3D input
    assert len(vision.calls) == 1  # the grip side is asked of the kept draw only


# ── the glow put back has edges that follow its pixels, not the 4-px cell grid ──


def painted(paint, backdrop=DARK):
    """What background removal returns for a picture painted pixel by pixel: paint(x, y) is (rgb, alpha) for what is
    drawn there, None for the backdrop (the picture's RGB under every pixel, alpha only on what the remover kept)."""
    rows = []
    for y in range(H):
        row = bytearray()
        for x in range(W):
            rgb, alpha = paint(x, y) or (backdrop, 0)
            row += bytes((*rgb, alpha))
        rows.append(row)
    return encode(W, H, rows, filters=(2,))


def fade(rgb, share):
    """rgb glowing over the backdrop at this share of its strength (light fading into the dark cloth)."""
    return tuple(round(d + share * (c - d)) for d, c in zip(DARK, rgb))


def hilt(x, y, parts=HILT):
    return next(((rgb, alpha) for x0, y0, x1, y1, rgb, alpha in parts if x0 <= x < x1 and y0 <= y < y1), None)


SHAFT, CRYSTAL, SPARKLE, PURPLE = (120, 70, 50), (240, 210, 250), (250, 245, 255), (150, 90, 230)
CORE, CYAN = (235, 255, 255), (30, 190, 230)


def staff(x, y):
    """A magic staff lying left: the remover kept its wooden shaft and erased the white-hot crystal
    at its head, the purple halo fading round it and a sparkle in that halo just above the shaft."""
    r = math.hypot(x - 156, y - 80)
    if 20 <= x < 135 and 74 <= y < 86:
        return SHAFT, 255
    if 128 <= x < 131 and 69 <= y < 72:
        return SPARKLE, 0
    if r <= 18:
        return CRYSTAL, 0
    return (fade(PURPLE, (34 - r) / 16), 0) if r < 34 else None


def slanted(x, y):
    """A plasma katana: the remover kept the hilt and erased the blade, a white-hot core whose lower
    edge slants across the cell rows (its last row 83 at the guard, 91 at the tip), a cyan glow fading under it."""
    if 100 <= x < 200:
        low = 84 + (x - 100) // 12
        if 76 <= y < low:
            return CORE, 0
        if low <= y < low + 6:
            return fade(CYAN, (low + 6 - y) / 6), 0
    return hilt(x, y)


def erased_alike(paint, png):
    """{drawn colour: the alphas the cleaned cutout gives its pixels}, over the pixels the remover erased."""
    _, _, rows = cutout._read(png)
    seen = {}
    for y in range(H):
        for x in range(W):
            drawn = paint(x, y)
            if drawn and not drawn[1]:
                seen.setdefault(drawn[0], set()).add(rows[y][x * 4 + 3])
    return seen


def test_r0_a_crystals_halo_fades_with_its_pixels_instead_of_coming_back_as_whole_cells():
    clean, check = cutout.prepare(painted(staff), "object")

    assert check == {"ok": True, "subjects": 1, "cut": [], "problem": "", "glow": 1.09}
    _, _, rows = cutout._read(clean)
    alpha = lambda x, y: rows[y][x * 4 + 3]  # noqa: E731
    glowing = [(x, y, math.hypot(x - 156, y - 80)) for y in range(H) for x in range(W)
               if staff(x, y) and staff(x, y)[0] not in (SHAFT, SPARKLE)]  # the crystal and its halo
    assert all(alpha(x, y) == 255 for x, y, r in glowing if r <= 18)  # the crystal is back
    assert not [(x, y) for x, y, r in glowing if r >= 20 and alpha(x, y) >= 128]  # no halo in whole cells round it
    assert [alpha(x, 70) for x in range(131, 140)] == [0] * 9  # no stub from the sparkle to the crystal
    assert all(len(alphas) == 1 for alphas in erased_alike(staff, clean).values())  # alike pixels, alike alpha


def test_r0_a_plasma_cores_lower_edge_follows_its_slant_instead_of_the_cell_rows():
    clean, check = cutout.prepare(painted(slanted), "object")

    assert check == {"ok": True, "subjects": 1, "cut": [], "problem": "", "glow": 1.05}
    _, _, rows = cutout._read(clean)
    lowest = [max(y for y in range(H) if rows[y][x * 4 + 3] >= 128) for x in range(100, 200)]
    assert lowest == [83 + (x - 100) // 12 for x in range(100, 200)]  # the core's own last row, not a cell's
    assert rows[84][100 * 4:100 * 4 + 4] == bytes((*CYAN, 122))  # the glow right under it, faded by its brightness
    assert all(len(alphas) == 1 for alphas in erased_alike(slanted, clean).values())


def test_r0_the_frame_check_still_counts_the_cells_of_a_glow_whose_halo_fades():
    def thin(x, y):  # a thin core cut by the right edge with its glow above and below
        if x >= 100 and 76 <= y < 88:
            return (CORE, 0) if 80 <= y < 84 else (fade(CYAN, (y - 75) / 4 if y < 80 else (88 - y) / 4), 0)
        return hilt(x, y)

    clean, check = cutout.prepare(painted(thin), "object")

    assert (check["cut"], check["glow"]) == (["right"], 1.01)  # the core alone is 1 of the guard's 12 cell rows
    _, _, rows = cutout._read(clean)
    assert [rows[y][200 * 4 + 3] for y in range(76, 88)] == [0, 0, 0, 122, 255, 255, 255, 255, 122, 0, 0, 0]


def test_r0_the_dark_steel_by_the_guard_stays_where_the_guard_and_the_blade_enclose_a_seam():
    tips = HILT + [(100, 66, 108, 76, (120, 60, 140), 255), (100, 84, 108, 94, (120, 60, 140), 255)]

    def seamed(x, y):  # by the guard: a dark seam the remover erased, closed by the guard's tips
        if 100 <= x < 108 and 76 <= y < 84:
            return (14, 16, 26), 0
        if 108 <= x < 200 and 72 <= y < 88:
            return ((240, 245, 255) if y < 76 else (70, 85, 110) if y < 84 else CORE), 0
        return hilt(x, y, tips)

    clean, check = cutout.prepare(painted(seamed), "object")

    assert check == {"ok": True, "subjects": 1, "cut": [], "problem": "", "glow": 0.79}
    _, _, rows = cutout._read(clean)
    assert {rows[y][x * 4 + 3] for y in range(72, 88) for x in range(108, 160)} == {255}  # not mistaken for halo


# ── the orb the remover half-saw, the glass under the steel, the sparkles left in a faded halo ──

MIST = (130, 125, 140)  # a mid-grey backdrop: level 140, so white-hot starts at 220
WOOD, CLAW, BODY, GLINT, WHITE, WARM, HAZE = (110, 70, 50), (50, 70, 120), (90, 205, 235), (150, 235, 250), \
    (235, 250, 252), (205, 245, 250), (140, 215, 240)
GLASS, SPINE = (40, 150, 160), (90, 100, 110)


def orb_staff(arcs=True):
    """A staff whose claws hold a glowing orb: the remover kept the shaft and the claws and erased the
    orb, a cyan body (not white-hot) with a white facet, a bright band inside its rim and a rim white-hot only on the
    top and bottom arcs the claws' prongs hold (arcs=False: nowhere), and the pale haze round it; it left the orb,
    which it half-saw, translucent (alpha 6) out to its rim. The claws meet on the left past a wedge of haze; the
    right is open."""
    def paint(x, y):
        r, turn = math.hypot(x - 172, y - 80), math.degrees(math.atan2(80 - y, x - 172)) % 360
        if 6 <= x < 136 and 66 <= y < 94:
            return WOOD, 255
        if (30 <= r < 38 and (30 <= turn <= 150 or 210 <= turn <= 330) or 38 <= r < 46 and 150 <= turn <= 210
                or 27 <= r < 30 and (80 <= turn <= 100 or 260 <= turn <= 280)):
            return CLAW, 255
        if r <= 26:
            if 156 <= x < 170 and 64 <= y < 74:
                return WHITE, 6
            return (BODY if r < 20 else GLINT if r < 24 else WHITE if arcs and abs(x - 172) < 12 else WARM), 6
        return (HAZE, 0) if r < 38 or r < 46 and (turn < 30 or turn > 330) else None
    return paint


def round_px(r0, r1):
    """The pixels between these distances from the orb's centre."""
    return [(x, y) for y in range(H) for x in range(W) if r0 <= math.hypot(x - 172, y - 80) < r1]


def test_n0_an_orb_the_remover_half_saw_comes_back_whole_though_only_its_rim_arcs_are_white_hot():
    cut = painted(orb_staff(), MIST)
    assert plain(cut)[1]["ok"] is True  # without the restore: a hollow ring that passes

    clean, check = cutout.prepare(cut, "object")

    assert (check["ok"], check["cut"], check["subjects"], check["glow"]) == (True, [], 1, 0.38)
    _, _, rows = cutout._read(clean)
    alpha = lambda x, y: rows[y][x * 4 + 3]  # noqa: E731
    assert {alpha(x, y) for x, y in round_px(0, 20)} == {255}  # the cyan body and the facet
    assert min(alpha(x, y) for x, y in round_px(20, 26)) >= 128  # its bright band and rim, faded by brightness at most
    wedge = [(x, y) for x, y in round_px(28, 37) if 160 <= math.degrees(math.atan2(80 - y, x - 172)) % 360 <= 200]
    assert max(alpha(x, y) for x, y in wedge) < 128  # the haze between the orb and where the claws meet
    assert max(alpha(x, y) for x, y in round_px(28, 46) if x > 172 and abs(y - 80) < 8) < 128  # past the open side


def test_n0_a_glowing_part_the_restore_cannot_put_back_fails_the_check_instead_of_passing():
    cut = painted(orb_staff(arcs=False), MIST)  # only the facet is white-hot: too little to put the orb back from
    assert plain(cut)[1] == {"ok": True, "subjects": 1, "cut": [], "problem": ""}  # without the restore: passes silently

    clean, check = cutout.prepare(cut, "object")

    assert check == {"ok": False, "subjects": 1, "cut": [], "problem": cutout.ERASED, "erased": 0.29}
    assert cutout.ERASED == "배경을 지우다 빛나는 부분까지 지워짐" and clean == plain(cut)[0]  # nothing guessed in


def test_n0_a_reroll_whose_orb_is_still_erased_leaves_the_ip_on_its_picture_and_says_why(world):
    _concept(world)
    made = _create(world, "빛나는 마법 지팡이", kind="prop", description="a magic staff with a glowing cyan orb")
    _poll(world)
    v1 = _ip(world, made["ipId"])
    hollow = painted(orb_staff(arcs=False), MIST)
    world["cutouts"].update({b"\x89PNG-g2": hollow, b"\x89PNG-g3": hollow})  # the re-roll and its one redraw

    out = tools.run_tool(world["ctx"], world["session"], "reroll_ip_image", {"ipId": made["ipId"]})
    _poll(world)

    ip, job = _ip(world, made["ipId"]), _job(world, out["jobId"])
    assert (ip["imageAssetId"], ip["version"]) == (v1["imageAssetId"], 1)  # v1 stays the IP's picture
    assert len(world["box"].starts) == 3 and job["error"].startswith(f"{mi.CHECK_FAILED}: {cutout.ERASED}")
    assert _assets(world)[ip["cutoutAssetId"]]["meta"]["forAssetId"] == v1["imageAssetId"]


def glass_blade(x, y):
    """A plasma katana's glass blade: the remover kept the steel spine along its top, the guard and a
    cap at the tip, and erased the teal glass under the spine and the white-hot core running through it 12 px down."""
    if 100 <= x < 200 and 70 <= y < 74 or 200 <= x < 206 and 68 <= y < 94:
        return SPINE, 255
    if 100 <= x < 200 and 74 <= y < 92:
        return (CORE if 86 <= y < 90 else GLASS), 0
    return hilt(x, y)


def test_r0_the_glass_under_the_steel_comes_back_to_the_steels_edge_not_to_a_cells():
    clean, check = cutout.prepare(painted(glass_blade), "object")

    assert (check["ok"], check["cut"]) == (True, [])
    _, _, rows = cutout._read(clean)
    for x in range(100, 200):  # glass and core, opaque from the steel down: no clear slit closed at y 80
        assert [rows[y][x * 4 + 3] for y in range(74, 90)] == [255] * 16, x


def test_n1_sparkles_a_faded_halo_leaves_are_dropped_and_a_glowing_gem_apart_from_the_rest_stays():
    def gem_staff(x, y):  # the staff with a white-hot gem in the halo, under the end of the shaft
        return (SPARKLE, 0) if 128 <= x < 134 and 88 <= y < 94 else staff(x, y)

    clean, check = cutout.prepare(painted(gem_staff), "object")

    assert check["ok"] is True
    _, _, rows = cutout._read(clean)
    alpha = lambda x, y: rows[y][x * 4 + 3]  # noqa: E731
    assert [alpha(x, y) for y in range(69, 72) for x in range(128, 131)] == [0] * 9  # the 9-px sparkle
    assert {alpha(x, y) for y in range(88, 94) for x in range(128, 134)} == {255}  # the 36-px gem


# ── Krea is asked for the whole weapon from far away, before the look ────────


def test_d6_a_weapon_prompt_leads_with_the_whole_weapon_from_far_and_drops_camera_words(world):
    store.update_session(world["ctx"], world["session"], concept={
        "title": "t", "logline": "", "palette": [],
        "style": "stylized cyberpunk anime illustration, neon rim light, cinematic, detailed"})
    out = _create(world, "플라즈마 카타나 II", kind="weapon", description=(
        "cyberpunk katana, ornate tsuba with neon-etched patterns, glowing cyan plasma blade, cinematic close-up"))

    prompt = _job(world, out["jobId"])["input"]["prompt"]

    opening = prompt.split(": ", 1)[0]  # what Krea reads before the look: the whole weapon, from far away
    assert "whole weapon" in opening and "far" in opening and "all of it fits" in opening
    assert "the end of the grip" in prompt and "tip of the blade" in prompt  # both ends named, with margin
    assert "lying horizontally across the wide frame" in prompt and "at the left end" in prompt
    assert not re.search(r"cinematic|close-?up", prompt, re.I)  # "cinematic" draws a hilt close-up
    assert "neon rim light" in prompt and "glowing cyan plasma blade" in prompt and "ornate tsuba" in prompt
    rule = prompts.SYSTEM
    assert "cinematic" in rule and "close-up" in rule  # the agent is told not to write camera words either


# ── the grip end is opposite the working end a vision model names, for every weapon ────


def test_m1_a_weapon_held_at_its_right_end_stands_up_on_that_end():
    spear = png_rgba(SPEAR)  # head at the left, butt at the right

    up = cutout.stand_up(spear, "right")  # a quarter turn right: the right end goes to the bottom

    width, height, rows = cutout._read(up)
    assert (width, height) == (H, W)
    assert alpha_box(up) == (H - 90, 5, H - 71, 234)  # old (x, y) is now (159 - y, x)
    alpha = lambda x, y: rows[y][x * 4 + 3]  # noqa: E731
    assert alpha(80, 230) == 255 and alpha(72, 230) == 0  # the thin butt at the bottom: the game's grip
    assert alpha(72, 20) == 255  # the wide head at the top
    assert cutout.stand_up(spear) == cutout.stand_up(spear, "left") != up  # the drawn convention stays the default


def test_m1_the_grip_side_is_opposite_the_one_word_working_end_on_the_drawn_picture():
    drawn = drawn_png("katana")
    vision = FakeBedrockRT([said("Right."), said("left"), said("left or right"), said("I can't tell")])
    ctx = make_ctx(bedrock_rt_quick=vision)

    assert [bedrock_image.grip_side(ctx, drawn) for _ in range(4)] == ["left", "right", None, None]

    call = vision.calls[0]
    assert (call["method"], call["modelId"]) == ("converse", bedrock_image.GRIP_MODEL_ID)
    assert call["inferenceConfig"] == {"maxTokens": 5}  # one word; no sampling settings (the model refuses them)
    assert call["additionalModelRequestFields"] == {"thinking": {"type": "disabled"}}  # no thinking tokens for one word
    image, question = call["messages"][0]["content"]
    assert image["image"] == {"format": "png", "source": {"bytes": drawn}}
    assert "working end" in question["text"] and "spearhead" in question["text"] and "left or right" in question["text"]
    jpeg_vision = FakeBedrockRT([said("right")])
    assert bedrock_image.grip_side(make_ctx(bedrock_rt_quick=jpeg_vision), b"\xff\xd8\xff-jpeg") == "left"
    assert jpeg_vision.calls[0]["messages"][0]["content"][0]["image"]["format"] == "jpeg"  # Stable Image Ultra's
    assert bedrock_image.grip_side(ctx, b"GIF89a") is None and len(vision.calls) == 4  # not asked at all


def test_m1_a_failing_vision_call_leaves_the_drawn_convention():
    class Down:
        def converse(self, **kwargs):
            raise RuntimeError("throttled")

    assert bedrock_image.grip_side(make_ctx(bedrock_rt_quick=Down()), drawn_png("katana")) is None
    assert bedrock_image.grip_side(make_ctx(), drawn_png("katana")) is None  # no client at all


def test_m1_the_vision_question_waits_seconds_and_never_on_the_agents_client():
    spear, quick, slow = drawn_png("spear"), FakeBedrockRT([said("left")]), FakeBedrockRT([said("left")])
    assert bedrock_image.grip_side(make_ctx(bedrock_rt_quick=quick, bedrock_rt_east=slow), spear) == "right"
    assert (len(quick.calls), len(slow.calls)) == (1, 0)
    # without the quick client it is not asked: the agent's client waits up to 600 s a try, 3 tries
    assert bedrock_image.grip_side(make_ctx(bedrock_rt_east=slow), spear) is None and slow.calls == []
    config = Ctx.from_env().bedrock_rt_quick.meta.config  # built, no call made
    assert (config.connect_timeout, config.read_timeout, config.retries["total_max_attempts"]) == (2, 5, 1)


def test_m1_a_spear_drawn_head_left_is_stood_up_on_its_butt(world):
    _concept(world)
    drawn = drawn_png("spear")
    world["box"].png = lambda job: drawn
    world["cutouts"][drawn] = png_rgba(SPEAR)
    world["ctx"].bedrock_rt_quick = FakeBedrockRT([said("left")])  # the spearhead: held at the right

    out = _create(world, "장창", kind="weapon", description="a very long war spear")
    _poll(world)

    cut = _assets(world)[_ip(world, out["ipId"])["cutoutAssetId"]]
    assert _head_up(_bytes(world, cut["key"]))


def _head_up(png):
    """The stood-up spear has its wide head at the top and the thin butt at the bottom."""
    width, height, rows = cutout._read(png)
    alpha = lambda x, y: rows[y][x * 4 + 3]  # noqa: E731
    return (width, height) == (H, W) and alpha(72, 20) == 255 and alpha(72, 230) == 0 and alpha(80, 230) == 255


def test_m1_a_stable_image_ultra_weapon_stands_on_the_end_the_vision_answer_names(monkeypatch):
    vision = FakeBedrockRT([said("left")])  # the spearhead: held at the right
    ctx = make_ctx(table=FakeTable(), s3=FakeS3(), bedrock_rt_quick=vision)
    session = store.put_session(ctx, "user-1", None, "rpg-explore")
    monkeypatch.setattr(tools, "generate_image", lambda *a, **k: b"\xff\xd8\xff-jpeg")
    monkeypatch.setattr(tools, "remove_background", lambda ctx, image: png_rgba(SPEAR))

    out = tools.run_tool(ctx, session, "create_ip_asset", {"kind": "weapon", "name": "장창", "description": "a spear",
                                                            "image_model": "stability-ultra"})

    snap = store.snapshot(ctx, session["sessionId"])
    cut = next(a for a in snap["assets"] if a["assetId"] == store.get_ip(ctx, session["sessionId"],
                                                                         out["ipId"])["cutoutAssetId"])
    assert _head_up(ctx.s3._store[(BUCKET, cut["key"])])
    assert vision.calls[0]["messages"][0]["content"][0]["image"]["format"] == "jpeg"


# ── web: the results the UI shows carry a short notice for the user ──────────


def _notice_ok(text, limit=60, sentences=1):
    """Short Korean for the user: no GameSpec keys, tool names or model ids."""
    return (isinstance(text, str) and 0 < len(text) <= limit and re.search("[가-힣]", text)
            and text.count(".") - text.count("2.5D") <= sentences
            and not re.search(r"[A-Za-z_]+\.[A-Za-z_]+|_|mode image|Hunyuan|hunyuan|relief", text))


def test_web_a_background_3d_result_has_a_short_notice_beside_the_agents_message(world):
    _concept(world)
    bg = _create(world, "비 내리는 네온 거리", kind="prop", usage="background")
    _poll(world)

    out = tools.run_tool(world["ctx"], world["session"], "render_3d", {"ipId": bg["ipId"]})

    assert "world.background" in out["message"]  # the agent's instructions
    assert out["notice"] == tools.NOTICE_BACKGROUND_3D  # one short sentence
    assert _notice_ok(out["notice"]) and "걸어 다닐 수 있는 3D 대신" in out["notice"]
    assert "두께만 준 그림 판" in out["notice"] and "3D 회전 영상" in out["notice"]


def test_web_the_image_tools_errors_lead_with_a_korean_sentence_for_the_user(world):
    """A card shows an error's first sentence when there is no notice: the agent's instructions come after it."""
    _concept(world)
    ctx, session = world["ctx"], world["session"]
    world["box"].fail_next.append("bad request: nope")  # its image job fails for good
    lost = _create(world, "마법사")
    _poll(world)
    drawing = _create(world, "기사")  # still queued for the box
    pending = tools.run_tool(ctx, session, "make_video_shot", {"ipId": drawing["ipId"], "prompt": "walks"})
    again = tools.run_tool(ctx, session, "reroll_ip_image", {"ipId": drawing["ipId"]})
    failed = tools.run_tool(ctx, session, "render_3d", {"ipId": lost["ipId"]})
    missing = tools.run_tool(ctx, session, "render_3d", {"ipId": "ip_nope"})
    for out, code in ((pending, "images_pending"), (again, "image_pending"), (failed, "image_failed"),
                      (missing, "not_found")):
        first = re.split(r"(?<=[.다])\s", out["message"], 1)[0]
        assert out["error"] == code and re.search("[가-힣]", first), out
        assert not re.search(r"create_ip_asset|이 도구|사용자에게|안내하세요|state", first), first


def test_web_a_check_failed_warning_has_a_short_notice_too(world):
    _concept(world)
    world["cutouts"].update({b"\x89PNG-g1": png_rgba([(115, 0, 125, 120, 255)]),
                             b"\x89PNG-g2": png_rgba([(115, 0, 125, 120, 255)])})  # cut by the top edge, twice
    made = _create(world, "검", kind="weapon")
    _poll(world)

    out = tools.run_tool(world["ctx"], world["session"], "render_3d", {"ipId": made["ipId"]})

    assert "다시 뽑기를 권하세요" in out["warning"] and _notice_ok(out["notice"]) and "다시 뽑" in out["notice"]
    good = _create(world, "방패", kind="prop")
    _poll(world)
    assert "notice" not in tools.run_tool(world["ctx"], world["session"], "render_3d", {"ipId": good["ipId"]})


def test_web_a_stable_image_ultra_first_picture_that_fails_its_check_has_a_short_notice(monkeypatch):
    ctx = make_ctx(table=FakeTable(), s3=FakeS3())
    session = store.put_session(ctx, "user-1", None, "rpg-explore")
    cut = {"png": png_rgba([(115, 0, 125, 120, 255)])}  # cut by the top edge
    monkeypatch.setattr(tools, "generate_image", lambda *a, **k: b"\xff\xd8\xff-jpeg")
    monkeypatch.setattr(tools, "remove_background", lambda ctx, image: cut["png"])
    args = {"kind": "prop", "name": "깃대", "description": "a flagpole", "image_model": "stability-ultra"}

    out = tools.run_tool(ctx, session, "create_ip_asset", args)

    assert "다시 뽑아 주세요" in out["message"]  # the agent's note
    assert out["notice"] == tools.NOTICE_CHECK_FAILED_FIRST and _notice_ok(out["notice"]) and "다시 뽑" in out["notice"]
    cut["png"] = png_rgba([(100, 40, 140, 120, 255)])  # a picture that passes has nothing to add
    assert "notice" not in tools.run_tool(ctx, session, "create_ip_asset", args)
