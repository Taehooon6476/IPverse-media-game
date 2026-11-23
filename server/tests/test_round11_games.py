"""The authored contract connects a jump platformer's climb (the jump reaches 1.48 m in game3d): every platform is
within STEP_RISE (top to top) and STEP_GAP (edge to edge) of the floor or of a platform already reached. Too high:
lowered, with what stands on it. Too far: stepping stones in the gap. The fixture is a published sky-island game."""
import json
import math
from pathlib import Path

import pytest

from server import authored_contract as ac, gamespec, prompts
from server.tests.test_genre_modules import stair_spec

FIXTURE = Path(__file__).resolve().parents[2] / "game3d" / "test" / "fixtures" / "gm_1e7d17bbb0.spec.json"
RESOLVED = {"spriteUrl", "modelUrl", "weaponUrl", "animUrl", "imageUrl"}


def unresolved(obj):
    """The spec as the agent wrote it (tools._unresolved): the asset URLs make_game fills in are dropped."""
    if isinstance(obj, dict):
        return {k: unresolved(v) for k, v in obj.items() if k not in RESOLVED}
    if isinstance(obj, list):
        return [unresolved(v) for v in obj]
    return obj


def rumi():
    return unresolved(json.loads(FIXTURE.read_text()))


def top(p):
    return p["y"] + p["height"]


def box(p):
    """The rotated footprint's bounding box, swept by x/z motion (as the contract measures it)."""
    c, s = abs(math.cos(p.get("rotation", 0))), abs(math.sin(p.get("rotation", 0)))
    hx, hz = (p["width"] * c + p["depth"] * s) / 2, (p["width"] * s + p["depth"] * c) / 2
    m = p.get("motion") or {}
    if m.get("axis") == "x":
        hx, hz = hx + c * m["distance"] / 2, hz + s * m["distance"] / 2
    elif m.get("axis") == "z":
        hx, hz = hx + s * m["distance"] / 2, hz + c * m["distance"] / 2
    return p["x"] - hx, p["x"] + hx, p["z"] - hz, p["z"] + hz


def gap(a, b):
    (ax0, ax1, az0, az1), (bx0, bx1, bz0, bz1) = box(a), box(b)
    return math.hypot(max(0, bx0 - ax1, ax0 - bx1), max(0, bz0 - az1, az0 - bz1))


def unreachable(validated, rise=1.2, span=2.5):
    """Platforms no chain of steps (each within `rise` up and `span` across) reaches from the floor."""
    platforms = [e for e in validated["world"]["entities"] if e["kind"] == "platform"]
    reached, left = [], list(platforms)
    while True:
        ok = [p for p in left if top(p) <= rise + 1e-6
              or any(top(p) - top(s) - (s.get("motion") or {}).get("distance", 0) * ((s.get("motion") or {}).get("axis") == "y")
                     <= rise + 1e-6 and gap(s, p) <= span + 1e-6 for s in reached)]
        if not ok:
            return [p["id"] for p in left]
        reached += ok
        left = [p for p in left if p not in ok]


def test_the_published_sky_island_climb_validates_and_the_first_island_is_reachable_from_the_floor():
    spec = rumi()
    before = {e["id"]: e for e in spec["world"]["entities"]}
    assert top({"y": .6, "height": 1}) == 1.6  # as authored: 1.6 m up from the spawn on the floor
    validated, errors = gamespec.validate_spec(spec)
    assert errors == [], errors
    entities = {e["id"]: e for e in validated["world"]["entities"]}
    assert unreachable(validated) == []
    assert top(entities["plat_start"]) <= ac.STEP_RISE  # the first cloud island: one jump from the floor
    # the rest of the climb is reachable and stays as authored: still 8 m up to the goal
    for pid in ("plat_1", "plat_5", "plat_10", "plat_goal"):
        assert entities[pid]["y"] == before[pid]["y"], pid
    assert top(entities["plat_goal"]) == 9
    assert [e["id"] for e in validated["world"]["entities"] if e["id"].startswith("step")] == []  # no stones needed


def climb(rise_at=None, gap_at=None):
    """An 8 m climb in 15 steps (0.6 m to 8 m, height 1, 4 m wide, 1.5 m apart), optionally with one 2.5 m rise
    and one 6 m gap, plus the goal flag on the top step."""
    spec = stair_spec()
    steps, x, y = [], -40.0, .6
    step = (8 - .6 - (2.5 if rise_at else 0)) / (14 - (1 if rise_at else 0))
    for i in range(15):
        if i == gap_at:
            x += 4.5
        steps.append({"id": f"p{i}", "kind": "platform", "x": x, "z": 0, "y": round(y, 3), "width": 4, "depth": 4,
                      "height": 1})
        x += 5.5
        y += 2.5 if i + 1 == rise_at else step
    goal = steps[-1]
    spec["world"]["entities"] = [*steps, {"id": "flag", "kind": "beacon", "x": goal["x"], "z": 0, "y": goal["y"]},
                                 {"id": "coin_a", "kind": "crystal", "x": steps[3]["x"], "z": 0, "pickup": True},
                                 {"id": "coin_b", "kind": "crystal", "x": steps[9]["x"], "z": 0, "pickup": True}]
    spec["world"]["width"] = spec["world"]["depth"] = 100
    spec["world"]["spawn"] = {"x": -44, "z": 6}
    spec["world"]["propPlacements"] = [{"id": "core_a", "propIndex": 0, "x": steps[5]["x"], "z": 0, "stageId": "find"},
                                       {"id": "core_b", "propIndex": 0, "x": steps[12]["x"], "z": 0, "stageId": "find"}]
    spec["mission"]["stages"][1]["entityIds"] = ["coin_a", "coin_b"]
    return spec


def test_an_8m_climb_in_15_steps_comes_out_reachable():
    validated, errors = gamespec.validate_spec(climb())
    assert errors == [], errors
    assert unreachable(validated) == []
    tops = [top(e) for e in validated["world"]["entities"] if e["kind"] == "platform"]
    assert tops[0] == pytest.approx(1.6 - .4)  # the 1.6 m first step comes down to 1.2 m
    assert max(tops) == pytest.approx(9)  # the rest keeps its height


def test_a_step_too_high_comes_down_with_its_flag_and_one_too_far_gets_stepping_stones():
    spec = climb(rise_at=8, gap_at=11)
    p8 = spec["world"]["entities"][8]
    spec["world"]["entities"].append({"id": "crate", "kind": "box", "x": p8["x"] + 1, "z": 1, "y": p8["y"] + 1,
                                      "width": 1, "depth": 1, "height": 1})  # standing on the step that comes down
    raw = {e["id"]: e for e in spec["world"]["entities"]}
    assert top(raw["p8"]) - top(raw["p7"]) == pytest.approx(2.5)
    assert gap(raw["p10"], raw["p11"]) == pytest.approx(6)
    validated, errors = gamespec.validate_spec(spec)
    assert errors == [], errors
    assert unreachable(validated) == []
    out = {e["id"]: e for e in validated["world"]["entities"]}
    drop = top(raw["p8"]) - top(out["p8"])
    assert top(out["p8"]) - top(out["p7"]) == pytest.approx(ac.STEP_RISE)
    assert drop > 1
    assert out["crate"]["y"] == pytest.approx(top(out["p8"]))  # what stood on it came down with it
    assert top(out["p9"]) - top(out["p8"]) <= ac.STEP_RISE + 1e-6  # the step after it follows it down
    assert top(out["p14"]) == pytest.approx(9) and out["flag"]["y"] == out["p14"]["y"]  # the top keeps its flag
    stones = [e for e in validated["world"]["entities"] if e["id"].startswith("step")]
    assert stones and all(e["kind"] == "platform" and e["solid"] for e in stones)
    assert all(top(out["p10"]) <= top(s) <= top(out["p11"]) for s in stones)
    assert len(validated["world"]["entities"]) <= 72
    # the collectibles still sit on the climb
    from server.tests.test_genre_modules import seat_of
    for coin in (out["coin_a"], out["coin_b"]):
        assert seat_of(validated, coin)["y"] == coin["y"]


def test_the_climb_is_left_alone_outside_a_platformer():
    spec = climb(rise_at=8)
    spec["mechanics"]["fallRespawn"] = False
    validated, errors = gamespec.validate_spec(spec)
    assert errors == [], errors
    assert [e["y"] for e in validated["world"]["entities"]] == [e.get("y", 0) for e in spec["world"]["entities"]]


def test_a_full_entity_list_pulls_the_far_step_closer_instead_of_adding_stones():
    spec = climb(gap_at=11)
    spec["world"]["entities"] += [{"id": f"rock{i}", "kind": "box", "x": 46, "z": -40 + 1.5 * i, "width": .5,
                                   "depth": .5, "height": .5} for i in range(72 - len(spec["world"]["entities"]))]
    validated, errors = gamespec.validate_spec(spec)
    assert errors == [], errors
    assert len(validated["world"]["entities"]) == 72
    assert unreachable(validated) == []


def test_the_game_rules_give_the_climb_limits_from_the_top_of_each_platform():
    line = next(line for line in prompts.SYSTEM.splitlines() if "점프 플랫포머" in line)
    for must in ("윗면", "y+height", "바닥", "1.2m", "2.5m", "첫 발판"):
        assert must in line, must
