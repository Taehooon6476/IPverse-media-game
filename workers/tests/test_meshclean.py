"""workers/img3d/meshclean.py on synthetic meshes in Hunyuan's +-1 output box (glTF axes: Y up, Z toward the camera)."""
import sys
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "img3d"))
import meshclean  # noqa: E402

SLAB = 0.013  # the measured thickness of Hunyuan's floor slabs and cards (2.5 voxels)


def box(lo, hi, cells=6):
    """Closed axis-aligned box surface, outward winding, each side split into cells x cells quads."""
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    Vs, Fs, n = [], [], 0
    g = np.linspace(0, 1, cells + 1)
    uu, vv = (a.ravel() for a in np.meshgrid(g, g, indexing="ij"))
    idx = np.arange((cells + 1) ** 2).reshape(cells + 1, cells + 1)
    a, b, c, d = idx[:-1, :-1].ravel(), idx[1:, :-1].ravel(), idx[1:, 1:].ravel(), idx[:-1, 1:].ravel()
    quad = np.concatenate([np.stack([a, b, c], 1), np.stack([a, c, d], 1)])  # normal u x v
    for axis in range(3):
        u, v = (axis + 1) % 3, (axis + 2) % 3
        for side in (1, -1):
            P = np.empty((len(uu), 3))
            P[:, axis] = hi[axis] if side > 0 else lo[axis]
            P[:, u] = lo[u] + uu * (hi[u] - lo[u])
            P[:, v] = lo[v] + vv * (hi[v] - lo[v])
            Vs.append(P)
            Fs.append((quad if side > 0 else quad[:, ::-1]) + n)
            n += len(P)
    return np.concatenate(Vs), np.concatenate(Fs)


def merge(*parts):
    Vs, Fs, n = [], [], 0
    for V, F in parts:
        Vs.append(V)
        Fs.append(F + n)
        n += len(V)
    return np.concatenate(Vs), np.concatenate(Fs)


def figure(bottom=-1.0 + SLAB):
    """A standing figure 2 units tall: legs from `bottom`, torso, head."""
    return merge(box((-0.2, bottom, -0.08), (-0.05, -0.1, 0.08)), box((0.05, bottom, -0.08), (0.2, -0.1, 0.08)),
                 box((-0.3, -0.1, -0.12), (0.3, 0.6, 0.12)), box((-0.1, 0.6, -0.1), (0.1, 1.0, 0.1)))


def floor_slab(width=1.0):
    return box((-width, -1.0, -width), (width, -1.0 + SLAB, width), cells=12)


def run(V, F, **axes):
    keep, info = meshclean.clean(V, F, **axes)
    return keep, info, V[np.unique(F[keep])]


def test_floor_slab_under_the_feet_goes_and_the_figure_stays():
    body, slab = figure(), floor_slab()
    V, F = merge(body, slab)
    keep, info, kept = run(V, F)
    assert not keep[len(body[1]):].any(), "every slab face goes"
    assert keep[:len(body[1])].sum() >= len(body[1]) - 2 * 72, "at most the two soles on the slab go"
    assert np.allclose(kept.min(0), [-0.3, -1 + SLAB, -0.12]) and np.allclose(kept.max(0), [0.3, 1.0, 0.12])
    assert len(info["slabs"]) == 1 and info["removedFaces"] == (~keep).sum()


def test_blender_axes_find_the_same_slab():
    V, F = merge(figure(), floor_slab())
    blender = np.stack([V[:, 0], -V[:, 2], V[:, 1]], 1)  # glTF (x, y, z) -> Blender (x, -z, y)
    assert np.array_equal(meshclean.clean(blender, F, up=2, front=1)[0], meshclean.clean(V, F)[0])


def test_a_figure_without_a_slab_is_untouched():
    V, F = figure(bottom=-1.0)
    assert meshclean.clean(V, F)[0].all()


def test_flat_bottoms_are_not_floors():
    crate = box((-1, -1, -1), (1, 0.4, 1))
    assert meshclean.clean(*crate)[0].all()
    coaster = box((-1, -SLAB / 2, -1), (1, SLAB / 2, 1))  # the whole object is the thin plate
    assert meshclean.clean(*coaster)[0].all()
    # a thin base under a wider lampshade: it does not stick out past the body, so it is design, not floor
    lamp = merge(box((-0.3, -1, -0.3), (0.3, -1 + SLAB, 0.3)), box((-0.05, -1 + SLAB, -0.05), (0.05, 0.4, 0.05)),
                 box((-0.6, 0.4, -0.6), (0.6, 1.0, 0.6)))
    assert meshclean.clean(*lamp)[0].all()
    # a thick pedestal is part of the design too
    statue = merge(figure(bottom=-0.85), box((-1, -1, -1), (1, -0.85, 1), cells=12))
    assert meshclean.clean(*statue)[0].all()


def test_a_stray_flat_card_goes_and_the_blade_stays():
    sword = merge(box((-0.62, -0.25, -0.025), (-0.55, 1.0, 0.025)), box((-0.85, -0.33, -0.06), (-0.17, -0.25, 0.06)),
                  box((-0.62, -1.0, -0.04), (-0.55, -0.33, 0.04)))
    card = box((0.1, -0.72, -0.0084), (0.98, 1.0, 0.0036), cells=10)
    V, F = merge(sword, card)
    keep, info, kept = run(V, F)
    assert keep[:len(sword[1])].all() and not keep[len(sword[1]):].any() and info["cards"] == 1
    assert kept[:, 0].max() == pytest.approx(-0.17)


def test_a_card_fused_to_the_blade_goes_with_a_stray_card_in_its_plane():
    """Faint cutout alpha makes a backdrop layer of two cards in one plane, one standing apart and one stuck to the
    blade. The stray card shows the plane is an artifact: both go."""
    blade = box((-0.62, -0.25, -0.025), (-0.55, 1.0, 0.025), cells=8)  # z grid steps of 0.00625
    fused = box((-0.98, 0.0625, -0.00625), (-0.62, 1.0, 0.00625), cells=2)  # shares blade vertices; 2-row rim
    stray = box((0.1, -0.72, -0.00625), (0.98, 1.0, 0.00625), cells=8)
    V, F = merge(blade, fused, stray)
    keep, info, kept = run(V, F)
    n = len(blade[1])
    stuck = np.isclose(V[F, 0], -0.62).any(1)  # card faces touching the blade: the junction flaps may stay
    assert keep[:n].all() and not keep[n:][~stuck[n:]].any() and info["cards"] == 2
    assert kept[:, 0].max() == pytest.approx(-0.55)


def test_thin_parts_attached_to_the_body_stay():
    blade = box((-0.62, -0.25, -0.025), (-0.55, 1.0, 0.025), cells=8)  # z grid steps of 0.00625
    fused_card = box((-0.98, 0.0625, -0.00625), (-0.62, 1.0, 0.00625), cells=8)  # shares the blade's side vertices
    V, F = merge(blade, fused_card)
    assert meshclean.clean(V, F)[0].all()  # can't be told from a flag or a wing by shape alone
    # a thin cape hanging behind a figure, tilted 30 degrees: thin, but not a plane facing up or the camera
    cape = box((-0.3, -0.8, -0.006), (0.3, 0.55, 0.006))
    t = np.radians(30)
    cape = (np.stack([cape[0][:, 0], cape[0][:, 1] * np.cos(t) - cape[0][:, 2] * np.sin(t),
                      cape[0][:, 1] * np.sin(t) + cape[0][:, 2] * np.cos(t) - 0.3], 1), cape[1])
    V, F = merge(figure(bottom=-1.0), cape)
    assert meshclean.clean(V, F)[0].all()


def test_compact_renumbers_the_kept_faces():
    V = np.arange(15, dtype=float).reshape(5, 3)
    F = np.array([[0, 1, 2], [2, 3, 4]])
    V2, F2, remap = meshclean.compact(V, F, np.array([False, True]))
    assert V2.tolist() == V[2:].tolist() and F2.tolist() == [[0, 1, 2]] and remap.tolist() == [-1, -1, 0, 1, 2]


def test_a_slab_under_arms_as_wide_as_itself_goes():
    """An A-pose figure whose arms reach almost to the edges of a slab as deep as the torso: the slab sticks out
    past the feet, so it is a floor, though not past the arms or the torso."""
    arms = box((-0.95, 0.4, -0.05), (0.95, 0.5, 0.05))
    body, slab = merge(figure(), arms), box((-1.0, -1.0, -0.13), (1.0, -1.0 + SLAB, 0.13), cells=12)
    V, F = merge(body, slab)
    keep, info, kept = run(V, F)
    assert len(info["slabs"]) == 1 and not keep[len(body[1]):].any()
    assert np.allclose(kept.min(0), [-0.95, -1 + SLAB, -0.12]) and np.allclose(kept.max(0), [0.95, 1.0, 0.12])


# ── a kite shield fused to a backdrop sheet 0.011 thick spanning the whole +-1 box in front view: the shield bulge
# (x +-0.7) sits in a 2x2 plate, while its cutout fills only 73% of its bbox ──
KITE_FILL = 0.729  # the shield cutout's opaque share of its alpha bbox


def front_footprint(V, F, keep, cells=40):
    """Which cells of the mesh's front (x, y) bbox the kept faces' centroids fall in."""
    C = V[F[keep]].mean(1)[:, :2]
    lo, hi = V[:, :2].min(0), V[:, :2].max(0)
    ij = np.clip(((C - lo) / (hi - lo) * cells).astype(int), 0, cells - 1)
    grid = np.zeros((cells, cells), bool)
    grid[ij[:, 1], ij[:, 0]] = True
    return grid


def test_m5_the_real_shields_backdrop_goes_and_the_kite_shield_stays():
    V, F = real_mesh("shield_job_dbae148996.npz")
    C, N, A = meshclean._geometry(V, F)
    assert meshclean.clean(V, F)[0].all()  # the slab and card rules leave it: fused, and no stray card
    keep, info = meshclean.backdrop(V, F, np.ones(len(F), bool), fill=KITE_FILL)
    assert info["backdrops"] == 1 and info["removedFaces"] == (~keep).sum()
    sheet = (np.abs(V[F, 2]) < 0.012).all(1)  # the plate's faces, z -0.008..0.003
    body = ~sheet
    assert keep[body].mean() > 0.995, "the shield's bulge stays"
    assert A[~keep].sum() > 3.5, "the plate around the shield (3.8 of its 8.5 area) goes"
    kept = V[np.unique(F[keep])]
    assert np.ptp(kept[:, 0]) < 1.5 and np.ptp(kept[:, 1]) > 1.9  # 1.4 wide, 1.96 tall: the cutout's 450 x 651
    grid = front_footprint(V, F, keep)
    assert not grid[0, 0] and not grid[0, -1] and not grid[-1, 0] and not grid[-1, -1], "no square corners"


@pytest.mark.parametrize("name", ["mutant_job_df734024d9.npz", "skeleton_job_9b8452492e.npz"])
def test_m5_real_figures_have_no_backdrop(name):
    V, F = real_mesh(name)
    keep = meshclean.clean(V, F)[0]
    assert np.array_equal(meshclean.backdrop(V, F, keep, fill=0.4)[0], keep)


def shield_on_backdrop():
    """A shield bulge (0.7 wide, 1.8 tall, 0.1 deep) standing in a 2x2 front-facing sheet 0.011 thick."""
    shield = box((-0.35, -0.9, 0.0055), (0.35, 0.9, 0.1), cells=8)
    sheet = box((-1.0, -1.0, -0.0055), (1.0, 1.0, 0.0055), cells=20)
    return merge(shield, sheet), len(shield[1])


def test_m5_a_backdrop_behind_a_body_goes_where_the_cutout_is_empty():
    (V, F), n = shield_on_backdrop()
    keep, info = meshclean.backdrop(V, F, np.ones(len(F), bool), fill=KITE_FILL)
    assert info["backdrops"] == 1 and keep[:n].all()
    kept = V[np.unique(F[keep])]
    assert np.abs(kept[:, 0]).max() < 0.5, "only the sheet behind the shield may stay"


def test_m5_a_plate_that_is_the_object_stays():
    (V, F), _ = shield_on_backdrop()
    # a square sign with an emboss: its cutout fills its bbox, so the plate is the object
    assert meshclean.backdrop(V, F, np.ones(len(F), bool), fill=0.98)[0].all()
    # no cutout to compare (the rig path): nothing to tell it by
    assert meshclean.backdrop(V, F, np.ones(len(F), bool), fill=None)[0].all()
    # a flat kite shield with a boss: the plate is the shield and leaves its bbox corners empty
    kite = box((-0.7, -1.0, -0.0055), (0.7, 1.0, 0.0055), cells=20)
    kite[0][:, 0] *= np.where(kite[0][:, 1] < 0, 1 + kite[0][:, 1] * 0.95, 1)  # the bottom half narrows to a point
    boss = box((-0.15, -0.15, 0.0055), (0.15, 0.15, 0.08))
    V, F = merge(kite, boss)
    assert meshclean.backdrop(V, F, np.ones(len(F), bool), fill=KITE_FILL)[0].all()


def real_mesh(name):
    """A real Hunyuan3D-2.1 mesh from workers/tests/data (glTF axes), positions quantised to uint16 over its bbox."""
    d = np.load(Path(__file__).resolve().parent / "data" / name)
    return d["lo"] + d["q"] / 65535.0 * (d["hi"] - d["lo"]), d["faces"].astype(np.int64)


@pytest.mark.parametrize("name,floor_area", [
    # a 1.6 m wide slab fused to the soles, under an A-pose arm span of 1.48 m
    ("mutant_job_df734024d9.npz", 2.0),
    # a cape hangs down to the plate as wide as the plate across, and the plate is only a little deeper than the
    # body, front to back
    ("skeleton_job_9b8452492e.npz", 1.4),
])
def test_a_real_slab_goes_and_the_feet_stay(name, floor_area):
    V, F = real_mesh(name)
    C, N, A = meshclean._geometry(V, F)
    y = V[:, 1]
    floor = (np.abs(N[:, 1]) > meshclean.COS) & (C[:, 1] < y.min() + 0.05 * np.ptp(y))
    keep, info, kept = run(V, F)
    assert len(info["slabs"]) == 1
    assert A[floor].sum() > floor_area and A[floor & keep].sum() < 0.15, "the flat floor area at the bottom is gone"
    feet = (V[F, 1] > y.min() + 0.04 * np.ptp(y)).any(1)  # every face reaching 4% of the height up: soles and up
    assert keep[feet].all(), "no body part is cut"
    assert kept[:, 1].min() < y.min() + 0.03 * np.ptp(y), "the feet reach down to where the slab was"
