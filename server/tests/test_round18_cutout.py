"""A cutout's glow restore must not put a backdrop's moon back (#40): a large pale disc the remover erased behind
the subject is the backdrop's (recorded as `backdrop` in the check), while the subject's own glowing parts still
come back.

Most pictures here are synthetic, as the remover returns them (the picture's RGB under every pixel, alpha on what
it kept), at the frame's real size, since the rule counts 4-px cells.
"""
import math
import pathlib

from server.providers import cutout
from server.tests.test_cutout import alpha_box, encode
from server.tests.test_image_jobs import _concept, _create, _ip, _poll, _snap, world  # noqa: F401 (fixture)
from server.tests.test_reverify2_gen import CORE, DARK, GLASS, plain

FW, FH = 1216, 688  # Krea's frame
MIST = (81, 109, 118)  # the moonlit forest's mist along the top of the frame
MOON, HALO = (229, 230, 207), (165, 193, 186)  # the moon's colour, and the mist it lights round it
SHELL, RIM, AMBER, WOOD = (22, 34, 30), (217, 229, 229), (200, 120, 50), (110, 70, 50)
CLEAN = {"ok": True, "subjects": 1, "cut": [], "problem": ""}
MOONLESS = {**CLEAN, "backdrop": 0.17}  # the check says what it left out as the backdrop's: 17% of the beetle
ALONE = (290, 150, 1059, 619)  # the beetle's own box: the drawer's thumbnail and the game's sprite are cropped to it
WAS_MOON = ((270, 140), (160, 140), (270, 30), (320, 190), (289, 240))  # its middle, three sides, beside the head


def box(x0, y0, x1, y1):
    return lambda y: (x0, x1) if y0 <= y < y1 else None


def disc(cx, cy, r):
    def span(y):
        if abs(y - cy) > r:
            return None
        half = int(math.sqrt(r * r - (y - cy) ** 2))
        return cx - half, cx + half + 1
    return span


def returned(shapes, backdrop=MIST):
    """What background removal returns for a full-size picture, as Stability writes it (Up rows). shapes: (span, rgb,
    alpha) drawn in this order over the backdrop, alpha being what the remover kept of it; span(y) is the shape's
    (x0, x1) on row y, or None."""
    rows = []
    for y in range(FH):
        row = bytearray(bytes((*backdrop, 0)) * FW)
        for span, rgb, alpha in shapes:
            ends = span(y)
            if ends:
                x0, x1 = max(0, ends[0]), min(FW, ends[1])
                row[x0 * 4:x1 * 4] = bytes((*rgb, alpha)) * (x1 - x0)
        rows.append(row)
    return encode(FW, FH, rows, filters=(2,))


def moon(trace=0):
    """A full moon 240 px across at the top left, with the mist it lights round it. trace: the alpha the remover
    left on the moon itself (under SOLID)."""
    return [(disc(270, 140, 132), HALO, 0), (disc(270, 140, 120), MOON, trace)]


def beetle(trace=0):
    """가시 딱정벌레 in front of that moon. The remover kept its shell, its head under the moon with the moon's light
    along its top, a thorn that stands in front of the moon and three thin legs, and half-kept a thin amber feeler
    that crosses the moon."""
    return moon(trace) + [
        (box(360, 150, 1060, 470), SHELL, 255), (box(290, 230, 360, 400), SHELL, 255),
        (box(300, 230, 360, 236), RIM, 255), (box(330, 160, 345, 230), SHELL, 255),
        (box(300, 150, 306, 230), AMBER, 90), (box(420, 470, 432, 620), SHELL, 255),
        (box(640, 470, 652, 620), SHELL, 255), (box(900, 470, 912, 620), SHELL, 255)]


def _alpha(png):
    _, _, rows = cutout._read(png)
    return lambda x, y: rows[y][x * 4 + 3]


def kept(alpha):
    """The beetle's parts by the moon and a leg: the thorn, the light on its head, the feeler (half-kept), a leg."""
    return [alpha(337, 190), alpha(330, 232), alpha(303, 190), alpha(425, 600)]


def test_40_a_full_moon_behind_a_creatures_head_stays_out_of_its_cutout():
    cut = returned(beetle())

    clean, check = cutout.prepare(cut, "object")

    assert check == MOONLESS  # backdrop, not glow
    alpha = _alpha(clean)
    assert [alpha(x, y) for x, y in WAS_MOON] == [0] * 5 and alpha_box(clean) == ALONE
    assert kept(alpha) == [255, 255, 90, 255]  # the half-kept feeler is not made opaque
    assert (clean, {**check, "backdrop": 0}) == (plain(cut)[0], {**CLEAN, "backdrop": 0})  # the remover's own cutout, cleaned


def test_40_the_moon_goes_whatever_trace_of_it_the_remover_left():
    # a trace under FAINT (alpha 1-13), and a half-opaque one
    for trace in (8, 60):
        clean, check = cutout.prepare(returned(beetle(trace)), "object")

        assert check == MOONLESS, trace  # neither put back nor counted as a glowing part still erased
        alpha = _alpha(clean)
        assert [alpha(x, y) for x, y in WAS_MOON] == [0] * 5 and alpha_box(clean) == ALONE, trace
        assert kept(alpha) == [255, 255, 90, 255], trace  # nothing of the beetle went with it


def test_40_an_enemy_drawn_in_front_of_a_moon_lands_with_a_cutout_of_itself_alone(world):  # noqa: F811
    _concept(world)
    world["cutouts"][b"\x89PNG-g1"] = returned(beetle())  # what the remover returns for the one draw

    out = _create(world, "가시 딱정벌레", kind="enemy", humanoid=False, description="giant thorny beetle")
    _poll(world)

    ip, assets = _ip(world, out["ipId"]), {a["assetId"]: a for a in _snap(world)["assets"]}
    assert assets[ip["imageAssetId"]]["meta"]["check"] == MOONLESS and len(world["box"].starts) == 1
    assert alpha_box(world["ctx"].s3._store[("test-assets", assets[ip["cutoutAssetId"]]["key"])]) == ALONE


def test_40_a_creatures_own_glowing_part_is_still_put_back_beside_the_moon():
    tail = [(box(900, 250, 1020, 330), (40, 220, 255), 0), (box(900, 260, 1020, 320), CORE, 0)]  # glowing: erased
    bug = moon() + [(box(330, 200, 900, 400), SHELL, 255)] + tail

    clean, check = cutout.prepare(returned(bug), "object")

    assert (check["ok"], check["cut"], check["subjects"], check["glow"]) == (True, [], 1, 0.07)  # the tail's cells
    alpha = _alpha(clean)
    assert alpha(960, 290) == 255 and alpha(960, 258) == 255  # its white core and its cyan rim
    assert alpha(270, 140) == 0 and alpha_box(clean) == (330, 200, 1019, 399)  # and no moon


# a broad hilt the remover kept, larger than each blade below: its grip and its guard
HILT = [(box(60, 240, 660, 460), (70, 25, 70), 255), (box(660, 160, 700, 540), (120, 60, 140), 255)]


def test_40_a_glowing_part_as_deep_as_the_moon_is_the_objects_when_its_light_is_coloured():
    # a thick blade: 148 px of cyan glass between a white-hot edge line and core, all erased, ending inside the frame
    blade = [(box(700, 280, 1100, 428), GLASS, 0), (box(700, 280, 1100, 288), (240, 245, 255), 0),
             (box(700, 400, 1100, 428), CORE, 0)]

    clean, check = cutout.prepare(returned(HILT + blade, DARK), "object")

    assert (check["ok"], check["cut"], check["subjects"]) == (True, [], 1) and check["glow"] > 0.3
    assert {_alpha(clean)(900, y) for y in (284, 350, 414)} == {255}  # edge line, glass and core
    assert alpha_box(clean) == (60, 160, 1099, 539)  # grip to tip


def test_40_two_glowing_lines_with_unlit_steel_between_them_are_no_pale_disc():
    # a broad blade on grey cloth (its steel is no brighter than the cloth, so only its light comes back): white-hot
    # lines along both edges, 120 px apart, fill into a part as deep as the moon, but only an eighth of it is lit
    cloth, steel = (120, 124, 128), (104, 112, 122)
    blade = [(box(700, 280, 1100, 416), steel, 0), (box(700, 280, 1100, 288), CORE, 0),
             (box(700, 408, 1100, 416), CORE, 0)]

    clean, check = cutout.prepare(returned(HILT + blade, cloth), "object")

    assert (check["ok"], check["cut"], check["subjects"]) == (True, [], 1) and check["glow"] > 0
    alpha = _alpha(clean)
    assert [alpha(900, 284), alpha(900, 350), alpha(900, 412)] == [255, 0, 255]  # the lines back, the steel erased


def test_40_a_part_as_deep_and_as_pale_as_the_moon_that_runs_off_the_frame_is_left_out_and_recorded():
    # a hilt whose erased blade, white-hot all through, runs off the right edge: in pixels it is a moon (deep, whitish
    # all over, smaller than the object, off the frame), so it is read as the backdrop, and the check says so
    clean, check = cutout.prepare(returned(HILT + [(box(700, 280, FW, 428), CORE, 0)], DARK), "object")

    assert "glow" not in check and check["backdrop"] > 0.3 and _alpha(clean)(900, 350) == 0
    assert (check["ok"], check["cut"]) == (True, [])  # the hilt alone, as the remover returned it


def test_40_a_large_white_orb_the_remover_erased_is_left_out_but_the_check_records_it():
    # the ambiguous case: a pale ball smaller than the object reads as the moon does. It stays out, and the check
    # carries backdrop
    staff = [(box(120, 300, 800, 400), WOOD, 255), (box(300, 200, 700, 500), WOOD, 255),
             (disc(920, 344, 120), (235, 240, 225), 0)]

    clean, check = cutout.prepare(returned(staff, DARK), "object")

    assert "glow" not in check and "erased" not in check and check["backdrop"] > 0.1
    assert alpha_box(clean) == (120, 200, 799, 499)


def test_40_a_pale_glowing_ball_larger_than_what_the_remover_kept_is_the_object_itself():
    # an orb of light on a stub, as large and as pale as the moon: the remover kept next to nothing (the stub alone,
    # smaller than a 100-px square), so no object stands in front of a backdrop here: the ball is the object
    prop = [(disc(630, 300, 120), (235, 240, 225), 0), (box(590, 400, 670, 450), WOOD, 255)]

    clean, check = cutout.prepare(returned(prop, DARK), "object")

    assert (check["ok"], check["cut"], check["subjects"]) == (True, [], 1) and check["glow"] > 4
    assert {_alpha(clean)(x, y) for x, y in ((630, 300), (540, 300), (630, 200))} == {255}  # the ball is back


def test_40_a_pale_glowing_part_no_deeper_than_a_staffs_orb_is_the_objects():
    # a white orb 110 px across at the head of a staff: 9 cells deep once filled, against the moon's 23
    staff = [(box(120, 330, 800, 358), WOOD, 255), (disc(852, 344, 55), (235, 240, 225), 0)]

    clean, check = cutout.prepare(returned(staff, DARK), "object")

    assert (check["ok"], check["cut"], check["subjects"]) == (True, [], 1) and check["glow"] > 0
    alpha = _alpha(clean)
    assert {alpha(852, 344), alpha(852, 295), alpha(900, 344)} == {255}  # the orb is back, whole


def test_40_a_pale_round_shield_the_remover_kept_is_left_as_it_returned_it():
    # as large and as pale as the moon and beside the body, but kept: the rule reads only what the remover erased, so
    # the shield stays whole with the soft edge the remover half-kept (alpha 120), on a dark and on a misty backdrop
    golem = [(box(500, 120, 900, 620), SHELL, 255), (disc(420, 380, 126), (235, 240, 225), 120),
             (disc(420, 380, 120), (235, 240, 225), 255)]
    for backdrop in (DARK, MIST):
        cut = returned(golem, backdrop)

        clean, check = cutout.prepare(cut, "object")

        assert check == CLEAN and (clean, check) == plain(cut), backdrop  # the remover's own cutout, cleaned
        alpha = _alpha(clean)
        assert [alpha(420, 380), alpha(296, 380)] == [255, 120] and alpha_box(clean) == (294, 120, 899, 619), backdrop


# The remover's real output for saved pictures (Stability remove-background, RGB kept to 5 bits), 1216x688: a moon
# larger than the synthetic one, split by the subject and running off the top of the frame.
def _real(name):
    return (pathlib.Path(__file__).parent / "fixtures" / "round18" / f"{name}-remover.png").read_bytes()


def _solid(png):
    return sum(a >= cutout.SOLID for row in cutout._read(png)[2] for a in row[3::4])


def test_40_the_huge_moon_behind_the_live_beetle_stays_out_of_its_cutout():
    cut = _real("beetle")

    clean, check = cutout.prepare(cut, "object")

    assert "glow" not in check and check["backdrop"] > 0.5
    alpha = _alpha(clean)
    # the moon's face, its top at the frame, and its pieces between the horns and right of the jaws
    assert [alpha(x, y) for x, y in ((328, 80), (200, 200), (400, 2), (744, 392), (680, 180))] == [0] * 5
    assert min(alpha(488, 344), alpha(584, 216)) >= 250  # the shell and the moonlight on it
    assert 0.97 * _solid(cut) <= _solid(clean) <= _solid(cut)  # the beetle as the remover kept it


def test_40_the_moon_behind_the_live_lantern_stays_out_and_its_flame_stays():
    cut = _real("lantern")

    clean, check = cutout.prepare(cut, "object")

    assert "glow" not in check and check["backdrop"] > 0.5
    alpha = _alpha(clean)
    # the moon right and left of the lantern, at the frame's top, and seen between its frame and its glass
    assert [alpha(x, y) for x, y in ((808, 296), (392, 32), (700, 2), (504, 272), (712, 250))] == [0] * 5
    assert min(alpha(607, 353), alpha(600, 425), alpha(568, 560)) >= 250  # the flame's core, its blue, the brass
    assert 0.97 * _solid(cut) <= _solid(clean) <= _solid(cut)


def test_40_a_moon_larger_than_the_lantern_in_front_of_it_stays_out():
    # the moon fills the frame from top to bottom: what the restore finds of it is larger than the lantern, and must
    # still not pass as the object's own body
    cut = _real("lantern-full-moon")

    clean, check = cutout.prepare(cut, "object")

    assert "glow" not in check and check["backdrop"] > 1
    alpha = _alpha(clean)
    # the moon right and left of the lantern, at the frame's top and under its base
    assert [alpha(x, y) for x, y in ((808, 368), (296, 488), (808, 8), (600, 668), (920, 300))] == [0] * 5
    assert min(alpha(607, 417), alpha(600, 584)) >= 250  # the blue flame and the brass
    assert 0.97 * _solid(cut) <= _solid(clean) <= _solid(cut)  # the lantern as the remover kept it
