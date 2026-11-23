"""Cleanup and composition check for Stability's background-removed PNG, stdlib only (the API Lambda has no Pillow).

Hunyuan3D crops to every pixel with alpha > 0 and turns faint haze into geometry, and Krea 2 Turbo draws two figures
side by side in its wide 1216x688 frame or cuts a figure at the thighs. prepare() cleans the cutout and measures
both on a coarse grid; the image job draws once more with a new seed when the check fails.
The remover also erases what glows. prepare() first puts an object's glow back, read from the remover's output
(which keeps the picture's RGB under every pixel): a white-hot part touching the object, its halo fading out with
the pixels' brightness, and what the remover left translucent round it. A glowing part it still cannot put back
fails the check, and so does one the restored glow runs into the frame. A pale disc of the backdrop behind the
object (a moon) stays out, and the check says what it left out (backdrop).
stand_up() turns a weapon drawn lying along that frame so its grip is at the bottom."""
from __future__ import annotations
import struct
import zlib
from collections import deque

FAINT = 16  # alpha below this is removal haze, never the subject
SOLID = 128  # what counts as the subject in the composition check
CELL = 4  # px per grid cell (304x172 cells for a 1216x688 image)
SPECK = 0.02  # a part smaller than this share of the largest part is a stray speck
SECOND = 0.25  # another part at least this share of the largest one is a second subject
CUT = {"figure": 0.45, "object": 0.15}  # frame contact / the subject's extent along that edge = cut off by the frame
EDGES = {"top": "위쪽", "bottom": "아래쪽", "left": "왼쪽", "right": "오른쪽"}
# A glow the remover erased, found in its own output (it keeps the picture's RGB under every pixel). An erased
# glowing part has a white-hot core (every channel high); coloured light cast on a floor has none.
HOT = 160  # a white-hot core: every channel at least this ...
HOT_OVER = 80  # ... and this far above the backdrop's brightness (above 250 the backdrop is too light to tell)
RESTORE = 0.05  # glow touching the object adds at least this share of it: the remover ate a glowing part
FILL = 32  # cells: a gap this short between restored cells along a row or a column is the same part (a blade's steel)
LIT_OVER = 24  # a pixel of a restored cell at least this much brighter than the backdrop is the glow's
EDGE = 16  # px a halo can fade in from the backdrop (12 leaves some of a crystal's halo opaque)
PASSES = 4  # a halo the restored cells closed into a pocket (a stub grown to a sparkle) opens up as it fades
TAIL = 6  # px of the remover's trace that can still fade as halo: it runs past a part it half-saw into the haze
PALE = 0.75  # a lit pixel whose dimmest channel is at least this share of its brightest is whitish: a glowing
# part's rim (an orb's coloured body and the haze round it are far less whitish)
ERASED = "배경을 지우다 빛나는 부분까지 지워짐"  # the check's problem: a glowing part is still missing from the cutout
# A pale disc of the backdrop behind the object (a full moon) is no glowing part of it: restored, it would join the
# cutout as a pale blob. Such a disc is deep (20+ cells) and whitish all over; real glowing parts 5 to 17 cells
# deep are under a third whitish, and parts over half whitish are at most 2 deep (edge lines). The disc can be
# larger than the object, so its size against the object does not decide, only whether the remover kept an object
# at all (_discs).
DISC = 12  # cells from its edge to its core: a 100-px square fits in it (the deepest orb or crystal is 9) ...
DISC_PALE = 0.75  # ... and this share of its pixels is lit and whitish (PALE)
_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_NO_FAINT = bytes(0 if a < FAINT else a for a in range(256))
_KEEP = bytes(0 if a == 0 else 255 for a in range(256))


def _read(png: bytes):
    """→ (width, height, RGBA rows as bytearrays), or None for anything but an 8-bit non-interlaced RGBA PNG."""
    if not png.startswith(_SIGNATURE):
        return None
    pos, idat, head = 8, [], None
    while pos + 8 <= len(png):
        size, kind = struct.unpack(">I4s", png[pos:pos + 8])
        body = png[pos + 8:pos + 8 + size]
        if kind == b"IHDR":
            head = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat.append(body)
        pos += 12 + size
    if not head or head[2:4] != (8, 6) or head[6] != 0:
        return None
    width, height, stride = head[0], head[1], head[0] * 4
    raw, rows, prev = zlib.decompress(b"".join(idat)), [], bytearray(head[0] * 4)
    low, high = int.from_bytes(b"\x7f" * stride, "big"), int.from_bytes(b"\x80" * stride, "big")
    for y in range(height):
        kind, row = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        if kind == 2:  # Up: what Stability writes for every row but the first; all bytes summed at once, no carries
            a, b = int.from_bytes(row, "big"), int.from_bytes(prev, "big")
            row = bytearray((((a & low) + (b & low)) ^ ((a ^ b) & high)).to_bytes(stride, "big"))
        elif kind in (1, 3, 4):
            for i in range(stride):
                left = row[i - 4] if i >= 4 else 0
                if kind == 1:
                    pred = left
                elif kind == 3:
                    pred = (left + prev[i]) >> 1
                else:  # Paeth
                    up, corner = prev[i], prev[i - 4] if i >= 4 else 0
                    p = left + up - corner
                    pa, pb, pc = abs(p - left), abs(p - up), abs(p - corner)
                    pred = left if pa <= pb and pa <= pc else up if pb <= pc else corner
                row[i] = (row[i] + pred) & 255
        rows.append(row)
        prev = row
    return width, height, rows


def _write(width: int, height: int, rows) -> bytes:
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    raw = b"".join(b"\x00" + bytes(row) for row in rows)  # transparent pixels are zeroed: plain rows compress well
    return (_SIGNATURE + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def _alpha(rows):
    return [row[3::4] for row in rows]


def _grid(width, height, planes, level):
    """→ (cells, grid width, grid height): a cell is set when a pixel in its CELL x CELL block is >= level in planes
    (one value per pixel and row: a cutout's alpha, or its pixels' dimmest channel)."""
    gw, gh = (width + CELL - 1) // CELL, (height + CELL - 1) // CELL
    cells = bytearray(gw * gh)
    for y, plane in enumerate(planes):
        base = (y // CELL) * gw
        for gx in range(gw):
            if not cells[base + gx] and max(plane[gx * CELL:(gx + 1) * CELL]) >= level:
                cells[base + gx] = 1
    return cells, gw, gh


def _parts(cells, gw, gh):
    """8-connected groups of set cells, largest first (lists of cell indexes)."""
    seen, parts = bytearray(len(cells)), []
    for start, on in enumerate(cells):
        if not on or seen[start]:
            continue
        seen[start], todo, part = 1, deque([start]), []
        while todo:
            i = todo.popleft()
            part.append(i)
            x, y = i % gw, i // gw
            for ny in (y - 1, y, y + 1):
                for nx in (x - 1, x, x + 1):
                    j = ny * gw + nx
                    if 0 <= nx < gw and 0 <= ny < gh and cells[j] and not seen[j]:
                        seen[j] = 1
                        todo.append(j)
        parts.append(part)
    return sorted(parts, key=len, reverse=True)


def _check(part_list, gw, gh, subject, erased=0, reach=()):
    """One subject, not cut off by the frame, missing no glowing part (erased: the share of the object one still
    erased adds, _restore_glow). An edge the glow put back reaches is cut whatever its share (reach: those edges): the
    remover erased what runs on there, and the restore puts back only its light.
    → {ok, subjects, cut, problem}, plus erased when there is one."""
    if not part_list:
        return {"ok": False, "subjects": 0, "cut": [], "problem": "피사체가 없음"}
    main = part_list[0]
    subjects = sum(1 for p in part_list if len(p) >= SECOND * len(main))
    xs, ys = [i % gw for i in main], [i // gw for i in main]
    width, height = max(xs) - min(xs) + 1, max(ys) - min(ys) + 1
    touch = {"top": ys.count(0) / width, "bottom": ys.count(gh - 1) / width,
             "left": xs.count(0) / height, "right": xs.count(gw - 1) / height}
    cut = [edge for edge, share in touch.items() if share >= CUT[subject] or edge in reach]
    problems = ([f"피사체 {subjects}개"] if subjects > 1 else []) + \
               ([f"{'·'.join(EDGES[e] for e in cut)}이 프레임에 잘림"] if cut else []) + ([ERASED] if erased else [])
    check = {"ok": not problems, "subjects": subjects, "cut": cut, "problem": ", ".join(problems)}
    return {**check, "erased": erased} if erased else check


def _around(i, gw, gh):
    """The 8 neighbours of cell i inside the grid."""
    x, y = i % gw, i // gw
    return [ny * gw + nx for ny in (y - 1, y, y + 1) if 0 <= ny < gh
            for nx in (x - 1, x, x + 1) if 0 <= nx < gw and (nx, ny) != (x, y)]


def _reach(seed, allowed, gw, gh):
    """Allowed cells 8-connected to a seed cell through other allowed cells (seed cells excluded)."""
    found = {i for i, on in enumerate(allowed) if on and not seed[i] and any(seed[j] for j in _around(i, gw, gh))}
    todo = deque(found)
    while todo:
        for j in _around(todo.popleft(), gw, gh):
            if allowed[j] and not seed[j] and j not in found:
                found.add(j)
                todo.append(j)
    return found


def _fill(found, seed, gw):
    """Cells in a gap of at most FILL cells between two found cells of the same column or row (seed cells kept out)."""
    lines = ({}, {})
    for i in found:
        lines[0].setdefault(i % gw, []).append(i // gw)  # columns: x -> ys
        lines[1].setdefault(i // gw, []).append(i % gw)  # rows: y -> xs
    gaps = set()
    for vertical, line in ((True, lines[0]), (False, lines[1])):
        for fixed, spots in line.items():
            spots.sort()
            for a, b in zip(spots, spots[1:]):
                if 1 < b - a <= FILL:
                    gaps.update((s * gw + fixed) if vertical else (fixed * gw + s) for s in range(a + 1, b))
    return {i for i in gaps if not seed[i]} - found


def _halo(width, height, rows, gw, solid, found, glow, clear, keep, lo, guard, haze):
    """The pixels of a glow put back that are its halo, light fading over the backdrop: those of glow (pixel -> its
    brightest channel, 255 when white-hot or saturated) not 255 nor in guard, within EDGE px (4-connected, through other
    such pixels) of the backdrop. The backdrop: cells neither the object's nor restored joined to the frame's edge or to
    haze (cells by what the remover half-saw: its matte cut them from it), and the clear pixels of restored cells
    (clear: pixel indexes) joined to those. A pocket the object and the glow enclose is a seam of the object, not the
    backdrop (a katana's dark steel beside its guard). A restored cell its halo leaves clear (keep: cell -> its pixels
    that stay) opens a pocket only that halo closed (a stub grown to a sparkle) for the next pass, but seeds no halo
    itself, or a dark part of the object would fade on from pass to pass.
    → (the halo's pixels, the pockets left: the enclosed free cells in parts that touch a restored cell)."""
    count, size, r = len(solid), width * height, EDGE // CELL
    gh = count // gw
    free = bytearray(0 if solid[c] or c in found else 1 for c in range(count))
    away, seed = bytearray(count), bytes(free)  # seed: free from the start

    def beside(c):  # the 4 neighbour cells
        return [n for n in (c - 1 if c % gw else -1, c + 1 if (c + 1) % gw else -1, c - gw, c + gw) if 0 <= n < count]

    def spread(start):  # the free cells 4-connected to these through other free cells join the backdrop
        todo = deque(c for c in start if free[c] and not away[c])
        for c in todo:
            away[c] = 1
        while todo:
            for n in beside(todo.popleft()):
                if free[n] and not away[n]:
                    away[n] = 1
                    todo.append(n)

    def side(k):
        x = k % width
        return [n for n in (k - 1 if x else -1, k + 1 if x < width - 1 else -1, k - width, k + width) if 0 <= n < size]

    def backdrop(k):
        c = k // width // CELL * gw + k % width // CELL
        return away[c] and seed[c]

    def clear_round(c):  # the frame's edge with free cells EDGE px all round: not a seam that runs off the frame
        x, y = c % gw, c // gw
        return all(free[j * gw + i] for j in range(max(0, y - r), min(gh, y + r + 1))
                   for i in range(max(0, x - r), min(gw, x + r + 1)))

    spread([c for c in range(count) if (c < gw or c >= count - gw or c % gw in (0, gw - 1)) and clear_round(c)])
    spread(haze)
    rim = [k for k, v in glow.items() if v < 255 and k not in guard and (  # where a halo can start: beside a pixel
        k % width and k - 1 not in glow or (k + 1) % width and k + 1 not in glow  # that is not the glow's
        or k >= width and k - width not in glow or k + width < size and k + width not in glow)]
    halo = set()
    for _ in range(PASSES):
        todo = deque(k for k in clear if any(backdrop(n) for n in side(k)))
        outside = set(todo)
        while todo:
            for n in side(todo.popleft()):
                if n in clear and n not in outside:
                    outside.add(n)
                    todo.append(n)
        front = [k for k in rim if k not in halo and any(n in outside or backdrop(n) for n in side(k))]
        fresh = set(front)
        for _ in range(EDGE - 1):
            front, ahead = [], front
            for k in ahead:
                for n in side(k):
                    if glow.get(n, 255) < 255 and n not in halo and n not in fresh and n not in guard:
                        fresh.add(n)
                        front.append(n)
        halo |= fresh
        opened = []
        for k in fresh:
            y, x = divmod(k, width)
            c = y // CELL * gw + x // CELL
            if c in keep and not rows[y][x * 4 + 3] and (glow[k] - lo) * 255 // (255 - lo) < FAINT:  # fades out
                keep[c] -= 1
                if not keep[c]:
                    free[c] = 1
                    opened.append(c)
        if not opened:
            break
        spread([c for c in opened if any(away[n] for n in beside(c))])
    pockets, seen = [], bytearray(count)
    for c in range(count):
        if seed[c] and not away[c] and not seen[c]:
            part, todo, touch = [c], deque([c]), False
            seen[c] = 1
            while todo:
                for n in beside(todo.popleft()):
                    if seed[n] and not away[n] and not seen[n]:
                        seen[n] = 1
                        part.append(n)
                        todo.append(n)
                    touch = touch or n in found
            pockets += part if touch else []
    return halo, pockets


def _traced(trace, height, gw):
    """→ cell -> whether the remover left every pixel of it translucent, at alpha 1..SOLID-1 (trace: its alpha rows,
    faint alpha included): what it makes of a glowing part it half-saw."""
    memo = {}

    def traced(c):
        if c not in memo:
            x0, y0 = (c % gw) * CELL, (c // gw) * CELL
            memo[c] = all(min(a) and max(a) < SOLID
                          for a in (trace[y][x0:x0 + CELL] for y in range(y0, min(y0 + CELL, height))))
        return memo[c]
    return traced


def _spread(start, traced, taken, gw, gh):
    """The traced cells 8-connected to the start cells through other traced cells, none taken."""
    out, todo = set(), deque(start)
    while todo:
        for j in _around(todo.popleft(), gw, gh):
            if j not in out and not taken(j) and traced(j):
                out.add(j)
                todo.append(j)
    return out


def _rim(rows, width, gw, lit, hot):
    """→ cell -> whether it holds a lit pixel that is white-hot or whitish (its dimmest channel PALE of its brightest
    or more): a glowing part's rim, like a staff orb's white ring, beyond its colored body and the haze round it."""
    memo = {}

    def rim(c):
        if c not in memo:
            x0, y0 = (c % gw) * CELL, (c // gw) * CELL
            memo[c] = any(top >= lit and (dim >= hot or dim >= PALE * top) for row in rows[y0:y0 + CELL]
                          for top, dim in ((max(row[p:p + 3]), min(row[p:p + 3]))
                                           for p in range(x0 * 4, min(x0 + CELL, width) * 4, 4)))
        return memo[c]
    return rim


def _half_seen(start, taken, traced, total, gw, gh):
    """What the remover half-saw beside the start cells: traced cells 8-connected to them through other traced cells,
    none taken, in parts at least RESTORE of the object (total: its cells; a steel edge's soft tail is a few cells).
    → those parts (sets of cells)."""
    left, parts = _spread(start, traced, taken, gw, gh), []
    while left:
        cell = left.pop()
        part = {cell} | _spread([cell], traced, lambda j: j not in left, gw, gh)
        left -= part
        if len(part) >= RESTORE * total:
            parts.append(part)
    return parts


def _glowing(part, hot_cells):
    """A part with a white-hot core: RESTORE of its cells hold a white-hot pixel (the light round a katana has none)."""
    return sum(hot_cells[i] for i in part) >= RESTORE * len(part)


def _lit(rows, width, gw, cells, lit):
    """The lit pixels of these cells (brightest channel >= lit) → (row, byte offset, whether it is whitish: PALE)."""
    for i in cells:
        x0, y0 = (i % gw) * CELL, (i // gw) * CELL
        for row in rows[y0:y0 + CELL]:
            for p in range(x0 * 4, min(x0 + CELL, width) * 4, 4):
                top = max(row[p:p + 3])
                if top >= lit:
                    yield row, p, min(row[p:p + 3]) >= PALE * top


def _behind(part, disc, solid, gw, gh):
    """Whether this part lies across the object from the disc: along a row or a column from one of its cells, or a
    cell beside it, only cells of the object lie before the disc or a cell beside it."""
    edge = disc | {j for i in disc for j in _around(i, gw, gh)}
    for i in part | {j for i in part for j in _around(i, gw, gh) if solid[j]}:
        x, y = i % gw, i // gw
        for line in (range(i - 1, i - x - 1, -1), range(i + 1, i - x + gw), range(i - gw, -1, -gw),
                     range(i + gw, gw * gh, gw)):
            for j in line:
                if not solid[j]:
                    if j in edge and j != line[0]:
                        return True
                    break
    return False


def _discs(rows, width, gw, gh, found, solid, lit, total):
    """The parts of found (8-connected) that are a pale disc of the backdrop behind the object (a moon), not a
    glowing part of it. Only when the remover kept an object (total: its cells, at least the smallest disc's): a
    part with DISC_PALE of its pixels lit and whitish and a core DISC cells or more from its edge is the disc,
    however large and wherever it meets the frame. So is a pale part that lies across the object from it (_behind):
    the object in front splits the disc into pieces. A white-hot part elsewhere is the object's. When the remover
    kept less than that (a stub under a ball of light), the pale part is the object itself and comes back.
    → their cells."""
    if total < (2 * DISC + 1) ** 2:
        return set()
    core, left, pale, disc = set(found), set(found), [], set()
    for _ in range(DISC):
        core = {i for i in core for near in [_around(i, gw, gh)] if len(near) == 8 and core.issuperset(near)}
    while left:
        start = left.pop()
        part = {start} | _spread([start], found.__contains__, lambda j: False, gw, gh)
        left -= part
        if sum(white for _, _, white in _lit(rows, width, gw, part, lit)) >= DISC_PALE * CELL * CELL * len(part):
            if core.isdisjoint(part):
                pale.append(part)
            else:
                disc |= part
    more = bool(disc)
    while more:  # a piece behind a piece: the disc seen through two gaps of the object in a row
        tied = [part for part in pale if _behind(part, disc, solid, gw, gh)]
        pale = [part for part in pale if part not in tied]
        disc, more = disc.union(*tied), bool(tied)
    return disc


def _erased(gw, solid, back, hot_cells, traced, total):
    """The share of the object (solid, total: its cells) a glowing part the remover half-saw beside it, or beside the
    glow put back (back), still adds: the largest the restore did not put back, 0 when there is none."""
    subject, count = bytearray(solid), len(solid)
    for i in back:
        subject[i] = 1
    edge = [i for i in range(count) if subject[i] and not (subject[i - 1] and subject[(i + 1) % count]  # its rim
                                                            and subject[i - gw] and subject[(i + gw) % count])]
    parts = _half_seen(edge, subject.__getitem__, traced, total, gw, count // gw)
    return round(max((len(p) for p in parts if _glowing(p, hot_cells)), default=0) / total, 2)


def _sparkles(width, height, rows, before, raised):
    """Drops what the restore put back (raised: pixel indexes) in 8-connected pieces smaller than a cell that touch
    nothing the remover kept (before: the alpha rows it left): the sparkles in a faded halo's cells. A glowing piece
    the halo left apart from the rest stays."""
    runs, row_runs = [], {}  # runs of raised pixels along the rows: [y, first x, last x]
    for k in sorted(set(raised)):
        y, x = divmod(k, width)
        if runs and runs[-1][0] == y and runs[-1][2] == x - 1:
            runs[-1][2] = x
        else:
            row_runs.setdefault(y, []).append(len(runs))
            runs.append([y, x, x])
    parent = list(range(len(runs)))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for y, here in row_runs.items():
        for i in here:
            for j in row_runs.get(y + 1, ()):
                if runs[j][1] <= runs[i][2] + 1 and runs[j][2] >= runs[i][1] - 1:
                    parent[root(j)] = root(i)
    size, held = {}, set()
    for i, (y, x0, x1) in enumerate(runs):
        r = root(i)
        size[r] = size.get(r, 0) + x1 - x0 + 1
        if any(max(before[v][max(0, x0 - 1):x1 + 2]) >= FAINT for v in range(max(0, y - 1), min(height, y + 2))):
            held.add(r)
    for i, (y, x0, x1) in enumerate(runs):
        if root(i) not in held and size[root(i)] < CELL * CELL:
            rows[y][x0 * 4 + 3:(x1 + 1) * 4:4] = bytes(x1 - x0 + 1)


def _join(width, rows, raised, lit, hot):
    """The glow put back meets what the remover kept of it without a step in alpha: a lit pixel next to one put back
    opaque, that the remover kept at least half-opaque or that is white-hot, takes that opacity less 256 // EDGE per
    px of the way (4-connected, through such pixels), where that is above its own."""
    size, step, up = len(rows) * width, 256 // EDGE, set(raised)
    front, seen = [k for k in up if rows[k // width][k % width * 4 + 3] == 255], set()
    for a in range(255 - step, 0, -step):
        ahead, front = front, []
        for k in ahead:
            x = k % width
            for n in (k - 1 if x else -1, k + 1 if x + 1 < width else -1, k - width, k + width):
                if n < 0 or n >= size or n in up or n in seen:
                    continue
                seen.add(n)
                row, p = rows[n // width], n % width * 4
                own = row[p + 3]
                if own < a and max(row[p:p + 3]) >= lit and (own >= SOLID or own >= FAINT and min(row[p:p + 3]) >= hot):
                    row[p + 3] = a
                    front.append(n)


def _restore_glow(width, height, rows, trace):
    """Puts back a glowing part the remover erased, found in the cutout itself (the remover keeps the picture's RGB
    under every pixel). Found: cells with a white-hot pixel (every channel >= HOT and HOT_OVER above the backdrop)
    8-connected to the solid object, and the gaps between them (FILL), when they add at least RESTORE of the object;
    plus what the remover half-saw beside them (_half_seen, trace: its alpha rows) that has a white-hot core and
    lies inside the part's rim (_rim; past the rim is backdrop haze), and a ring round them.
    Alpha: pixels LIT_OVER brighter than the backdrop get 255, but the halo (_halo) gets alpha by its brightest
    channel, so the glow's edge follows its pixels, not the cells; of what the remover half-saw only the outer TAIL
    px can fade, its rim never. Pockets the object and the glow enclose get their lit pixels back, as do the
    object's own pixels below SOLID beside the glow; sparkles the halo leaves apart are dropped (_sparkles), and
    what the remover kept of the glow joins it without a step (_join).
    Left out: coloured light cast on the floor (no white core) and a pale disc of the backdrop behind the object
    (_discs), which is removed before RESTORE is counted and whose half-kept pixels are cleared.
    → (the share of the object's cells put back, those cells, the share a glowing part still erased adds: _erased,
    the pixels it put back on the frame's edge lines, the share such a disc left out would have added)."""
    if not width or not height or not rows:  # an empty image: nothing to restore ("피사체가 없음" follows)
        return 0, set(), 0, (), 0
    edge = list(map(max, rows[0][0::4], rows[0][1::4], rows[0][2::4])) + \
        list(map(max, rows[-1][0::4], rows[-1][1::4], rows[-1][2::4])) + \
        [max(r[0:3]) for r in rows] + [max(r[-4:-1]) for r in rows]
    level = sorted(edge)[len(edge) // 2]  # the backdrop: the median brightest channel of the frame's edge pixels
    hot = max(HOT, level + HOT_OVER)
    if hot > 250:
        return 0, set(), 0, (), 0
    solid, gw, gh = _grid(width, height, _alpha(rows), SOLID)
    total = sum(solid)
    if not total:
        return 0, set(), 0, (), 0
    core = [bytes(map(min, r[0::4], r[1::4], r[2::4])) for r in rows]  # the dimmest channel: high only for white-hot
    hot_cells, traced = _grid(width, height, core, hot)[0], _traced(trace, height, gw)
    found = _reach(solid, hot_cells, gw, gh)
    found |= _fill(found, solid, gw)
    lit = level + LIT_OVER
    disc = _discs(rows, width, gw, gh, found, solid, lit, total)  # the backdrop's, not the object's glow
    for row, p, pale in _lit(rows, width, gw, {j for i in disc for j in [i, *_around(i, gw, gh)]}, lit):
        if pale and row[p + 3] < SOLID:  # what the remover half-kept of it goes too, up to the object's edge
            row[p + 3] = 0
    for i in disc:  # ... and it is no glowing part still erased either (_erased)
        hot_cells[i] = 0
    found -= disc
    left = round(len(disc) / total, 2)
    if len(found) < RESTORE * total:
        return 0, set(), _erased(gw, solid, (), hot_cells, traced, total), (), left
    parts = _half_seen(found, solid.__getitem__, traced, total, gw, gh)  # what the remover half-saw by the glow
    marked = set().union(*(p for p in parts if _glowing(p, hot_cells))) - found  # its glowing parts: the orb's body
    beyond = set()
    if marked:  # what lies inside their rim, with the glow it lies round
        rim = _rim(rows, width, gw, lit, hot)
        start = [i for i in found if not rim(i)] or list(found)
        inner = _spread(start, lambda j: j in marked and not rim(j), lambda j: False, gw, gh)
        inner |= _spread(inner.union(start), lambda j: j in marked and rim(j), lambda j: False, gw, gh)  # the rim
        beyond = marked - inner  # what the remover traced past the rim: haze, the backdrop's
        marked = inner | found if inner else set()
    seen = set().union(*parts)
    seen |= {j for i in seen for j in _around(i, gw, gh)}
    found |= marked
    found |= {j for i in found for j in _around(i, gw, gh) if not solid[j] and j not in beyond}  # and the colored
    marked |= {j for i in marked for j in _around(i, gw, gh) if not solid[j] and j not in beyond}  # rim outside them
    shore = {j for i in found for j in _around(i, gw, gh) if solid[j]}  # the object's cells beside the glow
    lo, glow, clear, keep, held, pale = (hot + 255) // 2, {}, set(), {}, set(), set()
    before = [bytes(r[3::4]) for r in rows]
    for i in list(found) + list(shore):  # their pixels below SOLID
        x0, y0, stay, inside = (i % gw) * CELL, (i // gw) * CELL, 0, i in marked
        for y in range(y0, min(y0 + CELL, height)):
            row, base, alphas = rows[y], y * width, trace[y]
            for x in range(x0, min(x0 + CELL, width)):
                p = x * 4
                if row[p + 3] >= SOLID:
                    continue
                top, dim = max(row[p], row[p + 1], row[p + 2]), min(row[p], row[p + 1], row[p + 2])
                if top >= lit:
                    glow[base + x] = 255 if dim >= hot else top
                    stay += 1
                    if inside and alphas[x]:  # traced by the remover
                        held.add(base + x)
                    if marked and (dim >= hot or dim >= PALE * top):  # the half-seen part's rim: the haze past it
                        pale.add(base + x)  # fades as halo, not the part
                elif row[p + 3]:
                    stay += 1
                else:
                    clear.add(base + x)
        if not solid[i]:
            keep[i] = stay
    tail = {k for k in held if not (k - 1 in held and k + 1 in held and k - width in held and k + width in held)}
    ring = tail
    for _ in range(TAIL - 1):  # what stays held is more than TAIL px inside the trace
        ring = {n for k in ring for n in (k - 1, k + 1, k - width, k + width) if n in held and n not in tail}
        tail |= ring
    back = {k // width // CELL * gw + k % width // CELL for k in glow} - shore  # the cells it puts a pixel back in
    if not back:
        return 0, set(), _erased(gw, solid, (), hot_cells, traced, total), (), left
    haze = [j for i in seen for j in _around(i, gw, gh) if not solid[j] and j not in found]
    halo, pockets = _halo(width, height, rows, gw, solid, found, glow, clear, keep, lo, held - tail | pale, haze)
    raised = []
    for k, v in glow.items():
        y, x = divmod(k, width)
        a = 255 if k not in halo else (v - lo) * 255 // (255 - lo) if v > lo else 0
        if a >= FAINT and a > rows[y][x * 4 + 3]:
            rows[y][x * 4 + 3] = a
            raised.append(k)
    for i in set(pockets) | ({j for c in pockets for j in _around(c, gw, gh) if solid[j]} - shore):
        x0, y0 = (i % gw) * CELL, (i // gw) * CELL
        for y in range(y0, min(y0 + CELL, height)):
            row, base = rows[y], y * width
            for x in range(x0, min(x0 + CELL, width)):
                p = x * 4
                if row[p + 3] < SOLID and max(row[p], row[p + 1], row[p + 2]) >= lit:
                    row[p + 3] = 255
                    raised.append(base + x)
                    if not solid[i]:
                        back.add(i)
    _sparkles(width, height, rows, before, raised)
    _join(width, rows, raised, lit, hot)
    framed = [k for k in set(raised) if k < width or k >= (height - 1) * width or k % width in (0, width - 1)]
    return round(len(back) / total, 2), back, _erased(gw, solid, back, hot_cells, traced, total), framed, left


def prepare(png: bytes, subject: str = "object"):
    """→ (clean PNG, check). Clean: faint alpha zeroed, an object's glow put back (_restore_glow), what the remover
    half-kept of a pale backdrop disc cleared (_discs), specks far from the subject dropped, transparent pixels
    zeroed. check: {ok, subjects, cut, problem}, measured with the glow back, plus glow (the share of the object's
    cells put back), backdrop (the share a pale disc left out would have added) and erased (the share a glowing part
    it could not put back adds: the check fails). The specks and the check count the cells put back whole, faded
    halo included, and an edge its pixels put back at SOLID or more reach is cut (_check).
    subject "figure" (a full-body character) tolerates feet or a head touching the frame, "object" (props, weapons,
    creatures) must keep a margin. A PNG this cannot read comes back unchanged with check None."""
    try:
        image = _read(png)
    except (zlib.error, struct.error, IndexError, ValueError):  # a broken PNG stays as it is; the check cannot judge it
        image = None
    if image is None:
        return png, None
    width, height, rows = image
    trace = [bytes(row[3::4]) for row in rows]  # the remover's own alpha, faint traces included (_restore_glow)
    for row in rows:
        row[3::4] = row[3::4].translate(_NO_FAINT)
    glow, back, erased, framed, backdrop = (_restore_glow(width, height, rows, trace) if subject == "object"
                                            else (0, (), 0, (), 0))  # before RGB is zeroed
    back = set(back)
    cells, gw, gh = _grid(width, height, _alpha(rows), 1)
    for i in back:
        cells[i] = 1
    parts = _parts(cells, gw, gh)
    for part in parts[1:]:
        if len(part) >= SPECK * len(parts[0]):
            continue
        back.difference_update(part)
        for i in part:
            x0, y0 = (i % gw) * CELL * 4, (i // gw) * CELL
            for row in rows[y0:y0 + CELL]:
                block = row[x0 + 3:x0 + CELL * 4:4]
                row[x0 + 3:x0 + CELL * 4:4] = bytes(len(block))
    for row in rows:
        keep = int.from_bytes(row[3::4].translate(_KEEP), "big")
        for channel in range(3):
            row[channel::4] = (int.from_bytes(row[channel::4], "big") & keep).to_bytes(width, "big")
    cells, gw, gh = _grid(width, height, _alpha(rows), SOLID)
    for i in back:
        cells[i] = 1
    reach = {edge for k in framed if rows[k // width][k % width * 4 + 3] >= SOLID  # still there after the specks
             for edge, on in (("top", k < width), ("bottom", k >= (height - 1) * width), ("left", not k % width),
                              ("right", k % width == width - 1)) if on}
    check = _check(_parts(cells, gw, gh), gw, gh, subject, erased, reach)
    check.update({k: v for k, v in (("glow", glow), ("backdrop", backdrop)) if v})
    return _write(width, height, rows), check


def clean(png: bytes) -> bytes:
    """prepare() without the check, for the A-pose cutout that goes to Hunyuan3D (a figure: no glow is put back)."""
    return prepare(png, "figure")[0]


def stand_up(png: bytes, grip: str = "left") -> bytes:
    """A weapon cutout drawn lying along the wide frame, turned a quarter so the end it is held by is at the bottom:
    Hunyuan3D's mesh, the game's weapon mount (game3d/anim.js prepareWeapon) and a pickup billboard take a standing
    weapon. grip: that end as drawn, "left" (what the prompt asks) or "right"; anything else counts as left. A
    subject at least as tall as it is wide, or a PNG this cannot read, comes back unchanged."""
    try:
        image = _read(png)
    except (zlib.error, struct.error, IndexError, ValueError):
        image = None
    if image is None:
        return png
    width, height, rows = image
    cells, gw, _ = _grid(width, height, _alpha(rows), SOLID)
    on = [i for i, c in enumerate(cells) if c]
    xs, ys = [i % gw for i in on], [i // gw for i in on]
    if not on or max(xs) - min(xs) <= max(ys) - min(ys):  # nothing there, or standing already
        return png
    pixels, stride, turned, right = b"".join(rows), width * 4, [], grip == "right"
    for y in range(width):  # new row y is an old column: the grip's end column goes to the bottom row
        row, x = bytearray(height * 4), y if right else width - 1 - y
        for channel in range(4):
            column = pixels[x * 4 + channel::stride]  # top to bottom
            row[channel::4] = column[::-1] if right else column
        turned.append(row)
    return _write(height, width, turned)
