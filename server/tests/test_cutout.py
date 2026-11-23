"""Cutout cleanup (faint alpha makes Hunyuan3D slabs) and the composition check (two figures, a figure cut at the
thighs). Synthetic RGBA PNGs from an encoder written here, independent of the one under test."""
import struct
import zlib

from server.providers import cutout

W, H = 240, 160


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else b if pb <= pc else c


def encode(width, height, rows, filters=(0,)):
    """RGBA rows → PNG; row y uses filters[y % len(filters)] (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth)."""
    out, prev = [], bytes(width * 4)
    for y, row in enumerate(rows):
        f = filters[y % len(filters)]
        if f in (0, 2):  # the common rows, done bytewise in one go
            line = bytes(row) if f == 0 else bytes((v - u) & 255 for v, u in zip(row, prev))
        else:
            line = bytearray(len(row))
            for i, v in enumerate(row):
                left, up, corner = (row[i - 4] if i >= 4 else 0), prev[i], (prev[i - 4] if i >= 4 else 0)
                pred = left if f == 1 else (left + up) >> 1 if f == 3 else _paeth(left, up, corner)
                line[i] = (v - pred) & 255
        out.append(bytes([f]) + bytes(line))
        prev = row

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(out))) + chunk(b"IEND", b""))


def canvas(boxes, width=W, height=H):
    """Transparent canvas with colored pixels everywhere (like Stability's output: the old background stays in RGB),
    alpha painted by boxes (x0, y0, x1, y1, alpha)."""
    rows = [bytearray(b for x in range(width) for b in ((x * 7 + y) & 255, (x + y * 3) & 255, (x ^ y) & 255, 0))
            for y in range(height)]
    for x0, y0, x1, y1, a in boxes:
        for y in range(y0, y1):
            for x in range(x0, x1):
                rows[y][x * 4 + 3] = a
    return rows


def png_rgba(boxes, width=W, height=H, filters=(2,)):
    return encode(width, height, canvas(boxes, width, height), filters)


def figure(dx=0, legs_to=150):
    """A full-body A-pose figure with a margin (head, torso, arms out, two legs)."""
    return [(110 + dx, 10, 130 + dx, 30, 255), (105 + dx, 30, 135 + dx, 90, 255), (85 + dx, 35, 105 + dx, 70, 255),
            (135 + dx, 35, 155 + dx, 70, 255), (108 + dx, 90, 118 + dx, legs_to, 255),
            (122 + dx, 90, 132 + dx, legs_to, 255)]


def sword(top=20):
    return [(115, top, 125, 120, 255), (100, 120, 140, 128, 255), (117, 128, 123, 150, 255)]


def alpha_box(png):
    _, _, rows = cutout._read(png)
    on = [(x, y) for y, row in enumerate(rows) for x, a in enumerate(row[3::4]) if a]
    return min(p[0] for p in on), min(p[1] for p in on), max(p[0] for p in on), max(p[1] for p in on)


def test_the_reader_undoes_every_png_row_filter():
    rows = canvas(figure())
    for i, row in enumerate(rows):  # give alpha some texture too
        row[3::4] = bytes((a + i) & 255 for a in row[3::4])
    width, height, decoded = cutout._read(encode(W, H, rows, filters=(0, 1, 2, 3, 4)))
    assert (width, height) == (W, H) and [bytes(r) for r in decoded] == [bytes(r) for r in rows]


def test_faint_haze_and_far_specks_are_removed_and_the_subject_is_kept():
    haze = [(160, 0, 240, 160, 5), (150, 60, 160, 70, 7)]  # alpha 1–7: the haze a removed background leaves
    specks = [(200, 40, 203, 43, 200), (20, 150, 22, 152, 255)]  # solid crumbs far from the sword
    dirty = png_rgba(sword() + haze + specks)
    assert alpha_box(dirty) == (20, 0, 239, 159)

    clean, check = cutout.prepare(dirty, "object")

    assert alpha_box(clean) == (100, 20, 139, 149)  # just the sword: Hunyuan3D crops to this, no slabs
    assert check == {"ok": True, "subjects": 1, "cut": [], "problem": ""}
    _, _, before = cutout._read(png_rgba(sword()))
    _, _, after = cutout._read(clean)
    for y in range(H):  # the sword's pixels are untouched; transparent pixels carry no stale background color
        for x in range(W):
            a = after[y][x * 4 + 3]
            assert a == before[y][x * 4 + 3]
            assert after[y][x * 4:x * 4 + 3] == (before[y][x * 4:x * 4 + 3] if a else bytes(3))


def test_one_full_body_figure_passes_even_with_its_feet_on_the_frame():
    for legs_to in (150, H):
        assert cutout.prepare(png_rgba(figure(legs_to=legs_to)), "figure")[1]["ok"] is True


def test_two_figures_side_by_side_are_caught():
    check = cutout.prepare(png_rgba(figure(-60) + figure(60)), "figure")[1]
    assert (check["ok"], check["subjects"], check["problem"]) == (False, 2, "피사체 2개")


def test_a_figure_cut_at_the_hips_is_caught():
    big = [(90, 20, 150, H, 255), (60, 30, 90, 100, 255), (150, 30, 180, 100, 255), (105, 0, 135, 20, 255)]
    check = cutout.prepare(png_rgba(big), "figure")[1]
    assert (check["ok"], check["cut"], check["problem"]) == (False, ["bottom"], "아래쪽이 프레임에 잘림")


def test_an_object_cut_by_the_frame_is_caught():
    check = cutout.prepare(png_rgba(sword(top=0)), "object")[1]
    assert (check["ok"], check["cut"]) == (False, ["top"])
    assert cutout.prepare(png_rgba(sword(top=0)), "figure")[1]["ok"] is True  # a figure may touch it


def test_an_empty_cutout_fails_and_unreadable_images_pass_through():
    assert cutout.prepare(png_rgba([]))[1] == {"ok": False, "subjects": 0, "cut": [], "problem": "피사체가 없음"}
    rgb = png_rgba(figure()).replace(struct.pack(">BB", 8, 6), struct.pack(">BB", 8, 2), 1)  # claims RGB
    for odd in (b"JPEG?", rgb, b"\x89PNG\r\n\x1a\nbroken"):
        assert cutout.prepare(odd) == (odd, None)
    assert cutout.clean(b"JPEG?") == b"JPEG?"
