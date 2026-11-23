"""Strip Hunyuan3D-2.1's flat sheet artifacts from a mesh: the floor slab under the feet and stray flat cards.

The shape model sometimes turns the studio floor, or faint alpha left in the cutout, into a flat double-sided
sheet about 2.5 voxels thick: a pair of opposite planes, each a large share of the surface, perpendicular to the
up axis or to the view axis.

Removed: (1) a floor slab: a horizontal pair starting in the bottom 5% of the height that sticks out past the feet
(see clean() for the overhang rule); its whole in-band surface goes, fused to the feet or not.
(2) a stray card: a connected component that is a thin plane facing up or the camera, next to solid geometry,
and the flat pieces stuck to the body in that card's plane, with their rims.
(3) backdrop(), run after clean() where the cutout is known: a sheet filling the front view behind the body.
Kept: real thin parts (capes, blades, shields, wings) are curved, thicker, attached, or not at the bottom; flat
bottoms (crates, a car's floor) have no plane pair or no overhang; a lone sheet stuck to the body (geometry cannot
tell it from a flat flag or wing).

clean(V, F, up, front) -> (keep: bool per face, info). numpy only: workers/img3d/worker.py runs it on the white
mesh before painting (glTF axes: up=1, front=2), workers/rig/blender_rig.py before rigging (Blender: up=2, front=1).
"""
import numpy as np

# lengths are fractions of the mesh's largest extent; Hunyuan's octree has 384 cells across it (voxel ~ 0.0026)
BIN = 0.0013          # plane histogram bin: half a voxel
THICK_MAX = 0.01      # thickest sheet: ~4 voxels (the artifacts measure 2.5)
TOL = 0.0026          # band margin around a sheet: one voxel
NEAR = 0.04           # debris left this close to a removed slab goes too
AREA_MIN = 0.03       # each plane of a sheet covers at least 3% of the surface area
BOTTOM = 0.05         # a floor slab starts in the bottom 5% of the height
OVERHANG = 0.05       # ... and sticks out past the feet by 5% of the body height on both sides of an axis,
FEET = 0.15           # (feet: the body's bottom 15%) reaching within that margin of the whole body's extent
BODY_MIN = 10         # ... under a body at least 10 slab thicknesses tall
DEBRIS_MAX = 0.02     # debris: a component with under 2% of the faces
PIECE_MIN = 0.005     # a flat piece stuck to the body in a stray card's plane: at least 0.5% of the area
COS = 0.985           # a plane's faces are within ~10 degrees of the axis


def _geometry(V, F):
    e = V[F]
    cr = np.cross(e[:, 1] - e[:, 0], e[:, 2] - e[:, 0])
    length = np.linalg.norm(cr, axis=1)
    return e.mean(1), cr / np.maximum(length, 1e-20)[:, None], length / 2


def _weld(V, F):
    """Face corners as shared-position vertex ids (UV seams split vertices, connectivity must not)."""
    span = max(float(np.ptp(V, 0).max()), 1e-12)
    q = np.round((V - V.min(0)) / (span * 1e-6)).astype(np.int64)
    _, inv = np.unique(q, axis=0, return_inverse=True)
    return inv.reshape(-1)[F]


def components(W, faces=None):
    """Connected components of the faces in `faces` (default all), joined by shared welded vertices.
    -> label per face (-1 outside `faces`); labels are not contiguous."""
    faces = np.ones(len(W), bool) if faces is None else faces
    sub = W[faces]
    lab = np.arange(int(W.max()) + 1 if len(W) else 0)
    while True:  # min-label propagation with pointer jumping
        m = lab[sub].min(1)
        new = lab.copy()
        for k in range(3):
            np.minimum.at(new, sub[:, k], m)
        new = new[new]
        if np.array_equal(new, lab):
            break
        lab = new
    out = np.full(len(W), -1)
    out[faces] = lab[sub[:, 0]]
    return out


def _planes(pos, area, bin_w, area_min):
    """Plane positions where faces of one orientation pile up: [(position, area)], biggest first, at most 3."""
    if not len(pos):
        return []
    b = np.floor(pos / bin_w).astype(np.int64)
    uniq, inv = np.unique(b, return_inverse=True)
    acc = np.bincount(inv, weights=area)
    used, out = np.zeros(len(uniq), bool), []
    for k in np.argsort(-acc):
        win = ~used & (np.abs(uniq - uniq[k]) <= 1)
        if acc[win].sum() < area_min:
            break
        used |= win
        sel = win[inv]
        out.append((float(np.average(pos[sel], weights=area[sel])), float(area[sel].sum())))
        if len(out) == 3:
            break
    return out


def sheets(V, F, axis, C=None, N=None, A=None):
    """Thin double-sided planes perpendicular to `axis`: [(lo, hi)] with the -axis face at lo, the +axis face at hi."""
    if C is None:
        C, N, A = _geometry(V, F)
    ext = float(np.ptp(V, 0).max())
    area_min = AREA_MIN * A.sum()
    up, down = N[:, axis] > COS, N[:, axis] < -COS
    tops = _planes(C[up, axis], A[up], BIN * ext, area_min)
    bottoms = _planes(C[down, axis], A[down], BIN * ext, area_min)
    return [(lo, hi) for hi, _ in tops for lo, _ in bottoms if 0 < hi - lo <= THICK_MAX * ext]


def clean(V, F, up=1, front=2):
    """-> (keep, info): keep[i] is False for faces of a floor slab or a stray flat card. See the module doc."""
    V, F = np.asarray(V, dtype=np.float64), np.asarray(F, dtype=np.int64)
    keep = np.ones(len(F), bool)
    info = {"removedFaces": 0, "slabs": [], "cards": 0}
    if len(F) < 4:
        return keep, info
    C, N, A = _geometry(V, F)
    ext = float(np.ptp(V, 0).max())
    W = _weld(V, F)
    x = V[:, up]
    tol = TOL * ext
    for lo, hi in sheets(V, F, up, C, N, A):
        if lo > x.min() + BOTTOM * np.ptp(x):
            continue
        band = keep & (x[F] >= lo - tol).all(1) & (x[F] <= hi + tol).all(1)
        above = x > hi + tol
        if not above.any() or x.max() - hi < BODY_MIN * (hi - lo):
            continue  # nothing stands on it: the object itself is flat
        plane = band & (np.abs(N[:, up]) > COS) & ((np.abs(C[:, up] - lo) < tol) | (np.abs(C[:, up] - hi) < tol))
        if not plane.any():
            continue  # already removed with an overlapping pair
        flat = [k for k in range(3) if k != up]
        body = V[above][:, flat]
        feet = V[above & (x < hi + FEET * (x.max() - hi))][:, flat]
        slab = C[plane][:, flat]
        margin = OVERHANG * (x.max() - hi)
        # how far the slab sticks out past the feet and past the whole body, per axis and side
        past_feet = np.stack([feet.min(0) - slab.min(0), slab.max(0) - feet.max(0)], 1)
        past_body = np.stack([body.min(0) - slab.min(0), slab.max(0) - body.max(0)], 1)
        # a floor sticks out past the feet and reaches about as far as the body above (an A-pose arm span is almost as
        # wide as the floor; a lamp's thin base is far narrower than its shade), or lies under the whole body and sticks
        # out past the feet on one side (a cape or robe hanging to the floor can be as wide as it on one axis)
        if not any((past_feet[i] > margin).all() and (past_body[i] > -margin).all()
                   or (past_body[i] > tol).all() and (past_feet[i] > margin).any() for i in range(2)):
            continue  # no wider than the body above it: a flat bottom, not a floor
        lab = components(W, band)
        doomed = band & np.isin(lab, np.unique(lab[plane]))
        keep &= ~doomed
        # debris: small pieces near the slab that lost their connection (soles below it, rims)
        rest = components(W, keep)
        ids, counts = np.unique(rest[keep], return_counts=True)
        main = ids[np.argmax(counts)]
        near = (x[F] >= lo - NEAR * ext).all(1) & (x[F] <= hi + NEAR * ext).all(1)
        for i, n in zip(ids, counts):
            faces = rest == i
            if i != main and n < DEBRIS_MAX * len(F) and near[faces].all():
                keep &= ~faces
        info["slabs"].append({"lo": round(lo, 5), "hi": round(hi, 5), "faces": int(doomed.sum())})
    # stray cards: whole components that are thin planes facing up or the camera, beside some other geometry
    lab = components(W, keep)
    cards, solid = [], False
    for i in np.unique(lab[keep]):
        faces = lab == i
        verts = np.unique(F[faces])
        axis = next((a for a in (up, front) if np.ptp(V[verts, a]) <= THICK_MAX * ext + 2 * tol
                     and A[faces][np.abs(N[faces, a]) > COS].sum() > 0.8 * A[faces].sum()), None)
        if axis is None:
            solid = True
        else:
            cards.append((faces, axis, V[verts, axis].min(), V[verts, axis].max()))
    if not solid:  # an object made only of flat plates (a sign, a card) keeps them
        cards = []
    for faces, axis, lo, hi in cards:
        keep &= ~faces
        info["cards"] += 1
        # the card's plane is a backdrop layer (faint cutout alpha): flat pieces of it stuck to the body go too.
        # Only that plane's own faces seed it: the body's thin rims and tips lie in the same band.
        p = V[:, axis]
        band = keep & (p[F] >= lo - tol).all(1) & (p[F] <= hi + tol).all(1)
        on = (np.abs(C[:, axis] - lo) < BIN * ext) | (np.abs(C[:, axis] - hi) < BIN * ext)
        flat = band & (np.abs(N[:, axis]) > COS) & on
        lab = components(W, flat)
        ids = [i for i in np.unique(lab[flat]) if A[lab == i].sum() >= PIECE_MIN * A.sum()]
        doomed = flat & np.isin(lab, ids)
        # with their rounded borders and rims: grow through band faces that neither touch the body (faces leaving
        # the band) nor lie over its silhouette seen along the axis, so the body's own thin rims and tips stay
        solid_faces = keep & ~band
        body = np.zeros(int(W.max()) + 1, bool)
        body[W[solid_faces].reshape(-1)] = True
        uv = [k for k in range(3) if k != axis]
        cell = TOL * ext
        shadow = {(i + di, j + dj) for i, j in map(tuple, np.floor(np.concatenate(
            [C[solid_faces][:, uv], V[np.unique(F[solid_faces])][:, uv]]) / cell).astype(np.int64))
            for di in (-1, 0, 1) for dj in (-1, 0, 1)}
        over = np.array([c in shadow for c in map(tuple, np.floor(C[:, uv] / cell).astype(np.int64))])
        free = band & ~body[W].any(1) & ~over
        while True:
            touch = np.zeros(len(body), bool)
            touch[W[doomed].reshape(-1)] = True
            grown = doomed | (free & touch[W].any(1))
            if (grown == doomed).all():
                break
            doomed = grown
        keep &= ~doomed
        info["cards"] += len(np.unique(components(W, doomed)[doomed]))
    info["removedFaces"] = int((~keep).sum())
    return keep, info


FILL_MAX = 0.9  # a cutout filling this much of its bbox is a rectangle: a plate as big as the frame may be the object
CORNER = 0.05  # a backdrop reaches into each corner of the front bbox, this share of its sides


def backdrop(V, F, keep, fill, up=1, front=2):
    """(3) a backdrop: a sheet facing the camera that fills the front view out to all four corners of the mesh's
    bbox, behind a body, while the cutout it was made from does not fill its own bbox (fill: its opaque share, e.g.
    0.73 for a kite shield; None without a cutout). The sheet goes where it lies outside the body's silhouette seen
    from the front; behind the body it stays, as do the flaps that join it to the body. A plate alone, or one a
    rectangular cutout (a sign, a door) fills, is the object.
    -> (keep, {"removedFaces", "backdrops"}) for the faces kept so far."""
    V, F = np.asarray(V, dtype=np.float64), np.asarray(F, dtype=np.int64)
    keep = np.array(keep, bool)
    info = {"removedFaces": int((~keep).sum()), "backdrops": 0}  # the faces gone, the earlier rules' included
    if fill is None or fill >= FILL_MAX or len(F) < 4 or not keep.any():
        return keep, info
    C, N, A = _geometry(V, F)
    ext = float(np.ptp(V, 0).max())
    tol = TOL * ext
    uv = [k for k in range(3) if k != front]
    kept = V[np.unique(F[keep])][:, uv]
    lo_uv, span = kept.min(0), np.maximum(np.ptp(kept, 0), 1e-12)
    W = _weld(V, F)
    p = V[:, front]
    for lo, hi in sheets(V, F[keep], front, C[keep], N[keep], A[keep]):
        band = keep & (p[F] >= lo - tol).all(1) & (p[F] <= hi + tol).all(1)
        on = (np.abs(C[:, front] - lo) < tol) | (np.abs(C[:, front] - hi) < tol)
        flat = band & (np.abs(N[:, front]) > COS) & on
        rel = (C[flat][:, uv] - lo_uv) / span
        near = [rel < CORNER, rel > 1 - CORNER]  # per side: low, high
        if not all((near[a][:, 0] & near[b][:, 1]).any() for a in (0, 1) for b in (0, 1)):
            continue  # its corners are empty: the plate has the object's own outline
        solid_faces = keep & ~band
        if not solid_faces.any():
            continue  # nothing in front of or behind it: the plate is the object
        # the body's silhouette along the view axis, one cell of slack around it (as for the stray cards' planes)
        body = np.zeros(int(W.max()) + 1, bool)
        body[W[solid_faces].reshape(-1)] = True
        cell = TOL * ext
        shadow = {(i + di, j + dj) for i, j in map(tuple, np.floor(np.concatenate(
            [C[solid_faces][:, uv], V[np.unique(F[solid_faces])][:, uv]]) / cell).astype(np.int64))
            for di in (-1, 0, 1) for dj in (-1, 0, 1)}
        over = np.array([c in shadow for c in map(tuple, np.floor(C[:, uv] / cell).astype(np.int64))])
        doomed = flat & ~over
        free = band & ~body[W].any(1) & ~over  # its rounded rims, not the flaps touching the body
        while True:
            touch = np.zeros(len(body), bool)
            touch[W[doomed].reshape(-1)] = True
            grown = doomed | (free & touch[W].any(1))
            if (grown == doomed).all():
                break
            doomed = grown
        if doomed.any():
            keep &= ~doomed
            info["backdrops"] += 1
    info["removedFaces"] = int((~keep).sum())
    return keep, info


def compact(V, F, keep):
    """The kept faces with their vertices renumbered -> (V2, F2, vertex index map old -> new, -1 if dropped)."""
    F2 = np.asarray(F)[keep]
    used = np.zeros(len(V), bool)
    used[F2.reshape(-1)] = True
    remap = np.full(len(V), -1)
    remap[used] = np.arange(int(used.sum()))
    return np.asarray(V)[used], remap[F2], remap
