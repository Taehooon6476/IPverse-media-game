"""A sky climb's first step is one jump from the start island (fixture: a published sky-climb game)."""
import copy
import json
import math
from pathlib import Path

from server import authored_contract as ac

KAIRO = json.loads((Path(__file__).parents[2] / "game3d/test/fixtures/gm_8f1fc9a181.spec.json").read_text())


def _reach(a, b):
    pa, pb = ac._nearest(ac._extent(a), ac._extent(b))
    return ac._top(b) - ac._top(a, high=True), math.hypot(pb[0] - pa[0], pb[1] - pa[1])


def _first_steps(world):
    home = next(i for i in ac.sky_islands(world) if i["id"] == "home")
    return [p for p in ac._platforms(world["entities"])
            if (lambda r, g: r <= ac.STEP_RISE + 1e-6 and g <= ac.STEP_GAP + 1e-6)(*_reach(home, p))]


def test_kairos_first_step_is_one_jump_from_the_start_island():
    spec = copy.deepcopy(KAIRO)
    ac.settle_sky(spec)
    assert [p["id"] for p in _first_steps(spec["world"])] == ["isle1"]


def test_a_climb_reachable_only_from_an_enemys_island_gets_a_first_step_from_the_start_island():
    # the hero starts on the home island; the enemy's island is 20 m off across the clouds, and the 1 m platform is
    # within a step of that island only
    world = {"spawn": {"x": 0, "z": 0}, "enemySpawns": [{"id": "e1", "x": 0, "z": -20}],
             "entities": [{"id": "p1", "kind": "platform", "x": 0, "z": -16, "y": 0, "width": 3, "depth": 3, "height": 1,
                           "rotation": 0},
                          {"id": "p2", "kind": "platform", "x": 0, "z": -10, "y": 1.5, "width": 3, "depth": 3,
                           "height": 1, "rotation": 0}]}
    spec = {"world": world, "artDirection": {"setting": "sky"}}
    ac.settle_sky(spec)
    assert _first_steps(spec["world"]), "no step from the start island"
